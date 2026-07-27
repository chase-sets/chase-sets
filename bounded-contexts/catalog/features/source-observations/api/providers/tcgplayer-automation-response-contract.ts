export type TcgplayerAutomationCatalogEndpoint =
  | "product-lines"
  | "catalog-set-names"
  | "product-search"
  | "product-detail";

export type TcgplayerAutomationCatalogFieldOwner =
  | "catalog-truth"
  | "catalog-merge-evidence"
  | "external-reference"
  | "pricing-signal"
  | "inventory-signal"
  | "operations"
  | "excluded";

export type TcgplayerAutomationCatalogFieldDecision = Readonly<{
  endpoint: TcgplayerAutomationCatalogEndpoint;
  path: string;
  owner: TcgplayerAutomationCatalogFieldOwner;
  affectsObservationHash: boolean;
  note: string;
}>;

export type TcgplayerAutomationResponseAuditFinding = Readonly<{
  finding: string;
  consequence: string;
  followUpIssue: number;
}>;

export const tcgplayerAutomationCatalogRequiredFixturePaths: Readonly<
  Record<TcgplayerAutomationCatalogEndpoint, readonly string[]>
> = {
  "product-lines": ["0.productLineId", "0.productLineName", "0.productLineUrlName", "0.isDirect"],
  "catalog-set-names": [
    "results.0.setNameId",
    "results.0.categoryId",
    "results.0.name",
    "results.0.cleanSetName",
    "results.0.urlName",
    "results.0.abbreviation",
    "results.0.releaseDate",
    "results.0.isSupplemental",
    "results.0.active",
  ],
  "product-search": [
    "results.0.results.0.productId",
    "results.0.results.0.productName",
    "results.0.results.0.productLineId",
    "results.0.results.0.productLineName",
    "results.0.results.0.productTypeName",
    "results.0.results.0.setId",
    "results.0.results.0.setName",
    "results.0.results.0.setUrlName",
    "results.0.results.0.rarityName",
    "results.0.results.0.customAttributes.number",
    "results.0.results.0.customAttributes.releaseDate",
    "results.0.results.0.listings.0.productConditionId",
    "results.0.results.0.listings.0.price",
    "results.0.results.0.listings.0.sellerId",
  ],
  "product-detail": [
    "productId",
    "productName",
    "productLineId",
    "productLineName",
    "productTypeName",
    "setId",
    "setCode",
    "setName",
    "rarityName",
    "customAttributes.number",
    "customAttributes.releaseDate",
    "formattedAttributes.Artist",
    "skus.0.sku",
    "skus.0.condition",
    "skus.0.variant",
    "skus.0.language",
    "marketPrice",
    "lowestPrice",
  ],
};

export const tcgplayerAutomationCatalogFieldDecisions: readonly TcgplayerAutomationCatalogFieldDecision[] = [
  catalogTruth("product-lines", "productLineId", "Product line identity."),
  catalogTruth("product-lines", "productLineName", "Product line display name and merge discriminator."),
  catalogMerge("product-lines", "productLineUrlName", "Stable slug evidence for provider diagnostics."),
  operations("product-lines", "isDirect", "Provider channel capability; not Catalog item truth."),

  externalReference("catalog-set-names", "setNameId", "Provider set identifier for expansion reference evidence."),
  externalReference("catalog-set-names", "categoryId", "Provider product line/category identifier."),
  catalogTruth("catalog-set-names", "name", "Provider set display name."),
  catalogTruth("catalog-set-names", "cleanSetName", "Search/import set scope and merge evidence."),
  catalogMerge("catalog-set-names", "urlName", "Provider set slug evidence."),
  catalogTruth("catalog-set-names", "abbreviation", "Set abbreviation when supplied."),
  catalogTruth("catalog-set-names", "releaseDate", "Set release-date evidence."),
  catalogTruth("catalog-set-names", "isSupplemental", "Set classification evidence."),
  operations("catalog-set-names", "active", "Provider availability flag; source-payload only for Catalog."),

  externalReference("product-search", "productId", "External Catalog Item reference as tcgplayer:product:<id>."),
  catalogTruth("product-search", "productName", "Provider product name."),
  externalReference("product-search", "productLineId", "Provider product-line reference evidence."),
  catalogTruth("product-search", "productLineName", "Product-line name used for merge confidence."),
  catalogTruth("product-search", "productTypeName", "Provider product type such as Cards or Sealed Products."),
  externalReference("product-search", "setId", "Provider set reference evidence."),
  catalogTruth("product-search", "setName", "Set name observed in search results."),
  catalogMerge("product-search", "setUrlName", "Set abbreviation/slug evidence."),
  catalogTruth("product-search", "rarityName", "Rarity evidence for singles."),
  catalogTruth("product-search", "customAttributes.number", "Collector number evidence."),
  catalogTruth("product-search", "customAttributes.releaseDate", "Product release-date evidence."),
  catalogTruth("product-search", "customAttributes.cardType", "Card/product subtype evidence."),
  externalReference(
    "product-search",
    "listings.productConditionId",
    "Product condition identifier appears in listing search, not product-detail SKUs.",
  ),
  pricing("product-search", "marketPrice", "Pricing-owned signal; never Catalog truth."),
  pricing("product-search", "lowestPrice", "Pricing-owned signal; never Catalog truth."),
  pricing("product-search", "lowestPriceWithShipping", "Pricing-owned signal; never Catalog truth."),
  pricing("product-search", "totalListings", "Marketplace supply signal for Pricing or commerce analysis."),
  excluded("product-search", "listings.sellerId", "Seller identifier is not Catalog truth."),
  excluded("product-search", "listings.sellerKey", "Seller key is not Catalog truth."),
  excluded("product-search", "listings.sellerName", "Seller name is not Catalog truth."),
  pricing("product-search", "listings.price", "Listing price is Pricing-owned."),
  inventory("product-search", "listings.quantity", "Seller quantity is Inventory/commerce signal, not Catalog truth."),

  externalReference("product-detail", "productId", "External Catalog Item reference as tcgplayer:product:<id>."),
  catalogTruth("product-detail", "productName", "Provider product name."),
  externalReference("product-detail", "productLineId", "Provider product-line reference evidence."),
  catalogTruth("product-detail", "productLineName", "Product-line name used for merge confidence."),
  catalogTruth("product-detail", "productTypeName", "Provider product type such as Cards or Sealed Products."),
  externalReference("product-detail", "setId", "Provider set reference evidence."),
  catalogMerge("product-detail", "setCode", "Set abbreviation/code evidence."),
  catalogTruth("product-detail", "setName", "Set name observed in product detail."),
  catalogTruth("product-detail", "rarityName", "Rarity evidence for singles."),
  catalogTruth("product-detail", "customAttributes.number", "Collector number evidence."),
  catalogTruth("product-detail", "customAttributes.releaseDate", "Product release-date evidence."),
  catalogTruth("product-detail", "customAttributes.cardType", "Card/product subtype evidence."),
  catalogTruth("product-detail", "formattedAttributes.Artist", "Illustrator evidence when supplied."),
  externalReference("product-detail", "skus.sku", "External Product reference as tcgplayer:sku:<id>."),
  catalogMerge("product-detail", "skus.condition", "Selected option evidence for SKU-backed Product references."),
  catalogMerge("product-detail", "skus.variant", "Selected option evidence for SKU-backed Product references."),
  catalogMerge("product-detail", "skus.language", "Selected option evidence for SKU-backed Product references."),
  pricing("product-detail", "marketPrice", "Pricing-owned signal; never Catalog truth."),
  pricing("product-detail", "lowestPrice", "Pricing-owned signal; never Catalog truth."),
  pricing("product-detail", "lowestPriceWithShipping", "Pricing-owned signal; never Catalog truth."),
  pricing("product-detail", "medianPrice", "Pricing-owned signal; never Catalog truth."),
  pricing("product-detail", "listings", "Marketplace supply signal for Pricing or commerce analysis."),
  operations("product-detail", "sellerListable", "Provider marketplace listing capability."),
  operations(
    "product-detail",
    "productStatusId",
    "Provider status diagnostic; not promoted as Catalog truth without review.",
  ),
];

export const tcgplayerAutomationResponseAuditFindings: readonly TcgplayerAutomationResponseAuditFinding[] = [
  {
    finding:
      "The automation app's product-detail SKU shape contains sku, condition, variant, and language, but not productConditionId.",
    consequence:
      "Catalog can create tcgplayer:sku:<id> Product references from product detail, but productConditionId must only be mapped when a response fixture proves the endpoint supplies it.",
    followUpIssue: 616,
  },
  {
    finding:
      "Search and detail responses include price, listing count, seller, and quantity fields beside Catalog facts.",
    consequence:
      "Those fields must remain source-payload evidence or Pricing/Inventory handoff signals and must not affect Catalog observation hashes.",
    followUpIssue: 616,
  },
  {
    finding: "The automation app uses workflow-specific TypeScript types and some unknown/any fields.",
    consequence:
      "Catalog import DTOs must be expanded from sanitized fixtures before new fields are used for merge or promotion.",
    followUpIssue: 616,
  },
];

export function tcgplayerCatalogHashFieldPaths(endpoint: TcgplayerAutomationCatalogEndpoint): readonly string[] {
  return tcgplayerAutomationCatalogFieldDecisions
    .filter((decision) => decision.endpoint === endpoint && decision.affectsObservationHash)
    .map((decision) => decision.path);
}

export function tcgplayerSourcePayloadOnlyFieldPaths(endpoint: TcgplayerAutomationCatalogEndpoint): readonly string[] {
  return tcgplayerAutomationCatalogFieldDecisions
    .filter((decision) => decision.endpoint === endpoint && !decision.affectsObservationHash)
    .map((decision) => decision.path);
}

export function tcgplayerFindFieldDecision(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
): TcgplayerAutomationCatalogFieldDecision | null {
  return (
    tcgplayerAutomationCatalogFieldDecisions.find(
      (decision) => decision.endpoint === endpoint && decision.path === path,
    ) ?? null
  );
}

function catalogTruth(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "catalog-truth", affectsObservationHash: true, note };
}

function catalogMerge(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "catalog-merge-evidence", affectsObservationHash: true, note };
}

function externalReference(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "external-reference", affectsObservationHash: true, note };
}

function pricing(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "pricing-signal", affectsObservationHash: false, note };
}

function inventory(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "inventory-signal", affectsObservationHash: false, note };
}

function operations(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "operations", affectsObservationHash: false, note };
}

function excluded(
  endpoint: TcgplayerAutomationCatalogEndpoint,
  path: string,
  note: string,
): TcgplayerAutomationCatalogFieldDecision {
  return { endpoint, path, owner: "excluded", affectsObservationHash: false, note };
}
