const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src", "docs", "openapi.placeholder.yaml");
const destDir = path.join(__dirname, "..", "dist", "docs");
const dest = path.join(destDir, "openapi.placeholder.yaml");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
