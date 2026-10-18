import { Router } from "express";
import type { Db } from "../db/client";
import { hasDiscogsToken } from "../db/discogs-tokens";
import {
  cancelActiveRun,
  currentRun,
  notFoundReleases,
  runProgress,
  startRun,
} from "../enrichment/enrichment-run";
import type { EnrichmentPreviewDto, EnrichmentRunDto, EnrichmentStatusDto } from "../dto/enrichment.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";
import type { ReadRunner } from "../read/read-runner";

export interface EnrichmentRouterDeps {
  db: Db;
  queue: DiscogsQueue;
  readRunner: ReadRunner;
}

const MAX_QUERY_LENGTH = 4000;

/**
 * Enrichment runs (fader-ui#109): fetch the releases an Explore filter shows from Discogs, with
 * the collector's own token, to store their community rating. One active run per collector; starting another filter adds to it.
 */
export function createEnrichmentRouter(deps: EnrichmentRouterDeps): Router {
  const router = Router();

  function runDto(run: NonNullable<ReturnType<typeof currentRun>>): EnrichmentRunDto {
    const progress = runProgress(deps.db, run.id);
    const pause = run.status === "running" ? deps.queue.getPause(run.uid) : null;
    return {
      id: run.id,
      status: run.status,
      query: run.query,
      fresh: run.fresh,
      total: run.total,
      skipped: run.skipped,
      ...progress,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      errorMessage: run.errorMessage,
      pausedUntil: pause?.retryAt.toISOString() ?? null,
      notFoundReleases: notFoundReleases(deps.db, run.id),
    };
  }

  function parseQuery(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const query = value.startsWith("?") ? value.slice(1) : value;
    return query.length <= MAX_QUERY_LENGTH ? query : null;
  }

  router.get("/preview", async (req, res) => {
    const query = parseQuery(req.query.query ?? "");
    if (query === null) {
      res.status(400).json({ error: "query must be a string of at most 4000 characters" });
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const preview = await deps.readRunner.run(
      "previewEnrichment",
      { uid: req.user!.uid, query, fresh: req.query.fresh === "true" },
      { signal: abort.signal },
    );
    if ("error" in preview) {
      res.status(400).json({ error: preview.error });
      return;
    }
    const dto: EnrichmentPreviewDto = preview;
    res.json(dto);
  });

  router.get("/run", (req, res) => {
    const run = currentRun(deps.db, req.user!.uid);
    const dto: EnrichmentStatusDto = { run: run ? runDto(run) : null };
    res.set("Cache-Control", "no-store").json(dto);
  });

  router.post("/run", (req, res) => {
    const { uid } = req.user!;
    const body = (req.body ?? {}) as { query?: unknown; fresh?: unknown };
    const query = parseQuery(body.query ?? "");
    if (query === null || (body.fresh !== undefined && typeof body.fresh !== "boolean")) {
      res.status(400).json({ error: "query must be a string of at most 4000 characters, fresh a boolean" });
      return;
    }
    if (!hasDiscogsToken(deps.db, uid)) {
      res.status(409).json({ error: "Add a Discogs token in Settings to enrich releases", code: "token_required" });
      return;
    }

    const result = startRun(deps.db, deps.queue, uid, query, body.fresh === true);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
    } else if ("conflict" in result) {
      res.status(409).json({ error: "An enrichment run is already active", code: "run_active" });
    } else if ("tooMany" in result) {
      const { count, max } = result.tooMany;
      res
        .status(422)
        .json({ error: `This filter has ${count} releases to enrich; a run is limited to ${max}`, code: "too_many_releases" });
    } else {
      res.status(201).json(runDto(result.run));
    }
  });

  router.post("/run/cancel", (req, res) => {
    const run = cancelActiveRun(deps.db, deps.queue, req.user!.uid);
    if (!run) {
      res.status(409).json({ error: "No enrichment run is active", code: "no_active_run" });
      return;
    }
    res.json(runDto(run));
  });

  return router;
}
