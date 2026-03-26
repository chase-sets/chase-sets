import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const roots = ["bounded-contexts", "deployables"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const violations = [];
const forbiddenPaths = [
  "bounded-contexts/catalog/authoring/shared",
  "bounded-contexts/catalog/authoring/ui",
  "bounded-contexts/catalog/authoring/shell/ui",
  "bounded-contexts/discovery/shared",
  "bounded-contexts/discovery/ui",
  "bounded-contexts/discovery/search",
  "bounded-contexts/discovery/item-detail",
  "bounded-contexts/catalog/authoring/api/projections/queries.ts",
  "bounded-contexts/catalog/authoring/api/projections/schema.sql",
  "bounded-contexts/catalog/authoring/runtime.ts",
  "bounded-contexts/catalog/authoring/ui/index.tsx",
  "bounded-contexts/discovery/ui/app.tsx",
  "bounded-contexts/discovery/ui/router.ts",
  "bounded-contexts/discovery/schema.sql",
  "deployables/catalog-admin/src/router.ts",
  "deployables/marketplace/src/router.ts",
];

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

function addPathViolation(relativePath, message) {
  violations.push(`${relativePath}: ${message}`);
}

function isTmpFile(file) {
  return /\.tmp($|\.)|\.(ts|tsx|json)\.tmp$/i.test(path.basename(file));
}

function isImplementedContextFile(relativeFile) {
  return (
    relativeFile.startsWith("bounded-contexts/catalog/authoring/") ||
    relativeFile.startsWith("bounded-contexts/discovery/")
  );
}

function checkImport(file, specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");

  if (relativeFile.startsWith("bounded-contexts/") && normalized.includes("deployables/")) {
    addViolation(file, `bounded contexts must not import deployables (${specifier})`);
  }

  if (
    relativeFile.startsWith("bounded-contexts/catalog/") &&
    !relativeFile.startsWith("bounded-contexts/catalog/authoring/") &&
    normalized.includes("bounded-contexts/catalog/authoring/")
  ) {
    addViolation(file, `catalog public modules must not import authoring internals (${specifier})`);
  }

  if (relativeFile.startsWith("deployables/")) {
    if (normalized.includes("bounded-contexts/") || normalized.includes("contracts/")) {
      addViolation(file, `deployables must use module aliases, not filesystem boundary imports (${specifier})`);
    }

    if (
      normalized.startsWith("@chase-sets/catalog-authoring/") ||
      normalized.startsWith("@chase-sets/discovery/")
    ) {
      addViolation(file, `deployables must use bounded-context entrypoints, not deep imports (${specifier})`);
    }

    return;
  }

  if (!isImplementedContextFile(relativeFile)) {
    return;
  }

  const isShellFile = relativeFile.includes("/shell/");
  const isContextRootEntrypoint = /bounded-contexts\/[^/]+(?:\/authoring)?\/index\.ts$/.test(relativeFile);
  if (!isShellFile && !isContextRootEntrypoint && (normalized.includes("/shell/") || normalized.endsWith("/shell"))) {
    addViolation(file, `non-shell context modules must not depend on shell internals (${specifier})`);
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

for (const forbiddenPath of forbiddenPaths) {
  if (existsSync(path.join(repoRoot, forbiddenPath))) {
    addPathViolation(forbiddenPath, "stale structure artifact should not exist");
  }
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

    if (file.includes(`${path.sep}bounded-contexts${path.sep}discovery${path.sep}`) && content.includes("marketplace_")) {
      addViolation(file, "discovery should use discovery-owned read-model names, not marketplace_* tables");
    }

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

