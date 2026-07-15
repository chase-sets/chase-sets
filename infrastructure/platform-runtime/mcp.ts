import { createHash } from "node:crypto";
import { Hono } from "hono";
import { AGENT_OAUTH_SUPPORTED_SCOPES, type AgentOAuthScope } from "@chase-sets/auth-context";
import type { BcApiModule, BcMcpCapabilities, BcMcpHandlers } from "@chase-sets/bounded-context-module";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { TypedUlid } from "@chase-sets/primitives/typed-ids";
import {
  authorizeMcpToolInvocation,
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  findMcpTool,
  flattenMcpResources,
  flattenMcpTools,
  getMcpCapabilityAvailability,
  getMcpToolConfirmationExpectedValue,
  isAvailableMcpCapability,
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
import {
  MCP_CLIENT_CAPABILITIES_HEADER,
  MCP_CLIENT_NAME_HEADER,
  MCP_CLIENT_VERSION_HEADER,
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_META_CLIENT_INFO_KEY,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_STATELESS_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  isStatelessMcpProtocolVersion,
  isSupportedMcpProtocolVersion,
  negotiateMcpProtocolVersion,
} from "./mcp-protocol";
import {
  createMemoryPlatformIdempotencyStore,
  type PlatformIdempotencyRecord,
  type PlatformIdempotencyStore,
} from "./idempotency";
import { agentGrantIdFromActor, type AgentGrantRateLimiter } from "./agent-guardrails";
import { resolveClientAddress, resolvePublicRequestOrigin } from "./http";
import { createMcpHttpOriginPolicyMiddleware, type McpHttpOriginPolicyOptions } from "./mcp-http";

export type McpRuntimeEnv = {
  Variables: {
    actor: ResolvedActor | null;
  };
};

export type McpClientInfo = Readonly<{
  name: string;
  version: string;
  [key: string]: unknown;
}>;

export type McpClientCapabilities = Readonly<Record<string, unknown>>;

export type McpRequestProtocolContext = Readonly<{
  protocolVersion: string;
  stateless: boolean;
  clientInfo: McpClientInfo | null;
  clientCapabilities: McpClientCapabilities | null;
}>;

export type McpToolHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  tool: McpToolDescriptor;
  arguments: Readonly<Record<string, unknown>>;
  request: Request;
  protocol: McpRequestProtocolContext;
}>;

export type McpResourceHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  resource: McpResourceDescriptor;
  uri: string;
  request: Request;
  protocol: McpRequestProtocolContext;
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
  agentGrantId?: string | null;
  agentGrantScopes?: readonly string[];
}>;

export type McpAuditSink = (record: McpAuditRecord) => Promise<void> | void;

export type McpIdempotencyRecord = PlatformIdempotencyRecord<unknown>;

export type McpIdempotencyStore = PlatformIdempotencyStore<unknown>;

export type McpExtensionCapabilities = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export type CreateMcpRoutesOptions = Readonly<{
  services?: readonly McpServiceDescriptor[];
  toolHandlers?: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers?: Readonly<Record<string, McpResourceHandler>>;
  extensionCapabilities?: McpExtensionCapabilities;
  originPolicy?: McpHttpOriginPolicyOptions;
  audit?: McpAuditSink;
  idempotencyStore?: McpIdempotencyStore;
  toolCallLimiter?: McpToolCallLimiter;
  agentGrantRateLimiter?: AgentGrantRateLimiter;
  allowInMemoryIdempotencyStoreForTests?: boolean;
}>;

export type McpModuleRuntimeEntry = Readonly<{
  module: Pick<BcApiModule, "contextName" | "mcpCapabilities" | "buildMcpHandlers">;
  services: unknown;
}>;

export type McpModuleRegistration = Readonly<{
  contextName: string;
  capabilities: BcMcpCapabilities;
  handlers: BcMcpHandlers<McpToolHandler, McpResourceHandler>;
}>;

export type McpModuleHandlerComposition = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
  registrations: readonly McpModuleRegistration[];
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
export const MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED = AGENT_OAUTH_SUPPORTED_SCOPES;
export const MCP_OAUTH_BEARER_METHODS_SUPPORTED = ["header"] as const;

export type McpOAuthProtectedResourceMetadataRoutesOptions = Readonly<{
  scopesSupported?: readonly string[];
}>;

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

export function readMcpStringArgument(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readMcpTypedIdArgument<Prefix extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  prefix: Prefix,
): TypedUlid<Prefix> {
  return parseTypedIdBoundary(readMcpStringArgument(args, key), prefix, key);
}

export function readOptionalMcpTypedIdArgument<Prefix extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  prefix: Prefix,
): TypedUlid<Prefix> | null {
  const value = readMcpStringArgument(args, key);
  if (value === null) {
    return null;
  }

  return readMcpTypedIdArgument(args, key, prefix);
}

export function ensureMcpActorAccount(
  actor: ResolvedActor | null,
  accountId: string | null,
  options: Readonly<{ accountIdArgumentName?: string }> = {},
): ResolvedActor {
  const accountIdArgumentName = options.accountIdArgumentName ?? "accountId";

  if (!actor?.accountId) {
    throw new Error("An account-scoped actor is required.");
  }

  if (!accountId) {
    throw new Error(`${accountIdArgumentName} is required.`);
  }

  const parsedAccountId = parseTypedIdBoundary(accountId, "acc", accountIdArgumentName);

  if (actor.accountId !== parsedAccountId) {
    throw new Error(`${accountIdArgumentName} must match the authenticated actor account.`);
  }

  return actor;
}

function toMcpActor(actor: ResolvedActor | null): McpActor | null {
  if (!actor) {
    return null;
  }

  return {
    actorId: actor.userId,
    accountId: actor.accountId,
    permissions: actor.permissions,
    agentGrant: actor.agentGrant,
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

function normalizeMcpOrigin(request: Request) {
  return resolvePublicRequestOrigin(request).replace(/\/+$/, "");
}

function mcpProtectedResourceMetadata(request: Request, options: McpOAuthProtectedResourceMetadataRoutesOptions = {}) {
  const origin = normalizeMcpOrigin(request);
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [`${origin}/.well-known/oauth-authorization-server`],
    scopes_supported: options.scopesSupported ?? MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED,
    bearer_methods_supported: MCP_OAUTH_BEARER_METHODS_SUPPORTED,
  };
}

function mcpProtectedResourceMetadataUrl(request: Request) {
  return `${normalizeMcpOrigin(request)}${MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH}`;
}

function mcpProtectedResourceChallenge(request: Request, scopes: readonly string[] = []) {
  const scope = scopes.length > 0 ? `, scope="${scopes.join(" ")}"` : "";
  return `Bearer resource_metadata="${mcpProtectedResourceMetadataUrl(request)}"${scope}`;
}

export function createMcpOAuthProtectedResourceMetadataRoutes(
  options: McpOAuthProtectedResourceMetadataRoutesOptions = {},
) {
  const app = new Hono();

  app.get("/oauth-protected-resource", (c) => c.json(mcpProtectedResourceMetadata(c.req.raw, options)));

  return app;
}

function mcpToolSuccessResult(result: unknown) {
  const structuredContent = result === undefined ? null : result;
  return jsonRpcResult(null, {
    structuredContent,
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
  });
}

function mcpToolErrorResult(text: string) {
  return jsonRpcResult(null, {
    isError: true,
    content: [
      {
        type: "text",
        text,
      },
    ],
  });
}

function publicAvailableMcpServices(services: readonly McpServiceDescriptor[]): McpServiceDescriptor[] {
  return services
    .map((serviceDescriptor) => ({
      ...serviceDescriptor,
      tools: serviceDescriptor.tools.filter(
        (tool) => tool.permissionBoundary.scope === "public" && isAvailableMcpCapability(tool),
      ),
      resources: serviceDescriptor.resources.filter(
        (resource) => resource.permissionBoundary.scope === "public" && isAvailableMcpCapability(resource),
      ),
    }))
    .filter((serviceDescriptor) => serviceDescriptor.tools.length > 0 || serviceDescriptor.resources.length > 0);
}

function mcpProtectedInvocationAuthenticationRequiredResponse(id: JsonRpcRequest["id"] = null) {
  return jsonRpcError(id, -32001, "An authenticated actor is required.");
}

function requireMcpDiscoveryActor(actor: ResolvedActor | null | undefined) {
  return actor ? null : mcpProtectedInvocationAuthenticationRequiredResponse();
}

function mcpServicesVisibleToActor(
  services: readonly McpServiceDescriptor[],
  actor: ResolvedActor | null | undefined,
): readonly McpServiceDescriptor[] {
  if (!actor) {
    return publicAvailableMcpServices(services);
  }
  if (!actor.agentGrant) {
    return services;
  }

  const grantedScopes = new Set(actor.agentGrant.scopes);
  const visible = services
    .map((serviceDescriptor) => ({
      ...serviceDescriptor,
      tools: serviceDescriptor.tools.filter(
        (tool) =>
          tool.permissionBoundary.requiredPermissions.every((permission) => actor.permissions.includes(permission)) &&
          (tool.permissionBoundary.requiredScopes ?? []).every((scope) => grantedScopes.has(scope)),
      ),
      resources: serviceDescriptor.resources.filter(
        (resource) =>
          resource.permissionBoundary.requiredPermissions.every((permission) =>
            actor.permissions.includes(permission),
          ) && (resource.permissionBoundary.requiredScopes ?? []).every((scope) => grantedScopes.has(scope)),
      ),
    }))
    .filter((serviceDescriptor) => serviceDescriptor.tools.length > 0 || serviceDescriptor.resources.length > 0);

  return visible;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return true;
}

type McpRequestProtocolError = Readonly<{
  ok: false;
  status: 400;
  body: ReturnType<typeof jsonRpcError>;
}>;

type McpRequestProtocolResolution =
  | Readonly<{
      ok: true;
      protocol: McpRequestProtocolContext;
    }>
  | McpRequestProtocolError;

function mcpHeaderValue(request: Request, name: string) {
  const value = request.headers.get(name);
  return value === null || value.trim().length === 0 ? null : value.trim();
}

function isValidMcpHeaderValue(value: string) {
  return !/[\0\r\n]/.test(value);
}

function paramsRecord(params: unknown): Readonly<Record<string, unknown>> {
  return isRecord(params) ? params : {};
}

function mcpMetaFromParams(params: unknown) {
  const paramsObject = paramsRecord(params);
  return isRecord(paramsObject._meta) ? paramsObject._meta : {};
}

function mcpMetaProtocolVersion(meta: Readonly<Record<string, unknown>>) {
  const protocolVersion = meta[MCP_META_PROTOCOL_VERSION_KEY];
  return typeof protocolVersion === "string" && protocolVersion.trim().length > 0 ? protocolVersion.trim() : null;
}

function mcpRequestProtocolError(
  id: JsonRpcRequest["id"],
  status: 400,
  code: number,
  message: string,
  data?: unknown,
): McpRequestProtocolError {
  return {
    ok: false,
    status,
    body: jsonRpcError(id, code, message, data),
  };
}

function unsupportedMcpProtocolResponse(id: JsonRpcRequest["id"], requestedVersion: string) {
  return mcpRequestProtocolError(id, 400, -32004, `Unsupported MCP protocol version '${requestedVersion}'.`, {
    requestedVersion,
    supportedVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
  });
}

function mcpHeaderMismatchResponse(id: JsonRpcRequest["id"], message: string) {
  return mcpRequestProtocolError(id, 400, -32001, message);
}

function invalidMcpParamsResponse(id: JsonRpcRequest["id"], message: string) {
  return mcpRequestProtocolError(id, 400, -32602, message);
}

function readMcpClientInfoFromMeta(meta: Readonly<Record<string, unknown>>): McpClientInfo | null {
  const clientInfo = meta[MCP_META_CLIENT_INFO_KEY];
  if (!isRecord(clientInfo)) {
    return null;
  }

  const name = clientInfo.name;
  const version = clientInfo.version;
  return typeof name === "string" && name.trim().length > 0 && typeof version === "string" && version.trim().length > 0
    ? {
        ...clientInfo,
        name: name.trim(),
        version: version.trim(),
      }
    : null;
}

function readMcpClientInfoFromHeaders(request: Request): McpClientInfo | null {
  const name = mcpHeaderValue(request, MCP_CLIENT_NAME_HEADER);
  const version = mcpHeaderValue(request, MCP_CLIENT_VERSION_HEADER);
  return name && version ? { name, version } : null;
}

function readMcpClientCapabilitiesFromHeaders(request: Request): McpClientCapabilities | null {
  const value = mcpHeaderValue(request, MCP_CLIENT_CAPABILITIES_HEADER);
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readMcpClientCapabilities(
  request: Request,
  meta: Readonly<Record<string, unknown>>,
): McpClientCapabilities | null {
  const capabilities = meta[MCP_META_CLIENT_CAPABILITIES_KEY];
  if (isRecord(capabilities)) {
    return capabilities;
  }

  return readMcpClientCapabilitiesFromHeaders(request);
}

function resolveMcpRequestProtocol(request: Request, rpcRequest: JsonRpcRequest): McpRequestProtocolResolution {
  const protocolHeader = mcpHeaderValue(request, MCP_PROTOCOL_VERSION_HEADER);
  const meta = mcpMetaFromParams(rpcRequest.params);
  const metaProtocolVersion = mcpMetaProtocolVersion(meta);
  let protocolVersion = MCP_PROTOCOL_VERSION;

  if (protocolHeader) {
    if (!isValidMcpHeaderValue(protocolHeader)) {
      return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_PROTOCOL_VERSION_HEADER} contains an invalid value.`);
    }
    if (!isSupportedMcpProtocolVersion(protocolHeader)) {
      return unsupportedMcpProtocolResponse(rpcRequest.id, protocolHeader);
    }
    protocolVersion = protocolHeader;
    if (metaProtocolVersion && metaProtocolVersion !== protocolHeader) {
      return mcpHeaderMismatchResponse(
        rpcRequest.id,
        `${MCP_PROTOCOL_VERSION_HEADER} must match params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`,
      );
    }
  } else if (metaProtocolVersion) {
    if (!isSupportedMcpProtocolVersion(metaProtocolVersion)) {
      return unsupportedMcpProtocolResponse(rpcRequest.id, metaProtocolVersion);
    }
    if (isStatelessMcpProtocolVersion(metaProtocolVersion)) {
      return mcpHeaderMismatchResponse(
        rpcRequest.id,
        `${MCP_PROTOCOL_VERSION_HEADER} is required for MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION}.`,
      );
    }
    protocolVersion = metaProtocolVersion;
  }

  const stateless = isStatelessMcpProtocolVersion(protocolVersion);
  if (!stateless) {
    return {
      ok: true,
      protocol: {
        protocolVersion,
        stateless: false,
        clientInfo: readMcpClientInfoFromMeta(meta) ?? readMcpClientInfoFromHeaders(request),
        clientCapabilities: readMcpClientCapabilities(request, meta),
      },
    };
  }

  if (metaProtocolVersion !== MCP_STATELESS_PROTOCOL_VERSION) {
    return invalidMcpParamsResponse(
      rpcRequest.id,
      `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`,
    );
  }

  const clientInfo = readMcpClientInfoFromMeta(meta) ?? readMcpClientInfoFromHeaders(request);
  if (!clientInfo) {
    return invalidMcpParamsResponse(
      rpcRequest.id,
      `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires client info in params._meta.${MCP_META_CLIENT_INFO_KEY} or ${MCP_CLIENT_NAME_HEADER}/${MCP_CLIENT_VERSION_HEADER}.`,
    );
  }

  const clientCapabilities = readMcpClientCapabilities(request, meta);
  if (!clientCapabilities) {
    return invalidMcpParamsResponse(
      rpcRequest.id,
      `MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION} requires client capabilities in params._meta.${MCP_META_CLIENT_CAPABILITIES_KEY} or ${MCP_CLIENT_CAPABILITIES_HEADER}.`,
    );
  }

  return {
    ok: true,
    protocol: {
      protocolVersion,
      stateless,
      clientInfo,
      clientCapabilities,
    },
  };
}

function expectedMcpNameHeaderValue(request: JsonRpcRequest) {
  const params = paramsRecord(request.params);
  switch (request.method) {
    case "tools/call":
    case "prompts/get":
      return typeof params.name === "string" ? params.name : null;
    case "resources/read":
      return typeof params.uri === "string" ? params.uri : null;
    default:
      return null;
  }
}

function validateMcpRoutingHeaders(
  request: Request,
  rpcRequest: JsonRpcRequest,
  protocol: McpRequestProtocolContext,
): McpRequestProtocolError | null {
  const methodHeader = mcpHeaderValue(request, MCP_METHOD_HEADER);
  const nameHeader = mcpHeaderValue(request, MCP_NAME_HEADER);
  const shouldValidate = protocol.stateless || methodHeader !== null || nameHeader !== null;
  if (!shouldValidate) {
    return null;
  }

  if (!methodHeader) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_METHOD_HEADER} is required for this MCP request.`);
  }
  if (!isValidMcpHeaderValue(methodHeader)) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_METHOD_HEADER} contains an invalid value.`);
  }
  if (methodHeader !== rpcRequest.method) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_METHOD_HEADER} must match the JSON-RPC method.`);
  }

  const expectedName = expectedMcpNameHeaderValue(rpcRequest);
  if (!expectedName) {
    return null;
  }

  if (!nameHeader) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_NAME_HEADER} is required for ${rpcRequest.method}.`);
  }
  if (!isValidMcpHeaderValue(nameHeader)) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_NAME_HEADER} contains an invalid value.`);
  }
  if (nameHeader !== expectedName) {
    return mcpHeaderMismatchResponse(rpcRequest.id, `${MCP_NAME_HEADER} must match the MCP request target.`);
  }

  return null;
}

function normalizeArguments(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function protectedToolRequiresAuthentication(
  actor: ResolvedActor | null,
  params: McpToolCallParams,
  services: readonly McpServiceDescriptor[],
) {
  if (actor || typeof params.name !== "string") {
    return false;
  }

  const tool = findMcpTool(params.name, services);
  return Boolean(tool && tool.permissionBoundary.scope !== "public");
}

function protectedResourceRequiresAuthentication(
  actor: ResolvedActor | null,
  params: McpResourceReadParams,
  services: readonly McpServiceDescriptor[],
) {
  if (actor || typeof params.uri !== "string") {
    return false;
  }

  const resourceMatch =
    flattenMcpResources(services)
      .map((candidate) => matchResourceUri(candidate, params.uri as string))
      .find((candidate) => candidate !== null) ?? null;
  return Boolean(resourceMatch && resourceMatch.resource.permissionBoundary.scope !== "public");
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

function formatToolArgumentValidationDiagnostic(reason: string, issues: readonly McpInputValidationIssue[]) {
  if (issues.length === 0) {
    return reason;
  }

  const details = issues
    .map((issue) => {
      const expected = issue.expected ? ` Expected ${issue.expected}.` : "";
      const actual = issue.actual ? ` Actual ${issue.actual}.` : "";
      return `${issue.path}: ${issue.message}${expected}${actual}`;
    })
    .join(" ");
  return `${reason} ${details}`;
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
  const readOnlyHint = tool.risk === "read";

  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: {
      readOnlyHint,
      destructiveHint: tool.risk === "destructive",
      ...(!readOnlyHint && tool.guardrails.idempotencyKey === "required" ? { idempotentHint: true } : {}),
      serviceId: tool.serviceId,
      availability: getMcpCapabilityAvailability(tool),
      risk: tool.risk,
      requiredPermissions: tool.permissionBoundary.requiredPermissions,
      requiredScopes: tool.permissionBoundary.requiredScopes ?? [],
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
      requiredScopes: resource.permissionBoundary.requiredScopes ?? [],
      accountScoped: resource.permissionBoundary.accountScoped,
      expectedUsage: resource.expectedUsage,
    },
  };
}

function mcpServerInfo() {
  return {
    name: "chase-sets-platform",
    version: "0.1.0",
  };
}

function mcpServerCapabilities(extensionCapabilities: McpExtensionCapabilities) {
  return {
    tools: {},
    resources: {},
    extensions: extensionCapabilities,
  };
}

function mcpServerDiscovery(extensionCapabilities: McpExtensionCapabilities) {
  return {
    protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    serverInfo: mcpServerInfo(),
    capabilities: mcpServerCapabilities(extensionCapabilities),
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

function mcpAuditActor(actor: ResolvedActor | null) {
  return {
    actorId: actor?.userId ?? null,
    accountId: actor?.accountId ?? null,
    agentGrantId: actor?.agentGrant?.grantId ?? agentGrantIdFromActor(actor),
    agentGrantScopes: actor?.agentGrant?.scopes,
  };
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
      grantId: agentGrantIdFromActor(actor),
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

function normalizeMcpCapabilities(capabilities: BcMcpCapabilities | undefined): Required<BcMcpCapabilities> {
  return {
    tools: capabilities?.tools ?? [],
    resources: capabilities?.resources ?? [],
  };
}

function duplicateMessage(kind: "tool" | "resource" | "tool handler" | "resource handler", key: string) {
  return `Duplicate MCP ${kind} '${key}'.`;
}

export function validateMcpModuleRegistrations(
  registrations: readonly McpModuleRegistration[],
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): readonly string[] {
  const errors: string[] = [];
  const toolDescriptors = new Map(flattenMcpTools(services).map((tool) => [tool.name, tool]));
  const resourceDescriptors = new Map(
    flattenMcpResources(services).map((resource) => [resource.uriTemplate, resource]),
  );
  const contextNames = new Set(registrations.map((registration) => registration.contextName));
  const declaredTools = new Map<string, string>();
  const declaredResources = new Map<string, string>();
  const toolHandlers = new Map<string, string>();
  const resourceHandlers = new Map<string, string>();

  for (const registration of registrations) {
    const capabilities = normalizeMcpCapabilities(registration.capabilities);
    const moduleToolNames = new Set(capabilities.tools.map((tool) => tool.name));
    const moduleResourceTemplates = new Set(capabilities.resources.map((resource) => resource.uriTemplate));

    for (const tool of capabilities.tools) {
      if (declaredTools.has(tool.name)) {
        errors.push(duplicateMessage("tool", tool.name));
      }
      declaredTools.set(tool.name, registration.contextName);

      const descriptor = toolDescriptors.get(tool.name);
      if (!descriptor) {
        errors.push(`Context '${registration.contextName}' declares unknown MCP tool '${tool.name}'.`);
      } else if (descriptor.serviceId !== registration.contextName) {
        errors.push(
          `Context '${registration.contextName}' declares MCP tool '${tool.name}' owned by context '${descriptor.serviceId}'.`,
        );
      }
    }

    for (const resource of capabilities.resources) {
      if (declaredResources.has(resource.uriTemplate)) {
        errors.push(duplicateMessage("resource", resource.uriTemplate));
      }
      declaredResources.set(resource.uriTemplate, registration.contextName);

      const descriptor = resourceDescriptors.get(resource.uriTemplate);
      if (!descriptor) {
        errors.push(`Context '${registration.contextName}' declares unknown MCP resource '${resource.uriTemplate}'.`);
      } else if (descriptor.serviceId !== registration.contextName) {
        errors.push(
          `Context '${registration.contextName}' declares MCP resource '${resource.uriTemplate}' owned by context '${descriptor.serviceId}'.`,
        );
      }
    }

    for (const handlerName of Object.keys(registration.handlers.toolHandlers ?? {})) {
      if (toolHandlers.has(handlerName)) {
        errors.push(duplicateMessage("tool handler", handlerName));
      }
      toolHandlers.set(handlerName, registration.contextName);

      if (!moduleToolNames.has(handlerName)) {
        errors.push(
          `Context '${registration.contextName}' registers MCP tool handler '${handlerName}' without declaring it in mcpCapabilities.tools.`,
        );
      }
    }

    for (const handlerName of Object.keys(registration.handlers.resourceHandlers ?? {})) {
      if (resourceHandlers.has(handlerName)) {
        errors.push(duplicateMessage("resource handler", handlerName));
      }
      resourceHandlers.set(handlerName, registration.contextName);

      if (!moduleResourceTemplates.has(handlerName)) {
        errors.push(
          `Context '${registration.contextName}' registers MCP resource handler '${handlerName}' without declaring it in mcpCapabilities.resources.`,
        );
      }
    }
  }

  for (const tool of flattenAvailableMcpTools(services).filter((candidate) => contextNames.has(candidate.serviceId))) {
    if (!declaredTools.has(tool.name)) {
      errors.push(
        `Available MCP tool '${tool.name}' is owned by mounted context '${tool.serviceId}' but no module declares it.`,
      );
      continue;
    }

    if (declaredTools.get(tool.name) !== tool.serviceId) {
      errors.push(
        `Available MCP tool '${tool.name}' is owned by mounted context '${tool.serviceId}' but declared by context '${declaredTools.get(
          tool.name,
        )}'.`,
      );
      continue;
    }

    if (!toolHandlers.has(tool.name)) {
      errors.push(`Available MCP tool '${tool.name}' is declared but no handler is registered.`);
    }
  }

  for (const resource of flattenAvailableMcpResources(services).filter((candidate) =>
    contextNames.has(candidate.serviceId),
  )) {
    if (!declaredResources.has(resource.uriTemplate)) {
      errors.push(
        `Available MCP resource '${resource.uriTemplate}' is owned by mounted context '${resource.serviceId}' but no module declares it.`,
      );
      continue;
    }

    if (declaredResources.get(resource.uriTemplate) !== resource.serviceId) {
      errors.push(
        `Available MCP resource '${resource.uriTemplate}' is owned by mounted context '${resource.serviceId}' but declared by context '${declaredResources.get(
          resource.uriTemplate,
        )}'.`,
      );
      continue;
    }

    if (!resourceHandlers.has(resource.uriTemplate)) {
      errors.push(`Available MCP resource '${resource.uriTemplate}' is declared but no handler is registered.`);
    }
  }

  for (const [handlerName, contextName] of toolHandlers) {
    const descriptor = toolDescriptors.get(handlerName);
    if (descriptor && !isAvailableMcpCapability(descriptor)) {
      errors.push(`Context '${contextName}' registers handler '${handlerName}' for a planned MCP tool.`);
    }
  }

  for (const [handlerName, contextName] of resourceHandlers) {
    const descriptor = resourceDescriptors.get(handlerName);
    if (descriptor && !isAvailableMcpCapability(descriptor)) {
      errors.push(`Context '${contextName}' registers handler '${handlerName}' for a planned MCP resource.`);
    }
  }

  return errors;
}

export function buildMcpHandlersFromModules(
  modules: readonly McpModuleRuntimeEntry[],
  services: readonly McpServiceDescriptor[] = mcpServiceCatalog,
): McpModuleHandlerComposition {
  const registrations = modules.flatMap((entry): readonly McpModuleRegistration[] => {
    if (!entry.module.mcpCapabilities && !entry.module.buildMcpHandlers) {
      return [];
    }

    return [
      {
        contextName: entry.module.contextName,
        capabilities: entry.module.mcpCapabilities ?? {},
        handlers: (entry.module.buildMcpHandlers?.(entry.services as never) ?? {}) as BcMcpHandlers<
          McpToolHandler,
          McpResourceHandler
        >,
      },
    ];
  });
  const errors = validateMcpModuleRegistrations(registrations, services);
  if (errors.length > 0) {
    throw new Error(`Invalid MCP module registration:\n- ${errors.join("\n- ")}`);
  }

  const toolHandlers = Object.fromEntries(
    registrations.flatMap((registration) => Object.entries(registration.handlers.toolHandlers ?? {})),
  );
  const resourceHandlers = Object.fromEntries(
    registrations.flatMap((registration) => Object.entries(registration.handlers.resourceHandlers ?? {})),
  );

  return {
    toolHandlers,
    resourceHandlers,
    registrations,
  };
}

async function callTool(
  request: Request,
  actor: ResolvedActor | null,
  protocol: McpRequestProtocolContext,
  params: McpToolCallParams,
  options: Required<Pick<CreateMcpRoutesOptions, "services" | "toolHandlers" | "idempotencyStore">> &
    Pick<CreateMcpRoutesOptions, "audit" | "toolCallLimiter" | "agentGrantRateLimiter"> &
    Readonly<{ onScopeChallenge?: (scopes: readonly AgentOAuthScope[]) => void }>,
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
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return mcpToolErrorResult(formatToolArgumentValidationDiagnostic(reason, validationIssues));
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
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: authorization.reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });
    if (authorization.missingScopes && authorization.missingScopes.length > 0) {
      options.onScopeChallenge?.(authorization.missingScopes);
      return jsonRpcError(null, -32001, authorization.reason, { missingScopes: authorization.missingScopes });
    }

    return mcpToolErrorResult(authorization.reason);
  }

  const accountOwnershipReason = validateToolAccountOwnership(tool, actor, args);
  if (accountOwnershipReason) {
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: accountOwnershipReason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return mcpToolErrorResult(accountOwnershipReason);
  }

  if (!hasRequiredIdempotencyKey(tool, args)) {
    const reason = "An idempotency key is required for this MCP tool.";
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return mcpToolErrorResult(reason);
  }

  const agentGrantRateLimit =
    tool.guardrails.idempotencyKey === "required"
      ? enforceMcpAgentGrantRateLimit(options.agentGrantRateLimiter, tool.name, actor)
      : null;
  if (agentGrantRateLimit) {
    await audit(options.audit, {
      outcome: "denied",
      method: "tools/call",
      toolName: tool.name,
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: agentGrantRateLimit,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
      limitKind: "write",
    });

    return mcpToolErrorResult(agentGrantRateLimit);
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
          ...mcpAuditActor(actor),
          auditEventName: tool.audit.eventName,
          targetType: tool.audit.targetType,
          reason: "idempotency-replay",
          sensitiveInputFields: tool.audit.sensitiveInputFields,
        });

        return reservation.record.response as ReturnType<typeof jsonRpcResult>;
      }
    }

    if (reservation.outcome === "pending") {
      return mcpToolErrorResult("A matching MCP tool call is already in progress. Retry later.");
    }

    if (reservation.outcome === "conflict") {
      const reason = "Idempotency key was already used with different MCP tool arguments.";
      await audit(options.audit, {
        outcome: "denied",
        method: "tools/call",
        toolName: tool.name,
        ...mcpAuditActor(actor),
        auditEventName: tool.audit.eventName,
        targetType: tool.audit.targetType,
        reason,
        sensitiveInputFields: tool.audit.sensitiveInputFields,
      });

      return mcpToolErrorResult(reason);
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
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return mcpToolErrorResult(
      `${reason} Redacted arguments: ${JSON.stringify(redactArguments(args, tool.audit.sensitiveInputFields))}`,
    );
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
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason: limit.reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
      limitKind: limit.limitKind,
    });

    return mcpToolErrorResult(limit.reason);
  }

  try {
    const result = await handler({
      actor,
      tool,
      arguments: args,
      request,
      protocol,
    });
    const response = mcpToolSuccessResult(result);
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
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const response = mcpToolErrorResult(reason);
    if (reservedIdempotency) {
      await options.idempotencyStore.complete({
        ...reservedIdempotency,
        response,
      });
    } else if (idempotency) {
      await options.idempotencyStore.abandon(idempotency);
    }
    await audit(options.audit, {
      outcome: "failed",
      method: "tools/call",
      toolName: tool.name,
      ...mcpAuditActor(actor),
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      reason,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return response;
  } finally {
    await Promise.resolve(limit.lease?.release()).catch(() => undefined);
  }
}

function enforceMcpAgentGrantRateLimit(
  limiter: AgentGrantRateLimiter | undefined,
  operation: string,
  actor: ResolvedActor | null,
) {
  const grantId = agentGrantIdFromActor(actor);
  if (!limiter || !grantId) {
    return null;
  }

  const decision = limiter.check({
    grantId,
    accountId: actor?.accountId ?? null,
    actorId: actor?.userId ?? null,
    operation,
  });
  return decision.allowed ? null : decision.reason;
}

async function readResource(
  request: Request,
  actor: ResolvedActor | null,
  protocol: McpRequestProtocolContext,
  params: McpResourceReadParams,
  options: Required<Pick<CreateMcpRoutesOptions, "services" | "resourceHandlers">> &
    Pick<CreateMcpRoutesOptions, "audit"> &
    Readonly<{ onScopeChallenge?: (scopes: readonly AgentOAuthScope[]) => void }>,
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
      ...mcpAuditActor(actor),
      auditEventName: pseudoTool.audit.eventName,
      targetType: pseudoTool.audit.targetType,
      reason: authorization.reason,
    });
    if (authorization.missingScopes && authorization.missingScopes.length > 0) {
      options.onScopeChallenge?.(authorization.missingScopes);
      return jsonRpcError(null, -32001, authorization.reason, { missingScopes: authorization.missingScopes });
    }

    return jsonRpcError(null, -32001, authorization.reason);
  }

  const accountOwnershipReason = validateResourceAccountOwnership(resource, actor, variables);
  if (accountOwnershipReason) {
    await audit(options.audit, {
      outcome: "denied",
      method: "resources/read",
      resourceUri: params.uri,
      ...mcpAuditActor(actor),
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
      ...mcpAuditActor(actor),
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
      protocol,
    });
    await audit(options.audit, {
      outcome: "allowed",
      method: "resources/read",
      resourceUri: params.uri,
      ...mcpAuditActor(actor),
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
      ...mcpAuditActor(actor),
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
  const extensionCapabilities = options.extensionCapabilities ?? {};
  const idempotencyStore = resolveMcpIdempotencyStore(options);

  app.use("*", createMcpHttpOriginPolicyMiddleware(options.originPolicy));

  app.get("/services", (c) => {
    const visibleServices = mcpServicesVisibleToActor(services, c.get("actor"));

    return c.json({
      services: visibleServices,
    });
  });

  app.get("/tools", (c) => {
    const visibleServices = mcpServicesVisibleToActor(services, c.get("actor"));

    return c.json({
      tools: flattenAvailableMcpTools(visibleServices).map(toToolListItem),
    });
  });

  app.get("/resources", (c) => {
    const visibleServices = mcpServicesVisibleToActor(services, c.get("actor"));

    return c.json({
      resources: flattenAvailableMcpResources(visibleServices).map(toResourceListItem),
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
    const protocolResolution = resolveMcpRequestProtocol(c.req.raw, request);
    if (!protocolResolution.ok) {
      return c.json(protocolResolution.body, protocolResolution.status);
    }

    const routingHeaderError = validateMcpRoutingHeaders(c.req.raw, request, protocolResolution.protocol);
    if (routingHeaderError) {
      return c.json(routingHeaderError.body, routingHeaderError.status);
    }

    const protocol = protocolResolution.protocol;

    switch (request.method) {
      case "server/discover": {
        return c.json(jsonRpcResult(request.id, mcpServerDiscovery(extensionCapabilities)));
      }
      case "initialize": {
        if (protocol.stateless || paramsRecord(request.params).protocolVersion === MCP_STATELESS_PROTOCOL_VERSION) {
          return c.json(
            jsonRpcError(
              request.id,
              -32601,
              `initialize is not supported for MCP protocol version ${MCP_STATELESS_PROTOCOL_VERSION}. Use server/discover and per-request metadata.`,
            ),
          );
        }

        const negotiatedProtocolVersion =
          mcpHeaderValue(c.req.raw, MCP_PROTOCOL_VERSION_HEADER) &&
          protocol.protocolVersion !== MCP_STATELESS_PROTOCOL_VERSION
            ? protocol.protocolVersion
            : negotiateMcpProtocolVersion(request.params);

        return c.json(
          jsonRpcResult(request.id, {
            protocolVersion: negotiatedProtocolVersion,
            serverInfo: mcpServerInfo(),
            capabilities: mcpServerCapabilities(extensionCapabilities),
          }),
        );
      }
      case "tools/list": {
        const visibleServices = mcpServicesVisibleToActor(services, actor);

        return c.json(
          jsonRpcResult(request.id, {
            tools: flattenAvailableMcpTools(visibleServices).map(toToolListItem),
          }),
        );
      }
      case "resources/list": {
        const visibleServices = mcpServicesVisibleToActor(services, actor);

        return c.json(
          jsonRpcResult(request.id, {
            resources: flattenAvailableMcpResources(visibleServices).map(toResourceListItem),
          }),
        );
      }
      case "tools/call": {
        const params = (request.params ?? {}) as McpToolCallParams;
        if (protectedToolRequiresAuthentication(actor, params, services)) {
          c.header("WWW-Authenticate", mcpProtectedResourceChallenge(c.req.raw));
          return c.json(mcpProtectedInvocationAuthenticationRequiredResponse(request.id), 401);
        }

        let scopeChallenge: readonly AgentOAuthScope[] = [];
        const result = await callTool(c.req.raw, actor, protocol, params, {
          services,
          toolHandlers,
          audit: options.audit,
          idempotencyStore,
          toolCallLimiter: options.toolCallLimiter,
          agentGrantRateLimiter: options.agentGrantRateLimiter,
          onScopeChallenge: (scopes) => {
            scopeChallenge = scopes;
          },
        });
        if (scopeChallenge.length > 0) {
          c.header("WWW-Authenticate", mcpProtectedResourceChallenge(c.req.raw, scopeChallenge));
          return c.json({ ...result, id: request.id ?? null }, 401);
        }
        return c.json({ ...result, id: request.id ?? null });
      }
      case "resources/read": {
        const params = (request.params ?? {}) as McpResourceReadParams;
        if (protectedResourceRequiresAuthentication(actor, params, services)) {
          c.header("WWW-Authenticate", mcpProtectedResourceChallenge(c.req.raw));
          return c.json(mcpProtectedInvocationAuthenticationRequiredResponse(request.id), 401);
        }

        let scopeChallenge: readonly AgentOAuthScope[] = [];
        const result = await readResource(c.req.raw, actor, protocol, params, {
          services,
          resourceHandlers,
          audit: options.audit,
          onScopeChallenge: (scopes) => {
            scopeChallenge = scopes;
          },
        });
        if (scopeChallenge.length > 0) {
          c.header("WWW-Authenticate", mcpProtectedResourceChallenge(c.req.raw, scopeChallenge));
          return c.json({ ...result, id: request.id ?? null }, 401);
        }
        return c.json({ ...result, id: request.id ?? null });
      }
      default:
        return c.json(jsonRpcError(request.id, -32601, `Unsupported MCP method '${request.method}'.`));
    }
  });

  return app;
}
