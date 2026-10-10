import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { importDump } from "./import-dump";

const DUMP = `<?xml version="1.0" encoding="UTF-8"?>
<releases>
<release id="1" status="Accepted"><artists><artist><id>1</id><name>The Persuader</name><anv></anv></artist></artists><title>Stockholm &amp; Co</title><labels><label name="Svek" catno="SK032" id="5"/><label name="Svek" catno="SK 032" id="5"/></labels><extraartists><artist><id>9</id><name>Someone Else</name><role>Lacquer Cut By</role></artist></extraartists><formats><format name="Vinyl" qty="2" text=""><descriptions><description>12"</description><description>33 ⅓ RPM</description></descriptions></format><format name="CD" qty="1" text=""/></formats><genres><genre>Electronic</genre><genre>Rock</genre></genres><styles><style>Deep House</style></styles><country>Sweden</country><released>1999-03-00</released><notes>skip me</notes><master_id is_main_release="true">1660109</master_id><tracklist><track><position>A</position><title>Östermalm</title><duration>4:45</duration><artists><artist><id>77</id><name>Track Artist</name></artist></artists></track><track><position>B</position><title>Vasastaden</title><duration></duration></track></tracklist><identifiers><identifier type="Barcode" value="1"/></identifiers><videos><video src="https://www.youtube.com/watch?v=a" duration="325" embed="true"><title>Gamla Stan</title><description>long text</description></video></videos></release>
<release id="2"><artists><artist><id>2</id><name>Folk Band</name></artist></artists><title>Not Electronic</title><genres><genre>Folk, World, &amp; Country</genre></genres><styles></styles><country>US</country><released>1970</released><master_id is_main_release="true">55</master_id><tracklist></tracklist></release>
<release id="3"><artists><artist><id>3</id><name>No Master</name></artist></artists><title>Loose Single</title><genres><genre>Electronic</genre></genres><styles><style>Techno</style></styles><country>Germany</country><released>?</released><master_id is_main_release="false">0</master_id><tracklist></tracklist></release>
<release id="4"><artists><artist><id>4</id><name>Twice</name></artist></artists><title>Repeated Values</title><formats><format name="Vinyl" qty="1" text=""/><format name="Vinyl" qty="1" text=""/></formats><genres><genre>Electronic</genre><genre>Electronic</genre></genres><styles><style>Dub</style><style>Dub</style></styles><country>UK</country><released>2001</released><master_id is_main_release="true">0</master_id><tracklist></tracklist></release>
</releases>
`;

describe("importDump", () => {
  let dir: string;
  const open = (file: string) => new Database(path.join(dir, file), { readonly: true });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fader-import-"));
    fs.writeFileSync(path.join(dir, "releases.xml"), DUMP);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only Electronic releases, trimmed to the stored shape", async () => {
    const stats = await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "new.sqlite") });

    expect(stats).toMatchObject({ scanned: 4, kept: 3, masterVersions: 1 });
    const db = open("new.sqlite");
    const rows = db.prepare("SELECT * FROM releases ORDER BY id").all() as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual([1, 3, 4]);
    expect(rows[0]).toMatchObject({
      title: "Stockholm & Co",
      year: 1999,
      country: "Sweden",
      master_id: 1660109,
      track_count: 2,
      artist_sort: "The Persuader",
      format_sort: "Vinyl",
    });
    expect(JSON.parse(rows[0]!.genres as string)).toEqual(["Electronic", "Rock"]);
    expect(JSON.parse(rows[0]!.artists as string)).toEqual([{ id: 1, name: "The Persuader" }]);
    expect(JSON.parse(rows[0]!.labels as string)).toEqual([
      { id: 5, name: "Svek", catno: "SK032" },
      { id: 5, name: "Svek", catno: "SK 032" },
    ]);
    expect(JSON.parse(rows[0]!.formats as string)).toEqual([
      { name: "Vinyl", descriptions: ['12"', "33 ⅓ RPM"] },
      { name: "CD", descriptions: [] },
    ]);
    expect(JSON.parse(rows[0]!.tracklist as string)).toEqual([
      { position: "A", title: "Östermalm", duration: "4:45" },
      { position: "B", title: "Vasastaden" },
    ]);
    expect(JSON.parse(rows[0]!.videos as string)).toEqual([{ src: "https://www.youtube.com/watch?v=a", title: "Gamla Stan", duration: 325 }]);
    db.close();
  });

  it("stores no master and no year as null, and adds no master version for them", async () => {
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "new.sqlite") });

    const db = open("new.sqlite");
    expect(db.prepare("SELECT master_id, year FROM releases WHERE id = 3").get()).toEqual({ master_id: null, year: null });
    expect(db.prepare("SELECT master_id, release_id FROM master_versions").all()).toEqual([{ master_id: 1660109, release_id: 1 }]);
    db.close();
  });

  it("fills the side tables and rebuilds the indexes after the load", async () => {
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "new.sqlite") });

    const db = open("new.sqlite");
    expect(db.prepare("SELECT genre FROM release_genres WHERE release_id = 1 ORDER BY genre").all()).toEqual([{ genre: "Electronic" }, { genre: "Rock" }]);
    expect(db.prepare("SELECT format FROM release_formats WHERE release_id = 1 ORDER BY format").all()).toEqual([{ format: "CD" }, { format: "Vinyl" }]);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'release%'").all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual(expect.arrayContaining(["releases_title_idx", "release_styles_style_idx", "releases_track_count_idx"]));
    db.close();
  });

  it("stores a value once per release even when the dump repeats it", async () => {
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "new.sqlite") });

    const db = open("new.sqlite");
    expect(db.prepare("SELECT format FROM release_formats WHERE release_id = 4").all()).toEqual([{ format: "Vinyl" }]);
    expect(db.prepare("SELECT genre FROM release_genres WHERE release_id = 4").all()).toEqual([{ genre: "Electronic" }]);
    expect(db.prepare("SELECT style FROM release_styles WHERE release_id = 4").all()).toEqual([{ style: "Dub" }]);
    db.close();
  });

  it("lists the filter options of each category, most common first", async () => {
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "new.sqlite") });

    const db = open("new.sqlite");
    const options = (kind: string) =>
      (db.prepare("SELECT value FROM filter_options WHERE kind = ? ORDER BY position").all(kind) as { value: string }[]).map((r) => r.value);
    expect(options("genre")).toEqual(["Electronic", "Rock"]);
    expect(options("style")).toEqual(["Deep House", "Dub", "Techno"]);
    expect(options("format")).toEqual(["Vinyl", "CD"]);
    expect(options("country")).toEqual(["Germany", "Sweden", "UK"]);
    db.close();
  });

  it("reads a gzipped dump", async () => {
    fs.writeFileSync(path.join(dir, "releases.xml.gz"), zlib.gzipSync(DUMP));

    const stats = await importDump({ dumpPath: path.join(dir, "releases.xml.gz"), outPath: path.join(dir, "new.sqlite") });

    expect(stats.kept).toBe(3);
  });

  it("carries over only fades and user settings from the old database", async () => {
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath: path.join(dir, "old.sqlite") });
    const old = new Database(path.join(dir, "old.sqlite"));
    old.exec(`
      INSERT INTO fades (uid, kind, id, created_at, lookup_status, title) VALUES ('u1', 'master', 1660109, 100, 'done', 'Stockholm');
      INSERT INTO user_settings (uid, theme, updated_at) VALUES ('u1', 'light', 200);
      INSERT INTO releases (id, title, genres, styles, formats, artists) VALUES (99, 'Old only', '["Electronic"]', '[]', '[]', '[]');
    `);
    old.close();

    const stats = await importDump({
      dumpPath: path.join(dir, "releases.xml"),
      outPath: path.join(dir, "new.sqlite"),
      carryOverFrom: path.join(dir, "old.sqlite"),
    });

    expect(stats.fadesCarried).toBe(1);
    const db = open("new.sqlite");
    expect(db.prepare("SELECT uid, kind, id, lookup_status, title FROM fades").all()).toEqual([
      { uid: "u1", kind: "master", id: 1660109, lookup_status: "done", title: "Stockholm" },
    ]);
    expect(db.prepare("SELECT uid, theme FROM user_settings").all()).toEqual([{ uid: "u1", theme: "light" }]);
    expect(db.prepare("SELECT count(*) c FROM releases WHERE id = 99").get()).toEqual({ c: 0 });
    db.close();
  });

  it("refuses to overwrite an existing database unless forced", async () => {
    const outPath = path.join(dir, "new.sqlite");
    await importDump({ dumpPath: path.join(dir, "releases.xml"), outPath });

    await expect(importDump({ dumpPath: path.join(dir, "releases.xml"), outPath })).rejects.toThrow(/exists/);
    await expect(importDump({ dumpPath: path.join(dir, "releases.xml"), outPath, force: true })).resolves.toMatchObject({ kept: 3 });
  });

  it("samples a chunk trimmed to whole releases", async () => {
    const stats = await importDump({
      dumpPath: path.join(dir, "releases.xml"),
      outPath: path.join(dir, "new.sqlite"),
      sample: { chunks: 1, chunkBytes: Buffer.byteLength(DUMP) },
    });

    expect(stats).toMatchObject({ scanned: 4, kept: 3 });
  });

  it("refuses a sample whose chunks would overlap", async () => {
    await expect(
      importDump({
        dumpPath: path.join(dir, "releases.xml"),
        outPath: path.join(dir, "new.sqlite"),
        sample: { chunks: 2, chunkBytes: Buffer.byteLength(DUMP) },
      }),
    ).rejects.toThrow(/overlap/);
  });
});
