import fs from "node:fs";
import { sqliteGenerate } from "drizzle-dbml-generator";
import * as schema from "../src/db/schema";

/**
 * The schema declares no foreign keys (the importer and the Discogs queue write rows in bulk and
 * independently), so the generator draws no relations. These are the logical ones, kept by hand.
 */
const LOGICAL_REFS = `
// Logical relations (not enforced by SQLite). releases.master_id has no Ref: it is nullable and
// master_versions.master_id is only half of a composite key, so DBML cannot express it.
Ref: release_genres.release_id > releases.id
Ref: release_styles.release_id > releases.id
Ref: release_formats.release_id > releases.id
Ref: master_versions.release_id > releases.id
Ref: enrichment_not_found.run_id > enrichment_runs.id
Ref: discogs_queue_jobs.run_id > enrichment_runs.id
Ref: enrichment_runs.uid > discogs_tokens.uid
Ref: discogs_profiles.uid - discogs_tokens.uid
Ref: user_settings.uid - discogs_tokens.uid
Ref: saved_filters.uid > discogs_tokens.uid
Ref: fades.uid > discogs_tokens.uid
`;

const dbml = sqliteGenerate({ schema, relational: false });
fs.mkdirSync("docs/architecture", { recursive: true });
fs.writeFileSync("docs/architecture/schema.dbml", dbml + LOGICAL_REFS);
console.log("Wrote docs/architecture/schema.dbml");
