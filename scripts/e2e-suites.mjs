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

export function e2eSuiteById(suiteId) {
  return e2eSuites.find((suite) => suite.id === suiteId);
}

export function e2eSuiteIdsForChangedFile(filePath) {
  const normalized = normalizeFilePath(filePath);

  if (isBrowserRuntimeFile(normalized)) {
    return allMarketplaceSuiteIds;
  }

  if (
    normalized.startsWith("deployables/marketplace/") ||
    normalized.startsWith("deployables/platform-api/") ||
    normalized.startsWith("packages/design-system/")
  ) {
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
