import { and, desc, eq, or } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { fades, releases } from "../db/schema";
import type {
  FadedIdsDto,
  FadedItemDto,
  FadedItemsDto,
  FadeRequestDto,
  FadeResponseDto,
} from "../dto/fade.dto";
import { highlightId, logger } from "../util/logger";

export interface FadeRouterDeps {
  db: Db;
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

  /** The fade a request targets: a release with a master is stored as that master. */
  function resolveFade(parsed: { releaseId: number } | { masterId: number }): FadeResponseDto | null {
    if ("masterId" in parsed) return { kind: "master", id: parsed.masterId };
    const release = deps.db
      .select({ masterId: releases.masterId })
      .from(releases)
      .where(eq(releases.id, parsed.releaseId))
      .get();
    if (!release) return null;
    return release.masterId
      ? { kind: "master", id: release.masterId }
      : { kind: "release", id: parsed.releaseId };
  }

  router.get("/", (req, res) => {
    const rows = deps.db
      .select({ kind: fades.kind, id: fades.id })
      .from(fades)
      .where(eq(fades.uid, req.user!.uid))
      .all();

    const dto: FadedIdsDto = {
      masterIds: rows.filter((row) => row.kind === "master").map((row) => row.id),
      releaseIds: rows.filter((row) => row.kind === "release").map((row) => row.id),
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
      .select({ kind: fades.kind, id: fades.id, createdAt: fades.createdAt })
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

    const matches = (versions: typeof hidden): boolean =>
      versions.some(
        (v) =>
          v.title.toLowerCase().includes(q) ||
          v.artists.some((artist) => artist.name.toLowerCase().includes(q)),
      );

    const matching = fadeRows.filter(
      (fade) => !q || matches(versionsByFade.get(`${fade.kind}:${fade.id}`) ?? []),
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
          title: first?.title ?? null,
          artists: first?.artists ?? [],
          year: first?.year ?? null,
          thumb: first?.thumb ?? null,
          versionsIndexed: versions.length,
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

    const result = resolveFade(parsed);
    if (!result) {
      res.status(404).json({ error: "Release not found" });
      return;
    }

    deps.db
      .insert(fades)
      .values({ uid: req.user!.uid, kind: result.kind, id: result.id, createdAt: new Date() })
      .onConflictDoNothing()
      .run();

    logger.info(`Faded ${result.kind} ${highlightId(result.id)}`);
    res.json(result);
  });

  router.delete("/", (req, res) => {
    const parsed = parseFadeRequest((req.body ?? {}) as Partial<FadeRequestDto>);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // An unindexed release can't be resolved to a master; fall back to a release fade.
    const target =
      resolveFade(parsed) ?? ({ kind: "release", id: (parsed as { releaseId: number }).releaseId } as const);

    deps.db
      .delete(fades)
      .where(and(eq(fades.uid, req.user!.uid), eq(fades.kind, target.kind), eq(fades.id, target.id)))
      .run();

    logger.info(`Unfaded ${target.kind} ${highlightId(target.id)}`);
    res.status(204).end();
  });

  return router;
}
