import { Router } from "express";
import { DiscogsNotFoundError, getMaster } from "../discogs-client";
import { mapMasterToDto } from "../dto/mappers";
import { logger } from "../util/logger";

export const mastersRouter = Router();

mastersRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }

  try {
    const raw = await getMaster(id);
    res.json(mapMasterToDto(raw));
  } catch (err) {
    if (err instanceof DiscogsNotFoundError) {
      res.status(404).json({ error: "Master not found" });
      return;
    }
    logger.error("Failed to fetch master from Discogs", err);
    res.status(502).json({ error: "Failed to fetch master from Discogs" });
  }
});
