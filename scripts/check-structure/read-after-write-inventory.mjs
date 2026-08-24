import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", "artifacts"]);
const freshWriteHelperNames = new Set([
  "appendFreshWriteToken",
  "appendFreshWriteTokenFromSources",
  "appendPostWriteHandoff",
  "appendPostWriteHandoffFromSources",
  "evaluatePostWriteHandoff",
  "defineResourceRoute",
  "formActionRedirect",
  "formActionRedirectFromSources",
  "loadAfterWrite",
  "loadFreshlyWrittenResource",
  "navigateAfterWrite",
  "navigateAfterWriteFromSources",
  "navigateAfterWriteFromSourcesWithCompactToken",
  "navigateAfterWriteFromSourcesWithPlatformPostWriteToken",
  "navigateAfterWriteWithCompactToken",
  "navigateAfterWriteWithPlatformPostWriteToken",
  "readPostWriteHandoff",
  "readPostWriteHandoffState",
]);
const semanticPostWriteHandoffHelperNames = new Set([
  "appendPostWriteHandoff",
  "appendPostWriteHandoffFromSources",
  "evaluatePostWriteHandoff",
  "readPostWriteHandoff",
  "readPostWriteHandoffState",
]);
const receiptProducingFreshWriteHelperNames = new Set([
  "appendFreshWriteToken",
  "appendFreshWriteTokenFromSources",
  "appendPostWriteHandoff",
  "appendPostWriteHandoffFromSources",
  "navigateAfterWrite",
  "navigateAfterWriteFromSources",
  "navigateAfterWriteFromSourcesWithCompactToken",
  "navigateAfterWriteFromSourcesWithPlatformPostWriteToken",
  "navigateAfterWriteWithCompactToken",
  "navigateAfterWriteWithPlatformPostWriteToken",
  "formActionRedirect",
  "formActionRedirectFromSources",
]);
const routeRuntimeContractHelperNames = new Set([
  "defineResourceRoute",
  "formActionRedirect",
  "formActionRedirectFromSources",
]);

function helperUseSatisfiesClaim(usedHelpers, claimedHelper) {
  if (usedHelpers.has(claimedHelper)) return true;
  if (usedHelpers.has("defineResourceRoute") && claimedHelper === "loadAfterWrite") return true;
  if (
    (usedHelpers.has("formActionRedirect") || usedHelpers.has("formActionRedirectFromSources")) &&
    receiptProducingFreshWriteHelperNames.has(claimedHelper)
  ) {
    return true;
  }
  return false;
}

function helperUsageIsCovered(usedHelper, coveredHelpers) {
  if (coveredHelpers.has(usedHelper)) return true;
  if (usedHelper === "defineResourceRoute" && coveredHelpers.has("loadAfterWrite")) return true;
  if (usedHelper === "formActionRedirect" || usedHelper === "formActionRedirectFromSources") {
    return [...coveredHelpers].some((helper) => receiptProducingFreshWriteHelperNames.has(helper));
  }
  return false;
}
const helperImportPattern =
  /from\s+["']@chase-sets\/(?:http\/responses|platform-runtime\/http|platform-runtime\/post-write-tokens)["']/;
const rawPostWriteHandoffMetadataPattern =
  /\bsearchParams\.(?:set|append)\(\s*["']postWriteHandoff["']|[?&]postWriteHandoff=|new\s+URLSearchParams\(\s*\{[^}]*\bpostWriteHandoff\b/s;
const supportedRiskClassifications = new Set(["critical", "important", "internal", "informational"]);
const supportedExceptionStatuses = new Set(["accepted", "not-read-model-backed", "not-post-write-read"]);
const supportedFreshnessFlowClasses = new Set([
  "critical-customer-handoff",
  "important-self-refresh",
  "operator-background-read",
]);
const POST_WRITE_HANDOFF_EXPECTATIONS = new Set([
  "resource-present",
  "resource-updated",
  "resource-absent",
  "collection-non-empty",
]);
const POST_WRITE_RECOVERY_KINDS = new Set([
  "pending-projection",
  "refreshable-catching-up",
  "stale-projection",
  "action-required",
  "expired-handoff",
  "terminal-failure",
]);
const mutatingHttpMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const supportedMutationStrategies = new Set([
  "fresh-read",
  "optimistic-with-correction",
  "realtime-correction",
  "snapshot-return",
  "read-model-neutral",
  "non-user-visible",
  "not-post-write-read",
  "migration",
]);
const mutationExceptionStrategies = new Set([
  "read-model-neutral",
  "non-user-visible",
  "not-post-write-read",
  "migration",
]);
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const frozenMutationConsistencyBaselineSurfaces = new Set([
  "api-route:bounded-contexts/public-presence/api.ts:DELETE /promo-bar-messages/:messageId",
  "api-route:bounded-contexts/public-presence/api.ts:POST /promo-bar-messages",
  "api-route:bounded-contexts/public-presence/api.ts:POST /promo-bar-messages/:messageId/activate",
  "api-route:bounded-contexts/public-presence/api.ts:POST /promo-bar-messages/:messageId/deactivate",
  "api-route:bounded-contexts/public-presence/api.ts:POST /waitlist",
  "api-route:bounded-contexts/public-presence/api.ts:PUT /promo-bar-messages/:messageId",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#1",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#2",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#3",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#4",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#5",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#6",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-detail-page.tsx:H2df726441e2a#7",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-packing-page.tsx:H2df726441e2a#1",
  "post-form:bounded-contexts/fulfillment/features/shipments/ui/shipment-packing-page.tsx:Ha72c19094e96#1",
  "post-form:bounded-contexts/public-presence/features/promo-bar/ui/admin-pages.tsx:H2df726441e2a#1",
  "post-form:bounded-contexts/public-presence/features/promo-bar/ui/admin-pages.tsx:H2df726441e2a#2",
  "post-form:bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx:H2df726441e2a#1",
  "route-action:bounded-contexts/auth/routes/access-admin/account-select.tsx",
  "route-action:bounded-contexts/auth/routes/access-admin/sessions-detail.tsx",
  "route-action:bounded-contexts/auth/routes/access-admin/sign-in.tsx",
  "route-action:bounded-contexts/auth/routes/access-admin/sign-out.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/account-select.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/account-sessions-detail.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/guest-checkout-exit.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/register.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/sign-in.tsx",
  "route-action:bounded-contexts/auth/routes/marketplace/sign-out.tsx",
  "route-action:bounded-contexts/public-presence/routes/admin/promo-bar.tsx",
  "route-action:bounded-contexts/public-presence/routes/marketplace/home.tsx",
]);

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

function isPostWriteRecoveryKind(value) {
  return typeof value === "string" && POST_WRITE_RECOVERY_KINDS.has(value);
}

function postWriteRecoveryKindsFromValue(value) {
  if (isPostWriteRecoveryKind(value)) {
    return [value];
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isPostWriteRecoveryKind)) {
    return value;
  }
  return null;
}

function postWriteRecoveryKinds(declaration) {
  if (!isPlainObject(declaration)) {
    return null;
  }
  return postWriteRecoveryKindsFromValue(declaration.kinds);
}

function postWriteRecoveryBehavior(declaration) {
  return isPlainObject(declaration) && isNonEmptyString(declaration.behavior) ? declaration.behavior : "";
}

function isPortableHandoffText(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function formatValues(values) {
  return [...values].sort().join(", ") || "none";
}

function formatFreshnessSlo(slo) {
  if (!isPlainObject(slo)) {
    return "missing";
  }
  return `${slo.flowClass ?? "missing"} p95<=${slo.p95Ms ?? "?"}ms p99<=${slo.p99Ms ?? "?"}ms`;
}

function sectionRouteIds(section) {
  if (!isPlainObject(section)) {
    return [];
  }
  return [section.routeId, ...(section.routeIds ?? [])].filter(isNonEmptyString);
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function recommendedStrategyForSurface(surface) {
  if (surface.kind === "post-form" || surface.kind === "fetcher-submit" || surface.kind === "route-action") {
    return "fresh-read or optimistic-with-correction";
  }
  if (surface.kind === "api-route" || surface.kind === "api-client") {
    return "snapshot-return or fresh-read";
  }
  return "needs classification";
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function contextRootForFile(relativeFile) {
  const match = relativeFile.match(/^bounded-contexts\/[^/]+/);
  return match?.[0] ?? null;
}

function contextNameForFile(relativeFile, contextManifests) {
  const contextRoot = contextRootForFile(relativeFile);
  if (!contextRoot) {
    return null;
  }
  return contextManifests.get(contextRoot)?.manifest.contextName ?? contextRoot.slice("bounded-contexts/".length);
}

function buildMutationSurfaceId(kind, file, detail) {
  return detail ? `${kind}:${file}:${detail}` : `${kind}:${file}`;
}

function stableSnippetId(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return `H${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

function occurrenceDetail(occurrences, scope, baseDetail) {
  const key = `${scope}:${baseDetail}`;
  const count = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, count);
  return `${baseDetail}#${count}`;
}

function addMutationSurface(surfaces, surface) {
  if (surfaces.some((existing) => existing.id === surface.id)) {
    return;
  }
  surfaces.push(surface);
}

function stripRouteFileExtension(filePath) {
  return filePath.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function manifestRouteFileCandidates(contextRoot, fileExport) {
  const withoutPrefix = fileExport.replace(/^\.\//, "");
  const base = `${contextRoot}/${withoutPrefix}`;
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`);
}

function routeSupportRouteIds(relativeFile, contextManifests, routesById) {
  const match = relativeFile.match(/^(bounded-contexts\/[^/]+)\/support\/route-support\/([^/]+)\//);
  if (!match) {
    return new Set();
  }

  const [, contextRoot, routeId] = match;
  const context = contextManifests.get(contextRoot);
  const route = routesById.get(routeId);
  if (!context || !route || route.contextName !== context.manifest.contextName) {
    return new Set();
  }

  return new Set([routeId]);
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
  const routeFileContents = routeFiles.map((file) => [file, readFileSync(file, "utf8")]);
  const prefixes = routeFileContents
    .flatMap(([, content]) => [...content.matchAll(/\bapp\.route\(\s*["']([^"']+)["']/g)])
    .map((match) => match[1])
    .filter(isNonEmptyString);

  for (const [, content] of routeFileContents) {
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
  const { routeIdsByFile, routesById } = collectReadAfterWriteRouteIndexes(contextManifests);
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
      new RegExp(`\\b${helperName}\\s*(?:<[^>]+>\\s*)?\\(`).test(content),
    );
    if (helperUses.length === 0) {
      continue;
    }

    const routeIds =
      routeIdsByFile.get(relativeFile) ??
      routeIdsByFile.get(stripRouteFileExtension(relativeFile)) ??
      routeSupportRouteIds(relativeFile, contextManifests, routesById);
    usages.push({
      file: relativeFile,
      helpers: helperUses.sort(),
      routeIds: [...(routeIds ?? [])].sort(),
    });
  }

  return usages.sort((left, right) => left.file.localeCompare(right.file));
}

async function collectRawPostWriteHandoffMetadataUsage(options) {
  const { repoRoot } = options;
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
    if (rawPostWriteHandoffMetadataPattern.test(content)) {
      usages.push(relativeFile);
    }
  }

  return usages.sort();
}

export async function collectMutationConsistencySurfaces(options) {
  const { repoRoot, contextManifests } = options;
  const { routeIdsByFile, routesById } = collectReadAfterWriteRouteIndexes(contextManifests);
  const scanRoots = ["bounded-contexts", "deployables"]
    .map((root) => path.join(repoRoot, root))
    .filter((root) => existsSync(root));
  const files = [];
  for (const scanRoot of scanRoots) {
    files.push(...(await walkSourceFiles(scanRoot)));
  }
  const surfaces = [];

  for (const file of files) {
    const relativeFile = normalizeRelative(file, repoRoot);
    if (
      relativeFile.includes("/tests/") ||
      relativeFile.includes("/__tests__/") ||
      relativeFile.endsWith(".test.ts") ||
      relativeFile.endsWith(".test.tsx") ||
      relativeFile.endsWith(".spec.ts") ||
      relativeFile.endsWith(".spec.tsx")
    ) {
      continue;
    }

    const contextName = contextNameForFile(relativeFile, contextManifests);
    const contextRoot = contextRootForFile(relativeFile);
    const completeRawFetchCensus =
      contextRoot !== null && contextManifests.get(contextRoot)?.manifest.rawFetchCensus === "complete";
    const content = readFileSync(file, "utf8");
    const routeIds = [
      ...(routeIdsByFile.get(relativeFile) ??
        routeIdsByFile.get(stripRouteFileExtension(relativeFile)) ??
        routeSupportRouteIds(relativeFile, contextManifests, routesById)),
    ].sort();
    const occurrenceCounts = new Map();

    if (completeRawFetchCensus && !/(?:^|\/)(?:client|server)\.ts$/.test(relativeFile)) {
      const rawFetchPattern = /\bfetch\s*\([\s\S]{0,1600}?\);/g;
      for (const match of content.matchAll(rawFetchPattern)) {
        const method =
          match[0].match(/\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i)?.[1].toUpperCase() ?? "GET";
        const detail = occurrenceDetail(occurrenceCounts, "raw-fetch", `${method} ${stableSnippetId(match[0])}`);
        addMutationSurface(surfaces, {
          id: buildMutationSurfaceId("raw-fetch", relativeFile, detail),
          contextName: contextName ?? "deployable",
          file: relativeFile,
          kind: "raw-fetch",
          routeIds,
          location: `${relativeFile}:${lineNumberAt(content, match.index ?? 0)}`,
          mutationSurface: `${method} raw fetch`,
        });
      }
    }

    if (/^\s*export\s+(?:async\s+function|const)\s+action\b/m.test(content)) {
      addMutationSurface(surfaces, {
        id: buildMutationSurfaceId("route-action", relativeFile),
        contextName: contextName ?? "deployable",
        file: relativeFile,
        kind: "route-action",
        routeIds,
        location: relativeFile,
        mutationSurface: "browser route action",
      });
    }

    const postFormPattern =
      /<(?:RouterForm|Form|fetcher\.Form|form)\b[\s\S]{0,800}?\bmethod\s*=\s*(?:"post"|'post'|\{\s*["']post["']\s*\})/g;
    for (const match of content.matchAll(postFormPattern)) {
      const line = lineNumberAt(content, match.index ?? 0);
      const detail = occurrenceDetail(occurrenceCounts, "post-form", stableSnippetId(match[0]));
      addMutationSurface(surfaces, {
        id: buildMutationSurfaceId("post-form", relativeFile, detail),
        contextName: contextName ?? "deployable",
        file: relativeFile,
        kind: "post-form",
        routeIds,
        location: `${relativeFile}:${line}`,
        mutationSurface: "POST form",
      });
    }

    const fetcherSubmitPattern =
      /\b[A-Za-z0-9_$]+\.submit\([\s\S]{0,800}?\bmethod\s*:\s*["'](?:post|put|patch|delete)["']/gi;
    for (const match of content.matchAll(fetcherSubmitPattern)) {
      const line = lineNumberAt(content, match.index ?? 0);
      const detail = occurrenceDetail(occurrenceCounts, "fetcher-submit", stableSnippetId(match[0]));
      addMutationSurface(surfaces, {
        id: buildMutationSurfaceId("fetcher-submit", relativeFile, detail),
        contextName: contextName ?? "deployable",
        file: relativeFile,
        kind: "fetcher-submit",
        routeIds,
        location: `${relativeFile}:${line}`,
        mutationSurface: "fetcher submit",
      });
    }

    const apiRoutePattern = /\bapp\.(post|put|patch|delete)\(\s*["']([^"']+)["']/gi;
    for (const match of content.matchAll(apiRoutePattern)) {
      const method = match[1].toUpperCase();
      const routePath = hostRoutePath(match[2]);
      addMutationSurface(surfaces, {
        id: buildMutationSurfaceId("api-route", relativeFile, `${method} ${routePath}`),
        contextName: contextName ?? "deployable",
        file: relativeFile,
        kind: "api-route",
        routeIds: [],
        location: `${relativeFile}:${lineNumberAt(content, match.index ?? 0)}`,
        mutationSurface: `${method} API route ${routePath}`,
      });
    }

    const shouldScanAsApiClient =
      /(?:^|\/)(?:client|server)\.ts$/.test(relativeFile) ||
      relativeFile.includes("/request-support/") ||
      relativeFile.includes("/client-support/") ||
      relativeFile.includes("/api-client") ||
      relativeFile.includes("/api/");
    if (shouldScanAsApiClient) {
      const methodPropertyPattern = /\bmethod\s*:\s*["'](POST|PUT|PATCH|DELETE|post|put|patch|delete)["']/g;
      for (const match of content.matchAll(methodPropertyPattern)) {
        const method = match[1].toUpperCase();
        if (!mutatingHttpMethods.has(method)) {
          continue;
        }
        const line = lineNumberAt(content, match.index ?? 0);
        const snippetStart = Math.max(0, (match.index ?? 0) - 240);
        const snippetEnd = Math.min(content.length, (match.index ?? 0) + 240);
        const detail = occurrenceDetail(
          occurrenceCounts,
          "api-client",
          `${method} ${stableSnippetId(content.slice(snippetStart, snippetEnd))}`,
        );
        addMutationSurface(surfaces, {
          id: buildMutationSurfaceId("api-client", relativeFile, detail),
          contextName: contextName ?? "deployable",
          file: relativeFile,
          kind: "api-client",
          routeIds,
          location: `${relativeFile}:${line}`,
          mutationSurface: `${method} API client call`,
        });
      }
    }
  }

  return surfaces.sort((left, right) => left.id.localeCompare(right.id));
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

  if (!Array.isArray(route.dependencies) || route.dependencies.length === 0) {
    violations.push(
      `${routeLabel}: readFreshnessRoutes entry '${route.routePath ?? "unknown"}' must declare dependencies`,
    );
    return;
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
}

function validateReadModelTableOwnership(options) {
  const { dependencyLabel, tableName, targetContextName, tableOwnersByContext, violations } = options;
  const owners = tableOwnersByContext.get(targetContextName)?.get(tableName) ?? [];
  if (owners.length === 0) {
    violations.push(
      `${dependencyLabel}: readModelTable '${targetContextName}.${tableName}' is not owned by a declared projection group`,
    );
    return;
  }
  if (owners.length > 1) {
    violations.push(
      `${dependencyLabel}: readModelTable '${targetContextName}.${tableName}' is owned by multiple projection groups (${owners
        .map((owner) => owner.projectionName)
        .sort()
        .join(", ")})`,
    );
  }
}

function validateProjectionDependencyJustification(options) {
  const { sectionLabel, section, violations } = options;
  const projectionDependencies = section.projectionDependencies ?? [];
  if (projectionDependencies.length > 0 && !isNonEmptyString(section.freshnessDependencyReason)) {
    violations.push(
      `${sectionLabel}.freshnessDependencyReason is required when declaring projectionDependencies instead of readModelTables`,
    );
  }
}

function validateInventoryFreshnessDependencies(options) {
  const { entryLabel, sectionLabel, section, freshnessRoute, targetContextName, projectionGroupsByContext } = options;
  const { tableOwnersByContext, violations } = options;
  const declaredTables = new Set(
    (freshnessRoute.route.dependencies ?? []).map((dependency) => dependency.readModelTable).filter(isNonEmptyString),
  );
  const declaredProjections = new Set(
    (freshnessRoute.route.dependencies ?? []).map((dependency) => dependency.projectionName).filter(isNonEmptyString),
  );
  const projectionGroups = projectionGroupsByContext.get(targetContextName) ?? new Map();

  for (const tableName of section.readModelTables ?? []) {
    if (!declaredTables.has(tableName)) {
      violations.push(
        `${entryLabel}: ${sectionLabel}.readModelTables includes '${tableName}' but the matching readFreshnessRoutes dependencies do not`,
      );
    }

    validateReadModelTableOwnership({
      dependencyLabel: `${entryLabel}: ${sectionLabel}`,
      tableName,
      targetContextName,
      tableOwnersByContext,
      violations,
    });
  }

  validateProjectionDependencyJustification({ sectionLabel: `${entryLabel}: ${sectionLabel}`, section, violations });

  for (const projectionName of section.projectionDependencies ?? []) {
    if (!projectionGroups.has(projectionName)) {
      violations.push(
        `${entryLabel}: ${sectionLabel}.projectionDependencies includes '${targetContextName}.${projectionName}' but that projection group is not declared`,
      );
      continue;
    }
    if (!declaredProjections.has(projectionName)) {
      violations.push(
        `${entryLabel}: ${sectionLabel}.projectionDependencies includes '${projectionName}' but the matching readFreshnessRoutes explicit dependencies do not`,
      );
    }
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

function routeSetIntersects(left, right) {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function hasProjectionBackedMutationDestination(destination) {
  if (!isPlainObject(destination)) {
    return false;
  }

  return (
    isNonEmptyString(destination.apiContextName) &&
    isNonEmptyString(destination.apiRoutePath) &&
    (isNonEmptyStringArray(destination.readModelTables) || isNonEmptyStringArray(destination.projectionDependencies))
  );
}

function destinationMatchesMutationFreshRead(destination, visibleDestination) {
  return (
    isPlainObject(destination) &&
    destination.apiContextName === visibleDestination.apiContextName &&
    destination.apiRoutePath === visibleDestination.apiRoutePath
  );
}

function sectionUsesReceiptProducingHelper(section) {
  const helperUses = Array.isArray(section?.helperUses) ? section.helperUses : [];
  return helperUses.some((helperName) => receiptProducingFreshWriteHelperNames.has(helperName));
}

function hasDeclaredFreshReadReceiptSource(options) {
  const { entries, sourceRouteIds, visibleDestination } = options;
  const sourceRoutes = new Set(sourceRouteIds);

  return entries.some(({ entry }) => {
    if (!isPlainObject(entry) || !isPlainObject(entry.source) || !isPlainObject(entry.destination)) {
      return false;
    }

    return (
      routeSetIntersects(sectionRouteIds(entry.source), sourceRoutes) &&
      destinationMatchesMutationFreshRead(entry.destination, visibleDestination) &&
      sectionUsesReceiptProducingHelper(entry.source)
    );
  });
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

function collectHelperUsageIndexes(helperUsages) {
  const helpersUsedByRoute = new Map();
  const helpersUsedByFile = new Map();

  for (const usage of helperUsages) {
    helpersUsedByFile.set(usage.file, new Set(usage.helpers));
    for (const routeId of usage.routeIds) {
      const helperSet = helpersUsedByRoute.get(routeId) ?? new Set();
      for (const helperName of usage.helpers) {
        helperSet.add(helperName);
      }
      helpersUsedByRoute.set(routeId, helperSet);
    }
  }

  return { helpersUsedByFile, helpersUsedByRoute };
}

function validateHelperUseClaims(options) {
  const { entry, entryLabel, helpersUsedByFile, helpersUsedByRoute, routesById, violations } = options;

  for (const [sectionName, section] of Object.entries({
    source: entry.source,
    destination: entry.destination,
    exception: entry.exception,
  })) {
    if (!isPlainObject(section) || !isNonEmptyStringArray(section.helperUses)) {
      continue;
    }

    const claimedHelpers = section.helperUses.filter((helperName) => freshWriteHelperNames.has(helperName));
    const routeIds = [section.routeId, ...(section.routeIds ?? [])]
      .filter(isNonEmptyString)
      .filter((routeId) => routesById.has(routeId));

    for (const routeId of routeIds) {
      const usedHelpers = helpersUsedByRoute.get(routeId) ?? new Set();
      for (const helperName of claimedHelpers) {
        if (!helperUseSatisfiesClaim(usedHelpers, helperName)) {
          violations.push(
            `${entryLabel}: ${sectionName}.helperUses claims '${helperName}' on route '${routeId}' but no production route module for that route uses it`,
          );
        }
      }
    }

    for (const file of section.files ?? []) {
      if (!isNonEmptyString(file)) {
        continue;
      }
      const usedHelpers = helpersUsedByFile.get(file) ?? new Set();
      for (const helperName of claimedHelpers) {
        if (!helperUseSatisfiesClaim(usedHelpers, helperName)) {
          violations.push(
            `${entryLabel}: ${sectionName}.helperUses claims '${helperName}' for file '${file}' but the file does not use it`,
          );
        }
      }
    }
  }
}

function validatePostWriteHandoffDeclarations(options) {
  const { entryLabel, sectionName, section, violations } = options;
  const helperUses = Array.isArray(section.helperUses) ? section.helperUses : [];
  const semanticHelperUses = helperUses.filter((helperName) => semanticPostWriteHandoffHelperNames.has(helperName));
  const hasDeclarations = "postWriteHandoffs" in section;

  if (semanticHelperUses.length > 0 && !hasDeclarations) {
    violations.push(
      `${entryLabel}: ${sectionName}.postWriteHandoffs must declare portable handoff receipts when using ${semanticHelperUses
        .sort()
        .join(", ")}`,
    );
    return;
  }

  if (!hasDeclarations) {
    return;
  }

  if (!Array.isArray(section.postWriteHandoffs) || section.postWriteHandoffs.length === 0) {
    violations.push(`${entryLabel}: ${sectionName}.postWriteHandoffs must be a non-empty array when provided`);
    return;
  }

  for (const [handoffIndex, handoff] of section.postWriteHandoffs.entries()) {
    const handoffLabel = `${entryLabel}: ${sectionName}.postWriteHandoffs[${handoffIndex}]`;
    if (!isPlainObject(handoff)) {
      violations.push(`${handoffLabel} must be an object`);
      continue;
    }

    const supportedHandoffKeys = new Set([
      "kind",
      "expectation",
      "surface",
      "sourceContextName",
      "receiptSourceContextName",
      "actorOwnership",
      "destinationRead",
    ]);
    const unsupportedKeys = Object.keys(handoff).filter((key) => !supportedHandoffKeys.has(key));
    if (unsupportedKeys.length > 0) {
      violations.push(`${handoffLabel} contains unsupported field(s): ${unsupportedKeys.sort().join(", ")}`);
    }
    if (!isPortableHandoffText(handoff.kind)) {
      violations.push(`${handoffLabel}.kind must use portable handoff text`);
    }
    if (!POST_WRITE_HANDOFF_EXPECTATIONS.has(handoff.expectation)) {
      violations.push(
        `${handoffLabel}.expectation must be one of ${[...POST_WRITE_HANDOFF_EXPECTATIONS].sort().join(", ")}`,
      );
    }
    if (handoff.surface !== undefined && !isPortableHandoffText(handoff.surface)) {
      violations.push(`${handoffLabel}.surface must use portable handoff text when provided`);
    }
    if (!isNonEmptyString(handoff.sourceContextName)) {
      violations.push(`${handoffLabel}.sourceContextName must name the command source context`);
    }
    if (!isNonEmptyString(handoff.receiptSourceContextName)) {
      violations.push(`${handoffLabel}.receiptSourceContextName must name the commit receipt source context`);
    }
    if (!isNonEmptyString(handoff.actorOwnership)) {
      violations.push(`${handoffLabel}.actorOwnership must describe the actor/account ownership guard`);
    }

    const destinationRead = handoff.destinationRead;
    if (!isPlainObject(destinationRead)) {
      violations.push(`${handoffLabel}.destinationRead must declare the intended projection-backed read`);
      continue;
    }

    const unsupportedDestinationReadKeys = Object.keys(destinationRead).filter(
      (key) => !["apiContextName", "apiRoutePath", "readModelTables", "projectionDependencies"].includes(key),
    );
    if (unsupportedDestinationReadKeys.length > 0) {
      violations.push(
        `${handoffLabel}.destinationRead contains unsupported field(s): ${unsupportedDestinationReadKeys
          .sort()
          .join(", ")}`,
      );
    }
    if (!isNonEmptyString(destinationRead.apiContextName)) {
      violations.push(`${handoffLabel}.destinationRead.apiContextName must be a non-empty string`);
    }
    if (!isNonEmptyString(destinationRead.apiRoutePath)) {
      violations.push(`${handoffLabel}.destinationRead.apiRoutePath must be a non-empty string`);
    }
    const destinationTables = destinationRead.readModelTables ?? [];
    const destinationProjections = destinationRead.projectionDependencies ?? [];
    if (!isNonEmptyStringArray(destinationTables) && !isNonEmptyStringArray(destinationProjections)) {
      violations.push(
        `${handoffLabel}.destinationRead must declare readModelTables or projectionDependencies for the expected read`,
      );
    }

    if (sectionName === "destination") {
      if (destinationRead.apiContextName !== section.apiContextName) {
        violations.push(`${handoffLabel}.destinationRead.apiContextName must match destination.apiContextName`);
      }
      if (destinationRead.apiRoutePath !== section.apiRoutePath) {
        violations.push(`${handoffLabel}.destinationRead.apiRoutePath must match destination.apiRoutePath`);
      }
      const sectionTables = new Set(section.readModelTables ?? []);
      for (const tableName of destinationTables) {
        if (!sectionTables.has(tableName)) {
          violations.push(
            `${handoffLabel}.destinationRead.readModelTables includes '${tableName}' not declared by destination.readModelTables`,
          );
        }
      }
      const sectionProjections = new Set(section.projectionDependencies ?? []);
      for (const projectionName of destinationProjections) {
        if (!sectionProjections.has(projectionName)) {
          violations.push(
            `${handoffLabel}.destinationRead.projectionDependencies includes '${projectionName}' not declared by destination.projectionDependencies`,
          );
        }
      }
    }
  }
}

function collectMutationConsistencyDeclarations(contextManifests) {
  const declarations = [];
  for (const context of contextManifests.values()) {
    for (const [index, entry] of (context.manifest.mutationConsistencyInventory ?? []).entries()) {
      declarations.push({ context, entry, index });
    }
  }
  return declarations;
}

function collectBaselineMutationSurfaces(repoRoot) {
  const baselinePath = path.join(repoRoot, "scripts", "check-structure", "mutation-consistency-baseline.json");
  if (!existsSync(baselinePath)) {
    return new Map();
  }

  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  const defaults = {
    issue: parsed.issue,
    owner: parsed.owner,
    reason: parsed.reason,
    reviewBy: parsed.reviewBy,
  };
  const baseline = new Map();
  for (const entry of parsed.surfaces ?? []) {
    if (typeof entry === "string") {
      baseline.set(entry, defaults);
      continue;
    }
    if (isPlainObject(entry) && isNonEmptyString(entry.id)) {
      baseline.set(entry.id, { ...defaults, ...entry });
    }
  }
  return baseline;
}

function validateMutationException(entryLabel, entry, violations) {
  const exception = entry.exception;
  if (!isPlainObject(exception)) {
    violations.push(`${entryLabel}: ${entry.strategy} strategy requires exception owner, reason, reviewBy, and issue`);
    return;
  }
  if (!isNonEmptyString(exception.owner)) {
    violations.push(`${entryLabel}: exception.owner must name the accountable owner`);
  }
  if (!isNonEmptyString(exception.reason)) {
    violations.push(`${entryLabel}: exception.reason must tie the classification to code evidence`);
  }
  if (!isNonEmptyString(exception.reviewBy) || !isoDatePattern.test(exception.reviewBy)) {
    violations.push(`${entryLabel}: exception.reviewBy must be a YYYY-MM-DD renewal/removal date`);
  }
  if (!isNonEmptyString(exception.issue) || !/^#\d+$/.test(exception.issue)) {
    violations.push(
      `${entryLabel}: exception.issue must reference the remediation or evidence issue, for example #1809`,
    );
  }
}

function validateMutationFreshReadProof(options) {
  const { entryLabel, entry, indexes, violations } = options;
  const destination = isPlainObject(entry.visibleDestination) ? entry.visibleDestination : {};
  if (!isNonEmptyString(destination.apiContextName)) {
    violations.push(`${entryLabel}: fresh-read visibleDestination.apiContextName is required`);
    return;
  }
  if (!isNonEmptyString(destination.apiRoutePath)) {
    violations.push(`${entryLabel}: fresh-read visibleDestination.apiRoutePath is required`);
    return;
  }
  validateTransientRecoveryDeclaration({
    entryLabel,
    fieldPath: "fresh-read visibleDestination.transientRecovery",
    value: destination.transientRecovery,
    violations,
  });
  if (destination.transientRecovery === undefined) {
    violations.push(`${entryLabel}: fresh-read visibleDestination.transientRecovery is required`);
  }

  const readModelTables = destination.readModelTables ?? [];
  const projectionDependencies = destination.projectionDependencies ?? [];
  if (!isNonEmptyStringArray(readModelTables) && !isNonEmptyStringArray(projectionDependencies)) {
    violations.push(`${entryLabel}: fresh-read requires readModelTables or projectionDependencies`);
  }

  const freshnessRoute = indexes.freshnessRoutesByContext
    .get(destination.apiContextName)
    ?.get(destination.apiRoutePath);
  if (!freshnessRoute) {
    violations.push(
      `${entryLabel}: fresh-read destination '${destination.apiContextName}.${destination.apiRoutePath}' has no matching readFreshnessRoutes declaration`,
    );
    return;
  }

  validateInventoryFreshnessDependencies({
    entryLabel,
    sectionLabel: "fresh-read visibleDestination",
    section: destination,
    freshnessRoute,
    targetContextName: destination.apiContextName,
    projectionGroupsByContext: indexes.projectionGroupsByContext,
    tableOwnersByContext: indexes.tableOwnersByContext,
    violations,
  });
}

function validateTransientRecoveryDeclaration(options) {
  const { entryLabel, fieldPath, value, violations } = options;
  if (value === undefined) {
    return;
  }

  if (!isPlainObject(value)) {
    violations.push(
      `${entryLabel}: ${fieldPath} must be an object with canonical post-write recovery kinds and route-owned behavior`,
    );
    return;
  }

  if (!postWriteRecoveryKinds(value)) {
    violations.push(
      `${entryLabel}: ${fieldPath}.kinds must be a canonical post-write recovery kind or non-empty array of kinds (${formatValues(
        POST_WRITE_RECOVERY_KINDS,
      )})`,
    );
  }

  if (!isNonEmptyString(value.behavior)) {
    violations.push(`${entryLabel}: ${fieldPath}.behavior must describe route-owned recovery behavior`);
  }
}

function validateFreshnessSloDeclaration(options) {
  const { entryLabel, risk, value, violations } = options;
  if (!isPlainObject(value)) {
    violations.push(`${entryLabel}: freshnessSlo with flowClass, p95Ms, and p99Ms is required`);
    return;
  }

  if (!supportedFreshnessFlowClasses.has(value.flowClass)) {
    violations.push(
      `${entryLabel}: freshnessSlo.flowClass must be one of ${[...supportedFreshnessFlowClasses].sort().join(", ")}`,
    );
  }

  if (!Number.isInteger(value.p95Ms) || value.p95Ms <= 0) {
    violations.push(`${entryLabel}: freshnessSlo.p95Ms must be a positive integer millisecond target`);
  }
  if (!Number.isInteger(value.p99Ms) || value.p99Ms <= 0) {
    violations.push(`${entryLabel}: freshnessSlo.p99Ms must be a positive integer millisecond target`);
  }
  if (Number.isInteger(value.p95Ms) && Number.isInteger(value.p99Ms) && value.p99Ms < value.p95Ms) {
    violations.push(`${entryLabel}: freshnessSlo.p99Ms must be greater than or equal to p95Ms`);
  }
  if (risk === "critical" && value.flowClass === "operator-background-read") {
    violations.push(`${entryLabel}: critical routes cannot use operator-background-read freshness flow class`);
  }
}

function validateMutationStrategyProof(entryLabel, entry, indexes, violations) {
  const proof = isPlainObject(entry.proof) ? entry.proof : {};
  const destination = isPlainObject(entry.visibleDestination) ? entry.visibleDestination : {};

  if (entry.strategy === "fresh-read") {
    validateMutationFreshReadProof({
      entryLabel,
      entry,
      indexes,
      violations,
    });
    return;
  }

  if (entry.strategy === "optimistic-with-correction") {
    if (!isNonEmptyString(destination.description)) {
      violations.push(`${entryLabel}: optimistic-with-correction requires visibleDestination.description`);
    }
    if (!isNonEmptyString(proof.correction)) {
      violations.push(`${entryLabel}: optimistic-with-correction requires proof.correction`);
    }
    if (!isNonEmptyStringArray(proof.tests)) {
      violations.push(`${entryLabel}: optimistic-with-correction requires proof.tests`);
    }
    return;
  }

  if (entry.strategy === "realtime-correction") {
    if (!isNonEmptyString(destination.description)) {
      violations.push(`${entryLabel}: realtime-correction requires visibleDestination.description`);
    }
    if (!isNonEmptyString(proof.fallback)) {
      violations.push(`${entryLabel}: realtime-correction requires proof.fallback`);
    }
    if (!isNonEmptyStringArray(proof.tests)) {
      violations.push(`${entryLabel}: realtime-correction requires proof.tests`);
    }
    return;
  }

  if (entry.strategy === "snapshot-return") {
    if (!isNonEmptyString(destination.description)) {
      violations.push(`${entryLabel}: snapshot-return requires visibleDestination.description`);
    }
    if (!isNonEmptyString(proof.authoritativeResponse)) {
      violations.push(`${entryLabel}: snapshot-return requires proof.authoritativeResponse`);
    }
    if (!isNonEmptyStringArray(proof.tests)) {
      violations.push(`${entryLabel}: snapshot-return requires proof.tests`);
    }
    return;
  }

  if (mutationExceptionStrategies.has(entry.strategy)) {
    validateMutationException(entryLabel, entry, violations);
  }
}

function validateMutationBaselineFreeze(options) {
  const { baseline, frozenBaselineSurfaces, violations } = options;
  for (const surfaceId of baseline.keys()) {
    if (!frozenBaselineSurfaces.has(surfaceId)) {
      violations.push(
        `scripts/check-structure/mutation-consistency-baseline.json: mutation baseline surface '${surfaceId}' is not in the frozen #1809 baseline; classify the surface in mutationConsistencyInventory instead of adding migration debt`,
      );
    }
  }
}

function validateMutationConsistencyInventory(options) {
  const { repoRoot, contextManifests, mutationSurfaces, indexes, violations, frozenBaselineSurfaces } = options;
  const declarations = collectMutationConsistencyDeclarations(contextManifests);
  const readAfterWriteEntries = routeInventoryEntries(contextManifests);
  const baseline = collectBaselineMutationSurfaces(repoRoot);
  const declaredSurfaceIds = new Set();
  const declarationBySurfaceId = new Map();
  const surfaceIds = new Set(mutationSurfaces.map((surface) => surface.id));
  const reportRows = [];

  validateMutationBaselineFreeze({
    baseline,
    frozenBaselineSurfaces,
    violations,
  });

  for (const { context, entry, index } of declarations) {
    const entryLabel = `${context.root}/context.json mutationConsistencyInventory[${index}]`;
    if (!isPlainObject(entry)) {
      violations.push(`${entryLabel}: entry must be an object`);
      continue;
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
    if (!supportedMutationStrategies.has(entry.strategy)) {
      violations.push(`${entryLabel}: strategy must be one of ${[...supportedMutationStrategies].sort().join(", ")}`);
    }
    if (!isNonEmptyStringArray(entry.surfaces)) {
      violations.push(`${entryLabel}: surfaces must be a non-empty string array of discovered mutation surface ids`);
      continue;
    }

    for (const surfaceId of entry.surfaces) {
      if (!surfaceIds.has(surfaceId)) {
        violations.push(`${entryLabel}: surface '${surfaceId}' was not discovered by the mutation inventory scanner`);
      }
      declaredSurfaceIds.add(surfaceId);
      declarationBySurfaceId.set(surfaceId, entry);
    }

    validateMutationStrategyProof(entryLabel, entry, indexes, violations);
  }

  for (const surface of mutationSurfaces) {
    const declaration = declarationBySurfaceId.get(surface.id);
    const baselineEntry = baseline.get(surface.id);
    if (!declaration && !baselineEntry) {
      violations.push(
        `${surface.location}: mutating ${surface.kind} is unclassified; add mutationConsistencyInventory with strategy proof`,
      );
    }

    const visibleDestination = declaration?.visibleDestination;
    if (
      declaration?.strategy === "fresh-read" &&
      surface.kind === "route-action" &&
      hasProjectionBackedMutationDestination(visibleDestination) &&
      !hasDeclaredFreshReadReceiptSource({
        entries: readAfterWriteEntries,
        sourceRouteIds: surface.routeIds,
        visibleDestination,
      })
    ) {
      const sourceRouteLabel = surface.routeIds.join(", ") || "unmapped-route";
      violations.push(
        `${surface.location}: fresh-read route action '${sourceRouteLabel}' redirects to projection-backed destination '${visibleDestination.apiContextName}.${visibleDestination.apiRoutePath}' without a declared afterWrite receipt source; use navigateAfterWrite or appendFreshWriteToken on the redirect/redirectDocument and cover it in readAfterWriteRouteInventory, or classify the mutation with a non-fresh-read mutationConsistencyInventory strategy and proof. See docs/architecture/read-after-write-route-author-checklist.md`,
      );
    }

    reportRows.push({
      ...surface,
      owner: declaration?.owner ?? baselineEntry?.owner ?? surface.contextName,
      risk: declaration?.risk ?? "unclassified",
      strategy: declaration?.strategy ?? (baselineEntry ? "migration" : "unclassified"),
      recommendedStrategy: declaration?.strategy ?? recommendedStrategyForSurface(surface),
      visibleDestination:
        declaration?.visibleDestination?.routeId ??
        declaration?.visibleDestination?.routePath ??
        declaration?.visibleDestination?.description ??
        "unknown",
      dependencies: [
        ...(declaration?.visibleDestination?.readModelTables ?? []),
        ...(declaration?.visibleDestination?.projectionDependencies ?? []),
      ],
      issueOrException:
        declaration?.exception?.issue ??
        declaration?.exception?.status ??
        baselineEntry?.issue ??
        (declaration ? "classified" : "missing classification"),
    });
  }

  for (const surfaceId of baseline.keys()) {
    if (!surfaceIds.has(surfaceId)) {
      violations.push(
        `scripts/check-structure/mutation-consistency-baseline.json: stale mutation baseline surface '${surfaceId}' was not discovered`,
      );
    }
  }

  return reportRows.sort((left, right) => left.id.localeCompare(right.id));
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

    validatePostWriteHandoffDeclarations({
      entryLabel,
      sectionName,
      section,
      violations,
    });

    if ("transientRecovery" in section) {
      validateTransientRecoveryDeclaration({
        entryLabel,
        fieldPath: `${sectionName}.transientRecovery`,
        value: section.transientRecovery,
        violations,
      });
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
    if (entry.exception.status === "accepted" && !isNonEmptyString(entry.exception.issue)) {
      violations.push(`${entryLabel}: accepted exceptions must reference a current remediation issue`);
    }
    return entry;
  }

  validateFreshnessSloDeclaration({
    entryLabel,
    risk: entry.risk,
    value: entry.freshnessSlo,
    violations,
  });

  const destination = isPlainObject(entry.destination) ? entry.destination : {};
  if (destination.transientRecovery === undefined) {
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

  validateInventoryFreshnessDependencies({
    entryLabel,
    sectionLabel: "destination",
    section: destination,
    freshnessRoute,
    targetContextName: destination.apiContextName,
    projectionGroupsByContext,
    tableOwnersByContext,
    violations,
  });

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
  const {
    repoRoot,
    contextManifests,
    reportOutputPath = "artifacts/read-after-write-route-inventory.md",
    frozenBaselineSurfaces = frozenMutationConsistencyBaselineSurfaces,
  } = options;
  const indexes = collectReadAfterWriteRouteIndexes(contextManifests);
  const helperUsages = await collectFreshWriteHelperUsage({ repoRoot, contextManifests });
  const rawPostWriteHandoffMetadataUsages = await collectRawPostWriteHandoffMetadataUsage({ repoRoot });
  const mutationSurfaces = await collectMutationConsistencySurfaces({ repoRoot, contextManifests });
  const { helpersUsedByFile, helpersUsedByRoute } = collectHelperUsageIndexes(helperUsages);
  const violations = [];
  const warnings = [];
  const entries = routeInventoryEntries(contextManifests);
  const entryIds = new Set();
  const helperCoverageByRoute = new Map();
  const helperCoverageByFile = new Map();
  const freshnessRoutesCovered = new Set();
  const reportEntries = [];

  for (const file of rawPostWriteHandoffMetadataUsages) {
    violations.push(
      `${file}: raw postWriteHandoff query metadata is not allowed; use appendPostWriteHandoff or appendPostWriteHandoffFromSources`,
    );
  }

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

    // Inverse of the helper-usage scan: recovery/wait behavior claimed by the
    // inventory must exist in production route modules, so the inventory
    // cannot promise loader recovery (for example loadFreshlyWrittenResource)
    // that the route never implements.
    validateHelperUseClaims({
      entry: validatedEntry,
      entryLabel,
      helpersUsedByFile,
      helpersUsedByRoute,
      routesById: indexes.routesById,
      violations,
    });

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
      flowClass: validatedEntry.freshnessSlo?.flowClass ?? "(exception)",
      freshnessSlo: formatFreshnessSlo(validatedEntry.freshnessSlo),
      sourceRoute: sectionRouteIds(validatedEntry.source).join(", ") || "(missing source)",
      destinationRoute: sectionRouteIds(validatedEntry.destination).join(", ") || "(missing destination)",
      apiRoute: validatedEntry.destination?.apiContextName
        ? `${validatedEntry.destination.apiContextName}${validatedEntry.destination.apiRoutePath ?? ""}`
        : "(exception)",
      dependencies: [
        ...(validatedEntry.destination?.readModelTables ?? []),
        ...(validatedEntry.destination?.projectionDependencies ?? []),
      ],
      transientRecovery: postWriteRecoveryKinds(validatedEntry.destination?.transientRecovery) ?? [],
      transientRecoveryBehavior: postWriteRecoveryBehavior(validatedEntry.destination?.transientRecovery),
      exception: validatedEntry.exception
        ? `${validatedEntry.exception.status ?? "exception"}${validatedEntry.exception.issue ? ` ${validatedEntry.exception.issue}` : ""}`
        : "",
    });
  }

  for (const usage of helperUsages) {
    if (usage.routeIds.length === 0) {
      const coveredHelpers = helperCoverageByFile.get(usage.file) ?? new Set();
      const missingHelpers = usage.helpers.filter(
        (helper) => !routeRuntimeContractHelperNames.has(helper) && !helperUsageIsCovered(helper, coveredHelpers),
      );
      if (missingHelpers.length > 0) {
        violations.push(
          `${usage.file}: fresh-write helper(s) ${missingHelpers.join(", ")} must map to a manifest route contribution or file-level inventory exception`,
        );
      }
      continue;
    }

    for (const routeId of usage.routeIds) {
      const coveredHelpers = helperCoverageByRoute.get(routeId) ?? new Set();
      const fileCoveredHelpers = helperCoverageByFile.get(usage.file) ?? new Set();
      const missingHelpers = usage.helpers.filter(
        (helper) =>
          !routeRuntimeContractHelperNames.has(helper) &&
          !helperUsageIsCovered(helper, coveredHelpers) &&
          !helperUsageIsCovered(helper, fileCoveredHelpers),
      );
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

  const mutationRows = validateMutationConsistencyInventory({
    repoRoot,
    contextManifests,
    mutationSurfaces,
    indexes,
    violations,
    frozenBaselineSurfaces,
  });

  writeReadAfterWriteRouteInventoryReport({
    repoRoot,
    outputPath: reportOutputPath,
    entries: reportEntries,
    helperUsages,
    mutationRows,
    violations,
    warnings,
  });

  return {
    ok: violations.length === 0,
    helperUsages,
    mutationRows,
    mutationSurfaces,
    reportEntries,
    violations,
    warnings,
  };
}

export function writeReadAfterWriteRouteInventoryReport(options) {
  const { repoRoot, outputPath, entries, helperUsages, mutationRows = [], violations, warnings } = options;
  const absoluteOutputPath = path.resolve(repoRoot, outputPath);
  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  const lines = [
    "# Post-Write Mutation Consistency Inventory",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Fresh-Write Routes",
    "",
    "| Context | Inventory ID | Risk | Flow class | Freshness SLO | Owner | Source route | Destination route | API route | Dependencies | Recovery / exception |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of entries.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `| ${markdownCell(entry.contextName)} | ${markdownCell(entry.id)} | ${markdownCell(entry.risk)} | ${markdownCell(entry.flowClass)} | ${markdownCell(entry.freshnessSlo)} | ${markdownCell(entry.owner)} | ${markdownCell(entry.sourceRoute)} | ${markdownCell(entry.destinationRoute)} | ${markdownCell(entry.apiRoute)} | ${markdownCell(formatValues(entry.dependencies))} | ${markdownCell(entry.exception || `${formatValues(entry.transientRecovery)}: ${entry.transientRecoveryBehavior}`)} |`,
    );
  }

  const auditGroups = new Map();
  for (const row of mutationRows) {
    const key = [row.contextName, row.kind, row.strategy, row.issueOrException, row.recommendedStrategy].join("|");
    const group = auditGroups.get(key) ?? {
      contextName: row.contextName,
      kind: row.kind,
      strategy: row.strategy,
      issueOrException: row.issueOrException,
      recommendedStrategy: row.recommendedStrategy,
      count: 0,
      examples: [],
    };
    group.count += 1;
    if (group.examples.length < 3) {
      group.examples.push(row.location);
    }
    auditGroups.set(key, group);
  }

  lines.push(
    "",
    "## Audit Summary",
    "",
    "| Context | Failure class | Count | Current classification | Recommended strategy | Issue / exception | Example surfaces |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
  );
  for (const group of [...auditGroups.values()].sort((left, right) => {
    const contextCompare = left.contextName.localeCompare(right.contextName);
    if (contextCompare !== 0) {
      return contextCompare;
    }
    return left.kind.localeCompare(right.kind);
  })) {
    lines.push(
      `| ${markdownCell(group.contextName)} | ${markdownCell(group.kind)} | ${group.count} | ${markdownCell(group.strategy)} | ${markdownCell(group.recommendedStrategy)} | ${markdownCell(group.issueOrException)} | ${markdownCell(group.examples.join("; "))} |`,
    );
  }

  lines.push(
    "",
    "## Mutation Surfaces",
    "",
    "| Context | Surface ID | Kind | Owner | Risk | Strategy | Recommended strategy | Route IDs | Visible destination | Dependencies | Issue / exception |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of mutationRows) {
    lines.push(
      `| ${markdownCell(row.contextName)} | ${markdownCell(row.id)} | ${markdownCell(row.kind)} | ${markdownCell(row.owner)} | ${markdownCell(row.risk)} | ${markdownCell(row.strategy)} | ${markdownCell(row.recommendedStrategy)} | ${markdownCell(formatValues(row.routeIds))} | ${markdownCell(row.visibleDestination)} | ${markdownCell(formatValues(row.dependencies))} | ${markdownCell(row.issueOrException)} |`,
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
