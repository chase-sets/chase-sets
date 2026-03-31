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
const violations = [];
const forbiddenPaths = [
  "bounded-contexts/catalog/authoring/api",
  "bounded-contexts/catalog/authoring/support",
  "bounded-contexts/catalog/authoring/database-schema.ts",
  "bounded-contexts/discovery/support",
  "bounded-contexts/discovery/__tests__",
  "bounded-contexts/discovery/items/ui",
  "bounded-contexts/discovery/items/use-debounce.ts",
  "contracts/event-core/postgres",
  "deployables/catalog-api/src/infrastructure",
  "deployables/catalog-api/src/routes",
  "deployables/marketplace-api/src/infrastructure",
  "deployables/marketplace-api/src/projections",
  "deployables/marketplace-api/src/routes",
  "deployables/catalog-admin/src/__tests__",
  "deployables/marketplace/src/__tests__",
];
const implementedRootRules = new Map([
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
        "package.json",
        "runtime-support.ts",
        "schema.ts",
        "seed-support.ts",
        "seed.ts",
        "services.ts",
        "test-helpers.ts",
        "test-support.ts",
        "web.ts",
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
        "package.json",
        "README.md",
        "runtime-support.ts",
        "schema.ts",
        "services.ts",
        "web.ts",
      ]),
    },
  ],
  [
    "bounded-contexts/identity",
    {
      allowedDirs: new Set([
        "accounts",
        "api-keys",
        "auth-support",
        "consents",
        "customer",
        "invitations",
        "memberships",
        "projection-support",
        "read-model-support",
        "sessions",
        "shell",
        "shell-support",
        "tests",
        "users",
      ]),
      allowedFiles: new Set([
        "README.md",
        "GLOSSARY.md",
        "api.ts",
        "common.ts",
        "constants.ts",
        "index.ts",
        "package.json",
        "runtime-support.ts",
        "schema.ts",
        "server.test.ts",
        "server.ts",
        "seed.ts",
        "services.ts",
        "test-support.ts",
        "web.ts",
      ]),
    },
  ],
  [
    "bounded-contexts/inventory",
    {
      allowedDirs: new Set(["holds", "records", "storage-locations", "tests"]),
      allowedFiles: new Set([
        "README.md",
        "GLOSSARY.md",
        "api.ts",
        "common.ts",
        "index.ts",
        "package.json",
        "runtime-support.ts",
        "schema.ts",
        "seed-support.ts",
        "seed.ts",
        "services.ts",
        "web.ts",
      ]),
    },
  ],
  [
    "contracts/dev-seeds",
    {
      allowedDirs: new Set([]),
      allowedFiles: new Set(["index.ts", "package.json"]),
    },
  ],
  [
    "contracts/event-core",
    {
      allowedDirs: new Set([]),
      allowedFiles: new Set([
        "aggregate-repository.ts",
        "codec.ts",
        "command-handler.ts",
        "domain.ts",
        "event-store.ts",
        "index.ts",
        "package.json",
        "projector-runner.ts",
        "projector.ts",
        "README.md",
        "storage.ts",
        "transport.ts",
      ]),
    },
  ],
  [
    "contracts/http",
    {
      allowedDirs: new Set([]),
      allowedFiles: new Set(["health.ts", "package.json", "responses.ts"]),
    },
  ],
  [
    "contracts/primitives",
    {
      allowedDirs: new Set([]),
      allowedFiles: new Set([
        "brand.ts",
        "iso-utc-timestamp.ts",
        "json.ts",
        "package.json",
        "typed-ids.ts",
      ]),
    },
  ],
  [
    "infrastructure/event-core-postgres",
    {
      allowedDirs: new Set([]),
      allowedFiles: new Set([
        "event-store.ts",
        "index.ts",
        "package.json",
        "pool.ts",
        "projection-store.ts",
        "schema.sql",
        "schema.ts",
        "sql-identifier.ts",
        "types.ts",
      ]),
    },
  ],
]);
const boundedContextPackages = ["@chase-sets/catalog-authoring", "@chase-sets/discovery", "@chase-sets/identity", "@chase-sets/inventory"];
const contractPackages = [
  "@chase-sets/dev-seeds",
  "@chase-sets/event-core",
  "@chase-sets/http",
  "@chase-sets/primitives",
];
const infrastructurePackages = ["@chase-sets/event-core-postgres"];
const workspacePackages = ["@chase-sets/design-system"];
const forbiddenBoundedContextDirectoryNames = new Set([
  "infrastructure",
  "shared",
  "support",
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
    relativeDir.startsWith("contracts/") ||
    relativeDir.startsWith("infrastructure/") ||
    relativeDir.startsWith("packages/") ||
    /^deployables\/[^/]+\/src(?:\/|$)/.test(relativeDir)
  );
}

function matchesPackageSpecifier(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isAllowedDeployableBoundedContextImport(specifier) {
    return (
      specifier === "@chase-sets/catalog-authoring/web" ||
      specifier === "@chase-sets/discovery/web" ||
      specifier === "@chase-sets/identity/server" ||
      specifier === "@chase-sets/identity/web" ||
      specifier === "@chase-sets/inventory/web"
    );
  }

function isBoundedContextSpecifier(specifier) {
  return (
    specifier.includes("bounded-contexts/") ||
    boundedContextPackages.some((packageName) =>
      matchesPackageSpecifier(specifier, packageName),
    )
  );
}

function isDeployableSpecifier(specifier) {
  return specifier.includes("deployables/");
}

function isInfrastructureSpecifier(specifier) {
  return (
    specifier.includes("infrastructure/") ||
    infrastructurePackages.some((packageName) =>
      matchesPackageSpecifier(specifier, packageName),
    )
  );
}

function isWorkspacePackageSpecifier(specifier) {
  return (
    specifier.includes("packages/") ||
    workspacePackages.some((packageName) =>
      matchesPackageSpecifier(specifier, packageName),
    )
  );
}

function getBoundedContextSegment(relativeFile) {
  const parts = relativeFile.split("/");
  return parts[1] ?? null;
}

function getBoundedContextRoot(relativeFile) {
  const parts = relativeFile.split("/");
  if (parts[0] !== "bounded-contexts" || parts.length < 2) {
    return null;
  }

  if (parts[1] === "catalog" && parts[2] === "authoring") {
    return "bounded-contexts/catalog/authoring";
  }

  if (parts[1] === "discovery") {
    return "bounded-contexts/discovery";
  }

  if (parts[1] === "identity") {
    return "bounded-contexts/identity";
  }

  return `bounded-contexts/${parts[1]}`;
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
  const importerContextRoot = getBoundedContextRoot(relativeFile);

  if (relativeFile.startsWith("bounded-contexts/") && isDeployableSpecifier(normalized)) {
    addViolation(file, `bounded contexts must not import deployables (${specifier})`);
  }

  if (
    importerContextRoot !== null &&
    boundedContextPackages.some(
      (packageName) =>
        matchesPackageSpecifier(normalized, packageName) && normalized !== packageName,
    )
  ) {
    addViolation(
      file,
      `bounded contexts must not import another bounded context's internals (${specifier})`,
    );
  }

  if (
    importerContextRoot !== null &&
    normalized.includes("bounded-contexts/")
  ) {
    const referencedContextRoot = getBoundedContextRoot(normalized);
    if (
      referencedContextRoot !== null &&
      referencedContextRoot !== importerContextRoot
    ) {
      addViolation(
        file,
        `bounded contexts must not import another bounded context's internals (${specifier})`,
      );
    }
  }

  if (
    relativeFile.startsWith("bounded-contexts/catalog/") &&
    !relativeFile.startsWith("bounded-contexts/catalog/authoring/") &&
    normalized.includes("bounded-contexts/catalog/authoring/")
  ) {
    addViolation(file, `catalog public modules must not import authoring internals (${specifier})`);
  }

  if (relativeFile.startsWith("contracts/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isInfrastructureSpecifier(normalized) ||
      isWorkspacePackageSpecifier(normalized)
    ) {
      addViolation(
        file,
        `contracts must stay pure and must not depend on app, context, infrastructure, or package code (${specifier})`,
      );
    }
  }

  if (relativeFile.startsWith("infrastructure/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isWorkspacePackageSpecifier(normalized)
    ) {
      addViolation(
        file,
        `infrastructure must not depend on bounded contexts, deployables, or reusable packages (${specifier})`,
      );
    }
  }

  if (relativeFile.startsWith("packages/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isInfrastructureSpecifier(normalized)
    ) {
      addViolation(
        file,
        `packages must not depend on bounded contexts, deployables, or infrastructure (${specifier})`,
      );
    }
  }

  if (relativeFile.startsWith("deployables/")) {
    if (
      normalized.includes("bounded-contexts/") ||
      normalized.includes("contracts/") ||
      normalized.includes("infrastructure/")
    ) {
      addViolation(
        file,
        `deployables must use package imports, not filesystem boundary imports (${specifier})`,
      );
    }

    if (
      boundedContextPackages.some(
        (packageName) =>
          matchesPackageSpecifier(normalized, packageName) &&
          normalized !== packageName &&
          !isAllowedDeployableBoundedContextImport(normalized),
      )
    ) {
      addViolation(file, `deployables must use bounded-context entrypoints, not deep imports (${specifier})`);
    }

    if (
      infrastructurePackages.some(
        (packageName) =>
          matchesPackageSpecifier(normalized, packageName) && normalized !== packageName,
      )
    ) {
      addViolation(
        file,
        `deployables must use infrastructure package entrypoints, not deep imports (${specifier})`,
      );
    }

    return;
  }

  if (!isImplementedContextFile(relativeFile)) {
    return;
  }

  const isShellFile = relativeFile.includes("/shell/");
  const isContextRootEntrypoint = /bounded-contexts\/[^/]+(?:\/authoring)?\/(index|web)\.ts$/.test(relativeFile);
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

const forbiddenSourcePatterns = [
  {
    regex: /location\.hash/,
    message: "hash-based routing is not allowed",
  },
  {
    regex: /#\//,
    message: "hash-style routes are not allowed",
  },
  {
    regex: /hashchange/i,
    message: "hashchange listeners are not allowed",
  },
  {
    regex: /fetch\(\s*["']\/api/,
    message: "use typed API clients instead of raw /api fetch calls",
  },
];

const topLevelEntries = await readdir(repoRoot, { withFileTypes: true });
for (const entry of topLevelEntries) {
  if (!entry.isDirectory()) {
    continue;
  }

  if (entry.name.startsWith(".")) {
    continue;
  }

  if (!allowedTopLevelDirectories.has(entry.name)) {
    addPathViolation(entry.name, "top-level directory is not allowed; add an explicit rule first");
  }
}

for (const forbiddenPath of forbiddenPaths) {
  if (existsSync(path.join(repoRoot, forbiddenPath))) {
    addPathViolation(forbiddenPath, "stale structure artifact should not exist");
  }
}

for (const [rootPath, rule] of implementedRootRules) {
  const entries = await readdir(path.join(repoRoot, rootPath), { withFileTypes: true });

  for (const entry of entries) {
    const allowed = entry.isDirectory()
      ? rule.allowedDirs.has(entry.name)
      : rule.allowedFiles.has(entry.name);

    if (!allowed) {
      addPathViolation(
        `${rootPath}/${entry.name}`,
        "implemented root contains an unexpected entry",
      );
    }
  }

  for (const forbiddenName of ["support", "shared"]) {
    if (existsSync(path.join(repoRoot, rootPath, forbiddenName))) {
      addPathViolation(`${rootPath}/${forbiddenName}`, "generic support folders are not allowed");
    }
  }
}

for (const root of roots) {
  const rootPath = path.join(repoRoot, root);
  const { files, directories } = await walk(rootPath);

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

    if (relativeFile.startsWith("deployables/") || relativeFile.startsWith("bounded-contexts/")) {
      for (const pattern of forbiddenSourcePatterns) {
        if (pattern.regex.test(content)) {
          addViolation(file, pattern.message);
        }
      }
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
