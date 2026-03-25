import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const roots = ["bounded-contexts", "deployables"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const violations = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
      continue;
    }
    files.push(fullPath);
  }

  return files;
}

function addViolation(file, message) {
  violations.push(`${path.relative(repoRoot, file)}: ${message}`);
}

function isTmpFile(file) {
  return /\.tmp($|\.)|\.(ts|tsx|json)\.tmp$/i.test(path.basename(file));
}

function checkImport(file, specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");

  if (relativeFile.startsWith("bounded-contexts/") && normalized.includes("deployables/")) {
    addViolation(file, `bounded contexts must not import deployables (${specifier})`);
  }

  if (!relativeFile.startsWith("deployables/")) {
    return;
  }

  const allowed = new Set([
    "../../../bounded-contexts/catalog/authoring",
    "../../../bounded-contexts/discovery",
    "../../../../bounded-contexts/catalog/authoring",
    "../../../../bounded-contexts/discovery",
  ]);

  if (normalized.includes("bounded-contexts/catalog/authoring/") || normalized.includes("bounded-contexts/discovery/")) {
    if (!allowed.has(normalized)) {
      addViolation(file, `deployables must use bounded-context entrypoints, not deep imports (${specifier})`);
    }
  }

  if (normalized.includes("bounded-contexts/catalog/") && !normalized.includes("bounded-contexts/catalog/authoring")) {
    addViolation(file, `deployables must not import catalog internals directly (${specifier})`);
  }
}

function extractImportSpecifiers(content) {
  const specifiers = [];
  const patterns = [
    /from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+[^\n]*from\s+["']([^"']+)["']/g,
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

for (const root of roots) {
  const rootPath = path.join(repoRoot, root);
  const files = await walk(rootPath);

  for (const file of files) {
    if (isTmpFile(file)) {
      addViolation(file, "tracked tmp artifact should not exist");
    }

    if (!sourceExtensions.has(path.extname(file))) {
      continue;
    }

    const content = await readFile(file, "utf8");
    for (const specifier of extractImportSpecifiers(content)) {
      checkImport(file, specifier);
    }
  }
}

if (violations.length > 0) {
  console.error("Structure check failed:\n");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Structure check passed.");