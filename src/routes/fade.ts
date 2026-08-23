import { Router } from "express";
import { DiscogsNotFoundError } from "../discogs-client";
import type { FadeRequestDto, FadeResponseDto } from "../dto/fade.dto";
import { resolveFadeFromMaster, resolveFadeFromRelease } from "../services/fade-resolver";
import { formatIdList, highlightId, logger } from "../util/logger";

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
    let result: FadeResponseDto;

    if (hasReleaseId) {
      const releaseId = Number(body.releaseId);
      if (!Number.isInteger(releaseId)) {
        res.status(400).json({ error: "releaseId must be an integer" });
        return;
      }
      result = await resolveFadeFromRelease(releaseId);
    } else {
      const masterId = Number(body.masterId);
      if (!Number.isInteger(masterId)) {
        res.status(400).json({ error: "masterId must be an integer" });
        return;
      }
      result = await resolveFadeFromMaster(masterId);
    }

    const kind = hasReleaseId ? "release" : "master";
    const sourceId = highlightId(hasReleaseId ? body.releaseId! : body.masterId!);
    const masterId = result.masterId !== undefined ? highlightId(result.masterId) : "n/a";
    logger.info(
      `Faded ${kind} ${sourceId} → masterId=${masterId} ` +
        `cascade(${result.releaseIds.length})=${formatIdList(result.releaseIds)}`,
    );

    res.json(result);
  } catch (err) {
    if (err instanceof DiscogsNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    logger.error("Failed to resolve fade ids from Discogs", err);
    res.status(502).json({ error: "Failed to resolve fade ids from Discogs" });
  }
});
