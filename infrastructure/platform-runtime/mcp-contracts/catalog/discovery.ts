import {
  type McpJsonSchema,
  type McpServiceDescriptor,
  arrayProperty,
  integerProperty,
  objectSchema,
  publicBoundary,
  readTool,
  resource,
  service,
  stringProperty,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const discoverySearchOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["items", "total", "count", "nextCursor"],
  properties: {
    items: arrayProperty("Public discovery search rows.", {
      type: "object",
      description: "Public discovery item row.",
      additionalProperties: true,
      required: ["catalog_item_id", "slug", "title", "status"],
      properties: {
        catalog_item_id: stringProperty("Catalog item identifier."),
        slug: stringProperty("Public item slug."),
        title: stringProperty("Public item title."),
        subtitle: stringProperty("Optional public item subtitle."),
        status: stringProperty("Public lifecycle status.", ["active"]),
      },
    }),
    facets: arrayProperty("Search facet groups.", {
      type: "object",
      description: "Facet group.",
      additionalProperties: true,
      properties: {},
    }),
    total: integerProperty("Total matching public item count."),
    count: integerProperty("Returned public item count."),
    nextCursor: stringProperty("Cursor for the next page when available."),
  },
};

const discoveryItemDetailOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["catalog_item_id", "slug", "title", "status", "market_listings"],
  properties: {
    catalog_item_id: stringProperty("Catalog item identifier."),
    slug: stringProperty("Public item slug."),
    title: stringProperty("Public item title."),
    subtitle: stringProperty("Optional public item subtitle."),
    description: stringProperty("Public item description."),
    status: stringProperty("Public lifecycle status.", ["active"]),
    market_listings: arrayProperty("Buyer-visible active listings.", {
      type: "object",
      description: "Buyer-visible active listing.",
      additionalProperties: true,
      required: ["listing_id", "product_id", "price_amount", "visible_quantity", "status"],
      properties: {
        listing_id: stringProperty("Listing identifier."),
        product_id: stringProperty("Product identifier."),
        price_amount: stringProperty("Listing unit price."),
        visible_quantity: integerProperty("Buyer-visible quantity."),
        status: stringProperty("Buyer-visible listing status.", ["active"]),
      },
    }),
  },
};

const discoveryChatGptFeedOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["feedFormat", "products", "total", "count", "nextCursor"],
  properties: {
    feedFormat: stringProperty("Feed format identifier.", ["chatgpt-product-feed/v1"]),
    products: arrayProperty("ChatGPT product feed rows.", {
      type: "object",
      description: "ChatGPT product feed product.",
      additionalProperties: true,
      required: ["id", "title", "url", "availability", "price", "variants"],
      properties: {
        id: stringProperty("Catalog item identifier."),
        title: stringProperty("Product title."),
        subtitle: stringProperty("Optional product subtitle."),
        description: stringProperty("Product description."),
        url: stringProperty("Public product URL."),
        image_url: stringProperty("Primary public image URL."),
        availability: {
          type: "object",
          description: "Product availability summary.",
          additionalProperties: true,
          required: ["status", "quantity"],
          properties: {
            status: stringProperty("Availability status.", ["in_stock", "out_of_stock"]),
            quantity: integerProperty("Buyer-visible quantity."),
          },
        },
        price: {
          type: "object",
          description: "Lowest visible product price.",
          additionalProperties: true,
          required: ["currency", "amount", "display"],
          properties: {
            currency: stringProperty("Currency code."),
            amount: stringProperty("Decimal price amount when listed."),
            display: stringProperty("Buyer-facing price display."),
          },
        },
        variants: arrayProperty("Buyer-visible listing variants.", {
          type: "object",
          description: "Listing variant.",
          additionalProperties: true,
          required: ["id", "listing_id", "url", "price", "availability"],
          properties: {
            id: stringProperty("Product identifier."),
            listing_id: stringProperty("Listing identifier."),
            title: stringProperty("Variant title."),
            url: stringProperty("Public listing URL."),
            price: {
              type: "object",
              description: "Variant price.",
              additionalProperties: true,
              required: ["currency", "amount", "display"],
              properties: {
                currency: stringProperty("Currency code."),
                amount: stringProperty("Decimal price amount."),
                display: stringProperty("Buyer-facing price display."),
              },
            },
            availability: {
              type: "object",
              description: "Variant availability.",
              additionalProperties: true,
              required: ["status", "quantity"],
              properties: {
                status: stringProperty("Availability status.", ["in_stock", "out_of_stock"]),
                quantity: integerProperty("Buyer-visible quantity."),
              },
            },
          },
        }),
      },
    }),
    total: integerProperty("Total matching public item count."),
    count: integerProperty("Returned product count."),
    nextCursor: stringProperty("Cursor for the next page when available."),
  },
};

export const discoveryService = {
  ...service(
    "discovery",
    "Discovery",
    "bounded-contexts/discovery",
    "Public search, item detail composition, and buyer discovery experiences.",
    "accounts.view",
    ["item"],
    {
      packageName: "@chase-sets/discovery",
    },
  ),
  tools: [
    {
      ...readTool(
        "discovery",
        "search-market",
        "Search Market",
        "Search active public marketplace items and buyer-visible supply.",
        "accounts.view",
        objectSchema({
          query: stringProperty(
            'Marketplace search term. Accepts free text or a structured "<setCode> <collectorNumber>[/<total>]" natural key (for example "SV04 123/182", "sv04 123", "OP01-001") -- structured natural keys resolve through an exact set-code + collector-number lookup before falling back to full-text search.',
          ),
          search: stringProperty("Deprecated alias for query."),
          category: stringProperty("Optional category name or slug."),
          tag: stringProperty("Optional public tag."),
          blueprintId: stringProperty("Optional blueprint identifier."),
          language: stringProperty("Optional language code."),
          marketActivity: stringProperty("Optional marketplace activity filter.", ["listings", "offers", "any"]),
          sort: stringProperty("Optional sort mode.", ["relevance", "title_asc", "title_desc", "newest"]),
          limit: integerProperty("Maximum items to return."),
          offset: integerProperty("Result offset."),
          cursor: stringProperty("Cursor for the next page."),
        }),
        "market-search",
        [
          "Use to compare public marketplace options without exposing account-private data.",
          'Use a "<setCode> <collectorNumber>" query (e.g. "SV04 123/182") instead of a full-text guess when the agent already has the set code and collector number.',
        ],
      ),
      availability: "available",
      permissionBoundary: publicBoundary,
      outputSchema: discoverySearchOutputSchema,
    },
    {
      ...readTool(
        "discovery",
        "get-item-detail",
        "Get Item Detail",
        "Read public marketplace item detail, listing options, and offer affordances.",
        "accounts.view",
        objectSchema({ itemSlug: stringProperty("Public marketplace item slug.") }, ["itemSlug"]),
        "item-detail",
        ["Use to inspect public item detail before adding to cart or submitting an offer."],
      ),
      availability: "available",
      permissionBoundary: publicBoundary,
      outputSchema: discoveryItemDetailOutputSchema,
    },
    {
      ...readTool(
        "discovery",
        "get-chatgpt-product-feed",
        "Get ChatGPT Product Feed",
        "Return active public marketplace products in the ChatGPT product feed shape.",
        "accounts.view",
        objectSchema({
          query: stringProperty("Marketplace search term."),
          category: stringProperty("Optional category name or slug."),
          tag: stringProperty("Optional public tag."),
          blueprintId: stringProperty("Optional blueprint identifier."),
          language: stringProperty("Optional language code."),
          marketActivity: stringProperty("Optional marketplace activity filter.", ["listings", "offers", "any"]),
          sort: stringProperty("Optional sort mode.", ["relevance", "title_asc", "title_desc", "newest"]),
          limit: integerProperty("Maximum products to return."),
          offset: integerProperty("Result offset."),
          cursor: stringProperty("Cursor for the next page."),
        }),
        "chatgpt-product-feed",
        ["Use when ChatGPT needs product-card feed rows from public storefront discovery."],
      ),
      availability: "available",
      permissionBoundary: publicBoundary,
      outputSchema: discoveryChatGptFeedOutputSchema,
    },
  ],
  resources: [
    {
      ...resource(
        "discovery",
        "chase-sets://discovery/items/{itemSlug}",
        "Item Detail",
        "Public marketplace item detail composition.",
        "accounts.view",
        ["Use for public product discovery and marketplace comparison."],
      ),
      availability: "available",
      permissionBoundary: publicBoundary,
    },
  ],
} as const satisfies McpServiceDescriptor;
