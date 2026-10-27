// Every var(--x) without a fallback in the pilot's stylesheets, scripts and Rust names a custom
// property the design system's tokens (platform/tokens.json, through corten::style::tokens!) or one
// of the pilot's own stylesheets defines. Corten does not check this yet:
// https://github.com/todd-skelton/corten/issues/179. Remove this script once it does.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skip = new Set(["target", "node_modules", ".corten"]);

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else if (/\.(css|rs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const tokens = JSON.parse(readFileSync(join(root, "platform", "tokens.json"), "utf8"));
const defined = new Set();
function scales(group) {
  for (const [scale, entries] of Object.entries(group ?? {})) {
    for (const key of Object.keys(entries)) defined.add(`--${scale}-${key}`);
  }
}
scales(tokens.scales);
for (const theme of Object.values(tokens.themes ?? {})) scales(theme);

const sources = files(root);
for (const file of sources) {
  for (const match of readFileSync(file, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
}

const missing = [];
for (const file of sources) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
      if (match[2] === ")" && !defined.has(match[1])) {
        missing.push(`${relative(root, file)}:${i + 1}: ${match[1]} is not a token or a declared property`);
      }
    }
  });
}

if (missing.length > 0) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log(`Every var() names a defined property (${defined.size} defined, ${sources.length} files).`);
