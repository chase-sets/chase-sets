import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  authorizeMcpToolInvocation,
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  findMcpTool,
  flattenMcpResources,
  getMcpCapabilityAvailability,
  getMcpToolConfirmationExpectedValue,
  mcpServiceCatalog,
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpActor,
  type McpResourceDescriptor,
  type McpServiceDescriptor,
  type McpToolDescriptor,
} from "./mcp-contracts";
import type { McpToolCallLease, McpToolCallLimitKind, McpToolCallLimiter } from "./mcp-tool-call-limiter";
import type { ResolvedActor } from "./auth";
import { negotiateMcpProtocolVersion } from "./mcp-protocol";
import {
  createMemoryPlatformIdempotencyStore,
  type PlatformIdempotencyRecord,
  type PlatformIdempotencyStore,
} from "./idempotency";
import { resolveClientAddress } from "./http";

export type McpRuntimeEnv = {
  Variables: {
    actor: ResolvedActor | null;
  };
};

export type McpToolHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  tool: McpToolDescriptor;
  arguments: Readonly<Record<string, unknown>>;
  request: Request;
}>;

export type McpResourceHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  resource: McpResourceDescriptor;
  uri: string;
  request: Request;
}>;

export type McpToolHandler = (input: McpToolHandlerInput) => Promise<unknown> | unknown;

export type McpResourceHandler = (input: McpResourceHandlerInput) => Promise<unknown> | unknown;

export type McpAuditRecord = Readonly<{
  outcome: "allowed" | "denied" | "failed";
  method: string;
  toolName?: string;
  resourceUri?: string;
  actorId?: string | null;
  accountId?: string | null;
  auditEventName?: string;
  targetType?: string;
  reason?: string;
  sensitiveInputFields?: readonly string[];
  limitKind?: McpToolCallLimitKind;
}>;

export type McpAuditSink = (record: McpAuditRecord) => Promise<void> | void;

export type McpIdempotencyRecord = PlatformIdempotencyRecord<unknown>;

export type McpIdempotencyStore = PlatformIdempotencyStore<unknown>;

export type CreateMcpRoutesOptions = Readonly<{
  services?: readonly McpServiceDescriptor[];
  toolHandlers?: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers?: Readonly<Record<string, McpResourceHandler>>;
  audit?: McpAuditSink;
  idempotencyStore?: McpIdempotencyStore;
  toolCallLimiter?: McpToolCallLimiter;
  allowInMemoryIdempotencyStoreForTests?: boolean;
}>;

type JsonRpcRequest = Readonly<{
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}>;

type McpToolCallParams = Readonly<{
  name?: unknown;
  arguments?: unknown;
  confirmation?: unknown;
}>;

type McpResourceReadParams = Readonly<{
  uri?: unknown;
}>;

const JSON_RPC_VERSION = "2.0";
const IDEMPOTENCY_PENDING_TTL_MS = 2 * 60 * 1000;

type McpInputValidationIssue = Readonly<{
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}>;

type ResourceUriMatch = Readonly<{
  resource: McpResourceDescriptor;
  variables: Readonly<Record<string, string>>;
}>;

function toMcpActor(actor: ResolvedActor | null): McpActor | null {
  if (!actor) {
    return null;
  }

  return {
    actorId: actor.userId,
    accountId: actor.accountId,
    permissions: actor.permissions,
  };
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function mcpAuthenticationRequiredResponse(id: JsonRpcRequest["id"] = null) {
  return jsonRpcError(id, -32001, "An authenticated actor is required for native MCP discovery.");
}

function requireMcpDiscoveryActor(actor: ResolvedActor | null | undefined) {
  return actor ? null : mcpAuthenticationRequiredResponse();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return true;
}

function normalizeArguments(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function typeName(value: unknown) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function validatePrimitiveType(value: unknown, expected: McpJsonSchemaProperty["type"]) {
  switch (expected) {
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "boolean":
    case "string":
      return typeof value === expected;
  }
}

function validateSchemaProperty(
  value: unknown,
  schema: McpJsonSchemaProperty,
  path: string,
): McpInputValidationIssue[] {
  if (!validatePrimitiveType(value, schema.type)) {
    return [
      {
        path,
        message: `Expected ${schema.type}.`,
        expected: schema.type,
        actual: typeName(value),
      },
    ];
  }

  const issues: McpInputValidationIssue[] = [];

  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    issues.push({
      path,
      message: `Expected one of: ${schema.enum.join(", ")}.`,
      expected: schema.enum.join(" | "),
      actual: value,
    });
  }

  if (schema.type === "array" && schema.items) {
    (value as readonly unknown[]).forEach((item, index) => {
      issues.push(...validateSchemaProperty(item, schema.items as McpJsonSchemaProperty, `${path}[${index}]`));
    });
  }

  if (schema.type === "object" && schema.properties) {
    issues.push(
      ...validateObjectProperties(
        value as Readonly<Record<string, unknown>>,
        {
          additionalProperties: schema.additionalProperties,
          properties: schema.properties,
          required: schema.required,
        },
        path,
      ),
    );
  }

  return issues;
}

function validateObjectProperties(
  value: Readonly<Record<string, unknown>>,
  schema: Pick<McpJsonSchema, "additionalProperties" | "properties" | "required">,
  basePath = "",
): McpInputValidationIssue[] {
  const issues: McpInputValidationIssue[] = [];
  const properties = schema.properties;

  for (const field of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      issues.push({
        path: basePath ? `${basePath}.${field}` : field,
        message: "Required field is missing.",
        expected: "present",
        actual: "missing",
      });
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, field)) {
        issues.push({
          path: basePath ? `${basePath}.${field}` : field,
          message: "Unexpected field.",
        });
      }
    }
  }

  for (const [field, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      continue;
    }

    issues.push(...validateSchemaProperty(value[field], propertySchema, basePath ? `${basePath}.${field}` : field));
  }

  return issues;
}

function validateToolArguments(schema: McpJsonSchema, value: unknown): McpInputValidationIssue[] {
  if (value === undefined) {
    return validateObjectProperties({}, schema);
  }

  if (!isRecord(value)) {
    return [
      {
        path: "$",
        message: "Expected object.",
        expected: "object",
        actual: typeName(value),
      },
    ];
  }

  return validateObjectProperties(value, schema);
}

function normalizeConfirmation(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return {
      confirmed: false,
      text: null,
    };
  }

  const confirmation = value as Readonly<Record<string, unknown>>;
  return {
    confirmed: confirmation.confirmed === true,
    text:
      typeof confirmation.text === "string"
        ? confirmation.text
        : typeof confirmation.confirmationText === "string"
          ? confirmation.confirmationText
          : null,
  };
}

function hasRequiredIdempotencyKey(tool: McpToolDescriptor, args: Readonly<Record<string, unknown>>) {
  return (
    tool.guardrails.idempotencyKey !== "required" ||
    (typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function mcpIdempotencyKey(toolName: string, args: Readonly<Record<string, unknown>>, actor: ResolvedActor | null) {
  const digest = createHash("sha256")
    .update(
      stableJson({
        transport: "native-mcp",
        toolName,
        tenantId: actor?.tenantId ?? "anonymous",
        accountId: actor?.accountId ?? "anonymous",
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "",
      }),
    )
    .digest("base64url");
  return `mcp:${digest}`;
}

function mcpToolRequestHash(toolName: string, args: Readonly<Record<string, unknown>>) {
  const { idempotencyKey: _idempotencyKey, ...requestArguments } = args;
  return createHash("sha256")
    .update(
      stableJson({
        method: "tools/call",
        name: toolName,
        arguments: requestArguments,
      }),
    )
    .digest("base64url");
}

function createMemoryMcpIdempotencyStore(): McpIdempotencyStore {
  return createMemoryPlatformIdempotencyStore();
}

function isMcpTestRuntime() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function resolveMcpIdempotencyStore(options: CreateMcpRoutesOptions): McpIdempotencyStore {
  if (options.idempotencyStore) {
    return options.idempotencyStore;
  }

  if (
    isMcpTestRuntime() ||
    (options.allowInMemoryIdempotencyStoreForTests === true && process.env.NODE_ENV !== "production")
  ) {
    return createMemoryMcpIdempotencyStore();
  }

  throw new Error(
    "Native MCP routes require a durable idempotencyStore. Bootstrap platformUcpRuntimeSchemaSql and pass createPostgresUcpIdempotencyStore(...) for production mounts; allowInMemoryIdempotencyStoreForTests is only for isolated tests.",
  );
}

function redactArguments(args: Readonly<Record<string, unknown>>, sensitiveInputFields: readonly string[]) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, sensitiveInputFields.includes(key) ? "[redacted]" : value]),
  );
}

function toToolListItem(tool: McpToolDescriptor) {
  const confirmationExpectedValue = getMcpToolConfirmationExpectedValue(tool);

  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      serviceId: tool.serviceId,
      availability: getMcpCapabilityAvailability(tool),
      risk: tool.risk,
      requiredPermissions: tool.permissionBoundary.requiredPermissions,
      accountScoped: tool.permissionBoundary.accountScoped,
      confirmationRequired: tool.guardrails.confirmation.required,
      confirmationMatchInputField: tool.guardrails.confirmation.matchInputField ?? null,
      confirmationExpectedValue,
      idempotencyKey: tool.guardrails.idempotencyKey,
      dryRunSupported: tool.guardrails.dryRunSupported,
      auditEventName: tool.audit.eventName,
      expectedUsage: tool.expectedUsage,
    },
  };
}

function toResourceListItem(resource: McpResourceDescriptor) {
  return {
    uriTemplate: resource.uriTemplate,
    name: resource.title,
    title: resource.title,
    description: resource.description,
    annotations: {
      serviceId: resource.serviceId,
      availability: getMcpCapabilityAvailability(resource),
      requiredPermissions: resource.permissionBoundary.requiredPermissions,
      accountScoped: resource.permissionBoundary.accountScoped,
      expectedUsage: resource.expectedUsage,
    },
  };
}

function matchResourceUri(resource: McpResourceDescriptor, uri: string): ResourceUriMatch | null {
  const templateSegments = resource.uriTemplate.split("/");
  const uriSegments = uri.split("/");

  if (templateSegments.length !== uriSegments.length) {
    return null;
  }

  const variables: Record<string, string> = {};

  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index];
    const uriSegment = uriSegments[index];
    const variableMatch = /^\{([^}]+)\}$/.exec(templateSegment);

    if (variableMatch) {
      variables[variableMatch[1]] = decodeURIComponent(uriSegment);
      continue;
    }

    if (templateSegment !== uriSegment) {
      return null;
    }
  }

  return {
    resource,
    variables,
  };
}

function validateToolAccountOwnership(
  tool: McpToolDescriptor,
  actor: ResolvedActor | null,
  args: Readonly<Record<string, unknown>>,
) {
  if (!tool.permissionBoundary.accountScoped || typeof args.accountId !== "string") {
    return null;
  }

  if (args.accountId === actor?.accountId) {
    return null;
  }

  return "MCP tool accountId must match the authenticated actor account.";
}

function validateResourceAccountOwnership(
  resource: McpResourceDescriptor,
  actor: ResolvedActor | null,
  variables: Readonly<Record<string, string>>,
) {
  if (!resource.permissionBoundary.accountScoped || !variables.accountId) {
    return null;
  }

  if (variables.accountId === actor?.accountId) {
    return null;
  }

  return "MCP resource accountId must match the authenticated actor account.";
}

async function audit(sink: McpAuditSink | undefined, record: McpAuditRecord) {
  await sink?.(record);
}

async function auditBestEffort(sink: McpAuditSink | undefined, record: McpAuditRecord) {
  await Promise.resolve(sink?.(record)).catch(() => undefined);
}

function mcpToolLimitKind(tool: McpToolDescriptor, services: readonly McpServiceDescriptor[]): McpToolCallLimitKind {
  const service = services.find((candidate) => candidate.serviceId === tool.serviceId);
  if (service?.kind === "external-provider") {
    return "external-provider";
  }

  return tool.risk === "read" ? "read" : "write";
}

async function acquireMcpToolCallLease(
  limiter: McpToolCallLimiter | undefined,
  request: Request,
  tool: McpToolDescriptor,
  actor: ResolvedActor | null,
  services: readonly McpServiceDescriptor[],
): Promise<
  | Readonly<{
      allowed: true;
      lease?: McpToolCallLease;
      limitKind: McpToolCallLimitKind;
    }>
  | Readonly<{
      allowed: false;
      reason: string;
      limitKind: McpToolCallLimitKind;
    }>
> {
  const limitKind = mcpToolLimitKind(tool, services);
  if (!limiter) {
    return { allowed: true, limitKind };
  }

  try {
    const result = await limiter.acquire({
      transport: "native-mcp",
      toolName: tool.name,
      limitKind,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      clientAddress: resolveClientAddress(request),
    });

    return result.allowed
      ? { allowed: true, lease: result.lease, limitKind }
      : { allowed: false, reason: result.reason, limitKind };
  } catch {
    return { allowed: false, reason: "MCP tool call limiter is unavailable.", limitKind };
  }
}

async function callTool(
  request: Request,
  actor: ResolvedActor | null,
  params: McpToolCallParams,
  options: Required<Pick<CreateMcpRoutesOptions, "services" | "toolHandlers" | "idempotencyStore">> &
    Pick<CreateMcpRoutesOptions, "audit" | "toolCallLimiter">,
) {
  if (typeof params.name !== "string") {
    return jsonRpcError(null, -32602, "Tool name is required.");
  }

  const tool = findMcpTool(params.name, options.services);
  if (!tool) {
    return jsonRpcError(null, -32602, `Unknown MCP tool '${params.name}'.`);
  }

  const validationIssues = validateToolArguments(tool.inputSchema, params.arguments);
  if (validationIssues.length > 0) {
    const reason = "Invalid MCP tool arguments.";
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32602, reason, {
      issues: validationIssues,
    });
  }

  const args = normalizeArguments(params.arguments);
  const confirmation = normalizeConfirmation(
    params.confirmation ?? {
      confirmed: args.confirmed,
      text: args.confirmationText,
    },
  );
  const authorization = authorizeMcpToolInvocation(tool, toMcpActor(actor), confirmation, args);

  if (!authorization.allowed) {
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: authorization.reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32001, authorization.reason);
  }

  const accountOwnershipReason = validateToolAccountOwnership(tool, actor, args);
  if (accountOwnershipReason) {
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: accountOwnershipReason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32001, accountOwnershipReason);
  }

  if (!hasRequiredIdempotencyKey(tool, args)) {
    const reason = "An idempotency key is required for this MCP tool.";
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32001, reason);
  }

  const idempotency =
    tool.guardrails.idempotencyKey === "required"
      ? {
          key: mcpIdempotencyKey(tool.name, args, actor),
          requestHash: mcpToolRequestHash(tool.name, args),
        }
      : null;
  let reservedIdempotency: McpIdempotencyRecord | null = null;
  if (idempotency) {
    const createdAt = new Date();
    const reservation = await options.idempotencyStore.reserve({
      key: idempotency.key,
      requestHash: idempotency.requestHash,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_PENDING_TTL_MS).toISOString(),
    });
    if (reservation.outcome === "completed") {
      if (reservation.record.response) {
        await auditBestEffort(options.audit, {
          outcome: "allowed",
          method: "tools/call",
          toolName: tool.name,
          actorId: actor?.userId ?? null,
          accountId: actor?.accountId ?? null,
          auditEventName: tool.audit.eventName,
          targetType: tool.audit.targetType,
          reason: "idempotency-replay",
          sensitiveInputFields: tool.audit.sensitiveInputFields,
        });

        return reservation.record.response as ReturnType<typeof jsonRpcResult>;
      }
    }

    if (reservation.outcome === "pending") {
      return jsonRpcError(null, -32029, "A matching MCP tool call is already in progress. Retry later.");
    }

    if (reservation.outcome === "conflict") {
      const reason = "Idempotency key was already used with different MCP tool arguments.";
      await audit(options.audit, {
        outcome: "denied",
        method: "tools/call",
        toolName: tool.name,
        actorId: actor?.userId ?? null,
        accountId: actor?.accountId ?? null,
        auditEventName: tool.audit.eventName,
        targetType: tool.audit.targetType,
        reason,
        sensitiveInputFields: tool.audit.sensitiveInputFields,
      });

      return jsonRpcError(null, -32000, reason);
    }

    reservedIdempotency = reservation.record;
  }

  const handler = options.toolHandlers[tool.name];
  if (!handler) {
    if (idempotency) {
      await options.idempotencyStore.abandon(idempotency);
    }
    const reason = `No runtime handler is registered for MCP tool '${tool.name}'.`;
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32004, reason, {
      tool: toToolListItem(tool),
      redactedArguments: redactArguments(args, tool.audit.sensitiveInputFields),
    });
  }

  const limit = await acquireMcpToolCallLease(options.toolCallLimiter, request, tool, actor, options.services);
  if (!limit.allowed) {
    if (idempotency) {
      await options.idempotencyStore.abandon(idempotency);
    }
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: limit.reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
      limitKind: limit.limitKind,
    });

    return jsonRpcError(null, -32029, limit.reason);
  }

  try {
    const result = await handler({
      actor,
      tool,
      arguments: args,
      request,
    });
    const response = jsonRpcResult(null, {
      content: [
        {
          type: "json",
          json: result,
        },
      ],
    });
    if (reservedIdempotency) {
      await options.idempotencyStore.complete({
        ...reservedIdempotency,
        response,
      });
    }

    await auditBestEffort(options.audit, {
      outcome: "allowed",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return response;
  } catch (error) {
    if (idempotency) {
      await options.idempotencyStore.abandon(idempotency);
    }
    const reason = error instanceof Error ? error.message : String(error);
    await audit(options.audit, {
      outcome: "failed",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcError(null, -32000, reason);
  } finally {
    await Promise.resolve(limit.lease?.release()).catch(() => undefined);
  }
}

async function readResource(
  request: Request,
  actor: ResolvedActor | null,
  params: McpResourceReadParams,
  options: Required<Pick<CreateMcpRoutesOptions, "services" | "resourceHandlers">> &
    Pick<CreateMcpRoutesOptions, "audit">,
) {
  if (typeof params.uri !== "string") {
    return jsonRpcError(null, -32602, "Resource URI is required.");
  }

  const resourceMatch =
    flattenMcpResources(options.services)
      .map((candidate) => matchResourceUri(candidate, params.uri as string))
      .find((candidate) => candidate !== null) ?? null;

  if (!resourceMatch) {
    return jsonRpcError(null, -32602, `Unknown MCP resource '${params.uri}'.`);
  }

  const { resource, variables } = resourceMatch;
  const pseudoTool: McpToolDescriptor = {
    name: `resources/read:${resource.uriTemplate}`,
    title: resource.title,
    description: resource.description,
    serviceId: resource.serviceId,
    risk: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: {
          type: "string",
          description: "Resource URI to read.",
        },
      },
    },
    permissionBoundary: resource.permissionBoundary,
    guardrails: {
      confirmation: {
        required: false,
      },
      idempotencyKey: "not-applicable",
      dryRunSupported: false,
      notes: [],
    },
    audit: {
      eventName: `mcp.${resource.serviceId}.resources.read`,
      targetType: resource.title,
      sensitiveInputFields: [],
    },
    expectedUsage: resource.expectedUsage,
  };
  const authorization = authorizeMcpToolInvocation(pseudoTool, toMcpActor(actor));

  if (!authorization.allowed) {
    await audit(options.audit, {
      outcome: "denied",
      method: "resources/read",
      resourceUri: params.uri,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
      reason: authorization.reason,
    });

    return jsonRpcError(null, -32001, authorization.reason);
  }

  const accountOwnershipReason = validateResourceAccountOwnership(resource, actor, variables);
  if (accountOwnershipReason) {
    await audit(options.audit, {
      outcome: "denied",
      method: "resources/read",
      resourceUri: params.uri,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
      reason: accountOwnershipReason,
    });

    return jsonRpcError(null, -32001, accountOwnershipReason);
  }

  const handler = options.resourceHandlers[resource.uriTemplate];
  if (!handler) {
    const reason = `No runtime handler is registered for MCP resource '${resource.uriTemplate}'.`;
    await audit(options.audit, {
      outcome: "denied",
      method: "resources/read",
      resourceUri: params.uri,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
      reason,
    });

    return jsonRpcError(null, -32004, reason, {
      resource: toResourceListItem(resource),
    });
  }

  try {
    const result = await handler({
      actor,
      resource,
      uri: params.uri,
      request,
    });
    await audit(options.audit, {
      outcome: "allowed",
      method: "resources/read",
      resourceUri: params.uri,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
    });

    return jsonRpcResult(null, {
      contents: [
        {
          uri: params.uri,
          mimeType: "application/json",
          text: JSON.stringify(result),
        },
      ],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await audit(options.audit, {
      outcome: "failed",
      method: "resources/read",
      resourceUri: params.uri,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
      reason,
    });

    return jsonRpcError(null, -32000, reason);
  }
}

export function createMcpRoutes(options: CreateMcpRoutesOptions = {}) {
  const app = new Hono<McpRuntimeEnv>();
  const services = options.services ?? mcpServiceCatalog;
  const toolHandlers = options.toolHandlers ?? {};
  const resourceHandlers = options.resourceHandlers ?? {};
  const idempotencyStore = resolveMcpIdempotencyStore(options);

  app.get("/services", (c) => {
    const actorError = requireMcpDiscoveryActor(c.get("actor"));
    if (actorError) {
      return c.json(actorError, 401);
    }

    return c.json({
      services,
    });
  });

  app.get("/tools", (c) => {
    const actorError = requireMcpDiscoveryActor(c.get("actor"));
    if (actorError) {
      return c.json(actorError, 401);
    }

    return c.json({
      tools: flattenAvailableMcpTools(services).map(toToolListItem),
    });
  });

  app.get("/resources", (c) => {
    const actorError = requireMcpDiscoveryActor(c.get("actor"));
    if (actorError) {
      return c.json(actorError, 401);
    }

    return c.json({
      resources: flattenAvailableMcpResources(services).map(toResourceListItem),
    });
  });

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | readonly unknown[] | null;
    if (Array.isArray(body)) {
      return c.json(jsonRpcError(null, -32600, "JSON-RPC batch requests are not supported."), 400);
    }
    if (!body || typeof body !== "object") {
      return c.json(jsonRpcError(null, -32700, "Invalid JSON-RPC request."), 400);
    }

    const request = body as JsonRpcRequest;
    const actor = c.get("actor") ?? null;

    switch (request.method) {
      case "initialize": {
        const actorError = requireMcpDiscoveryActor(actor);
        if (actorError) {
          return c.json({ ...actorError, id: request.id ?? null }, 401);
        }

        return c.json(
          jsonRpcResult(request.id, {
            protocolVersion: negotiateMcpProtocolVersion(request.params),
            serverInfo: {
              name: "chase-sets-platform",
              version: "0.1.0",
            },
            capabilities: {
              tools: {},
              resources: {},
            },
          }),
        );
      }
      case "tools/list": {
        const actorError = requireMcpDiscoveryActor(actor);
        if (actorError) {
          return c.json({ ...actorError, id: request.id ?? null }, 401);
        }

        return c.json(
          jsonRpcResult(request.id, {
            tools: flattenAvailableMcpTools(services).map(toToolListItem),
          }),
        );
      }
      case "resources/list": {
        const actorError = requireMcpDiscoveryActor(actor);
        if (actorError) {
          return c.json({ ...actorError, id: request.id ?? null }, 401);
        }

        return c.json(
          jsonRpcResult(request.id, {
            resources: flattenAvailableMcpResources(services).map(toResourceListItem),
          }),
        );
      }
      case "tools/call": {
        const result = await callTool(c.req.raw, actor, (request.params ?? {}) as McpToolCallParams, {
          services,
          toolHandlers,
          audit: options.audit,
          idempotencyStore,
          toolCallLimiter: options.toolCallLimiter,
        });
        return c.json({ ...result, id: request.id ?? null });
      }
      case "resources/read": {
        const result = await readResource(c.req.raw, actor, (request.params ?? {}) as McpResourceReadParams, {
          services,
          resourceHandlers,
          audit: options.audit,
        });
        return c.json({ ...result, id: request.id ?? null });
      }
      default:
        return c.json(jsonRpcError(request.id, -32601, `Unsupported MCP method '${request.method}'.`));
    }
  });

  return app;
}
