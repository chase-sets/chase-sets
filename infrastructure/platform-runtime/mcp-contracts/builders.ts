// MCP contract vocabulary and the descriptor builders every `catalog/` shard
// composes with. Shard-internal: `mcp-contracts.ts` is the only module that
// republishes anything from here, and it republishes only the type vocabulary
// and the service-id constants. Nothing in this file may be forked into a
// shard — a second `service()` with a drifted default is invisible to the
// catalog serialization until a new service relies on the defaults.
import {
  type AgentOAuthGrantContext,
  type AgentOAuthScope,
  agentOAuthScopesForPermissions,
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
  /** Omitted historical/generated descriptors are platform-authoritative. */
  idempotencyAuthority?: "platform" | "owner";
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

export const DEFAULT_MCP_CAPABILITY_AVAILABILITY: McpCapabilityAvailability = "planned";

export const emptySchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const stringProperty = (description: string, values?: readonly string[]): McpJsonSchemaProperty => ({
  type: "string",
  description,
  ...(values ? { enum: values } : {}),
});

export const booleanProperty = (description: string): McpJsonSchemaProperty => ({
  type: "boolean",
  description,
});

export const integerProperty = (description: string): McpJsonSchemaProperty => ({
  type: "integer",
  description,
});

export const arrayProperty = (description: string, items: McpJsonSchemaProperty): McpJsonSchemaProperty => ({
  type: "array",
  description,
  items,
});

// Shared guidance for every write tool's `idempotencyKey` field: the agent
// host must generate one stable value per logical action and resend that
// same value on every retry, so a retried call is deduped rather than
// repeated.
const IDEMPOTENCY_KEY_DESCRIPTION =
  "Stable unique string supplied by the agent host (for example, a UUID). Retried calls must reuse the same key so the action is applied at most once instead of repeating it.";

export const idempotencyKeyProperty = (): McpJsonSchemaProperty => stringProperty(IDEMPOTENCY_KEY_DESCRIPTION);

export const objectSchema = (
  properties: McpJsonSchema["properties"],
  required: readonly string[] = [],
): McpJsonSchema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

export const readBoundary = (permission: string, scope: McpAccessScope = "account"): McpPermissionBoundary => ({
  scope,
  requiredPermissions: [permission],
  requiredScopes: agentOAuthScopesForPermissions([permission]),
  accountScoped: scope === "account",
  auditPrincipal: "actor",
});

export const publicBoundary: McpPermissionBoundary = {
  scope: "public",
  requiredPermissions: [],
  requiredScopes: [],
  accountScoped: false,
  auditPrincipal: "actor",
};

export const guardrails = (risk: McpToolRisk, options: Partial<McpGuardrails> = {}): McpGuardrails => ({
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
  idempotencyAuthority: "platform",
  dryRunSupported: risk !== "read",
  notes:
    risk === "read"
      ? ["Return only account-scoped data that the actor can already view."]
      : ["Write through the owning bounded context and emit normal domain events."],
  ...options,
});

export const audit = (
  serviceId: string,
  action: string,
  targetType: string,
  sensitiveInputFields: readonly string[] = [],
): McpAuditPolicy => ({
  eventName: `mcp.${serviceId}.${action}`,
  targetType,
  sensitiveInputFields,
});

const sensitiveWriteInputFieldNames = ["amount", "confirmationText", "email", "reason", "idempotencyKey"] as const;

function sensitiveInputFieldsForWriteTool(inputSchema: McpJsonSchema): readonly string[] {
  const properties = inputSchema.properties ?? {};
  return sensitiveWriteInputFieldNames.filter((fieldName) => fieldName in properties);
}

export const readTool = (
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

export const writeTool = (
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

export const resource = (
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

export const service = (
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

export const mutationInput = (idName: string, description: string): McpJsonSchema =>
  objectSchema(
    {
      accountId: stringProperty("Authenticated account scope."),
      [idName]: stringProperty(description),
      reason: stringProperty("Business reason for the action."),
      idempotencyKey: idempotencyKeyProperty(),
      confirmationText: stringProperty("Exact user or policy confirmation text."),
      dryRun: booleanProperty("Validate the action without committing it."),
    },
    ["accountId", idName, "reason", "idempotencyKey", "confirmationText"],
  );

export const accountScopedListOutputSchema = (itemDescription: string): McpJsonSchema =>
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

export const accountScopedDetailOutputSchema = (key: string, description: string): McpJsonSchema =>
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
