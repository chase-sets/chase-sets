import {
  type McpServiceDescriptor,
  accountScopedListOutputSchema,
  integerProperty,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const orderingOrderDetailOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    side: stringProperty("Order side.", ["purchase", "sale"]),
    order: {
      type: "object",
      description: "Ordering order detail row.",
      additionalProperties: true,
      required: ["order_id", "status", "buyer_account_id", "seller_account_id"],
      properties: {
        order_id: stringProperty("Order identifier."),
        status: stringProperty("Current order status."),
        buyer_account_id: stringProperty("Buyer account identifier."),
        seller_account_id: stringProperty("Seller account identifier."),
      },
    },
  },
  ["accountId", "side", "order"],
);

export const orderingService = {
  ...service(
    "ordering",
    "Ordering",
    "bounded-contexts/ordering",
    "Orders, purchases, sales, reservation outcomes, and order state transitions.",
    "orders.view",
    ["order"],
    {
      packageName: "@chase-sets/ordering",
    },
  ),
  tools: [
    {
      ...readTool(
        "ordering",
        "list-orders",
        "List Orders",
        "List purchases and sales visible to the actor.",
        "orders.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Order side.", ["purchase", "sale"]),
            limit: integerProperty("Maximum records to return."),
            offset: integerProperty("Zero-based record offset."),
          },
          ["accountId"],
        ),
        "order",
        ["Use before fulfillment, payment, reputation, or support actions."],
      ),
      availability: "available",
      outputSchema: accountScopedListOutputSchema("Ordering order rows visible to the actor."),
    },
    {
      ...readTool(
        "ordering",
        "get-order",
        "Get Order",
        "Read one purchase or sale order visible to the actor.",
        "orders.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            orderId: stringProperty("Order identifier."),
          },
          ["accountId", "orderId"],
        ),
        "order",
        ["Use to inspect order detail, payment deadlines, cancellation state, and line items."],
      ),
      availability: "available",
      outputSchema: orderingOrderDetailOutputSchema,
    },
    writeTool(
      "ordering",
      "cancel-order",
      "Cancel Order",
      "Cancel an order that is still eligible for cancellation.",
      "orders.manage",
      mutationInput("orderId", "Order to cancel."),
      "order",
      ["Use only after checking payment, fulfillment, and cancellation policy."],
      "destructive",
    ),
  ],
  resources: [
    {
      ...resource(
        "ordering",
        "chase-sets://ordering/{accountId}/orders/{orderId}",
        "Order",
        "Order state, lines, participant-safe totals, and workflow status.",
        "orders.view",
        ["Use as the source of truth for purchase and sale workflows."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
