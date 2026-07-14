export type InventoryImportSourceKey =
  | "native-csv"
  | "saved-list"
  | "tcgplayer-csv"
  | "ebay-csv"
  | "shopify-csv"
  | "whatnot-csv"
  | "cardtrader-csv";

export type InventoryImportCandidateTargetIntent =
  | "product-reference"
  | "catalog-item-reference"
  | "account-sku"
  | "source-listing-reference"
  | "source-product-reference"
  | "gtin-reference";

export type InventoryImportValueTransform = "clean" | "decimal" | "integer" | "positive-integer-or-empty";

export type InventoryImportValueMapping = Readonly<{
  targetKey: string;
  headers?: readonly string[];
  copyFrom?: string;
  fallbackValueKeys?: readonly string[];
  defaultFromInput?: "defaultStorageLocationId";
  transform?: InventoryImportValueTransform;
}>;

export type InventoryImportExternalReferenceCandidate = Readonly<{
  providerKey: string;
  externalKeyPrefix: string;
  targetIntent: InventoryImportCandidateTargetIntent;
  valueKey?: string;
  headers?: readonly string[];
}>;

export type InventoryImportSelectedOptionInferenceRule = Readonly<{
  dimensionKey: string;
  headers: readonly string[];
}>;

export type InventoryImportSourceProfile = Readonly<{
  sourceKey: InventoryImportSourceKey;
  label: string;
  kind: "csv" | "api";
  adapterVersion: number;
  nativePassthrough?: boolean;
  displayNameValueKeys: readonly string[];
  rowNoteValueKeys?: readonly string[];
  values: readonly InventoryImportValueMapping[];
  externalReferenceCandidates: readonly InventoryImportExternalReferenceCandidate[];
  selectedOptionInference: readonly InventoryImportSelectedOptionInferenceRule[];
}>;

const defaultStorage = {
  targetKey: "storageLocationId",
  defaultFromInput: "defaultStorageLocationId",
} as const satisfies InventoryImportValueMapping;

const listingQuantityCap = {
  targetKey: "listingQuantityCap",
  copyFrom: "totalQuantity",
  transform: "positive-integer-or-empty",
} as const satisfies InventoryImportValueMapping;

export const inventoryImportSourceProfiles = [
  {
    sourceKey: "native-csv",
    label: "Chase Sets CSV",
    kind: "csv",
    adapterVersion: 1,
    nativePassthrough: true,
    displayNameValueKeys: [],
    values: [
      defaultStorage,
      { targetKey: "sellerSku", headers: ["sellerSku", "Seller SKU"] },
      { targetKey: "gtin", headers: ["gtin", "GTIN", "Barcode", "UPC", "EAN"] },
    ],
    externalReferenceCandidates: [
      {
        providerKey: "gtin",
        externalKeyPrefix: "",
        valueKey: "gtin",
        targetIntent: "gtin-reference",
      },
      {
        providerKey: "account",
        externalKeyPrefix: "sku:",
        valueKey: "sellerSku",
        targetIntent: "account-sku",
      },
    ],
    selectedOptionInference: [],
  },
  {
    sourceKey: "saved-list",
    label: "Saved List",
    kind: "api",
    adapterVersion: 1,
    nativePassthrough: true,
    displayNameValueKeys: [],
    values: [],
    externalReferenceCandidates: [],
    selectedOptionInference: [],
  },
  {
    sourceKey: "tcgplayer-csv",
    label: "TCGplayer CSV",
    kind: "csv",
    adapterVersion: 1,
    displayNameValueKeys: ["title", "setName", "condition"],
    values: [
      defaultStorage,
      { targetKey: "tcgplayerSku", headers: ["SKU", "TCGplayer SKU", "TCGplayerSku", "Product SKU"] },
      {
        targetKey: "tcgplayerProductId",
        headers: ["Product ID", "ProductId", "TCGplayer Product ID", "TCGplayerProductId", "TCGplayer ID"],
      },
      {
        targetKey: "totalQuantity",
        headers: ["Quantity", "Qty", "Add to Quantity", "Total Quantity", "Inventory Quantity"],
      },
      {
        targetKey: "listingPriceAmount",
        headers: ["TCG Marketplace Price", "Marketplace Price", "My Price", "Price", "Listing Price", "TCG Low Price"],
        transform: "decimal",
      },
      {
        targetKey: "sellerSku",
        headers: ["Seller SKU", "SellerSku", "Custom SKU"],
        fallbackValueKeys: ["tcgplayerSku"],
      },
      listingQuantityCap,
      { targetKey: "sourcePriceAmount", copyFrom: "listingPriceAmount" },
      { targetKey: "sourceQuantity", copyFrom: "totalQuantity" },
      { targetKey: "title", headers: ["Product Name", "Name", "Title"] },
      { targetKey: "setName", headers: ["Set Name", "Set"] },
      { targetKey: "condition", headers: ["Condition", "Printing Condition"] },
    ],
    rowNoteValueKeys: ["title", "setName", "condition"],
    externalReferenceCandidates: [
      {
        providerKey: "tcgplayer",
        externalKeyPrefix: "sku:",
        valueKey: "tcgplayerSku",
        targetIntent: "product-reference",
      },
      {
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        valueKey: "tcgplayerProductId",
        targetIntent: "catalog-item-reference",
      },
      {
        providerKey: "account",
        externalKeyPrefix: "sku:",
        headers: ["Seller SKU", "SellerSku", "Custom SKU"],
        targetIntent: "account-sku",
      },
    ],
    selectedOptionInference: [{ dimensionKey: "condition", headers: ["Condition", "Printing Condition"] }],
  },
  {
    sourceKey: "ebay-csv",
    label: "eBay CSV",
    kind: "csv",
    adapterVersion: 1,
    displayNameValueKeys: ["title", "condition"],
    values: [
      defaultStorage,
      { targetKey: "ebayItemId", headers: ["Item ID", "ItemId", "Listing ID", "ListingId"] },
      { targetKey: "ebayVariationId", headers: ["Variation ID", "VariationId"] },
      { targetKey: "sellerSku", headers: ["Custom label", "Custom Label", "SKU", "Seller SKU", "Inventory SKU"] },
      { targetKey: "ebayEpid", headers: ["ePID", "EPID", "Product ID", "Catalog Product ID"] },
      { targetKey: "gtin", headers: ["GTIN", "EAN", "ISBN"] },
      { targetKey: "barcode", headers: ["UPC", "Barcode"], fallbackValueKeys: ["gtin"] },
      { targetKey: "title", headers: ["Title", "Item title", "Product Name"] },
      { targetKey: "condition", headers: ["Condition", "Condition Name"] },
      {
        targetKey: "totalQuantity",
        headers: ["Available quantity", "Available Quantity", "Quantity", "Qty", "Available"],
        transform: "integer",
      },
      {
        targetKey: "listingPriceAmount",
        headers: ["Current price", "Current Price", "Price", "Start price"],
        transform: "decimal",
      },
      listingQuantityCap,
      { targetKey: "sourcePriceAmount", copyFrom: "listingPriceAmount" },
      { targetKey: "sourceQuantity", copyFrom: "totalQuantity" },
    ],
    externalReferenceCandidates: [
      { providerKey: "ebay", externalKeyPrefix: "listing:", valueKey: "ebayItemId", targetIntent: "product-reference" },
      {
        providerKey: "ebay",
        externalKeyPrefix: "variation:",
        valueKey: "ebayVariationId",
        targetIntent: "product-reference",
      },
      { providerKey: "ebay", externalKeyPrefix: "sku:", valueKey: "sellerSku", targetIntent: "account-sku" },
      { providerKey: "ebay", externalKeyPrefix: "epid:", valueKey: "ebayEpid", targetIntent: "catalog-item-reference" },
      { providerKey: "gtin", externalKeyPrefix: "", valueKey: "gtin", targetIntent: "gtin-reference" },
      { providerKey: "gtin", externalKeyPrefix: "", valueKey: "barcode", targetIntent: "gtin-reference" },
    ],
    selectedOptionInference: [{ dimensionKey: "condition", headers: ["Condition", "Condition Name"] }],
  },
  {
    sourceKey: "shopify-csv",
    label: "Shopify CSV",
    kind: "csv",
    adapterVersion: 1,
    displayNameValueKeys: ["title", "variantTitle"],
    values: [
      defaultStorage,
      { targetKey: "shopifyProductId", headers: ["Product ID", "ProductId", "ID"] },
      { targetKey: "shopifyVariantId", headers: ["Variant ID", "VariantId"] },
      { targetKey: "handle", headers: ["Handle"] },
      { targetKey: "title", headers: ["Title", "Product Title"] },
      { targetKey: "variantTitle", headers: ["Variant Title", "Option1 Value", "Option 1 Value"] },
      { targetKey: "sellerSku", headers: ["Variant SKU", "SKU"] },
      { targetKey: "barcode", headers: ["Variant Barcode", "Barcode", "UPC"] },
      {
        targetKey: "totalQuantity",
        headers: ["Variant Inventory Qty", "Available", "On hand", "New On Hand", "Quantity", "Inventory Quantity"],
        transform: "integer",
      },
      { targetKey: "listingPriceAmount", headers: ["Variant Price", "Price"], transform: "decimal" },
      listingQuantityCap,
      { targetKey: "sourcePriceAmount", copyFrom: "listingPriceAmount" },
      { targetKey: "sourceQuantity", copyFrom: "totalQuantity" },
    ],
    externalReferenceCandidates: [
      {
        providerKey: "shopify",
        externalKeyPrefix: "variant:",
        valueKey: "shopifyVariantId",
        targetIntent: "product-reference",
      },
      {
        providerKey: "shopify",
        externalKeyPrefix: "product:",
        valueKey: "shopifyProductId",
        targetIntent: "catalog-item-reference",
      },
      { providerKey: "shopify", externalKeyPrefix: "sku:", valueKey: "sellerSku", targetIntent: "account-sku" },
      { providerKey: "gtin", externalKeyPrefix: "", valueKey: "barcode", targetIntent: "gtin-reference" },
      {
        providerKey: "shopify",
        externalKeyPrefix: "handle:",
        valueKey: "handle",
        targetIntent: "catalog-item-reference",
      },
    ],
    selectedOptionInference: [
      { dimensionKey: "condition", headers: ["Variant Title", "Option1 Value", "Option 1 Value"] },
    ],
  },
  {
    sourceKey: "whatnot-csv",
    label: "Whatnot CSV",
    kind: "csv",
    adapterVersion: 1,
    displayNameValueKeys: ["title", "condition"],
    values: [
      defaultStorage,
      { targetKey: "whatnotProductId", headers: ["Product ID", "ProductId"] },
      { targetKey: "whatnotListingId", headers: ["Listing ID", "ListingId", "Item ID"] },
      { targetKey: "whatnotInventoryId", headers: ["Inventory ID", "InventoryId"] },
      { targetKey: "sellerSku", headers: ["SKU", "Seller SKU", "Custom SKU"] },
      { targetKey: "title", headers: ["Title", "Product Name", "Name"] },
      { targetKey: "condition", headers: ["Condition"] },
      { targetKey: "totalQuantity", headers: ["Quantity", "Qty", "Available"], transform: "integer" },
      {
        targetKey: "listingPriceAmount",
        headers: ["Price", "Buy It Now Price", "Listing Price"],
        transform: "decimal",
      },
      listingQuantityCap,
      { targetKey: "sourcePriceAmount", copyFrom: "listingPriceAmount" },
      { targetKey: "sourceQuantity", copyFrom: "totalQuantity" },
    ],
    externalReferenceCandidates: [
      {
        providerKey: "whatnot",
        externalKeyPrefix: "product:",
        valueKey: "whatnotProductId",
        targetIntent: "catalog-item-reference",
      },
      {
        providerKey: "whatnot",
        externalKeyPrefix: "listing:",
        valueKey: "whatnotListingId",
        targetIntent: "product-reference",
      },
      {
        providerKey: "whatnot",
        externalKeyPrefix: "inventory:",
        valueKey: "whatnotInventoryId",
        targetIntent: "product-reference",
      },
      { providerKey: "whatnot", externalKeyPrefix: "sku:", valueKey: "sellerSku", targetIntent: "account-sku" },
    ],
    selectedOptionInference: [{ dimensionKey: "condition", headers: ["Condition"] }],
  },
  {
    sourceKey: "cardtrader-csv",
    label: "CardTrader CSV",
    kind: "csv",
    adapterVersion: 1,
    displayNameValueKeys: ["title", "expansion", "condition"],
    values: [
      defaultStorage,
      { targetKey: "cardTraderProductId", headers: ["Product ID", "ProductId", "CardTrader Product ID"] },
      { targetKey: "cardTraderBlueprintId", headers: ["Blueprint ID", "BlueprintId", "CardTrader Blueprint ID"] },
      { targetKey: "cardTraderArticleId", headers: ["Article ID", "ArticleId", "Inventory ID"] },
      { targetKey: "sellerSku", headers: ["SKU", "Seller SKU", "User Data"] },
      { targetKey: "tcgplayerProductId", headers: ["TCGplayer ID", "TCGplayerId", "TCG Player ID"] },
      { targetKey: "cardmarketProductId", headers: ["Cardmarket ID", "CardMarket ID", "idProduct"] },
      { targetKey: "title", headers: ["Name", "Title", "Product Name"] },
      { targetKey: "expansion", headers: ["Expansion", "Set Name", "Set"] },
      { targetKey: "condition", headers: ["Condition"] },
      { targetKey: "totalQuantity", headers: ["Quantity", "Qty", "Available"], transform: "integer" },
      { targetKey: "listingPriceAmount", headers: ["Price", "Selling Price", "Listing Price"], transform: "decimal" },
      listingQuantityCap,
      { targetKey: "sourcePriceAmount", copyFrom: "listingPriceAmount" },
      { targetKey: "sourceQuantity", copyFrom: "totalQuantity" },
    ],
    externalReferenceCandidates: [
      {
        providerKey: "cardtrader",
        externalKeyPrefix: "product:",
        valueKey: "cardTraderProductId",
        targetIntent: "catalog-item-reference",
      },
      {
        providerKey: "cardtrader",
        externalKeyPrefix: "blueprint:",
        valueKey: "cardTraderBlueprintId",
        targetIntent: "catalog-item-reference",
      },
      {
        providerKey: "cardtrader",
        externalKeyPrefix: "article:",
        valueKey: "cardTraderArticleId",
        targetIntent: "product-reference",
      },
      { providerKey: "cardtrader", externalKeyPrefix: "sku:", valueKey: "sellerSku", targetIntent: "account-sku" },
      {
        providerKey: "tcgplayer",
        externalKeyPrefix: "product:",
        valueKey: "tcgplayerProductId",
        targetIntent: "catalog-item-reference",
      },
      {
        providerKey: "cardmarket",
        externalKeyPrefix: "product:",
        valueKey: "cardmarketProductId",
        targetIntent: "catalog-item-reference",
      },
    ],
    selectedOptionInference: [{ dimensionKey: "condition", headers: ["Condition"] }],
  },
] as const satisfies readonly InventoryImportSourceProfile[];

export function listInventoryImportSourceProfiles(): readonly InventoryImportSourceProfile[] {
  return inventoryImportSourceProfiles;
}

export function getInventoryImportSourceProfile(
  sourceKey: string | null | undefined,
): InventoryImportSourceProfile | null {
  const normalized = (sourceKey ?? "").trim() || "native-csv";
  return inventoryImportSourceProfiles.find((profile) => profile.sourceKey === normalized) ?? null;
}
