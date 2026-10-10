import { and, desc, eq, inArray, not, or, sql } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { isCoveredByFadeFor } from "../db/fades";
import {
  discogsQueueJobs,
  fades,
  masterVersions,
  releases,
  sellerInventory,
  type FadeKind,
  type ReleaseArtistStub,
  type ReleaseDetailPayload,
} from "../db/schema";
import type {
  FadedIdsDto,
  FadedItemDto,
  FadedItemsDto,
  FadeRequestDto,
  FadeResponseDto,
} from "../dto/fade.dto";
import { enqueueFadeLookup, hasStoredVersions } from "../indexing/fade-lookup-handler";
import type { DiscogsQueue } from "../queue/discogs-queue";
import { highlightId, logger } from "../util/logger";

export interface FadeRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

/** Reads exactly one integer id from `releaseId` or `masterId`; `error` is the 400 message. */
function parseFadeRequest(
  body: Partial<FadeRequestDto>,
): { releaseId: number } | { masterId: number } | { error: string } {
  const hasReleaseId = body.releaseId !== undefined;
  const hasMasterId = body.masterId !== undefined;
  if (hasReleaseId === hasMasterId) {
    return { error: "Provide exactly one of releaseId or masterId" };
  }
  if (hasReleaseId) {
    const releaseId = Number(body.releaseId);
    if (!Number.isInteger(releaseId)) return { error: "releaseId must be an integer" };
    return { releaseId };
  }
  const masterId = Number(body.masterId);
  if (!Number.isInteger(masterId)) return { error: "masterId must be an integer" };
  return { masterId };
}

export function createFadeRouter(deps: FadeRouterDeps): Router {
  const router = Router();

  /**
   * The fade a request targets. A release whose master we know (from an indexed release or a
   * stored version list) is the master; one we know has no master stays a release (`resolved`);
   * any other release is stored as itself until its lookup finds the master.
   */
  function resolveFade(parsed: { releaseId: number } | { masterId: number }): {
    kind: FadeKind;
    id: number;
    resolved: boolean;
  } {
    if ("masterId" in parsed) return { kind: "master", id: parsed.masterId, resolved: true };
    const release = deps.db
      .select({ masterId: releases.masterId })
      .from(releases)
      .where(eq(releases.id, parsed.releaseId))
      .get();
    if (release?.masterId) return { kind: "master", id: release.masterId, resolved: true };
    if (release) return { kind: "release", id: parsed.releaseId, resolved: true };

    const version = deps.db
      .select({ masterId: masterVersions.masterId })
      .from(masterVersions)
      .where(eq(masterVersions.releaseId, parsed.releaseId))
      .get();
    return version
      ? { kind: "master", id: version.masterId, resolved: true }
      : { kind: "release", id: parsed.releaseId, resolved: false };
  }

  /**
   * Releases a fade used to cover were skipped by enrichment. Those that sit in a seller's
   * inventory without a `releases` row, and that no remaining fade of this collector covers,
   * go back on the queue (unless already queued).
   */
  function requeueEnrichment(uid: string, target: { kind: FadeKind; id: number }): void {
    const covered = deps.db
      .selectDistinct({ releaseId: sellerInventory.releaseId })
      .from(sellerInventory)
      .where(
        and(
          target.kind === "release"
            ? eq(sellerInventory.releaseId, target.id)
            : inArray(
                sellerInventory.releaseId,
                deps.db
                  .select({ releaseId: masterVersions.releaseId })
                  .from(masterVersions)
                  .where(eq(masterVersions.masterId, target.id)),
              ),
          sql`${sellerInventory.releaseId} NOT IN (SELECT ${releases.id} FROM ${releases})`,
          not(isCoveredByFadeFor(uid, sellerInventory.releaseId)),
        ),
      )
      .all();
    if (covered.length === 0) return;

    const queued = new Set(
      deps.db
        .select({ payload: discogsQueueJobs.payload })
        .from(discogsQueueJobs)
        .where(
          and(
            eq(discogsQueueJobs.type, "release_detail"),
            inArray(discogsQueueJobs.status, ["pending", "processing"]),
          ),
        )
        .all()
        .map((job) => (job.payload as ReleaseDetailPayload).releaseId),
    );
    for (const { releaseId } of covered) {
      if (queued.has(releaseId)) continue;
      deps.queue.enqueue({ runId: `unfade:${uid}`, type: "release_detail", payload: { releaseId } });
    }
  }

  router.get("/", (req, res) => {
    const rows = deps.db
      .select({ kind: fades.kind, id: fades.id, lookupStatus: fades.lookupStatus })
      .from(fades)
      .where(eq(fades.uid, req.user!.uid))
      .all();

    const masterIds = rows.filter((row) => row.kind === "master").map((row) => row.id);
    const versionRows = masterIds.length
      ? deps.db
          .selectDistinct({ releaseId: masterVersions.releaseId })
          .from(masterVersions)
          .where(inArray(masterVersions.masterId, masterIds))
          .all()
      : [];

    const dto: FadedIdsDto = {
      masterIds,
      releaseIds: rows.filter((row) => row.kind === "release").map((row) => row.id),
      versionReleaseIds: versionRows.map((row) => row.releaseId),
      failedLookups: rows
        .filter((row) => row.lookupStatus === "failed")
        .map((row) => ({ kind: row.kind, id: row.id })),
    };
    res.set("Cache-Control", "no-store").json(dto);
  });

  router.get("/items", (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    if (!Number.isInteger(page) || page < 1) {
      res.status(400).json({ error: "page must be a positive integer" });
      return;
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      res.status(400).json({ error: "pageSize must be a positive integer" });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const uid = req.user!.uid;

    const fadeRows = deps.db
      .select({
        kind: fades.kind,
        id: fades.id,
        createdAt: fades.createdAt,
        lookupStatus: fades.lookupStatus,
        title: fades.title,
        artists: fades.artists,
      })
      .from(fades)
      .where(eq(fades.uid, uid))
      .orderBy(desc(fades.createdAt), desc(fades.id))
      .all();

    const hidden = deps.db
      .select({
        fadeKind: fades.kind,
        fadeId: fades.id,
        title: releases.title,
        year: releases.year,
        thumb: releases.thumb,
        artists: releases.artists,
      })
      .from(releases)
      .innerJoin(
        fades,
        and(
          eq(fades.uid, uid),
          or(
            and(eq(fades.kind, "master"), eq(fades.id, releases.masterId)),
            and(eq(fades.kind, "release"), eq(fades.id, releases.id)),
          ),
        ),
      )
      .orderBy(releases.id)
      .all();

    const versionsByFade = new Map<string, typeof hidden>();
    for (const row of hidden) {
      const key = `${row.fadeKind}:${row.fadeId}`;
      const versions = versionsByFade.get(key);
      if (versions) versions.push(row);
      else versionsByFade.set(key, [row]);
    }

    const matches = (
      candidates: { title: string | null; artists: ReleaseArtistStub[] | null }[],
    ): boolean =>
      candidates.some(
        (c) =>
          c.title?.toLowerCase().includes(q) ||
          c.artists?.some((artist) => artist.name.toLowerCase().includes(q)),
      );

    const matching = fadeRows.filter(
      (fade) => !q || matches([...(versionsByFade.get(`${fade.kind}:${fade.id}`) ?? []), fade]),
    );
    const items: FadedItemDto[] = matching
      .slice((page - 1) * pageSize, page * pageSize)
      .map((fade) => {
        const versions = versionsByFade.get(`${fade.kind}:${fade.id}`) ?? [];
        const first = versions[0];
        return {
          kind: fade.kind,
          id: fade.id,
          fadedAt: fade.createdAt.toISOString(),
          title: first?.title ?? fade.title,
          artists: first?.artists ?? fade.artists ?? [],
          year: first?.year ?? null,
          thumb: first?.thumb ?? null,
          versionsIndexed: versions.length,
          lookupStatus: fade.lookupStatus,
        };
      });

    const dto: FadedItemsDto = {
      items,
      page,
      pageSize,
      total: matching.length,
      fadedTotal: fadeRows.length,
    };
    res.set("Cache-Control", "no-store").json(dto);
  });

  router.post("/", (req, res) => {
    const parsed = parseFadeRequest((req.body ?? {}) as Partial<FadeRequestDto>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const uid = req.user!.uid;
    const target = resolveFade(parsed);
    const [existing] = deps.db
      .select()
      .from(fades)
      .where(and(eq(fades.uid, uid), eq(fades.kind, target.kind), eq(fades.id, target.id)))
      .all();

    // A pending or done fade needs nothing more; a failed one is retried by fading again.
    if (existing && existing.lookupStatus !== "failed") {
      const dto: FadeResponseDto = { kind: target.kind, id: target.id, lookupStatus: existing.lookupStatus };
      res.json(dto);
      return;
    }

    const needsLookup = target.kind === "master" ? !hasStoredVersions(deps.db, target.id) : !target.resolved;
    const lookupStatus = needsLookup ? "pending" : "done";

    deps.db
      .insert(fades)
      .values({ uid, kind: target.kind, id: target.id, createdAt: new Date(), lookupStatus })
      .onConflictDoUpdate({ target: [fades.uid, fades.kind, fades.id], set: { lookupStatus } })
      .run();
    if (needsLookup) enqueueFadeLookup((job) => deps.queue.enqueue(job), uid, target.kind, target.id);

    logger.info(`Faded ${target.kind} ${highlightId(target.id)}`);
    const dto: FadeResponseDto = { kind: target.kind, id: target.id, lookupStatus };
    res.json(dto);
  });

  router.delete("/", (req, res) => {
    const parsed = parseFadeRequest((req.body ?? {}) as Partial<FadeRequestDto>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const uid = req.user!.uid;
    const target = resolveFade(parsed);

    const removed = deps.db
      .delete(fades)
      .where(and(eq(fades.uid, uid), eq(fades.kind, target.kind), eq(fades.id, target.id)))
      .returning()
      .all();
    if (removed.length > 0) requeueEnrichment(uid, target);

    logger.info(`Unfaded ${target.kind} ${highlightId(target.id)}`);
    res.status(204).end();
  });

  return router;
}
