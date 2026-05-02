import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const fulfillmentRoot = path.join(root, "bounded-contexts", "fulfillment");
const checkedExtensions = new Set([".json", ".ts", ".tsx"]);
const forbiddenPatterns = [
  "@chase-sets/easypost-postage",
  "@chase-sets/postage-labels-testing",
  "api.easypost.com",
];
const skippedDirectories = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...await collectFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

const violations = [];

for (const filePath of await collectFiles(fulfillmentRoot)) {
  const contents = await readFile(filePath, "utf8");
  for (const pattern of forbiddenPatterns) {
    if (contents.includes(pattern)) {
      violations.push({ filePath, pattern });
    }
  }
}

if (violations.length > 0) {
  console.error("Postage provider implementations must stay outside fulfillment.");
  for (const violation of violations) {
    console.error(
      `- ${path.relative(root, violation.filePath)} contains ${JSON.stringify(
        violation.pattern,
      )}`,
    );
  }
  process.exit(1);
}

console.log("Postage adapter boundaries are clean.");
