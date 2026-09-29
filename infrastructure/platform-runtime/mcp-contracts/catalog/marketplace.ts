import { agentOAuthScopesForPermissions } from "@chase-sets/auth-context";

import {
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  type McpToolDescriptor,
  arrayProperty,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  mutationInput,
  objectSchema,
  publicBoundary,
  readBoundary,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const sellerAttentionQueueOutputSchema = objectSchema(
  {
    items: arrayProperty("Seller Desk work ordered by the canonical attention policy.", {
      type: "object",
      description: "One account-owned item that needs seller attention.",
      additionalProperties: true,
      required: ["id", "source", "entity", "severity", "summary", "deepLink", "observedAt"],
      properties: {
        id: stringProperty("Stable attention item identifier used for follow-up actions."),
        source: stringProperty("Owning attention source."),
        entity: stringProperty("Seller entity type."),
        severity: stringProperty("Canonical attention severity.", ["critical", "warning", "info"]),
        summary: {
          type: "object",
          description: "Transport-neutral summary code and interpolation data.",
          additionalProperties: false,
          required: ["code", "params"],
          properties: {
            code: stringProperty("Stable summary code."),
            params: {
              type: "object",
              description: "Summary interpolation and follow-up data.",
              additionalProperties: true,
            },
          },
        },
        deepLink: {
          type: "object",
          description: "Canonical Seller Desk destination for the item.",
          additionalProperties: false,
          required: ["surface", "href"],
          properties: {
            surface: stringProperty("Seller Desk surface identifier."),
            href: stringProperty("Account surface deep link."),
          },
        },
        observedAt: stringProperty("Time the work first needed attention."),
      },
    }),
    rollup: {
      type: "object",
      description: "Counts derived from the returned items.",
      additionalProperties: true,
      required: ["total", "bySeverity", "bySource"],
      properties: {
        total: integerProperty("Total attention item count."),
        bySeverity: { type: "object", description: "Counts by severity.", additionalProperties: true },
        bySource: { type: "object", description: "Counts by attention source.", additionalProperties: true },
      },
    },
    sources: arrayProperty("Per-source availability and item counts.", {
      type: "object",
      description: "Health of one attention source.",
      additionalProperties: true,
      required: ["id", "status", "itemCount"],
      properties: {
        id: stringProperty("Attention source identifier."),
        status: stringProperty("Source availability.", ["available", "unavailable"]),
        itemCount: integerProperty("Items contributed by the source."),
      },
    }),
    degraded: booleanProperty("Whether any attention source was unavailable."),
  },
  ["items", "rollup", "sources", "degraded"],
);

const listingPurchaseLimitsInputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Optional per-listing purchase limits.",
  additionalProperties: false,
  properties: {
    maxUnitsPerOrder: integerProperty("Maximum units per order."),
    maxUnitsPerDay: integerProperty("Maximum units per day."),
    maxUnitsPerCustomerAccount: integerProperty("Maximum units per customer account."),
  },
};

const marketplaceListingReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Listing identifier."),
    listingId: stringProperty("Listing identifier."),
    version: integerProperty("Committed listing stream version."),
    status: stringProperty("Lifecycle write result."),
    resourceUri: stringProperty("MCP resource URI for the listing."),
    inventoryItemId: stringProperty("Inventory item used to create the listing."),
    feeQuoteFingerprint: {
      type: ["string", "null"],
      description: "Marketplace sales-fee quote fingerprint; null before native enrollment.",
    },
  },
  ["accountId", "id", "listingId", "version", "status", "resourceUri"],
);

const marketplaceSelectedOptionInputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Selected product option.",
  additionalProperties: false,
  required: ["dimensionId", "optionId"],
  properties: {
    dimensionId: stringProperty("Product option dimension identifier."),
    optionId: stringProperty("Selected option identifier."),
  },
};

const listingPriceTargetProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Exact native or channel-connection Listing price target.",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: stringProperty("Target kind.", ["native-marketplace", "channel-connection"]),
    connectionId: stringProperty("Required only for a channel-connection target."),
  },
  oneOf: [
    {
      type: "object",
      description: "Native Marketplace target.",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: stringProperty("Native target.", ["native-marketplace"]) },
    },
    {
      type: "object",
      description: "Channel connection target.",
      additionalProperties: false,
      required: ["kind", "connectionId"],
      properties: {
        kind: stringProperty("Channel target.", ["channel-connection"]),
        connectionId: stringProperty("Exact connection."),
      },
    },
  ],
};
const listingPriceDecisionFields: McpJsonSchemaProperty = {
  type: "object",
  description:
    "Seller reference or complete owner-verified Pricing evaluation. Pricing fields are required for pricing-evaluation and forbidden for seller-reference.",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: stringProperty("Decision kind.", ["seller-reference", "pricing-evaluation"]),
    evaluationId: stringProperty("Pricing evaluation identity."),
    evaluationRevision: stringProperty("Pricing evaluation revision."),
    policyId: stringProperty("Pricing policy identity."),
    policyRevision: stringProperty("Pricing policy revision."),
    goal: {
      type: ["object", "null"],
      description: "Pricing goal binding, or null.",
      additionalProperties: false,
      required: ["goalId", "version"],
      properties: { goalId: stringProperty("Goal identity."), version: stringProperty("Goal version.") },
    },
    inputEvidenceRefs: arrayProperty("Verified input evidence references.", stringProperty("Evidence reference.")),
    curveEvidenceRefs: arrayProperty("Verified curve evidence references.", stringProperty("Evidence reference.")),
    economicsSourceRevision: { type: ["string", "null"], description: "Economics source revision, or null." },
    economicsOverrideRevision: { type: ["string", "null"], description: "Economics override revision, or null." },
    basePriceRevision: integerProperty("Evaluation base-price revision."),
    standingAuthorizationId: stringProperty("Standing authorization identity."),
    standingAuthorizationRevision: stringProperty("Standing authorization revision."),
  },
};
const listingPriceDecisionProperty: McpJsonSchemaProperty = {
  ...listingPriceDecisionFields,
  oneOf: [
    {
      type: "object",
      description: "Seller-authored native reference.",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: stringProperty("Seller decision.", ["seller-reference"]) },
    },
    {
      ...listingPriceDecisionFields,
      description: "Complete verified Pricing decision.",
      required: Object.keys(listingPriceDecisionFields.properties!),
      properties: {
        ...listingPriceDecisionFields.properties!,
        kind: stringProperty("Pricing decision.", ["pricing-evaluation"]),
      },
    },
  ],
};
function listingAuthorityTool(
  name: string,
  title: string,
  description: string,
  properties: Readonly<Record<string, McpJsonSchemaProperty>>,
  required: readonly string[],
): McpToolDescriptor {
  return {
    ...writeTool(
      "marketplace",
      name,
      title,
      description,
      "listings.manage",
      objectSchema(
        {
          accountId: stringProperty("Authenticated seller account."),
          listingId: stringProperty("Listing identity."),
          expectedListingVersion: integerProperty("Exact current Listing stream revision."),
          idempotencyKey: idempotencyKeyProperty(),
          confirmationText: stringProperty("Exact user or policy confirmation text."),
          ...properties,
        },
        ["accountId", "listingId", "expectedListingVersion", "idempotencyKey", "confirmationText", ...required],
      ),
      "listing",
      ["Read current Listing authority first; reuse the same idempotency key only for an identical request."],
    ),
    availability: "available",
    outputSchema: marketplaceListingReceiptOutputSchema,
  };
}
const listingAuthorityTools = [
  listingAuthorityTool(
    "accept-listing-target-price",
    "Accept Listing Target Price",
    "Retain the exact authorized price pair for one target without provider execution.",
    {
      target: listingPriceTargetProperty,
      priceAmount: stringProperty("Complete price amount."),
      priceCurrencyCode: stringProperty("Three-letter price currency."),
      expectedTargetPriceRevision: integerProperty("Exact accepted target-price revision; zero when absent."),
      decision: listingPriceDecisionProperty,
      changeSource: stringProperty("Pricing-originated acceptance only.", ["repricing-engine"]),
    },
    ["target", "priceAmount", "priceCurrencyCode", "expectedTargetPriceRevision", "decision"],
  ),
  listingAuthorityTool(
    "activate-listing-for-channel",
    "Activate Listing For Channel",
    "Activate a retained channel price using current connection and stock allocation authority.",
    {
      connectionId: stringProperty("Exact channel connection."),
      expectedTargetPriceRevision: integerProperty("Accepted target-price revision."),
      allocationRevision: integerProperty("Current Inventory allocation revision."),
    },
    ["connectionId", "expectedTargetPriceRevision", "allocationRevision"],
  ),
  listingAuthorityTool(
    "set-native-listing-visibility",
    "Set Native Listing Visibility",
    "Explicitly enable or disable native Marketplace visibility; enablement requires current readiness and fee consent.",
    {
      nativeVisibility: stringProperty("Native visibility consent.", ["enabled", "disabled"]),
      feeQuoteFingerprint: stringProperty("Confirmed current quote when enrolling uncovered native units."),
    },
    ["nativeVisibility"],
  ),
  listingAuthorityTool(
    "resume-listing",
    "Resume Listing",
    "Resume only the observed pause without changing native visibility.",
    {
      expectedPauseReason: stringProperty("Exact current pause reason.", [
        "seller",
        "policy-input-missing",
        "channel-inbound-dark",
      ]),
      inboundClamp: {
        type: "object",
        description: "Exact final inbound-clamp owner, required only for its guarded release.",
        additionalProperties: false,
        required: ["connectionId", "runId", "generation"],
        properties: {
          connectionId: stringProperty("Clamp connection."),
          runId: stringProperty("Clamp run."),
          generation: integerProperty("Clamp generation."),
        },
      },
    },
    ["expectedPauseReason"],
  ),
];

const marketplaceShippingDestinationInputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Buyer shipping destination snapshot required to submit an offer.",
  additionalProperties: false,
  required: ["name", "line1", "city", "state", "postalCode", "country"],
  properties: {
    name: stringProperty("Recipient name."),
    company: stringProperty("Optional company."),
    line1: stringProperty("Street address line 1."),
    line2: stringProperty("Optional street address line 2."),
    city: stringProperty("City."),
    state: stringProperty("State or region."),
    postalCode: stringProperty("Postal code."),
    country: stringProperty("Country code."),
    phone: stringProperty("Optional recipient phone."),
    email: stringProperty("Optional recipient email."),
  },
};

const marketplaceSubmitOfferInputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated buyer account scope."),
    catalogItemId: stringProperty("Catalog item identifier."),
    productId: stringProperty("Product identifier derived from selected options."),
    itemTitle: stringProperty("Item title snapshot."),
    itemSubtitle: stringProperty("Optional item subtitle snapshot."),
    selectedOptions: arrayProperty("Selected product options.", marketplaceSelectedOptionInputProperty),
    productSummary: stringProperty("Optional product summary snapshot."),
    shippingDestinationSnapshot: marketplaceShippingDestinationInputProperty,
    priceAmount: stringProperty("Offer unit price in decimal currency format."),
    priceCurrencyCode: stringProperty("Buyer-authored three-letter ISO-4217 Offer price currency code."),
    quantityRequested: integerProperty("Quantity requested by the buyer."),
    offerIdOverride: stringProperty("Optional deterministic offer id for idempotent handoffs."),
    idempotencyKey: idempotencyKeyProperty(),
    confirmationText: stringProperty("Exact user or policy confirmation text."),
    dryRun: booleanProperty("Validate the action without committing it."),
  },
  [
    "accountId",
    "catalogItemId",
    "productId",
    "itemTitle",
    "shippingDestinationSnapshot",
    "priceAmount",
    "priceCurrencyCode",
    "quantityRequested",
    "idempotencyKey",
    "confirmationText",
  ],
);

const marketplaceOfferReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Offer identifier."),
    offerId: stringProperty("Offer identifier."),
    version: integerProperty("Committed offer stream version."),
    status: stringProperty("Lifecycle write result."),
    resourceUri: stringProperty("MCP resource URI for the offer."),
    catalogItemId: stringProperty("Catalog item used to submit the offer."),
    productId: stringProperty("Product targeted by the offer."),
    counteredOfferId: stringProperty("Offer being countered when this receipt came from a counter-offer."),
  },
  ["accountId", "id", "offerId", "version", "status", "resourceUri"],
);

const marketplaceOfferListOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["accountId", "side", "items", "total", "count"],
  properties: {
    accountId: stringProperty("Authenticated account scope."),
    side: stringProperty("Offer side.", ["submitted", "matched"]),
    items: arrayProperty("Offer rows visible to the actor.", {
      type: "object",
      description: "Participant-safe offer row.",
      additionalProperties: true,
      required: ["offer_id", "buyer_account_id", "product_id", "price_amount", "quantity_requested", "status"],
      properties: {
        offer_id: stringProperty("Offer identifier."),
        buyer_account_id: stringProperty("Buyer account identifier."),
        product_id: stringProperty("Product identifier."),
        price_amount: stringProperty("Offer unit price."),
        quantity_requested: integerProperty("Requested quantity."),
        status: stringProperty("Offer status."),
      },
    }),
    total: integerProperty("Total visible offer count."),
    count: integerProperty("Returned offer count."),
  },
};

export const marketplaceService = {
  ...service(
    "marketplace",
    "Marketplace",
    "bounded-contexts/marketplace",
    "Listings, buyer offers, seller offer matches, and market-facing supply.",
    "listings.view",
    ["listing"],
    {
      packageName: "@chase-sets/marketplace",
    },
  ),
  tools: [
    {
      ...readTool(
        "marketplace",
        "get-seller-attention-queue",
        "Get Seller Attention Queue",
        "Read the same aggregated, work-ordered attention queue used by the Seller Desk home.",
        "listings.view",
        objectSchema({ accountId: stringProperty("Authenticated seller account scope.") }, ["accountId"]),
        "seller-attention-queue",
        ["Use before seller actions to find the highest-priority work and its follow-up entity data."],
      ),
      availability: "available",
      permissionBoundary: {
        ...readBoundary("listings.view"),
        requiredPermissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
        requiredScopes: agentOAuthScopesForPermissions([
          "inventory.view",
          "listings.view",
          "offers.view",
          "fulfillment.view",
          "payouts.view",
        ]),
      },
      outputSchema: sellerAttentionQueueOutputSchema,
    },
    {
      ...readTool(
        "marketplace",
        "list-listings",
        "List Listings",
        "List account listings and publication state.",
        "listings.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            status: stringProperty("Optional listing status."),
            limit: integerProperty("Maximum listings to return."),
            offset: integerProperty("Result offset."),
          },
          ["accountId"],
        ),
        "listing",
        ["Use before listing price or publication changes."],
      ),
      availability: "available",
    },
    {
      ...readTool(
        "marketplace",
        "get-seller-insights",
        "Get Seller Insights",
        "Read seller availability, listings, fee-lock rows, and sellable supply from current Marketplace read models.",
        "listings.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Optional Catalog Item filter for supply."),
            limit: integerProperty("Maximum rows to return per section."),
            offset: integerProperty("Result offset."),
          },
          ["accountId"],
        ),
        "seller-insights",
        ["Use before repricing, listing maintenance, or seller workflow recommendations."],
      ),
      availability: "available",
    },
    {
      ...readTool(
        "marketplace",
        "list-offers",
        "List Offers",
        "List submitted offers and offer matches visible to the actor.",
        "offers.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Offer side.", ["submitted", "matched"]),
            limit: integerProperty("Maximum offers to return."),
            offset: integerProperty("Result offset."),
            productIds: stringProperty("Optional comma-separated product ids for seller matches."),
            status: stringProperty("Optional offer status filter.", ["submitted"]),
            canFulfill: booleanProperty("When true, return only seller matches with enough active supply."),
          },
          ["accountId"],
        ),
        "offer",
        ["Use before accepting, declining, or revising offers."],
      ),
      availability: "available",
      outputSchema: marketplaceOfferListOutputSchema,
    },
    {
      ...readTool(
        "marketplace",
        "get-reputation-summary",
        "Get Reputation Summary",
        "Read the public review summary currently available for an account.",
        "reputation.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            subjectAccountId: stringProperty(
              "Account whose reputation summary should be read (ULID). Alternative to subjectAccountSlug.",
            ),
            subjectAccountSlug: stringProperty(
              "Public seller slug for the account whose reputation summary should be read (from a search result, listing, or order's seller reference). Alternative to subjectAccountId; if both are given, subjectAccountId wins.",
            ),
          },
          ["accountId"],
        ),
        "review-summary",
        ["Use before explaining seller or buyer review history."],
      ),
      availability: "available",
    },
    {
      ...readTool(
        "marketplace",
        "list-reviews",
        "List Reviews",
        "List written, received, or public account reviews from Marketplace review read models.",
        "reputation.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Review side.", ["written", "received", "public"]),
            subjectAccountId: stringProperty(
              "Reviewed account for public review reads (ULID). Alternative to subjectAccountSlug.",
            ),
            subjectAccountSlug: stringProperty(
              "Public seller slug for the reviewed account, for public review reads. Alternative to subjectAccountId; if both are given, subjectAccountId wins.",
            ),
            limit: integerProperty("Maximum reviews to return."),
            offset: integerProperty("Result offset."),
          },
          ["accountId"],
        ),
        "review",
        ["Use before review support, reputation explanations, or review-detail reads."],
      ),
      availability: "available",
    },
    {
      ...writeTool(
        "marketplace",
        "submit-offer",
        "Submit Offer",
        "Submit a buyer offer for a specific product, price, quantity, and shipping destination.",
        "offers.manage",
        marketplaceSubmitOfferInputSchema,
        "offer",
        ["Use after resolving the product, selected options, price, quantity, and shipping destination."],
      ),
      availability: "available",
      outputSchema: marketplaceOfferReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "counter-offer",
        "Counter Offer",
        "Submit a replacement buyer offer that records the offer being countered in the MCP receipt.",
        "offers.manage",
        objectSchema(
          {
            ...marketplaceSubmitOfferInputSchema.properties,
            counteredOfferId: stringProperty("Offer being countered."),
          },
          [...(marketplaceSubmitOfferInputSchema.required ?? []), "counteredOfferId"],
        ),
        "offer",
        ["Use when the buyer wants to answer a prior offer position with a new submitted offer."],
      ),
      availability: "available",
      outputSchema: marketplaceOfferReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "update-offer-price",
        "Update Offer Price",
        "Replace a submitted buyer Offer price amount and currency as one pair.",
        "offers.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated buyer account scope."),
            offerId: stringProperty("Submitted Offer identifier."),
            priceAmount: stringProperty("Offer unit price in decimal currency format."),
            priceCurrencyCode: stringProperty("Buyer-authored three-letter ISO-4217 Offer price currency code."),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
          },
          ["accountId", "offerId", "priceAmount", "priceCurrencyCode", "confirmationText"],
        ),
        "offer",
        ["Use only when the buyer explicitly authorizes both members of a submitted Offer price."],
      ),
      availability: "available",
      outputSchema: marketplaceOfferReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "create-listing",
        "Create Listing",
        "Create a draft listing from account-owned inventory.",
        "listings.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            inventoryItemId: stringProperty(
              "Account-owned inventory item identifier resolved from Catalog or Inventory natural keys.",
            ),
            priceAmount: stringProperty("Listing unit price in decimal currency format."),
            priceCurrencyCode: stringProperty("Seller-authored three-letter ISO-4217 listing price currency code."),
            quantityCap: integerProperty("Maximum listed quantity."),
            publicationScope: stringProperty(
              "Creation scope; channel-only retains a reference without native fees or visibility.",
              ["native", "channel-only"],
            ),
            purchaseLimits: listingPurchaseLimitsInputProperty,
            listingIdOverride: stringProperty("Optional deterministic listing id for idempotent handoffs."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          [
            "accountId",
            "inventoryItemId",
            "priceAmount",
            "priceCurrencyCode",
            "quantityCap",
            "idempotencyKey",
            "confirmationText",
          ],
        ),
        "listing",
        ["Use after resolving the seller inventory item and confirming listing price, quantity, and terms."],
      ),
      availability: "available",
      outputSchema: marketplaceListingReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "update-listing-price",
        "Update Listing Price",
        "Update the seller asking price for an account-owned listing.",
        "listings.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            listingId: stringProperty("Listing to update."),
            priceAmount: stringProperty("New listing unit price in decimal currency format."),
            priceCurrencyCode: stringProperty("Seller-authored three-letter ISO-4217 listing price currency code."),
            feeQuoteFingerprint: stringProperty("Current marketplace sales-fee quote fingerprint."),
            expectedVersion: integerProperty("Expected current Listing revision."),
            expectedTargetPriceRevision: integerProperty("Expected native price revision."),
            decision: listingPriceDecisionProperty,
            changeSource: stringProperty("Pricing-originated acceptance only.", ["repricing-engine"]),
            minimumChange: {
              type: "object",
              description: "Seller request suppression policy; never applied to Pricing decisions.",
              additionalProperties: false,
              required: ["mode"],
              properties: {
                mode: stringProperty("Suppression mode.", ["absolute", "percent"]),
                amount: stringProperty("Required absolute amount for absolute mode."),
                percent: { type: "number", description: "Required nonnegative percentage for percent mode." },
              },
            },
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "listingId", "priceAmount", "priceCurrencyCode", "idempotencyKey", "confirmationText"],
        ),
        "listing",
        ["Use after reading the listing and confirming the current marketplace terms preview."],
      ),
      availability: "available",
      outputSchema: marketplaceListingReceiptOutputSchema,
    },
    ...listingAuthorityTools,
    {
      ...writeTool(
        "marketplace",
        "publish-listing",
        "Publish Listing",
        "Publish a listing to buyer discovery.",
        "listings.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            listingId: stringProperty("Listing to publish."),
            feeQuoteFingerprint: stringProperty("Current marketplace sales-fee quote fingerprint."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "listingId", "idempotencyKey", "confirmationText"],
        ),
        "listing",
        ["Use after confirming inventory, pricing, photos when required, and commercial terms."],
      ),
      availability: "available",
      outputSchema: marketplaceListingReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "unpublish-listing",
        "Unpublish Listing",
        "Remove a listing from buyer discovery while keeping it seller-manageable.",
        "listings.manage",
        mutationInput("listingId", "Listing to unpublish."),
        "listing",
        ["Use when the seller wants to stop buyer discovery without withdrawing the listing permanently."],
      ),
      availability: "available",
      outputSchema: marketplaceListingReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "accept-offer",
        "Accept Offer",
        "Accept a buyer offer and begin order creation.",
        "offers.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated seller account scope."),
            offerId: stringProperty("Offer to accept."),
            listingId: stringProperty("Seller listing whose supply and evidence bind the acceptance."),
            feeQuoteFingerprint: stringProperty("Current marketplace sales-fee quote fingerprint."),
            sourceActionKey: stringProperty("Optional source action key for semantic handoffs."),
            reason: stringProperty("Business reason for the action."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "offerId", "listingId", "feeQuoteFingerprint", "idempotencyKey", "confirmationText"],
        ),
        "offer",
        ["Use only after confirming price, quantity, seller supply, and commercial terms."],
        "sensitive",
      ),
      availability: "available",
      permissionBoundary: {
        ...readBoundary("offers.manage"),
        requiredPermissions: ["offers.manage", "listings.view"],
      },
      outputSchema: marketplaceOfferReceiptOutputSchema,
    },
    {
      ...writeTool(
        "marketplace",
        "decline-offer",
        "Decline Offer",
        "Hide a seller offer match without ending marketplace-wide buyer demand.",
        "offers.manage",
        mutationInput("offerId", "Offer match to decline."),
        "offer",
        ["Use when the seller does not want this matched offer for their active listing."],
        "sensitive",
      ),
      availability: "available",
      permissionBoundary: {
        ...readBoundary("offers.manage"),
        requiredPermissions: ["offers.manage", "listings.view"],
      },
      outputSchema: marketplaceOfferReceiptOutputSchema,
    },
  ],
  resources: [
    {
      ...resource(
        "marketplace",
        "chase-sets://marketplace/{accountId}/listings/{listingId}",
        "Listing",
        "Listing publication and market-facing price state.",
        "listings.view",
        ["Use to inspect active marketplace supply."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "marketplace",
        "chase-sets://marketplace/{accountId}/offers/{offerId}",
        "Offer",
        "Offer state and participant-safe details.",
        "offers.view",
        ["Use before offer negotiation or acceptance."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "marketplace",
        "chase-sets://marketplace/{accountId}/reputation/summaries/{subjectAccountId}",
        "Reputation Summary",
        "Public review rollup currently available for an account.",
        "reputation.view",
        ["Use for account trust and review workflows."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "marketplace",
        "chase-sets://marketplace/{accountId}/reviews/{reviewId}",
        "Review",
        "Review detail visible to the actor as author or subject.",
        "reputation.view",
        ["Use for review support and reputation explanations."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "marketplace",
        "ui://chase-sets/product-cards/v1.html",
        "Product Cards Widget",
        "MCP Apps HTML template for in-chat marketplace product cards.",
        "listings.view",
        ["Use as the output template for UCP catalog search and product lookup results."],
        "public",
      ),
      permissionBoundary: publicBoundary,
    },
  ],
} as const satisfies McpServiceDescriptor;
