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
}>;

export type McpToolInvocationAuthorization = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: string }>;

export const CORE_MCP_SERVICE_IDS = [
  "auth",
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
  accountScoped: scope === "account",
  auditPrincipal: "actor",
});

const publicBoundary: McpPermissionBoundary = {
  scope: "public",
  requiredPermissions: [],
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
      readTool(
        "identity",
        "get-account",
        "Get Account",
        "Read account profile, status, and membership summary.",
        "accounts.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "account",
        ["Use when an agent needs account profile facts or status."],
      ),
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
          "Search public marketplace supply.",
          "accounts.view",
          objectSchema({
            query: stringProperty("Marketplace search term."),
            filters: arrayProperty("Optional marketplace filters.", stringProperty("Filter expression.")),
          }),
          "market-search",
          ["Use to compare public marketplace options without exposing account-private data."],
        ),
        permissionBoundary: publicBoundary,
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
        permissionBoundary: publicBoundary,
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
      readTool(
        "inventory",
        "list-items",
        "List Inventory Items",
        "List inventory items and sale readiness for an account.",
        "inventory.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            status: stringProperty("Optional inventory status."),
          },
          ["accountId"],
        ),
        "inventory-item",
        ["Use before creating or updating listings."],
      ),
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
      writeTool(
        "inventory",
        "adjust-item",
        "Adjust Inventory Item",
        "Adjust inventory item quantity, condition, or storage metadata.",
        "inventory.manage",
        mutationInput("inventoryItemId", "Inventory item to adjust."),
        "inventory-item",
        ["Use for explicit stock corrections after checking open holds."],
      ),
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
      resource(
        "inventory",
        "chase-sets://inventory/{accountId}/items/{inventoryItemId}",
        "Inventory Item",
        "Seller-owned inventory item state.",
        "inventory.view",
        ["Use before pricing, listing, or fulfillment actions."],
      ),
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
      readTool(
        "marketplace",
        "list-listings",
        "List Listings",
        "List account listings and publication state.",
        "listings.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            status: stringProperty("Optional listing status."),
          },
          ["accountId"],
        ),
        "listing",
        ["Use before listing price or publication changes."],
      ),
      readTool(
        "marketplace",
        "list-offers",
        "List Offers",
        "List submitted offers and offer matches visible to the actor.",
        "offers.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Offer side.", ["submitted", "matched"]),
          },
          ["accountId"],
        ),
        "offer",
        ["Use before accepting, declining, or revising offers."],
      ),
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
      writeTool(
        "marketplace",
        "accept-offer",
        "Accept Offer",
        "Accept a buyer offer and begin order creation.",
        "offers.manage",
        mutationInput("offerId", "Offer to accept."),
        "offer",
        ["Use only after confirming price, quantity, and seller intent."],
        "sensitive",
      ),
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
      resource(
        "marketplace",
        "chase-sets://marketplace/{accountId}/offers/{offerId}",
        "Offer",
        "Offer state and participant-safe details.",
        "offers.view",
        ["Use before offer negotiation or acceptance."],
      ),
    ],
  },
  {
    ...service(
      "pricing",
      "Pricing",
      "bounded-contexts/pricing",
      "Market price snapshots, pricing signals, and price recommendations.",
      "listings.view",
      ["price-recommendation"],
      {
        packageName: "@chase-sets/pricing",
      },
    ),
    tools: [
      readTool(
        "pricing",
        "recommend-price",
        "Recommend Price",
        "Get a price recommendation for inventory or listing context.",
        "listings.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Catalog item identifier."),
            condition: stringProperty("Item condition or grade."),
          },
          ["accountId", "catalogItemId"],
        ),
        "price-recommendation",
        ["Use to support seller pricing decisions, not to mutate listings directly."],
      ),
      readTool(
        "pricing",
        "explain-signals",
        "Explain Pricing Signals",
        "Explain recent market, inventory, order, and fulfillment signals used by pricing.",
        "listings.view",
        objectSchema({ catalogItemId: stringProperty("Catalog item identifier.") }, ["catalogItemId"]),
        "market-price-snapshot",
        ["Use when an agent needs to justify a recommendation."],
      ),
    ],
    resources: [
      resource(
        "pricing",
        "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations",
        "Price Recommendation",
        "Pricing recommendation read model.",
        "listings.view",
        ["Use before listing price updates."],
      ),
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
      writeTool(
        "checkout",
        "add-cart-line",
        "Add Cart Line",
        "Add a listing or accepted offer to the cart.",
        "orders.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            listingId: stringProperty("Listing identifier."),
            quantity: stringProperty("Requested quantity."),
            idempotencyKey: stringProperty("Stable key supplied by the agent host."),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate without changing cart state."),
          },
          ["accountId", "listingId", "quantity", "idempotencyKey", "confirmationText"],
        ),
        "cart-line",
        ["Use after confirming buyer intent and current listing state."],
      ),
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
      readTool(
        "ordering",
        "list-orders",
        "List Orders",
        "List purchases and sales visible to the actor.",
        "orders.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            side: stringProperty("Order side.", ["purchase", "sale"]),
          },
          ["accountId"],
        ),
        "order",
        ["Use before fulfillment, payment, reputation, or support actions."],
      ),
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
      resource(
        "ordering",
        "chase-sets://ordering/{accountId}/orders/{orderId}",
        "Order",
        "Order state, lines, participant-safe totals, and workflow status.",
        "orders.view",
        ["Use as the source of truth for purchase and sale workflows."],
      ),
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
      readTool(
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
      resource(
        "payments",
        "chase-sets://payments/{accountId}/payments/{paymentId}",
        "Payment",
        "Payment processor status projected into Chase Sets.",
        "orders.view",
        ["Use for payment support and order readiness checks."],
      ),
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
      readTool(
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
      writeTool(
        "fulfillment",
        "purchase-label",
        "Purchase Label",
        "Purchase a postage label through the fulfillment workflow.",
        "fulfillment.manage",
        mutationInput("shipmentId", "Shipment needing a label."),
        "shipment",
        ["Use after confirming package, sender, recipient, and service level."],
        "sensitive",
      ),
      writeTool(
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
    ],
    resources: [
      resource(
        "fulfillment",
        "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}",
        "Shipment",
        "Shipment state, package, label, and tracking read model.",
        "fulfillment.view",
        ["Use before fulfillment mutations."],
      ),
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
      readTool(
        "settlement",
        "get-wallet",
        "Get Wallet",
        "Read account wallet balance, pending funds, and payout readiness.",
        "payouts.view",
        objectSchema({ accountId: stringProperty("Authenticated account scope.") }, ["accountId"]),
        "wallet",
        ["Use before payout setup, payout request, or reconciliation actions."],
      ),
      writeTool(
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
      writeTool(
        "settlement",
        "refresh-readiness",
        "Refresh Payout Readiness",
        "Refresh payout readiness from the money movement provider.",
        "payouts.setup",
        mutationInput("accountId", "Account whose readiness should be refreshed."),
        "payout-readiness",
        ["Use when setup status appears stale or after provider onboarding."],
        "sensitive",
      ),
    ],
    resources: [
      resource(
        "settlement",
        "chase-sets://settlement/{accountId}/wallet",
        "Wallet",
        "Wallet, ledger summary, and payout state.",
        "payouts.view",
        ["Use for payout and reconciliation decisions."],
      ),
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
