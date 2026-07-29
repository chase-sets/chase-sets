import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  reportStructureCheckResults,
  runImportBoundaryValidation,
  runManifestValidation,
  writeStructureMetricsReport,
} from "./phases.mjs";
import { checkWorkspaceTsconfigExtends } from "../check-workspace-tsconfig-extends.mjs";
import { checkDesignSystemDeadExports } from "../check-design-system-dead-exports.mjs";
import {
  findAccountCapabilityLanguageViolations,
  isAccountCapabilityLanguageGuardedFile,
} from "./account-capability-language.mjs";
import {
  findSoftwareDeliveryConceptViolations,
  isSoftwareDeliveryConceptGuardedFile,
} from "./software-delivery-concepts.mjs";
import { findBusinessLiteralGuardViolations, isBusinessLiteralGuardedFile } from "./business-literal-guard.mjs";
import { validateCrossContextFallbackInventory } from "./cross-context-fallback-inventory.mjs";
import { validateCrossContextReadInventory } from "./cross-context-read-inventory.mjs";
import { validateGlossaryCoverage } from "./glossary-coverage.mjs";
import { validateIaRegistry } from "./ia-registry-guard.mjs";
import { validateReadAfterWriteRouteInventory } from "./read-after-write-inventory.mjs";
import { validateServerBarrelReactFree } from "./server-barrel-react-free.mjs";
import { findBootSchemaDdlDisciplineViolations } from "./boot-schema-ddl-discipline.mjs";
import { validateRetentionSweepCoverage } from "./retention-sweep-coverage.mjs";
import { validateBrowserE2eDisclosureGuard } from "./browser-e2e-disclosure-guard.mjs";
import { validateResponsiveEvidenceGuard } from "./responsive-evidence-guard.mjs";
import { validatePublicPolicyPosture } from "./public-policy-posture.mjs";
import { validatePolicyValueDiscriminantChokepoint } from "./policy-value-discriminant-chokepoint.mjs";
import { findGitKeySetTripwireViolations } from "./catalog-localization-keyset-tripwire.mjs";
import { validateLostUpdateWriteGuard } from "./lost-update-write-guard.mjs";
import { validateAuthoritativeStreamReadInventory } from "./authoritative-stream-read-inventory.mjs";
import { validateProviderScopePickerShapeGuard } from "./provider-scope-picker-shape-guard.mjs";
import { runSqlExecutionSurfaceGuard } from "./sql-execution-surface.mjs";
import { listWorkspacePackages, repoRoot, workspaceRoots } from "../lib/repo.mjs";
import { defaultSkippedDirectories } from "../lib/files.mjs";

const roots = workspaceRoots;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const moduleFileExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const ignoredDirectories = defaultSkippedDirectories;
const allowedTopLevelDirectories = new Set([
  "artifacts",
  "bounded-contexts",
  "contracts",
  "deployables",
  "docs",
  "infrastructure",
  "node_modules",
  "packages",
  "scripts",
  "secure",
]);
const forbiddenBoundedContextDirectoryNames = new Set(["infrastructure", "shared"]);
const nonSupportSuffixDirectoryExceptions = new Set(["tests"]);
const supportDirectoryNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-support$/;
const forbiddenUmbrellaSliceNames = new Set(["authoring", "customer", "items"]);
const retiredPanelDrawerNames = [
  "CommerceDrawer",
  "FilterDrawer",
  "MarketplaceFilterDrawer",
  "MarketplaceMobileFilterDrawer",
  "NotificationCenterDrawer",
];
const retiredPanelDrawerPattern = new RegExp(`\\b(?:${retiredPanelDrawerNames.join("|")})\\b`);
const directoryIntentAllowedFields = new Set([
  "classification",
  "crossCuttingRuntimeComposition",
  "expectedConsumers",
  "purpose",
]);
const intentPlaceholderGuardFields = ["purpose"];
const placeholderFieldTokens = new Set([
  "bd",
  "fixme",
  "misc",
  "na",
  "n/a",
  "none",
  "placeholder",
  "temp",
  "temporary",
  "tbd",
  "todo",
  "unknown",
]);
const crossCuttingRuntimeCompositionSupportDirectories = new Set(["auth-support", "request-support", "seed-support"]);
const legacyForbiddenPaths = [
  "bounded-contexts/experience",
  "bounded-contexts/insights",
  "bounded-contexts/reputation",
  "bounded-contexts/support",
  "bounded-contexts/tax",
  "bounded-contexts/catalog/authoring/package.json",
  "bounded-contexts/catalog/authoring/api",
  "contracts/notifications",
  "contracts/dev-seeds",
  "contracts/event-core/postgres",
  "contracts/sellable-units",
  "deployables/admin-support-api",
  "deployables/admin-support-worker",
  "deployables/catalog-admin",
  "deployables/catalog-api",
  "deployables/identity-admin",
  "deployables/identity-api",
  "deployables/inventory-api",
  "deployables/marketplace-api",
  "deployables/platform-ingress",
  "scripts/deployable-api-mount-support.mjs",
  "scripts/deployable-lifecycle-support.mjs",
  "scripts/deployable-route-support.mjs",
  "scripts/deployable-runtime-support.mjs",
  "scripts/deployable-shell-support.mjs",
  "scripts/generate-deployable-api-mounts.mjs",
  "scripts/generate-deployable-lifecycles.mjs",
  "scripts/generate-deployable-routes.mjs",
  "scripts/generate-deployable-runtimes.mjs",
  "scripts/generate-deployable-shells.mjs",
];
const nonPackageWorkspaceDirectoryExceptions = new Set([
  "infrastructure/digitalocean",
  "infrastructure/helm",
  "infrastructure/remote-dev",
]);
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
  "seedRequirements",
  "hostPorts",
  "apiDeployables",
  "apiRuntimeProfiles",
  "apiMounts",
  "workerRuntimeProfiles",
  "deployableContributions",
  "shellContributions",
  "directoryIntent",
];
const knownDeployables = new Set(["admin-web", "marketplace-web", "public-web"]);
const knownApiDeployables = new Set(["platform-api"]);
const knownLifecycleDeployables = new Set(["platform-api", "platform-worker"]);
const knownRuntimeDeployables = new Set(["platform-worker"]);
const knownShellDeployables = new Set(["admin-web", "marketplace-web"]);
const knownShellDeployableSlots = new Map([
  ["admin-web", new Set(["primary-nav"])],
  ["marketplace-web", new Set(["top-nav", "bottom-nav"])],
]);
const deployableRouteTests = /\.test\.(ts|tsx)$/;
const domainFacingImportHeuristic =
  /(?:^|\/)(?:domain|domains|query|queries|projection|projections|read-model|read-models|projector|projectors)(?:\/|$)/;
const contractsForbiddenImports = /^(react($|\/)|react-dom($|\/)|react-router($|\/)|@react-router\/|hono($|\/))/;
const retiredIntegrationSurfaceImportPattern = /["']@chase-sets\/[^/"'\s]+\/integration(?:\/[^"']*)?["']/;
const forbiddenRootSurfaceReexports =
  /export\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']\.\/(?:client|server|web|seed-support(?:\/[^"']+)?)["']/;
const boundedContextSurfaceFiles = new Set(["client.ts", "server.ts", "web.ts"]);
const canonicalBoundedContextRootFiles = new Set([
  "README.md",
  "GLOSSARY.md",
  "api.ts",
  "client.ts",
  "context.json",
  "ids.ts",
  "index.ts",
  "package.json",
  "server.ts",
  "web.ts",
]);
const allowedFeatureSubdirectories = new Set(["api", "domain", "integrations", "read-model", "tests", "ui"]);
const singleSliceSupportFileAllowlist = [
  // Temporary migration exceptions: remove entries once each file is relocated into its owning slice.
  // {
  //   file: "bounded-contexts/<context>/<support-directory>/<file>.ts",
  //   owner: "@team-handle",
  //   removeBy: "YYYY-MM-DD",
  // },
];
const singleSliceSupportFileAllowlistByFile = new Map(
  singleSliceSupportFileAllowlist.map((entry) => [entry.file, entry]),
);
const singleSliceSupportEnforcementMode =
  process.env.STRUCTURE_SINGLE_SLICE_SUPPORT_ENFORCEMENT === "violation" ? "violation" : "warn";
const temporarySingleSliceSupportDebtFlag = process.env.STRUCTURE_ALLOW_TEMPORARY_SINGLE_SLICE_SUPPORT_DEBT === "true";
const temporarySingleSliceSupportDebtLabel =
  process.env.STRUCTURE_TEMPORARY_SINGLE_SLICE_SUPPORT_DEBT_LABEL ?? "structure-temporary-debt";
const structureMetricsOutputPath = process.env.STRUCTURE_METRICS_OUTPUT_PATH ?? "artifacts/structure-metrics.json";
const violations = [];
const warnings = [];
const lostUpdateWriteGuard = await validateLostUpdateWriteGuard({ repoRoot });
violations.push(...lostUpdateWriteGuard.violations);
const authoritativeStreamReadInventory = await validateAuthoritativeStreamReadInventory({ repoRoot });
violations.push(...authoritativeStreamReadInventory.violations);
const providerScopePickerShapeGuard = await validateProviderScopePickerShapeGuard({ repoRoot });
violations.push(...providerScopePickerShapeGuard.violations);
const clientSurfaceConsumers = new Map();
const supportFileConsumers = new Map();
const crossContextSqlReadGuards = [
  { tableName: "identity_accounts", ownerContextName: "identity" },
  { tableName: "inventory_catalog_items", ownerContextName: "inventory" },
  { tableName: "inventory_items", ownerContextName: "inventory" },
  { tableName: "inventory_holds", ownerContextName: "inventory" },
  { tableName: "inventory_storage_locations", ownerContextName: "inventory" },
  { tableName: "ordering_order_pages", ownerContextName: "ordering" },
  { tableName: "ordering_order_line_pages", ownerContextName: "ordering" },
  { tableName: "fulfillment_shipment_pages", ownerContextName: "fulfillment" },
].map((entry) => ({
  ...entry,
  pattern: new RegExp(
    `(?:from|join|into|update|references)\\s+${entry.tableName}\\b|delete\\s+from\\s+${entry.tableName}\\b|to_regclass\\(\\s*['"]public\\.${entry.tableName}['"]\\s*\\)`,
    "i",
  ),
}));
function normalizeRelative(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function addViolation(file, message) {
  violations.push(`${normalizeRelative(file)}: ${message}`);
}

function addPathViolation(relativePath, message) {
  violations.push(`${relativePath}: ${message}`);
}

function addPathWarning(relativePath, message) {
  warnings.push(`${relativePath}: ${message}`);
}

function recordClientSurfaceConsumer(packageName, relativeFile) {
  const consumers = clientSurfaceConsumers.get(packageName) ?? new Set();
  consumers.add(relativeFile);
  clientSurfaceConsumers.set(packageName, consumers);
}

function classifyContextTopLevelSegment(context, relativePath) {
  const remainder = relativePath.slice(`${context.root}/`.length);
  const [segment, nestedSegment] = remainder.split("/");
  if (!segment) {
    return null;
  }

  if (
    segment === "features" &&
    nestedSegment &&
    context.manifest.directoryIntent?.[nestedSegment]?.classification === "slice"
  ) {
    return { kind: "slice", name: nestedSegment };
  }

  if (
    segment === "support" &&
    nestedSegment &&
    context.manifest.directoryIntent?.[nestedSegment]?.classification === "support"
  ) {
    return { kind: "support", name: nestedSegment };
  }

  if (segment === "routes") {
    return { kind: "routes", name: "routes" };
  }

  const declaredIntent = context.manifest.directoryIntent?.[segment];
  if (declaredIntent) {
    return { kind: declaredIntent.classification, name: segment };
  }

  return { kind: "other", name: segment };
}

function recordSupportFileConsumer(importerContext, importerRelativeFile, resolvedSpecifier) {
  if (!resolvedSpecifier?.startsWith(`${importerContext.root}/`)) {
    return;
  }

  const importerSegment = classifyContextTopLevelSegment(importerContext, importerRelativeFile);
  if (!importerSegment || importerSegment.kind !== "slice") {
    return;
  }

  const importedSegment = classifyContextTopLevelSegment(importerContext, resolvedSpecifier);
  if (!importedSegment || importedSegment.kind !== "support") {
    return;
  }

  const usageRecord = supportFileConsumers.get(resolvedSpecifier) ?? {
    contextRoot: importerContext.root,
    supportDirectory: importedSegment.name,
    consumerSlices: new Set(),
  };
  usageRecord.consumerSlices.add(importerSegment.name);
  supportFileConsumers.set(resolvedSpecifier, usageRecord);
}

function formatSetValues(values) {
  return [...values].sort().join(", ") || "none";
}

function setsAreEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function readGitHubPullRequestLabels() {
  if (!process.env.GITHUB_EVENT_PATH || !existsSync(process.env.GITHUB_EVENT_PATH)) {
    return [];
  }

  try {
    const eventPayload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    return (eventPayload.pull_request?.labels ?? [])
      .map((label) => label?.name)
      .filter((label) => typeof label === "string");
  } catch {
    return [];
  }
}

function isValidIsoDate(value) {
  return /^\\d{4}-\\d{2}-\\d{2}$/.test(value);
}

function normalizeIntentFieldValue(value) {
  return value.trim().toLowerCase();
}

function splitIntentFieldTokens(value) {
  return normalizeIntentFieldValue(value)
    .split(/[^a-z0-9/.-]+/)
    .filter(Boolean);
}

function containsPlaceholderToken(value) {
  const normalized = normalizeIntentFieldValue(value);
  if (placeholderFieldTokens.has(normalized)) {
    return true;
  }

  const tokens = splitIntentFieldTokens(value);
  return tokens.some((token) => placeholderFieldTokens.has(token));
}

function collectSpecificityTerms(manifest) {
  return new Set(
    [manifest.contextName, ...(manifest.ownedNouns ?? []), ...(manifest.slices ?? [])]
      .filter((term) => typeof term === "string")
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= 3),
  );
}

function hasSpecificityTerm(value, specificityTerms) {
  const normalizedValue = normalizeIntentFieldValue(value);
  for (const term of specificityTerms) {
    if (normalizedValue.includes(term)) {
      return true;
    }
  }

  return false;
}

export function validateDirectoryIntentEntry({ manifest, relativeRoot, directoryName, intent }) {
  const violations = [];
  const warnings = [];
  const intentLabel = `${relativeRoot}/context.json directoryIntent.${directoryName}`;
  const intentFieldPath = (fieldName) => `${relativeRoot}/context.json directoryIntent.${directoryName}.${fieldName}`;
  const addEntryViolation = (path, message) => violations.push({ path, message });
  const addEntryWarning = (path, message) => warnings.push({ path, message });

  if (!isPlainObject(intent)) {
    addEntryViolation(intentLabel, "intent metadata must be an object");
    return { violations, warnings };
  }

  for (const field of Object.keys(intent)) {
    if (!directoryIntentAllowedFields.has(field)) {
      addEntryViolation(
        intentFieldPath(field),
        `field is not part of the directoryIntent schema; allowed fields: ${formatSetValues(directoryIntentAllowedFields)}`,
      );
    }
  }

  if (!isValidDirectoryClassification(intent.classification)) {
    addEntryViolation(intentFieldPath("classification"), "classification must be one of: slice, support, routes");
  }

  if (typeof intent.purpose !== "string" || intent.purpose.trim().length === 0) {
    addEntryViolation(intentFieldPath("purpose"), "purpose must be a non-empty string");
  }

  if (!isStringArray(intent.expectedConsumers) || intent.expectedConsumers.length === 0) {
    addEntryViolation(intentFieldPath("expectedConsumers"), "expectedConsumers must be a non-empty array of strings");
  }

  if (Array.isArray(intent.expectedConsumers)) {
    const uniqueExpectedConsumers = new Set(intent.expectedConsumers);
    if (uniqueExpectedConsumers.size !== intent.expectedConsumers.length) {
      addEntryViolation(intentFieldPath("expectedConsumers"), "expectedConsumers must not contain duplicates");
    }
  }

  for (const field of intentPlaceholderGuardFields) {
    if (typeof intent[field] !== "string" || intent[field].trim().length === 0) {
      continue;
    }

    if (containsPlaceholderToken(intent[field])) {
      addEntryViolation(
        intentFieldPath(field),
        `must not use placeholder values (forbidden tokens: ${formatSetValues(placeholderFieldTokens)})`,
      );
    }
  }

  const specificityTerms = collectSpecificityTerms(manifest);
  if (typeof intent.purpose === "string" && intent.purpose.trim().length > 0) {
    if (!hasSpecificityTerm(intent.purpose, specificityTerms)) {
      addEntryWarning(
        intentFieldPath("purpose"),
        "should reference at least one bounded-context term or slice name from context.json (contextName, ownedNouns, or slices)",
      );
    }
  }

  return { violations, warnings };
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

  return path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), specifier));
}

function classifyRouteOrShellSupportFile(relativeFile) {
  if (relativeFile.includes("/routes/")) {
    return "routes";
  }
  if (relativeFile.includes("/shell-support/")) {
    return "shell-support";
  }
  return null;
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

const retiredFreshnessDroppingForwardingImportMessage =
  "retired freshness-dropping forwarding helper import; use @chase-sets/platform-runtime/http";

export function retiredFreshnessDroppingForwardingImport(relativeFile, specifier) {
  const normalizedSpecifier = specifier.replaceAll("\\", "/").replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  const resolvedSpecifier = resolveRelativeSpecifier(relativeFile, normalizedSpecifier);

  return (
    normalizedSpecifier === "@chase-sets/bounded-context-runtime/http" ||
    resolvedSpecifier === "infrastructure/bounded-context-runtime/http"
  );
}

function stripContextManifestSurfaceExport(content) {
  return content
    .replace(/^\s*export\s+\{\s*default\s+as\s+contextManifest\s*\}\s+from\s+["']\.\/context\.json["'];?\s*$/gm, "")
    .trim();
}

function extractExportedValueNames(content) {
  const names = new Set();

  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
    names.add(match[1]);
  }

  for (const match of content.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_]+)/g)) {
    names.add(match[1]);
  }

  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const entries = match[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      if (entry.startsWith("type ")) {
        continue;
      }

      const aliasMatch = entry.match(/(?:[A-Za-z0-9_]+\s+as\s+)?([A-Za-z0-9_]+)/);
      if (aliasMatch?.[1]) {
        names.add(aliasMatch[1]);
      }
    }
  }

  return names;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBoolean(value) {
  return value === true || value === false;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateEventDeclarationOptions(declaration, declarationLabel) {
  const diagnostics = [];
  const addDiagnostic = (message) => {
    diagnostics.push(`${declarationLabel}: ${message}`);
  };

  if (!isPlainObject(declaration)) {
    return diagnostics;
  }

  if (
    "subscriptionName" in declaration &&
    (typeof declaration.subscriptionName !== "string" || declaration.subscriptionName.trim().length === 0)
  ) {
    addDiagnostic("subscriptionName must be a non-empty string when provided");
  }

  if ("filterToEventTypes" in declaration && !isBoolean(declaration.filterToEventTypes)) {
    addDiagnostic("filterToEventTypes must be a boolean when provided");
  }

  return diagnostics;
}

export function validateProjectionGroupOwnershipReset(projectionGroup, projectionGroupLabel) {
  const diagnostics = [];
  const addDiagnostic = (message) => {
    diagnostics.push(`${projectionGroupLabel}: ${message}`);
  };

  if (
    "handlerKind" in projectionGroup &&
    projectionGroup.handlerKind !== "projection" &&
    projectionGroup.handlerKind !== "reaction"
  ) {
    addDiagnostic("handlerKind must be projection or reaction when provided");
  }

  if ("sideEffectOnly" in projectionGroup && !isBoolean(projectionGroup.sideEffectOnly)) {
    addDiagnostic("sideEffectOnly must be a boolean when provided");
  }

  const handlerKind = projectionGroup.handlerKind ?? "projection";
  const sideEffectOnly = projectionGroup.sideEffectOnly === true;
  if (!isStringArray(projectionGroup.ownedTables)) {
    addDiagnostic("ownedTables must be an array of strings");
  } else if (sideEffectOnly && projectionGroup.ownedTables.length > 0) {
    addDiagnostic("sideEffectOnly projection groups must not declare ownedTables");
  } else if (handlerKind === "projection" && !sideEffectOnly && projectionGroup.ownedTables.length === 0) {
    addDiagnostic("ownedTables must be a non-empty array of strings unless sideEffectOnly is true");
  }

  const supportedResetStrategies = new Set([
    "append-only-no-reset",
    "generation-cutover",
    "replay-only",
    "truncate-owned-tables",
  ]);
  if (!supportedResetStrategies.has(projectionGroup.resetStrategy)) {
    addDiagnostic(
      "resetStrategy must be one of append-only-no-reset, generation-cutover, replay-only, or truncate-owned-tables",
    );
  }
  if (sideEffectOnly && projectionGroup.resetStrategy !== "replay-only") {
    addDiagnostic("sideEffectOnly projection groups must use replay-only resetStrategy");
  }
  if (handlerKind === "reaction" && projectionGroup.resetStrategy !== "replay-only") {
    addDiagnostic("reaction groups must use replay-only resetStrategy");
  }

  if ("requiredDuringBootstrap" in projectionGroup && !isBoolean(projectionGroup.requiredDuringBootstrap)) {
    addDiagnostic("requiredDuringBootstrap must be a boolean when provided");
  }

  return diagnostics;
}

export function validateEventReactionDeclaration(reaction, reactionLabel) {
  const diagnostics = [];
  const addDiagnostic = (message) => {
    diagnostics.push(`${reactionLabel}: ${message}`);
  };

  if (!isPlainObject(reaction)) {
    addDiagnostic("event reaction must be an object");
    return diagnostics;
  }

  diagnostics.push(...validateEventDeclarationOptions(reaction, reactionLabel));

  if (typeof reaction.sourceContextName !== "string" || reaction.sourceContextName.length === 0) {
    addDiagnostic("sourceContextName must be a non-empty string");
  }

  if (typeof reaction.reactionName !== "string" || reaction.reactionName.length === 0) {
    addDiagnostic("reactionName must be a non-empty string");
  }

  if (!Number.isInteger(reaction.subscriptionVersion) || reaction.subscriptionVersion < 1) {
    addDiagnostic("subscriptionVersion must be an integer >= 1");
  }

  if (!isStringArray(reaction.reactionHandlerSetNames) || reaction.reactionHandlerSetNames.length === 0) {
    addDiagnostic("reactionHandlerSetNames must be a non-empty array of strings");
  }

  if (reaction.idempotencyPolicy !== "idempotent-command-dispatch") {
    addDiagnostic("idempotencyPolicy must be idempotent-command-dispatch");
  }

  if (reaction.retryPolicy !== "retry-from-last-checkpoint") {
    addDiagnostic("retryPolicy must be retry-from-last-checkpoint");
  }

  if (reaction.failurePolicy !== "surface-as-reaction-failure") {
    addDiagnostic("failurePolicy must be surface-as-reaction-failure");
  }

  if ("eventTypes" in reaction && !isStringArray(reaction.eventTypes)) {
    addDiagnostic("eventTypes must be an array of strings when provided");
  }

  if ("streamPrefixes" in reaction && !isStringArray(reaction.streamPrefixes)) {
    addDiagnostic("streamPrefixes must be an array of strings when provided");
  }

  if ("order" in reaction && (typeof reaction.order !== "number" || Number.isNaN(reaction.order))) {
    addDiagnostic("order must be a number when provided");
  }

  return diagnostics;
}

function isEventSubscriptionDeclaration(value) {
  return isPlainObject(value);
}

function isAllowedPublicExportName(value) {
  return (
    value === "." ||
    value === "./context" ||
    value === "./client" ||
    value === "./host-config" ||
    value === "./seed-support/*" ||
    value === "./server" ||
    value === "./web" ||
    value === "./routes/*"
  );
}

function isValidDirectoryClassification(value) {
  return value === "slice" || value === "support" || value === "routes";
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

function readRelativeModuleSource(relativeSpecifier) {
  const resolvedPath = resolveExistingModulePath(repoRoot, relativeSpecifier);
  if (!resolvedPath) {
    return null;
  }

  return readFileSync(resolvedPath, "utf8");
}

function stripKnownModuleExtension(relativeFile) {
  for (const extension of moduleFileExtensions) {
    if (relativeFile.endsWith(extension)) {
      return relativeFile.slice(0, -extension.length);
    }
  }

  return relativeFile;
}

function isExportedFromContextServer(supportFile, usageRecord) {
  const serverSource = readRelativeModuleSource(`${usageRecord.contextRoot}/server`);
  if (!serverSource) {
    return false;
  }

  const contextRootPath = path.join(repoRoot, usageRecord.contextRoot);
  for (const specifier of extractImportSpecifiers(serverSource)) {
    const resolvedPath = resolveExistingModulePath(contextRootPath, specifier);
    if (!resolvedPath) {
      continue;
    }

    if (stripKnownModuleExtension(normalizeRelative(resolvedPath)) === supportFile) {
      return true;
    }
  }

  return false;
}

function isRequestSupportAdapter(supportFile, usageRecord, contextManifests) {
  if (usageRecord.supportDirectory !== "request-support") {
    return false;
  }

  const context = contextManifests.get(usageRecord.contextRoot);
  if (!context) {
    return false;
  }

  if (isExportedFromContextServer(supportFile, usageRecord)) {
    return true;
  }

  const source = readRelativeModuleSource(supportFile);
  if (!source) {
    return false;
  }

  return (context.manifest.allowedContextDependencies ?? []).some((packageName) =>
    source.includes(`${packageName}/server`),
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
      addPathViolation(
        `bounded-contexts/${entry.name}/context.json`,
        "implemented context must declare a context manifest",
      );
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
    } else {
      for (const sliceName of manifest.slices) {
        if (forbiddenUmbrellaSliceNames.has(sliceName)) {
          addPathViolation(
            `${relativeRoot}/context.json`,
            `slice names must be concrete capabilities or journeys, not umbrella labels (${sliceName})`,
          );
        }
      }
    }

    if (!isStringArray(manifest.allowedSupportDirectories)) {
      addPathViolation(`${relativeRoot}/context.json`, "allowedSupportDirectories must be an array of strings");
    } else {
      const declaredSlices = new Set(manifest.slices ?? []);
      const seenSupportDirectories = new Set();

      for (const supportDirectory of manifest.allowedSupportDirectories) {
        if (seenSupportDirectories.has(supportDirectory)) {
          addPathViolation(
            `${relativeRoot}/context.json`,
            `allowedSupportDirectories must not contain duplicates (${supportDirectory})`,
          );
        }
        seenSupportDirectories.add(supportDirectory);

        if (declaredSlices.has(supportDirectory)) {
          addPathViolation(
            `${relativeRoot}/context.json`,
            `allowedSupportDirectories entry must not overlap slices (${supportDirectory})`,
          );
        }

        const hasSupportSuffix = supportDirectoryNamePattern.test(supportDirectory);
        if (!hasSupportSuffix && !nonSupportSuffixDirectoryExceptions.has(supportDirectory)) {
          addPathViolation(
            `${relativeRoot}/context.json`,
            `support directories must use *-support naming unless explicitly exempt (tests): ${supportDirectory}`,
          );
        }
      }
    }

    if (!isPlainObject(manifest.directoryIntent)) {
      addPathViolation(`${relativeRoot}/context.json`, "directoryIntent must be an object");
    } else {
      for (const [directoryName, intent] of Object.entries(manifest.directoryIntent)) {
        const diagnostics = validateDirectoryIntentEntry({ manifest, relativeRoot, directoryName, intent });
        for (const violation of diagnostics.violations) {
          addPathViolation(violation.path, violation.message);
        }
        for (const warning of diagnostics.warnings) {
          addPathWarning(warning.path, warning.message);
        }
      }
    }

    if ("plannedSupportDirectories" in manifest && !isStringArray(manifest.plannedSupportDirectories)) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "plannedSupportDirectories must be an array of strings when provided",
      );
    }

    if ("localeCatalogs" in manifest && !isStringArray(manifest.localeCatalogs)) {
      addPathViolation(`${relativeRoot}/context.json`, "localeCatalogs must be an array of strings when provided");
    }

    if (!isStringArray(manifest.publicExports)) {
      addPathViolation(`${relativeRoot}/context.json`, "publicExports must be an array of strings");
    }

    if (!isStringArray(manifest.allowedContextDependencies)) {
      addPathViolation(`${relativeRoot}/context.json`, "allowedContextDependencies must be an array of package names");
    }

    if (!isStringArray(manifest.seedRequirements)) {
      addPathViolation(`${relativeRoot}/context.json`, "seedRequirements must be an array of context names");
    }

    if ("requiredPorts" in manifest) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "requiredPorts is retired; model external runtime dependencies through hostPorts only",
      );
    }

    if ("integrationCapabilities" in manifest) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "integrationCapabilities is retired; use eventSubscriptions, projectionGroups, hostPorts, and ./server surfaces instead",
      );
    }

    if ("apiRequirements" in manifest) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "apiRequirements is retired; use eventSubscriptions, projectionGroups, hostPorts, and ./server surfaces instead",
      );
    }

    if (
      manifest.contextName === "payments" &&
      (!Array.isArray(manifest.eventSubscriptions) ||
        !manifest.eventSubscriptions.some(
          (subscription) =>
            subscription.sourceContextName === "ordering" &&
            subscription.projectionName === "payments-order-input-projection",
        ) ||
        !Array.isArray(manifest.projectionGroups) ||
        !manifest.projectionGroups.some(
          (group) =>
            group.projectionName === "payments-order-input-projection" &&
            Array.isArray(group.sourceContextNames) &&
            group.sourceContextNames.includes("ordering"),
        ))
    ) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "payments must declare an ordering-backed payments-order-input-projection projection group",
      );
    }

    if ("eventSubscriptions" in manifest && !Array.isArray(manifest.eventSubscriptions)) {
      addPathViolation(`${relativeRoot}/context.json`, "eventSubscriptions must be an array when provided");
    }

    if ("eventReactions" in manifest && !Array.isArray(manifest.eventReactions)) {
      addPathViolation(`${relativeRoot}/context.json`, "eventReactions must be an array when provided");
    }

    if ("projectionGroups" in manifest && !Array.isArray(manifest.projectionGroups)) {
      addPathViolation(`${relativeRoot}/context.json`, "projectionGroups must be an array when provided");
    }

    if (
      ((Array.isArray(manifest.eventSubscriptions) && manifest.eventSubscriptions.length > 0) ||
        (Array.isArray(manifest.eventReactions) && manifest.eventReactions.length > 0)) &&
      !Array.isArray(manifest.projectionGroups)
    ) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "contexts with eventSubscriptions or eventReactions must declare projectionGroups",
      );
    }

    if (!Array.isArray(manifest.hostPorts)) {
      addPathViolation(`${relativeRoot}/context.json`, "hostPorts must be an array");
    }

    if (!isStringArray(manifest.apiDeployables)) {
      addPathViolation(`${relativeRoot}/context.json`, "apiDeployables must be an array of deployable names");
    }

    if ("runtimeDeployables" in manifest && !isStringArray(manifest.runtimeDeployables)) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "runtimeDeployables must be an array of deployable names when provided",
      );
    }

    if ("sourceRuntimeDeployables" in manifest && !isStringArray(manifest.sourceRuntimeDeployables)) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "sourceRuntimeDeployables must be an array of deployable names when provided",
      );
    }

    if (!Array.isArray(manifest.apiMounts)) {
      addPathViolation(`${relativeRoot}/context.json`, "apiMounts must be an array");
    }

    if (
      Array.isArray(manifest.apiDeployables) &&
      manifest.apiDeployables.length > 0 &&
      (!Array.isArray(manifest.apiMounts) || manifest.apiMounts.length === 0)
    ) {
      addPathViolation(
        `${relativeRoot}/context.json`,
        "apiMounts must declare at least one API contribution when apiDeployables are configured",
      );
    }

    if (!Array.isArray(manifest.deployableContributions)) {
      addPathViolation(`${relativeRoot}/context.json`, "deployableContributions must be an array");
    }

    if (!Array.isArray(manifest.shellContributions)) {
      addPathViolation(`${relativeRoot}/context.json`, "shellContributions must be an array");
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

export async function findWorkspaceDirectoryManifestViolations(options = {}) {
  const rootDir = options.repoRoot ?? repoRoot;
  const workspaceRootNames = options.workspaceRoots ?? roots;
  const diagnostics = [];

  for (const workspaceRoot of workspaceRootNames) {
    const rootPath = path.join(rootDir, workspaceRoot);
    const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const relativeDirectory = `${workspaceRoot}/${entry.name}`;
      if (legacyForbiddenPaths.includes(relativeDirectory)) {
        diagnostics.push({
          path: relativeDirectory,
          message: "retired workspace directory should not exist",
        });
        continue;
      }

      if (nonPackageWorkspaceDirectoryExceptions.has(relativeDirectory)) {
        continue;
      }

      const directoryPath = path.join(rootPath, entry.name);
      if (!existsSync(path.join(directoryPath, "package.json"))) {
        diagnostics.push({
          path: `${relativeDirectory}/package.json`,
          message: "workspace directory must declare package.json or be added to the retired-path list",
        });
        continue;
      }

      if (workspaceRoot === "bounded-contexts" && !existsSync(path.join(directoryPath, "context.json"))) {
        diagnostics.push({
          path: `${relativeDirectory}/context.json`,
          message: "bounded context workspace directory must declare context.json",
        });
      }
    }
  }

  return diagnostics;
}

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    relativeFile.endsWith(".test.ts") ||
    relativeFile.endsWith(".test.tsx") ||
    relativeFile.endsWith(".test.js") ||
    relativeFile.endsWith(".test.jsx")
  );
}

function isRunnableWorkspaceTestFile(relativeFile) {
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativeFile);
}

function isTypecheckableWorkspaceTestFile(relativeFile) {
  return /\.(?:test|spec)\.tsx?$/.test(relativeFile);
}

function isWebDeployableFile(relativeFile) {
  return /deployables\/(admin-web|marketplace)\//.test(relativeFile);
}

function isApiDeployableFile(relativeFile) {
  return /deployables\/(platform-api|platform-worker)\//.test(relativeFile);
}

function isAllowedDeployableBoundedContextImport(relativeFile, specifier) {
  if (isWebDeployableFile(relativeFile) && !isTestFile(relativeFile)) {
    return /^@chase-sets\/[^/]+\/(context|host-config|web|server|routes\/.+)$/.test(specifier);
  }

  if (isApiDeployableFile(relativeFile) && !isTestFile(relativeFile)) {
    return /^@chase-sets\/[^/]+(?:\/server)?$/.test(specifier);
  }

  return /^@chase-sets\/[^/]+(?:\/(context|host-config|web|server|routes\/.+))?$/.test(specifier);
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

function isFeatureModulePath(relativeFile) {
  return (
    relativeFile.includes("/routes/") ||
    relativeFile.includes("/ui/") ||
    domainFacingImportHeuristic.test(relativeFile) ||
    relativeFile.endsWith("/runtime.ts")
  );
}

function isAllowedServerSurfaceConsumer(relativeFile) {
  return (
    relativeFile.includes("/auth-api/") ||
    relativeFile.includes("/support/api-support/") ||
    relativeFile.includes("/routes/") ||
    relativeFile.includes("/request-support/") ||
    relativeFile.includes("/support/request-support/") ||
    relativeFile.includes("/support/ucp-support/") ||
    relativeFile.includes("/route-support/") ||
    relativeFile.includes("/support/route-support/") ||
    relativeFile.endsWith("/api.ts")
  );
}

const routeAdapterExportPattern =
  /\bexport\s+(?:async\s+)?function\s+(?:loader|action)\b|\bexport\s+const\s+(?:loader|action)\b|\bexport\s*\{[^}]*\b(?:loader|action)\b[^}]*\}/;

export function findRouteSupportPlacementViolation({ relativeFile, content, contextManifest, isTest = false }) {
  if (isTest) {
    return null;
  }

  const match = relativeFile.match(/^bounded-contexts\/[^/]+\/support\/([^/]+)\/.+\.[cm]?[jt]sx?$/);
  if (!match) {
    return null;
  }

  const supportDirectory = match[1];
  if (supportDirectory === "route-support") {
    return null;
  }

  const supportIntent = contextManifest?.directoryIntent?.[supportDirectory];
  if (supportIntent?.crossCuttingRuntimeComposition === true) {
    return null;
  }

  if (!routeAdapterExportPattern.test(content)) {
    return null;
  }

  return `route loader/action modules must live under support/route-support/<route-name>/, not support/${supportDirectory}/`;
}

const catalogAdminMarker = ["catalog", "admin"].join("-");

function resolveAdminWebSection(contextName, fileExportOrKey) {
  if (contextName === "catalog") {
    return "catalog";
  }

  if (contextName === "identity") {
    return "identity";
  }

  return fileExportOrKey?.includes(catalogAdminMarker) ? "catalog" : "identity";
}

function buildManifestHostRouteIdentity(deployable, sourceContext, route) {
  if (deployable !== "admin-web") {
    return {
      routeId: route.routeId,
      routePath: route.routePath,
    };
  }

  const section = resolveAdminWebSection(sourceContext, route.fileExport);
  return {
    routeId: `${section}:${route.routeId}`,
    routePath: `${section}:${route.routeType}:${route.routePath}`,
  };
}

export function validateShellContributionEntries({ manifest, root }) {
  const diagnostics = [];
  const routesByDeployable = new Map(
    (manifest.deployableContributions ?? []).map((contribution) => [
      contribution.deployable,
      contribution.routes ?? [],
    ]),
  );

  function addViolation(path, message) {
    diagnostics.push({ path, message });
  }

  function validateShellContributionNode(contribution, contributionLabel, deployable) {
    if (typeof contribution.key !== "string" || contribution.key.length === 0) {
      addViolation(contributionLabel, "key must be a non-empty string");
    }

    if (typeof contribution.label !== "string" || contribution.label.length === 0) {
      addViolation(contributionLabel, "label must be a non-empty string");
    }

    if (typeof contribution.icon !== "string" || contribution.icon.length === 0) {
      addViolation(contributionLabel, "icon must be a non-empty string");
    }

    const hasChildren = Array.isArray(contribution.children) && contribution.children.length > 0;

    if (
      contribution.href !== undefined &&
      (typeof contribution.href !== "string" || !contribution.href.startsWith("/"))
    ) {
      addViolation(contributionLabel, "href must be an absolute path");
    }

    if (typeof contribution.order !== "number") {
      addViolation(contributionLabel, "order must be a number");
    }

    if (
      contribution.visibility !== "always" &&
      contribution.visibility !== "signed-in" &&
      contribution.visibility !== "signed-out"
    ) {
      addViolation(contributionLabel, "visibility must be 'always', 'signed-in', or 'signed-out'");
    }

    if (!isStringArray(contribution.requiredPermissions)) {
      addViolation(contributionLabel, "requiredPermissions must be an array of strings");
    }

    if (contribution.children !== undefined && !Array.isArray(contribution.children)) {
      addViolation(contributionLabel, "children must be an array when provided");
    }

    if (contribution.href === undefined && !hasChildren) {
      addViolation(contributionLabel, "href is required when children are not provided");
    }

    const normalizedHref = contribution.href?.replace(/^\//, "");
    const ownedRoutes = routesByDeployable.get(deployable) ?? [];
    const hasOwnedRoute =
      normalizedHref === undefined || ownedRoutes.some((route) => route.routePath === normalizedHref);
    if (!hasOwnedRoute) {
      addViolation(
        contributionLabel,
        "shell contributions must point at a same-context route contribution for the target deployable",
      );
    }

    const children = Array.isArray(contribution.children) ? contribution.children : [];
    for (const [childIndex, child] of children.entries()) {
      validateShellContributionNode(child, `${contributionLabel}.children[${childIndex}]`, deployable);
    }
  }

  for (const [index, contribution] of (manifest.shellContributions ?? []).entries()) {
    const contributionLabel = `${root}/context.json shellContributions[${index}]`;

    if (!knownShellDeployables.has(contribution.deployable)) {
      addViolation(contributionLabel, `deployable must be one of ${[...knownShellDeployables].join(", ")}`);
      continue;
    }

    const allowedSlots = knownShellDeployableSlots.get(contribution.deployable) ?? new Set();
    if (!allowedSlots.has(contribution.slot)) {
      addViolation(contributionLabel, `slot must be one of ${[...allowedSlots].sort().join(", ")}`);
    }

    if (
      contribution.placements !== undefined &&
      (!Array.isArray(contribution.placements) || contribution.placements.length === 0)
    ) {
      addViolation(contributionLabel, "placements must be a non-empty array when provided");
    }

    for (const placement of contribution.placements ?? []) {
      if (!allowedSlots.has(placement)) {
        addViolation(contributionLabel, `placements must only use ${[...allowedSlots].sort().join(", ")}`);
      }
    }

    validateShellContributionNode(contribution, contributionLabel, contribution.deployable);
  }

  return diagnostics;
}

export async function runStructureCheck(options = {}) {
  violations.length = 0;
  warnings.length = 0;
  clientSurfaceConsumers.clear();
  supportFileConsumers.clear();

  const sqlExecutionSurface = runSqlExecutionSurfaceGuard({ repoRoot });
  violations.push(...sqlExecutionSurface.violations);

  for (const violation of findGitKeySetTripwireViolations({ repoRoot })) {
    addPathViolation(violation.testPath, violation.message);
  }

  for (const diagnostic of await findWorkspaceDirectoryManifestViolations({ repoRoot })) {
    addPathViolation(diagnostic.path, diagnostic.message);
  }

  const contextManifests = await loadContextManifests();
  const boundedContextPackages = [...contextManifests.values()].map(({ packageName }) => packageName);
  const contextMetricsByRoot = new Map(
    [...contextManifests.values()].map((context) => [
      context.root,
      {
        contextRoot: context.root,
        contextName: context.manifest.contextName,
        sliceCount: Array.isArray(context.manifest.slices) ? context.manifest.slices.length : 0,
        supportDirectoryCount: Array.isArray(context.manifest.allowedSupportDirectories)
          ? context.manifest.allowedSupportDirectories.length
          : 0,
        singleSliceSupportFiles: 0,
        driftCount: 0,
      },
    ]),
  );

  function getContextRoot(relativeFile) {
    for (const root of contextManifests.keys()) {
      if (relativeFile === root || relativeFile.startsWith(`${root}/`)) {
        return root;
      }
    }

    return null;
  }

  function isBoundedContextSpecifier(specifier) {
    return boundedContextPackages.some((packageName) => matchesPackageSpecifier(specifier, packageName));
  }

  function isDeployableSpecifier(specifier) {
    return specifier.includes("deployables/");
  }

  function isInfrastructureSpecifier(specifier) {
    return (
      specifier.includes("infrastructure/") ||
      specifier === "@chase-sets/bounded-context-runtime" ||
      specifier.startsWith("@chase-sets/bounded-context-runtime/") ||
      specifier === "@chase-sets/event-core-postgres" ||
      specifier.startsWith("@chase-sets/event-core-postgres/")
    );
  }

  function isWorkspacePackageSpecifier(specifier) {
    return (
      specifier.includes("packages/") ||
      specifier === "@chase-sets/design-system" ||
      specifier.startsWith("@chase-sets/design-system/")
    );
  }

  async function validateWorkspaceTestScriptCoverage() {
    const rootPackageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const rootScripts = rootPackageJson.scripts ?? {};
    const verifyTypecheckScript = path.join(repoRoot, "scripts", "verify-typecheck.mjs");
    const verifyTypecheckScriptContent = existsSync(verifyTypecheckScript)
      ? readFileSync(verifyTypecheckScript, "utf8")
      : "";
    const hasCentralTestTypecheck =
      typeof rootScripts["test:typecheck"] === "string" &&
      typeof rootScripts["verify:typecheck"] === "string" &&
      (rootScripts["verify:typecheck"].includes("test:typecheck") ||
        (rootScripts["verify:typecheck"].includes("verify-typecheck.mjs") &&
          verifyTypecheckScriptContent.includes("test:typecheck")));

    for (const workspace of listWorkspacePackages({ repoRoot })) {
      const { files } = await walk(workspace.dir);
      const testFiles = files.map(normalizeRelative).filter(isRunnableWorkspaceTestFile);
      if (testFiles.length === 0) {
        continue;
      }

      const scripts = workspace.packageJson.scripts ?? {};
      const hasRunnableTestScript =
        typeof scripts.test === "string" ||
        typeof scripts["test:unit"] === "string" ||
        typeof scripts["test:db"] === "string";
      if (!hasRunnableTestScript) {
        addPathViolation(
          normalizeRelative(workspace.packageJsonPath),
          `workspace has ${testFiles.length} test file(s) but no runnable test script (expected test, test:unit, or test:db)`,
        );
      }

      const typecheckableTestFiles = testFiles.filter(isTypecheckableWorkspaceTestFile);
      if (typecheckableTestFiles.length === 0) {
        continue;
      }

      const hasWorkspaceTypecheck =
        typeof scripts.typecheck === "string" ||
        typeof scripts["test:typecheck"] === "string" ||
        typeof scripts["typecheck:tests"] === "string";
      if (hasCentralTestTypecheck || hasWorkspaceTypecheck) {
        continue;
      }

      addPathViolation(
        normalizeRelative(workspace.packageJsonPath),
        `workspace has ${typecheckableTestFiles.length} TypeScript test file(s) but no test typecheck coverage (expected root test:typecheck in verify:typecheck or a workspace typecheck script)`,
      );
    }
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
    const packageExportKeys = new Set(Object.keys(packageJson.exports ?? {}).filter((key) => key !== "."));

    for (const exportKey of packageExportKeys) {
      if (!declaredPublicExports.has(exportKey)) {
        addPathViolation(
          `${root}/package.json`,
          `package export ${exportKey} must be declared in context.json publicExports`,
        );
      }
    }

    for (const publicExport of manifest.publicExports ?? []) {
      if (!isAllowedPublicExportName(publicExport)) {
        addPathViolation(`${root}/context.json`, `publicExports contains an unsupported surface (${publicExport})`);
      }

      const exportTarget =
        publicExport === "."
          ? (packageJson.exports?.["."] ?? packageJson.exports)
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
          addPathViolation(
            `${root}/package.json`,
            `package export ${publicExport} targets a missing file (${exportTarget})`,
          );
        }
      }
    }

    if ((manifest.deployableContributions?.length ?? 0) > 0 && !(manifest.publicExports ?? []).includes("./routes/*")) {
      addPathViolation(`${root}/context.json`, "contexts with route contributions must export ./routes/* publicly");
    }

    if ((manifest.publicExports ?? []).includes("./integration/*")) {
      addPathViolation(
        `${root}/context.json`,
        "contexts must not export ./integration/*; cross-context access belongs on ./server or through published events",
      );
    }

    for (const diagnostic of validateShellContributionEntries({ manifest, root })) {
      addPathViolation(diagnostic.path, diagnostic.message);
    }

    for (const dependency of manifest.allowedContextDependencies ?? []) {
      if (typeof dependency !== "string" || !dependency.startsWith("@chase-sets/")) {
        addPathViolation(
          `${root}/context.json`,
          `allowedContextDependencies must contain workspace package names (${dependency})`,
        );
      }
    }

    for (const seedRequirement of manifest.seedRequirements ?? []) {
      if (typeof seedRequirement !== "string" || seedRequirement.length === 0) {
        addPathViolation(
          `${root}/context.json`,
          `seedRequirements must contain bounded context names (${seedRequirement})`,
        );
      }
    }

    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      const dependencyContext = [...contextManifests.values()].find(
        (candidate) => candidate.packageName === dependency,
      );

      if (!dependencyContext || dependency === manifest.packageName) {
        continue;
      }

      if (dependency === "@chase-sets/catalog") {
        addPathViolation(
          `${root}/package.json`,
          "non-catalog bounded contexts must not declare a runtime dependency on @chase-sets/catalog; seed fixtures live in @chase-sets/catalog-seed and test-only module mounts belong in devDependencies",
        );
        continue;
      }

      const dependencyContextName = dependencyContext.manifest.contextName;
      const isAllowedDependency =
        (manifest.allowedContextDependencies ?? []).includes(dependency) ||
        (manifest.seedRequirements ?? []).includes(dependencyContextName);

      if (!isAllowedDependency) {
        addPathViolation(
          `${root}/package.json`,
          `bounded-context dependency ${dependency} must be declared through allowedContextDependencies or seedRequirements`,
        );
      }
    }

    for (const deployable of manifest.apiDeployables ?? []) {
      if (!knownApiDeployables.has(deployable)) {
        addPathViolation(
          `${root}/context.json`,
          `apiDeployables must be one of ${[...knownApiDeployables].join(", ")}`,
        );
      }
    }

    for (const deployable of manifest.runtimeDeployables ?? []) {
      if (!knownRuntimeDeployables.has(deployable)) {
        addPathViolation(
          `${root}/context.json`,
          `runtimeDeployables must be one of ${[...knownRuntimeDeployables].join(", ")}`,
        );
      }
    }

    for (const deployable of manifest.sourceRuntimeDeployables ?? []) {
      if (!knownLifecycleDeployables.has(deployable)) {
        addPathViolation(
          `${root}/context.json`,
          `sourceRuntimeDeployables must be one of ${[...knownLifecycleDeployables].join(", ")}`,
        );
      }
    }

    for (const [index, subscription] of (manifest.eventSubscriptions ?? []).entries()) {
      const subscriptionLabel = `${root}/context.json eventSubscriptions[${index}]`;

      if (!isEventSubscriptionDeclaration(subscription)) {
        addPathViolation(subscriptionLabel, "event subscription must be an object");
        continue;
      }

      for (const diagnostic of validateEventDeclarationOptions(subscription, subscriptionLabel)) {
        violations.push(diagnostic);
      }

      if (typeof subscription.sourceContextName !== "string" || subscription.sourceContextName.length === 0) {
        addPathViolation(subscriptionLabel, "sourceContextName must be a non-empty string");
      }

      if (typeof subscription.projectionName !== "string" || subscription.projectionName.length === 0) {
        addPathViolation(subscriptionLabel, "projectionName must be a non-empty string");
      }

      if (!Number.isInteger(subscription.subscriptionVersion) || subscription.subscriptionVersion < 1) {
        addPathViolation(subscriptionLabel, "subscriptionVersion must be an integer >= 1");
      }

      if (
        !isStringArray(subscription.projectionHandlerSetNames) ||
        subscription.projectionHandlerSetNames.length === 0
      ) {
        addPathViolation(subscriptionLabel, "projectionHandlerSetNames must be a non-empty array of strings");
      }

      if ("reactionHandlerSetNames" in subscription) {
        addPathViolation(subscriptionLabel, "reactionHandlerSetNames belongs under eventReactions");
      }

      if ("handlerKind" in subscription && subscription.handlerKind !== "projection") {
        addPathViolation(subscriptionLabel, "eventSubscriptions must declare projection handlers only");
      }

      if ("eventTypes" in subscription && !isStringArray(subscription.eventTypes)) {
        addPathViolation(subscriptionLabel, "eventTypes must be an array of strings when provided");
      }

      if ("streamPrefixes" in subscription && !isStringArray(subscription.streamPrefixes)) {
        addPathViolation(subscriptionLabel, "streamPrefixes must be an array of strings when provided");
      }

      if ("order" in subscription && (typeof subscription.order !== "number" || Number.isNaN(subscription.order))) {
        addPathViolation(subscriptionLabel, "order must be a number when provided");
      }
    }

    for (const [index, reaction] of (manifest.eventReactions ?? []).entries()) {
      const reactionLabel = `${root}/context.json eventReactions[${index}]`;
      const diagnostics = validateEventReactionDeclaration(reaction, reactionLabel);
      for (const diagnostic of diagnostics) {
        violations.push(diagnostic);
      }

      if (!isPlainObject(reaction)) {
        continue;
      }

      if ("projectionHandlerSetNames" in reaction) {
        addPathViolation(reactionLabel, "projectionHandlerSetNames belongs under eventSubscriptions");
      }
    }

    const projectionGroupsByName = new Map();
    for (const [index, projectionGroup] of (manifest.projectionGroups ?? []).entries()) {
      const projectionGroupLabel = `${root}/context.json projectionGroups[${index}]`;

      if (!isPlainObject(projectionGroup)) {
        addPathViolation(projectionGroupLabel, "projection group must be an object");
        continue;
      }

      if (typeof projectionGroup.projectionName !== "string" || projectionGroup.projectionName.length === 0) {
        addPathViolation(projectionGroupLabel, "projectionName must be a non-empty string");
        continue;
      }

      if (projectionGroupsByName.has(projectionGroup.projectionName)) {
        addPathViolation(
          projectionGroupLabel,
          `projectionGroups must not contain duplicate projection names (${projectionGroup.projectionName})`,
        );
        continue;
      }
      projectionGroupsByName.set(projectionGroup.projectionName, projectionGroup);

      if (!isStringArray(projectionGroup.sourceContextNames) || projectionGroup.sourceContextNames.length === 0) {
        addPathViolation(projectionGroupLabel, "sourceContextNames must be a non-empty array of strings");
      }

      for (const diagnostic of validateProjectionGroupOwnershipReset(projectionGroup, projectionGroupLabel)) {
        violations.push(diagnostic);
      }
    }

    const subscribedSourcesByProjection = new Map();
    for (const subscription of manifest.eventSubscriptions ?? []) {
      const projectionName = subscription.projectionName;
      if (typeof projectionName !== "string" || projectionName.length === 0) {
        continue;
      }

      const projectionGroup = projectionGroupsByName.get(projectionName);
      if (!projectionGroup) {
        addPathViolation(
          `${root}/context.json`,
          `eventSubscriptions references undeclared projection group ${projectionName}`,
        );
        continue;
      }
      if ((projectionGroup.handlerKind ?? "projection") !== "projection") {
        addPathViolation(
          `${root}/context.json`,
          `eventSubscriptions references reaction group ${projectionName}; use eventReactions`,
        );
        continue;
      }

      const subscribedSources = subscribedSourcesByProjection.get(projectionName) ?? new Set();
      subscribedSources.add(subscription.sourceContextName);
      subscribedSourcesByProjection.set(projectionName, subscribedSources);
    }

    const subscribedSourcesByReaction = new Map();
    for (const reaction of manifest.eventReactions ?? []) {
      const reactionName = reaction.reactionName;
      if (typeof reactionName !== "string" || reactionName.length === 0) {
        continue;
      }

      const projectionGroup = projectionGroupsByName.get(reactionName);
      if (!projectionGroup) {
        addPathViolation(`${root}/context.json`, `eventReactions references undeclared reaction group ${reactionName}`);
        continue;
      }
      if ((projectionGroup.handlerKind ?? "projection") !== "reaction") {
        addPathViolation(
          `${root}/context.json`,
          `eventReactions references projection group ${reactionName}; mark its projectionGroups entry with handlerKind reaction`,
        );
        continue;
      }

      const subscribedSources = subscribedSourcesByReaction.get(reactionName) ?? new Set();
      subscribedSources.add(reaction.sourceContextName);
      subscribedSourcesByReaction.set(reactionName, subscribedSources);
    }

    for (const [projectionName, subscribedSources] of subscribedSourcesByProjection.entries()) {
      const projectionGroup = projectionGroupsByName.get(projectionName);
      if (!projectionGroup) {
        continue;
      }

      const declaredSources = new Set(projectionGroup.sourceContextNames ?? []);
      if (!setsAreEqual(subscribedSources, declaredSources)) {
        addPathViolation(
          `${root}/context.json`,
          `projection group ${projectionName} sourceContextNames must exactly match subscribed sources; declared [${formatSetValues(declaredSources)}], actual [${formatSetValues(subscribedSources)}]`,
        );
      }
    }

    for (const [reactionName, subscribedSources] of subscribedSourcesByReaction.entries()) {
      const reactionGroup = projectionGroupsByName.get(reactionName);
      if (!reactionGroup) {
        continue;
      }

      const declaredSources = new Set(reactionGroup.sourceContextNames ?? []);
      if (!setsAreEqual(subscribedSources, declaredSources)) {
        addPathViolation(
          `${root}/context.json`,
          `reaction group ${reactionName} sourceContextNames must exactly match subscribed sources; declared [${formatSetValues(declaredSources)}], actual [${formatSetValues(subscribedSources)}]`,
        );
      }
    }

    for (const [index, hostPort] of (manifest.hostPorts ?? []).entries()) {
      const hostPortLabel = `${root}/context.json hostPorts[${index}]`;

      if (!isPlainObject(hostPort)) {
        addPathViolation(hostPortLabel, "host port must be an object");
        continue;
      }

      if (typeof hostPort.portName !== "string" || hostPort.portName.length === 0) {
        addPathViolation(hostPortLabel, "portName must be a non-empty string");
      }

      if (typeof hostPort.providedBy !== "string" || hostPort.providedBy.length === 0) {
        addPathViolation(hostPortLabel, "providedBy must name the context or deployable that supplies the host port");
      }

      if (typeof hostPort.purpose !== "string" || hostPort.purpose.length === 0) {
        addPathViolation(hostPortLabel, "purpose must describe why this host port is required");
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

      if ("readFreshnessRoutes" in mount) {
        if (!Array.isArray(mount.readFreshnessRoutes)) {
          addPathViolation(mountLabel, "readFreshnessRoutes must be an array when provided");
        } else {
          for (const [routeIndex, route] of mount.readFreshnessRoutes.entries()) {
            const routeLabel = `${mountLabel} readFreshnessRoutes[${routeIndex}]`;
            if (!isPlainObject(route)) {
              addPathViolation(routeLabel, "read freshness route must be an object");
              continue;
            }

            if (typeof route.routePath !== "string" || !route.routePath.startsWith("/")) {
              addPathViolation(routeLabel, "routePath must be a mount-relative absolute path");
            }

            if ("methods" in route) {
              const supportedMethods = new Set(["GET", "HEAD"]);
              if (
                !Array.isArray(route.methods) ||
                route.methods.length === 0 ||
                !route.methods.every((method) => supportedMethods.has(method))
              ) {
                addPathViolation(routeLabel, "methods must contain GET and/or HEAD when provided");
              }
            }

            if (!Array.isArray(route.dependencies) || route.dependencies.length === 0) {
              addPathViolation(routeLabel, "dependencies must be a non-empty array");
              continue;
            }

            for (const [dependencyIndex, dependency] of route.dependencies.entries()) {
              const dependencyLabel = `${routeLabel} dependencies[${dependencyIndex}]`;
              if (!isPlainObject(dependency)) {
                addPathViolation(dependencyLabel, "read freshness dependency must be an object");
                continue;
              }

              const hasProjectionName =
                typeof dependency.projectionName === "string" && dependency.projectionName.length > 0;
              const hasReadModelTable =
                typeof dependency.readModelTable === "string" && dependency.readModelTable.length > 0;
              if (hasProjectionName === hasReadModelTable) {
                addPathViolation(dependencyLabel, "declare exactly one of projectionName or readModelTable");
              }

              if ("targetContextName" in dependency && typeof dependency.targetContextName !== "string") {
                addPathViolation(dependencyLabel, "targetContextName must be a string when provided");
              }
            }
          }
        }
      }
    }

    const expectedTopLevelDirectories = new Set(["features", "support", "routes", "tests", "docs"]);
    const declaredDirectoryIntent = manifest.directoryIntent ?? {};
    const declaredDirectoryIntentNames = new Set(Object.keys(declaredDirectoryIntent));

    if (manifest.contextName === "identity") {
      if ((manifest.allowedSupportDirectories ?? []).includes("auth-support")) {
        addPathViolation(
          `${root}/context.json`,
          "Identity must not declare auth-support after Auth ownership extraction",
        );
      }

      if ((manifest.ownedNouns ?? []).includes("session")) {
        addPathViolation(`${root}/context.json`, "Identity must not own session after Auth ownership extraction");
      }

      if ((manifest.slices ?? []).includes("sessions")) {
        addPathViolation(
          `${root}/context.json`,
          "Identity must not declare a sessions slice after Auth ownership extraction",
        );
      }
    }

    if (manifest.contextName === "auth") {
      const requiredOwnedNouns = ["authentication", "session-journey", "account-selection"];
      for (const noun of requiredOwnedNouns) {
        if (!(manifest.ownedNouns ?? []).includes(noun)) {
          addPathViolation(`${root}/context.json`, `Auth must own ${noun}`);
        }
      }
    }

    const rootEntries = await readdir(rootAbs, { withFileTypes: true });
    const topLevelDirectories = new Set(
      rootEntries
        .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
        .map((entry) => entry.name),
    );
    const featureDirectories = new Set(
      (await readdir(path.join(rootAbs, "features"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const supportDirectories = new Set(
      (await readdir(path.join(rootAbs, "support"), { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const allowedSupportDirectories = manifest.allowedSupportDirectories ?? [];
    const plannedSupportDirectories = new Set(manifest.plannedSupportDirectories ?? []);

    for (const supportDirectory of plannedSupportDirectories) {
      if (!allowedSupportDirectories.includes(supportDirectory)) {
        addPathViolation(
          `${root}/context.json`,
          `plannedSupportDirectories must reference declared support directories (${supportDirectory})`,
        );
      }
    }

    for (const supportDirectory of allowedSupportDirectories) {
      if (supportDirectory === "routes") {
        addPathViolation(
          `${root}/context.json`,
          "routes is implicit and must not be declared in allowedSupportDirectories",
        );
      }

      if (supportDirectories.has(supportDirectory)) {
        continue;
      }

      if (!plannedSupportDirectories.has(supportDirectory)) {
        addPathViolation(
          `${root}/context.json`,
          `declared support directory must exist or be listed in plannedSupportDirectories (${supportDirectory})`,
        );
      }
    }

    for (const sliceDirectory of manifest.slices ?? []) {
      const intent = declaredDirectoryIntent[sliceDirectory];
      if (!intent) {
        addPathViolation(`${root}/context.json`, `directoryIntent must define slice metadata (${sliceDirectory})`);
        continue;
      }

      if (intent.classification !== "slice") {
        addPathViolation(`${root}/context.json`, `directoryIntent classification for ${sliceDirectory} must be slice`);
      }

      if (!featureDirectories.has(sliceDirectory)) {
        addPathViolation(
          `${root}/context.json`,
          `declared slice directory must exist under features/ (${sliceDirectory})`,
        );
      }
    }

    for (const supportDirectory of allowedSupportDirectories) {
      const intent = declaredDirectoryIntent[supportDirectory];
      const supportIntentFieldPath = (fieldName) =>
        `${root}/context.json directoryIntent.${supportDirectory}.${fieldName}`;
      if (!intent) {
        addPathViolation(`${root}/context.json`, `directoryIntent must define support metadata (${supportDirectory})`);
        continue;
      }

      if (intent.classification !== "support") {
        addPathViolation(
          `${root}/context.json`,
          `directoryIntent classification for ${supportDirectory} must be support`,
        );
      }

      const expectedConsumers = Array.isArray(intent.expectedConsumers) ? intent.expectedConsumers : [];
      const taggedAsCrossCuttingRuntimeComposition = intent.crossCuttingRuntimeComposition === true;
      if (expectedConsumers.length < 1 && !taggedAsCrossCuttingRuntimeComposition) {
        addPathViolation(
          supportIntentFieldPath("expectedConsumers"),
          "must include at least one expected consumer unless crossCuttingRuntimeComposition is true",
        );
      }

      if (
        taggedAsCrossCuttingRuntimeComposition &&
        !crossCuttingRuntimeCompositionSupportDirectories.has(supportDirectory)
      ) {
        addPathViolation(
          supportIntentFieldPath("crossCuttingRuntimeComposition"),
          `crossCuttingRuntimeComposition is only allowed for: ${formatSetValues(crossCuttingRuntimeCompositionSupportDirectories)}`,
        );
      }
    }

    if (!declaredDirectoryIntent.routes) {
      addPathViolation(`${root}/context.json`, "directoryIntent must define routes metadata");
    } else if (declaredDirectoryIntent.routes.classification !== "routes") {
      addPathViolation(`${root}/context.json`, "directoryIntent classification for routes must be routes");
    }

    for (const [directoryName, intent] of Object.entries(declaredDirectoryIntent)) {
      const expectedClassification = (manifest.slices ?? []).includes(directoryName)
        ? "slice"
        : allowedSupportDirectories.includes(directoryName)
          ? "support"
          : directoryName === "routes"
            ? "routes"
            : null;

      if (!expectedClassification) {
        addPathViolation(
          `${root}/context.json`,
          `directoryIntent entry must reference a declared slice, allowed support directory, or routes (${directoryName})`,
        );
        continue;
      }

      if (intent.classification !== expectedClassification) {
        addPathViolation(
          `${root}/context.json`,
          `directoryIntent classification for ${directoryName} must be ${expectedClassification}`,
        );
      }
    }

    for (const featureDirectory of featureDirectories) {
      if (!(manifest.slices ?? []).includes(featureDirectory)) {
        addPathViolation(`${root}/features/${featureDirectory}`, "feature directory must map to a declared slice");
      }

      const featureEntries = await readdir(path.join(rootAbs, "features", featureDirectory), {
        withFileTypes: true,
      }).catch(() => []);

      for (const entry of featureEntries) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
          continue;
        }

        if (entry.isDirectory() && !allowedFeatureSubdirectories.has(entry.name)) {
          addPathViolation(
            `${root}/features/${featureDirectory}/${entry.name}`,
            "feature subdirectories must be domain, read-model, api, ui, integrations, or tests",
          );
        }

        if (entry.isFile()) {
          addPathViolation(
            `${root}/features/${featureDirectory}/${entry.name}`,
            "feature roots must not contain loose files; place code under domain, read-model, api, ui, integrations, or tests",
          );
        }
      }
    }

    for (const supportDirectory of supportDirectories) {
      if (!allowedSupportDirectories.includes(supportDirectory)) {
        addPathViolation(
          `${root}/support/${supportDirectory}`,
          "support directory must map to an allowed support directory",
        );
      }
    }

    for (const entry of rootEntries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (entry.isDirectory() && entry.name === "integration") {
        addPathViolation(
          `${root}/${entry.name}`,
          "integration directories are retired; use ./server for request-time access and eventSubscriptions for downstream data sharing",
        );
      }

      if (entry.isDirectory() && entry.name === "deployables") {
        continue;
      }

      if (entry.isDirectory() && !expectedTopLevelDirectories.has(entry.name)) {
        addPathViolation(
          `${root}/${entry.name}`,
          "top-level bounded-context directory must be one of features, support, routes, or tests",
        );
      }

      if (
        entry.isDirectory() &&
        entry.name === "features" &&
        (manifest.slices ?? []).length > 0 &&
        featureDirectories.size === 0
      ) {
        addPathViolation(
          `${root}/features`,
          "contexts with declared slices must store them under the features/ bucket",
        );
      }

      if (
        entry.isDirectory() &&
        entry.name === "support" &&
        allowedSupportDirectories.length > 0 &&
        supportDirectories.size === 0
      ) {
        addPathViolation(
          `${root}/support`,
          "contexts with declared support directories must store them under the support/ bucket",
        );
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!canonicalBoundedContextRootFiles.has(entry.name)) {
        addPathViolation(
          `${root}/${entry.name}`,
          "implemented bounded-context roots must keep top-level files canonical and avoid ad hoc helper files",
        );
      }
    }

    for (const directoryName of declaredDirectoryIntentNames) {
      const intent = declaredDirectoryIntent[directoryName];
      const existsForIntent =
        directoryName === "routes"
          ? topLevelDirectories.has("routes") || directoryName === "routes"
          : intent?.classification === "slice"
            ? featureDirectories.has(directoryName)
            : intent?.classification === "support"
              ? supportDirectories.has(directoryName)
              : topLevelDirectories.has(directoryName);
      if (!existsForIntent && directoryName !== "routes") {
        addPathViolation(
          `${root}/context.json`,
          `directoryIntent entry must map to an existing bucketed directory (${directoryName})`,
        );
      }
    }
  }

  async function validateDeployableApiMountOwnership(contexts) {
    for (const context of contexts.values()) {
      for (const deployable of context.manifest.apiDeployables ?? []) {
        if (!knownApiDeployables.has(deployable)) {
          continue;
        }

        for (const mount of context.manifest.apiMounts ?? []) {
          if (typeof mount.mountPath !== "string" || mount.mountPath.length === 0) {
            addPathViolation(`${context.root}/context.json`, "apiMounts mountPath must be a non-empty string");
          }
        }
      }
    }
  }

  async function validateDeployableRuntimeOwnership(contexts) {
    for (const context of contexts.values()) {
      const contextDeployables = new Set(context.manifest.runtimeDeployables ?? context.manifest.apiDeployables ?? []);
      const sourceConsumers = [
        ...(context.manifest.eventSubscriptions ?? []).map((subscription) => ({
          sourceContextName: subscription.sourceContextName,
          label: "eventSubscriptions",
        })),
        ...(context.manifest.eventReactions ?? []).map((reaction) => ({
          sourceContextName: reaction.sourceContextName,
          label: "eventReactions",
        })),
      ];

      for (const sourceConsumer of sourceConsumers) {
        const providerContext = [...contexts.values()].find(
          (candidate) => candidate.manifest.contextName === sourceConsumer.sourceContextName,
        );

        if (!providerContext) {
          addPathViolation(
            `${context.root}/context.json`,
            `${sourceConsumer.label} references unknown context ${sourceConsumer.sourceContextName}`,
          );
          continue;
        }

        const providerDeployables = new Set(
          providerContext.manifest.runtimeDeployables ?? providerContext.manifest.apiDeployables ?? [],
        );
        const sharesDeployable = [...contextDeployables].some((deployable) => providerDeployables.has(deployable));

        if (!sharesDeployable) {
          addPathViolation(
            `${context.root}/context.json`,
            `${sourceConsumer.label} context ${sourceConsumer.sourceContextName} must be mounted in the same runtime deployable`,
          );
        }
      }
    }
  }

  async function validateDeployableShellOwnership(contexts) {
    const contributionsByDeployable = new Map([...knownShellDeployables].map((deployable) => [deployable, []]));

    function collectPlacedShellContributionNodes(contribution) {
      const placements =
        Array.isArray(contribution.placements) && contribution.placements.length > 0
          ? contribution.placements
          : [contribution.slot];
      const { children: rawChildren, ...contributionNode } = contribution;
      const children = Array.isArray(rawChildren) ? rawChildren : [];
      const ownNodes = placements.map((placement) => ({
        ...contributionNode,
        slot: placement,
      }));
      const childNodes = children.flatMap((child) =>
        collectPlacedShellContributionNodes({
          ...child,
          deployable: contribution.deployable,
          slot: contribution.slot,
          placements,
          sourceContext: contribution.sourceContext,
          packageName: contribution.packageName,
        }),
      );

      return [...ownNodes, ...childNodes];
    }

    for (const context of contexts.values()) {
      for (const contribution of context.manifest.shellContributions ?? []) {
        contributionsByDeployable.get(contribution.deployable)?.push({
          ...contribution,
          sourceContext: context.manifest.contextName,
          packageName: context.packageName,
        });
      }
    }

    for (const [deployable, unsortedContributions] of contributionsByDeployable.entries()) {
      const contributions = unsortedContributions
        .flatMap((contribution) => collectPlacedShellContributionNodes(contribution))
        .sort((left, right) =>
          left.slot === right.slot
            ? left.order === right.order
              ? left.key.localeCompare(right.key)
              : left.order - right.order
            : left.slot.localeCompare(right.slot),
        );
      const contributionKeys = new Set();
      const contributionHrefs = new Set();

      for (const contribution of contributions) {
        const key = `${contribution.slot}:${contribution.key}`;
        if (contributionKeys.has(key)) {
          addPathViolation(
            `deployables/${deployable}/app`,
            `shell contribution keys must be unique per slot (${contribution.slot}:${contribution.key})`,
          );
        }
        contributionKeys.add(key);

        if (contribution.href) {
          const href = `${contribution.slot}:${contribution.href}`;
          if (contributionHrefs.has(href)) {
            addPathViolation(
              `deployables/${deployable}/app`,
              `shell contribution hrefs must be unique per slot (${contribution.slot}:${contribution.href})`,
            );
          }
          contributionHrefs.add(href);
        }
      }
    }
  }

  async function validateDeployableLifecycleOwnership(contexts) {
    for (const context of contexts.values()) {
      const contextDeployables = new Set(context.manifest.runtimeDeployables ?? context.manifest.apiDeployables ?? []);

      for (const requirement of context.manifest.seedRequirements ?? []) {
        const providerContext = [...contexts.values()].find(
          (candidate) => candidate.manifest.contextName === requirement,
        );

        if (!providerContext) {
          addPathViolation(
            `${context.root}/context.json`,
            `seedRequirements references unknown context ${requirement}`,
          );
          continue;
        }

        const providerDeployables = new Set(
          providerContext.manifest.runtimeDeployables ?? providerContext.manifest.apiDeployables ?? [],
        );
        const sharesDeployable = [...contextDeployables].some((deployable) => providerDeployables.has(deployable));

        if (!sharesDeployable) {
          addPathViolation(
            `${context.root}/context.json`,
            `seedRequirements context ${requirement} must be mounted in the same API deployable`,
          );
        }
      }
    }
  }

  async function validateDeployableRouteOwnership(contexts) {
    const routesByDeployable = new Map([...knownDeployables].map((deployable) => [deployable, []]));

    for (const context of contexts.values()) {
      const { manifest, packageName, rootAbs, root } = context;

      for (const [contributionIndex, contribution] of (manifest.deployableContributions ?? []).entries()) {
        const contributionLabel = `${root}/context.json deployableContributions[${contributionIndex}]`;

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

          if (route.placement !== undefined && route.placement !== "root" && route.placement !== "layout") {
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
      const routes = [...unsortedRoutes].sort((left, right) => left.routePath.localeCompare(right.routePath));
      const routeIds = new Set();
      const routePaths = new Set();

      for (const route of routes) {
        const manifestRouteIdentity = buildManifestHostRouteIdentity(deployable, route.sourceContext, route);

        if (routeIds.has(manifestRouteIdentity.routeId)) {
          addPathViolation(
            `deployables/${deployable}/app/routes/${route.routeId}.tsx`,
            "routeId must be unique per deployable",
          );
        }
        routeIds.add(manifestRouteIdentity.routeId);

        const routePathKey = manifestRouteIdentity.routePath;
        if (routePaths.has(routePathKey)) {
          addPathViolation(
            `deployables/${deployable}/app/routes.ts`,
            `routePath must be unique per deployable (${route.routePath})`,
          );
        }
        routePaths.add(routePathKey);
      }
    }
  }

  function checkImport(file, specifier) {
    const normalized = specifier.replaceAll("\\", "/");
    const relativeFile = normalizeRelative(file);
    const resolvedSpecifier = resolveRelativeSpecifier(relativeFile, normalized);
    const routeOrShellSupportClassification = classifyRouteOrShellSupportFile(relativeFile);
    const importerContextRoot = getContextRoot(relativeFile);
    const importerContext = importerContextRoot ? contextManifests.get(importerContextRoot) : null;

    if (retiredFreshnessDroppingForwardingImport(relativeFile, normalized)) {
      addViolation(file, retiredFreshnessDroppingForwardingImportMessage);
    }

    if (importerContext && resolvedSpecifier) {
      recordSupportFileConsumer(importerContext, relativeFile, resolvedSpecifier);
    }

    if (
      importerContextRoot !== null &&
      (resolvedSpecifier === `${importerContextRoot}/client` ||
        resolvedSpecifier === `${importerContextRoot}/server` ||
        resolvedSpecifier === `${importerContextRoot}/integration`)
    ) {
      const surfaceName = path.posix.basename(resolvedSpecifier);
      const isPublicSurface =
        surfaceName === "server" ||
        (surfaceName === "client" && (importerContext?.manifest.publicExports ?? []).includes("./client")) ||
        (surfaceName === "integration" && (importerContext?.manifest.publicExports ?? []).includes("./integration"));

      if (isPublicSurface && !relativeFile.endsWith("/host-config.ts")) {
        addViolation(file, `same-context code must not import its own public ./${surfaceName} surface (${specifier})`);
      }
    }

    for (const packageName of boundedContextPackages) {
      if (
        normalized === `${packageName}/client` &&
        !matchesPackageSpecifier(normalized, importerContext?.packageName ?? "")
      ) {
        recordClientSurfaceConsumer(packageName, relativeFile);
      }
    }

    if (
      importerContextRoot !== null &&
      (isDeployableSpecifier(normalized) || isDeployableSpecifier(resolvedSpecifier ?? ""))
    ) {
      addViolation(file, `bounded contexts must not import deployables (${specifier})`);
    }

    // Catalog is the largest and most-edited context. Its only legitimate
    // cross-context surface is seed fixtures, which live in
    // @chase-sets/catalog-seed. Keeping non-catalog runtime code off
    // @chase-sets/catalog holds a catalog edit's change-scope blast radius to
    // catalog plus the deployables that mount it; tests may still mount the
    // catalog module for acceptance composition.
    if (
      importerContextRoot !== null &&
      importerContext?.packageName !== "@chase-sets/catalog" &&
      matchesPackageSpecifier(normalized, "@chase-sets/catalog") &&
      !isTestFile(relativeFile)
    ) {
      addViolation(
        file,
        `non-catalog bounded contexts must not import @chase-sets/catalog outside tests; use @chase-sets/catalog-seed fixtures instead (${specifier})`,
      );
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
      const dependency = [...contextManifests.values()].find(({ packageName }) =>
        matchesPackageSpecifier(normalized, packageName),
      );

      if (!dependency) {
        addViolation(file, `bounded contexts must not import another bounded context (${specifier})`);
      } else {
        if (
          normalized === "@chase-sets/catalog/integration/sellable-units" &&
          dependency.packageName !== contextManifests.get(importerContextRoot)?.packageName
        ) {
          addViolation(
            file,
            "non-catalog code must own its catalog version-key logic locally instead of importing the catalog sellable-unit integration surface",
          );
        }

        if (
          normalized.startsWith(`${dependency.packageName}/integration/`) &&
          isFeatureModulePath(relativeFile) &&
          relativeFile !== "bounded-contexts/auth/services.ts"
        ) {
          addViolation(
            file,
            `feature modules must not import another bounded context's integration surface directly; move the adapter into local request-support or route-support (${specifier})`,
          );
        }

        const isAllowedIntegrationImport =
          normalized.startsWith(`${dependency.packageName}/integration/`) &&
          (importerContext?.manifest.allowedContextDependencies ?? []).includes(dependency.packageName);
        const isAllowedServerImport =
          normalized === `${dependency.packageName}/server` &&
          isAllowedServerSurfaceConsumer(relativeFile) &&
          (importerContext?.manifest.allowedContextDependencies ?? []).includes(dependency.packageName);
        const isAllowedWebImport =
          normalized === `${dependency.packageName}/web` &&
          relativeFile.startsWith(`${importerContextRoot}/routes/`) &&
          (importerContext?.manifest.allowedContextDependencies ?? []).includes(dependency.packageName);

        if (!isAllowedIntegrationImport && !isAllowedServerImport && !isAllowedWebImport) {
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

    if (relativeFile.startsWith("infrastructure/") && !relativeFile.startsWith("infrastructure/platform-runtime/")) {
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
        relativeFile.endsWith("/app/routes.ts") &&
        normalized === "../../../infrastructure/platform-runtime/web-route-config"
      ) {
        return;
      }

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
        !isAllowedDeployableBoundedContextImport(relativeFile, normalized)
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

    if (routeOrShellSupportClassification && domainFacingImportHeuristic.test(normalized)) {
      addViolation(
        file,
        `${routeOrShellSupportClassification} modules must stay composition-only and must not import domain/query/projection code (${specifier}); move this dependency behind a slice-local adapter module`,
      );
    }

    if (routeOrShellSupportClassification && resolvedSpecifier && domainFacingImportHeuristic.test(resolvedSpecifier)) {
      addViolation(
        file,
        `${routeOrShellSupportClassification} modules must stay composition-only and must not import domain/query/projection code (${specifier}); move this dependency behind a slice-local adapter module`,
      );
    }

    if (
      routeOrShellSupportClassification &&
      importerContextRoot &&
      resolvedSpecifier?.startsWith(`${importerContextRoot}/`) &&
      domainFacingImportHeuristic.test(resolvedSpecifier)
    ) {
      addViolation(
        file,
        `${routeOrShellSupportClassification} modules must depend on slice-local route adapters, not domain-facing internals (${specifier})`,
      );
    }

    if (routeOrShellSupportClassification && !isTestFile(relativeFile) && importerContextRoot) {
      const isSameContextImport = resolvedSpecifier?.startsWith(`${importerContextRoot}/`) ?? false;
      const isBoundedContextPackageImport = isBoundedContextSpecifier(normalized);
      const isAllowedBoundedContextImport =
        isBoundedContextPackageImport &&
        /^@chase-sets\/[^/]+(?:\/(routes\/.+|web|server|client|integration(?:\/.+)?))$/.test(normalized);

      if (!isSameContextImport && isBoundedContextPackageImport && !isAllowedBoundedContextImport) {
        addViolation(
          file,
          `${routeOrShellSupportClassification} modules may import only slice route handlers, ui/contracts, or deployable-facing interfaces (${specifier})`,
        );
      }
    }
  }

  await validateWorkspaceTestScriptCoverage();

  await runManifestValidation({
    contextManifests,
    validateContextManifest,
    validateDeployableRouteOwnership,
    validateDeployableApiMountOwnership,
    validateDeployableRuntimeOwnership,
    validateDeployableLifecycleOwnership,
    validateDeployableShellOwnership,
  });

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

  await runImportBoundaryValidation({
    roots: roots.map((root) => path.join(repoRoot, root)),
    walk,
    onDirectory: async (directory) => {
      const relativeDir = normalizeRelative(directory);

      if (/^bounded-contexts\/[^/]+\/deployables(?:\/|$)/.test(relativeDir)) {
        addPathViolation(
          relativeDir,
          "nested bounded-context deployables are retired; keep deployables only under the top-level deployables/ directory",
        );
      }

      if (relativeDir.startsWith("bounded-contexts/")) {
        const directoryName = path.basename(directory);
        if (forbiddenBoundedContextDirectoryNames.has(directoryName)) {
          addPathViolation(
            relativeDir,
            "bounded contexts must use purpose-specific folder names instead of generic infrastructure/shared/support directories",
          );
        }
      }
    },
    onFile: async (file) => {
      if (isTmpFile(file)) {
        addViolation(file, "tracked tmp artifact should not exist");
      }

      const normalizedFile = normalizeRelative(file);
      if (normalizedFile.startsWith("deployables/") && path.basename(file) === "api.server.ts") {
        addViolation(file, "deployables must not define local business API helpers");
      }

      if (/bounded-contexts\/[^/]+(?:\/[^/]+)?\/shell\/nav\.ts$/.test(normalizedFile)) {
        addViolation(
          file,
          "shell navigation must come from manifest-driven platform-runtime composition, not hand-authored nav modules",
        );
      }

      const extension = path.extname(file);
      let content = null;

      if (/^bounded-contexts\/[^/]+\/docs\//.test(normalizedFile) && sourceExtensions.has(extension)) {
        addViolation(
          file,
          "bounded-context docs must remain documentation-only and must not contain runtime source files",
        );
      }

      if (isAccountCapabilityLanguageGuardedFile(normalizedFile, extension)) {
        content = await readFile(file, "utf8");

        for (const guard of findAccountCapabilityLanguageViolations({
          relativeFile: normalizedFile,
          content,
        })) {
          addViolation(
            file,
            `account capability language is retired; replace ${guard.label} with account-neutral naming unless buyer/seller is a durable transaction-party identifier`,
          );
        }
      }

      if (!sourceExtensions.has(extension)) {
        return;
      }

      content ??= await readFile(file, "utf8");

      if (isSoftwareDeliveryConceptGuardedFile(normalizedFile, extension)) {
        for (const guard of findSoftwareDeliveryConceptViolations({
          relativeFile: normalizedFile,
          content,
        })) {
          addViolation(
            file,
            `software-delivery concepts belong in delivery tooling (scripts/, .github/, infrastructure/, docs/), not product code; remove ${guard.label}`,
          );
        }
      }

      if (isBusinessLiteralGuardedFile(normalizedFile, extension)) {
        for (const violation of findBusinessLiteralGuardViolations({
          relativeFile: normalizedFile,
          content,
        })) {
          addViolation(file, violation.message);
        }
      }

      if (
        (normalizedFile.startsWith("bounded-contexts/") || normalizedFile.startsWith("deployables/")) &&
        /application\/x-ndjson/i.test(content)
      ) {
        addViolation(
          file,
          "request-tied NDJSON progress streams are retired; long-running work must use durable jobs with SSE status events",
        );
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        normalizedFile.endsWith("/api/route.ts") &&
        /createDurableJobEventStream\s*\(/.test(content) &&
        !/waitForEvents\s*:/.test(content)
      ) {
        addViolation(
          file,
          "durable job SSE routes must pass a notification-backed waitForEvents hook with polling fallback",
        );
      }

      if (
        normalizedFile.startsWith("bounded-contexts/catalog/features/source-observations/") &&
        /catalog_source_observation_(?:bulk_jobs|integration_jobs|job_events)\b/.test(content)
      ) {
        addViolation(
          file,
          "Source Observation jobs must use the shared durable job store tables, not legacy unfenced job tables",
        );
      }

      if (
        normalizedFile === "bounded-contexts/catalog/features/source-observations/api/runtime.ts" &&
        /function\s+importIntegrationExpansion/.test(content) &&
        !/importIntegrationExpansion[\s\S]*onProgress\?:\s*\(progress:\s*TcgdexSetImportProgress\)/.test(content)
      ) {
        addViolation(
          file,
          "TCGdex durable integration imports must forward per-set progress so long set recording renews the job claim",
        );
      }

      if (
        normalizedFile === "bounded-contexts/inventory/features/import-batches/api/runtime.ts" &&
        !/create\?:\s*Readonly<\{[\s\S]*batchId\?:\s*string/.test(content)
      ) {
        addViolation(
          file,
          "inventory create import jobs must carry a stable batchId in the durable payload for replay-safe retries",
        );
      }

      if (
        normalizedFile === "bounded-contexts/inventory/features/import-batches/api/runtime.ts" &&
        /DELETE FROM inventory_import_batch_job_inputs/.test(content) &&
        !/NOT EXISTS \([\s\S]*inventory_import_batch_jobs[\s\S]*status IN \('queued', 'running'\)/.test(content)
      ) {
        addViolation(
          file,
          "inventory staged input retention must exclude inputs referenced by queued or running durable jobs",
        );
      }

      if (
        normalizedFile === "bounded-contexts/pricing/features/recommendations/api/runtime.ts" &&
        /createListing\(\{[\s\S]*inventoryItemId[\s\S]*quantityCap/.test(content) &&
        !/listingIdOverride:\s*listingIdForPricingRecommendation/.test(content)
      ) {
        addViolation(
          file,
          "pricing apply jobs that create draft listings must provide a deterministic listingIdOverride for replay safety",
        );
      }

      if (
        normalizedFile === "infrastructure/platform-runtime/control-plane.ts" &&
        (!/event_sequence integer NOT NULL DEFAULT 0/.test(content) ||
          !/RETURNING event_sequence/.test(content) ||
          !/claimed_until = now\(\) \+ \(\$5::text \|\| ' milliseconds'\)::interval/.test(content))
      ) {
        addViolation(
          file,
          "projection operation jobs must renew claims and reserve event sequences through the control-plane row",
        );
      }

      if (
        normalizedFile === "infrastructure/platform-runtime/durable-job-events.ts" &&
        (!/createInMemoryDurableJobStreamLimiter/.test(content) || !/too_many_durable_job_streams/.test(content))
      ) {
        addViolation(file, "durable job SSE streams must use a shared in-process stream limiter");
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        normalizedFile.endsWith("/api/route.ts") &&
        !normalizedFile.endsWith("/source-observations/api/route.ts") &&
        /\benqueue[A-Za-z0-9_]*Job\b/.test(content) &&
        /return\s+c\.json\(\s*job\s*,\s*202\s*\)/.test(content)
      ) {
        addViolation(
          file,
          "durable job enqueue routes must return a public job status snapshot, not the private worker job record",
        );
      }

      if (
        normalizedFile === "deployables/platform-worker/src/main.ts" &&
        /name:\s*"catalog\.authoring-bulk-jobs",\s*\n\s*kind:\s*"job",\s*\n\s*runOnce:\s*async\s*\(\s*\)\s*=>/.test(
          content,
        )
      ) {
        addViolation(file, "catalog authoring durable jobs must receive worker cancellation and lease-loss context");
      }

      if (normalizedFile !== "scripts/check-structure/run.mjs" && retiredPanelDrawerPattern.test(content)) {
        addViolation(
          file,
          "non-navigation drawer aliases are retired; use SideSheet, BottomSheet, CommerceSheet, ResponsiveEditSheet, or NotificationCenterSheet",
        );
      }

      if (
        ((normalizedFile.startsWith("deployables/") &&
          (normalizedFile.endsWith("/src/config.ts") || isTestFile(normalizedFile))) ||
          normalizedFile === "scripts/dev-system.mjs" ||
          (normalizedFile.startsWith("bounded-contexts/") && isTestFile(normalizedFile))) &&
        /\bDATABASE_URL\b/.test(content)
      ) {
        const databaseUrlAllowed =
          normalizedFile === "deployables/platform-api/src/config.ts" ||
          normalizedFile === "deployables/platform-api/__tests__/config.test.ts" ||
          normalizedFile === "deployables/platform-api/__tests__/database-pools.test.ts" ||
          normalizedFile === "deployables/platform-worker/src/config.ts" ||
          normalizedFile === "deployables/platform-worker/__tests__/config.test.ts" ||
          normalizedFile === "deployables/platform-worker/__tests__/database-pools.test.ts" ||
          normalizedFile === "scripts/dev-system.mjs";

        if (!databaseUrlAllowed) {
          addViolation(
            file,
            "DATABASE_URL is reserved for the platform host; bounded-context tests should continue using TEST_DATABASE_URL helpers",
          );
        }
      }

      if (
        (normalizedFile.startsWith("bounded-contexts/") || normalizedFile.startsWith("deployables/")) &&
        isTestFile(normalizedFile) &&
        /\bTEST_DATABASE_URL\b/.test(content) &&
        content.includes("@chase-sets/bounded-context-runtime/test-support") === false
      ) {
        addViolation(
          file,
          "DB-backed tests using TEST_DATABASE_URL must create per-context databases through @chase-sets/bounded-context-runtime/test-support",
        );
      }

      if (
        (normalizedFile.startsWith("bounded-contexts/") || normalizedFile.startsWith("deployables/")) &&
        isTestFile(normalizedFile) &&
        content.includes("composeSchemaSql(")
      ) {
        addViolation(
          file,
          "DB-backed tests must not compose multiple bounded-context schemas into one database; use per-context databases instead",
        );
      }

      const routeOrShellSupportClassification = classifyRouteOrShellSupportFile(normalizedFile);
      const contextRoot = getContextRoot(normalizedFile);
      const contextName = contextRoot ? (contextManifests.get(contextRoot)?.manifest.contextName ?? null) : null;
      const routeSupportPlacementViolation = findRouteSupportPlacementViolation({
        relativeFile: normalizedFile,
        content,
        contextManifest: contextRoot ? contextManifests.get(contextRoot)?.manifest : null,
        isTest: isTestFile(normalizedFile),
      });
      if (routeSupportPlacementViolation) {
        addViolation(file, routeSupportPlacementViolation);
      }

      if (contextName && !isTestFile(normalizedFile)) {
        for (const guard of crossContextSqlReadGuards) {
          if (guard.ownerContextName === contextName) {
            continue;
          }

          if (guard.pattern.test(content)) {
            addViolation(
              file,
              `non-owning contexts must not query ${guard.tableName}; subscribe to ${guard.ownerContextName} events and persist a local projection instead`,
            );
          }
        }
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        routeOrShellSupportClassification === "routes" &&
        !isTestFile(normalizedFile) &&
        /(export\s+const\s+(?:loader|action|meta|headers)|export\s+default\s+function)/.test(content) === false
      ) {
        addViolation(
          file,
          "routes/ must contain deployable adapter modules with route exports (loader/action/meta/default component)",
        );
      }

      if (/^bounded-contexts\/[^/]+\/index\.ts$/.test(normalizedFile) && forbiddenRootSurfaceReexports.test(content)) {
        addViolation(file, "context root entrypoints must not re-export secondary public surfaces");
      }

      if (/^bounded-contexts\/[^/]+\/index\.ts$/.test(normalizedFile)) {
        const exportStatements = [...content.matchAll(/^\s*export\b.*$/gm)].map((match) => match[0].trim());
        const invalidExports = exportStatements.filter(
          (statement) =>
            statement !== 'export { default as contextManifest } from "./context.json";' &&
            !statement.startsWith("export const module"),
        );

        if (invalidExports.length > 0) {
          addViolation(file, "context root entrypoints must export only contextManifest and module");
        }
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        boundedContextSurfaceFiles.has(path.basename(file)) &&
        /^bounded-contexts\/[^/]+\/(?:client|server|web)\.ts$/.test(normalizedFile) &&
        /export\s+\{\s*default\s+as\s+contextManifest\s*\}\s+from\s+["']\.\/context\.json["'];?/.test(content)
      ) {
        addViolation(file, "non-root public surfaces must not export contextManifest");
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        boundedContextSurfaceFiles.has(path.basename(file)) &&
        /^bounded-contexts\/[^/]+\/(?:client|server|web)\.ts$/.test(normalizedFile) &&
        stripContextManifestSurfaceExport(content).length === 0
      ) {
        addViolation(file, "declared public surfaces must not be placeholder-only");
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        path.basename(file) === "client.ts" &&
        /\bcreate[A-Z][A-Za-z0-9]*Request(?:Api|Integration)Client\b/.test(content)
      ) {
        addViolation(file, "client surfaces must stay browser-safe and must not export request-scoped helpers");
      }

      if (
        normalizedFile.startsWith("bounded-contexts/") &&
        path.basename(file) === "client.ts" &&
        /\/ui\/contracts\b/.test(content)
      ) {
        addViolation(file, "client surfaces must not export presentation-named DTO folders");
      }

      if (normalizedFile.startsWith("bounded-contexts/") && path.basename(file) === "integration.ts") {
        addViolation(
          file,
          "integration surfaces are retired; use ./server for request-time access and published events for downstream projections",
        );
      }

      if (/^bounded-contexts\/[^/]+\/web\.ts$/.test(normalizedFile)) {
        const webSurfaceSpecifiers = extractImportSpecifiers(content).filter((specifier) => specifier.startsWith("."));
        const invalidSpecifiers = webSurfaceSpecifiers.filter(
          (specifier) =>
            !(
              specifier.startsWith("./shell") ||
              specifier.startsWith("./shell-support") ||
              specifier.startsWith("./support/shell-support") ||
              specifier.startsWith("./support/ui-support") ||
              specifier.startsWith("./browser") ||
              specifier.startsWith("./providers")
            ),
        );

        if (invalidSpecifiers.length > 0) {
          addViolation(
            file,
            "web surfaces must stay deployable-facing and may only export shell, provider, or browser-entry modules",
          );
        }

        if (/\bcreate[A-Z][A-Za-z0-9]*ApiClient\b|\b[A-Z][A-Za-z0-9]*ApiError\b/.test(content)) {
          addViolation(file, "web surfaces must not export API client factories or API error types");
        }
      }

      if (
        /deployables\/[^/]+\/(?:vite|vitest)\.config\.ts$/.test(normalizedFile) &&
        !content.includes("createWorkspaceSourceAliases")
      ) {
        addViolation(file, "deployable build configs must use the shared workspace alias helper");
      }

      if (
        /deployables\/[^/]+\/(?:vite|vitest)\.config\.ts$/.test(normalizedFile) &&
        /(replacement\s*:\s*[\s\S]{0,160}?\.\.\/\.\.\/(?:bounded-contexts|contracts|infrastructure|packages)\/|resolve\([\s\S]{0,120}?\.\.\/\.\.\/(?:bounded-contexts|contracts|infrastructure|packages)\/)/.test(
          content,
        )
      ) {
        addViolation(file, "deployable build configs must not hard-code workspace source paths");
      }

      if (
        /deployables\/(admin-web|marketplace)\/app\/auth\.server\.ts$/.test(normalizedFile) &&
        !content.includes("defineAuthHost")
      ) {
        addViolation(file, "web deployable auth wrappers must use the shared auth host factory");
      }

      if (normalizedFile.startsWith("deployables/") && /\/src\/stack\.ts$/.test(normalizedFile)) {
        addViolation(file, "API deployables must not keep hand-written stack composition modules");
      }

      if (normalizedFile.startsWith("deployables/") && /\/src\/seed-stack\.ts$/.test(normalizedFile)) {
        addViolation(file, "API deployables must not keep hand-written seed stack composition modules");
      }

      if (
        normalizedFile.startsWith("deployables/") &&
        isApiDeployableFile(normalizedFile) &&
        normalizedFile.includes("/src/") &&
        retiredIntegrationSurfaceImportPattern.test(content)
      ) {
        addViolation(file, "API deployables must not import retired bounded-context integration surfaces");
      }

      if (normalizedFile.startsWith("bounded-contexts/") && retiredIntegrationSurfaceImportPattern.test(content)) {
        addViolation(
          file,
          "bounded-context code must not import retired ./integration surfaces; use provider ./server surfaces or published events instead",
        );
      }

      if (normalizedFile.startsWith("contracts/") && /\bprocess\.env\b/.test(content)) {
        addViolation(file, "contracts must not read environment variables");
      }

      if (
        normalizedFile.startsWith("deployables/") &&
        isTestFile(normalizedFile) &&
        /@chase-sets\/[^/]+\/client/.test(content)
      ) {
        addViolation(file, "deployable tests must not depend on bounded-context client surfaces");
      }

      for (const specifier of extractImportSpecifiers(content)) {
        checkImport(file, specifier);
      }
    },
  });

  for (const context of contextManifests.values()) {
    if (!(context.manifest.publicExports ?? []).includes("./client")) {
      continue;
    }

    const consumers = clientSurfaceConsumers.get(context.packageName) ?? new Set();
    if (consumers.size === 0) {
      addPathViolation(
        `${context.root}/context.json`,
        "contexts must not export ./client without an external consumer",
      );
    }
  }

  const todayIsoDate = new Date().toISOString().slice(0, 10);
  for (const entry of singleSliceSupportFileAllowlist) {
    if (!entry || typeof entry !== "object") {
      addPathViolation(
        "scripts/check-structure.mjs",
        "singleSliceSupportFileAllowlist entries must be objects with file, owner, and removeBy",
      );
      continue;
    }

    const { file, owner, removeBy } = entry;
    if (!file || typeof file !== "string") {
      addPathViolation("scripts/check-structure.mjs", "allowlist entries must include a file path");
    }
    if (!owner || typeof owner !== "string") {
      addPathViolation("scripts/check-structure.mjs", `allowlist entry for ${file ?? "unknown"} must include an owner`);
    }
    if (!removeBy || typeof removeBy !== "string" || !isValidIsoDate(removeBy)) {
      addPathViolation(
        "scripts/check-structure.mjs",
        `allowlist entry for ${file ?? "unknown"} must include removeBy in YYYY-MM-DD format`,
      );
      continue;
    }

    if (removeBy < todayIsoDate) {
      addPathViolation(
        file,
        `single-slice support allowlist entry expired on ${removeBy}; owner=${owner ?? "unknown"}`,
      );
    }
  }

  const pullRequestLabels = readGitHubPullRequestLabels();
  const temporaryDebtPermittedByLabel = pullRequestLabels.includes(temporarySingleSliceSupportDebtLabel);
  const temporaryDebtPermitted = temporarySingleSliceSupportDebtFlag || temporaryDebtPermittedByLabel;
  if (process.env.CI && singleSliceSupportFileAllowlist.length > 0 && !temporaryDebtPermitted) {
    addPathViolation(
      "scripts/check-structure.mjs",
      `singleSliceSupportFileAllowlist must be empty in CI unless STRUCTURE_ALLOW_TEMPORARY_SINGLE_SLICE_SUPPORT_DEBT=true or PR label ${temporarySingleSliceSupportDebtLabel} is present`,
    );
  }

  for (const [supportFile, usageRecord] of supportFileConsumers.entries()) {
    if (singleSliceSupportFileAllowlistByFile.has(supportFile)) {
      continue;
    }

    if (isRequestSupportAdapter(supportFile, usageRecord, contextManifests)) {
      continue;
    }

    if (usageRecord.consumerSlices.size === 1) {
      const metrics = contextMetricsByRoot.get(usageRecord.contextRoot);
      if (metrics) {
        metrics.singleSliceSupportFiles += 1;
      }

      const [sliceName] = [...usageRecord.consumerSlices];
      const message =
        `support file in ${usageRecord.supportDirectory} is imported by only one slice (${sliceName}); ` +
        `relocate it to bounded-contexts/.../${sliceName}/`;
      if (singleSliceSupportEnforcementMode === "warn") {
        addPathWarning(supportFile, message);
      } else {
        addPathViolation(supportFile, message);
      }
    }
  }

  const supportDirectoryConsumerSlicesByContext = new Map();
  for (const usageRecord of supportFileConsumers.values()) {
    const contextSupportMap = supportDirectoryConsumerSlicesByContext.get(usageRecord.contextRoot) ?? new Map();
    const directoryConsumers = contextSupportMap.get(usageRecord.supportDirectory) ?? new Set();
    for (const consumerSlice of usageRecord.consumerSlices) {
      directoryConsumers.add(consumerSlice);
    }
    contextSupportMap.set(usageRecord.supportDirectory, directoryConsumers);
    supportDirectoryConsumerSlicesByContext.set(usageRecord.contextRoot, contextSupportMap);
  }

  for (const context of contextManifests.values()) {
    const contextSupportMap = supportDirectoryConsumerSlicesByContext.get(context.root);
    if (!contextSupportMap) {
      continue;
    }

    for (const [supportDirectory, actualConsumers] of contextSupportMap.entries()) {
      const directoryIntent = context.manifest.directoryIntent?.[supportDirectory];
      if (!directoryIntent || directoryIntent.classification !== "support") {
        const metrics = contextMetricsByRoot.get(context.root);
        if (metrics) {
          metrics.driftCount += 1;
        }

        addPathViolation(
          `${context.root}/context.json`,
          `support consumer usage exists for ${supportDirectory} but directoryIntent support metadata is missing`,
        );
        continue;
      }

      const expectedConsumers = new Set(directoryIntent.expectedConsumers ?? []);
      if (!setsAreEqual(actualConsumers, expectedConsumers)) {
        const metrics = contextMetricsByRoot.get(context.root);
        if (metrics) {
          metrics.driftCount += 1;
        }

        addPathViolation(
          `${context.root}/context.json`,
          `directoryIntent expectedConsumers drift for ${supportDirectory}; expected [${formatSetValues(expectedConsumers)}], actual [${formatSetValues(actualConsumers)}]`,
        );
      }
    }
  }

  const contextMetrics = [...contextMetricsByRoot.values()].sort((left, right) =>
    left.contextName.localeCompare(right.contextName),
  );
  const structureMetrics = {
    generatedAt: new Date().toISOString(),
    totals: {
      contextCount: contextMetrics.length,
      sliceCount: contextMetrics.reduce((total, metrics) => total + metrics.sliceCount, 0),
      supportDirectoryCount: contextMetrics.reduce((total, metrics) => total + metrics.supportDirectoryCount, 0),
      singleSliceSupportFiles: contextMetrics.reduce((total, metrics) => total + metrics.singleSliceSupportFiles, 0),
      driftCount: contextMetrics.reduce((total, metrics) => total + metrics.driftCount, 0),
    },
    contexts: contextMetrics,
  };

  if (structureMetrics.totals.singleSliceSupportFiles !== 0) {
    addPathWarning(
      structureMetricsOutputPath,
      "singleSliceSupportFiles should trend to 0; move single-slice support assets into their owning slice",
    );
  }

  const readAfterWriteInventoryResult = await validateReadAfterWriteRouteInventory({
    repoRoot,
    contextManifests,
  });
  for (const violation of readAfterWriteInventoryResult.violations) {
    violations.push(violation);
  }
  for (const warning of readAfterWriteInventoryResult.warnings) {
    warnings.push(warning);
  }

  const crossContextFallbackInventoryResult = validateCrossContextFallbackInventory({
    repoRoot,
    contextManifests,
  });
  for (const violation of crossContextFallbackInventoryResult.violations) {
    violations.push(violation);
  }
  for (const warning of crossContextFallbackInventoryResult.warnings) {
    warnings.push(warning);
  }

  const crossContextReadInventoryResult = await validateCrossContextReadInventory({
    repoRoot,
    contextManifests,
  });
  for (const violation of crossContextReadInventoryResult.violations) {
    violations.push(violation);
  }
  for (const warning of crossContextReadInventoryResult.warnings) {
    warnings.push(warning);
  }

  const glossaryCoverageResult = validateGlossaryCoverage({
    repoRoot,
    contextManifests,
  });
  for (const violation of glossaryCoverageResult.violations) {
    violations.push(violation);
  }
  for (const warning of glossaryCoverageResult.warnings) {
    warnings.push(warning);
  }

  const serverBarrelReactFreeResult = await validateServerBarrelReactFree({
    repoRoot,
    contextManifests,
  });
  for (const violation of serverBarrelReactFreeResult.violations) {
    violations.push(violation);
  }
  for (const warning of serverBarrelReactFreeResult.warnings) {
    warnings.push(warning);
  }

  const iaRegistryResult = validateIaRegistry({ repoRoot, contextManifests });
  for (const violation of iaRegistryResult.violations) {
    violations.push(violation);
  }
  for (const warning of iaRegistryResult.warnings) {
    warnings.push(warning);
  }

  const bootSchemaDdlDisciplineViolations = await findBootSchemaDdlDisciplineViolations({ repoRoot });
  for (const violation of bootSchemaDdlDisciplineViolations) {
    violations.push(`${violation.file}:${violation.line}: ${violation.message}`);
  }

  const retentionSweepCoverageResult = await validateRetentionSweepCoverage({ repoRoot });
  violations.push(...retentionSweepCoverageResult.violations);

  const browserE2eDisclosureGuardResult = await validateBrowserE2eDisclosureGuard({ repoRoot });
  violations.push(...browserE2eDisclosureGuardResult.violations);

  const responsiveEvidenceGuardResult = await validateResponsiveEvidenceGuard({ repoRoot });
  violations.push(...responsiveEvidenceGuardResult.violations);

  const publicPolicyPostureResult = await validatePublicPolicyPosture({ repoRoot });
  violations.push(...publicPolicyPostureResult.violations);

  const policyValueDiscriminantChokepointResult = validatePolicyValueDiscriminantChokepoint({ repoRoot });
  violations.push(...policyValueDiscriminantChokepointResult.violations);

  const workspaceTsconfigResult = await checkWorkspaceTsconfigExtends({ repoRoot });
  for (const violation of workspaceTsconfigResult.violations) {
    violations.push(violation);
  }

  const designSystemDeadExportResult = await checkDesignSystemDeadExports({ repoRoot });
  for (const violation of designSystemDeadExportResult.violations) {
    violations.push(violation);
  }

  writeStructureMetricsReport({
    repoRoot,
    outputPath: structureMetricsOutputPath,
    metrics: structureMetrics,
  });

  const ok = reportStructureCheckResults({ violations, warnings });
  const result = {
    ok,
    metrics: structureMetrics,
    violations: [...violations],
    warnings: [...warnings],
  };

  if (!ok && options.exit !== false) {
    process.exit(1);
  }

  return result;
}
