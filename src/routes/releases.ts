import { eq } from "drizzle-orm";
import { Router, type Response } from "express";
import type { Db } from "../db/client";
import { filterOptions, releases, type FilterOptionKind } from "../db/schema";
import type { ReleaseFilterOptionsDto } from "../dto/release-list.dto";
import { mapReleaseRowToDto } from "../dto/mappers";
import type { DiscogsQueue } from "../queue/discogs-queue";
import type { ReadRunner } from "../read/read-runner";
import { fetchReleaseFromDiscogs } from "./fetch-release";

export interface ReleasesRouterDeps {
  db: Db;
  queue: DiscogsQueue;
  readRunner: ReadRunner;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const findRelease = (id: number) =>
    deps.db.select().from(releases).where(eq(releases.id, id)).get();

  function sendStoredRelease(id: number, res: Response): void {
    const row = findRelease(id);
    if (!row) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    res.json(mapReleaseRowToDto(row));
  }

  /** The one static list per catalogue, filled by the importer. An `enriched` parameter from an older client is ignored. */
  router.get("/filter-options", (_req, res) => {
    const rows = deps.db
      .select({ kind: filterOptions.kind, value: filterOptions.value })
      .from(filterOptions)
      .orderBy(filterOptions.kind, filterOptions.position)
      .all();
    const valuesOf = (kind: FilterOptionKind) => rows.filter((row) => row.kind === kind).map((row) => row.value);
    const dto: ReleaseFilterOptionsDto = {
      genres: valuesOf("genre"),
      styles: valuesOf("style"),
      formats: valuesOf("format"),
      countries: valuesOf("country"),
    };
    res.json(dto);
  });

  router.get("/", async (req, res) => {
    // The scans behind the list run on a worker thread, so they don't block other requests or the queue.
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const result = await deps.readRunner.run(
      "listReleases",
      { query: { ...req.query }, uid: req.user!.uid },
      { signal: abort.signal },
    );
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.page);
  });

  router.get("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }
    sendStoredRelease(id, res);
  });

  /**
   * Fetch one release from Discogs ahead of any queued run, with the collector's own token, and
   * overwrite what is stored for it (rating included).
   */
  router.post("/:id/refresh", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }
    const failure = await fetchReleaseFromDiscogs(deps, req.user!.uid, id);
    if (failure) {
      res.status(failure.status).json(failure.body);
      return;
    }
    sendStoredRelease(id, res);
  });

  return router;
}

