import { importDump } from "../src/import/import-dump";

const usage = `Usage: npm run db:import -- <releases.xml|releases.xml.gz> <new-db.sqlite> [options]
  --carry-over <old.sqlite>   copy fades and user settings from an existing database
  --sample <chunks>[x<MB>]    sample evenly spaced chunks (6 MB each by default) instead of the whole file
  --genre <name>              keep releases with this genre (default Electronic)
  --force                     replace the new database file if it exists`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [dumpPath, outPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!dumpPath || !outPath) {
  console.error(usage);
  process.exit(1);
}

const sampleArg = flag("--sample");
const [chunks, megabytes] = (sampleArg ?? "").split("x").map(Number);
const genre = flag("--genre");
const carryOverFrom = flag("--carry-over");

importDump({
  dumpPath,
  outPath,
  force: args.includes("--force"),
  ...(genre ? { genre } : {}),
  ...(carryOverFrom ? { carryOverFrom } : {}),
  ...(sampleArg ? { sample: { chunks: chunks!, chunkBytes: Math.round((megabytes || 6) * 1024 * 1024) } } : {}),
  log: (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`),
}).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
