import { sql } from "drizzle-orm";
import { releases } from "./schema";

/** Explore leaves out releases an enrichment run found Discogs no longer has. */
export const isNotMissing = sql`${releases.missingAt} IS NULL`;
