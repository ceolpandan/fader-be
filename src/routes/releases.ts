import { Router } from "express";
import { DiscogsNotFoundError, getRelease } from "../discogs-client";
import { mapReleaseToDto } from "../dto/mappers";
import { logger } from "../util/logger";

export const releasesRouter = Router();

releasesRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }

  try {
    const raw = await getRelease(id);
    res.json(mapReleaseToDto(raw));
  } catch (err) {
    if (err instanceof DiscogsNotFoundError) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    logger.error("Failed to fetch release from Discogs", err);
    res.status(502).json({ error: "Failed to fetch release from Discogs" });
  }
});
