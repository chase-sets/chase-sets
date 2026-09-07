import {
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  arrayProperty,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const checkoutCartLineOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Checkout cart line.",
  additionalProperties: true,
  // Cart lines are published owner-free: the account that owns a line is
  // internal source provenance, so the payload never carries it and this schema
  // must not promise it.
  required: ["line_id", "quantity"],
  properties: {
    line_id: stringProperty("Checkout cart line identifier."),
    catalog_item_id: stringProperty("Catalog item identifier."),
    product_id: stringProperty("Resolved product identifier."),
    item_title: stringProperty("Line item title."),
    quantity: integerProperty("Requested quantity."),
    updated_at: stringProperty("Last update timestamp."),
  },
};

const checkoutCartOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    items: arrayProperty("Checkout cart lines visible to the actor.", checkoutCartLineOutputProperty),
    total: integerProperty("Total cart line count."),
  },
  ["accountId", "items", "total"],
);

const checkoutCartLineReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Checkout cart line identifier."),
    cartLineId: stringProperty("Checkout cart line identifier."),
    version: integerProperty("Cart stream version after the write."),
    status: stringProperty("Cart line write status.", ["added", "merged", "updated", "removed"]),
    resourceUri: stringProperty("MCP resource URI for the updated cart."),
    quantity: integerProperty("Updated quantity when quantity was part of the request."),
  },
  ["accountId", "id", "cartLineId", "version", "status", "resourceUri"],
);

const checkoutSavedAddressReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Checkout session identifier."),
    sessionId: stringProperty("Checkout session identifier."),
    shippingAddressId: stringProperty("Selected saved shipping address identifier."),
    status: stringProperty("Shipping-address selection status.", ["shipping-address-selected"]),
    resourceUri: stringProperty("MCP resource URI for the updated checkout session."),
    commitPosition: stringProperty("Highest Checkout event-store commit position for the write."),
    commitEventIds: arrayProperty("Checkout event ids written by the command.", stringProperty("Event id.")),
    commitPositions: arrayProperty("Source commit positions written by the command.", {
      type: "object",
      description: "Fresh-write source commit position.",
      additionalProperties: false,
      required: ["sourceContextName", "maxGlobalPosition", "eventIds"],
      properties: {
        sourceContextName: stringProperty("Source context name."),
        maxGlobalPosition: stringProperty("Highest source global position."),
        eventIds: arrayProperty("Event ids included in this source position.", stringProperty("Event id.")),
      },
    }),
  },
  ["accountId", "id", "sessionId", "shippingAddressId", "status", "resourceUri"],
);

const checkoutSessionCancellationReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Checkout session identifier."),
    sessionId: stringProperty("Checkout session identifier."),
    status: stringProperty("Checkout session cancellation status.", ["cancelled", "already-cancelled"]),
    cancelledAt: stringProperty("Cancellation timestamp."),
    releasedReservationIds: arrayProperty(
      "Checkout reservation hold ids released during cancellation.",
      stringProperty("Hold id."),
    ),
    resourceUri: stringProperty("MCP resource URI for the cancelled checkout session."),
    commitPosition: stringProperty("Highest Checkout event-store commit position for the write."),
    commitEventIds: arrayProperty("Checkout event ids written by the command.", stringProperty("Event id.")),
    commitPositions: arrayProperty("Source commit positions written by the command.", {
      type: "object",
      description: "Fresh-write source commit position.",
      additionalProperties: false,
      required: ["sourceContextName", "maxGlobalPosition", "eventIds"],
      properties: {
        sourceContextName: stringProperty("Source context name."),
        maxGlobalPosition: stringProperty("Highest source global position."),
        eventIds: arrayProperty("Event ids included in this source position.", stringProperty("Event id.")),
      },
    }),
  },
  ["accountId", "id", "sessionId", "status", "resourceUri", "releasedReservationIds"],
);

export const checkoutService = {
  ...service(
    "checkout",
    "Checkout",
    "bounded-contexts/checkout",
    "Cart state and checkout session orchestration.",
    "orders.view",
    ["cart"],
    {
      packageName: "@chase-sets/checkout",
    },
  ),
  tools: [
    {
      ...readTool(
        "checkout",
        "get-cart",
        "Get Cart",
        "Read the actor account cart.",
        "orders.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "cart",
        ["Use before adding items or starting checkout."],
      ),
      availability: "available",
      outputSchema: checkoutCartOutputSchema,
    },
    {
      ...writeTool(
        "checkout",
        "add-cart-line",
        "Add Cart Line",
        "Add a product or locked listing snapshot to the cart.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Catalog item identifier from marketplace discovery."),
            productId: stringProperty("Resolved product identifier for the selected options."),
            itemTitle: stringProperty("Buyer-visible item title snapshot."),
            itemSubtitle: stringProperty("Optional buyer-visible item subtitle snapshot."),
            itemImageUrl: stringProperty("Optional buyer-visible item image URL snapshot."),
            selectedOptions: arrayProperty("Selected catalog options.", {
              type: "object",
              description: "Selected catalog option.",
              additionalProperties: false,
              required: ["dimensionId", "optionId"],
              properties: {
                dimensionId: stringProperty("Catalog dimension identifier."),
                optionId: stringProperty("Catalog option identifier."),
              },
            }),
            productSummary: stringProperty("Optional buyer-visible product summary."),
            quantity: integerProperty("Requested quantity."),
            fulfillmentMode: stringProperty("Cart fulfillment mode.", ["optimize", "locked-listing"]),
            lockedListingId: stringProperty("Marketplace listing identifier when locking the line to a seller."),
            sellerPreferenceId: stringProperty("Optional preferred seller account identifier."),
            selectedListingSnapshot: {
              type: "object",
              description: "Optional selected listing snapshot for locked-listing lines.",
              additionalProperties: false,
              properties: {
                listingId: stringProperty("Marketplace listing identifier."),
                sellerAccountId: stringProperty("Seller account identifier."),
                sellerDisplayName: stringProperty("Seller display name."),
                sellerSlug: stringProperty("Seller slug."),
                priceAmount: stringProperty("Listing price amount."),
                source: stringProperty("Snapshot source."),
              },
            },
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing cart state."),
          },
          ["accountId", "catalogItemId", "productId", "itemTitle", "quantity", "idempotencyKey", "confirmationText"],
        ),
        "cart-line",
        ["Use after confirming buyer intent and current product or listing state."],
      ),
      availability: "available",
      outputSchema: checkoutCartLineReceiptOutputSchema,
    },
    {
      ...writeTool(
        "checkout",
        "update-cart-line",
        "Update Cart Line",
        "Update a cart line quantity or seller fulfillment selection.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            cartLineId: stringProperty("Checkout cart line identifier returned by checkout.get-cart."),
            quantity: integerProperty("Requested quantity."),
            fulfillmentMode: stringProperty("Cart fulfillment mode.", ["optimize", "locked-listing"]),
            lockedListingId: stringProperty("Marketplace listing identifier when locking the line to a seller."),
            sellerPreferenceId: stringProperty("Optional preferred seller account identifier."),
            availabilityState: stringProperty("Line availability state.", [
              "available",
              "unavailable",
              "changed",
              "waiting-for-supply",
            ]),
            selectedListingSnapshot: {
              type: "object",
              description: "Optional selected listing snapshot for locked-listing lines.",
              additionalProperties: false,
              properties: {
                listingId: stringProperty("Marketplace listing identifier."),
                sellerAccountId: stringProperty("Seller account identifier."),
                sellerDisplayName: stringProperty("Seller display name."),
                sellerSlug: stringProperty("Seller slug."),
                priceAmount: stringProperty("Listing price amount."),
                source: stringProperty("Snapshot source."),
              },
            },
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing cart state."),
          },
          ["accountId", "cartLineId", "idempotencyKey", "confirmationText"],
        ),
        "cart-line",
        ["Use after reading the current cart line and confirming the buyer-requested change."],
      ),
      availability: "available",
      outputSchema: checkoutCartLineReceiptOutputSchema,
    },
    {
      ...writeTool(
        "checkout",
        "remove-cart-line",
        "Remove Cart Line",
        "Remove a line from the buyer cart.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            cartLineId: stringProperty("Checkout cart line identifier returned by checkout.get-cart."),
            reason: stringProperty("Business reason for removing the line."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing cart state."),
          },
          ["accountId", "cartLineId", "idempotencyKey", "confirmationText"],
        ),
        "cart-line",
        ["Use after confirming the buyer wants the line removed from the cart."],
      ),
      availability: "available",
      outputSchema: checkoutCartLineReceiptOutputSchema,
    },
    {
      ...writeTool(
        "checkout",
        "select-saved-address",
        "Select Saved Address",
        "Select a saved shipping address for an active checkout session.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            sessionId: stringProperty("Checkout session identifier."),
            shippingAddressId: stringProperty("Saved shipping address identifier visible to the actor."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing checkout state."),
          },
          ["accountId", "sessionId", "shippingAddressId", "idempotencyKey", "confirmationText"],
        ),
        "checkout-session",
        ["Use after checkout session creation when the buyer chooses a saved delivery address."],
      ),
      availability: "available",
      outputSchema: checkoutSavedAddressReceiptOutputSchema,
    },
    {
      ...writeTool(
        "checkout",
        "cancel-session",
        "Cancel Checkout Session",
        "Cancel an active checkout session and release active checkout reservations before order or payment commitment.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            sessionId: stringProperty("Checkout session identifier."),
            reason: stringProperty("Business reason for cancelling checkout."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing checkout state."),
          },
          ["accountId", "sessionId", "idempotencyKey", "confirmationText"],
        ),
        "checkout-session",
        ["Use only when the buyer explicitly asks to cancel or abandon an active checkout session."],
        "destructive",
      ),
      availability: "available",
      outputSchema: checkoutSessionCancellationReceiptOutputSchema,
    },
    writeTool(
      "checkout",
      "start-session",
      "Start Checkout Session",
      "Create a checkout session for cart payment.",
      "orders.manage",
      mutationInput("cartId", "Cart to check out."),
      "checkout-session",
      ["Use only after confirming total, shipping terms, and buyer intent."],
      "sensitive",
    ),
  ],
  resources: [
    {
      ...resource(
        "checkout",
        "chase-sets://checkout/{accountId}/cart",
        "Cart",
        "Current account cart and checkout readiness.",
        "orders.view",
        ["Use before checkout mutations."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "checkout",
        "ui://chase-sets/cart-review/v1.html",
        "Cart Review Widget",
        "MCP Apps HTML template for in-chat cart and checkout review.",
        "orders.view",
        ["Use as the output template for UCP checkout session review results."],
      ),
    },
    {
      ...resource(
        "checkout",
        "ui://chase-sets/checkout-handoff/v1.html",
        "Checkout Handoff Widget",
        "MCP Apps HTML template for trusted checkout handoff actions.",
        "orders.view",
        ["Use as the output template when trusted UI is required for checkout completion or cancellation."],
      ),
    },
  ],
} as const satisfies McpServiceDescriptor;
