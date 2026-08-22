import { Router } from "express";
import { DiscogsNotFoundError } from "../discogs-client";
import type { FadeRequestDto } from "../dto/fade.dto";
import { resolveFadeFromMaster, resolveFadeFromRelease } from "../services/fade-resolver";

export const fadeRouter = Router();

fadeRouter.post("/", async (req, res) => {
  const body = req.body as Partial<FadeRequestDto>;
  const action = body.action ?? "fade";

  if (action !== "fade") {
    res.status(400).json({ error: `Unsupported action: ${String(action)}` });
    return;
  }

  const hasReleaseId = body.releaseId !== undefined;
  const hasMasterId = body.masterId !== undefined;

  if (hasReleaseId === hasMasterId) {
    res.status(400).json({ error: "Provide exactly one of releaseId or masterId" });
    return;
  }

  try {
    if (hasReleaseId) {
      const releaseId = Number(body.releaseId);
      if (!Number.isInteger(releaseId)) {
        res.status(400).json({ error: "releaseId must be an integer" });
        return;
      }
      res.json(await resolveFadeFromRelease(releaseId));
      return;
    }

    const masterId = Number(body.masterId);
    if (!Number.isInteger(masterId)) {
      res.status(400).json({ error: "masterId must be an integer" });
      return;
    }
    res.json(await resolveFadeFromMaster(masterId));
  } catch (err) {
    if (err instanceof DiscogsNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(502).json({ error: "Failed to resolve fade ids from Discogs" });
  }
});
