import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { rebuildFilterOptions } from "../db/filter-options";
import { refreshVersionCounts } from "../db/version-counts";
import { createReleaseParser, toReleaseRow, type DumpRelease } from "./release-xml";

export interface ImportOptions {
  /** The `releases.xml` or `releases.xml.gz` from the Discogs data dump. */
  dumpPath: string;
  /** The new database file. The live database is never written to. */
  outPath: string;
  /** Replace `outPath` if it exists. */
  force?: boolean;
  /** Keep the releases that have this genre. */
  genre?: string;
  /** Read only evenly spaced chunks of the file (plain `.xml` only), for a sample database. */
  sample?: { chunks: number; chunkBytes: number };
  /** An existing database to carry the fades, user settings, saved filters and Discogs tokens over from. */
  carryOverFrom?: string;
  migrationsFolder?: string;
  log?: (message: string) => void;
}

export interface ImportStats {
  scanned: number;
  kept: number;
  masterVersions: number;
  fadesCarried: number;
  /** Releases copied from the old database, which the dump never overwrites. */
  releasesCarried: number;
  /** Dump releases that were new to the database (the rest were already there). */
  releasesAdded: number;
  seconds: number;
}

const BATCH_SIZE = 20_000;
const READ_BYTES = 8 * 1024 * 1024;

/**
 * Builds a new database from the Discogs releases dump: the migrations, then the old database's
 * releases (when carrying over), then every dump release with the genre that is not there yet
 * (existing rows always win), then the indexes (built after the load, which is much faster). Only the fades, user
 * settings, saved filters and Discogs tokens are carried over from `carryOverFrom`. Swap the file in by pointing `DB_PATH` at
 * it with the API stopped.
 */
export async function importDump(options: ImportOptions): Promise<ImportStats> {
  const log = options.log ?? (() => {});
  const genre = options.genre ?? "Electronic";
  const started = Date.now();

  if (fs.existsSync(options.outPath)) {
    if (!options.force) throw new Error(`${options.outPath} exists; pass force to replace it`);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(options.outPath + suffix, { force: true });
  }
  fs.mkdirSync(path.dirname(path.resolve(options.outPath)), { recursive: true });

  const sqlite = new Database(options.outPath);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: options.migrationsFolder ?? "./drizzle" });
    sqlite.pragma("synchronous = OFF");
    sqlite.pragma("journal_mode = OFF");

    const indexes = sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
         AND tbl_name IN ('releases', 'release_genres', 'release_styles', 'release_formats')`,
      )
      .all() as { name: string; sql: string }[];
    for (const index of indexes) sqlite.exec(`DROP INDEX "${index.name}"`);

    const insertRelease = sqlite.prepare(
      `INSERT OR IGNORE INTO releases (id, title, year, country, genres, styles, formats, master_id, labels, artists, tracklist, videos)
       VALUES (@id, @title, @year, @country, @genres, @styles, @formats, @masterId, @labels, @artists, @tracklist, @videos)`,
    );
    const insertMasterVersion = sqlite.prepare("INSERT OR IGNORE INTO master_versions (master_id, release_id) VALUES (?, ?)");

    const stats: ImportStats = {
      scanned: 0,
      kept: 0,
      masterVersions: 0,
      fadesCarried: 0,
      releasesCarried: 0,
      releasesAdded: 0,
      seconds: 0,
    };
    if (options.carryOverFrom) {
      log(`Copying the releases of ${options.carryOverFrom}`);
      stats.releasesCarried = carryOverReleases(sqlite, options.carryOverFrom);
      log(`  ${stats.releasesCarried} releases copied`);
    }
    let pending = 0;
    sqlite.exec("BEGIN");
    const onRelease = (release: DumpRelease): void => {
      stats.scanned++;
      if (!release.genres.includes(genre)) return;
      const row = toReleaseRow(release);
      const inserted = insertRelease.run({
        ...row,
        genres: JSON.stringify(row.genres),
        styles: JSON.stringify(row.styles),
        formats: JSON.stringify(row.formats),
        labels: JSON.stringify(row.labels),
        artists: JSON.stringify(row.artists),
        tracklist: JSON.stringify(row.tracklist),
        videos: JSON.stringify(row.videos),
      });
      stats.kept++;
      stats.releasesAdded += inserted.changes;
      if (row.masterId) stats.masterVersions += insertMasterVersion.run(row.masterId, row.id).changes;
      if (++pending >= BATCH_SIZE) {
        sqlite.exec("COMMIT; BEGIN");
        pending = 0;
      }
    };

    if (options.sample) readSample(options.dumpPath, options.sample, onRelease, stats, log);
    else await readAll(options.dumpPath, onRelease, stats, log);
    sqlite.exec("COMMIT");

    log(`Loaded ${stats.kept} releases of ${stats.scanned}; building ${indexes.length} indexes`);
    for (const index of indexes) {
      const t = Date.now();
      sqlite.exec(index.sql);
      log(`  ${index.name} ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    rebuildFilterOptions(sqlite);
    log("Counting versions per master");
    refreshVersionCounts(sqlite);
    sqlite.exec("ANALYZE");

    if (options.carryOverFrom) stats.fadesCarried = carryOver(sqlite, options.carryOverFrom);
    sqlite.pragma("journal_mode = WAL");
    stats.seconds = (Date.now() - started) / 1000;
    log(
      `Done in ${(stats.seconds / 60).toFixed(1)} min: ${stats.releasesCarried} releases kept from the old database, ${stats.releasesAdded} added from the dump (${stats.kept} matched), ${stats.masterVersions} master versions, ${stats.fadesCarried} fades carried over`,
    );
    return stats;
  } finally {
    sqlite.close();
  }
}

/**
 * Copies the old database's releases, and the master versions fade lookups stored, into the new
 * one before the dump loads. The dump then only adds releases that are not there yet, so an
 * existing row, enriched or not, always wins. Only the columns both databases have are copied.
 */
function carryOverReleases(target: Database.Database, oldPath: string): number {
  target.prepare("ATTACH DATABASE ? AS old").run(oldPath);
  try {
    const columns = (table: string, schema: string) =>
      (target.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    let releases = 0;
    for (const table of ["releases", "master_versions"]) {
      const inOld = columns(table, "old");
      const list = columns(table, "main")
        .filter((c) => inOld.includes(c))
        .map((c) => `"${c}"`)
        .join(", ");
      if (!list) continue; // an older database without this table
      const { changes } = target
        .prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM old.${table}`)
        .run();
      if (table === "releases") releases = changes;
    }
    return releases;
  } finally {
    target.exec("DETACH DATABASE old");
  }
}

/** Copies `fades`, `user_settings`, `saved_filters` and `discogs_tokens`, by the columns both databases have. Returns the fades copied. */
function carryOver(target: Database.Database, oldPath: string): number {
  target.prepare("ATTACH DATABASE ? AS old").run(oldPath);
  try {
    let fades = 0;
    for (const table of ["fades", "user_settings", "saved_filters", "discogs_tokens"]) {
      const columns = (schema: string) =>
        (target.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      const inOld = columns("old");
      const list = columns("main")
        .filter((c) => inOld.includes(c))
        .map((c) => `"${c}"`)
        .join(", ");
      if (!list) continue; // an older database without this table
      const { changes } = target.prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM old.${table}`).run();
      if (table === "fades") fades = changes;
    }
    return fades;
  } finally {
    target.exec("DETACH DATABASE old");
  }
}

async function readAll(
  dumpPath: string,
  onRelease: (r: DumpRelease) => void,
  stats: ImportStats,
  log: (m: string) => void,
): Promise<void> {
  const total = fs.statSync(dumpPath).size;
  const file = fs.createReadStream(dumpPath, { highWaterMark: READ_BYTES });
  const source = dumpPath.endsWith(".gz") ? file.pipe(zlib.createGunzip()) : file;
  const parser = createReleaseParser(onRelease);
  const decoder = new StringDecoder("utf8");
  const started = Date.now();
  let lastLogged = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    parser.write(decoder.write(chunk));
    if (stats.scanned - lastLogged >= 500_000) {
      lastLogged = stats.scanned;
      const done = Math.min(1, file.bytesRead / total);
      const elapsed = (Date.now() - started) / 1000;
      log(
        `${(done * 100).toFixed(1)}% of the file, ${stats.scanned} scanned, ${stats.kept} kept, ${(elapsed / 60).toFixed(1)} min, about ${((elapsed / done - elapsed) / 60).toFixed(0)} min left`,
      );
    }
  }
  parser.write(decoder.end());
  parser.close();
}

/**
 * Systematic sample: `chunks` evenly spaced pieces of `chunkBytes` across the whole file, each
 * trimmed to whole releases, so the sample keeps the real mix of eras.
 */
function readSample(
  dumpPath: string,
  sample: { chunks: number; chunkBytes: number },
  onRelease: (r: DumpRelease) => void,
  stats: ImportStats,
  log: (m: string) => void,
): void {
  if (dumpPath.endsWith(".gz")) throw new Error("Sampling needs the plain .xml; a .gz cannot be read from the middle");
  const fd = fs.openSync(dumpPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (sample.chunks * sample.chunkBytes > size) throw new Error("The sample chunks would overlap; use fewer or smaller chunks");
    const stride = Math.floor((size - sample.chunkBytes) / Math.max(1, sample.chunks - 1));
    const buffer = Buffer.alloc(sample.chunkBytes);
    for (let i = 0; i < sample.chunks; i++) {
      const read = fs.readSync(fd, buffer, 0, sample.chunkBytes, i * stride);
      const text = buffer.toString("utf8", 0, read);
      const first = text.indexOf('<release id="');
      const last = text.lastIndexOf("</release>");
      if (first < 0 || last < first) continue;
      const parser = createReleaseParser(onRelease);
      parser.write("<releases>" + text.slice(first, last + "</release>".length) + "</releases>");
      parser.close();
      if (i % 100 === 99) log(`chunk ${i + 1}/${sample.chunks}: ${stats.scanned} scanned, ${stats.kept} kept`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
