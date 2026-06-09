import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", "artifacts"]);
const freshWriteHelperNames = new Set([
  "appendFreshWriteToken",
  "appendFreshWriteTokenFromSources",
  "loadFreshlyWrittenResource",
]);
const helperImportPattern = /from\s+["']@chase-sets\/http\/responses["']/;
const supportedRiskClassifications = new Set(["critical", "important", "internal", "informational"]);
const supportedExceptionStatuses = new Set(["accepted", "not-read-model-backed", "not-post-write-read"]);
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function normalizeRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function normalizePosixPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function formatValues(values) {
  return [...values].sort().join(", ") || "none";
}

function stripRouteFileExtension(filePath) {
  return filePath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function manifestRouteFileCandidates(contextRoot, fileExport) {
  const withoutPrefix = fileExport.replace(/^\.\//, "");
  const base = `${contextRoot}/${withoutPrefix}`;
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`);
}

function hostRoutePath(routePath) {
  const normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return normalized.replace(/\/+/g, "/");
}

function joinRoutePaths(prefix, routePath) {
  if (routePath === "/") {
    return hostRoutePath(prefix);
  }
  return hostRoutePath(`${prefix}/${routePath}`);
}

function collectApiRoutePathsForContext(context) {
  const routePaths = new Set();
  const apiPath = path.join(context.rootAbs, "api.ts");
  const apiContent = existsSync(apiPath) ? readFileSync(apiPath, "utf8") : "";
  const prefixes = [...apiContent.matchAll(/\bapp\.route\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter(isNonEmptyString);
  const routeFiles = [];

  function collectFiles(dir) {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSyncCompat(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        collectFiles(fullPath);
      } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        routeFiles.push(fullPath);
      }
    }
  }

  collectFiles(context.rootAbs);

  for (const file of routeFiles) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/\bapp\.(?:get|head)\(\s*["']([^"']+)["']/g)) {
      const routePath = match[1];
      routePaths.add(hostRoutePath(routePath));
      for (const prefix of prefixes) {
        routePaths.add(joinRoutePaths(prefix, routePath));
      }
    }
  }

  return routePaths;
}

function readdirSyncCompat(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

async function walkSourceFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

export function collectReadAfterWriteRouteIndexes(contextManifests) {
  const routesById = new Map();
  const routeIdsByFile = new Map();
  const contextsByName = new Map();
  const projectionGroupsByContext = new Map();
  const tableOwnersByContext = new Map();
  const freshnessRoutesByContext = new Map();
  const apiRoutePathsByContext = new Map();

  for (const context of contextManifests.values()) {
    contextsByName.set(context.manifest.contextName, context);
    apiRoutePathsByContext.set(context.manifest.contextName, collectApiRoutePathsForContext(context));

    const projectionGroups = new Map();
    const tableOwners = new Map();
    for (const group of context.manifest.projectionGroups ?? []) {
      if (isNonEmptyString(group.projectionName)) {
        projectionGroups.set(group.projectionName, group);
      }

      for (const tableName of group.ownedTables ?? []) {
        if (!isNonEmptyString(tableName)) {
          continue;
        }
        const owners = tableOwners.get(tableName) ?? [];
        owners.push(group);
        tableOwners.set(tableName, owners);
      }
    }
    projectionGroupsByContext.set(context.manifest.contextName, projectionGroups);
    tableOwnersByContext.set(context.manifest.contextName, tableOwners);

    const freshnessRoutes = new Map();
    for (const mount of context.manifest.apiMounts ?? []) {
      for (const route of mount.readFreshnessRoutes ?? []) {
        if (isNonEmptyString(route.routePath)) {
          freshnessRoutes.set(route.routePath, {
            mountPath: mount.mountPath,
            route,
          });
        }
      }
    }
    freshnessRoutesByContext.set(context.manifest.contextName, freshnessRoutes);

    for (const contribution of context.manifest.deployableContributions ?? []) {
      for (const route of contribution.routes ?? []) {
        if (!isNonEmptyString(route.routeId)) {
          continue;
        }

        const record = {
          contextName: context.manifest.contextName,
          deployable: contribution.deployable,
          routeId: route.routeId,
          routePath: hostRoutePath(route.routePath),
          fileExport: route.fileExport,
        };
        routesById.set(route.routeId, record);

        if (isNonEmptyString(route.fileExport)) {
          for (const candidate of manifestRouteFileCandidates(context.root, route.fileExport)) {
            const ids = routeIdsByFile.get(candidate) ?? new Set();
            ids.add(route.routeId);
            routeIdsByFile.set(candidate, ids);
          }
        }
      }
    }
  }

  return {
    contextsByName,
    apiRoutePathsByContext,
    freshnessRoutesByContext,
    projectionGroupsByContext,
    routeIdsByFile,
    routesById,
    tableOwnersByContext,
  };
}

export async function collectFreshWriteHelperUsage(options) {
  const { repoRoot, contextManifests } = options;
  const { routeIdsByFile } = collectReadAfterWriteRouteIndexes(contextManifests);
  const boundedContextRoot = path.join(repoRoot, "bounded-contexts");
  const files = await walkSourceFiles(boundedContextRoot);
  const usages = [];

  for (const file of files) {
    const relativeFile = normalizeRelative(file, repoRoot);
    if (
      relativeFile.includes("/tests/") ||
      relativeFile.endsWith(".test.ts") ||
      relativeFile.endsWith(".test.tsx") ||
      relativeFile.endsWith(".test.js") ||
      relativeFile.endsWith(".test.jsx")
    ) {
      continue;
    }

    const content = readFileSync(file, "utf8");
    if (!helperImportPattern.test(content)) {
      continue;
    }

    const helperUses = [...freshWriteHelperNames].filter((helperName) =>
      new RegExp(`\\b${helperName}\\s*\\(`).test(content),
    );
    if (helperUses.length === 0) {
      continue;
    }

    const routeIds = routeIdsByFile.get(relativeFile) ?? routeIdsByFile.get(stripRouteFileExtension(relativeFile));
    usages.push({
      file: relativeFile,
      helpers: helperUses.sort(),
      routeIds: [...(routeIds ?? [])].sort(),
    });
  }

  return usages.sort((left, right) => left.file.localeCompare(right.file));
}

function validateFreshnessRouteDependencies(options) {
  const {
    apiRoutePathsByContext,
    context,
    contextLabel,
    route,
    routeLabel,
    projectionGroupsByContext,
    tableOwnersByContext,
    violations,
  } = options;
  const targetContextName = context.manifest.contextName;

  const apiRoutePaths = apiRoutePathsByContext.get(targetContextName) ?? new Set();
  if (isNonEmptyString(route.routePath) && !apiRoutePaths.has(route.routePath)) {
    violations.push(`${routeLabel}: routePath '${route.routePath}' does not match a discovered GET/HEAD API route`);
  }

  for (const [dependencyIndex, dependency] of (route.dependencies ?? []).entries()) {
    const dependencyLabel = `${routeLabel} dependencies[${dependencyIndex}]`;
    if (!isPlainObject(dependency)) {
      continue;
    }

    const dependencyContextName =
      isNonEmptyString(dependency.targetContextName) && dependency.targetContextName !== targetContextName
        ? dependency.targetContextName
        : targetContextName;
    const projectionGroups = projectionGroupsByContext.get(dependencyContextName) ?? new Map();
    const tableOwners = tableOwnersByContext.get(dependencyContextName) ?? new Map();

    if (isNonEmptyString(dependency.projectionName) && !projectionGroups.has(dependency.projectionName)) {
      violations.push(
        `${dependencyLabel}: projectionName '${dependencyContextName}.${dependency.projectionName}' does not match a declared projection group`,
      );
    }

    if (isNonEmptyString(dependency.readModelTable)) {
      const owners = tableOwners.get(dependency.readModelTable) ?? [];
      if (owners.length === 0) {
        violations.push(
          `${dependencyLabel}: readModelTable '${dependencyContextName}.${dependency.readModelTable}' is not owned by a declared projection group`,
        );
      } else if (owners.length > 1) {
        violations.push(
          `${dependencyLabel}: readModelTable '${dependencyContextName}.${dependency.readModelTable}' is owned by multiple projection groups (${owners
            .map((owner) => owner.projectionName)
            .sort()
            .join(", ")})`,
        );
      }
    }
  }

  if (!Array.isArray(route.dependencies) || route.dependencies.length === 0) {
    violations.push(
      `${contextLabel}: readFreshnessRoutes entry '${route.routePath ?? "unknown"}' must declare dependencies`,
    );
  }
}

function routeInventoryEntries(contextManifests) {
  const entries = [];
  for (const context of contextManifests.values()) {
    for (const [index, entry] of (context.manifest.readAfterWriteRouteInventory ?? []).entries()) {
      entries.push({
        context,
        index,
        entry,
      });
    }
  }
  return entries;
}

function helperCoverageForEntry(entry) {
  const routeCoverage = new Map();
  const fileCoverage = new Map();

  for (const sectionName of ["source", "destination", "exception"]) {
    const section = entry[sectionName];
    if (!isPlainObject(section)) {
      continue;
    }

    const routeIds = [section.routeId, ...(section.routeIds ?? [])].filter(isNonEmptyString);
    const helpers = section.helperUses ?? [];
    if (!Array.isArray(helpers)) {
      continue;
    }

    for (const routeId of routeIds) {
      const helperSet = routeCoverage.get(routeId) ?? new Set();
      for (const helperName of helpers) {
        helperSet.add(helperName);
      }
      routeCoverage.set(routeId, helperSet);
    }

    for (const file of section.files ?? []) {
      const helperSet = fileCoverage.get(file) ?? new Set();
      for (const helperName of helpers) {
        helperSet.add(helperName);
      }
      fileCoverage.set(file, helperSet);
    }
  }

  return { fileCoverage, routeCoverage };
}

function validateInventoryEntry(options) {
  const {
    context,
    entry,
    index,
    freshnessRoutesByContext,
    projectionGroupsByContext,
    apiRoutePathsByContext,
    routesById,
    tableOwnersByContext,
    violations,
  } = options;
  const entryLabel = `${context.root}/context.json readAfterWriteRouteInventory[${index}]`;

  if (!isPlainObject(entry)) {
    violations.push(`${entryLabel}: inventory entry must be an object`);
    return null;
  }

  if (!isNonEmptyString(entry.id)) {
    violations.push(`${entryLabel}: id must be a non-empty string`);
  }

  if (!isNonEmptyString(entry.owner)) {
    violations.push(`${entryLabel}: owner must name the accountable context or team`);
  }

  if (!supportedRiskClassifications.has(entry.risk)) {
    violations.push(`${entryLabel}: risk must be one of ${[...supportedRiskClassifications].sort().join(", ")}`);
  }

  for (const sectionName of ["source", "destination"]) {
    if (!isPlainObject(entry[sectionName])) {
      violations.push(`${entryLabel}: ${sectionName} must be an object`);
    }
  }

  for (const [sectionName, section] of Object.entries({
    source: entry.source,
    destination: entry.destination,
    exception: entry.exception,
  })) {
    if (!isPlainObject(section)) {
      continue;
    }

    const routeIds = [section.routeId, ...(section.routeIds ?? [])].filter(isNonEmptyString);
    if (sectionName !== "exception" && routeIds.length === 0) {
      violations.push(`${entryLabel}: ${sectionName}.routeId must reference a deployable route`);
    }

    for (const routeId of routeIds) {
      if (!routesById.has(routeId)) {
        violations.push(`${entryLabel}: ${sectionName}.routeId '${routeId}' does not match a deployable route`);
      }
    }

    if ("helperUses" in section) {
      if (!isNonEmptyStringArray(section.helperUses)) {
        violations.push(`${entryLabel}: ${sectionName}.helperUses must be a non-empty string array when provided`);
      } else {
        for (const helperName of section.helperUses) {
          if (!freshWriteHelperNames.has(helperName)) {
            violations.push(`${entryLabel}: ${sectionName}.helperUses contains unsupported helper '${helperName}'`);
          }
        }
      }
    }

    if ("files" in section && !isNonEmptyStringArray(section.files)) {
      violations.push(`${entryLabel}: ${sectionName}.files must be a non-empty string array when provided`);
    }
  }

  if (isPlainObject(entry.exception)) {
    if (!supportedExceptionStatuses.has(entry.exception.status)) {
      violations.push(
        `${entryLabel}: exception.status must be one of ${[...supportedExceptionStatuses].sort().join(", ")}`,
      );
    }
    if (!isNonEmptyString(entry.exception.reason)) {
      violations.push(`${entryLabel}: exception.reason must explain why exact freshness is not required`);
    }
    if (!isNonEmptyString(entry.exception.owner)) {
      violations.push(`${entryLabel}: exception.owner must name the accountable owner`);
    }
    if (!isNonEmptyString(entry.exception.reviewBy) || !isoDatePattern.test(entry.exception.reviewBy)) {
      violations.push(`${entryLabel}: exception.reviewBy must be a YYYY-MM-DD renewal/removal date`);
    }
    return entry;
  }

  const destination = isPlainObject(entry.destination) ? entry.destination : {};
  if (!isNonEmptyString(destination.transientRecovery)) {
    violations.push(`${entryLabel}: destination.transientRecovery is required when no exception is declared`);
  }

  if (!isNonEmptyString(destination.apiContextName)) {
    violations.push(`${entryLabel}: destination.apiContextName is required when no exception is declared`);
    return entry;
  }

  if (!isNonEmptyString(destination.apiRoutePath)) {
    violations.push(`${entryLabel}: destination.apiRoutePath is required when no exception is declared`);
    return entry;
  }

  const freshnessRoutes = freshnessRoutesByContext.get(destination.apiContextName) ?? new Map();
  const freshnessRoute = freshnessRoutes.get(destination.apiRoutePath);
  if (!freshnessRoute) {
    violations.push(
      `${entryLabel}: destination.apiRoutePath '${destination.apiContextName}.${destination.apiRoutePath}' has no matching readFreshnessRoutes declaration`,
    );
    return entry;
  }

  const declaredTables = new Set(
    (freshnessRoute.route.dependencies ?? []).map((dependency) => dependency.readModelTable).filter(isNonEmptyString),
  );
  const declaredProjections = new Set(
    (freshnessRoute.route.dependencies ?? []).map((dependency) => dependency.projectionName).filter(isNonEmptyString),
  );

  for (const tableName of destination.readModelTables ?? []) {
    if (!declaredTables.has(tableName)) {
      violations.push(
        `${entryLabel}: destination.readModelTables includes '${tableName}' but the matching readFreshnessRoutes dependencies do not`,
      );
    }
  }

  for (const projectionName of destination.projectionDependencies ?? []) {
    if (!declaredProjections.has(projectionName)) {
      violations.push(
        `${entryLabel}: destination.projectionDependencies includes '${projectionName}' but the matching readFreshnessRoutes dependencies do not`,
      );
    }
  }

  validateFreshnessRouteDependencies({
    context: context,
    contextLabel: `${context.root}/context.json`,
    apiRoutePathsByContext,
    projectionGroupsByContext,
    route: freshnessRoute.route,
    routeLabel: `${context.root}/context.json readFreshnessRoutes ${destination.apiRoutePath}`,
    tableOwnersByContext,
    violations,
  });

  return entry;
}

export async function validateReadAfterWriteRouteInventory(options) {
  const { repoRoot, contextManifests, reportOutputPath = "artifacts/read-after-write-route-inventory.md" } = options;
  const indexes = collectReadAfterWriteRouteIndexes(contextManifests);
  const helperUsages = await collectFreshWriteHelperUsage({ repoRoot, contextManifests });
  const violations = [];
  const warnings = [];
  const entries = routeInventoryEntries(contextManifests);
  const entryIds = new Set();
  const helperCoverageByRoute = new Map();
  const helperCoverageByFile = new Map();
  const freshnessRoutesCovered = new Set();
  const reportEntries = [];

  for (const context of contextManifests.values()) {
    for (const [mountIndex, mount] of (context.manifest.apiMounts ?? []).entries()) {
      for (const [routeIndex, route] of (mount.readFreshnessRoutes ?? []).entries()) {
        const routeLabel = `${context.root}/context.json apiMounts[${mountIndex}] readFreshnessRoutes[${routeIndex}]`;
        validateFreshnessRouteDependencies({
          context,
          contextLabel: `${context.root}/context.json`,
          apiRoutePathsByContext: indexes.apiRoutePathsByContext,
          projectionGroupsByContext: indexes.projectionGroupsByContext,
          route,
          routeLabel,
          tableOwnersByContext: indexes.tableOwnersByContext,
          violations,
        });
      }
    }
  }

  for (const inventoryEntry of entries) {
    const { context, index, entry } = inventoryEntry;
    const entryLabel = `${context.root}/context.json readAfterWriteRouteInventory[${index}]`;
    if (isPlainObject(entry) && isNonEmptyString(entry.id)) {
      if (entryIds.has(entry.id)) {
        violations.push(`${entryLabel}: id '${entry.id}' must be unique`);
      }
      entryIds.add(entry.id);
    }

    const validatedEntry = validateInventoryEntry({
      context,
      entry,
      index,
      freshnessRoutesByContext: indexes.freshnessRoutesByContext,
      projectionGroupsByContext: indexes.projectionGroupsByContext,
      apiRoutePathsByContext: indexes.apiRoutePathsByContext,
      routesById: indexes.routesById,
      tableOwnersByContext: indexes.tableOwnersByContext,
      violations,
    });
    if (!validatedEntry) {
      continue;
    }

    const { fileCoverage, routeCoverage } = helperCoverageForEntry(validatedEntry);
    for (const [routeId, helpers] of routeCoverage.entries()) {
      const routeHelpers = helperCoverageByRoute.get(routeId) ?? new Set();
      for (const helper of helpers) {
        routeHelpers.add(helper);
      }
      helperCoverageByRoute.set(routeId, routeHelpers);
    }
    for (const [file, helpers] of fileCoverage.entries()) {
      const fileHelpers = helperCoverageByFile.get(file) ?? new Set();
      for (const helper of helpers) {
        fileHelpers.add(helper);
      }
      helperCoverageByFile.set(file, fileHelpers);
    }

    if (isPlainObject(validatedEntry.destination) && isNonEmptyString(validatedEntry.destination.apiContextName)) {
      freshnessRoutesCovered.add(
        `${validatedEntry.destination.apiContextName}:${validatedEntry.destination.apiRoutePath ?? ""}`,
      );
    }

    reportEntries.push({
      contextName: context.manifest.contextName,
      id: validatedEntry.id ?? "(missing id)",
      owner: validatedEntry.owner ?? "(missing owner)",
      risk: validatedEntry.risk ?? "(missing risk)",
      sourceRoute: validatedEntry.source?.routeId ?? "(missing source)",
      destinationRoute: validatedEntry.destination?.routeId ?? "(missing destination)",
      apiRoute: validatedEntry.destination?.apiContextName
        ? `${validatedEntry.destination.apiContextName}${validatedEntry.destination.apiRoutePath ?? ""}`
        : "(exception)",
      dependencies: [
        ...(validatedEntry.destination?.readModelTables ?? []),
        ...(validatedEntry.destination?.projectionDependencies ?? []),
      ],
      transientRecovery: validatedEntry.destination?.transientRecovery ?? "",
      exception: validatedEntry.exception?.status ?? "",
    });
  }

  for (const usage of helperUsages) {
    if (usage.routeIds.length === 0) {
      const coveredHelpers = helperCoverageByFile.get(usage.file) ?? new Set();
      const missingHelpers = usage.helpers.filter((helper) => !coveredHelpers.has(helper));
      if (missingHelpers.length > 0) {
        violations.push(
          `${usage.file}: fresh-write helper(s) ${missingHelpers.join(", ")} must map to a manifest route contribution or file-level inventory exception`,
        );
      }
      continue;
    }

    for (const routeId of usage.routeIds) {
      const coveredHelpers = helperCoverageByRoute.get(routeId) ?? new Set();
      const missingHelpers = usage.helpers.filter((helper) => !coveredHelpers.has(helper));
      if (missingHelpers.length > 0) {
        violations.push(
          `${usage.file}: fresh-write helper(s) ${missingHelpers.join(", ")} on route '${routeId}' must be declared in readAfterWriteRouteInventory or an exception`,
        );
      }
    }
  }

  for (const context of contextManifests.values()) {
    for (const mount of context.manifest.apiMounts ?? []) {
      for (const route of mount.readFreshnessRoutes ?? []) {
        const key = `${context.manifest.contextName}:${route.routePath ?? ""}`;
        if (!freshnessRoutesCovered.has(key)) {
          violations.push(
            `${context.root}/context.json: readFreshnessRoutes '${route.routePath ?? "unknown"}' must be referenced by readAfterWriteRouteInventory`,
          );
        }
      }
    }
  }

  writeReadAfterWriteRouteInventoryReport({
    repoRoot,
    outputPath: reportOutputPath,
    entries: reportEntries,
    helperUsages,
    violations,
    warnings,
  });

  return {
    ok: violations.length === 0,
    helperUsages,
    reportEntries,
    violations,
    warnings,
  };
}

export function writeReadAfterWriteRouteInventoryReport(options) {
  const { repoRoot, outputPath, entries, helperUsages, violations, warnings } = options;
  const absoluteOutputPath = path.resolve(repoRoot, outputPath);
  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  const lines = [
    "# Read-After-Write Route Inventory",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Routes",
    "",
    "| Context | Inventory ID | Risk | Owner | Source route | Destination route | API route | Dependencies | Recovery / exception |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of entries.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `| ${entry.contextName} | ${entry.id} | ${entry.risk} | ${entry.owner} | ${entry.sourceRoute} | ${entry.destinationRoute} | ${entry.apiRoute} | ${formatValues(entry.dependencies)} | ${entry.exception || entry.transientRecovery || "none"} |`,
    );
  }

  lines.push("", "## Helper Uses", "");
  for (const usage of helperUsages) {
    lines.push(`- ${usage.file}: ${usage.helpers.join(", ")} (${usage.routeIds.join(", ") || "unmapped"})`);
  }

  lines.push("", "## Validation", "");
  if (violations.length === 0 && warnings.length === 0) {
    lines.push("- Passed with no violations or warnings.");
  } else {
    for (const violation of violations) {
      lines.push(`- Violation: ${violation}`);
    }
    for (const warning of warnings) {
      lines.push(`- Warning: ${warning}`);
    }
  }

  writeFileSync(absoluteOutputPath, `${lines.join("\n")}\n`, "utf8");
}
