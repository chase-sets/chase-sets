import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  buildMcpHandlersFromModules,
  createMcpOAuthProtectedResourceMetadataRoutes,
  createMcpRoutes,
  MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  validateMcpModuleRegistrations,
  type McpAuditRecord,
  type McpToolHandlerInput,
} from "./mcp";
import {
  MCP_EXTENSION_TASKS,
  MCP_EXTENSION_UI,
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_META_CLIENT_INFO_KEY,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_UI_RESOURCE_MIME_TYPE,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from "./mcp-protocol";
import type { ResolvedActor } from "./auth";
import { flattenAvailableMcpTools, type McpServiceDescriptor } from "./mcp-contracts";

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

function statelessMcpMeta(clientCapabilities: Readonly<Record<string, unknown>> = {}) {
  return {
    [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION_2026_07_28,
    [MCP_META_CLIENT_INFO_KEY]: {
      name: "vitest-mcp-client",
      version: "0.1.0",
    },
    [MCP_META_CLIENT_CAPABILITIES_KEY]: clientCapabilities,
  };
}

function statelessRequest(method: string, params: Readonly<Record<string, unknown>> = {}) {
  return createRequest(method, {
    ...params,
    _meta: statelessMcpMeta(),
  });
}

function statelessHeaders(method: string, name?: string) {
  return {
    "Content-Type": "application/json",
    [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2026_07_28,
    [MCP_METHOD_HEADER]: method,
    ...(name ? { [MCP_NAME_HEADER]: name } : {}),
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

  it("serves RFC 9728 protected-resource metadata without credentials", async () => {
    const app = createMcpOAuthProtectedResourceMetadataRoutes();

    const response = await app.request("https://marketplace.example/oauth-protected-resource");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://marketplace.example/mcp",
      authorization_servers: ["https://marketplace.example/.well-known/oauth-authorization-server"],
      scopes_supported: expect.arrayContaining([
        "catalog:read",
        "checkout:read",
        "checkout:write",
        "order:read",
        "listings:write",
        "payouts:request",
        "account:read",
      ]),
      bearer_methods_supported: ["header"],
    });
  });

  it("challenges anonymous protected tool calls with protected-resource metadata", async () => {
    const handler = vi.fn();
    const app = createMcpRoutes({
      toolHandlers: {
        "inventory.list-import-sources": handler,
      },
    });

    const response = await app.request("https://marketplace.example/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "inventory.list-import-sources",
          arguments: { accountId: "account_1" },
        }),
      ),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="https://marketplace.example${MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH}"`,
    );
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "An authenticated actor is required.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("challenges anonymous protected resource reads with protected-resource metadata", async () => {
    const handler = vi.fn();
    const app = createMcpRoutes({
      resourceHandlers: {
        "chase-sets://inventory/{accountId}/import-batches/{batchId}": handler,
      },
    });

    const response = await app.request("https://marketplace.example/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("resources/read", {
          uri: "chase-sets://inventory/account_1/import-batches/batch_1",
        }),
      ),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="https://marketplace.example${MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH}"`,
    );
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "An authenticated actor is required.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("lists only available descriptor-backed tools", async () => {
    const app = createActorApp(actor);
    const response = await app.request("/tools");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string; annotations: { availability: string } }> };
    expect(body.tools.map((tool) => tool.name).sort()).toEqual([
      "checkout.add-cart-line",
      "checkout.cancel-session",
      "checkout.get-cart",
      "checkout.remove-cart-line",
      "checkout.select-saved-address",
      "checkout.update-cart-line",
      "discovery.get-chatgpt-product-feed",
      "discovery.get-item-detail",
      "discovery.search-market",
      "fulfillment.get-tracking",
      "fulfillment.list-shipments",
      "fulfillment.purchase-label",
      "fulfillment.void-label",
      "identity.get-account",
      "inventory.adjust-item",
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.list-import-sources",
      "inventory.list-items",
      "marketplace.accept-offer",
      "marketplace.counter-offer",
      "marketplace.create-listing",
      "marketplace.decline-offer",
      "marketplace.get-reputation-summary",
      "marketplace.get-seller-insights",
      "marketplace.list-listings",
      "marketplace.list-offers",
      "marketplace.list-reviews",
      "marketplace.publish-listing",
      "marketplace.submit-offer",
      "marketplace.unpublish-listing",
      "marketplace.update-listing-price",
      "ordering.get-order",
      "ordering.list-orders",
      "payments.confirm-payment-method-setup",
      "payments.get-payment",
      "payments.get-refund-status",
      "payments.start-payment-method-setup",
      "platform-operations.get-seller-insight-summary",
      "platform-operations.get-support-request",
      "platform-operations.list-support-requests",
      "pricing.explain-signals",
      "pricing.recommend-price",
      "settlement.create-payout-onboarding-link",
      "settlement.get-payout",
      "settlement.get-wallet",
      "settlement.list-ledger-entries",
      "settlement.list-payouts",
      "settlement.refresh-readiness",
      "settlement.request-payout",
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
          name: "discovery.search-market",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: [],
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
        expect.objectContaining({
          name: "fulfillment.purchase-label",
          annotations: expect.objectContaining({
            confirmationRequired: true,
            confirmationMatchInputField: "confirmationText",
            confirmationExpectedValue: "Purchase Label.",
          }),
        }),
        expect.objectContaining({
          name: "marketplace.create-listing",
          annotations: expect.objectContaining({
            confirmationRequired: true,
            confirmationMatchInputField: "confirmationText",
            confirmationExpectedValue: "Create Listing.",
          }),
        }),
      ]),
    );
  });

  it("maps every cataloged tool risk model onto MCP standard annotations", async () => {
    const app = createActorApp(actor);
    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
      headers: {
        "Content-Type": "application/json",
        [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2025_11_25,
      },
    });
    const body = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          annotations: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
          };
        }>;
      };
    };
    const descriptorsByName = new Map(flattenAvailableMcpTools().map((tool) => [tool.name, tool]));

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(descriptorsByName.size);
    for (const tool of body.result.tools) {
      const descriptor = descriptorsByName.get(tool.name);
      if (!descriptor) {
        throw new Error(`Unexpected MCP tool '${tool.name}'.`);
      }

      expect(tool.annotations).toMatchObject({
        readOnlyHint: descriptor.risk === "read",
        destructiveHint: descriptor.risk === "destructive",
      });
      if (descriptor.risk !== "read" && descriptor.guardrails.idempotencyKey === "required") {
        expect(tool.annotations.idempotentHint).toBe(true);
      }
    }
  });

  it("rejects hostile browser origins and emits CORS headers for allowed MCP origins", async () => {
    const app = createActorApp(actor);

    const hostileResponse = await app.request("https://marketplace.chasesets.test/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
    });
    const preflightResponse = await app.request("https://marketplace.chasesets.test/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://marketplace.chasesets.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `Content-Type, Authorization, ${MCP_PROTOCOL_VERSION_HEADER}`,
      },
    });
    const allowedResponse = await app.request("https://marketplace.chasesets.test/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://marketplace.chasesets.test",
      },
    });

    expect(hostileResponse.status).toBe(403);
    await expect(hostileResponse.json()).resolves.toMatchObject({
      error: {
        code: -32003,
        message: "Invalid Origin header for MCP endpoint.",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://marketplace.chasesets.test");
    expect(preflightResponse.headers.get("Access-Control-Allow-Headers")).toContain(MCP_PROTOCOL_VERSION_HEADER);
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://marketplace.chasesets.test");
  });

  it("lists only available descriptor-backed resources", async () => {
    const app = createActorApp(actor);
    const response = await app.request("/resources");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resources: [
        expect.objectContaining({
          uriTemplate: "chase-sets://identity/{accountId}/account",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["accounts.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://discovery/items/{itemSlug}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: [],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://inventory/{accountId}/items/{inventoryItemId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["inventory.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://marketplace/{accountId}/listings/{listingId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["listings.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://marketplace/{accountId}/offers/{offerId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["offers.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://marketplace/{accountId}/reputation/summaries/{subjectAccountId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["reputation.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://marketplace/{accountId}/reviews/{reviewId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["reputation.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["pricing.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://checkout/{accountId}/cart",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["orders.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://ordering/{accountId}/orders/{orderId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["orders.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://payments/{accountId}/payments/{paymentId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["orders.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["fulfillment.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://settlement/{accountId}/wallet",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["payouts.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://settlement/{accountId}/payouts/{payoutId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["payouts.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://platform-operations/{accountId}/insights/summary",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["accounts.view"],
          }),
        }),
        expect.objectContaining({
          uriTemplate: "chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["support.view"],
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

  it("lists only public available capabilities for anonymous native discovery endpoints", async () => {
    const app = createMcpRoutes();
    const servicesResponse = await app.request("/services");
    const toolsResponse = await app.request("/tools");
    const resourcesResponse = await app.request("/resources");

    expect(servicesResponse.status).toBe(200);
    await expect(servicesResponse.json()).resolves.toMatchObject({
      services: [
        expect.objectContaining({
          serviceId: "discovery",
          tools: [
            expect.objectContaining({ name: "discovery.search-market" }),
            expect.objectContaining({ name: "discovery.get-item-detail" }),
            expect.objectContaining({ name: "discovery.get-chatgpt-product-feed" }),
          ],
          resources: [expect.objectContaining({ uriTemplate: "chase-sets://discovery/items/{itemSlug}" })],
        }),
      ],
    });
    await expect(toolsResponse.json()).resolves.toMatchObject({
      tools: [
        expect.objectContaining({ name: "discovery.search-market" }),
        expect.objectContaining({ name: "discovery.get-item-detail" }),
        expect.objectContaining({ name: "discovery.get-chatgpt-product-feed" }),
      ],
    });
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      resources: [expect.objectContaining({ uriTemplate: "chase-sets://discovery/items/{itemSlug}" })],
    });
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
          expect.objectContaining({ name: "discovery.search-market" }),
          expect.objectContaining({ name: "discovery.get-item-detail" }),
          expect.objectContaining({ name: "discovery.get-chatgpt-product-feed" }),
          expect.objectContaining({ name: "inventory.list-import-sources" }),
          expect.objectContaining({ name: "inventory.create-import-batch" }),
          expect.objectContaining({ name: "inventory.get-import-batch" }),
          expect.objectContaining({ name: "inventory.commit-import-batch" }),
          expect.objectContaining({ name: "marketplace.create-listing" }),
          expect.objectContaining({ name: "marketplace.update-listing-price" }),
          expect.objectContaining({ name: "marketplace.publish-listing" }),
          expect.objectContaining({ name: "marketplace.unpublish-listing" }),
        ]),
      },
    });
    expect(resourcesResponse.status).toBe(200);
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: expect.arrayContaining([
          expect.objectContaining({
            uriTemplate: "chase-sets://discovery/items/{itemSlug}",
          }),
          expect.objectContaining({
            uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          }),
          expect.objectContaining({
            uriTemplate: "chase-sets://checkout/{accountId}/cart",
          }),
          expect.objectContaining({
            uriTemplate: "chase-sets://marketplace/{accountId}/listings/{listingId}",
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
    const revision20251125Response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: MCP_PROTOCOL_VERSION_2025_11_25 })),
    });
    const statelessInitializeResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28 })),
    });

    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toEqual([
      MCP_PROTOCOL_VERSION,
      MCP_PROTOCOL_VERSION_2025_11_25,
      MCP_PROTOCOL_VERSION_2026_07_28,
    ]);
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
    expect(revision20251125Response.status).toBe(200);
    await expect(revision20251125Response.json()).resolves.toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION_2025_11_25,
      },
    });
    expect(statelessInitializeResponse.status).toBe(200);
    await expect(statelessInitializeResponse.json()).resolves.toMatchObject({
      error: {
        code: -32601,
        message: expect.stringContaining(MCP_PROTOCOL_VERSION_2026_07_28),
      },
    });
  });

  it("discovers stateless native MCP capabilities without issuing a session id", async () => {
    const app = createActorApp(actor, {
      extensionCapabilities: {
        [MCP_EXTENSION_TASKS]: {},
        [MCP_EXTENSION_UI]: {
          mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
        },
      },
    });

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(statelessRequest("server/discover")),
      headers: statelessHeaders("server/discover"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      result: {
        protocolVersions: [MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_2025_11_25, MCP_PROTOCOL_VERSION_2026_07_28],
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            [MCP_EXTENSION_TASKS]: {},
            [MCP_EXTENSION_UI]: {
              mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
            },
          },
        },
      },
    });
  });

  it("handles handshakeless stateless native MCP tool requests with per-request client metadata", async () => {
    const handler = vi.fn(async ({ protocol }: McpToolHandlerInput) => ({
      protocolVersion: protocol.protocolVersion,
      clientName: protocol.clientInfo?.name,
      clientCapabilities: protocol.clientCapabilities,
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
        statelessRequest("tools/call", {
          name: "inventory.account-defaulted-summary",
          arguments: {},
        }),
      ),
      headers: statelessHeaders("tools/call", "inventory.account-defaulted-summary"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    await expect(response.json()).resolves.toEqual(
      toolSuccessResponse("request_1", {
        protocolVersion: MCP_PROTOCOL_VERSION_2026_07_28,
        clientName: "vitest-mcp-client",
        clientCapabilities: {},
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects stateless native MCP requests with missing or mismatched routing headers", async () => {
    const app = createActorApp(actor);

    const missingNameResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        statelessRequest("tools/call", {
          name: "inventory.list-import-sources",
          arguments: {
            accountId: "account_1",
          },
        }),
      ),
      headers: statelessHeaders("tools/call"),
    });
    const mismatchedMethodResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(statelessRequest("tools/list")),
      headers: statelessHeaders("resources/list"),
    });

    expect(missingNameResponse.status).toBe(400);
    await expect(missingNameResponse.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        message: `${MCP_NAME_HEADER} is required for tools/call.`,
      },
    });
    expect(mismatchedMethodResponse.status).toBe(400);
    await expect(mismatchedMethodResponse.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        message: `${MCP_METHOD_HEADER} must match the JSON-RPC method.`,
      },
    });
  });

  it("rejects stateless native MCP requests that omit required per-request metadata", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/list", {
          _meta: {
            [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION_2026_07_28,
          },
        }),
      ),
      headers: statelessHeaders("tools/list"),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining(MCP_META_CLIENT_INFO_KEY),
      },
    });
  });

  it("rejects unsupported native MCP protocol revision headers", async () => {
    const app = createActorApp(actor);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
      headers: {
        [MCP_PROTOCOL_VERSION_HEADER]: "2025-03-26",
        [MCP_METHOD_HEADER]: "tools/list",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32004,
        data: {
          requestedVersion: "2025-03-26",
          supportedVersions: [MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_2025_11_25, MCP_PROTOCOL_VERSION_2026_07_28],
        },
      },
    });
  });

  it("lists only public available capabilities for anonymous JSON-RPC discovery methods", async () => {
    const app = createMcpRoutes();

    const discoverResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("server/discover")),
    });
    const initializeResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("initialize", { protocolVersion: MCP_PROTOCOL_VERSION })),
    });
    const toolsResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
    });
    const resourcesResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("resources/list")),
    });

    expect(discoverResponse.status).toBe(200);
    await expect(discoverResponse.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "chase-sets-platform" } },
    });
    expect(initializeResponse.status).toBe(200);
    await expect(initializeResponse.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "chase-sets-platform" } },
    });
    await expect(toolsResponse.json()).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: "discovery.search-market" }),
          expect.objectContaining({ name: "discovery.get-item-detail" }),
          expect.objectContaining({ name: "discovery.get-chatgpt-product-feed" }),
        ],
      },
    });
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: [expect.objectContaining({ uriTemplate: "chase-sets://discovery/items/{itemSlug}" })],
      },
    });
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

  it("allows seller listing writes granted by OAuth scope and records the acting grant", async () => {
    const handler = vi.fn(async () => ({ listingId: "lst_1", status: "published" }));
    const audit = vi.fn();
    const app = createActorApp(
      {
        ...actor,
        sessionId: "ucp:lpa_listings",
        permissions: ["listings.manage"],
        agentGrant: {
          grantId: "lpa_listings",
          scopes: ["listings:write"],
          rolePermissions: ["listings.manage", "payouts.request"],
        },
      },
      {
        toolHandlers: {
          "marketplace.publish-listing": handler,
        },
        audit,
      },
    );

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "marketplace.publish-listing",
          arguments: {
            accountId: "account_1",
            listingId: "lst_1",
            feeQuoteFingerprint: "fee_1",
            idempotencyKey: "idem_publish",
            confirmationText: "Publish Listing.",
          },
          confirmation: {
            confirmed: true,
            text: "Publish Listing.",
          },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      toolSuccessResponse("request_1", { listingId: "lst_1", status: "published" }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "allowed",
        toolName: "marketplace.publish-listing",
        agentGrantId: "lpa_listings",
        agentGrantScopes: ["listings:write"],
      }),
    );
  });

  it("returns an OAuth scope challenge when an agent grant needs incremental consent", async () => {
    const handler = vi.fn();
    const audit = vi.fn();
    const app = createActorApp(
      {
        ...actor,
        sessionId: "ucp:lpa_listings",
        permissions: ["listings.manage"],
        agentGrant: {
          grantId: "lpa_listings",
          scopes: ["listings:write"],
          rolePermissions: ["listings.manage", "payouts.request"],
        },
      },
      {
        toolHandlers: {
          "settlement.request-payout": handler,
        },
        audit,
      },
    );

    const response = await app.request("https://marketplace.example/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_payout",
            confirmationText: "Request Payout.",
          },
          confirmation: {
            confirmed: true,
            text: "Request Payout.",
          },
        }),
      ),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="https://marketplace.example${MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH}", scope="payouts:request"`,
    );
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: {
        code: -32001,
        message: "Missing required OAuth scope: payouts:request.",
        data: {
          missingScopes: ["payouts:request"],
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        toolName: "settlement.request-payout",
        reason: "Missing required OAuth scope: payouts:request.",
        agentGrantId: "lpa_listings",
      }),
    );
  });

  it("does not scope-challenge when the member role lacks the requested permission", async () => {
    const handler = vi.fn();
    const app = createActorApp(
      {
        ...actor,
        sessionId: "ucp:lpa_viewer",
        permissions: [],
        agentGrant: {
          grantId: "lpa_viewer",
          scopes: ["payouts:request"],
          rolePermissions: ["payouts.view"],
        },
      },
      {
        toolHandlers: {
          "settlement.request-payout": handler,
        },
      },
    );

    const response = await app.request("https://marketplace.example/", {
      method: "POST",
      body: JSON.stringify(
        createRequest("tools/call", {
          name: "settlement.request-payout",
          arguments: {
            accountId: "account_1",
            amount: "25.00",
            reason: "Seller requested payout.",
            idempotencyKey: "idem_viewer_payout",
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
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    await expect(response.json()).resolves.toEqual(
      toolErrorResponse("request_1", "Missing required permission: payouts.request."),
    );
    expect(handler).not.toHaveBeenCalled();
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
