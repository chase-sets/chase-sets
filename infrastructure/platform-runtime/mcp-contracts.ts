import {
  agentOAuthScopesForPermissions,
  missingAgentOAuthScopesForPermissions,
  type AgentOAuthGrantContext,
  type AgentOAuthScope,
} from "@chase-sets/auth-context";

export type McpServiceKind = "bounded-context" | "external-provider" | "infrastructure";
export type McpAccessScope = "public" | "actor" | "account" | "operator";
export type McpToolRisk = "read" | "sensitive" | "destructive";
export type McpIdempotencyPolicy = "not-applicable" | "recommended" | "required";
export type McpCapabilityAvailability = "available" | "planned";

export type McpJsonSchema = Readonly<{
  type: "object";
  additionalProperties?: boolean;
  required?: readonly string[];
  properties: Readonly<Record<string, McpJsonSchemaProperty>>;
}>;

export type McpJsonSchemaProperty = Readonly<{
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  enum?: readonly string[];
  items?: McpJsonSchemaProperty;
  additionalProperties?: boolean;
  properties?: Readonly<Record<string, McpJsonSchemaProperty>>;
  required?: readonly string[];
}>;

export type McpPermissionBoundary = Readonly<{
  scope: McpAccessScope;
  requiredPermissions: readonly string[];
  requiredScopes?: readonly AgentOAuthScope[];
  accountScoped: boolean;
  auditPrincipal: "actor" | "system";
}>;

export type McpConfirmationPolicy = Readonly<{
  required: boolean;
  prompt?: string;
  matchInputField?: string;
}>;

export type McpGuardrails = Readonly<{
  confirmation: McpConfirmationPolicy;
  idempotencyKey: McpIdempotencyPolicy;
  dryRunSupported: boolean;
  notes: readonly string[];
}>;

export type McpAuditPolicy = Readonly<{
  eventName: string;
  targetType: string;
  sensitiveInputFields: readonly string[];
}>;

export type McpToolDescriptor = Readonly<{
  name: string;
  title: string;
  description: string;
  availability?: McpCapabilityAvailability;
  serviceId: string;
  risk: McpToolRisk;
  inputSchema: McpJsonSchema;
  outputSchema?: McpJsonSchema;
  permissionBoundary: McpPermissionBoundary;
  guardrails: McpGuardrails;
  audit: McpAuditPolicy;
  expectedUsage: readonly string[];
}>;

export type McpResourceDescriptor = Readonly<{
  uriTemplate: string;
  title: string;
  description: string;
  availability?: McpCapabilityAvailability;
  serviceId: string;
  permissionBoundary: McpPermissionBoundary;
  expectedUsage: readonly string[];
}>;

export type McpServiceDescriptor = Readonly<{
  serviceId: string;
  serviceName: string;
  kind: McpServiceKind;
  owner: string;
  packageName?: string;
  serviceBoundary: string;
  tools: readonly McpToolDescriptor[];
  resources: readonly McpResourceDescriptor[];
}>;

export type McpActor = Readonly<{
  actorId: string;
  accountId?: string | null;
  permissions: readonly string[];
  agentGrant?: AgentOAuthGrantContext;
}>;

export type McpToolInvocationAuthorization =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: string; missingScopes?: readonly AgentOAuthScope[] }>;

export const CORE_MCP_SERVICE_IDS = [
  "auth",
  "authenticity",
  "catalog",
  "checkout",
  "commercial-terms",
  "discovery",
  "fulfillment",
  "identity",
  "insights",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "pricing",
  "reputation",
  "settlement",
] as const;

export const EXTERNAL_MCP_SERVICE_IDS = ["easypost-postage", "stripe-connect", "stripe-payments"] as const;

const DEFAULT_MCP_CAPABILITY_AVAILABILITY: McpCapabilityAvailability = "planned";

const emptySchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

const stringProperty = (description: string, values?: readonly string[]): McpJsonSchemaProperty => ({
  type: "string",
  description,
  ...(values ? { enum: values } : {}),
});

const booleanProperty = (description: string): McpJsonSchemaProperty => ({
  type: "boolean",
  description,
});

const integerProperty = (description: string): McpJsonSchemaProperty => ({
  type: "integer",
  description,
});

const arrayProperty = (description: string, items: McpJsonSchemaProperty): McpJsonSchemaProperty => ({
  type: "array",
  description,
  items,
});

const objectSchema = (properties: McpJsonSchema["properties"], required: readonly string[] = []): McpJsonSchema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const readBoundary = (permission: string, scope: McpAccessScope = "account"): McpPermissionBoundary => ({
  scope,
  requiredPermissions: [permission],
  requiredScopes: agentOAuthScopesForPermissions([permission]),
  accountScoped: scope === "account",
  auditPrincipal: "actor",
});

const publicBoundary: McpPermissionBoundary = {
  scope: "public",
  requiredPermissions: [],
  requiredScopes: [],
  accountScoped: false,
  auditPrincipal: "actor",
};

const guardrails = (risk: McpToolRisk, options: Partial<McpGuardrails> = {}): McpGuardrails => ({
  confirmation: {
    required: risk !== "read",
    ...(risk === "read"
      ? {}
      : {
          prompt: "Confirm the exact business action before invoking this tool.",
          matchInputField: "confirmationText",
        }),
    ...options.confirmation,
  },
  idempotencyKey: risk === "read" ? "not-applicable" : "required",
  dryRunSupported: risk !== "read",
  notes:
    risk === "read"
      ? ["Return only account-scoped data that the actor can already view."]
      : ["Write through the owning bounded context and emit normal domain events."],
  ...options,
});

const audit = (
  serviceId: string,
  action: string,
  targetType: string,
  sensitiveInputFields: readonly string[] = [],
): McpAuditPolicy => ({
  eventName: `mcp.${serviceId}.${action}`,
  targetType,
  sensitiveInputFields,
});

const sensitiveWriteInputFieldNames = ["amount", "confirmationText", "email", "reason"] as const;

function sensitiveInputFieldsForWriteTool(inputSchema: McpJsonSchema): readonly string[] {
  const properties = inputSchema.properties ?? {};
  return sensitiveWriteInputFieldNames.filter((fieldName) => fieldName in properties);
}

const readTool = (
  serviceId: string,
  name: string,
  title: string,
  description: string,
  permission: string,
  inputSchema: McpJsonSchema,
  targetType: string,
  expectedUsage: readonly string[],
  scope: McpAccessScope = "account",
): McpToolDescriptor => ({
  name: `${serviceId}.${name}`,
  title,
  description,
  availability: DEFAULT_MCP_CAPABILITY_AVAILABILITY,
  serviceId,
  risk: "read",
  inputSchema,
  permissionBoundary: readBoundary(permission, scope),
  guardrails: guardrails("read"),
  audit: audit(serviceId, name, targetType),
  expectedUsage,
});

const writeTool = (
  serviceId: string,
  name: string,
  title: string,
  description: string,
  permission: string,
  inputSchema: McpJsonSchema,
  targetType: string,
  expectedUsage: readonly string[],
  risk: Exclude<McpToolRisk, "read"> = "sensitive",
  scope: McpAccessScope = "account",
): McpToolDescriptor => ({
  name: `${serviceId}.${name}`,
  title,
  description,
  availability: DEFAULT_MCP_CAPABILITY_AVAILABILITY,
  serviceId,
  risk,
  inputSchema,
  permissionBoundary: readBoundary(permission, scope),
  guardrails: guardrails(risk),
  audit: audit(serviceId, name, targetType, sensitiveInputFieldsForWriteTool(inputSchema)),
  expectedUsage,
});

const resource = (
  serviceId: string,
  uriTemplate: string,
  title: string,
  description: string,
  permission: string,
  expectedUsage: readonly string[],
  scope: McpAccessScope = "account",
): McpResourceDescriptor => ({
  uriTemplate,
  title,
  description,
  availability: DEFAULT_MCP_CAPABILITY_AVAILABILITY,
  serviceId,
  permissionBoundary: readBoundary(permission, scope),
  expectedUsage,
});

const service = (
  serviceId: string,
  serviceName: string,
  owner: string,
  serviceBoundary: string,
  permission: string,
  nouns: readonly string[],
  options: Partial<Pick<McpServiceDescriptor, "kind" | "packageName">> = {},
): McpServiceDescriptor => {
  const primaryNoun = nouns[0] ?? serviceId;
  const primaryNounId = `${primaryNoun.replaceAll("-", "")}Id`;

  return {
    serviceId,
    serviceName,
    kind: options.kind ?? "bounded-context",
    owner,
    packageName: options.packageName ?? `@chase-sets/${serviceId}`,
    serviceBoundary,
    resources: [
      resource(
        serviceId,
        `chase-sets://${serviceId}/{accountId}/${primaryNoun}`,
        `${serviceName} ${primaryNoun}`,
        `Account-scoped ${primaryNoun} read model owned by ${serviceName}.`,
        permission,
        [`Inspect ${primaryNoun} state before planning or invoking a write tool.`],
      ),
    ],
    tools: [
      readTool(
        serviceId,
        "search",
        `Search ${serviceName}`,
        `Find ${serviceName} records visible to the actor.`,
        permission,
        objectSchema({
          accountId: stringProperty("Authenticated account scope."),
          query: stringProperty("Natural language or exact identifier search term."),
          status: stringProperty("Optional status filter."),
        }),
        primaryNoun,
        [`Use before writes to locate the canonical ${primaryNoun} identifier.`],
      ),
      readTool(
        serviceId,
        "get",
        `Get ${serviceName} Record`,
        `Read one ${serviceName} record by identifier.`,
        permission,
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            [primaryNounId]: stringProperty(`Identifier for the ${primaryNoun}.`),
          },
          ["accountId", primaryNounId],
        ),
        primaryNoun,
        ["Use to verify current state and permission-scoped visibility."],
      ),
    ],
  };
};

const mutationInput = (idName: string, description: string): McpJsonSchema =>
  objectSchema(
    {
      accountId: stringProperty("Authenticated account scope."),
      [idName]: stringProperty(description),
      reason: stringProperty("Business reason for the action."),
      idempotencyKey: stringProperty("Stable key supplied by the agent host."),
      confirmationText: stringProperty("Exact user or policy confirmation text."),
      dryRun: booleanProperty("Validate the action without committing it."),
    },
    ["accountId", idName, "reason", "idempotencyKey", "confirmationText"],
  );

const postageAddressProperty = (description: string): McpJsonSchemaProperty => ({
  type: "object",
  description,
  additionalProperties: false,
  properties: {
    name: stringProperty("Recipient or sender name."),
    company: stringProperty("Optional company name."),
    street1: stringProperty("Street line 1."),
    street2: stringProperty("Optional street line 2."),
    line1: stringProperty("Deprecated alias for street1."),
    line2: stringProperty("Deprecated alias for street2."),
    city: stringProperty("City."),
    state: stringProperty("State or province."),
    postalCode: stringProperty("Postal code."),
    country: stringProperty("Country code."),
    phone: stringProperty("Optional phone number."),
    email: stringProperty("Optional email address."),
  },
  required: ["name", "city", "state", "postalCode", "country"],
});

const postagePackageProperty = (): McpJsonSchemaProperty => ({
  type: "object",
  description: "Optional package override for postage purchase.",
  additionalProperties: false,
  properties: {
    lengthInches: { type: "number", description: "Package length in inches." },
    widthInches: { type: "number", description: "Package width in inches." },
    heightInches: { type: "number", description: "Package height in inches." },
    weightOunces: { type: "number", description: "Package weight in ounces." },
  },
  required: ["lengthInches", "widthInches", "heightInches", "weightOunces"],
});

const importSourceProfileOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Inventory import source profile.",
  additionalProperties: true,
  required: [
    "sourceKey",
    "label",
    "kind",
    "adapterVersion",
    "displayNameValueKeys",
    "values",
    "externalReferenceCandidates",
    "selectedOptionInference",
  ],
  properties: {
    sourceKey: stringProperty("Configured import source key."),
    label: stringProperty("Human-readable import source label."),
    kind: stringProperty("Import source transport kind.", ["csv", "api"]),
    adapterVersion: integerProperty("Version of the import adapter contract."),
    nativePassthrough: booleanProperty("Whether rows pass through native Chase Sets CSV fields."),
    displayNameValueKeys: arrayProperty("Value keys that make a row display name.", stringProperty("Value key.")),
    rowNoteValueKeys: arrayProperty("Value keys used to build review notes.", stringProperty("Value key.")),
    values: arrayProperty("Value mappings accepted by this source.", {
      type: "object",
      description: "Import value mapping.",
      additionalProperties: true,
      required: ["targetKey"],
      properties: {
        targetKey: stringProperty("Normalized target value key."),
      },
    }),
    externalReferenceCandidates: arrayProperty("External reference candidates inferred from source rows.", {
      type: "object",
      description: "External reference candidate rule.",
      additionalProperties: true,
      required: ["providerKey", "externalKeyPrefix", "targetIntent"],
      properties: {
        providerKey: stringProperty("External provider key."),
        externalKeyPrefix: stringProperty("Prefix used for external reference keys."),
        targetIntent: stringProperty("How this external reference should be resolved."),
      },
    }),
    selectedOptionInference: arrayProperty("Catalog option inference rules for source rows.", {
      type: "object",
      description: "Selected option inference rule.",
      additionalProperties: true,
      required: ["dimensionKey", "headers"],
      properties: {
        dimensionKey: stringProperty("Catalog dimension key."),
        headers: arrayProperty("Source headers used for the dimension.", stringProperty("Source header.")),
      },
    }),
  },
};

const inventoryImportSourcesOutputSchema = objectSchema(
  {
    items: arrayProperty("Supported inventory import source profiles.", importSourceProfileOutputProperty),
    total: integerProperty("Total supported source profile count."),
  },
  ["items", "total"],
);

const importBatchRowOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Inventory import batch row.",
  additionalProperties: true,
  required: [
    "row_id",
    "batch_id",
    "row_number",
    "status",
    "quantity_mode",
    "resolution_status",
    "validation_errors",
    "created_at",
    "updated_at",
  ],
  properties: {
    row_id: stringProperty("Import batch row identifier."),
    batch_id: stringProperty("Import batch identifier."),
    row_number: integerProperty("Source row number."),
    status: stringProperty("Import row status.", ["accepted", "rejected", "committed"]),
    quantity_mode: stringProperty("How row quantities affect stock.", ["add", "replace"]),
    resolution_status: stringProperty("Catalog resolution status.", ["native", "resolved", "unresolved"]),
    validation_errors: arrayProperty("Validation errors for the row.", stringProperty("Validation error.")),
    created_at: stringProperty("Creation timestamp."),
    updated_at: stringProperty("Last update timestamp."),
  },
};

const inventoryImportBatchDetailOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    batch_id: stringProperty("Import batch identifier."),
    account_id: stringProperty("Account that owns the import batch."),
    status: stringProperty("Import batch status.", ["uploaded", "committed"]),
    source_key: stringProperty("Configured import source key."),
    adapter_version: integerProperty("Version of the import adapter contract."),
    quantity_mode: stringProperty("How row quantities affect stock.", ["add", "replace"]),
    total_count: integerProperty("Total row count."),
    accepted_count: integerProperty("Accepted row count."),
    rejected_count: integerProperty("Rejected row count."),
    committed_count: integerProperty("Committed row count."),
    created_at: stringProperty("Creation timestamp."),
    updated_at: stringProperty("Last update timestamp."),
    rows: arrayProperty("Import batch rows.", importBatchRowOutputProperty),
  },
  required: [
    "batch_id",
    "account_id",
    "status",
    "source_key",
    "adapter_version",
    "quantity_mode",
    "total_count",
    "accepted_count",
    "rejected_count",
    "committed_count",
    "created_at",
    "updated_at",
    "rows",
  ],
};

const checkoutCartLineOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Checkout cart line.",
  additionalProperties: true,
  required: ["line_id", "buyer_account_id", "quantity"],
  properties: {
    line_id: stringProperty("Checkout cart line identifier."),
    buyer_account_id: stringProperty("Account that owns the cart line."),
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
const accountScopedListOutputSchema = (itemDescription: string): McpJsonSchema =>
  objectSchema(
    {
      accountId: stringProperty("Authenticated account scope."),
      side: stringProperty("Account relationship for the returned records."),
      items: arrayProperty(itemDescription, {
        type: "object",
        description: itemDescription,
        additionalProperties: true,
        properties: {},
      }),
      total: integerProperty("Total matching record count."),
      count: integerProperty("Returned record count."),
    },
    ["accountId", "side", "items", "total", "count"],
  );

const accountScopedDetailOutputSchema = (key: string, description: string): McpJsonSchema =>
  objectSchema(
    {
      accountId: stringProperty("Authenticated account scope."),
      [key]: {
        type: "object",
        description,
        additionalProperties: true,
        properties: {},
      },
    },
    ["accountId", key],
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

const paymentsPaymentStatusOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    payment: {
      type: "object",
      description: "Payments payment detail row.",
      additionalProperties: true,
      required: ["payment_id", "buyer_account_id", "status", "processor_status", "refunded_amount"],
      properties: {
        payment_id: stringProperty("Payment identifier."),
        buyer_account_id: stringProperty("Buyer account identifier."),
        status: stringProperty("Current payment status."),
        processor_status: stringProperty("Processor status mirrored into Payments."),
        refunded_amount: stringProperty("Total refunded amount."),
      },
    },
    moneyTimeline: {
      type: "object",
      description: "Payment money-movement timeline.",
      additionalProperties: true,
      properties: {},
    },
    status: {
      type: "object",
      description: "Compact payment, refund, and dispute status.",
      additionalProperties: true,
      required: ["paymentStatus", "processorStatus", "refundedAmount"],
      properties: {
        paymentStatus: stringProperty("Current payment status."),
        processorStatus: stringProperty("Current processor status."),
        refundedAmount: stringProperty("Total refunded amount."),
        refundedAt: stringProperty("Refund timestamp when present."),
        disputedAt: stringProperty("Dispute timestamp when present."),
        failureCode: stringProperty("Failure code when present."),
        failureMessage: stringProperty("Failure message when present."),
      },
    },
  },
  ["accountId", "payment", "moneyTimeline", "status"],
);

const paymentsRefundStatusOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    paymentId: stringProperty("Payment identifier."),
    orderIds: arrayProperty("Order identifiers paid by the payment.", stringProperty("Order identifier.")),
    status: {
      type: "object",
      description: "Compact payment, refund, and dispute status.",
      additionalProperties: true,
      properties: {},
    },
    orderRefundCaps: arrayProperty("Per-order refund caps.", {
      type: "object",
      description: "Order refund cap.",
      additionalProperties: true,
      properties: {},
    }),
    orderRefundedAmounts: arrayProperty("Per-order refunded amounts.", {
      type: "object",
      description: "Order refunded amount.",
      additionalProperties: true,
      properties: {},
    }),
    moneyTimeline: {
      type: "object",
      description: "Payment money-movement timeline.",
      additionalProperties: true,
      properties: {},
    },
  },
  ["accountId", "paymentId", "orderIds", "status", "orderRefundCaps", "orderRefundedAmounts", "moneyTimeline"],
);

const paymentsPaymentMethodSetupOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Payment-method setup reference."),
    setupReferenceId: stringProperty("Payment-method setup reference to poll for attachment."),
    status: stringProperty("Provider-neutral setup session status."),
    url: stringProperty("Hosted HTTPS card-setup page URL. No client secret is exposed."),
    consentText: stringProperty("Consent text the buyer accepts when saving the payment method."),
  },
  ["accountId", "id", "setupReferenceId", "status", "url", "consentText"],
);

const paymentsPaymentMethodConfirmationOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    setupReferenceId: stringProperty("Payment-method setup reference that was polled."),
    attached: booleanProperty("Whether a payment method is now attached to the account."),
    status: stringProperty("Attachment status: attached or pending."),
    paymentMethod: {
      type: "object",
      description: "Display-safe stored payment-method facts. No provider reference or fingerprint.",
      additionalProperties: true,
      required: ["instrumentId", "displayLabel", "paymentMethodCategory", "isDefault", "readiness"],
      properties: {
        instrumentId: stringProperty("Chase Sets stored payment-method identifier."),
        displayLabel: stringProperty("Display label, e.g. brand and last four digits."),
        paymentMethodCategory: stringProperty("Payment-method category."),
        isDefault: booleanProperty("Whether this is the account default payment method."),
        readiness: stringProperty("Stored payment-method readiness."),
      },
    },
  },
  ["accountId", "setupReferenceId", "attached", "status"],
);

const fulfillmentTrackingOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    shipmentId: stringProperty("Shipment identifier."),
    status: stringProperty("Current shipment status."),
    carrierName: stringProperty("Carrier name when present."),
    trackingIdentifier: stringProperty("Tracking identifier when present."),
    labelStatus: stringProperty("Label status when present."),
    dispatchedAt: stringProperty("Dispatch timestamp when present."),
    deliveredAt: stringProperty("Delivery timestamp when present."),
    returnedAt: stringProperty("Return timestamp when present."),
    exceptionRaisedAt: stringProperty("Exception timestamp when present."),
    currentExceptionType: stringProperty("Current exception type when present."),
    currentExceptionNotes: stringProperty("Current exception notes when present."),
    providerEvents: arrayProperty("Provider tracking events.", {
      type: "object",
      description: "Postage provider event.",
      additionalProperties: true,
      properties: {},
    }),
    resourceUri: stringProperty("MCP resource URI for the shipment."),
  },
  ["accountId", "shipmentId", "status", "providerEvents", "resourceUri"],
);

const settlementWalletOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    wallet: {
      type: "object",
      description: "Settlement wallet balance row.",
      additionalProperties: true,
      required: ["account_id", "currency_code", "pending_balance_amount", "available_balance_amount"],
      properties: {
        account_id: stringProperty("Account that owns the wallet."),
        currency_code: stringProperty("Wallet currency code."),
        pending_balance_amount: stringProperty("Pending balance amount."),
        available_balance_amount: stringProperty("Available balance amount."),
      },
    },
  },
  ["accountId", "wallet"],
);

const settlementLedgerEntryOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement ledger entry row.",
  additionalProperties: true,
  required: ["ledger_entry_id", "account_id", "kind", "direction", "amount", "currency_code", "funds_status"],
  properties: {
    ledger_entry_id: stringProperty("Ledger entry identifier."),
    account_id: stringProperty("Account that owns the ledger entry."),
    kind: stringProperty("Ledger entry kind."),
    direction: stringProperty("Debit or credit direction."),
    amount: stringProperty("Ledger entry amount."),
    currency_code: stringProperty("Ledger entry currency code."),
    funds_status: stringProperty("Funds status."),
  },
};

const settlementLedgerEntriesOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    items: arrayProperty("Ledger entries visible to the actor.", settlementLedgerEntryOutputProperty),
    total: integerProperty("Total ledger entry count."),
    count: integerProperty("Returned ledger entry count."),
  },
  ["accountId", "items", "total", "count"],
);

const settlementPayoutOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement payout row.",
  additionalProperties: true,
  required: ["payout_id", "account_id", "amount", "currency_code", "status", "requested_at", "updated_at"],
  properties: {
    payout_id: stringProperty("Payout identifier."),
    account_id: stringProperty("Account that owns the payout."),
    amount: stringProperty("Payout amount."),
    currency_code: stringProperty("Payout currency code."),
    status: stringProperty("Payout lifecycle status."),
    requested_at: stringProperty("Payout request timestamp."),
    updated_at: stringProperty("Payout update timestamp."),
  },
};

const settlementPayoutsOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    items: arrayProperty("Payouts visible to the actor.", settlementPayoutOutputProperty),
    total: integerProperty("Total payout count."),
    count: integerProperty("Returned payout count."),
  },
  ["accountId", "items", "total", "count"],
);

const settlementPayoutOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    payout: settlementPayoutOutputProperty,
  },
  ["accountId", "payout"],
);

const settlementPayoutReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Payout identifier."),
    payoutId: stringProperty("Payout identifier."),
    version: integerProperty("Committed payout stream version."),
    status: stringProperty("Payout lifecycle status."),
    resourceUri: stringProperty("MCP resource URI for the payout."),
    payout: settlementPayoutOutputProperty,
  },
  ["accountId", "id", "payoutId", "version", "status", "resourceUri", "payout"],
);

const settlementReadinessOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Settlement payout readiness row.",
  additionalProperties: true,
  required: ["account_id", "status", "missing_requirements", "onboarding_status", "updated_at"],
  properties: {
    account_id: stringProperty("Account that owns the readiness row."),
    status: stringProperty("Provider-neutral payout readiness status."),
    missing_requirements: arrayProperty("Provider-neutral missing requirement keys.", stringProperty("Requirement.")),
    provider_reference: stringProperty("Provider connected account reference."),
    onboarding_status: stringProperty("Provider-neutral onboarding status."),
    updated_at: stringProperty("Last readiness update timestamp."),
  },
};

const settlementReadinessReceiptOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Account identifier."),
    status: stringProperty("Provider-neutral payout readiness status."),
    readiness: settlementReadinessOutputProperty,
    resourceUri: stringProperty("MCP resource URI for the settlement wallet."),
  },
  ["accountId", "id", "status", "readiness", "resourceUri"],
);

const settlementHostedOnboardingLinkOutputSchema = objectSchema(
  {
    accountId: stringProperty("Authenticated account scope."),
    id: stringProperty("Provider connected account reference."),
    providerReference: stringProperty("Provider connected account reference."),
    status: stringProperty("Provider-neutral payout readiness status."),
    url: stringProperty("Hosted provider onboarding URL."),
    expiresAt: stringProperty("Hosted onboarding link expiration timestamp."),
    readiness: settlementReadinessOutputProperty,
  },
  ["accountId", "id", "providerReference", "status", "url", "readiness"],
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
    feeQuoteFingerprint: stringProperty("Marketplace sales-fee quote fingerprint."),
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
    quantityRequested: integerProperty("Quantity requested by the buyer."),
    offerIdOverride: stringProperty("Optional deterministic offer id for idempotent handoffs."),
    idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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

export const mcpServiceCatalog = [
  {
    ...service(
      "auth",
      "Auth",
      "bounded-contexts/auth",
      "Sessions, account selection, authentication methods, and actor resolution.",
      "security.manage",
      ["session"],
      {
        packageName: "@chase-sets/auth",
      },
    ),
    tools: [
      readTool(
        "auth",
        "resolve-actor",
        "Resolve Actor",
        "Resolve the current actor and selected account from an agent session.",
        "accounts.view",
        emptySchema,
        "actor",
        ["Use as the first step in account-scoped agent flows."],
      ),
      readTool(
        "auth",
        "list-sessions",
        "List Sessions",
        "List active sessions visible to a security operator.",
        "security.manage",
        objectSchema({ userId: stringProperty("User identifier.") }),
        "session",
        ["Use when investigating account access or stale sessions."],
        "operator",
      ),
      writeTool(
        "auth",
        "revoke-session",
        "Revoke Session",
        "Revoke an active authentication session.",
        "security.manage",
        mutationInput("sessionId", "Session to revoke."),
        "session",
        ["Use only for explicit account security remediation."],
        "destructive",
        "operator",
      ),
    ],
    resources: [
      resource(
        "auth",
        "chase-sets://auth/actor",
        "Current Actor",
        "Actor, account, and permission facts for the current agent session.",
        "accounts.view",
        ["Use to understand the account and permission boundary before calling tools."],
      ),
    ],
  },
  {
    ...service(
      "authenticity",
      "Authenticity",
      "bounded-contexts/authenticity",
      "Authenticity case lifecycle: judgment records for authenticity-checked orders.",
      "authenticity.view",
      ["authenticity-case"],
      {
        packageName: "@chase-sets/authenticity",
      },
    ),
    tools: [
      {
        ...readTool(
          "authenticity",
          "get-case-status",
          "Get Authenticity Case Status",
          "Read the authenticity case status for an order.",
          "authenticity.view",
          objectSchema({ orderId: stringProperty("Order identifier.") }, ["orderId"]),
          "authenticity-case",
          ["Use to check whether an order's authenticity check has passed, failed, or is still in progress."],
        ),
        availability: "available",
      },
    ],
    resources: [
      {
        ...resource(
          "authenticity",
          "chase-sets://authenticity/cases/{caseId}",
          "Authenticity Case",
          "Authenticity case read model: lifecycle status, verdict, and reason codes.",
          "authenticity.view",
          ["Use to read the full case record once the case id is known."],
        ),
        availability: "available",
      },
    ],
  },
  {
    ...service(
      "identity",
      "Identity",
      "bounded-contexts/identity",
      "Accounts, users, memberships, invitations, consent, and API keys.",
      "accounts.view",
      ["account"],
      {
        packageName: "@chase-sets/identity",
      },
    ),
    tools: [
      {
        ...readTool(
          "identity",
          "get-account",
          "Get Account",
          "Read account profile, status, and membership summary.",
          "accounts.view",
          objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
          "account",
          ["Use when an agent needs account profile facts or status."],
        ),
        availability: "available",
      },
      readTool(
        "identity",
        "list-memberships",
        "List Memberships",
        "List account memberships and role permissions.",
        "memberships.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "membership",
        ["Use before inviting, changing, or revoking team access."],
      ),
      writeTool(
        "identity",
        "invite-member",
        "Invite Member",
        "Send a membership invitation for an account.",
        "memberships.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            email: stringProperty("Invitee email address."),
            roleKey: stringProperty("Role to grant.", ["owner", "manager", "fulfillment", "viewer"]),
            idempotencyKey: stringProperty("Stable key supplied by the agent host."),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the invitation without sending it."),
          },
          ["accountId", "email", "roleKey", "idempotencyKey", "confirmationText"],
        ),
        "membership",
        ["Use for explicit account administration requests."],
      ),
      writeTool(
        "identity",
        "revoke-api-key",
        "Revoke API Key",
        "Revoke an account API key.",
        "security.manage",
        mutationInput("apiKeyId", "API key to revoke."),
        "api-key",
        ["Use for confirmed credential rotation or incident response."],
        "destructive",
      ),
    ],
    resources: [
      {
        ...resource(
          "identity",
          "chase-sets://identity/{accountId}/account",
          "Account",
          "Account profile, badge, and lifecycle read model.",
          "accounts.view",
          ["Use when an agent needs account profile facts or status."],
        ),
        availability: "available",
      },
      resource(
        "identity",
        "chase-sets://identity/{accountId}/memberships",
        "Memberships",
        "Account membership and permission read model.",
        "memberships.view",
        ["Use before any team or role mutation."],
      ),
    ],
  },
  {
    ...service(
      "catalog",
      "Catalog",
      "bounded-contexts/catalog",
      "Categories, dimensions, fields, components, blueprints, and catalog items.",
      "catalog.view",
      ["catalog-item"],
      {
        packageName: "@chase-sets/catalog",
      },
    ),
    tools: [
      readTool(
        "catalog",
        "search-items",
        "Search Catalog Items",
        "Search published and administrative catalog item read models.",
        "catalog.view",
        objectSchema({
          query: stringProperty("Catalog search term."),
          blueprintId: stringProperty("Optional blueprint filter."),
        }),
        "catalog-item",
        ["Use before mapping inventory, listings, or pricing to a canonical catalog item."],
      ),
      readTool(
        "catalog",
        "get-blueprint",
        "Get Blueprint",
        "Read blueprint dimensions, components, and product resolution rules.",
        "catalog.view",
        objectSchema({ blueprintId: stringProperty("Blueprint identifier.") }, ["blueprintId"]),
        "blueprint",
        ["Use to understand valid product metadata and dimensions."],
      ),
      writeTool(
        "catalog",
        "publish-item",
        "Publish Catalog Item",
        "Publish a catalog item for marketplace use.",
        "catalog.manage",
        mutationInput("catalogItemId", "Catalog item to publish."),
        "catalog-item",
        ["Use after validating dimensions, fields, and merchandising readiness."],
      ),
    ],
    resources: [
      resource(
        "catalog",
        "chase-sets://catalog/items/{catalogItemId}",
        "Catalog Item",
        "Canonical item facts and public merchandising state.",
        "catalog.view",
        ["Use as the source of truth for product identity."],
      ),
    ],
  },
  {
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
            query: stringProperty("Marketplace search term."),
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
          ["Use to compare public marketplace options without exposing account-private data."],
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
  },
  {
    ...service(
      "inventory",
      "Inventory",
      "bounded-contexts/inventory",
      "Inventory items, holds, reservations, and storage locations.",
      "inventory.view",
      ["inventory-item"],
      {
        packageName: "@chase-sets/inventory",
      },
    ),
    tools: [
      {
        ...readTool(
          "inventory",
          "list-items",
          "List Inventory Items",
          "List inventory items, hold-derived availability, and sale readiness for an account.",
          "inventory.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              catalogItemId: stringProperty("Optional Catalog Item natural key filter."),
              productId: stringProperty("Optional resolved Product natural key filter."),
              storageLocationId: stringProperty("Optional storage location filter."),
              status: stringProperty("Deprecated alias for availability.", ["available", "held", "out-of-stock"]),
              availability: stringProperty("Optional hold-derived availability filter.", [
                "available",
                "held",
                "out-of-stock",
              ]),
              limit: integerProperty("Maximum items to return."),
              offset: integerProperty("Result offset."),
            },
            ["accountId"],
          ),
          "inventory-item",
          ["Use before creating or updating listings, pricing recommendations, or stock holds."],
        ),
        availability: "available",
        outputSchema: accountScopedListOutputSchema("Inventory item rows visible to the actor."),
      },
      {
        ...readTool(
          "inventory",
          "list-import-sources",
          "List Inventory Import Sources",
          "List supported inventory import source profiles, field mappings, external reference candidates, and option inference rules.",
          "inventory.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
            },
            ["accountId"],
          ),
          "import-source-profile",
          ["Use before creating an import batch so agents can choose the right sourceKey and row shape."],
        ),
        availability: "available",
        outputSchema: inventoryImportSourcesOutputSchema,
      },
      {
        ...writeTool(
          "inventory",
          "create-import-batch",
          "Create Inventory Import Batch",
          "Create a review-first import batch from CSV text or pre-parsed provider rows.",
          "inventory.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              sourceKey: stringProperty("Configured import source key."),
              quantityMode: stringProperty("How row quantities should affect stock.", ["add", "replace"]),
              csvText: stringProperty("CSV text to parse through the configured source profile."),
              parsedRows: arrayProperty("Pre-parsed rows to normalize through the configured source profile.", {
                type: "object",
                description: "Parsed row with rowNumber and string values.",
                additionalProperties: true,
              }),
              defaultStorageLocationId: stringProperty("Default Inventory Storage Location for rows that omit one."),
              sourceFilename: stringProperty("Original file or connector source name."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "sourceKey", "quantityMode", "idempotencyKey", "confirmationText"],
          ),
          "import-batch",
          ["Use after source rows are fetched and before committing stock or draft listings."],
        ),
        availability: "available",
        outputSchema: inventoryImportBatchDetailOutputSchema,
      },
      {
        ...readTool(
          "inventory",
          "get-import-batch",
          "Get Inventory Import Batch",
          "Read import batch match results, validation errors, and committed inventory/listing ids.",
          "inventory.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              batchId: stringProperty("Import batch identifier."),
            },
            ["accountId", "batchId"],
          ),
          "import-batch",
          ["Use after creating a batch to inspect accepted, rejected, unresolved, and committed rows."],
        ),
        availability: "available",
        outputSchema: inventoryImportBatchDetailOutputSchema,
      },
      {
        ...writeTool(
          "inventory",
          "commit-import-batch",
          "Commit Inventory Import Batch",
          "Commit accepted import rows into Inventory Items and draft Listings when listing fields are present.",
          "inventory.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              batchId: stringProperty("Import batch identifier."),
              reason: stringProperty("Business reason for the action."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "batchId", "reason", "idempotencyKey", "confirmationText"],
          ),
          "import-batch",
          ["Use only after reviewing match outcomes and confirming rejected rows should remain in review."],
        ),
        availability: "available",
        outputSchema: inventoryImportBatchDetailOutputSchema,
      },
      {
        ...writeTool(
          "inventory",
          "adjust-item",
          "Adjust Inventory Item",
          "Adjust inventory item quantity through the stock ledger while preserving active hold constraints.",
          "inventory.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              inventoryItemId: stringProperty("Inventory item to adjust."),
              quantityDelta: integerProperty(
                "Signed quantity adjustment. Positive adds stock; negative removes stock.",
              ),
              reason: stringProperty("Business reason for the stock adjustment."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "inventoryItemId", "quantityDelta", "reason", "idempotencyKey", "confirmationText"],
          ),
          "inventory-item",
          ["Use for explicit stock corrections after checking active holds and ledger history."],
        ),
        availability: "available",
      },
      writeTool(
        "inventory",
        "archive-location",
        "Archive Storage Location",
        "Archive a storage location no longer in use.",
        "inventory.manage",
        mutationInput("storageLocationId", "Storage location to archive."),
        "storage-location",
        ["Use only after confirming no active inventory depends on the location."],
        "destructive",
      ),
    ],
    resources: [
      {
        ...resource(
          "inventory",
          "chase-sets://inventory/{accountId}/items/{inventoryItemId}",
          "Inventory Item",
          "Seller-owned inventory item state, hold-derived availability, and stock ledger.",
          "inventory.view",
          ["Use before pricing, listing, stock holds, or adjustment actions."],
        ),
        availability: "available",
      },
      {
        ...resource(
          "inventory",
          "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          "Inventory Import Batch",
          "Review-first inventory import batch with product match and draft listing outcomes.",
          "inventory.view",
          ["Use after an agent creates or commits an import batch."],
        ),
        availability: "available",
      },
    ],
  },
  {
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
              subjectAccountId: stringProperty("Account whose reputation summary should be read."),
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
              subjectAccountId: stringProperty("Reviewed account for public review reads."),
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
              quantityCap: integerProperty("Maximum listed quantity."),
              purchaseLimits: listingPurchaseLimitsInputProperty,
              listingIdOverride: stringProperty("Optional deterministic listing id for idempotent handoffs."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "inventoryItemId", "priceAmount", "quantityCap", "idempotencyKey", "confirmationText"],
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
              feeQuoteFingerprint: stringProperty("Current marketplace sales-fee quote fingerprint."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "listingId", "priceAmount", "idempotencyKey", "confirmationText"],
          ),
          "listing",
          ["Use after reading the listing and confirming the current marketplace terms preview."],
        ),
        availability: "available",
        outputSchema: marketplaceListingReceiptOutputSchema,
      },
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
              feeQuoteFingerprint: stringProperty("Current marketplace sales-fee quote fingerprint."),
              sourceActionKey: stringProperty("Optional source action key for semantic handoffs."),
              reason: stringProperty("Business reason for the action."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "offerId", "feeQuoteFingerprint", "idempotencyKey", "confirmationText"],
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
  },
  {
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
  },
  {
    ...service(
      "commercial-terms",
      "Commercial Terms",
      "bounded-contexts/commercial-terms",
      "Agreement schedules, fee terms, settlement terms, and order/listing term resolution.",
      "commercial-terms.view",
      ["agreement"],
      {
        packageName: "@chase-sets/commercial-terms",
      },
    ),
    tools: [
      readTool(
        "commercial-terms",
        "resolve-listing-terms",
        "Resolve Listing Terms",
        "Resolve terms that apply to a listing or account sale workflow.",
        "commercial-terms.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            listingId: stringProperty("Listing identifier."),
          },
          ["accountId", "listingId"],
        ),
        "terms-resolution",
        ["Use before publishing listings or accepting offers."],
      ),
      writeTool(
        "commercial-terms",
        "publish-schedule",
        "Publish Terms Schedule",
        "Publish a commercial terms schedule.",
        "commercial-terms.manage",
        mutationInput("scheduleId", "Terms schedule to publish."),
        "terms-schedule",
        ["Use only for explicit policy administration changes."],
        "sensitive",
        "operator",
      ),
    ],
    resources: [
      resource(
        "commercial-terms",
        "chase-sets://commercial-terms/{accountId}/agreements/{agreementId}",
        "Agreement",
        "Commercial agreement and applied schedule state.",
        "commercial-terms.view",
        ["Use to inspect fee and payout terms."],
      ),
    ],
  },
  {
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
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
  },
  {
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
  },
  {
    ...service(
      "payments",
      "Payments",
      "bounded-contexts/payments",
      "Payment sessions, payment events, refunds, and provider webhook normalization.",
      "orders.view",
      ["payment"],
      {
        packageName: "@chase-sets/payments",
      },
    ),
    tools: [
      {
        ...writeTool(
          "payments",
          "start-payment-method-setup",
          "Start Payment Method Setup",
          "Create a one-time Stripe-hosted card-setup page and return its HTTPS URL for URL-mode elicitation. A card number never transits chat; the buyer enters it on the hosted page.",
          "orders.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              returnUrl: stringProperty("HTTPS URL where the hosted page returns after card setup."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate without creating a hosted setup session."),
            },
            ["accountId", "returnUrl", "idempotencyKey", "confirmationText"],
          ),
          "payment-method-setup",
          [
            "Use once, before in-chat checkout completion, when the account has no stored payment method.",
            "Return the hosted URL to the user for a one-time card-entry hop; then poll confirm-payment-method-setup.",
          ],
          "sensitive",
        ),
        availability: "available",
        outputSchema: paymentsPaymentMethodSetupOutputSchema,
      },
      {
        ...readTool(
          "payments",
          "confirm-payment-method-setup",
          "Confirm Payment Method Setup",
          "Poll a payment-method setup session and confirm whether a stored payment method is now attached to the account.",
          "orders.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              setupReferenceId: stringProperty("Setup reference returned by start-payment-method-setup."),
            },
            ["accountId", "setupReferenceId"],
          ),
          "payment-method-setup",
          ["Poll after directing the user to the hosted setup URL, until attachment is confirmed."],
        ),
        availability: "available",
        outputSchema: paymentsPaymentMethodConfirmationOutputSchema,
      },
      {
        ...readTool(
          "payments",
          "get-payment",
          "Get Payment",
          "Read payment and refund state for an order payment.",
          "orders.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              paymentId: stringProperty("Payment identifier."),
            },
            ["accountId", "paymentId"],
          ),
          "payment",
          ["Use before refund, support, or order readiness actions."],
        ),
        availability: "available",
        outputSchema: paymentsPaymentStatusOutputSchema,
      },
      {
        ...readTool(
          "payments",
          "get-refund-status",
          "Get Refund Status",
          "Read refund and dispute status for an account payment.",
          "orders.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              paymentId: stringProperty("Payment identifier."),
            },
            ["accountId", "paymentId"],
          ),
          "refund",
          ["Use before explaining refund outcomes, dispute status, or support resolution state."],
        ),
        availability: "available",
        outputSchema: paymentsRefundStatusOutputSchema,
      },
      writeTool(
        "payments",
        "request-refund",
        "Request Refund",
        "Request a payment refund through the owning payment workflow.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            paymentId: stringProperty("Payment identifier."),
            amount: stringProperty("Refund amount in decimal currency format."),
            reason: stringProperty("Business reason for the refund."),
            idempotencyKey: stringProperty("Stable key supplied by the agent host."),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without requesting the refund."),
          },
          ["accountId", "paymentId", "amount", "reason", "idempotencyKey", "confirmationText"],
        ),
        "refund",
        ["Use only after order policy and participant intent are confirmed."],
        "sensitive",
      ),
    ],
    resources: [
      {
        ...resource(
          "payments",
          "chase-sets://payments/{accountId}/payments/{paymentId}",
          "Payment",
          "Payment processor status projected into Chase Sets.",
          "orders.view",
          ["Use for payment support and order readiness checks."],
        ),
        availability: "available",
      },
    ],
  },
  {
    ...service(
      "fulfillment",
      "Fulfillment",
      "bounded-contexts/fulfillment",
      "Shipments, package details, label purchase, tracking, and delivery outcomes.",
      "fulfillment.view",
      ["shipment"],
      {
        packageName: "@chase-sets/fulfillment",
      },
    ),
    tools: [
      {
        ...readTool(
          "fulfillment",
          "list-shipments",
          "List Shipments",
          "List shipments for purchases or sales.",
          "fulfillment.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              side: stringProperty("Shipment side.", ["purchase", "sale"]),
            },
            ["accountId"],
          ),
          "shipment",
          ["Use before label, tracking, or delivery support actions."],
        ),
        availability: "available",
        outputSchema: accountScopedListOutputSchema("Fulfillment shipment rows visible to the actor."),
      },
      {
        ...readTool(
          "fulfillment",
          "get-tracking",
          "Get Tracking",
          "Read tracking and delivery status for a purchase or sale shipment.",
          "fulfillment.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              shipmentId: stringProperty("Shipment identifier."),
            },
            ["accountId", "shipmentId"],
          ),
          "shipment-tracking",
          ["Use to answer buyer post-purchase tracking and delivery questions."],
        ),
        availability: "available",
        outputSchema: fulfillmentTrackingOutputSchema,
      },
      {
        ...writeTool(
          "fulfillment",
          "purchase-label",
          "Purchase Label",
          "Purchase a postage label through the fulfillment workflow.",
          "fulfillment.manage",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              shipmentId: stringProperty("Shipment needing a label."),
              serviceLevel: stringProperty("USPS service level."),
              sender: postageAddressProperty("Optional sender address override."),
              recipient: postageAddressProperty("Optional recipient address override."),
              overrideReason: stringProperty("Reason for changing sender or recipient address snapshots."),
              package: postagePackageProperty(),
              reason: stringProperty("Business reason for the action."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate the action without committing it."),
            },
            ["accountId", "shipmentId", "reason", "idempotencyKey", "confirmationText"],
          ),
          "shipment",
          ["Use after confirming package, sender, recipient, and service level."],
          "sensitive",
        ),
        availability: "available",
      },
      {
        ...writeTool(
          "fulfillment",
          "void-label",
          "Void Label",
          "Void an unused postage label.",
          "fulfillment.manage",
          mutationInput("shipmentId", "Shipment with label to void."),
          "shipment",
          ["Use only after confirming the label is unused and eligible to void."],
          "destructive",
        ),
        availability: "available",
      },
    ],
    resources: [
      {
        ...resource(
          "fulfillment",
          "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}",
          "Shipment",
          "Shipment state, package, label, and tracking read model.",
          "fulfillment.view",
          ["Use before fulfillment mutations."],
        ),
        availability: "available",
      },
    ],
  },
  {
    ...service(
      "settlement",
      "Settlement",
      "bounded-contexts/settlement",
      "Wallets, ledger entries, payout readiness, payout requests, and reconciliation.",
      "payouts.view",
      ["wallet"],
      {
        packageName: "@chase-sets/settlement",
      },
    ),
    tools: [
      {
        ...readTool(
          "settlement",
          "get-wallet",
          "Get Wallet",
          "Read account wallet balance, pending funds, and payout readiness.",
          "payouts.view",
          objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
          "wallet",
          ["Use before payout setup, payout request, or reconciliation actions."],
        ),
        availability: "available",
        outputSchema: settlementWalletOutputSchema,
      },
      {
        ...readTool(
          "settlement",
          "list-ledger-entries",
          "List Ledger Entries",
          "Read account ledger entries that explain wallet balance changes.",
          "payouts.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              limit: integerProperty("Maximum number of ledger entries to return."),
              offset: integerProperty("Number of ledger entries to skip."),
            },
            ["accountId"],
          ),
          "ledger-entry",
          ["Use when explaining balance changes or payout availability."],
        ),
        availability: "available",
        outputSchema: settlementLedgerEntriesOutputSchema,
      },
      {
        ...readTool(
          "settlement",
          "list-payouts",
          "List Payouts",
          "Read account payout request history.",
          "payouts.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              limit: integerProperty("Maximum number of payouts to return."),
              offset: integerProperty("Number of payouts to skip."),
            },
            ["accountId"],
          ),
          "payout",
          ["Use to inspect payout history before requesting or reconciling payouts."],
        ),
        availability: "available",
        outputSchema: settlementPayoutsOutputSchema,
      },
      {
        ...readTool(
          "settlement",
          "get-payout",
          "Get Payout",
          "Read one payout by identifier.",
          "payouts.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              payoutId: stringProperty("Payout identifier."),
            },
            ["accountId", "payoutId"],
          ),
          "payout",
          ["Use to inspect payout status, provider references, or failure details."],
        ),
        availability: "available",
        outputSchema: settlementPayoutOutputSchema,
      },
      {
        ...writeTool(
          "settlement",
          "request-payout",
          "Request Payout",
          "Request an account payout from available balance.",
          "payouts.request",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              amount: stringProperty("Payout amount in decimal currency format."),
              reason: stringProperty("Business reason for payout request."),
              sensitiveActionToken: stringProperty("Step-up verification token when required by payout policy."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate without requesting payout."),
            },
            ["accountId", "amount", "reason", "idempotencyKey", "confirmationText"],
          ),
          "payout",
          ["Use only after confirming available balance and payout readiness."],
          "sensitive",
        ),
        availability: "available",
        outputSchema: settlementPayoutReceiptOutputSchema,
      },
      {
        ...writeTool(
          "settlement",
          "refresh-readiness",
          "Refresh Payout Readiness",
          "Refresh payout readiness from the money movement provider.",
          "payouts.setup",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              providerReference: stringProperty("Optional expected connected payout account reference."),
              contactEmail: stringProperty("Optional account contact email for provider setup."),
              reason: stringProperty("Business reason for refreshing payout readiness."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate without refreshing readiness."),
            },
            ["accountId", "reason", "idempotencyKey", "confirmationText"],
          ),
          "payout-readiness",
          ["Use when setup status appears stale or after provider onboarding."],
          "sensitive",
        ),
        availability: "available",
        outputSchema: settlementReadinessReceiptOutputSchema,
      },
      {
        ...writeTool(
          "settlement",
          "create-payout-onboarding-link",
          "Create Payout Onboarding Link",
          "Create a hosted provider onboarding link for account payout setup.",
          "payouts.setup",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              returnUrl: stringProperty("HTTPS URL where the provider returns after onboarding."),
              refreshUrl: stringProperty("HTTPS URL where the provider sends expired-link recovery."),
              contactEmail: stringProperty("Optional account contact email for provider setup."),
              reason: stringProperty("Business reason for creating a hosted onboarding link."),
              idempotencyKey: stringProperty("Stable key supplied by the agent host."),
              confirmationText: stringProperty("Exact user or policy confirmation text."),
              dryRun: booleanProperty("Validate without creating a hosted link."),
            },
            ["accountId", "returnUrl", "refreshUrl", "reason", "idempotencyKey", "confirmationText"],
          ),
          "payout-readiness",
          ["Use when an agent-driven account needs a hosted Stripe Connect onboarding handoff."],
          "sensitive",
        ),
        availability: "available",
        outputSchema: settlementHostedOnboardingLinkOutputSchema,
      },
    ],
    resources: [
      {
        ...resource(
          "settlement",
          "chase-sets://settlement/{accountId}/wallet",
          "Wallet",
          "Wallet, ledger summary, and payout state.",
          "payouts.view",
          ["Use for payout and reconciliation decisions."],
        ),
        availability: "available",
      },
      {
        ...resource(
          "settlement",
          "chase-sets://settlement/{accountId}/payouts/{payoutId}",
          "Payout",
          "Payout status, provider references, and failure details.",
          "payouts.view",
          ["Use for payout status and reconciliation decisions."],
        ),
        availability: "available",
      },
    ],
  },
  {
    ...service(
      "reputation",
      "Reputation",
      "bounded-contexts/marketplace",
      "Reviews, review summaries, and reputation signals for purchases and sales.",
      "reputation.view",
      ["review"],
      {
        packageName: "@chase-sets/marketplace",
      },
    ),
    tools: [
      readTool(
        "reputation",
        "get-summary",
        "Get Reputation Summary",
        "Read account reputation summary.",
        "reputation.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            subjectAccountId: stringProperty("Account being reviewed."),
          },
          ["accountId", "subjectAccountId"],
        ),
        "review-summary",
        ["Use before writing reviews or explaining seller/buyer history."],
      ),
      writeTool(
        "reputation",
        "submit-review",
        "Submit Review",
        "Submit a review for an eligible purchase or sale.",
        "reputation.manage",
        mutationInput("orderId", "Order being reviewed."),
        "review",
        ["Use only when the actor explicitly confirms rating and review text."],
        "sensitive",
      ),
    ],
    resources: [
      resource(
        "reputation",
        "chase-sets://reputation/{accountId}/summaries/{subjectAccountId}",
        "Reputation Summary",
        "Review rollup and participant-safe history.",
        "reputation.view",
        ["Use for trust and review workflows."],
      ),
    ],
  },
  {
    ...service(
      "insights",
      "Insights",
      "bounded-contexts/platform-operations",
      "Marketplace analytics, account performance summaries, and operational insights.",
      "accounts.view",
      ["insight"],
      {
        packageName: "@chase-sets/platform-operations",
      },
    ),
    tools: [
      readTool(
        "insights",
        "get-account-summary",
        "Get Account Summary",
        "Read account performance and marketplace workflow summary.",
        "accounts.view",
        objectSchema(
          { accountId: stringProperty("Authenticated account scope."), period: stringProperty("Reporting period.") },
          ["accountId", "period"],
        ),
        "insight",
        ["Use for non-mutating analysis and account health explanations."],
      ),
    ],
    resources: [
      resource(
        "insights",
        "chase-sets://insights/{accountId}/summary",
        "Account Insight Summary",
        "Aggregated operational insight read model.",
        "accounts.view",
        ["Use for analysis and recommendation context."],
      ),
    ],
  },
  {
    serviceId: "platform-operations",
    serviceName: "Platform Operations",
    kind: "bounded-context",
    owner: "bounded-contexts/platform-operations",
    packageName: "@chase-sets/platform-operations",
    serviceBoundary: "Operator workflows, support read models, risk queues, and current insight dashboard reads.",
    tools: [
      {
        ...readTool(
          "platform-operations",
          "get-seller-insight-summary",
          "Get Seller Insight Summary",
          "Read seller dashboard KPIs currently exposed by Platform Operations insights dashboards.",
          "accounts.view",
          objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
          "seller-insight-summary",
          ["Use for non-mutating seller performance analysis."],
        ),
        availability: "available",
      },
      {
        ...readTool(
          "platform-operations",
          "list-support-requests",
          "List Support Requests",
          "List buyer or seller support requests visible to the actor.",
          "support.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              side: stringProperty("Support request side.", ["buyer", "seller"]),
              limit: integerProperty("Maximum records to return."),
              offset: integerProperty("Zero-based record offset."),
            },
            ["accountId"],
          ),
          "support-request",
          ["Use to find refund, dispute, return, or delivery support status for an account."],
        ),
        availability: "available",
        outputSchema: accountScopedListOutputSchema("Support request rows visible to the actor."),
      },
      {
        ...readTool(
          "platform-operations",
          "get-support-request",
          "Get Support Request",
          "Read support request status, pending offers, resolution, and evidence visible to the actor.",
          "support.view",
          objectSchema(
            {
              accountId: stringProperty("Authenticated account scope."),
              supportRequestId: stringProperty("Support request identifier."),
            },
            ["accountId", "supportRequestId"],
          ),
          "support-request",
          ["Use to answer refund, dispute, return, or delivery support status questions."],
        ),
        availability: "available",
        outputSchema: accountScopedDetailOutputSchema("supportRequest", "Support request detail and status."),
      },
    ],
    resources: [
      {
        ...resource(
          "platform-operations",
          "chase-sets://platform-operations/{accountId}/insights/summary",
          "Seller Insight Summary",
          "Sales performance, fulfillment latency, and conversion KPI summary.",
          "accounts.view",
          ["Use for seller dashboard analysis."],
        ),
        availability: "available",
      },
      {
        ...resource(
          "platform-operations",
          "chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}",
          "Support Request",
          "Support request detail, resolution, pending offers, and refund-support status.",
          "support.view",
          ["Use for post-purchase support status and refund/dispute explanations."],
        ),
        availability: "available",
      },
    ],
  },
  {
    serviceId: "stripe-payments",
    serviceName: "Stripe Payments",
    kind: "external-provider",
    owner: "infrastructure/stripe-payments",
    packageName: "@chase-sets/stripe-payments",
    serviceBoundary:
      "Provider adapter for payment sessions, refunds, and Stripe payment webhooks. Agents should prefer Payments tools except for support-safe provider diagnostics.",
    tools: [
      readTool(
        "stripe-payments",
        "get-public-config",
        "Get Stripe Public Config",
        "Read publishable, non-secret payment processor configuration.",
        "orders.view",
        emptySchema,
        "processor-config",
        ["Use to explain payment confirmation capabilities without exposing secrets."],
        "operator",
      ),
      readTool(
        "stripe-payments",
        "inspect-payment-reference",
        "Inspect Stripe Payment Reference",
        "Inspect support-safe Stripe status for a known internal payment reference.",
        "orders.view",
        objectSchema(
          {
            paymentId: stringProperty("Internal payment identifier."),
            processorPaymentReference: stringProperty("Stripe payment reference."),
          },
          ["paymentId", "processorPaymentReference"],
        ),
        "processor-payment",
        ["Use for support diagnostics after checking the Payments read model."],
        "operator",
      ),
    ],
    resources: [
      resource(
        "stripe-payments",
        "chase-sets://providers/stripe-payments/payments/{paymentId}",
        "Stripe Payment Diagnostic",
        "Support-safe provider payment diagnostic view.",
        "orders.view",
        ["Use only for diagnostics; writes flow through Payments."],
        "operator",
      ),
    ],
  },
  {
    serviceId: "stripe-connect",
    serviceName: "Stripe Connect",
    kind: "external-provider",
    owner: "infrastructure/stripe-connect",
    packageName: "@chase-sets/stripe-connect",
    serviceBoundary:
      "Provider adapter for payout accounts, platform balance transfers, connected-account payouts, and money movement webhooks.",
    tools: [
      readTool(
        "stripe-connect",
        "inspect-payout-readiness",
        "Inspect Stripe Payout Readiness",
        "Inspect support-safe payout readiness for a connected account.",
        "payouts.reconcile",
        objectSchema(
          {
            accountId: stringProperty("Account identifier."),
            providerReference: stringProperty("Stripe connected account reference."),
          },
          ["accountId", "providerReference"],
        ),
        "provider-payout-readiness",
        ["Use after checking Settlement readiness when provider state must be explained."],
        "operator",
      ),
      writeTool(
        "stripe-connect",
        "replay-webhook",
        "Replay Stripe Connect Webhook",
        "Replay a captured money movement webhook through the provider webhook inbox.",
        "payouts.reconcile",
        mutationInput("providerEventId", "Provider event to replay."),
        "provider-webhook",
        ["Use only for confirmed reconciliation recovery."],
        "sensitive",
        "operator",
      ),
    ],
    resources: [
      resource(
        "stripe-connect",
        "chase-sets://providers/stripe-connect/accounts/{providerReference}",
        "Stripe Connected Account Diagnostic",
        "Support-safe provider payout account state.",
        "payouts.reconcile",
        ["Use for payout support and reconciliation diagnostics."],
        "operator",
      ),
    ],
  },
  {
    serviceId: "easypost-postage",
    serviceName: "EasyPost Postage",
    kind: "external-provider",
    owner: "infrastructure/easypost-postage",
    packageName: "@chase-sets/easypost-postage",
    serviceBoundary:
      "Provider adapter for USPS label purchase and voiding. Agents should prefer Fulfillment tools except for support-safe provider diagnostics.",
    tools: [
      readTool(
        "easypost-postage",
        "inspect-label",
        "Inspect EasyPost Label",
        "Inspect support-safe provider label status.",
        "fulfillment.view",
        objectSchema(
          {
            shipmentId: stringProperty("Shipment identifier."),
            providerLabelId: stringProperty("EasyPost label identifier."),
          },
          ["shipmentId", "providerLabelId"],
        ),
        "provider-label",
        ["Use after checking the Fulfillment shipment read model."],
        "operator",
      ),
      writeTool(
        "easypost-postage",
        "replay-tracking-event",
        "Replay Tracking Event",
        "Replay a captured tracking webhook through the provider webhook inbox.",
        "fulfillment.manage",
        mutationInput("providerEventId", "Provider event to replay."),
        "provider-webhook",
        ["Use only for confirmed fulfillment support recovery."],
        "sensitive",
        "operator",
      ),
    ],
    resources: [
      resource(
        "easypost-postage",
        "chase-sets://providers/easypost/labels/{providerLabelId}",
        "EasyPost Label Diagnostic",
        "Support-safe provider label diagnostic view.",
        "fulfillment.view",
        ["Use for label support diagnostics; purchase and void writes flow through Fulfillment."],
        "operator",
      ),
    ],
  },
] as const satisfies readonly McpServiceDescriptor[];

export function flattenMcpTools(services: readonly McpServiceDescriptor[] = mcpServiceCatalog): McpToolDescriptor[] {
  return services.flatMap((serviceDescriptor) => [...serviceDescriptor.tools]);
}

export function flattenMcpResources(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpResourceDescriptor[] {
  return services.flatMap((serviceDescriptor) => [...serviceDescriptor.resources]);
}

export function getMcpCapabilityAvailability(
  capability: Pick<McpToolDescriptor | McpResourceDescriptor, "availability">,
): McpCapabilityAvailability {
  return capability.availability ?? DEFAULT_MCP_CAPABILITY_AVAILABILITY;
}

export function isAvailableMcpCapability(capability: Pick<McpToolDescriptor | McpResourceDescriptor, "availability">) {
  return getMcpCapabilityAvailability(capability) === "available";
}

function toConfirmationExpectedValue(title: string) {
  const normalizedTitle = title.trim().replaceAll(/\s+/g, " ");
  if (!normalizedTitle) {
    return null;
  }

  return normalizedTitle.endsWith(".") ? normalizedTitle : `${normalizedTitle}.`;
}

export function getMcpToolConfirmationExpectedValue(tool: McpToolDescriptor): string | null {
  if (!tool.guardrails.confirmation.required || !tool.guardrails.confirmation.matchInputField) {
    return null;
  }

  return toConfirmationExpectedValue(tool.title);
}

export function flattenAvailableMcpTools(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpToolDescriptor[] {
  return flattenMcpTools(services).filter(isAvailableMcpCapability);
}

export function flattenAvailableMcpResources(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpResourceDescriptor[] {
  return flattenMcpResources(services).filter(isAvailableMcpCapability);
}

export function findMcpTool(
  toolName: string,
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpToolDescriptor | null {
  return flattenMcpTools(services).find((tool) => tool.name === toolName) ?? null;
}

export function authorizeMcpToolInvocation(
  tool: McpToolDescriptor,
  actor: McpActor | null,
  confirmation: Readonly<{ confirmed: boolean; text?: string | null }> = {
    confirmed: false,
  },
  input?: Readonly<Record<string, unknown>>,
): McpToolInvocationAuthorization {
  if (tool.permissionBoundary.scope !== "public" && actor === null) {
    return { allowed: false, reason: "An authenticated actor is required." };
  }

  const missingPermissions = tool.permissionBoundary.requiredPermissions.filter(
    (permission) => !(actor?.permissions.includes(permission) ?? false),
  );

  if (missingPermissions.length > 0) {
    const missingScopes = missingOAuthScopesForAuthorization(tool, actor, missingPermissions);
    if (missingScopes.length > 0) {
      return {
        allowed: false,
        reason: `Missing required OAuth scope: ${missingScopes.join(", ")}.`,
        missingScopes,
      };
    }

    return {
      allowed: false,
      reason: `Missing required permission: ${missingPermissions.join(", ")}.`,
    };
  }

  if (tool.permissionBoundary.accountScoped && !actor?.accountId) {
    return { allowed: false, reason: "An account-scoped actor is required." };
  }

  if (tool.guardrails.confirmation.required && !confirmation.confirmed) {
    return { allowed: false, reason: "Confirmation is required for this MCP tool." };
  }

  if (
    tool.guardrails.confirmation.required &&
    tool.guardrails.confirmation.matchInputField &&
    !confirmation.text?.trim()
  ) {
    return {
      allowed: false,
      reason: "Confirmation text is required for this MCP tool.",
    };
  }

  const confirmationExpectedValue = getMcpToolConfirmationExpectedValue(tool);
  const matchInputField = tool.guardrails.confirmation.matchInputField;

  if (confirmationExpectedValue && matchInputField) {
    const confirmationText = confirmation.text?.trim() ?? "";
    const inputConfirmationText = input?.[matchInputField];

    if (confirmationText !== confirmationExpectedValue) {
      return {
        allowed: false,
        reason: `Confirmation text must exactly match '${confirmationExpectedValue}'.`,
      };
    }

    if (input && typeof inputConfirmationText !== "string") {
      return {
        allowed: false,
        reason: `Confirmation input field '${matchInputField}' is required for this MCP tool.`,
      };
    }

    if (typeof inputConfirmationText === "string" && inputConfirmationText.trim() !== confirmationExpectedValue) {
      return {
        allowed: false,
        reason: `Confirmation input field '${matchInputField}' must exactly match '${confirmationExpectedValue}'.`,
      };
    }
  }

  return { allowed: true };
}

function missingOAuthScopesForAuthorization(
  tool: McpToolDescriptor,
  actor: McpActor | null,
  missingPermissions: readonly string[],
): readonly AgentOAuthScope[] {
  const grant = actor?.agentGrant;
  if (!grant || missingPermissions.length === 0) {
    return [];
  }

  const rolePermissions = new Set(grant.rolePermissions);
  if (missingPermissions.some((permission) => !rolePermissions.has(permission))) {
    return [];
  }

  const requiredScopes =
    tool.permissionBoundary.requiredScopes && tool.permissionBoundary.requiredScopes.length > 0
      ? tool.permissionBoundary.requiredScopes
      : agentOAuthScopesForPermissions(tool.permissionBoundary.requiredPermissions);
  const missingScopes = missingAgentOAuthScopesForPermissions(missingPermissions, grant.scopes).filter((scope) =>
    requiredScopes.includes(scope),
  );
  return [...new Set(missingScopes)].sort();
}

export function validateMcpServiceCatalog(
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
  expectedServiceIds: readonly string[] = [...CORE_MCP_SERVICE_IDS, ...EXTERNAL_MCP_SERVICE_IDS],
): string[] {
  const errors: string[] = [];
  const serviceIds = new Set(services.map((serviceDescriptor) => serviceDescriptor.serviceId));
  const toolNames = new Set<string>();
  const resourceTemplates = new Set<string>();

  for (const expectedServiceId of expectedServiceIds) {
    if (!serviceIds.has(expectedServiceId)) {
      errors.push(`Missing MCP service descriptor for '${expectedServiceId}'.`);
    }
  }

  for (const serviceDescriptor of services) {
    if (serviceDescriptor.tools.length === 0 && serviceDescriptor.resources.length === 0) {
      errors.push(`${serviceDescriptor.serviceId} must expose at least one tool or resource.`);
    }

    for (const tool of serviceDescriptor.tools) {
      if (tool.serviceId !== serviceDescriptor.serviceId) {
        errors.push(
          `${tool.name} has serviceId '${tool.serviceId}' but is registered under '${serviceDescriptor.serviceId}'.`,
        );
      }

      if (toolNames.has(tool.name)) {
        errors.push(`Duplicate MCP tool '${tool.name}'.`);
      }
      toolNames.add(tool.name);

      if (tool.inputSchema.type !== "object") {
        errors.push(`${tool.name} input schema must be an object.`);
      }

      if (!tool.audit.eventName || !tool.audit.targetType) {
        errors.push(`${tool.name} must define an audit event and target type.`);
      }

      if (tool.risk !== "read") {
        if (tool.permissionBoundary.scope === "public") {
          errors.push(`${tool.name} cannot be public because it is ${tool.risk}.`);
        }

        if (tool.permissionBoundary.requiredPermissions.length === 0) {
          errors.push(`${tool.name} must declare at least one required permission.`);
        }

        if (!tool.guardrails.confirmation.required) {
          errors.push(`${tool.name} must require confirmation.`);
        }

        if (
          tool.guardrails.confirmation.matchInputField &&
          !(tool.guardrails.confirmation.matchInputField in tool.inputSchema.properties)
        ) {
          errors.push(
            `${tool.name} confirmation match field '${tool.guardrails.confirmation.matchInputField}' must exist in the input schema.`,
          );
        }

        if (tool.guardrails.idempotencyKey !== "required") {
          errors.push(`${tool.name} must require an idempotency key.`);
        }
      }
    }

    for (const descriptor of serviceDescriptor.resources) {
      if (descriptor.serviceId !== serviceDescriptor.serviceId) {
        errors.push(
          `${descriptor.uriTemplate} has serviceId '${descriptor.serviceId}' but is registered under '${serviceDescriptor.serviceId}'.`,
        );
      }

      if (resourceTemplates.has(descriptor.uriTemplate)) {
        errors.push(`Duplicate MCP resource '${descriptor.uriTemplate}'.`);
      }
      resourceTemplates.add(descriptor.uriTemplate);
    }
  }

  return errors;
}
