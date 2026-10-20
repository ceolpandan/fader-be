import { and, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { wantlistFolderItems, wantlistFolders, wantlistItems } from "../db/schema";
import type { WantlistFolderChangeDto, WantlistFolderDto } from "../dto/wantlist-folder.dto";

export interface WantlistFoldersRouterDeps {
  db: Db;
}

const MAX_NAME_LENGTH = 50;
const MAX_RELEASE_IDS = 1000;

function parseName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "name must not be empty" };
  if (name.length > MAX_NAME_LENGTH) return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  return { name };
}

function parseReleaseIds(value: unknown): { releaseIds: number[] } | { error: string } {
  if (!Array.isArray(value) || value.length > MAX_RELEASE_IDS || !value.every((id) => Number.isInteger(id) && id > 0)) {
    return { error: `releaseIds must be an array of at most ${MAX_RELEASE_IDS} positive integers` };
  }
  return { releaseIds: [...new Set(value as number[])] };
}

function parseFolderId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The signed-in collector's Fader-only wantlist folders; every query is scoped to their `uid`. */
export function createWantlistFoldersRouter(deps: WantlistFoldersRouterDeps): Router {
  const router = Router();
  const { db } = deps;

  const itemCount = (uid: string, folderId: number): number =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(wantlistFolderItems)
      .innerJoin(
        wantlistItems,
        and(eq(wantlistItems.uid, wantlistFolderItems.uid), eq(wantlistItems.releaseId, wantlistFolderItems.releaseId)),
      )
      .where(and(eq(wantlistFolderItems.uid, uid), eq(wantlistFolderItems.folderId, folderId)))
      .get()!.n;

  const findFolder = (uid: string, folderId: number) =>
    db
      .select()
      .from(wantlistFolders)
      .where(and(eq(wantlistFolders.uid, uid), eq(wantlistFolders.id, folderId)))
      .get();

  const nameTaken = (uid: string, name: string, exceptId?: number): boolean => {
    const row = db
      .select({ id: wantlistFolders.id })
      .from(wantlistFolders)
      .where(and(eq(wantlistFolders.uid, uid), sql`lower(${wantlistFolders.name}) = lower(${name})`))
      .get();
    return row !== undefined && row.id !== exceptId;
  };

  /** Splits the ids into those on the collector's wantlist and those that are not. */
  const splitByWantlist = (uid: string, releaseIds: number[]): { onWantlist: number[]; ignored: number[] } => {
    const onList = new Set(
      db
        .select({ id: wantlistItems.releaseId })
        .from(wantlistItems)
        .where(eq(wantlistItems.uid, uid))
        .all()
        .map((row) => row.id),
    );
    return {
      onWantlist: releaseIds.filter((id) => onList.has(id)),
      ignored: releaseIds.filter((id) => !onList.has(id)),
    };
  };

  const moveIn = (uid: string, folderId: number, releaseIds: number[]): void => {
    for (const releaseId of releaseIds) {
      db.insert(wantlistFolderItems)
        .values({ uid, releaseId, folderId })
        .onConflictDoUpdate({ target: [wantlistFolderItems.uid, wantlistFolderItems.releaseId], set: { folderId } })
        .run();
    }
  };

  const changeBody = (uid: string, folder: { id: number; name: string }, ignored: number[]): WantlistFolderChangeDto => ({
    id: folder.id,
    name: folder.name,
    itemCount: itemCount(uid, folder.id),
    ignoredReleaseIds: ignored,
  });

  router.get("/", (req, res) => {
    const uid = req.user!.uid;
    const folders = db.select().from(wantlistFolders).where(eq(wantlistFolders.uid, uid)).all();
    const body: WantlistFolderDto[] = folders
      .map((folder) => ({ id: folder.id, name: folder.name, itemCount: itemCount(uid, folder.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id);
    res.set("Cache-Control", "no-store").json(body);
  });

  router.post("/", (req, res) => {
    const uid = req.user!.uid;
    const name = parseName(req.body?.name);
    if ("error" in name) {
      res.status(400).json({ error: name.error });
      return;
    }
    const ids = parseReleaseIds(req.body?.releaseIds ?? []);
    if ("error" in ids) {
      res.status(400).json({ error: ids.error });
      return;
    }
    if (nameTaken(uid, name.name)) {
      res.status(409).json({ error: "You already have a folder with that name" });
      return;
    }

    const { onWantlist, ignored } = splitByWantlist(uid, ids.releaseIds);
    const folderId = db.transaction(() => {
      const created = db
        .insert(wantlistFolders)
        .values({ uid, name: name.name })
        .returning({ id: wantlistFolders.id })
        .get();
      moveIn(uid, created.id, onWantlist);
      return created.id;
    });
    res.status(201).json(changeBody(uid, { id: folderId, name: name.name }, ignored));
  });

  router.patch("/:id", (req, res) => {
    const uid = req.user!.uid;
    const folderId = parseFolderId(req.params.id);
    if (folderId === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    const name = parseName(req.body?.name);
    if ("error" in name) {
      res.status(400).json({ error: name.error });
      return;
    }
    if (!findFolder(uid, folderId)) {
      res.status(404).json({ error: "No such folder" });
      return;
    }
    if (nameTaken(uid, name.name, folderId)) {
      res.status(409).json({ error: "You already have a folder with that name" });
      return;
    }
    db.update(wantlistFolders).set({ name: name.name }).where(eq(wantlistFolders.id, folderId)).run();
    const body: WantlistFolderDto = { id: folderId, name: name.name, itemCount: itemCount(uid, folderId) };
    res.json(body);
  });

  router.delete("/:id", (req, res) => {
    const uid = req.user!.uid;
    const folderId = parseFolderId(req.params.id);
    if (folderId === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    if (!findFolder(uid, folderId)) {
      res.status(404).json({ error: "No such folder" });
      return;
    }
    db.transaction(() => {
      db.delete(wantlistFolderItems)
        .where(and(eq(wantlistFolderItems.uid, uid), eq(wantlistFolderItems.folderId, folderId)))
        .run();
      db.delete(wantlistFolders).where(eq(wantlistFolders.id, folderId)).run();
    });
    res.status(204).end();
  });

  router.put("/:id/items", (req, res) => {
    const uid = req.user!.uid;
    const folderId = parseFolderId(req.params.id);
    const ids = parseReleaseIds(req.body?.releaseIds);
    if (folderId === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    if ("error" in ids) {
      res.status(400).json({ error: ids.error });
      return;
    }
    const folder = findFolder(uid, folderId);
    if (!folder) {
      res.status(404).json({ error: "No such folder" });
      return;
    }
    const { onWantlist, ignored } = splitByWantlist(uid, ids.releaseIds);
    db.transaction(() => moveIn(uid, folderId, onWantlist));
    res.json(changeBody(uid, folder, ignored));
  });

  router.delete("/:id/items", (req, res) => {
    const uid = req.user!.uid;
    const folderId = parseFolderId(req.params.id);
    const ids = parseReleaseIds(req.body?.releaseIds);
    if (folderId === null) {
      res.status(400).json({ error: "id must be a positive integer" });
      return;
    }
    if ("error" in ids) {
      res.status(400).json({ error: ids.error });
      return;
    }
    const folder = findFolder(uid, folderId);
    if (!folder) {
      res.status(404).json({ error: "No such folder" });
      return;
    }
    const { onWantlist, ignored } = splitByWantlist(uid, ids.releaseIds);
    if (onWantlist.length > 0) {
      db.delete(wantlistFolderItems)
        .where(
          and(
            eq(wantlistFolderItems.uid, uid),
            eq(wantlistFolderItems.folderId, folderId),
            inArray(wantlistFolderItems.releaseId, onWantlist),
          ),
        )
        .run();
    }
    res.json(changeBody(uid, folder, ignored));
  });

  return router;
}
