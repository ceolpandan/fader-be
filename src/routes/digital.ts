import { and, eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { releases, wantlistItems } from "../db/schema";
import { checkRelease } from "../digital/check-release";
import { InvalidCurlError, parseCurl } from "../digital/curl";
import { toDigitalMatchDto } from "../digital/digital-match-dto";
import { DigitalScanner, type DigitalScanRow } from "../digital/digital-scan";
import { toDigitalScanDto } from "../digital/digital-scan-dto";
import type { DigitalStores } from "../digital/digital-stores";
import { CHECK_PRIORITY } from "../digital/paced-lane";
import { saveDigitalMatch } from "../digital/save-match";
import {
  DIGITAL_STORE_IDS,
  StoreSessionExpiredError,
  StoreUnavailableError,
  type DigitalStoreId,
} from "../digital/types";
import type {
  CheckDigitalMatchRequestDto,
  DigitalScanStatusDto,
  SaveStoreSessionRequestDto,
  StartDigitalScanRequestDto,
  StoreSessionDto,
} from "../dto/digital.dto";
import { logger } from "../util/logger";

export interface DigitalRouterDeps {
  db: Db;
  digital: DigitalStores;
}

/** The longest curl accepted: a browser's copy is a few KB, cookies included. */
const MAX_CURL_LENGTH = 32_000;

const SESSION_REQUIRED = { error: "Paste a fresh curl from your browser first", code: "store_session_required" };

/**
 * Checking the signed-in collector's wantlist items against a digital store (fader-ui#160). The
 * collector pastes a curl first (`PUT /digital/{store}/session`, kept in memory for a day), then a
 * check (`POST /digital/{store}/matches`) answers once the store has been searched, which takes a
 * second or more per request.
 */
export function createDigitalRouter(deps: DigitalRouterDeps): Router {
  const router = Router();
  const { db, digital } = deps;
  const scanner = new DigitalScanner(db, digital);

  const storeOf = (id: string) =>
    DIGITAL_STORE_IDS.includes(id as DigitalStoreId) ? digital.stores[id as DigitalStoreId] : undefined;

  router.put("/:store/session", (req, res) => {
    const uid = req.user!.uid;
    const registered = storeOf(req.params.store);
    if (!registered) {
      res.status(404).json({ error: "Unknown digital store" });
      return;
    }
    const { curl } = (req.body ?? {}) as Partial<SaveStoreSessionRequestDto>;
    if (typeof curl !== "string" || curl.trim() === "" || curl.length > MAX_CURL_LENGTH) {
      res.status(400).json({ error: `curl must be the copied command, at most ${MAX_CURL_LENGTH} characters` });
      return;
    }
    try {
      const session = parseCurl(curl, registered.host);
      const expiresAt = digital.sessions.set(uid, registered.store.id, session);
      scanner.resume(uid, registered.store.id);
      const body: StoreSessionDto = { store: registered.store.id, expiresAt: expiresAt.toISOString() };
      res.json(body);
    } catch (err) {
      if (err instanceof InvalidCurlError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/:store/matches", async (req, res) => {
    const uid = req.user!.uid;
    const registered = storeOf(req.params.store);
    if (!registered) {
      res.status(404).json({ error: "Unknown digital store" });
      return;
    }
    const { releaseId } = (req.body ?? {}) as Partial<CheckDigitalMatchRequestDto>;
    if (typeof releaseId !== "number" || !Number.isInteger(releaseId) || releaseId < 1) {
      res.status(400).json({ error: "releaseId must be a positive integer" });
      return;
    }

    const onWantlist = db
      .select({ releaseId: wantlistItems.releaseId })
      .from(wantlistItems)
      .where(and(eq(wantlistItems.uid, uid), eq(wantlistItems.releaseId, releaseId)))
      .get();
    if (!onWantlist) {
      res.status(404).json({ error: "That release is not on your wantlist" });
      return;
    }
    const release = db
      .select({ id: releases.id, title: releases.title, artists: releases.artists, tracklist: releases.tracklist })
      .from(releases)
      .where(eq(releases.id, releaseId))
      .get();
    if (!release) {
      res.status(409).json({ error: "That release is not stored yet. Try again once it has been fetched." });
      return;
    }

    const session = digital.sessions.get(uid, registered.store.id);
    if (!session) {
      res.status(409).json(SESSION_REQUIRED);
      return;
    }

    try {
      const result = await checkRelease(registered.store, registered.lane, session, release, {
        priority: CHECK_PRIORITY,
      });
      res.json(toDigitalMatchDto(saveDigitalMatch(db, releaseId, registered.store.id, result)));
    } catch (err) {
      if (err instanceof StoreSessionExpiredError) {
        digital.sessions.clear(uid, registered.store.id);
        res.status(409).json(SESSION_REQUIRED);
      } else if (err instanceof StoreUnavailableError) {
        res.status(503).json({ error: "The store is unavailable right now. Try again in a moment." });
      } else {
        logger.error("Checking a release against a digital store failed", err);
        res.status(502).json({ error: "Couldn't check the store. Try again." });
      }
    }
  });

  const scanDto = (scan: DigitalScanRow, registered: NonNullable<ReturnType<typeof storeOf>>) =>
    toDigitalScanDto(db, scan, registered.lane.gapMs);

  router.get("/:store/scan", (req, res) => {
    const registered = storeOf(req.params.store);
    if (!registered) {
      res.status(404).json({ error: "Unknown digital store" });
      return;
    }
    const scan = scanner.current(req.user!.uid, registered.store.id);
    const body: DigitalScanStatusDto = { scan: scan ? scanDto(scan, registered) : null };
    res.set("Cache-Control", "no-store").json(body);
  });

  router.post("/:store/scan", (req, res) => {
    const registered = storeOf(req.params.store);
    if (!registered) {
      res.status(404).json({ error: "Unknown digital store" });
      return;
    }
    const { recheck } = (req.body ?? {}) as Partial<StartDigitalScanRequestDto>;
    if (recheck !== undefined && typeof recheck !== "boolean") {
      res.status(400).json({ error: "recheck must be a boolean" });
      return;
    }
    const result = scanner.start(req.user!.uid, registered.store.id, recheck === true);
    if ("conflict" in result) {
      if (result.conflict === "scan_active") {
        res.status(409).json({ error: "A scan of this store is already active", code: "scan_active" });
      } else {
        res.status(409).json(SESSION_REQUIRED);
      }
      return;
    }
    res.status(201).json(scanDto(result.scan, registered));
  });

  router.post("/:store/scan/cancel", (req, res) => {
    const registered = storeOf(req.params.store);
    if (!registered) {
      res.status(404).json({ error: "Unknown digital store" });
      return;
    }
    const scan = scanner.cancel(req.user!.uid, registered.store.id);
    if (!scan) {
      res.status(409).json({ error: "No scan of this store is active", code: "no_active_scan" });
      return;
    }
    res.json(scanDto(scan, registered));
  });

  return router;
}
