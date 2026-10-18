import {
  type McpServiceDescriptor,
  arrayProperty,
  accountScopedListOutputSchema,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  mutationInput,
  nullableProperty,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const postagePolicyProperties = {
  policyVersion: stringProperty("Policy version."),
  maxLetterUnits: { type: "number", description: "Maximum letter units." },
  maxLetterWeightOunces: { type: "number", description: "Maximum letter weight in ounces." },
  maxLetterThicknessInches: { type: "number", description: "Maximum letter thickness in inches." },
  maxLetterDeclaredValueAmount: { type: "number", description: "Maximum letter declared value amount." },
  letterEnvelopeWeightOunces: { type: "number", description: "Letter envelope weight in ounces." },
  parcelPackagingWeightOunces: { type: "number", description: "Parcel packaging weight in ounces." },
  parcelRequiredShippingOptions: arrayProperty(
    "Shipping options that require parcel postage.",
    stringProperty("Shipping option."),
  ),
  letterRequiredPhysicalFlags: arrayProperty(
    "Physical flags that require letter postage.",
    stringProperty("Physical flag."),
  ),
  parcelRequiredPhysicalFlags: arrayProperty(
    "Physical flags that require parcel postage.",
    stringProperty("Physical flag."),
  ),
  signatureRequiredShippingOptions: arrayProperty(
    "Shipping options that require signature.",
    stringProperty("Shipping option."),
  ),
  signatureRequiredDeclaredValueAmount: nullableProperty({
    type: "number",
    description: "Nullable declared value threshold requiring signature.",
  }),
  signatureRequiredPhysicalFlags: arrayProperty(
    "Physical flags that require signature.",
    stringProperty("Physical flag."),
  ),
  insuranceRequiredDeclaredValueAmount: nullableProperty({
    type: "number",
    description: "Nullable declared value threshold requiring insurance.",
  }),
} as const;

const postagePolicyFields = {
  label: stringProperty("Policy label."),
  effectiveFrom: stringProperty("ISO timestamp when the policy becomes effective."),
  effectiveUntil: nullableProperty({
    type: "string",
    description: "Nullable ISO timestamp when the policy stops being effective.",
  }),
  ...postagePolicyProperties,
};

const postagePolicyWriteSchema = objectSchema(
  {
    ...postagePolicyFields,
    idempotencyKey: idempotencyKeyProperty(),
    confirmed: { type: "boolean", description: "Explicit confirmation of the requested action." },
    confirmationText: stringProperty("Exact confirmation text."),
  },
  [
    "label",
    "policyVersion",
    "maxLetterUnits",
    "maxLetterWeightOunces",
    "maxLetterThicknessInches",
    "maxLetterDeclaredValueAmount",
    "letterEnvelopeWeightOunces",
    "parcelPackagingWeightOunces",
    "idempotencyKey",
    "confirmed",
    "confirmationText",
  ],
);

const postagePolicyPreviewSchema = objectSchema(
  {
    policy: {
      type: "object",
      description: "Postage policy values to evaluate.",
      additionalProperties: false,
      properties: postagePolicyProperties,
    },
    shippingOption: stringProperty("Shipping option.", ["standard", "expedited", "priority"]),
    itemSubtotalAmount: stringProperty("Item subtotal amount."),
    quantity: { type: "number", description: "Item quantity." },
    unitLengthInches: { type: "number", description: "Unit length in inches." },
    unitWidthInches: { type: "number", description: "Unit width in inches." },
    unitHeightInches: { type: "number", description: "Unit height in inches." },
    unitWeightOunces: { type: "number", description: "Unit weight in ounces." },
    physicalFlags: arrayProperty("Product physical flags.", stringProperty("Physical flag.")),
  },
  ["policy"],
);

const postagePolicyReceiptOutput = objectSchema(
  {
    id: stringProperty("Postage policy identifier."),
    policyId: stringProperty("Postage policy identifier."),
    version: integerProperty("Committed aggregate version."),
    status: stringProperty("Write result: draft, revised, active, or retired."),
  },
  ["id", "policyId", "version", "status"],
);

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
    {
      ...readTool(
        "ordering",
        "list-postage-policies",
        "List Postage Policies",
        "List postage policies visible to an ordering operator.",
        "postage-policies.view",
        objectSchema({
          limit: integerProperty("Maximum records to return."),
          offset: integerProperty("Zero-based record offset."),
        }),
        "postage-policy",
        ["Use before creating, revising, activating, cloning, or retiring a postage policy."],
        "operator",
      ),
      availability: "available",
      outputSchema: objectSchema(
        {
          items: arrayProperty("Postage policy rows.", {
            type: "object",
            description: "Postage policy row.",
            additionalProperties: true,
            properties: {},
          }),
          total: integerProperty("Total matching policies."),
          count: integerProperty("Returned policy count."),
        },
        ["items", "total", "count"],
      ),
    },
    {
      ...readTool(
        "ordering",
        "get-postage-policy",
        "Get Postage Policy",
        "Read one postage policy and its history.",
        "postage-policies.view",
        objectSchema({ id: stringProperty("Postage policy identifier.") }, ["id"]),
        "postage-policy",
        ["Use to inspect the policy before lifecycle actions."],
        "operator",
      ),
      availability: "available",
      outputSchema: objectSchema(
        {
          policy: {
            type: "object",
            description: "Postage policy detail row.",
            additionalProperties: true,
            properties: {},
          },
        },
        ["policy"],
      ),
    },
    {
      ...readTool(
        "ordering",
        "preview-postage-policy",
        "Preview Postage Policy",
        "Evaluate a postage policy against a measured item without committing it.",
        "postage-policies.manage",
        postagePolicyPreviewSchema,
        "postage-policy-preview",
        ["Use before creating or revising a postage policy."],
        "operator",
      ),
      availability: "available",
      outputSchema: objectSchema(
        {
          packagePlan: {
            type: "object",
            description: "Evaluated package plan.",
            additionalProperties: true,
            properties: {},
          },
        },
        ["packagePlan"],
      ),
    },
    {
      ...writeTool(
        "ordering",
        "create-postage-policy",
        "Create Postage Policy",
        "Create a postage policy draft.",
        "postage-policies.manage",
        postagePolicyWriteSchema,
        "postage-policy",
        ["Use only for an explicit postage policy administration change."],
        "sensitive",
        "operator",
      ),
      availability: "available",
      outputSchema: postagePolicyReceiptOutput,
    },
    {
      ...writeTool(
        "ordering",
        "revise-postage-policy",
        "Revise Postage Policy",
        "Revise a postage policy that is not retired.",
        "postage-policies.manage",
        objectSchema({ id: stringProperty("Postage policy identifier."), ...postagePolicyWriteSchema.properties }, [
          "id",
          ...postagePolicyWriteSchema.required!.filter((field) => field !== "label"),
          "label",
        ]),
        "postage-policy",
        ["Use only for an explicit postage policy administration change."],
        "sensitive",
        "operator",
      ),
      availability: "available",
      outputSchema: postagePolicyReceiptOutput,
    },
    {
      ...writeTool(
        "ordering",
        "activate-postage-policy",
        "Activate Postage Policy",
        "Activate a postage policy and retire the previous active policy when applicable.",
        "postage-policies.manage",
        objectSchema(
          {
            id: stringProperty("Postage policy identifier."),
            activationReason: stringProperty("Reason for activation."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmed: booleanProperty("Explicit confirmation of the requested action."),
            confirmationText: stringProperty("Exact confirmation text."),
          },
          ["id", "activationReason", "idempotencyKey", "confirmed", "confirmationText"],
        ),
        "postage-policy",
        ["Use only after inspecting the candidate policy and its comparison."],
        "sensitive",
        "operator",
      ),
      availability: "available",
      outputSchema: postagePolicyReceiptOutput,
    },
    {
      ...writeTool(
        "ordering",
        "retire-postage-policy",
        "Retire Postage Policy",
        "Retire a postage policy.",
        "postage-policies.manage",
        objectSchema(
          {
            id: stringProperty("Postage policy identifier."),
            retirementReason: stringProperty("Reason for retirement."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmed: booleanProperty("Explicit confirmation of the requested action."),
            confirmationText: stringProperty("Exact confirmation text."),
          },
          ["id", "retirementReason", "idempotencyKey", "confirmed", "confirmationText"],
        ),
        "postage-policy",
        ["Use only for an explicit postage policy administration change."],
        "destructive",
        "operator",
      ),
      availability: "available",
      outputSchema: postagePolicyReceiptOutput,
    },
    {
      ...writeTool(
        "ordering",
        "clone-postage-policy",
        "Clone Postage Policy",
        "Clone a postage policy into a new draft.",
        "postage-policies.manage",
        objectSchema(
          {
            id: stringProperty("Source postage policy identifier."),
            label: stringProperty("New policy label."),
            effectiveFrom: stringProperty("ISO timestamp when the clone becomes effective."),
            effectiveUntil: nullableProperty({
              type: "string",
              description: "Nullable ISO timestamp when the clone stops being effective.",
            }),
            idempotencyKey: idempotencyKeyProperty(),
            confirmed: booleanProperty("Explicit confirmation of the requested action."),
            confirmationText: stringProperty("Exact confirmation text."),
          },
          ["id", "idempotencyKey", "confirmed", "confirmationText"],
        ),
        "postage-policy",
        ["Use after inspecting the source policy when preparing a replacement draft."],
        "sensitive",
        "operator",
      ),
      availability: "available",
      outputSchema: postagePolicyReceiptOutput,
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
