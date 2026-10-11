import { and, asc, eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { savedFilters } from "../db/schema";
import type {
  CreateSavedFilterRequestDto,
  RenameSavedFilterRequestDto,
  SavedFilterDto,
} from "../dto/saved-filter.dto";

export interface SavedFiltersRouterDeps {
  db: Db;
}

const MAX_NAME_LENGTH = 200;
const MAX_QUERY_LENGTH = 4000;

function parseName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "name must not be empty" };
  if (name.length > MAX_NAME_LENGTH) return { error: `name must be at most ${MAX_NAME_LENGTH} characters` };
  return { name };
}

function toDto(row: typeof savedFilters.$inferSelect): SavedFilterDto {
  return { id: row.id, name: row.name, query: row.query, createdAt: row.createdAt.toISOString() };
}

export function createSavedFiltersRouter(deps: SavedFiltersRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const rows = deps.db
      .select()
      .from(savedFilters)
      .where(eq(savedFilters.uid, req.user!.uid))
      .orderBy(asc(savedFilters.createdAt), asc(savedFilters.id))
      .all();
    res.set("Cache-Control", "no-store").json(rows.map(toDto));
  });

  router.post("/", (req, res) => {
    const body = (req.body ?? {}) as Partial<Record<keyof CreateSavedFilterRequestDto, unknown>>;
    const parsed = parseName(body.name);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const query = typeof body.query === "string" ? body.query.replace(/^\?/, "") : "";
    if (!query) {
      res.status(400).json({ error: "query must not be empty" });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: `query must be at most ${MAX_QUERY_LENGTH} characters` });
      return;
    }

    const uid = req.user!.uid;
    const existing = deps.db
      .select({ id: savedFilters.id })
      .from(savedFilters)
      .where(and(eq(savedFilters.uid, uid), eq(savedFilters.query, query)))
      .get();
    if (existing) {
      res.status(409).json({ error: "This filter is already saved" });
      return;
    }

    const row = deps.db
      .insert(savedFilters)
      .values({ uid, name: parsed.name, query, createdAt: new Date() })
      .returning()
      .get();
    res.status(201).json(toDto(row));
  });

  router.patch("/:id", (req, res) => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as Partial<Record<keyof RenameSavedFilterRequestDto, unknown>>;
    const parsed = parseName(body.name);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const row = Number.isInteger(id)
      ? deps.db
          .update(savedFilters)
          .set({ name: parsed.name })
          .where(and(eq(savedFilters.uid, req.user!.uid), eq(savedFilters.id, id)))
          .returning()
          .get()
      : undefined;
    if (!row) {
      res.status(404).json({ error: "Saved filter not found" });
      return;
    }
    res.json(toDto(row));
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id)
      ? deps.db
          .delete(savedFilters)
          .where(and(eq(savedFilters.uid, req.user!.uid), eq(savedFilters.id, id)))
          .returning({ id: savedFilters.id })
          .get()
      : undefined;
    if (!row) {
      res.status(404).json({ error: "Saved filter not found" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
