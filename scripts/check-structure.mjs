import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const roots = ["bounded-contexts", "deployables"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set(["node_modules", ".git", "dist"]);
const violations = [];
const forbiddenPaths = [
  "bounded-contexts/catalog/authoring/api",
  "bounded-contexts/catalog/authoring/support",
  "bounded-contexts/catalog/authoring/database-schema.ts",
  "bounded-contexts/discovery/support",
  "bounded-contexts/discovery/__tests__",
  "bounded-contexts/discovery/items/ui",
  "bounded-contexts/discovery/items/use-debounce.ts",
  "deployables/catalog-api/src/infrastructure",
  "deployables/catalog-api/src/routes",
  "deployables/marketplace-api/src/infrastructure",
  "deployables/marketplace-api/src/projections",
  "deployables/marketplace-api/src/routes",
  "deployables/catalog-admin/src/__tests__",
  "deployables/marketplace/src/__tests__",
];
const implementedContextRoots = new Map([
  [
    "bounded-contexts/catalog/authoring",
    {
      allowedDirs: new Set([
        "blueprints",
        "catalog-items",
        "categories",
        "components",
        "dimensions",
        "fields",
        "projection-support",
        "shell",
        "shell-support",
        "tests",
      ]),
      allowedFiles: new Set([
        "api.ts",
        "index.ts",
        "runtime-support.ts",
        "schema.ts",
        "seed-support.ts",
        "seed.ts",
        "services.ts",
        "test-helpers.ts",
        "test-support.ts",
      ]),
    },
  ],
  [
    "bounded-contexts/discovery",
    {
      allowedDirs: new Set(["categories", "items", "shell", "tests"]),
      allowedFiles: new Set([
        "api.ts",
        "GLOSSARY.md",
        "index.ts",
        "README.md",
        "runtime-support.ts",
        "schema.ts",
        "services.ts",
      ]),
    },
  ],
]);
const sliceRouteFiles = new Set([
  "bounded-contexts/catalog/authoring/blueprints/route.ts",
  "bounded-contexts/catalog/authoring/catalog-items/route.ts",
  "bounded-contexts/catalog/authoring/categories/route.ts",
  "bounded-contexts/catalog/authoring/components/route.ts",
  "bounded-contexts/catalog/authoring/dimensions/route.ts",
  "bounded-contexts/catalog/authoring/fields/route.ts",
  "bounded-contexts/discovery/categories/route.ts",
  "bounded-contexts/discovery/items/detail/route.ts",
  "bounded-contexts/discovery/items/search/route.ts",
]);

function normalizeRelative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function addViolation(file, message) {
  violations.push(`${normalizeRelative(file)}: ${message}`);
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

function isArchitectureDirectory(relativeDir) {
  return (
    relativeDir.startsWith("bounded-contexts/") ||
    /^deployables\/[^/]+\/src(?:\/|$)/.test(relativeDir)
  );
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  const directories = [dir];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walk(fullPath);
      files.push(...nested.files);
      directories.push(...nested.directories);
      continue;
    }
    files.push(fullPath);
  }

  return { files, directories };
}

function checkImport(file, specifier, content) {
  const normalized = specifier.replaceAll("\\", "/");
  const relativeFile = normalizeRelative(file);

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

  if (sliceRouteFiles.has(relativeFile) && (normalized === "../services" || normalized.endsWith("/services"))) {
    addViolation(file, `slice routes must depend on slice-local services (${specifier})`);
  }

  if (sliceRouteFiles.has(relativeFile) && content.includes("services.db")) {
    addViolation(file, "slice routes must not reach through context db handles");
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

for (const [contextRoot, rule] of implementedContextRoots) {
  const rootPath = path.join(repoRoot, contextRoot);
  const entries = await readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const allowed = entry.isDirectory()
      ? rule.allowedDirs.has(entry.name)
      : rule.allowedFiles.has(entry.name);

    if (!allowed) {
      addPathViolation(
        `${contextRoot}/${entry.name}`,
        "implemented context root contains an unexpected entry",
      );
    }
  }

  for (const forbiddenName of ["support", "shared"]) {
    if (existsSync(path.join(rootPath, forbiddenName))) {
      addPathViolation(`${contextRoot}/${forbiddenName}`, "generic root support folders are not allowed");
    }
  }
}

for (const root of roots) {
  const rootPath = path.join(repoRoot, root);
  const { files, directories } = await walk(rootPath);

  for (const directory of directories) {
    const relativeDir = normalizeRelative(directory);
    if (!isArchitectureDirectory(relativeDir)) {
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    const visibleEntries = entries.filter((entry) => !ignoredDirectories.has(entry.name));
    if (visibleEntries.length === 0) {
      addPathViolation(relativeDir, "empty architecture folder should not exist");
    }
  }

  for (const file of files) {
    if (isTmpFile(file)) {
      addViolation(file, "tracked tmp artifact should not exist");
    }

    if (!sourceExtensions.has(path.extname(file))) {
      continue;
    }

    const content = await readFile(file, "utf8");
    const relativeFile = normalizeRelative(file);

    if (relativeFile.startsWith("bounded-contexts/discovery/") && content.includes("marketplace_")) {
      addViolation(file, "discovery should use discovery-owned read-model names, not marketplace_* tables");
    }

    for (const specifier of extractImportSpecifiers(content)) {
      checkImport(file, specifier, content);
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