import { eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { fades, releases } from "../db/schema";
import type { FadedIdsDto, FadeRequestDto, FadeResponseDto } from "../dto/fade.dto";
import { highlightId, logger } from "../util/logger";

export interface FadeRouterDeps {
  db: Db;
}

export function createFadeRouter(deps: FadeRouterDeps): Router {
  const router = Router();

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

  router.post("/", (req, res) => {
    const body = (req.body ?? {}) as Partial<FadeRequestDto>;

    const hasReleaseId = body.releaseId !== undefined;
    const hasMasterId = body.masterId !== undefined;
    if (hasReleaseId === hasMasterId) {
      res.status(400).json({ error: "Provide exactly one of releaseId or masterId" });
      return;
    }

    let result: FadeResponseDto;
    if (hasReleaseId) {
      const releaseId = Number(body.releaseId);
      if (!Number.isInteger(releaseId)) {
        res.status(400).json({ error: "releaseId must be an integer" });
        return;
      }
      const release = deps.db
        .select({ masterId: releases.masterId })
        .from(releases)
        .where(eq(releases.id, releaseId))
        .get();
      if (!release) {
        res.status(404).json({ error: "Release not found" });
        return;
      }
      result = release.masterId
        ? { kind: "master", id: release.masterId }
        : { kind: "release", id: releaseId };
    } else {
      const masterId = Number(body.masterId);
      if (!Number.isInteger(masterId)) {
        res.status(400).json({ error: "masterId must be an integer" });
        return;
      }
      result = { kind: "master", id: masterId };
    }

    deps.db
      .insert(fades)
      .values({ uid: req.user!.uid, kind: result.kind, id: result.id, createdAt: new Date() })
      .onConflictDoNothing()
      .run();

    logger.info(`Faded ${result.kind} ${highlightId(result.id)}`);
    res.json(result);
  });

  return router;
}
