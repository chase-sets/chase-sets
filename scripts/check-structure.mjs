import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildApiMountFileContent,
  deployableApiMountConfig,
  resolveDeployableApiMountPath,
} from "./deployable-api-mount-support.mjs";
import {
  buildRoutesFileContent,
  buildWrapperContent,
  deployableRouteConfig,
  generatedComment,
  resolveDeployableRoutePaths,
} from "./deployable-route-support.mjs";

const repoRoot = process.cwd();
const roots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const moduleFileExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
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
const manifestRequiredFields = [
  "contextName",
  "packageName",
  "ownedNouns",
  "streamPrefix",
  "apiBasePath",
  "slices",
  "allowedSupportDirectories",
  "publicExports",
  "allowedContextDependencies",
  "requiredPorts",
  "apiDeployables",
  "apiMounts",
  "deployableContributions",
];
const knownDeployables = new Set(Object.keys(deployableRouteConfig));
const knownApiDeployables = new Set(Object.keys(deployableApiMountConfig));
const deployableRouteTests = /\.test\.(ts|tsx)$/;
const contractsForbiddenImports = /^(react($|\/)|react-dom($|\/)|react-router($|\/)|@react-router\/|hono($|\/))/;
const forbiddenRootSurfaceReexports =
  /export\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']\.\/(?:client|server|web|integration|seed-support(?:\/[^"']+)?)["']/;
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

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBoolean(value) {
  return value === true || value === false;
}

function isAllowedPublicExportName(value) {
  return (
    value === "." ||
    value === "./client" ||
    value === "./integration" ||
    value === "./seed-support/*" ||
    value === "./server" ||
    value === "./web" ||
    value === "./routes/*" ||
    value === "./ui/*"
  );
}

function resolveExistingModulePath(rootDir, relativeSpecifier) {
  const normalized = relativeSpecifier.replace(/^\.\//, "");
  const absoluteBase = path.join(rootDir, normalized);

  if (existsSync(absoluteBase)) {
    return absoluteBase;
  }

  for (const extension of moduleFileExtensions) {
    const candidate = `${absoluteBase}${extension}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const extension of moduleFileExtensions) {
    const candidate = path.join(absoluteBase, `index${extension}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

    const contextRootAbs = path.join(root, entry.name);
    const packagePath = path.join(contextRootAbs, "package.json");
    const manifestPath = path.join(contextRootAbs, "context.json");

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

    for (const field of manifestRequiredFields) {
      if (!(field in manifest)) {
        addPathViolation(`${relativeRoot}/context.json`, `manifest must declare ${field}`);
      }
    }

    if (manifest.packageName !== packageJson.name) {
      addPathViolation(relativeRoot, "context manifest packageName must match package.json name");
    }

    if (typeof manifest.contextName !== "string" || manifest.contextName.length === 0) {
      addPathViolation(`${relativeRoot}/context.json`, "contextName must be a non-empty string");
    }

    if (!isStringArray(manifest.ownedNouns)) {
      addPathViolation(`${relativeRoot}/context.json`, "ownedNouns must be an array of strings");
    }

    if (typeof manifest.streamPrefix !== "string" || !manifest.streamPrefix.endsWith(".")) {
      addPathViolation(`${relativeRoot}/context.json`, "streamPrefix must be a dotted string ending in '.'");
    }

    if (typeof manifest.apiBasePath !== "string" || !manifest.apiBasePath.startsWith("/")) {
      addPathViolation(`${relativeRoot}/context.json`, "apiBasePath must be an absolute path");
    }

    if (!isStringArray(manifest.slices)) {
      addPathViolation(`${relativeRoot}/context.json`, "slices must be an array of strings");
    }

    if (!isStringArray(manifest.allowedSupportDirectories)) {
      addPathViolation(`${relativeRoot}/context.json`, "allowedSupportDirectories must be an array of strings");
    }

    if (!isStringArray(manifest.publicExports)) {
      addPathViolation(`${relativeRoot}/context.json`, "publicExports must be an array of strings");
    }

    if (!isStringArray(manifest.allowedContextDependencies)) {
      addPathViolation(`${relativeRoot}/context.json`, "allowedContextDependencies must be an array of package names");
    }

    if (!isStringArray(manifest.requiredPorts)) {
      addPathViolation(`${relativeRoot}/context.json`, "requiredPorts must be an array of strings");
    }

    if (!isStringArray(manifest.apiDeployables)) {
      addPathViolation(`${relativeRoot}/context.json`, "apiDeployables must be an array of deployable names");
    }

    if (!Array.isArray(manifest.apiMounts)) {
      addPathViolation(`${relativeRoot}/context.json`, "apiMounts must be an array");
    }

    if (Array.isArray(manifest.apiDeployables) && manifest.apiDeployables.length > 0 &&
      (!Array.isArray(manifest.apiMounts) || manifest.apiMounts.length === 0)
    ) {
      addPathViolation(`${relativeRoot}/context.json`, "apiMounts must declare at least one API contribution when apiDeployables are configured");
    }

    if (!Array.isArray(manifest.deployableContributions)) {
      addPathViolation(`${relativeRoot}/context.json`, "deployableContributions must be an array");
    }

    manifests.set(relativeRoot, {
      root: relativeRoot,
      rootAbs: contextRootAbs,
      manifest,
      packageJson,
      packageName: manifest.packageName,
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
    relativeFile.includes("/__tests__/") ||
    relativeFile.includes("/seed-support/") ||
    relativeFile.endsWith(".test.ts") ||
    relativeFile.endsWith(".test.tsx") ||
    relativeFile.endsWith(".test.js") ||
    relativeFile.endsWith(".test.jsx") ||
    relativeFile.endsWith("/seed.ts") ||
    relativeFile.endsWith("/seed.test.ts")
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

async function validateContextManifest(context) {
  const { manifest, packageJson, rootAbs, root } = context;
  if (typeof packageJson.exports !== "object" || packageJson.exports === null) {
    addPathViolation(`${root}/package.json`, "implemented bounded contexts must declare package exports");
  }

  if (!existsSync(path.join(rootAbs, "README.md"))) {
    addPathViolation(`${root}/README.md`, "implemented bounded contexts must define a README");
  }

  if (!existsSync(path.join(rootAbs, "GLOSSARY.md"))) {
    addPathViolation(`${root}/GLOSSARY.md`, "implemented bounded contexts must define a glossary");
  }

  const declaredPublicExports = new Set(manifest.publicExports ?? []);
  const packageExportKeys = new Set(
    Object.keys(packageJson.exports ?? {}).filter((key) => key !== "."),
  );

  for (const exportKey of packageExportKeys) {
    if (!declaredPublicExports.has(exportKey)) {
      addPathViolation(`${root}/package.json`, `package export ${exportKey} must be declared in context.json publicExports`);
    }
  }

  for (const publicExport of manifest.publicExports ?? []) {
    if (!isAllowedPublicExportName(publicExport)) {
      addPathViolation(`${root}/context.json`, `publicExports contains an unsupported surface (${publicExport})`);
    }

    const exportTarget =
      publicExport === "."
        ? packageJson.exports?.["."] ?? packageJson.exports
        : packageJson.exports?.[publicExport];

    if (!exportTarget) {
      addPathViolation(`${root}/package.json`, `package exports must include ${publicExport}`);
      continue;
    }

    if (typeof exportTarget !== "string") {
      addPathViolation(`${root}/package.json`, `package export ${publicExport} must resolve to a source file`);
      continue;
    }

    if (!exportTarget.includes("*")) {
      const resolvedTarget = resolveExistingModulePath(rootAbs, exportTarget);
      if (!resolvedTarget) {
        addPathViolation(`${root}/package.json`, `package export ${publicExport} targets a missing file (${exportTarget})`);
      }
    }
  }

  if ((manifest.deployableContributions?.length ?? 0) > 0 && !(manifest.publicExports ?? []).includes("./routes/*")) {
    addPathViolation(`${root}/context.json`, "contexts with route contributions must export ./routes/* publicly");
  }

  for (const dependency of manifest.allowedContextDependencies ?? []) {
    if (typeof dependency !== "string" || !dependency.startsWith("@chase-sets/")) {
      addPathViolation(`${root}/context.json`, `allowedContextDependencies must contain workspace package names (${dependency})`);
    }
  }

  for (const deployable of manifest.apiDeployables ?? []) {
    if (!knownApiDeployables.has(deployable)) {
      addPathViolation(`${root}/context.json`, `apiDeployables must be one of ${[...knownApiDeployables].join(", ")}`);
    }
  }

  const apiMounts = manifest.apiMounts ?? [];
  const primaryMounts = apiMounts.filter((mount) => mount.kind === "primary");
  if ((manifest.apiDeployables?.length ?? 0) === 0) {
    if (apiMounts.length !== 0) {
      addPathViolation(`${root}/context.json`, "contexts without apiDeployables must not declare apiMounts");
    }
  } else if (primaryMounts.length !== 1) {
    addPathViolation(`${root}/context.json`, "apiMounts must declare exactly one primary mount");
  }

  for (const [index, mount] of apiMounts.entries()) {
    const mountLabel = `${root}/context.json apiMounts[${index}]`;

    if (typeof mount.mountPath !== "string" || !mount.mountPath.startsWith("/")) {
      addPathViolation(mountLabel, "mountPath must be an absolute path");
    }

    if (mount.kind !== "primary" && mount.kind !== "additional") {
      addPathViolation(mountLabel, "kind must be 'primary' or 'additional'");
    }

    if (!isBoolean(mount.requiresAuth)) {
      addPathViolation(mountLabel, "requiresAuth must be a boolean");
    }

    if (!isBoolean(mount.drainProjectorsOnWrite)) {
      addPathViolation(mountLabel, "drainProjectorsOnWrite must be a boolean");
    }
  }

  const expectedTopLevelDirectories = new Set([
    ...manifest.slices,
    ...manifest.allowedSupportDirectories,
    "routes",
  ]);

  const rootEntries = await readdir(rootAbs, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
      continue;
    }

    if (!expectedTopLevelDirectories.has(entry.name)) {
      addPathViolation(
        `${root}/${entry.name}`,
        "top-level bounded-context directory must be a declared slice, routes, or an explicitly allowed support directory",
      );
    }
  }
}

async function validateDeployableApiMountOwnership(contexts) {
  const contextsByDeployable = new Map(
    Object.keys(deployableApiMountConfig).map((deployable) => [deployable, []]),
  );

  for (const context of contexts.values()) {
    for (const deployable of context.manifest.apiDeployables ?? []) {
      contextsByDeployable.get(deployable)?.push({
        contextName: context.manifest.contextName,
        packageName: context.packageName,
      });
    }
  }

  for (const [deployable, unsortedContexts] of contextsByDeployable.entries()) {
    const expectedContexts = [...unsortedContexts].sort((left, right) =>
      left.contextName.localeCompare(right.contextName),
    );
    const inventoryPath = resolveDeployableApiMountPath(repoRoot, deployable);

    if (!existsSync(inventoryPath)) {
      addViolation(inventoryPath, "generated API mount inventory is missing");
      continue;
    }

    const actualInventory = await readFile(inventoryPath, "utf8");
    const expectedInventory = buildApiMountFileContent(expectedContexts);
    if (actualInventory !== expectedInventory) {
      addViolation(inventoryPath, "generated API mount inventory is out of date");
    }
  }
}

async function validateDeployableRouteOwnership(contexts) {
  const routesByDeployable = new Map(
    Object.keys(deployableRouteConfig).map((deployable) => [deployable, []]),
  );

  for (const context of contexts.values()) {
    const { manifest, packageName, rootAbs, root } = context;

    for (const [contributionIndex, contribution] of (manifest.deployableContributions ?? []).entries()) {
      const contributionLabel =
        `${root}/context.json deployableContributions[${contributionIndex}]`;

      if (!knownDeployables.has(contribution.deployable)) {
        addPathViolation(contributionLabel, `deployable must be one of ${[...knownDeployables].join(", ")}`);
        continue;
      }

      if (!Array.isArray(contribution.routes)) {
        addPathViolation(contributionLabel, "routes must be an array");
        continue;
      }

      for (const [routeIndex, route] of contribution.routes.entries()) {
        const routeLabel = `${contributionLabel}.routes[${routeIndex}]`;

        if (typeof route.routeId !== "string" || route.routeId.length === 0) {
          addPathViolation(routeLabel, "routeId must be a non-empty string");
        }

        if (typeof route.routePath !== "string") {
          addPathViolation(routeLabel, "routePath must be a string");
        }

        if (route.routeType !== "route" && route.routeType !== "index") {
          addPathViolation(routeLabel, "routeType must be 'route' or 'index'");
        }

        if (
          route.placement !== undefined &&
          route.placement !== "root" &&
          route.placement !== "layout"
        ) {
          addPathViolation(routeLabel, "placement must be 'root' or 'layout' when provided");
        }

        if (typeof route.fileExport !== "string" || !route.fileExport.startsWith("./routes/")) {
          addPathViolation(routeLabel, "fileExport must target a context-owned route module under ./routes/");
          continue;
        }

        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(route.fileExport)) {
          addPathViolation(routeLabel, "fileExport should omit file extensions");
        }

        const resolvedRouteFile = resolveExistingModulePath(rootAbs, route.fileExport);
        if (!resolvedRouteFile) {
          addPathViolation(routeLabel, `fileExport targets a missing route module (${route.fileExport})`);
        }

        routesByDeployable.get(contribution.deployable)?.push({
          ...route,
          packageName,
          sourceContext: manifest.contextName,
        });
      }
    }
  }

  for (const [deployable, unsortedRoutes] of routesByDeployable.entries()) {
    const routes = [...unsortedRoutes].sort((left, right) =>
      left.routePath.localeCompare(right.routePath),
    );
    const config = resolveDeployableRoutePaths(repoRoot, deployable);
    const routeIds = new Set();
    const routePaths = new Set();

    for (const route of routes) {
      if (routeIds.has(route.routeId)) {
        addPathViolation(`deployables/${deployable}/app/routes/${route.routeId}.tsx`, "routeId must be unique per deployable");
      }
      routeIds.add(route.routeId);

      const routePathKey = `${route.routeType}:${route.routePath}`;
      if (routePaths.has(routePathKey)) {
        addPathViolation(`deployables/${deployable}/app/context-routes.generated.ts`, `routePath must be unique per deployable (${route.routePath})`);
      }
      routePaths.add(routePathKey);
    }

    if (!existsSync(config.routesFile)) {
      addViolation(config.routesFile, "generated context route inventory is missing");
    } else {
      const actualRoutesFile = await readFile(config.routesFile, "utf8");
      const expectedRoutesFile = buildRoutesFileContent(routes);
      if (actualRoutesFile !== expectedRoutesFile) {
        addViolation(config.routesFile, "generated context route inventory is out of date");
      }
    }

    const expectedWrapperFiles = new Map(
      routes.map((route) => [`${route.routeId}.tsx`, buildWrapperContent(route.packageName, route)]),
    );

    if (!existsSync(config.routesDir)) {
      addViolation(config.routesDir, "deployable routes directory is missing");
      continue;
    }

    for (const [wrapperName] of expectedWrapperFiles) {
      const wrapperPath = path.join(config.routesDir, wrapperName);
      if (!existsSync(wrapperPath)) {
        addViolation(wrapperPath, "generated route adapter is missing");
      }
    }

    const routeEntries = await readdir(config.routesDir, { withFileTypes: true });
    for (const entry of routeEntries) {
      if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
        continue;
      }

      const routePath = path.join(config.routesDir, entry.name);
      const routeContent = await readFile(routePath, "utf8");

      if (deployableRouteTests.test(entry.name) || entry.name === "ssr.test.tsx") {
        continue;
      }

      if (config.hostRoutes.has(entry.name)) {
        if (routeContent.startsWith(generatedComment)) {
          addViolation(routePath, "host-owned route files must not be generated wrappers");
        }
        continue;
      }

      const expectedWrapper = expectedWrapperFiles.get(entry.name);
      if (expectedWrapper) {
        if (routeContent !== expectedWrapper) {
          addViolation(routePath, "generated route adapter is out of date");
        }
        continue;
      }

      if (routeContent.startsWith(generatedComment)) {
        addViolation(routePath, "unexpected generated route adapter exists without a manifest contribution");
        continue;
      }

      addViolation(routePath, "deployables must not implement feature routes locally");
    }
  }
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
    boundedContextPackages.some(
      (packageName) =>
        matchesPackageSpecifier(normalized, packageName) &&
        !matchesPackageSpecifier(normalized, contextManifests.get(importerContextRoot)?.packageName ?? ""),
    )
  ) {
    const importerContext = contextManifests.get(importerContextRoot);
    const dependency = [...contextManifests.values()].find(({ packageName }) =>
      matchesPackageSpecifier(normalized, packageName),
    );

    if (!dependency) {
      addViolation(file, `bounded contexts must not import another bounded context (${specifier})`);
    } else {
      const isAllowedIntegrationImport =
        normalized === `${dependency.packageName}/integration` &&
        (importerContext?.manifest.allowedContextDependencies ?? []).includes(dependency.packageName);

      if (!isAllowedIntegrationImport) {
        addViolation(file, `bounded contexts must use explicit integration exports only (${specifier})`);
      }
    }
  }

  if (relativeFile.startsWith("contracts/")) {
    if (
      isBoundedContextSpecifier(normalized) ||
      isDeployableSpecifier(normalized) ||
      isInfrastructureSpecifier(normalized) ||
      isWorkspacePackageSpecifier(normalized) ||
      contractsForbiddenImports.test(normalized)
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

  const importsScripts =
    normalized.startsWith("scripts/") ||
    normalized.includes("/scripts/") ||
    (resolvedSpecifier?.includes("/scripts/") ?? false);
  const isRuntimeSource =
    !relativeFile.startsWith("scripts/") &&
    !relativeFile.includes("/tests/") &&
    !relativeFile.includes("/__tests__/") &&
    !relativeFile.endsWith(".test.ts") &&
    !relativeFile.endsWith(".test.tsx") &&
    !relativeFile.endsWith(".test.js") &&
    !relativeFile.endsWith(".test.jsx") &&
    !relativeFile.endsWith("/seed.ts") &&
    !relativeFile.endsWith("/seed.test.ts") &&
    !relativeFile.includes("/seed-support/") &&
    !relativeFile.includes("/scripts/") &&
    !/\/(?:vite|vitest)\.config\.ts$/.test(relativeFile);

  if (isRuntimeSource && importsScripts) {
    addViolation(file, `runtime code must not import scripts (${specifier})`);
  }
}

for (const context of contextManifests.values()) {
  await validateContextManifest(context);
}

await validateDeployableRouteOwnership(contextManifests);
await validateDeployableApiMountOwnership(contextManifests);

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

    const normalizedFile = normalizeRelative(file);
    if (
      normalizedFile.startsWith("deployables/") &&
      path.basename(file) === "api.server.ts"
    ) {
      addViolation(file, "deployables must not define local business API helpers");
    }

    if (!sourceExtensions.has(path.extname(file))) {
      continue;
    }

    const content = await readFile(file, "utf8");

    if (
      normalizedFile.startsWith("bounded-contexts/") &&
      path.basename(file) === "index.ts" &&
      forbiddenRootSurfaceReexports.test(content)
    ) {
      addViolation(file, "context root entrypoints must not re-export secondary public surfaces");
    }

    if (
      /deployables\/[^/]+\/(?:vite|vitest)\.config\.ts$/.test(normalizedFile) &&
      !content.includes("createWorkspaceSourceAliases")
    ) {
      addViolation(file, "deployable build configs must use the shared workspace alias helper");
    }

    if (
      /deployables\/[^/]+\/(?:vite|vitest)\.config\.ts$/.test(normalizedFile) &&
      /(replacement\s*:\s*[\s\S]{0,160}?\.\.\/\.\.\/(?:bounded-contexts|contracts|infrastructure|packages)\/|resolve\([\s\S]{0,120}?\.\.\/\.\.\/(?:bounded-contexts|contracts|infrastructure|packages)\/)/.test(content)
    ) {
      addViolation(file, "deployable build configs must not hard-code workspace source paths");
    }

    if (
      normalizedFile.startsWith("deployables/") &&
      /\/src\/app\.ts$/.test(normalizedFile) &&
      /\bcreateResolvedApiMount\s*\(/.test(content)
    ) {
      addViolation(file, "deployable API hosts must consume generated API mount inventories");
    }

    if (normalizedFile.startsWith("contracts/") && /\bprocess\.env\b/.test(content)) {
      addViolation(file, "contracts must not read environment variables");
    }

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
