import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { discogsTokens } from "./schema";
import { decryptToken } from "../util/token-crypto";

/** The collector's Discogs token, decrypted; null when they have not saved one. */
export function getDiscogsToken(db: Db, uid: string): string | null {
  const row = db
    .select({ tokenEncrypted: discogsTokens.tokenEncrypted })
    .from(discogsTokens)
    .where(eq(discogsTokens.uid, uid))
    .get();
  return row ? decryptToken(row.tokenEncrypted) : null;
}

export function hasDiscogsToken(db: Db, uid: string): boolean {
  return (
    db.select({ uid: discogsTokens.uid }).from(discogsTokens).where(eq(discogsTokens.uid, uid)).get() !== undefined
  );
}
