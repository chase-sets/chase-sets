import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildMcpHandlersFromModules,
  createMcpRoutes,
  validateMcpModuleRegistrations,
  type McpAuditRecord,
} from "./mcp";
import { MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./mcp-protocol";
import type { ResolvedActor } from "./auth";
import type { McpServiceDescriptor } from "./mcp-contracts";

const actor: ResolvedActor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "account_1",
  membershipId: "member_1",
  roleKey: "manager",
  permissions: ["inventory.view", "orders.view", "payouts.request", "payouts.view"],
};

function createRequest(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id: "request_1",
    method,
    params,
  };
}

function toolSuccessResponse(id: string, structuredContent: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent,
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent),
        },
      ],
    },
  };
}

function toolErrorResponse(id: string, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createActorApp(resolvedActor: ResolvedActor, options: Parameters<typeof createMcpRoutes>[0] = {}) {
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", resolvedActor);
    await next();
  });
  app.route("/", createMcpRoutes(options));
  return app;
}

const accountDefaultedToolServices: readonly McpServiceDescriptor[] = [
  {
    serviceId: "inventory",
    serviceName: "Inventory",
    kind: "bounded-context",
    owner: "bounded-contexts/inventory",
    serviceBoundary: "Inventory account-defaulted test tool.",
    tools: [
      {
        name: "inventory.account-defaulted-summary",
        title: "Inventory Account Defaulted Summary",
        description: "Read account-scoped inventory summary using the authenticated account.",
        serviceId: "inventory",
        risk: "read",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              description: "Optional inventory status.",
            },
          },
        },
        permissionBoundary: {
          scope: "account",
          requiredPermissions: ["inventory.view"],
          accountScoped: true,
          auditPrincipal: "actor",
        },
        guardrails: {
          confirmation: {
            required: false,
          },
          idempotencyKey: "not-applicable",
          dryRunSupported: false,
          notes: [],
        },
        audit: {
          eventName: "mcp.inventory.account-defaulted-summary",
          targetType: "inventory-summary",
          sensitiveInputFields: [],
        },
        expectedUsage: ["Use when the actor account is implicit."],
      },
    ],
    resources: [],
  },
];

const availableModuleGuardServices: readonly McpServiceDescriptor[] = [
  {
    ...accountDefaultedToolServices[0]!,
    tools: [
      {
        ...accountDefaultedToolServices[0]!.tools[0]!,
        availability: "available",
      },
    ],
  },
];

describe("MCP runtime routes", () => {
  it("requires a durable idempotency store outside the test runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "false");

    try {
      expect(() => createMcpRoutes()).toThrow(
        "Native MCP routes require a durable idempotencyStore. Bootstrap platformUcpRuntimeSchemaSql",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lists only available descriptor-backed tools", async () => {
    const app = createActorApp(actor);
    const response = await app.request("/tools");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string; annotations: { availability: string } }> };
    expect(body.tools.map((tool) => tool.name).sort()).toEqual([
      "checkout.get-cart",
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.list-import-sources",
    ]);
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "inventory.list-import-sources",
          inputSchema: expect.objectContaining({ type: "object" }),
          outputSchema: expect.objectContaining({
            type: "object",
            required: ["items", "total"],
          }),
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
        expect.objectContaining({
          name: "inventory.create-import-batch",
          annotations: expect.objectContaining({
            confirmationRequired: true,
            confirmationMatchInputField: "confirmationText",
            confirmationExpectedValue: "Create Inventory Import Batch.",
          }),
        }),
      ]),
    );
  });

  it("lists only available descriptor-backed resources", async () => {
    const app = createActorApp(actor);
    const response = await app.request("/resources");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resources: [
        expect.objectContaining({
          uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://checkout/{accountId}/cart",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["orders.view"],
          }),
        }),
      ],
    });
  });

  it("composes MCP handlers from mounted module declarations", () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const composition = buildMcpHandlersFromModules(
      [
        {
          module: {
            contextName: "inventory",
            mcpCapabilities: {
              tools: [{ name: "inventory.account-defaulted-summary", ownerSlice: "inventory-items" }],
            },
            buildMcpHandlers: () => ({
              toolHandlers: {
                "inventory.account-defaulted-summary": handler,
              },
            }),
          },
          services: {},
        },
      ],
      availableModuleGuardServices,
    );

    expect(composition.toolHandlers["inventory.account-defaulted-summary"]).toBe(handler);
    expect(composition.registrations).toEqual([
      expect.objectContaining({
        contextName: "inventory",
        capabilities: {
          tools: [{ name: "inventory.account-defaulted-summary", ownerSlice: "inventory-items" }],
        },
      }),
    ]);
  });

  it("validates available MCP capabilities from module declarations", () => {
    expect(
      validateMcpModuleRegistrations(
        [
          {
            contextName: "inventory",
            capabilities: {},
            handlers: {},
          },
        ],
        availableModuleGuardServices,
      ),
    ).toEqual([
      "Available MCP tool 'inventory.account-defaulted-summary' is owned by mounted context 'inventory' but no module declares it.",
    ]);

    expect(
      validateMcpModuleRegistrations(
        [
          {
            contextName: "inventory",
            capabilities: {
              tools: [{ name: "inventory.account-defaulted-summary" }],
            },
            handlers: {},
          },
        ],
        availableModuleGuardServices,
      ),
    ).toEqual(["Available MCP tool 'inventory.account-defaulted-summary' is declared but no handler is registered."]);

    expect(
      validateMcpModuleRegistrations(
        [
          {
            contextName: "inventory",
            capabilities: {
              tools: [{ name: "inventory.account-defaulted-summary" }],
            },
            handlers: {},
          },
        ],
        accountDefaultedToolServices,
      ),
    ).toEqual([]);

    expect(
      validateMcpModuleRegistrations(
        [
          {
            contextName: "checkout",
            capabilities: {
              tools: [{ name: "inventory.account-defaulted-summary" }],
            },
            handlers: {},
          },
        ],
        availableModuleGuardServices,
      ),
    ).toEqual([
      "Context 'checkout' declares MCP tool 'inventory.account-defaulted-summary' owned by context 'inventory'.",
    ]);

    expect(
      validateMcpModuleRegistrations(
        [
          {
            contextName: "inventory",
            capabilities: {},
            handlers: {
              toolHandlers: {
                "inventory.account-defaulted-summary": vi.fn(),
              },
            },
          },
        ],
        availableModuleGuardServices,
      ),
    ).toEqual([
      "Context 'inventory' registers MCP tool handler 'inventory.account-defaulted-summary' without declaring it in mcpCapabilities.tools.",
      "Available MCP tool 'inventory.account-defaulted-summary' is owned by mounted context 'inventory' but no module declares it.",
    ]);
  });

  it("requires an authenticated actor for native discovery endpoints", async () => {
    const app = createMcpRoutes();
    const endpoints = ["/services", "/tools", "/resources"];

    for (const endpoint of endpoints) {
      const response = await app.request(endpoint);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message: "An authenticated actor is required for native MCP discovery.",
        },
      });
    }
  });

  it("filters JSON-RPC list methods to available capabilities", async () => {
    const app = createActorApp(actor);
    const toolsResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
    });
    const resourcesResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("resources/list")),
    });

    expect(toolsResponse.status).toBe(200);
    await expect(toolsResponse.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "checkout.get-cart" }),
          expect.objectContaining({ name: "inventory.list-import-sources" }),
          expect.objectContaining({ name: "inventory.create-import-batch" }),
          expect.objectContaining({ name: "inventory.get-import-batch" }),
          expect.objectContaining({ name: "inventory.commit-import-batch" }),
        ]),
      },
    });
    expect(resourcesResponse.status).toBe(200);
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: expect.arrayContaining([
          expect.objectContaining({
            uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          }),
          expect.objectContaining({
            uriTemplate: "chase-sets://checkout/{accountId}/cart",
          }),
        ]),
      },
    });
  });

  it("negotiates the native MCP protocol version on initialize", async () => {
    const app = createActorApp(actor);

    const supportedResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: MCP_PROTOCOL_VERSION })),
    });
    const unsupportedResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: "2025-03-26" })),
    });
    const futureRevisionResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: "2025-11-25" })),
    });

    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toEqual([MCP_PROTOCOL_VERSION]);
    expect(supportedResponse.status).toBe(200);
    await expect(supportedResponse.json()).resolves.toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "chase-sets-platform",
        },
      },
    });
    expect(unsupportedResponse.status).toBe(200);
    await expect(unsupportedResponse.json()).resolves.toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    });
    expect(futureRevisionResponse.status).toBe(200);
    await expect(futureRevisionResponse.json()).resolves.toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    });
  });

  it("requires an authenticated actor for JSON-RPC discovery methods", async () => {
    const app = createMcpRoutes();

    for (const method of ["initialize", "tools/list", "resources/list"]) {
      const response = await app.request("/", {
        method: "POST",
        body: JSON.stringify(createRequest(method)),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: "request_1",
        error: {
          code: -32001,
          message: "An authenticated actor is required for native MCP discovery.",
        },
      });
    }
  });

  it("rejects native MCP JSON-RPC batches as transport-level invalid requests", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify([createRequest("tools/list")]),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported.",
      },
    });
  });

  it("returns native MCP unsupported methods as in-band JSON-RPC errors", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("unknown/method")),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32601,
        message: "Unsupported MCP method 'unknown/method'.",
      },
    });
  });

  it("limits native MCP tool calls before invoking handlers and records audit evidence", async () => {
    const handler = vi.fn();
    const auditRecords: McpAuditRecord[] = [];
    const app = createActorApp(actor, {
      services: accountDefaultedToolServices,
      toolHandlers: {
        "inventory.account-defaulted-summary": handler,
      },
      toolCallLimiter: {
        acquire: vi.fn(async () => ({
          allowed: false as const,
          reason: "Too many MCP tool calls are already running for this principal.",
        })),
      },
      audit: (record) => {
        auditRecords.push(record);
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.account-defaulted-summary",
          arguments: {},
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Too many MCP tool calls are already running for this principal."),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(auditRecords).toEqual([
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "inventory.account-defaulted-summary",
        reason: "Too many MCP tool calls are already running for this principal.",
        limitKind: "read",
      }),
    ]);
  });

  it("releases native MCP tool call limiter leases after handlers complete", async () => {
    const release = vi.fn();
    const app = createActorApp(actor, {
      services: accountDefaultedToolServices,
      toolHandlers: {
        "inventory.account-defaulted-summary": vi.fn(async () => ({ ok: true })),
      },
      toolCallLimiter: {
        acquire: vi.fn(async () => ({
          allowed: true as const,
          lease: { release },
        })),
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.account-defaulted-summary",
          arguments: {},
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(toolSuccessResponse("request_1", { ok: true }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("calls a registered tool handler after authorization", async () => {
    const auditRecords: McpAuditRecord[] = [];
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": vi.fn(async ({ actor: resolvedActor, arguments: args }) => ({
          accountId: resolvedActor?.accountId,
          query: args.status,
          items: [],
        })),
      },
      audit: (record) => {
        auditRecords.push(record);
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
            status: "available",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        accountId: "account_1",
        query: "available",
        items: [],
      }),
    );
    expect(auditRecords).toEqual([
      expect.objectContaining({
        outcome: "allowed",
        method: "tools/call",
        toolName: "inventory.list-items",
        actorId: "user_1",
        accountId: "account_1",
      }),
    ]);
  });

  it("is parseable by the stock MCP SDK client for inventory import source reads", async () => {
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-import-sources": vi.fn(async () => ({
          items: [
            {
              sourceKey: "tcgplayer-csv",
              label: "TCGplayer CSV",
              kind: "csv",
              adapterVersion: 1,
              displayNameValueKeys: ["title"],
              values: [{ targetKey: "sellerSku" }],
              externalReferenceCandidates: [],
              selectedOptionInference: [],
            },
          ],
          total: 1,
        })),
      },
    });
    const client = new Client({ name: "chase-sets-mcp-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.test/"), {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return app.fetch(request);
      },
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "inventory.list-import-sources",
            outputSchema: expect.objectContaining({ type: "object" }),
          }),
        ]),
      );

      const result = await client.callTool({
        name: "inventory.list-import-sources",
        arguments: { accountId: "account_1" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        items: [
          {
            sourceKey: "tcgplayer-csv",
            label: "TCGplayer CSV",
            kind: "csv",
            adapterVersion: 1,
            displayNameValueKeys: ["title"],
            values: [{ targetKey: "sellerSku" }],
            externalReferenceCandidates: [],
            selectedOptionInference: [],
          },
        ],
        total: 1,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify(result.structuredContent),
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects account-scoped tool calls for another account before reaching handlers", async () => {
    const handler = vi.fn();
    const audit = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": handler,
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_2",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "MCP tool accountId must match the authenticated actor account."),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "inventory.list-items",
        reason: "MCP tool accountId must match the authenticated actor account.",
      }),
    );
  });

  it("allows account-scoped tool calls without an accountId argument", async () => {
    const handler = vi.fn(async ({ actor: resolvedActor }) => ({
      accountId: resolvedActor?.accountId,
      items: [],
    }));
    const app = createActorApp(actor, {
      services: accountDefaultedToolServices,
      toolHandlers: {
        "inventory.account-defaulted-summary": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.account-defaulted-summary",
          arguments: {
            status: "available",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        accountId: "account_1",
        items: [],
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects missing required tool arguments before reaching handlers", async () => {
    const handler = vi.fn();
    const audit = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": handler,
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            status: "available",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        "Invalid MCP tool arguments. accountId: Required field is missing. Expected present. Actual missing.",
      ),
    );
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "inventory.list-items",
        reason: "Invalid MCP tool arguments.",
      }),
    );
  });

  it("rejects wrong-type tool arguments before reaching handlers", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.list-items": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: 12,
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        "Invalid MCP tool arguments. accountId: Expected string. Expected string. Actual number.",
      ),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects out-of-enum tool arguments before authorization", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "inventory.create-import-batch": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.create-import-batch",
          arguments: {
            accountId: "account_1",
            sourceKey: "csv",
            quantityMode: "merge",
            idempotencyKey: "idem_1",
            confirmationText: "Create Inventory Import Batch.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        "Invalid MCP tool arguments. quantityMode: Expected one of: add, replace. Expected add | replace. Actual merge.",
      ),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects tools without the required permission and records audit", async () => {
    const audit = vi.fn();
    const app = createActorApp(
      {
        ...actor,
        permissions: ["inventory.view"],
      },
      { audit },
    );

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Missing required permission: payouts.request."),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        toolName: "settlement.request-payout",
        reason: "Missing required permission: payouts.request.",
      }),
    );
  });

  it("rejects sensitive tools without confirmation before reaching handlers", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Confirmation is required for this MCP tool."),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive tools when confirmation text does not match the expected value", async () => {
    const handler = vi.fn();
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Confirmation text must exactly match 'Request Payout.'."),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects sensitive tools with blank idempotency after schema validation", async () => {
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": vi.fn(),
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "An idempotency key is required for this MCP tool."),
    );
  });

  it("replays duplicate idempotent tool calls without invoking the handler again", async () => {
    const handler = vi.fn(async () => ({ payoutId: "payout_1", status: "requested" }));
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });
    const request = createRequest("tools/call", {
      name: "settlement.request-payout",
      arguments: {
        accountId: "account_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_replay",
        confirmationText: "Request Payout.",
      },
      confirmation: {
        confirmed: true,
        text: "Request Payout.",
      },
    });

    const first = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const replay = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(first.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        payoutId: "payout_1",
        status: "requested",
      }),
    );
    await expect(replay.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        payoutId: "payout_1",
        status: "requested",
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stores and replays idempotent handler failures as MCP tool error results", async () => {
    const handler = vi.fn(async () => {
      throw new Error("provider timeout");
    });
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });
    const request = createRequest("tools/call", {
      name: "settlement.request-payout",
      arguments: {
        accountId: "account_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_throw",
        confirmationText: "Request Payout.",
      },
      confirmation: {
        confirmed: true,
        text: "Request Payout.",
      },
    });

    const first = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const replay = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(first.json()).resolves.toEqual(toolErrorResponse("request_1", "provider timeout"));
    await expect(replay.json()).resolves.toEqual(toolErrorResponse("request_1", "provider timeout"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns retry-later for a duplicate idempotent call while the first call is still pending", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const handler = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return { payoutId: "payout_1", status: "requested" };
    });
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });
    const request = createRequest("tools/call", {
      name: "settlement.request-payout",
      arguments: {
        accountId: "account_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_pending",
        confirmationText: "Request Payout.",
      },
      confirmation: {
        confirmed: true,
        text: "Request Payout.",
      },
    });

    const first = app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });
    await started.promise;
    const duplicate = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });
    release.resolve();
    const firstResponse = await Promise.resolve(first);

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual(
      toolErrorResponse("request_1", "A matching MCP tool call is already in progress. Retry later."),
    );
    await expect(firstResponse.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        payoutId: "payout_1",
        status: "requested",
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stores idempotent success before best-effort audit failures", async () => {
    const handler = vi.fn(async () => ({ payoutId: "payout_1", status: "requested" }));
    const audit = vi.fn(async (record: McpAuditRecord) => {
      if (record.outcome === "allowed") {
        throw new Error("audit unavailable");
      }
    });
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
      audit,
    });
    const request = createRequest("tools/call", {
      name: "settlement.request-payout",
      arguments: {
        accountId: "account_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_audit",
        confirmationText: "Request Payout.",
      },
      confirmation: {
        confirmed: true,
        text: "Request Payout.",
      },
    });

    const first = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });
    const replay = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(first.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        payoutId: "payout_1",
        status: "requested",
      }),
    );
    await expect(replay.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        payoutId: "payout_1",
        status: "requested",
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency-key reuse with different tool arguments", async () => {
    const handler = vi.fn(async () => ({ payoutId: "payout_1", status: "requested" }));
    const app = createActorApp(actor, {
      toolHandlers: {
        "settlement.request-payout": handler,
      },
    });
    const request = (amount: string) =>
      createRequest("tools/call", {
        name: "settlement.request-payout",
        arguments: {
          accountId: "account_1",
          amount,
          reason: "Seller requested payout.",
          idempotencyKey: "idem_conflict",
          confirmationText: "Request Payout.",
        },
        confirmation: {
          confirmed: true,
          text: "Request Payout.",
        },
      });

    const first = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request("25.00")),
    });
    const conflict = await app.request("/", {
      method: "POST",
      body: JSON.stringify(request("30.00")),
    });

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(200);
    await expect(conflict.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Idempotency key was already used with different MCP tool arguments."),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns an auditable safe boundary when no handler is registered", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        'No runtime handler is registered for MCP tool \'inventory.list-items\'. Redacted arguments: {"accountId":"account_1"}',
      ),
    );
  });

  it("redacts sensitive write arguments when no handler is registered", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_1",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        'No runtime handler is registered for MCP tool \'settlement.request-payout\'. Redacted arguments: {"accountId":"account_1","amount":"[redacted]","reason":"[redacted]","idempotencyKey":"idem_1","confirmationText":"[redacted]"}',
      ),
    );
  });

  it("rejects account-scoped resource reads for another account before reaching handlers", async () => {
    const handler = vi.fn();
    const audit = vi.fn();
    const app = createActorApp(actor, {
      resourceHandlers: {
        "chase-sets://inventory/{accountId}/import-batches/{batchId}": handler,
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("resources/read", {
          uri: "chase-sets://inventory/account_2/import-batches/batch_1",
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "MCP resource accountId must match the authenticated actor account.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        method: "resources/read",
        resourceUri: "chase-sets://inventory/account_2/import-batches/batch_1",
        reason: "MCP resource accountId must match the authenticated actor account.",
      }),
    );
  });

  it("allows public resource reads without an actor account", async () => {
    const handler = vi.fn(async () => ({ slug: "base-set-charizard" }));
    const app = createMcpRoutes({
      resourceHandlers: {
        "chase-sets://discovery/items/{itemSlug}": handler,
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("resources/read", {
          uri: "chase-sets://discovery/items/base-set-charizard",
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        contents: [
          {
            uri: "chase-sets://discovery/items/base-set-charizard",
            mimeType: "application/json",
            text: JSON.stringify({ slug: "base-set-charizard" }),
          },
        ],
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns a JSON-RPC error and failed audit when a resource handler throws", async () => {
    const audit = vi.fn();
    const app = createActorApp(actor, {
      resourceHandlers: {
        "chase-sets://inventory/{accountId}/import-batches/{batchId}": vi.fn(async () => {
          throw new Error("Import batch read failed.");
        }),
      },
      audit,
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("resources/read", {
          uri: "chase-sets://inventory/account_1/import-batches/batch_1",
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32000,
        message: "Import batch read failed.",
      },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        method: "resources/read",
        resourceUri: "chase-sets://inventory/account_1/import-batches/batch_1",
        actorId: "user_1",
        accountId: "account_1",
        auditEventName: "mcp.inventory.resources.read",
        targetType: "Inventory Import Batch",
        reason: "Import batch read failed.",
      }),
    );
  });
});
