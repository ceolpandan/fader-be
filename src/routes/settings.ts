import { eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "../db/client";
import { DEFAULT_RARITY_HAVE_MAX, DEFAULT_THEME, THEMES, userSettings } from "../db/schema";
import type {
  SettingsDto,
  UpdateSettingsRequestDto,
} from "../dto/settings.dto";

export interface SettingsRouterDeps {
  db: Db;
}

/** The user's rarity ceiling, or the default when they never changed it. */
export function rarityHaveMaxOf(db: Db, uid: string): number {
  const row = db
    .select({ rarityHaveMax: userSettings.rarityHaveMax })
    .from(userSettings)
    .where(eq(userSettings.uid, uid))
    .get();
  return row?.rarityHaveMax ?? DEFAULT_RARITY_HAVE_MAX;
}

export function createSettingsRouter(deps: SettingsRouterDeps): Router {
  const router = Router();

  function settingsOf(uid: string): SettingsDto {
    const row = deps.db
      .select({ theme: userSettings.theme })
      .from(userSettings)
      .where(eq(userSettings.uid, uid))
      .get();
    return {
      theme: row?.theme ?? DEFAULT_THEME,
      rarityHaveMax: rarityHaveMaxOf(deps.db, uid),
    };
  }

  router.get("/", (req, res) => {
    res.set("Cache-Control", "no-store").json(settingsOf(req.user!.uid));
  });

  router.patch("/", (req, res) => {
    const body = (req.body ?? {}) as Partial<
      Record<keyof UpdateSettingsRequestDto, unknown>
    >;
    const uid = req.user!.uid;

    if (body.theme !== undefined && !THEMES.includes(body.theme as never)) {
      res
        .status(400)
        .json({ error: `theme must be one of: ${THEMES.join(", ")}` });
      return;
    }
    if (
      body.rarityHaveMax !== undefined &&
      !(Number.isInteger(body.rarityHaveMax) && (body.rarityHaveMax as number) >= 1)
    ) {
      res.status(400).json({ error: "rarityHaveMax must be a positive integer" });
      return;
    }

    const next: SettingsDto = {
      ...settingsOf(uid),
      ...(body.theme !== undefined && {
        theme: body.theme as SettingsDto["theme"],
      }),
      ...(body.rarityHaveMax !== undefined && {
        rarityHaveMax: body.rarityHaveMax as number,
      }),
    };
    const updatedAt = new Date();
    deps.db
      .insert(userSettings)
      .values({ uid, theme: next.theme, rarityHaveMax: next.rarityHaveMax, updatedAt })
      .onConflictDoUpdate({
        target: userSettings.uid,
        set: { theme: next.theme, rarityHaveMax: next.rarityHaveMax, updatedAt },
      })
      .run();

    res.json(next);
  });

  return router;
}
