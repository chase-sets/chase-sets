export const e2eSuites = Object.freeze([
  {
    id: "marketplace_browse",
    label: "Marketplace Browse",
    deployable: "marketplace",
    journeys: ["browse", "search", "auth entry"],
    grep: "@marketplace-browse",
  },
  {
    id: "marketplace_account",
    label: "Marketplace Account",
    deployable: "marketplace",
    journeys: ["account access", "authentication"],
    grep: "@marketplace-account",
  },
  {
    id: "marketplace_checkout",
    label: "Marketplace Checkout",
    deployable: "marketplace",
    journeys: ["buy cart", "sell list", "checkout"],
    grep: "@marketplace-checkout",
  },
  {
    id: "marketplace_seller",
    label: "Marketplace Seller",
    deployable: "marketplace",
    journeys: ["listings", "offers", "seller operations"],
    grep: "@marketplace-seller",
  },
]);

const suiteOrder = new Map(e2eSuites.map((suite, index) => [suite.id, index]));
const allMarketplaceSuiteIds = e2eSuites.filter((suite) => suite.deployable === "marketplace").map((suite) => suite.id);
const defaultSuiteBatchSize = 2;

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
  /^scripts\/run-e2e-suite\.mjs$/,
];

const contextSuiteOwnership = new Map([
  ["auth", ["marketplace_account"]],
  ["catalog", ["marketplace_browse"]],
  ["checkout", ["marketplace_checkout"]],
  ["commercial-terms", ["marketplace_browse", "marketplace_seller"]],
  ["discovery", ["marketplace_browse"]],
  ["fulfillment", ["marketplace_account"]],
  ["identity", ["marketplace_account"]],
  ["inventory", ["marketplace_seller"]],
  ["marketplace", ["marketplace_account", "marketplace_seller"]],
  ["ordering", ["marketplace_account", "marketplace_checkout"]],
  ["payments", ["marketplace_account", "marketplace_checkout"]],
  ["pricing", ["marketplace_browse"]],
  ["reputation", ["marketplace_account"]],
  ["settlement", ["marketplace_account", "marketplace_seller"]],
  ["support", ["marketplace_account"]],
]);

const marketplaceRouteSuiteOwnership = [
  {
    pattern: /^deployables\/marketplace\/app\/routes\/(?:search|_index|index)\./,
    suites: ["marketplace_browse"],
  },
  {
    pattern: /^deployables\/marketplace\/app\/routes\/(?:account-payment|checkout-payment)/,
    suites: ["marketplace_checkout"],
  },
  {
    pattern:
      /^deployables\/marketplace\/app\/routes\/(?:account-listing|account-listings|account-inventory|account-offers|account-repricing)/,
    suites: ["marketplace_seller"],
  },
  {
    pattern:
      /^deployables\/marketplace\/app\/routes\/(?:account-purchase|account-sale|account-review|account-payout|account-settlement|account-support)/,
    suites: ["marketplace_account"],
  },
  {
    pattern: /^deployables\/marketplace\/app\/(?:auth\.server|root)\./,
    suites: ["marketplace_account", "marketplace_browse"],
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

export function orderE2eSuiteIds(suiteIds) {
  return [...new Set(suiteIds)].sort((left, right) => (suiteOrder.get(left) ?? 999) - (suiteOrder.get(right) ?? 999));
}

export function batchE2eSuiteIds(suiteIds, batchSize = defaultSuiteBatchSize) {
  const orderedSuiteIds = orderE2eSuiteIds(suiteIds);
  const safeBatchSize = Math.max(1, batchSize);
  const batches = [];

  for (let index = 0; index < orderedSuiteIds.length; index += safeBatchSize) {
    batches.push(orderedSuiteIds.slice(index, index + safeBatchSize).join(","));
  }

  return batches;
}

export function e2eSuiteById(suiteId) {
  return e2eSuites.find((suite) => suite.id === suiteId);
}

function isTestOnlyOrDocumentationFile(filePath) {
  return (
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(filePath) ||
    /(?:^|\/)(?:__tests__|tests)\//.test(filePath) ||
    /\.(?:md|mdx)$/.test(filePath)
  );
}

function marketplaceDeployableSuiteIdsForChangedFile(filePath) {
  if (isTestOnlyOrDocumentationFile(filePath)) {
    return [];
  }

  for (const routeOwnership of marketplaceRouteSuiteOwnership) {
    if (routeOwnership.pattern.test(filePath)) {
      return routeOwnership.suites;
    }
  }

  return allMarketplaceSuiteIds;
}

export function e2eSuiteIdsForChangedFile(filePath) {
  const normalized = normalizeFilePath(filePath);

  if (isBrowserRuntimeFile(normalized)) {
    return allMarketplaceSuiteIds;
  }

  if (normalized.startsWith("deployables/marketplace/")) {
    return marketplaceDeployableSuiteIdsForChangedFile(normalized);
  }

  if (normalized.startsWith("deployables/platform-api/")) {
    return isTestOnlyOrDocumentationFile(normalized) ? [] : allMarketplaceSuiteIds;
  }

  if (normalized.startsWith("packages/design-system/")) {
    if (isTestOnlyOrDocumentationFile(normalized)) {
      return [];
    }

    return allMarketplaceSuiteIds;
  }

  const boundedContextMatch = normalized.match(
    /^bounded-contexts\/([^/]+)\/(?:(?:routes\/)|(?:features\/[^/]+\/(?:api|ui)\/)|(?:support\/shell-support\/))/,
  );
  if (!boundedContextMatch) {
    return [];
  }

  return contextSuiteOwnership.get(boundedContextMatch[1] ?? "") ?? allMarketplaceSuiteIds;
}
