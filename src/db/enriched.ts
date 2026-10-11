import { sql } from "drizzle-orm";
import { releases } from "./schema";

/** The release was fetched from the Discogs API by an enrichment run. */
export const isEnriched = sql`${releases.enrichedAt} IS NOT NULL`;
