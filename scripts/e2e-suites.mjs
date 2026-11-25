import { isDesignSystemNavigationRiskPath } from "./lib/risk-policy-v1.mjs";

// The marketplace has no suite of its own: production serves the Corten pilot's marketplace, whose kept
// browser specs run in the Corten Marketplace Browser Tests job. The ownership maps below name that job with
// this selection wherever a change would have picked a marketplace suite when marketplace-web served it, so
// the same changes keep running browser coverage of the served marketplace.
export const cortenMarketplaceBrowserSelection = "corten-marketplace-browser";
const marketplaceBrowser = cortenMarketplaceBrowserSelection;

export const e2eSuites = Object.freeze([
  {
    id: "catalog_admin_integrations",
    label: "Catalog Admin Integrations",
    deployable: "admin-web",
    journeys: ["provider profile management", "catalog integrations"],
    grep: "@catalog-admin-integrations",
    estimatedDurationSeconds: 720,
  },
  {
    id: "catalog_admin_modeling",
    label: "Catalog Admin Modeling",
    deployable: "admin-web",
    journeys: ["dimensions", "catalog model authoring"],
    grep: "@catalog-admin-modeling",
    estimatedDurationSeconds: 660,
  },
  {
    id: "admin_growth",
    label: "Admin Growth",
    deployable: "admin-web",
    journeys: ["Google Shopping operations", "waitlist review", "promo bar management"],
    grep: "@admin-growth",
    estimatedDurationSeconds: 360,
  },
  {
    id: "admin_commerce",
    label: "Admin Commerce",
    deployable: "admin-web",
    journeys: ["commercial terms management", "postage policy management", "facility return intake"],
    grep: "@admin-commerce",
    estimatedDurationSeconds: 420,
  },
  {
    id: "admin_support",
    label: "Admin Support",
    deployable: "admin-web",
    journeys: ["support request operations", "platform feedback triage"],
    grep: "@admin-support",
    estimatedDurationSeconds: 240,
  },
  {
    id: "admin_platform",
    label: "Admin Platform",
    deployable: "admin-web",
    journeys: ["projection operations", "Listing Evidence Policy", "API topology"],
    grep: "@admin-platform",
    estimatedDurationSeconds: 240,
  },
  {
    id: "admin_auth",
    label: "Admin Auth",
    deployable: "admin-web",
    journeys: ["admin sign-in", "shell session", "RBAC entry"],
    grep: "@admin-auth",
    estimatedDurationSeconds: 180,
  },
  {
    id: "admin_access",
    label: "Admin Access",
    deployable: "admin-web",
    journeys: ["invitation lifecycle", "api key lifecycle"],
    grep: "@admin-access",
    estimatedDurationSeconds: 300,
  },
  {
    id: "platform_mcp_sdk",
    label: "Platform MCP SDK",
    deployable: "platform-api",
    journeys: ["SDK client discovery", "agent commerce journey", "agent grant guardrails"],
    grep: "@mcp-sdk-journey",
    command: [
      "--filter",
      "@chase-sets/app-platform-api",
      "exec",
      "vitest",
      "run",
      "--config",
      "./vitest.config.ts",
      "__tests__/mcp-sdk-agent-journey.e2e.test.ts",
    ],
    estimatedDurationSeconds: 90,
  },
  {
    id: "agent_apps",
    label: "Agent Apps",
    deployable: "agent-apps",
    journeys: ["sandboxed product cards", "MCP Apps host handshake", "public asset and link policy"],
    grep: "@agent-apps",
    command: ["--filter", "@chase-sets/app-agent-apps", "run", "test:chromium"],
    estimatedDurationSeconds: 60,
  },
  {
    id: "tcgplayer_connector_extension",
    label: "TCGplayer Connector Extension Chromium Authority",
    deployable: "tcgplayer-connector-extension",
    journeys: ["extension identity", "callback authority", "popup-less action pairing"],
    grep: "@tcgplayer-connector-extension-authority",
    command: ["--filter", "@chase-sets/app-tcgplayer-connector-extension", "run", "test:chromium"],
    requiresDisplay: true,
    // Measured suite phase, not whole job: solo runs 39190003901 and 39197730983
    // reported 194 passed in 16.6m and 16.7m. Their whole jobs, with checkout,
    // install and evidence steps, took 17.38m and 17.77m, about 7m inside the
    // 25m job limit. Paired with marketplace_account (8.0m) it exceeded that
    // limit in runs 39233257411 and 39236645773, so it always runs alone.
    estimatedDurationSeconds: 1002,
    unpaired: true,
  },
  {
    id: "tcgplayer_operator_extension",
    label: "TCGplayer Operator Extension Isolation",
    deployable: "tcgplayer-operator-extension",
    journeys: ["sandbox isolation", "cookie applicability", "retained operator pairing"],
    grep: "@tcgplayer-operator-extension",
    command: ["--filter", "@chase-sets/app-tcgplayer-operator-extension", "run", "test:chromium"],
    requiresDisplay: true,
    estimatedDurationSeconds: 60,
  },
  {
    id: "rendered_copy",
    label: "Rendered Copy Sweep",
    deployable: "admin-web",
    journeys: ["seeded rendered-copy observations"],
    grep: "@rendered-copy",
    estimatedDurationSeconds: 900,
  },
]);

const suiteOrder = new Map(e2eSuites.map((suite, index) => [suite.id, index]));
const suitesById = new Map(e2eSuites.map((suite) => [suite.id, suite]));
const allMarketplaceSuiteIds = Object.freeze([marketplaceBrowser]);
const allAdminWebSuiteIds = e2eSuites
  .filter((suite) => suite.deployable === "admin-web" && suite.id !== "rendered_copy")
  .map((suite) => suite.id);
const allBrowserSuiteIds = Object.freeze([...allAdminWebSuiteIds, marketplaceBrowser]);
const defaultSuiteBatchSize = 2;
const fallbackEstimatedSuiteDurationSeconds = 300;

const browserRuntimePatterns = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^tsconfig\.json$/,
  /^tsconfig\.base\.json$/,
  /^tailwind\.config\.ts$/,
  /^vite\.config\.[cm]?[tj]s$/,
  /^react-router\.config\.[cm]?[tj]s$/,
  /^playwright\.config\.ts$/,
  /^scripts\/e2e-suites\.mjs$/,
  /^infrastructure\/playwright-evidence\/(?:index\.ts|package\.json|responsive-evidence-manifest\.json|rendered-copy\.ts)$/,
  /^scripts\/validate-responsive-evidence-artifacts\.mjs$/,
  /^scripts\/run-e2e-suite\.mjs$/,
  /^docker-compose\.dev\.yml$/,
  /^scripts\/lib\/sandbox\.mjs$/,
  /^scripts\/dev-system(?:-config)?\.mjs$/,
];

const contextSuiteOwnership = new Map([
  ["auth", [marketplaceBrowser, "admin_auth"]],
  ["catalog", [marketplaceBrowser, "catalog_admin_integrations"]],
  ["channels", [marketplaceBrowser]],
  ["checkout", [marketplaceBrowser]],
  ["commercial-terms", [marketplaceBrowser]],
  ["discovery", [marketplaceBrowser]],
  ["fulfillment", [marketplaceBrowser]],
  ["identity", [marketplaceBrowser, "admin_access"]],
  ["inventory", [marketplaceBrowser]],
  ["marketplace", [marketplaceBrowser]],
  ["notifications", [marketplaceBrowser]],
  ["ordering", [marketplaceBrowser, "admin_commerce"]],
  ["payments", [marketplaceBrowser]],
  ["platform-operations", [marketplaceBrowser, "admin_support", "admin_platform"]],
  ["pricing", [marketplaceBrowser]],
  ["public-presence", [marketplaceBrowser, "admin_growth"]],
  ["settlement", [marketplaceBrowser]],
]);

const marketplaceContextRouteSuiteOwnership = new Map([
  ["auth", [marketplaceBrowser]],
  ["channels", [marketplaceBrowser]],
  ["discovery", [marketplaceBrowser]],
  ["fulfillment", [marketplaceBrowser]],
  ["identity", [marketplaceBrowser]],
  ["inventory", [marketplaceBrowser]],
  ["marketplace", [marketplaceBrowser]],
  ["payments", [marketplaceBrowser]],
  ["platform-operations", [marketplaceBrowser]],
  ["pricing", [marketplaceBrowser]],
  ["public-presence", [marketplaceBrowser]],
  ["settlement", [marketplaceBrowser]],
]);

const adminContextRouteSuiteOwnership = new Map([
  ["auth", ["admin_auth", "admin_access"]],
  ["catalog", ["catalog_admin_modeling"]],
  ["channels", ["admin_support"]],
  ["commercial-terms", ["admin_commerce"]],
  ["discovery", ["admin_growth"]],
  ["identity", ["admin_access"]],
  ["fulfillment", ["admin_commerce"]],
  ["inventory", ["admin_commerce"]],
  ["ordering", ["admin_commerce"]],
  ["platform-operations", ["admin_support", "admin_platform"]],
  ["public-presence", ["admin_growth"]],
  ["settlement", ["admin_commerce"]],
]);

const e2eSpecSuiteOwnership = [
  { pattern: /^deployables\/corten-pilot\/e2e\/critical-flows\.spec\.ts$/, suites: allMarketplaceSuiteIds },
  {
    pattern: /^deployables\/corten-pilot\/e2e\/buyer-purchase-journey\.spec\.ts$/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^deployables\/corten-pilot\/e2e\/responsive-evidence-contract\.spec\.ts$/,
    suites: [marketplaceBrowser],
  },
  { pattern: /^deployables\/admin-web\/e2e\/access-/, suites: ["admin_access"] },
  {
    pattern: /^deployables\/admin-web\/e2e\/admin-tablet-navigation\.spec\.ts$/,
    suites: ["catalog_admin_integrations", "admin_support"],
  },
  { pattern: /^deployables\/admin-web\/e2e\/auth-shell-rbac\.spec\.ts$/, suites: ["admin_auth"] },
  { pattern: /^deployables\/admin-web\/e2e\/catalog-integrations\.spec\.ts$/, suites: ["catalog_admin_integrations"] },
  { pattern: /^deployables\/admin-web\/e2e\/catalog-scopes\.spec\.ts$/, suites: ["catalog_admin_integrations"] },
  { pattern: /^deployables\/admin-web\/e2e\/catalog-modeling\.spec\.ts$/, suites: ["catalog_admin_modeling"] },
  { pattern: /^deployables\/admin-web\/e2e\/commerce-/, suites: ["admin_commerce"] },
  { pattern: /^deployables\/admin-web\/e2e\/growth-/, suites: ["admin_growth"] },
  { pattern: /^deployables\/admin-web\/e2e\/support-/, suites: ["admin_support"] },
  {
    pattern: /^deployables\/admin-web\/e2e\/(?:admin-cross-cutting-topology|platform-projection-operations)\.spec\.ts$/,
    suites: ["admin_platform"],
  },
  {
    pattern: /^deployables\/corten-pilot\/e2e\/marketplace-shell-header\.spec\.ts$/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^deployables\/admin-web\/e2e\/rendered-copy-sweep\.spec\.ts$/,
    suites: [
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_access",
    ],
  },
];

export const e2eNoSuiteExclusions = Object.freeze([
  {
    pattern: /^deployables\/admin-web\/e2e\/catalog-staging-provider-sync\.uat\.spec\.ts$/,
    reason:
      "Manual staging UAT spec; it is outside the CI grep suite catalog, and its synthetic tests run in the Catalog UAT Synthetic Tests gate instead.",
  },
  {
    pattern: /^deployables\/public-web\/e2e\/.*\.spec\.ts$/,
    reason:
      "public-presence/public-web deployed-target spec: the public-web Playwright project only exists when PUBLIC_WEB_URL names a running public-web host, and the PR browser-e2e systems boot admin-web or the Corten marketplace only. It runs through test:e2e:deployed in the staging advisory evidence lane.",
  },
]);

const boundedContextRouteSuiteOwnership = [
  {
    pattern: /^bounded-contexts\/channels\/routes\/marketplace\/account-channels-connection\./,
    suites: [marketplaceBrowser],
  },
  {
    pattern:
      /^bounded-contexts\/fulfillment\/(?:routes\/admin\/return-intake|features\/return-shipments\/(?:api|ui)\/)/,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/marketplace\/routes\/admin\/listing-evidence-policy\./,
    suites: ["admin_platform"],
  },
  {
    pattern: /^bounded-contexts\/marketplace\/features\/listing-evidence-policy\/(?:api|ui)\//,
    suites: ["admin_platform"],
  },
  {
    pattern: /^bounded-contexts\/identity\/routes\/admin\/accounts/,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/identity\/routes\/admin\/invitations/,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/identity\/routes\/admin\/api-keys/,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/identity\/features\/accounts\/(?:api|ui)\//,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/identity\/features\/invitations\/(?:api|ui)\//,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/identity\/features\/api-keys\/(?:api|ui)\//,
    suites: ["admin_access"],
  },
  {
    pattern:
      /^bounded-contexts\/commercial-terms\/(?:routes\/admin|features\/(?:agreements|home|schedules)\/ui\/routes)\//,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/commercial-terms\/(?:routes\/public|features\/marketplace-sales-fee\/ui\/routes)\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/commercial-terms\/features\/(?:schedules|agreements|resolutions)\/(?:api|ui)\//,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/ordering\/routes\/admin\/postage-policies/,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/ordering\/features\/postage-policies\/(?:api|ui)\//,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/inventory\/features\/recovered-items\/(?:api|ui)\//,
    suites: ["admin_commerce"],
  },
  {
    pattern: /^bounded-contexts\/discovery\/routes\/admin\/google-shopping\./,
    suites: ["admin_growth"],
  },
  {
    pattern: /^bounded-contexts\/discovery\/features\/google-shopping-operations\/(?:api|ui)\//,
    suites: ["admin_growth"],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/routes\/admin\/waitlist\./,
    suites: ["admin_growth"],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/features\/waitlist\/(?:api|ui)\//,
    suites: ["admin_growth"],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/routes\/admin\/promo-bar\./,
    suites: ["admin_growth"],
  },
  {
    pattern: /^bounded-contexts\/platform-operations\/routes\/admin\/request(?:s|-detail)/,
    suites: ["admin_support"],
  },
  {
    pattern: /^bounded-contexts\/platform-operations\/features\/support-requests\/(?:api|ui)\//,
    suites: ["admin_support"],
  },
  {
    pattern: /^bounded-contexts\/platform-operations\/routes\/admin\/platform-feedback/,
    suites: ["admin_support"],
  },
  {
    pattern: /^bounded-contexts\/platform-operations\/routes\/admin\/projection-operations/,
    suites: ["admin_platform"],
  },
  {
    pattern: /^bounded-contexts\/customer-feedback\/(?:routes\/admin\/|features\/attention\/(?:api|ui)\/)/,
    suites: ["admin_support"],
  },
  {
    pattern: /^bounded-contexts\/catalog\/routes\/admin\/integrations\./,
    suites: ["catalog_admin_integrations"],
  },
  {
    pattern: /^bounded-contexts\/catalog\/routes\/admin\/integrations-/,
    suites: ["catalog_admin_integrations"],
  },
  {
    pattern: /^bounded-contexts\/catalog\/routes\/admin\/dimensions(?:-detail)?\./,
    suites: ["catalog_admin_modeling"],
  },
  {
    pattern: /^bounded-contexts\/catalog\/features\/dimensions\/(?:api|ui)\//,
    suites: ["catalog_admin_modeling"],
  },
  {
    pattern: /^bounded-contexts\/catalog\/routes\/admin\//,
    suites: ["catalog_admin_modeling"],
  },
  {
    pattern: /^bounded-contexts\/identity\/routes\/marketplace\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/marketplace\/routes\/marketplace\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/platform-operations\/routes\/marketplace\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/auth\/routes\/marketplace\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/auth\/routes\/(?:access-admin|catalog-admin)\//,
    suites: ["admin_auth", "admin_access"],
  },
  {
    pattern: /^bounded-contexts\/checkout\/routes\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/discovery\/routes\/(?:search|public-|account-product-alerts|set\.)/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/identity\/routes\/admin\//,
    suites: ["admin_access"],
  },
  {
    pattern: /^bounded-contexts\/marketplace\/routes\/account-(?:desk|listing|listings|offer)/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/ordering\/routes\/account-(?:purchase|sale)/,
    suites: [marketplaceBrowser],
  },
  {
    pattern:
      /^bounded-contexts\/payments\/(?:routes\/marketplace|features\/payments\/ui\/routes)\/account-payment(?:-methods|-new)/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/pricing\/routes\/marketplace\/account-repricing/,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/settlement\/routes\/marketplace\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/marketplace\/routes\/account-listing\./,
    suites: [marketplaceBrowser],
  },
  {
    // The item detail page and its market-history and rail-analytics resource routes.
    pattern: /^bounded-contexts\/discovery\/routes\/item-detail(?:\.|-market-history\.|-rail-analytics\.)/,
    suites: [marketplaceBrowser],
  },
  {
    // The sell handoff into a checkout session.
    pattern: /^bounded-contexts\/checkout\/routes\/sell-checkout-session\./,
    suites: [marketplaceBrowser],
  },
  {
    // The signed-in payment confirmation and the guest checkout-payment claim entry point.
    pattern:
      /^bounded-contexts\/payments\/(?:routes\/marketplace|features\/payments\/ui\/routes)\/(?:account-payment|checkout-payment)\./,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/(?:routes\/marketplace|features\/policies\/ui\/routes)\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/routes\/developers\//,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/public-presence\/features\/waitlist\/ui\/public-pages\./,
    suites: [marketplaceBrowser],
  },
  {
    pattern:
      /^bounded-contexts\/notifications\/(?:routes|features\/notification-center\/ui\/routes)\/account-notifications\./,
    suites: [marketplaceBrowser],
  },
  {
    pattern: /^bounded-contexts\/fulfillment\/routes\/seller-shipping-setup\.tsx$/,
    suites: [marketplaceBrowser],
  },
];

function normalizeFilePath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesAny(filePath, patterns) {
  return patterns.some((pattern) => pattern.test(filePath));
}

export function isBrowserRuntimeFile(filePath) {
  return matchesAny(normalizeFilePath(filePath), browserRuntimePatterns);
}

export function isDesignSystemNavigationFile(filePath) {
  return isDesignSystemNavigationRiskPath(filePath);
}

export function orderE2eSuiteIds(suiteIds) {
  return [...new Set(suiteIds)].sort((left, right) => (suiteOrder.get(left) ?? 999) - (suiteOrder.get(right) ?? 999));
}

// A suite declared unpaired gets its own batch; the rest keep duration balancing.
export function batchE2eSuiteIds(suiteIds, batchSize = defaultSuiteBatchSize) {
  const selectedSuiteIds = orderE2eSuiteIds(suiteIds);
  const unpairedSuiteIds = selectedSuiteIds.filter((suiteId) => e2eSuiteById(suiteId)?.unpaired === true);
  const orderedSuiteIds = selectedSuiteIds.filter((suiteId) => !unpairedSuiteIds.includes(suiteId));
  const safeBatchSize = Math.max(1, batchSize);
  const batchCount = Math.ceil(orderedSuiteIds.length / safeBatchSize);
  const batches = Array.from({ length: batchCount }, (_entry, index) => ({
    estimatedDurationSeconds: 0,
    index,
    suiteIds: [],
  }));

  const suiteIdsByDescendingDuration = [...orderedSuiteIds].sort((left, right) => {
    const durationDelta = estimatedE2eSuiteDurationSeconds(right) - estimatedE2eSuiteDurationSeconds(left);
    return durationDelta === 0 ? (suiteOrder.get(left) ?? 999) - (suiteOrder.get(right) ?? 999) : durationDelta;
  });

  for (const suiteId of suiteIdsByDescendingDuration) {
    const targetBatch = batches
      .filter((batch) => batch.suiteIds.length < safeBatchSize)
      .sort(
        (left, right) =>
          left.estimatedDurationSeconds - right.estimatedDurationSeconds ||
          left.suiteIds.length - right.suiteIds.length ||
          left.index - right.index,
      )[0];

    targetBatch.suiteIds.push(suiteId);
    targetBatch.estimatedDurationSeconds += estimatedE2eSuiteDurationSeconds(suiteId);
  }

  return [...batches.map((batch) => orderE2eSuiteIds(batch.suiteIds).join(",")), ...unpairedSuiteIds];
}

export function e2eSuiteById(suiteId) {
  return suitesById.get(suiteId);
}

export const renderedCopyOwningSuiteIds = Object.freeze([
  "catalog_admin_integrations",
  "catalog_admin_modeling",
  "admin_growth",
  "admin_commerce",
  "admin_support",
  "admin_access",
]);

// Ordinary balancing stays generic. Only browser dispatch isolates this substrate.
export function batchBrowserE2eSuiteIds(suiteIds) {
  const dedicated =
    suiteIds.includes("rendered_copy") || suiteIds.some((id) => renderedCopyOwningSuiteIds.includes(id));
  return [
    ...batchE2eSuiteIds(suiteIds.filter((id) => id !== "rendered_copy")),
    ...(dedicated ? ["rendered_copy"] : []),
  ];
}

export function estimatedE2eSuiteDurationSeconds(suiteId) {
  return e2eSuiteById(suiteId)?.estimatedDurationSeconds ?? fallbackEstimatedSuiteDurationSeconds;
}

export function isE2eSpecFile(filePath) {
  return /^deployables\/(?:admin-web|public-web|corten-pilot)\/e2e\/.*\.spec\.ts$/.test(normalizeFilePath(filePath));
}

export function isRouteFile(filePath) {
  const normalized = normalizeFilePath(filePath);
  if (/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized)) {
    return false;
  }

  return (
    /^deployables\/admin-web\/app\/routes\/.*\.(?:ts|tsx|js|jsx)$/.test(normalized) ||
    /^bounded-contexts\/[^/]+\/routes\/.*\.(?:ts|tsx|js|jsx)$/.test(normalized)
  );
}

export function e2eNoSuiteExclusionForChangedFile(filePath) {
  const normalized = normalizeFilePath(filePath);
  return e2eNoSuiteExclusions.find((exclusion) => exclusion.pattern.test(normalized)) ?? null;
}

function e2eSpecSuiteIdsForChangedFile(filePath) {
  for (const specOwnership of e2eSpecSuiteOwnership) {
    if (specOwnership.pattern.test(filePath)) {
      return specOwnership.suites;
    }
  }

  return e2eNoSuiteExclusionForChangedFile(filePath) ? [] : allBrowserSuiteIds;
}

function isTestOnlyOrDocumentationFile(filePath) {
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
    /(?:^|\/)(?:__tests__|tests|test-support)\//.test(filePath) ||
    /\.(?:md|mdx)$/.test(filePath)
  );
}

function boundedContextSuiteIdsForChangedFile(filePath, contextName) {
  if (isTestOnlyOrDocumentationFile(filePath)) {
    return [];
  }

  for (const routeOwnership of boundedContextRouteSuiteOwnership) {
    if (routeOwnership.pattern.test(filePath)) {
      return routeOwnership.suites;
    }
  }

  if (/(?:^|\/)routes\//.test(filePath)) {
    if (/^bounded-contexts\/[^/]+\/routes\/marketplace\//.test(filePath)) {
      return marketplaceContextRouteSuiteOwnership.get(contextName) ?? [];
    }
    if (/^bounded-contexts\/[^/]+\/routes\/(?:admin|access-admin|catalog-admin)\//.test(filePath)) {
      return adminContextRouteSuiteOwnership.get(contextName) ?? [];
    }
    if (/^bounded-contexts\/[^/]+\/features\/[^/]+\/ui\/routes\//.test(filePath)) {
      return contextSuiteOwnership.get(contextName) ?? [];
    }

    return [];
  }

  return contextSuiteOwnership.get(contextName) ?? [];
}

function ordinaryE2eSuiteIdsForChangedFile(filePath) {
  const normalized = normalizeFilePath(filePath);

  // Any platform-pr.yml edit intentionally runs admin_auth; no hunk parsing.
  if (normalized === ".github/workflows/platform-pr.yml" || normalized === "scripts/playwright-chromium-install.mjs") {
    return ["admin_auth"];
  }

  if (normalized === "deployables/platform-api/__tests__/mcp-sdk-agent-journey.e2e.test.ts") {
    return ["platform_mcp_sdk"];
  }

  if (
    normalized.startsWith("deployables/tcgplayer-operator-extension/") ||
    normalized.startsWith("bounded-contexts/catalog/features/operator-session/domain/extension/") ||
    normalized.startsWith("bounded-contexts/catalog/features/operator-session/ui/extension-popup/") ||
    normalized.startsWith("bounded-contexts/catalog/features/operator-session/tests/extension/") ||
    normalized === "bounded-contexts/catalog/client.ts" ||
    normalized === "contracts/localization/locales/en/catalog/operator-extension.ts"
  ) {
    return ["tcgplayer_operator_extension"];
  }

  if (
    normalized.startsWith("deployables/tcgplayer-connector-extension/") ||
    normalized.startsWith("bounded-contexts/channels/features/connector-client/")
  ) {
    return ["tcgplayer_connector_extension"];
  }

  if (isE2eSpecFile(normalized)) {
    return e2eSpecSuiteIdsForChangedFile(normalized);
  }

  if (isBrowserRuntimeFile(normalized)) {
    return allBrowserSuiteIds;
  }

  if (normalized.startsWith("deployables/admin-web/")) {
    return isTestOnlyOrDocumentationFile(normalized) ? [] : allAdminWebSuiteIds;
  }

  if (normalized.startsWith("deployables/platform-api/")) {
    return isTestOnlyOrDocumentationFile(normalized) ? [] : allBrowserSuiteIds;
  }

  if (normalized.startsWith("packages/design-system/")) {
    if (isTestOnlyOrDocumentationFile(normalized)) {
      return [];
    }

    return isDesignSystemNavigationFile(normalized) ? allBrowserSuiteIds : allMarketplaceSuiteIds;
  }

  if (normalized === "bounded-contexts/auth/support/runtime-support/seed.ts") {
    return boundedContextSuiteIdsForChangedFile(normalized, "auth");
  }

  const boundedContextMatch = normalized.match(
    /^bounded-contexts\/([^/]+)\/(?:(?:routes\/)|(?:features\/[^/]+\/(?:api|ui)\/)|(?:support\/shell-support\/))/,
  );
  if (!boundedContextMatch) {
    return [];
  }

  return boundedContextSuiteIdsForChangedFile(normalized, boundedContextMatch[1] ?? "");
}

function selectionsForChangedFile(filePath) {
  const normalized = normalizeFilePath(filePath);
  const suites = ordinaryE2eSuiteIdsForChangedFile(normalized);
  const agentApps =
    normalized.startsWith("deployables/agent-apps/") ||
    /^bounded-contexts\/discovery\/(?:features\/search\/ui\/agent-product-cards|support\/ui-support\/agent-product-cards|web\.ts$)/.test(
      normalized,
    ) ||
    /^bounded-contexts\/checkout\/(?:features\/sessions\/ui\/agent-(?:cart-review|checkout)|support\/ui-support\/agent-checkout-views|web\.ts$)/.test(
      normalized,
    ) ||
    // The Checkout widgets' copy source; en.ts is generated from it.
    normalized === "contracts/localization/locales/en/checkout.ts" ||
    /^infrastructure\/platform-runtime\/(?:mcp-widget-resources|public-product-urls|ucp-contracts)\.ts$/.test(
      normalized,
    );
  const seedFamily =
    /^bounded-contexts\/(?:auth|catalog|checkout|commercial-terms|fulfillment|identity|inventory|marketplace|ordering|payments|platform-operations|pricing|settlement)\/support\/(?:runtime-support|authoring-support)\/seed\.ts$/.test(
      normalized,
    );
  return [
    ...suites,
    ...(agentApps ? ["agent_apps"] : []),
    ...(seedFamily && !suites.some((id) => renderedCopyOwningSuiteIds.includes(id)) ? ["rendered_copy"] : []),
  ];
}

export function e2eSuiteIdsForChangedFile(filePath) {
  return orderE2eSuiteIds(selectionsForChangedFile(filePath).filter((id) => id !== marketplaceBrowser));
}

// The ownership entries that select the Corten Marketplace Browser Tests job, for the test that pins them.
// Beyond these, every non-test change to the platform API, the design system or a browser runtime file
// selects it, as each did every marketplace suite.
export function cortenMarketplaceBrowserOwnership() {
  const selecting = (suites) => suites.includes(marketplaceBrowser);
  return {
    contexts: [...contextSuiteOwnership].filter(([, suites]) => selecting(suites)).map(([name]) => name),
    marketplaceRouteContexts: [...marketplaceContextRouteSuiteOwnership]
      .filter(([, suites]) => selecting(suites))
      .map(([name]) => name),
    routePatterns: boundedContextRouteSuiteOwnership
      .filter(({ suites }) => selecting(suites))
      .map(({ pattern }) => pattern.source),
    specPatterns: e2eSpecSuiteOwnership.filter(({ suites }) => selecting(suites)).map(({ pattern }) => pattern.source),
  };
}

// Whether a change selects the Corten Marketplace Browser Tests job through the same context, route and spec
// ownership that selected a marketplace suite while marketplace-web served the marketplace.
export function cortenMarketplaceBrowserSelectedByChangedFile(filePath) {
  return selectionsForChangedFile(filePath).includes(marketplaceBrowser);
}

export function chromiumProbeCallerViolations(workspaces, suites = e2eSuites) {
  return workspaces.flatMap((workspace) => {
    const packageJson = workspace.packageJson ?? workspace;
    if (typeof packageJson?.scripts?.["test:chromium"] !== "string") return [];
    const expectedCommand = ["--filter", packageJson.name, "run", "test:chromium"];
    const callers = suites.filter(
      (suite) => Array.isArray(suite.command) && JSON.stringify(suite.command) === JSON.stringify(expectedCommand),
    );
    return callers.length === 1
      ? []
      : [`${packageJson.name} test:chromium must have exactly one registered E2E command caller`];
  });
}
