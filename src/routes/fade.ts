import { Router } from "express";
import { DiscogsNotFoundError } from "../discogs-client";
import type { FadeRequestDto } from "../dto/fade.dto";
import { resolveFadeIds } from "../services/fade-resolver";

export const fadeRouter = Router();

fadeRouter.post("/", async (req, res) => {
  const body = req.body as Partial<FadeRequestDto>;
  const releaseId = Number(body.releaseId);
  const action = body.action ?? "fade";

  if (!Number.isInteger(releaseId)) {
    res.status(400).json({ error: "releaseId must be an integer" });
    return;
  }
  if (action !== "fade") {
    res.status(400).json({ error: `Unsupported action: ${String(action)}` });
    return;
  }

  try {
    const result = await resolveFadeIds(releaseId);
    res.json(result);
  } catch (err) {
    if (err instanceof DiscogsNotFoundError) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    res.status(502).json({ error: "Failed to resolve fade ids from Discogs" });
  }
});
