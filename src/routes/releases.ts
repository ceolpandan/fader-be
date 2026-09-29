import { eq } from "drizzle-orm";
import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client";
import { releases } from "../db/schema";
import { mapReleaseRowToDto } from "../dto/mappers";
import { NonRetryableError, QueueWaitTimeoutError, type DiscogsQueue } from "../queue/discogs-queue";
import { logger } from "../util/logger";

export interface ReleasesRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

export function createReleasesRouter(deps: ReleasesRouterDeps): Router {
  const router = Router();

  const findRelease = (id: number) =>
    deps.db.select().from(releases).where(eq(releases.id, id)).get();

  /**
   * Fetch the release live from Discogs through the priority queue lane; the queue handler
   * overwrites the stored row. Returns false after sending the error response if that failed.
   */
  async function fetchAndSave(id: number, res: Response): Promise<boolean> {
    try {
      await deps.queue.enqueueAndWait({
        runId: `inline-${randomUUID()}`,
        type: "release_detail",
        payload: { releaseId: id },
      });
      return true;
    } catch (err) {
      if (err instanceof NonRetryableError) {
        res.status(404).json({ error: "Release not found" });
      } else if (err instanceof QueueWaitTimeoutError) {
        res.status(504).json({ error: "Timed out waiting for release from Discogs" });
      } else {
        logger.error("Failed to fetch release from Discogs", err);
        res.status(502).json({ error: "Failed to fetch release from Discogs" });
      }
      return false;
    }
  }

  function sendStoredRelease(id: number, res: Response): void {
    const row = findRelease(id);
    if (!row) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    res.json(mapReleaseRowToDto(row));
  }

  router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }

    if (!findRelease(id) && !(await fetchAndSave(id, res))) return;
    sendStoredRelease(id, res);
  });

  router.post("/:id/refresh", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }

    if (!(await fetchAndSave(id, res))) return;
    sendStoredRelease(id, res);
  });

  return router;
}
