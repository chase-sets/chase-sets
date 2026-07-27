import {
  type McpServiceDescriptor,
  integerProperty,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const pricingService = {
  ...service(
    "pricing",
    "Pricing",
    "bounded-contexts/pricing",
    "Market price snapshots, pricing signals, and price recommendations.",
    "pricing.view",
    ["price-recommendation"],
    {
      packageName: "@chase-sets/pricing",
    },
  ),
  tools: [
    {
      ...readTool(
        "pricing",
        "recommend-price",
        "Recommend Price",
        "Get existing seller price recommendations for a Catalog Item natural key.",
        "pricing.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Catalog Item natural key."),
            limit: integerProperty("Maximum recommendations to return."),
            offset: integerProperty("Result offset."),
          },
          ["accountId", "catalogItemId"],
        ),
        "price-recommendation",
        ["Use to support seller pricing decisions, not to mutate listings directly."],
      ),
      availability: "available",
    },
    {
      ...readTool(
        "pricing",
        "explain-signals",
        "Explain Pricing Signals",
        "Explain recent market, inventory, order, and fulfillment signals used by pricing.",
        "pricing.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Catalog Item natural key."),
            productId: stringProperty("Optional resolved Product natural key."),
          },
          ["accountId", "catalogItemId"],
        ),
        "market-price-snapshot",
        ["Use when an agent needs to justify a recommendation."],
      ),
      availability: "available",
    },
  ],
  resources: [
    {
      ...resource(
        "pricing",
        "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations",
        "Price Recommendation",
        "Pricing recommendation read model for the actor account and Catalog Item natural key.",
        "pricing.view",
        ["Use before listing price updates."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
