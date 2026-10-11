import { Router } from "express";
import type { Db } from "../db/client";
import { getDiscogsToken } from "../db/discogs-tokens";
import { DiscogsAuthError, DiscogsNotFoundError, getMaster } from "../discogs-client";
import { mapMasterToDto } from "../dto/mappers";
import { logger } from "../util/logger";

export interface MastersRouterDeps {
  db: Db;
}

/** Fetches a master from Discogs with the signed-in collector's own token. */
export function createMastersRouter(deps: MastersRouterDeps): Router {
  const router = Router();

  router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id must be an integer" });
      return;
    }

    const token = getDiscogsToken(deps.db, req.user!.uid);
    if (!token) {
      res.status(409).json({ error: "Add a Discogs token in Settings first" });
      return;
    }

    try {
      const raw = await getMaster(id, token);
      res.json(mapMasterToDto(raw));
    } catch (err) {
      if (err instanceof DiscogsNotFoundError) {
        res.status(404).json({ error: "Master not found" });
        return;
      }
      if (err instanceof DiscogsAuthError) {
        res.status(409).json({ error: "Discogs rejected your token" });
        return;
      }
      logger.error("Failed to fetch master from Discogs", err);
      res.status(502).json({ error: "Failed to fetch master from Discogs" });
    }
  });

  return router;
}
