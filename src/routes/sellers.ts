import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { discogsQueueJobs, releases, sellerInventory, sellers, type SellerInventoryStatus } from "../db/schema";
import type { IndexStartedDto, SellerInventoryPageDto, SellerStatusDto } from "../dto/seller.dto";
import type { DiscogsQueue } from "../queue/discogs-queue";

const INVENTORY_STATUS_FILTERS = ["active", "sold", "all"] as const;
type InventoryStatusFilter = (typeof INVENTORY_STATUS_FILTERS)[number];

export interface SellersRouterDeps {
  db: Db;
  queue: DiscogsQueue;
}

export function createSellersRouter(deps: SellersRouterDeps): Router {
  const router = Router();

  router.post("/:username/index", (req, res) => {
    const { username } = req.params;

    const [existing] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
    if (existing?.lastIndexStatus === "running") {
      res.status(409).json({ error: `Indexing is already running for ${username}` });
      return;
    }

    const runId = randomUUID();
    const runStartedAt = new Date().toISOString();

    deps.db
      .insert(sellers)
      .values({ username, lastIndexStatus: "running", currentRunId: runId })
      .onConflictDoUpdate({
        target: sellers.username,
        set: { lastIndexStatus: "running", currentRunId: runId },
      })
      .run();

    deps.queue.enqueue({
      runId,
      type: "inventory_page",
      payload: { username, page: 1, runStartedAt },
    });

    const dto: IndexStartedDto = { username, runId };
    res.status(202).json(dto);
  });

  router.get("/:username", (req, res) => {
    const { username } = req.params;

    const [seller] = deps.db.select().from(sellers).where(eq(sellers.username, username)).all();
    if (!seller) {
      res.status(404).json({ error: `${username} has never been indexed` });
      return;
    }

    const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
    if (seller.currentRunId) {
      const jobs = deps.db
        .select({ status: discogsQueueJobs.status })
        .from(discogsQueueJobs)
        .where(
          and(
            eq(discogsQueueJobs.runId, seller.currentRunId),
            eq(discogsQueueJobs.type, "release_detail"),
          ),
        )
        .all();
      for (const job of jobs) counts[job.status] += 1;
    }

    const dto: SellerStatusDto = {
      username: seller.username,
      lastIndexedAt: seller.lastIndexedAt?.toISOString() ?? null,
      lastIndexStatus: seller.lastIndexStatus,
      currentlyRunning: seller.lastIndexStatus === "running",
      totalReleasesFound: counts.pending + counts.processing + counts.done + counts.failed,
      releasesEnriched: counts.done,
      releasesFailed: counts.failed,
    };
    res.json(dto);
  });

  router.get("/:username/inventory", (req, res) => {
    const { username } = req.params;

    const statusParam = (req.query.status as string | undefined) ?? "active";
    if (!INVENTORY_STATUS_FILTERS.includes(statusParam as InventoryStatusFilter)) {
      res.status(400).json({ error: "status must be one of active, sold, all" });
      return;
    }
    const statusFilter = statusParam as InventoryStatusFilter;

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

    const whereClause =
      statusFilter === "all"
        ? eq(sellerInventory.sellerUsername, username)
        : and(
            eq(sellerInventory.sellerUsername, username),
            eq(sellerInventory.status, statusFilter as SellerInventoryStatus),
          );

    const total = deps.db
      .select({ count: sql<number>`count(*)` })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(whereClause)
      .all()[0]!.count;

    const rows = deps.db
      .select({
        releaseId: sellerInventory.releaseId,
        title: releases.title,
        thumb: releases.thumb,
        year: releases.year,
        status: sellerInventory.status,
        firstSeenAt: sellerInventory.firstSeenAt,
        soldAt: sellerInventory.soldAt,
      })
      .from(sellerInventory)
      .innerJoin(releases, eq(sellerInventory.releaseId, releases.id))
      .where(whereClause)
      .orderBy(sellerInventory.releaseId)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    const dto: SellerInventoryPageDto = {
      items: rows.map((row) => ({
        releaseId: row.releaseId,
        title: row.title,
        thumb: row.thumb,
        year: row.year,
        status: row.status,
        firstSeenAt: row.firstSeenAt.toISOString(),
        soldAt: row.soldAt?.toISOString() ?? null,
      })),
      page,
      pageSize,
      total,
    };
    res.json(dto);
  });

  return router;
}
