import { createHash, createPublicKey, verify as verifySignatureBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  buildUcpBusinessProfile,
  createUcpEnvelope,
  UCP_MCP_TOOLS,
  unsupportedUcpOperation,
  type UcpEnvelope,
} from "@chase-sets/ucp";
import type { ResolvedActor } from "./auth";

type UcpRuntimeEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

type JsonRpcRequest = Readonly<{
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}>;

type UcpToolCallParams = Readonly<{
  name?: unknown;
  arguments?: unknown;
}>;

export type UcpOperationHandlerInput = Readonly<{
  actor: ResolvedActor | null;
  context: EventStoreContext | null;
  arguments: Readonly<Record<string, unknown>>;
  request: Request;
  params: Readonly<Record<string, string>>;
}>;

export type UcpOperationHandler = (
  input: UcpOperationHandlerInput,
) => Promise<UcpEnvelope> | UcpEnvelope;

export type UcpIdempotencyRecord = Readonly<{
  key: string;
  requestHash: string;
  response: UcpEnvelope;
  createdAt: string;
}>;

export type UcpIdempotencyStore = Readonly<{
  get: (key: string) => Promise<UcpIdempotencyRecord | null> | UcpIdempotencyRecord | null;
  put: (record: UcpIdempotencyRecord) => Promise<void> | void;
}>;

export type UcpSignatureKeyResolver = (
  profileUrl: string,
  keyId: string,
) => Promise<JsonWebKey | null> | JsonWebKey | null;

export type UcpSignatureVerificationOptions = Readonly<{
  keyResolver: UcpSignatureKeyResolver;
}>;

export type CreateUcpRoutesOptions = Readonly<{
  restHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  mcpToolHandlers?: Readonly<Record<string, UcpOperationHandler>>;
  idempotencyStore?: UcpIdempotencyStore;
  signatureVerification?: UcpSignatureVerificationOptions;
}>;

const JSON_RPC_VERSION = "2.0";

const SIGNED_WRITE_HEADERS = [
  "Signature-Input",
  "Signature",
  "Content-Digest",
  "UCP-Agent",
] as const;

function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || url.host;

  const protocol =
    forwardedProto ||
    (url.protocol === "http:" && isPublicHostname(host) ? "https" : url.protocol.slice(0, -1));

  return `${protocol}://${host}`;
}

function isPublicHostname(host: string) {
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    return false;
  }

  if (/^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
    return false;
  }

  const private172Match = /^172\.(\d+)\./.exec(hostname);
  if (private172Match) {
    const secondOctet = Number.parseInt(private172Match[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return false;
    }
  }

  return hostname.includes(".");
}

function jsonRpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function normalizeArguments(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function missingSignedWriteHeaders(request: Request) {
  return SIGNED_WRITE_HEADERS.filter((header) => !request.headers.get(header));
}

async function requestBodyHash(request: Request) {
  const body = Buffer.from(await request.clone().arrayBuffer());
  return createHash("sha256").update(body).digest("base64");
}

async function verifyContentDigest(request: Request) {
  const digest = request.headers.get("Content-Digest");
  if (!digest) {
    return false;
  }

  const match = /^sha-256=:(.+):$/i.exec(digest.trim());
  if (!match) {
    return false;
  }

  return await requestBodyHash(request) === match[1];
}

async function signedWriteFailure(request: Request) {
  const missing = missingSignedWriteHeaders(request);
  if (missing.length > 0) {
    return `Missing required UCP signed request header(s): ${missing.join(", ")}.`;
  }

  if (!(await verifyContentDigest(request))) {
    return "Content-Digest did not match the request body.";
  }

  return null;
}

function ucpAgentProfileUrl(request: Request) {
  const header = request.headers.get("UCP-Agent")?.trim() ?? "";
  const match = /(?:^|[,\s])profile="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}

function parseSignatureInput(request: Request) {
  const header = request.headers.get("Signature-Input")?.trim() ?? "";
  const match = /^([A-Za-z0-9_.*-]+)=\(([^)]*)\)(.*)$/.exec(header);
  if (!match) {
    return null;
  }

  const params = match[3] ?? "";
  const keyId = /(?:^|;)keyid="([^"]+)"/.exec(params)?.[1] ?? null;
  const components = [...match[2].matchAll(/"([^"]+)"/g)].map((entry) => entry[1].toLowerCase());

  return {
    label: match[1],
    components,
    params: `(${match[2]})${params}`,
    keyId,
  };
}

function parseSignature(request: Request, label: string) {
  const header = request.headers.get("Signature")?.trim() ?? "";
  const expression = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=:([^:]+):`);
  const match = expression.exec(header);
  return match ? Buffer.from(match[1], "base64") : null;
}

function signatureComponentValue(request: Request, component: string) {
  const url = new URL(request.url);
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@path":
      return `${url.pathname}${url.search}`;
    case "@authority":
      return request.headers.get("host") ?? url.host;
    default:
      return request.headers.get(component);
  }
}

function signatureBase(request: Request, components: readonly string[], params: string) {
  const lines = components.map((component) => {
    const value = signatureComponentValue(request, component);
    if (value === null) {
      throw new Error(`Signed component '${component}' is missing.`);
    }

    return `"${component}": ${value}`;
  });

  return [...lines, `"@signature-params": ${params}`].join("\n");
}

function publicKeyAlgorithm(jwk: JsonWebKey) {
  return jwk.alg === "EdDSA" || jwk.crv === "Ed25519" ? null : "sha256";
}

async function verifyHttpMessageSignature(
  request: Request,
  options: UcpSignatureVerificationOptions | undefined,
) {
  if (!options) {
    return null;
  }

  const agentProfileUrl = ucpAgentProfileUrl(request);
  if (!agentProfileUrl) {
    return "UCP-Agent must contain a profile URL.";
  }

  const input = parseSignatureInput(request);
  if (!input?.keyId) {
    return "Signature-Input must include keyid.";
  }

  const signature = parseSignature(request, input.label);
  if (!signature) {
    return "Signature header did not include the declared signature label.";
  }

  const jwk = await options.keyResolver(agentProfileUrl, input.keyId);
  if (!jwk) {
    return "No signing key matched the UCP-Agent profile and Signature-Input keyid.";
  }

  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const base = signatureBase(request, input.components, input.params);
    const verified = verifySignatureBytes(
      publicKeyAlgorithm(jwk),
      Buffer.from(base),
      key,
      signature,
    );
    return verified ? null : "HTTP Message Signature verification failed.";
  } catch (error) {
    return error instanceof Error ? error.message : "HTTP Message Signature verification failed.";
  }
}

function idempotencyKey(request: Request) {
  return request.headers.get("Idempotency-Key")?.trim() ?? "";
}

function missingIdempotencyKey(request: Request) {
  return !idempotencyKey(request);
}

function unsupported(operation: string) {
  return unsupportedUcpOperation(operation);
}

async function invokeRestHandler(
  handlers: CreateUcpRoutesOptions["restHandlers"],
  operation: string,
  input: UcpOperationHandlerInput,
) {
  return handlers?.[operation]?.(input) ?? unsupported(operation);
}

async function signedWriteOrJsonError(request: Request) {
  const reason = await signedWriteFailure(request);
  return reason
    ? createUcpEnvelope("error", {}, [
        {
          severity: "error",
          code: "signed_request_required",
          message: reason,
        },
      ])
    : null;
}

function idempotencyRequiredEnvelope(operation: string) {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "idempotency_key_required",
      message: `Idempotency-Key is required for ${operation}.`,
    },
  ]);
}

function idempotencyConflictEnvelope() {
  return createUcpEnvelope("error", {}, [
    {
      severity: "error",
      code: "idempotency_key_conflict",
      message: "Idempotency-Key was already used with different request parameters.",
    },
  ]);
}

function createMemoryUcpIdempotencyStore(): UcpIdempotencyStore {
  const records = new Map<string, UcpIdempotencyRecord>();
  return {
    get: (key) => records.get(key) ?? null,
    put: (record) => {
      records.set(record.key, record);
    },
  };
}

function idempotencyScope(
  operation: string,
  request: Request,
  actor: ResolvedActor | null,
) {
  return [
    operation,
    actor?.tenantId ?? "anonymous",
    actor?.accountId ?? "anonymous",
    request.headers.get("UCP-Agent")?.trim() ?? "unknown-agent",
    idempotencyKey(request),
  ].join(":");
}

async function invokeRestWrite(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  operation: string,
  params: Readonly<Record<string, string>>,
  idempotencyStore: UcpIdempotencyStore,
) {
  const failure = await signedWriteOrJsonError(c.req.raw);
  if (failure) {
    return c.json(failure, 400);
  }

  const signatureFailure = await verifyHttpMessageSignature(
    c.req.raw,
    options.signatureVerification,
  );
  if (signatureFailure) {
    return c.json(createUcpEnvelope("error", {}, [
      {
        severity: "error",
        code: "signed_request_required",
        message: signatureFailure,
      },
    ]), 400);
  }

  if (missingIdempotencyKey(c.req.raw)) {
    return c.json(idempotencyRequiredEnvelope(operation), 400);
  }

  const input = handlerInput(c, params);
  const key = idempotencyScope(operation, c.req.raw, input.actor);
  const requestHash = await requestBodyHash(c.req.raw);
  const existing = await idempotencyStore.get(key);
  if (existing) {
    return existing.requestHash === requestHash
      ? c.json(existing.response)
      : c.json(idempotencyConflictEnvelope(), 409);
  }

  const response = await invokeRestHandler(options.restHandlers, operation, input);
  await idempotencyStore.put({
    key,
    requestHash,
    response,
    createdAt: new Date().toISOString(),
  });
  return c.json(response);
}

async function invokeMcpTool(
  c: Context<UcpRuntimeEnv>,
  options: CreateUcpRoutesOptions,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  idempotencyStore: UcpIdempotencyStore,
) {
  const input: UcpOperationHandlerInput = {
    actor: c.get("actor") ?? null,
    context: c.get("context") ?? null,
    arguments: args,
    request: c.req.raw,
    params: {},
  };
  const key = idempotencyScope(toolName, c.req.raw, input.actor);
  const requestHash = await requestBodyHash(c.req.raw);
  const existing = await idempotencyStore.get(key);
  if (existing) {
    return existing.requestHash === requestHash
      ? existing.response
      : idempotencyConflictEnvelope();
  }

  const response = await (options.mcpToolHandlers?.[toolName]?.(input) ?? unsupported(toolName));
  await idempotencyStore.put({
    key,
    requestHash,
    response,
    createdAt: new Date().toISOString(),
  });
  return response;
}

export function createUcpProfileRoutes() {
  const app = new Hono();

  app.get("/ucp", (c) => c.json(buildUcpBusinessProfile(requestOrigin(c.req.raw))));

  return app;
}

export function createUcpRestRoutes(options: CreateUcpRoutesOptions = {}) {
  const app = new Hono<UcpRuntimeEnv>();
  const idempotencyStore = options.idempotencyStore ?? createMemoryUcpIdempotencyStore();

  app.get("/", (c) => c.json(buildUcpBusinessProfile(requestOrigin(c.req.raw))));

  app.post("/catalog/search", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "search_catalog", handlerInput(c, {}))),
  );
  app.post("/catalog/lookup", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "lookup_catalog", handlerInput(c, {}))),
  );
  app.post("/catalog/product", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "get_product", handlerInput(c, {}))),
  );

  app.post("/checkout-sessions", async (c) =>
    invokeRestWrite(c, options, "create_checkout", {}, idempotencyStore),
  );
  app.get("/checkout-sessions/:id", async (c) =>
    c.json(await invokeRestHandler(options.restHandlers, "get_checkout", handlerInput(c, { id: c.req.param("id") }))),
  );
  app.put("/checkout-sessions/:id", async (c) =>
    invokeRestWrite(c, options, "update_checkout", { id: c.req.param("id") }, idempotencyStore),
  );
  app.post("/checkout-sessions/:id/complete", async (c) =>
    invokeRestWrite(c, options, "complete_checkout", { id: c.req.param("id") }, idempotencyStore),
  );
  app.post("/checkout-sessions/:id/cancel", async (c) =>
    invokeRestWrite(c, options, "cancel_checkout", { id: c.req.param("id") }, idempotencyStore),
  );

  return app;
}

export function createUcpMcpRoutes(options: CreateUcpRoutesOptions = {}) {
  const app = new Hono<UcpRuntimeEnv>();
  const idempotencyStore = options.idempotencyStore ?? createMemoryUcpIdempotencyStore();

  app.post("/", async (c) => {
    const body = await c.req.raw.clone().json().catch(() => null) as JsonRpcRequest | null;
    if (!body || body.jsonrpc !== JSON_RPC_VERSION) {
      return c.json(jsonRpcError(null, -32600, "Invalid JSON-RPC request."), 400);
    }

    if (body.method === "initialize") {
      return c.json(jsonRpcResult(body.id, {
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "chase-sets-ucp",
          title: "Chase Sets UCP",
          version: "0.1.0",
        },
        capabilities: {
          tools: {},
        },
      }));
    }

    if (body.method === "tools/list") {
      return c.json(jsonRpcResult(body.id, {
        tools: UCP_MCP_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: {
            type: "object",
            additionalProperties: true,
          },
          annotations: {
            capability: tool.capability,
            idempotencyKeyRequired: tool.idempotencyKeyRequired,
          },
        })),
      }));
    }

    if (body.method === "tools/call") {
      const params = normalizeArguments(body.params) as UcpToolCallParams;
      const toolName = typeof params.name === "string" ? params.name : "";
      const tool = UCP_MCP_TOOLS.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return c.json(jsonRpcError(body.id, -32602, `Unknown UCP MCP tool '${toolName}'.`), 400);
      }

      if (tool.idempotencyKeyRequired && missingIdempotencyKey(c.req.raw)) {
        return c.json(jsonRpcError(body.id, -32602, `Idempotency-Key is required for ${tool.name}.`), 400);
      }

      if (tool.idempotencyKeyRequired) {
        const signedFailure = await signedWriteFailure(c.req.raw);
        if (signedFailure) {
          return c.json(jsonRpcError(body.id, -32602, signedFailure), 400);
        }
        const signatureFailure = await verifyHttpMessageSignature(
          c.req.raw,
          options.signatureVerification,
        );
        if (signatureFailure) {
          return c.json(jsonRpcError(body.id, -32602, signatureFailure), 400);
        }
      }

      const args = normalizeArguments(params.arguments);
      const result = tool.idempotencyKeyRequired
        ? await invokeMcpTool(c, options, tool.name, args, idempotencyStore)
        : await (options.mcpToolHandlers?.[tool.name]?.({
            actor: c.get("actor") ?? null,
            context: c.get("context") ?? null,
            arguments: args,
            request: c.req.raw,
            params: {},
          }) ?? unsupported(tool.name));

      if (tool.idempotencyKeyRequired && result.messages?.some((message) => message.code === "idempotency_key_conflict")) {
        return c.json(jsonRpcError(body.id, -32000, "Idempotency-Key was already used with different request parameters."), 409);
      }

      return c.json(jsonRpcResult(body.id, {
        content: [
          {
            type: "json",
            json: result,
          },
        ],
      }));
    }

    return c.json(jsonRpcError(body.id, -32601, `Unsupported UCP MCP method '${body.method ?? ""}'.`), 404);
  });

  return app;
}

function handlerInput(
  c: Context<UcpRuntimeEnv>,
  params: Readonly<Record<string, string>>,
): UcpOperationHandlerInput {
  return {
    actor: c.get("actor") ?? null,
    context: c.get("context") ?? null,
    arguments: {},
    request: c.req.raw,
    params,
  };
}
