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
  type McpActor,
  type McpResourceDescriptor,
  type McpServiceDescriptor,
  type McpToolDescriptor,
} from "./mcp-contracts";
import type { ResolvedActor } from "./auth";

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
}>;

export type McpAuditSink = (record: McpAuditRecord) => Promise<void> | void;

export type CreateMcpRoutesOptions = Readonly<{
  services?: readonly McpServiceDescriptor[];
  toolHandlers?: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers?: Readonly<Record<string, McpResourceHandler>>;
  audit?: McpAuditSink;
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

function normalizeArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Readonly<Record<string, unknown>>;
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

function isResourceMatch(resource: McpResourceDescriptor, uri: string) {
  const expression = resource.uriTemplate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+");

  return new RegExp(`^${expression}$`).test(uri);
}

async function audit(sink: McpAuditSink | undefined, record: McpAuditRecord) {
  await sink?.(record);
}

async function callTool(
  request: Request,
  actor: ResolvedActor | null,
  params: McpToolCallParams,
  options: Required<Pick<CreateMcpRoutesOptions, "services" | "toolHandlers">> & Pick<CreateMcpRoutesOptions, "audit">,
) {
  if (typeof params.name !== "string") {
    return jsonRpcError(null, -32602, "Tool name is required.");
  }

  const tool = findMcpTool(params.name, options.services);
  if (!tool) {
    return jsonRpcError(null, -32602, `Unknown MCP tool '${params.name}'.`);
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

  const handler = options.toolHandlers[tool.name];
  if (!handler) {
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

  try {
    const result = await handler({
      actor,
      tool,
      arguments: args,
      request,
    });
    await audit(options.audit, {
      outcome: "allowed",
      method: "tools/call",
      toolName: tool.name,
      actorId: actor?.userId ?? null,
      accountId: actor?.accountId ?? null,
      auditEventName: tool.audit.eventName,
      targetType: tool.audit.targetType,
      sensitiveInputFields: tool.audit.sensitiveInputFields,
    });

    return jsonRpcResult(null, {
      content: [
        {
          type: "json",
          json: result,
        },
      ],
    });
  } catch (error) {
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

  const resource = flattenMcpResources(options.services).find((candidate) =>
    isResourceMatch(candidate, params.uri as string),
  );

  if (!resource) {
    return jsonRpcError(null, -32602, `Unknown MCP resource '${params.uri}'.`);
  }

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

  app.get("/services", (c) =>
    c.json({
      services,
    }),
  );

  app.get("/tools", (c) =>
    c.json({
      tools: flattenAvailableMcpTools(services).map(toToolListItem),
    }),
  );

  app.get("/resources", (c) =>
    c.json({
      resources: flattenAvailableMcpResources(services).map(toResourceListItem),
    }),
  );

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
    if (!body || typeof body !== "object") {
      return c.json(jsonRpcError(null, -32700, "Invalid JSON-RPC request."), 400);
    }

    const actor = c.get("actor") ?? null;

    switch (body.method) {
      case "initialize":
        return c.json(
          jsonRpcResult(body.id, {
            protocolVersion: "2025-03-26",
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
      case "tools/list":
        return c.json(
          jsonRpcResult(body.id, {
            tools: flattenAvailableMcpTools(services).map(toToolListItem),
          }),
        );
      case "resources/list":
        return c.json(
          jsonRpcResult(body.id, {
            resources: flattenAvailableMcpResources(services).map(toResourceListItem),
          }),
        );
      case "tools/call": {
        const result = await callTool(c.req.raw, actor, (body.params ?? {}) as McpToolCallParams, {
          services,
          toolHandlers,
          audit: options.audit,
        });
        return c.json({ ...result, id: body.id ?? null });
      }
      case "resources/read": {
        const result = await readResource(c.req.raw, actor, (body.params ?? {}) as McpResourceReadParams, {
          services,
          resourceHandlers,
          audit: options.audit,
        });
        return c.json({ ...result, id: body.id ?? null });
      }
      default:
        return c.json(jsonRpcError(body.id, -32601, `Unsupported MCP method '${body.method}'.`), 404);
    }
  });

  return app;
}
