import type Database from "better-sqlite3";

/** The SQL that fills `filter_options` from the releases, most common value first. */
export const FILL_FILTER_OPTIONS_SQL = [
  `INSERT INTO filter_options (kind, value, position)
   SELECT 'genre', genre, ROW_NUMBER() OVER (ORDER BY count(*) DESC, genre) FROM release_genres GROUP BY genre`,
  `INSERT INTO filter_options (kind, value, position)
   SELECT 'style', style, ROW_NUMBER() OVER (ORDER BY count(*) DESC, style) FROM release_styles GROUP BY style`,
  `INSERT INTO filter_options (kind, value, position)
   SELECT 'format', format, ROW_NUMBER() OVER (ORDER BY count(*) DESC, format) FROM release_formats GROUP BY format`,
  `INSERT INTO filter_options (kind, value, position)
   SELECT 'country', country, ROW_NUMBER() OVER (ORDER BY count(*) DESC, country) FROM releases WHERE country IS NOT NULL GROUP BY country`,
];

/** Rebuilds `filter_options` from the stored releases. The importer calls it after the load. */
export function rebuildFilterOptions(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec("DELETE FROM filter_options");
    for (const statement of FILL_FILTER_OPTIONS_SQL) sqlite.exec(statement);
  })();
}
