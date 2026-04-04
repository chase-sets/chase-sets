import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set(["node_modules", ".git", "dist", "build"]);
const allowedTopLevelDirectories = new Set([
  "bounded-contexts",
  "contracts",
  "deployables",
  "docs",
  "infrastructure",
  "node_modules",
  "packages",
  "scripts",
]);
const forbiddenBoundedContextDirectoryNames = new Set(["infrastructure", "shared", "support"]);
const legacyForbiddenPaths = [
  "bounded-contexts/catalog/authoring/package.json",
  "bounded-contexts/catalog/authoring/api",
  "bounded-contexts/discovery/support",
  "contracts/event-core/postgres",
];
const violations = [];

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

function matchesPackageSpecifier(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function resolveRelativeSpecifier(relativeFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }

  return path.posix.normalize(
    path.posix.join(path.posix.dirname(relativeFile), specifier),
  );
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

async function loadContextManifests() {
  const root = path.join(repoRoot, "bounded-contexts");
  const entries = await readdir(root, { withFileTypes: true });
  const manifests = new Map();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const contextRoot = path.join(root, entry.name);
    const packagePath = path.join(contextRoot, "package.json");
    const manifestPath = path.join(contextRoot, "context.json");

    if (!existsSync(packagePath)) {
      continue;
    }

    if (!existsSync(manifestPath)) {
      addPathViolation(`bounded-contexts/${entry.name}/context.json`, "implemented context must declare a context manifest");
      continue;
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    const relativeRoot = `bounded-contexts/${entry.name}`;

    if (manifest.packageName !== packageJson.name) {
      addPathViolation(relativeRoot, "context manifest packageName must match package.json name");
    }

    manifests.set(relativeRoot, {
      root: relativeRoot,
      packageName: manifest.packageName,
      manifest,
    });
  }

  return manifests;
}

function isAllowedDeployableBoundedContextImport(specifier) {
  return /^@chase-sets\/[^/]+\/(web|client|server|integration|routes\/.+)$/.test(specifier);
}

function isAllowedContextImporter(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.endsWith(".test.ts") ||
    relativeFile.endsWith(".test.tsx") ||
    relativeFile.endsWith("/seed.ts") ||
    relativeFile.endsWith("/seed.test.ts")
  );
}

function isAllowedContextRouteCollaboration(relativeFile, specifier) {
  return (
    relativeFile.includes("/routes/") &&
    /^@chase-sets\/[^/]+\/(web|client|server|integration|routes\/.+)$/.test(specifier)
  );
}

const contextManifests = await loadContextManifests();
const boundedContextPackages = [...contextManifests.values()].map(({ packageName }) => packageName);

function getContextRoot(relativeFile) {
  for (const root of contextManifests.keys()) {
    if (relativeFile === root || relativeFile.startsWith(`${root}/`)) {
      return root;
    }
  }

  return null;
}

function isBoundedContextSpecifier(specifier) {
  return boundedContextPackages.some((packageName) =>
    matchesPackageSpecifier(specifier, packageName),
  );
}

function isDeployableSpecifier(specifier) {
  return specifier.includes("deployables/");
}

function isInfrastructureSpecifier(specifier) {
  return specifier.includes("infrastructure/") ||
    specifier === "@chase-sets/bounded-context-runtime" ||
    specifier.startsWith("@chase-sets/bounded-context-runtime/") ||
    specifier === "@chase-sets/event-core-postgres" ||
    specifier.startsWith("@chase-sets/event-core-postgres/");
}

function isWorkspacePackageSpecifier(specifier) {
  return specifier.includes("packages/") ||
    specifier === "@chase-sets/design-system" ||
    specifier.startsWith("@chase-sets/design-system/");
}

function checkImport(file, specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  const relativeFile = normalizeRelative(file);
  const resolvedSpecifier = resolveRelativeSpecifier(relativeFile, normalized);
  const importerContextRoot = getContextRoot(relativeFile);

  if (
    importerContextRoot !== null &&
    (isDeployableSpecifier(normalized) || isDeployableSpecifier(resolvedSpecifier ?? ""))
  ) {
    addViolation(file, `bounded contexts must not import deployables (${specifier})`);
  }

  if (
    importerContextRoot !== null &&
    !isAllowedContextImporter(relativeFile) &&
    !isAllowedContextRouteCollaboration(relativeFile, normalized) &&
    boundedContextPackages.some(
      (packageName) =>
        matchesPackageSpecifier(normalized, packageName) &&
        !matchesPackageSpecifier(normalized, contextManifests.get(importerContextRoot)?.packageName ?? ""),
    )
  ) {
    addViolation(file, `bounded contexts must not import another bounded context (${specifier})`);
  }

  if (relativeFile.startsWith("contracts/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isInfrastructureSpecifier(normalized) ||
      isWorkspacePackageSpecifier(normalized)
    ) {
      addViolation(file, `contracts must stay pure (${specifier})`);
    }
  }

  if (relativeFile.startsWith("infrastructure/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isWorkspacePackageSpecifier(normalized)
    ) {
      addViolation(file, `infrastructure must stay technology-only (${specifier})`);
    }
  }

  if (relativeFile.startsWith("packages/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isInfrastructureSpecifier(normalized)
    ) {
      addViolation(file, `packages must stay domain-agnostic (${specifier})`);
    }
  }

  if (relativeFile.startsWith("deployables/")) {
    if (
      normalized.includes("bounded-contexts/") ||
      normalized.includes("contracts/") ||
      normalized.includes("infrastructure/") ||
      (resolvedSpecifier?.includes("bounded-contexts/") ?? false) ||
      (resolvedSpecifier?.includes("contracts/") ?? false) ||
      (resolvedSpecifier?.includes("infrastructure/") ?? false)
    ) {
      addViolation(file, `deployables must use package imports (${specifier})`);
    }

    if (
      isBoundedContextSpecifier(normalized) &&
      boundedContextPackages.some(
        (packageName) => matchesPackageSpecifier(normalized, packageName) && normalized !== packageName,
      ) &&
      !isAllowedDeployableBoundedContextImport(normalized)
    ) {
      addViolation(file, `deployables must consume public context entrypoints (${specifier})`);
    }
  }
}

const topLevelEntries = await readdir(repoRoot, { withFileTypes: true });
for (const entry of topLevelEntries) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) {
    continue;
  }

  if (!allowedTopLevelDirectories.has(entry.name)) {
    addPathViolation(entry.name, "top-level directory is not allowed");
  }
}

for (const forbiddenPath of legacyForbiddenPaths) {
  if (existsSync(path.join(repoRoot, forbiddenPath))) {
    addPathViolation(forbiddenPath, "legacy structure artifact should not exist");
  }
}

for (const root of roots) {
  const { files, directories } = await walk(path.join(repoRoot, root));

  for (const directory of directories) {
    const relativeDir = normalizeRelative(directory);

    if (relativeDir.startsWith("bounded-contexts/")) {
      const directoryName = path.basename(directory);
      if (forbiddenBoundedContextDirectoryNames.has(directoryName)) {
        addPathViolation(
          relativeDir,
          "bounded contexts must use purpose-specific folder names instead of generic infrastructure/shared/support directories",
        );
      }
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

    for (const specifier of extractImportSpecifiers(content)) {
      checkImport(file, specifier);
    }
  }
}

if (violations.length > 0) {
  console.error("Structure check failed:\n");
  for (const violation of violations.sort()) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Structure check passed.");
