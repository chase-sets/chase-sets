import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AGENT_OAUTH_COMMERCE_SCOPES,
  isAgentOAuthOperatorScope,
  type AgentOAuthScope,
  type OperatorAuthority,
  type OperatorAuthorityDecision,
} from "@chase-sets/auth-context";
import {
  buildMcpHandlersFromModules,
  createMcpOAuthProtectedResourceMetadataRoutes,
  createMcpRoutes,
  MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED,
  MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  validateMcpModuleRegistrations,
  type McpAuditRecord,
  type McpToolHandler,
  type McpToolHandlerInput,
} from "./mcp";
import {
  MCP_EXTENSION_TASKS,
  MCP_EXTENSION_UI,
  MCP_CLIENT_CAPABILITIES_HEADER,
  MCP_CLIENT_NAME_HEADER,
  MCP_CLIENT_VERSION_HEADER,
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
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "./http";
import {
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  validateMcpServiceCatalog,
  type McpServiceDescriptor,
} from "./mcp-contracts";

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
  describe("native MCP protocol equivalence", () => {
    const meta = statelessMcpMeta();
    const modernHeaders = statelessHeaders("tools/list");
    const error = (code: number, message: string, data?: unknown) => ({
      jsonrpc: "2.0",
      id: "request_1",
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
    const emptyTools = { jsonrpc: "2.0", id: "request_1", result: { tools: [] } };
    const mismatch = (message: string) => error(-32001, message);
    const invalid = (message: string) => error(-32602, message);
    const cases: readonly {
      name: string;
      method?: string;
      headers: Readonly<Record<string, string>>;
      params: unknown;
      status: number;
      body: unknown;
    }[] = [
      { name: "no header", headers: {}, params: {}, status: 200, body: emptyTools },
      ...[MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_2025_11_25].map((version) => ({
        name: `legacy ${version}`,
        headers: { [MCP_PROTOCOL_VERSION_HEADER]: version },
        params: {},
        status: 200,
        body: emptyTools,
      })),
      { name: "full modern", headers: modernHeaders, params: { _meta: meta }, status: 200, body: emptyTools },
      {
        name: "header/meta mismatch",
        headers: modernHeaders,
        params: { _meta: { ...meta, [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION } },
        status: 400,
        body: mismatch(`${MCP_PROTOCOL_VERSION_HEADER} must match params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`),
      },
      {
        name: "missing stateless header",
        headers: {},
        params: { _meta: meta },
        status: 400,
        body: mismatch(`${MCP_PROTOCOL_VERSION_HEADER} is required for MCP protocol version 2026-07-28.`),
      },
      {
        name: "missing version metadata",
        headers: modernHeaders,
        params: {},
        status: 400,
        body: invalid(`MCP protocol version 2026-07-28 requires params._meta.${MCP_META_PROTOCOL_VERSION_KEY}.`),
      },
      {
        name: "missing client info",
        headers: modernHeaders,
        params: { _meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28", [MCP_META_CLIENT_CAPABILITIES_KEY]: {} } },
        status: 400,
        body: invalid(
          `MCP protocol version 2026-07-28 requires client info in params._meta.${MCP_META_CLIENT_INFO_KEY} or ${MCP_CLIENT_NAME_HEADER}/${MCP_CLIENT_VERSION_HEADER}.`,
        ),
      },
      {
        name: "missing capabilities",
        headers: modernHeaders,
        params: {
          _meta: {
            [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28",
            [MCP_META_CLIENT_INFO_KEY]: meta[MCP_META_CLIENT_INFO_KEY],
          },
        },
        status: 400,
        body: invalid(
          `MCP protocol version 2026-07-28 requires client capabilities in params._meta.${MCP_META_CLIENT_CAPABILITIES_KEY} or ${MCP_CLIENT_CAPABILITIES_HEADER}.`,
        ),
      },
      {
        name: "client header fallback",
        headers: {
          ...modernHeaders,
          [MCP_CLIENT_NAME_HEADER]: "header-client",
          [MCP_CLIENT_VERSION_HEADER]: "1",
          [MCP_CLIENT_CAPABILITIES_HEADER]: "{}",
        },
        params: { _meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28" } },
        status: 200,
        body: emptyTools,
      },
      {
        name: "unsupported header",
        headers: { [MCP_PROTOCOL_VERSION_HEADER]: "1900-01-01" },
        params: {},
        status: 400,
        body: error(-32004, "Unsupported MCP protocol version '1900-01-01'.", {
          requestedVersion: "1900-01-01",
          supportedVersions: ["2025-06-18", "2025-11-25", "2026-07-28"],
        }),
      },
      {
        name: "unsupported metadata",
        headers: {},
        params: { _meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "1900-01-01" } },
        status: 400,
        body: error(-32004, "Unsupported MCP protocol version '1900-01-01'.", {
          requestedVersion: "1900-01-01",
          supportedVersions: ["2025-06-18", "2025-11-25", "2026-07-28"],
        }),
      },
      {
        name: "missing method header",
        headers: { [MCP_PROTOCOL_VERSION_HEADER]: "2026-07-28" },
        params: { _meta: meta },
        status: 400,
        body: mismatch("Mcp-Method is required for this MCP request."),
      },
      {
        name: "mismatched method header",
        headers: statelessHeaders("resources/list"),
        params: { _meta: meta },
        status: 400,
        body: mismatch("Mcp-Method must match the JSON-RPC method."),
      },
      {
        name: "legacy routing mismatch",
        headers: { [MCP_METHOD_HEADER]: "resources/list" },
        params: {},
        status: 400,
        body: mismatch("Mcp-Method must match the JSON-RPC method."),
      },
      ...[
        {
          name: "missing name",
          headers: statelessHeaders("tools/call"),
          message: "Mcp-Name is required for tools/call.",
        },
        {
          name: "mismatched name",
          headers: statelessHeaders("tools/call", "other"),
          message: "Mcp-Name must match the MCP request target.",
        },
        {
          name: "encoded name stays raw",
          headers: statelessHeaders("tools/call", "=?base64?dGFyZ2V0?="),
          message: "Mcp-Name must match the MCP request target.",
        },
      ].map((row) => ({
        ...row,
        method: "tools/call",
        params: { name: "target", _meta: meta },
        status: 400,
        body: mismatch(row.message),
      })),
      {
        name: "initialize naming modern",
        method: "initialize",
        headers: {},
        params: { protocolVersion: "2026-07-28" },
        status: 200,
        body: error(
          -32601,
          "initialize is not supported for MCP protocol version 2026-07-28. Use server/discover and per-request metadata.",
        ),
      },
      {
        name: "native discover shape",
        method: "server/discover",
        headers: statelessHeaders("server/discover"),
        params: { _meta: meta },
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: "request_1",
          result: {
            protocolVersions: ["2025-06-18", "2025-11-25", "2026-07-28"],
            serverInfo: { name: "chase-sets-platform", version: "0.1.0" },
            capabilities: { tools: {}, resources: {}, extensions: {} },
          },
        },
      },
    ];

    it.each(cases)("$name", async (row) => {
      const app = createMcpRoutes({ services: [] });
      const response = await app.request("/", {
        method: "POST",
        headers: row.headers,
        body: JSON.stringify(createRequest(row.method ?? "tools/list", row.params)),
      });
      expect(response.status).toBe(row.status);
      expect(await response.text()).toBe(JSON.stringify(row.body));
    });
  });

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
    const metadata = await response.clone().json();
    expect(metadata.scopes_supported).toHaveLength(17);
    expect(metadata.scopes_supported.filter((scope: string) => /checkout|order/.test(scope))).toEqual([
      "dev.ucp.shopping.checkout:manage",
      "dev.ucp.shopping.order:read",
    ]);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://marketplace.example/mcp",
      authorization_servers: ["https://marketplace.example"],
      scopes_supported: expect.arrayContaining([
        "catalog:read",
        "dev.ucp.shopping.checkout:manage",
        "dev.ucp.shopping.order:read",
        "listings:write",
        "payouts:request",
        "account:read",
      ]),
      bearer_methods_supported: ["header"],
    });
  });

  it("names the public request origin as the authorization server only through trusted forwarded headers", async () => {
    const app = createMcpOAuthProtectedResourceMetadataRoutes();
    const forwarded = {
      headers: { "x-forwarded-host": "marketplace.chasesets.test", "x-forwarded-proto": "https" },
    };

    try {
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "false");
      const untrusted = await app.request("http://platform-api.internal:8080/oauth-protected-resource", forwarded);
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
      const trusted = await app.request("http://platform-api.internal:8080/oauth-protected-resource", forwarded);

      await expect(untrusted.json()).resolves.toMatchObject({
        resource: "https://platform-api.internal:8080/mcp",
        authorization_servers: ["https://platform-api.internal:8080"],
      });
      await expect(trusted.json()).resolves.toMatchObject({
        resource: "https://marketplace.chasesets.test/mcp",
        authorization_servers: ["https://marketplace.chasesets.test"],
      });
    } finally {
      vi.unstubAllEnvs();
    }
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
      "authenticity.get-case-status",
      "checkout.add-cart-line",
      "checkout.cancel-session",
      "checkout.get-cart",
      "checkout.remove-cart-line",
      "checkout.select-saved-address",
      "checkout.update-cart-line",
      "discovery.get-chatgpt-product-feed",
      "discovery.get-item-detail",
      "discovery.search-market",
      "fulfillment.advance-shipment",
      "fulfillment.cancel-shipment",
      "fulfillment.dispatch-shipment",
      "fulfillment.get-tracking",
      "fulfillment.list-shipments",
      "fulfillment.purchase-label",
      "fulfillment.raise-shipment-exception",
      "fulfillment.void-label",
      "identity.get-account",
      "inventory.adjust-item",
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.get-mutation-attempt",
      "inventory.list-import-sources",
      "inventory.list-items",
      "marketplace.accept-offer",
      "marketplace.counter-offer",
      "marketplace.create-listing",
      "marketplace.decline-offer",
      "marketplace.get-reputation-summary",
      "marketplace.get-seller-attention-queue",
      "marketplace.get-seller-insights",
      "marketplace.list-listings",
      "marketplace.list-offers",
      "marketplace.list-reviews",
      "marketplace.publish-listing",
      "marketplace.submit-offer",
      "marketplace.unpublish-listing",
      "marketplace.update-listing-price",
      "marketplace.update-offer-price",
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

  it("lists the Seller Desk queue only when an OAuth grant carries every required seller read scope", async () => {
    const partialApp = createActorApp({
      ...actor,
      permissions: ["listings.view"],
      agentGrant: {
        grantId: "grant_partial_seller",
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        scopes: ["listings:read"],
        rolePermissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
      },
    });
    const fullApp = createActorApp({
      ...actor,
      permissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
      agentGrant: {
        grantId: "grant_full_seller",
        platformProfileUrl: "https://agent.example/.well-known/ucp",
        scopes: ["inventory:read", "listings:read", "offers:read", "fulfillment:read", "payouts:read"],
        rolePermissions: ["inventory.view", "listings.view", "offers.view", "fulfillment.view", "payouts.view"],
      },
    });

    const partial = (await (await partialApp.request("/tools")).json()) as { tools: Array<{ name: string }> };
    const full = (await (await fullApp.request("/tools")).json()) as { tools: Array<{ name: string }> };

    expect(partial.tools.map((tool) => tool.name)).not.toContain("marketplace.get-seller-attention-queue");
    expect(full.tools.map((tool) => tool.name)).toContain("marketplace.get-seller-attention-queue");
  });

  // Operator tools/list visibility depends only on the operator authority's role permissions, so a grant equal to
  // the union every available operator capability requires lists every available tool without hand-listing them.
  const operatorCapabilityPermissions = [
    ...new Set(
      [...flattenAvailableMcpTools(), ...flattenAvailableMcpResources()]
        .filter((capability) => capability.permissionBoundary.scope === "operator")
        .flatMap((capability) => capability.permissionBoundary.requiredPermissions),
    ),
  ].sort();

  function listToolsWithOperatorRolePermissions(rolePermissions: readonly string[]) {
    const app = createActorApp(
      { ...actor, roleKey: "platform-admin" },
      {
        operatorAuthority: async () => ({
          kind: "granted",
          membershipId: actor.membershipId,
          roleKey: "platform-admin",
          rolePermissions,
        }),
      },
    );
    return app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
      headers: {
        "Content-Type": "application/json",
        [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2025_11_25,
      },
    });
  }

  it("maps every cataloged tool risk model onto MCP standard annotations", async () => {
    const response = await listToolsWithOperatorRolePermissions(operatorCapabilityPermissions);
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

  it("drops exactly the operator tools whose permission the derived operator grant lacks", async () => {
    const availableTools = flattenAvailableMcpTools();
    const operatorTools = availableTools.filter((tool) => tool.permissionBoundary.scope === "operator");
    const operatorToolPermissions = [
      ...new Set(operatorTools.flatMap((tool) => tool.permissionBoundary.requiredPermissions)),
    ].sort();
    expect(operatorToolPermissions.length).toBeGreaterThan(0);

    for (const withheldPermission of operatorToolPermissions) {
      const response = await listToolsWithOperatorRolePermissions(
        operatorCapabilityPermissions.filter((permission) => permission !== withheldPermission),
      );
      const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
      const droppedToolNames = operatorTools
        .filter((tool) => tool.permissionBoundary.requiredPermissions.includes(withheldPermission))
        .map((tool) => tool.name);

      expect(response.status).toBe(200);
      expect(body.result.tools.map((tool) => tool.name).sort()).toEqual(
        availableTools
          .map((tool) => tool.name)
          .filter((name) => !droppedToolNames.includes(name))
          .sort(),
      );
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
          uriTemplate: "chase-sets://authenticity/cases/{caseId}",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: ["authenticity.view"],
          }),
        }),
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
                "inventory.account-defaulted-summary": vi.fn<McpToolHandler>(),
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

  it("publishes payment-method setup dryRun as an unsupported closed boolean and validates it before handlers", async () => {
    const handler = vi.fn(async () => ({ accepted: true }));
    const app = createActorApp(
      { ...actor, permissions: [...actor.permissions, "orders.manage"] },
      { toolHandlers: { "payments.start-payment-method-setup": handler } },
    );
    const callSetup = async (extraArguments: Readonly<Record<string, unknown>>) => {
      const response = await app.request("/", {
        method: "POST",
        body: JSON.stringify(
          createRequest("tools/call", {
            name: "payments.start-payment-method-setup",
            arguments: {
              accountId: "account_1",
              returnUrl: "https://app.chasesets.test/account/payment-methods",
              idempotencyKey: "3f2b8c1e-6a4d-4e9b-b7c2-1d0e5f6a7b81",
              confirmationText: "Start Payment Method Setup.",
              ...extraArguments,
            },
            confirmation: { confirmed: true, text: "Start Payment Method Setup." },
          }),
        ),
      });
      return response.json();
    };

    const listResponse = await app.request("/", {
      method: "POST",
      body: JSON.stringify(createRequest("tools/list")),
    });
    const listed = (
      (await listResponse.json()) as {
        result: {
          tools: Array<{
            name: string;
            inputSchema: { additionalProperties?: boolean; properties: Record<string, { type?: unknown }> };
            annotations: { dryRunSupported?: boolean };
          }>;
        };
      }
    ).result.tools.find((tool) => tool.name === "payments.start-payment-method-setup");
    expect(listed?.annotations.dryRunSupported).toBe(false);
    expect(listed?.inputSchema.additionalProperties).toBe(false);
    expect(listed?.inputSchema.properties.dryRun?.type).toBe("boolean");

    await expect(callSetup({ dryRun: "true" })).resolves.toEqual(
      toolErrorResponse(
        "request_1",
        "Invalid MCP tool arguments. dryRun: Expected boolean. Expected boolean. Actual string.",
      ),
    );
    await expect(callSetup({ unexpectedField: true })).resolves.toEqual(
      toolErrorResponse("request_1", "Invalid MCP tool arguments. unexpectedField: Unexpected field."),
    );
    expect(handler).not.toHaveBeenCalled();

    await expect(callSetup({ dryRun: false })).resolves.toEqual(toolSuccessResponse("request_1", { accepted: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: expect.objectContaining({ dryRun: false }) }),
    );
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
          platformProfileUrl: "https://agent.example/.well-known/ucp",
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
            requestHash: "a".repeat(64),
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
          platformProfileUrl: "https://agent.example/.well-known/ucp",
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
          platformProfileUrl: "https://agent.example/.well-known/ucp",
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
        "settlement.request-payout": vi.fn<McpToolHandler>(),
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

  it("issue-7171-key-hash-and-mcp-boundary sends every owner-authoritative replay to Fulfillment without an outer reservation", async () => {
    const reserve = vi.fn(async () => {
      throw new Error("owner-authoritative tools must not reserve platform idempotency");
    });
    const handler = vi.fn(async (_input: McpToolHandlerInput) => ({
      shipmentId: "shp_1",
      version: 7,
      status: "dispatched",
    }));
    const app = createActorApp(
      { ...actor, permissions: [...actor.permissions, "fulfillment.manage"] },
      {
        idempotencyStore: {
          reserve,
          complete: vi.fn(async () => undefined),
          abandon: vi.fn(async () => undefined),
        } as never,
        toolHandlers: { "fulfillment.dispatch-shipment": handler },
      },
    );
    const idempotencyKey = "d7cc6b42-1aeb-4d9f-a62e-8f57225451d2";
    const request = createRequest("tools/call", {
      name: "fulfillment.dispatch-shipment",
      arguments: {
        accountId: "account_1",
        shipmentId: "shp_1",
        reason: "Carrier accepted custody.",
        idempotencyKey,
        confirmationText: "Dispatch Shipment.",
      },
      confirmation: { confirmed: true, text: "Dispatch Shipment." },
    });

    const first = await app.request("/", { method: "POST", body: JSON.stringify(request) });
    const replay = await app.request("/", { method: "POST", body: JSON.stringify(request) });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(reserve).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.every(([input]) => input.arguments.idempotencyKey === idempotencyKey)).toBe(true);
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
        'No runtime handler is registered for MCP tool \'settlement.request-payout\'. Redacted arguments: {"accountId":"account_1","amount":"[redacted]","reason":"[redacted]","idempotencyKey":"[redacted]","confirmationText":"[redacted]"}',
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

const OPERATOR_DENIAL = "This MCP capability is not available to the authenticated actor.";

const grantedPlatformAdmin = {
  kind: "granted",
  membershipId: "mem_op",
  roleKey: "platform-admin",
  rolePermissions: ["catalog.manage", "catalog.view", "insights-dashboards.view", "listings.view"],
} as const satisfies OperatorAuthorityDecision;

const operatorMatrixServices: readonly McpServiceDescriptor[] = [
  {
    serviceId: "platform-operations",
    serviceName: "Platform Operations",
    kind: "bounded-context",
    owner: "bounded-contexts/platform-operations",
    serviceBoundary: "Synthetic operator and commerce capabilities for the operator predicate matrix.",
    tools: [
      {
        name: "platform-operations.inspect-catalog-plan",
        title: "Inspect Catalog Plan",
        description: "Read-risk operator tool gated on a manage permission.",
        availability: "available",
        serviceId: "platform-operations",
        risk: "read",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        permissionBoundary: {
          scope: "operator",
          requiredPermissions: ["catalog.manage"],
          requiredScopes: [],
          accountScoped: false,
          auditPrincipal: "actor",
        },
        guardrails: {
          confirmation: { required: false },
          idempotencyKey: "not-applicable",
          dryRunSupported: false,
          notes: [],
        },
        audit: {
          eventName: "mcp.platform-operations.inspect-catalog-plan",
          targetType: "catalog-plan",
          sensitiveInputFields: [],
        },
        expectedUsage: ["Synthetic operator read."],
      },
      {
        name: "platform-operations.apply-catalog-plan",
        title: "Apply Catalog Plan",
        description: "Write-risk operator tool bound to its plan fingerprint input.",
        availability: "available",
        serviceId: "platform-operations",
        risk: "sensitive",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["planFingerprint", "idempotencyKey"],
          properties: {
            planFingerprint: { type: "string", description: "Reviewed plan fingerprint." },
            idempotencyKey: { type: "string", description: "Idempotency key." },
          },
        },
        permissionBoundary: {
          scope: "operator",
          requiredPermissions: ["catalog.manage"],
          requiredScopes: [],
          accountScoped: false,
          auditPrincipal: "actor",
        },
        guardrails: {
          confirmation: { required: true, prompt: "Confirm the plan fingerprint.", matchInputValue: "planFingerprint" },
          idempotencyKey: "required",
          idempotencyAuthority: "platform",
          dryRunSupported: false,
          notes: [],
        },
        audit: {
          eventName: "mcp.platform-operations.apply-catalog-plan",
          targetType: "catalog-plan",
          sensitiveInputFields: [],
        },
        expectedUsage: ["Synthetic operator write."],
      },
      {
        name: "platform-operations.list-own-listings",
        title: "List Own Listings",
        description: "Commerce read tool gated on a commerce scope.",
        availability: "available",
        serviceId: "platform-operations",
        risk: "read",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        permissionBoundary: {
          scope: "account",
          requiredPermissions: ["listings.view"],
          requiredScopes: ["listings:read"],
          accountScoped: true,
          auditPrincipal: "actor",
        },
        guardrails: {
          confirmation: { required: false },
          idempotencyKey: "not-applicable",
          dryRunSupported: false,
          notes: [],
        },
        audit: {
          eventName: "mcp.platform-operations.list-own-listings",
          targetType: "listing",
          sensitiveInputFields: [],
        },
        expectedUsage: ["Synthetic commerce read."],
      },
    ],
    resources: [
      {
        uriTemplate: "chase-sets://platform-operations/catalog-plans/summary",
        title: "Catalog Plan Summary",
        description: "Operator resource.",
        availability: "available",
        serviceId: "platform-operations",
        permissionBoundary: {
          scope: "operator",
          requiredPermissions: ["insights-dashboards.view"],
          requiredScopes: [],
          accountScoped: false,
          auditPrincipal: "actor",
        },
        expectedUsage: ["Synthetic operator resource."],
      },
    ],
  },
];

function operatorGrant(scopes: readonly AgentOAuthScope[]) {
  return {
    grantId: "lpa_operator",
    platformProfileUrl: "https://agent.example/.well-known/ucp",
    scopes,
    rolePermissions: [...grantedPlatformAdmin.rolePermissions],
  };
}

type OperatorMatrixRow = Readonly<{
  label: string;
  actor: ResolvedActor;
  authority: OperatorAuthorityDecision;
  operatorRead: boolean;
  operatorWrite: boolean;
  commerce: boolean;
}>;

const platformAdminSession: ResolvedActor = {
  ...actor,
  userId: "usr_op",
  accountId: "acc_op",
  membershipId: "mem_op",
  roleKey: "platform-admin",
  permissions: ["listings.view"],
};
// Every self-registered owner holds catalog.manage: the predicate must not read actor.permissions.
const ownerSession: ResolvedActor = {
  ...platformAdminSession,
  roleKey: "owner",
  permissions: ["catalog.manage", "catalog.view", "insights-dashboards.view", "listings.view"],
};
const grantActor = (scopes: readonly AgentOAuthScope[], permissions: readonly string[] = []): ResolvedActor => ({
  ...platformAdminSession,
  sessionId: "ucp:lpa_operator",
  permissions,
  agentGrant: operatorGrant(scopes),
});
const demoted = { kind: "denied", reason: "not-platform-admin" } as const satisfies OperatorAuthorityDecision;

const operatorMatrix: readonly OperatorMatrixRow[] = [
  {
    label: "session, platform-admin",
    actor: platformAdminSession,
    authority: grantedPlatformAdmin,
    operatorRead: true,
    operatorWrite: true,
    commerce: true,
  },
  {
    label: "session, owner holding catalog.manage",
    actor: ownerSession,
    authority: demoted,
    operatorRead: false,
    operatorWrite: false,
    commerce: true,
  },
  {
    label: "grant with every commerce scope and no operations scope, platform-admin",
    actor: grantActor(["catalog:read", "listings:read", "listings:write"], ["catalog.view", "listings.view"]),
    authority: grantedPlatformAdmin,
    operatorRead: false,
    operatorWrite: false,
    commerce: true,
  },
  {
    label: "grant operations:read, platform-admin",
    actor: grantActor(["operations:read"]),
    authority: grantedPlatformAdmin,
    operatorRead: true,
    operatorWrite: false,
    commerce: false,
  },
  {
    label: "grant operations:write, platform-admin",
    actor: grantActor(["operations:write"]),
    authority: grantedPlatformAdmin,
    operatorRead: true,
    operatorWrite: true,
    commerce: false,
  },
  {
    label: "mixed commerce and operations:write grant, platform-admin",
    actor: grantActor(["listings:read", "operations:write"], ["listings.view"]),
    authority: grantedPlatformAdmin,
    operatorRead: true,
    operatorWrite: true,
    commerce: true,
  },
  {
    label: "grant operations:write, role no longer platform-admin",
    actor: grantActor(["listings:read", "operations:write"], ["listings.view"]),
    authority: demoted,
    operatorRead: false,
    operatorWrite: false,
    commerce: true,
  },
];

async function postMcp(app: Hono<{ Variables: { actor: ResolvedActor } }>, method: string, params?: unknown) {
  const response = await app.request("/", { method: "POST", body: JSON.stringify(createRequest(method, params)) });
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("operator predicate matrix", () => {
  it.each(operatorMatrix)("$label", async (row) => {
    const authority = vi.fn(async () => row.authority);
    const toolHandler = vi.fn(async () => ({ ok: true }));
    const resourceHandler = vi.fn(async () => ({ ok: true }));
    const audit = vi.fn();
    const reserve = vi.fn(async () => ({ outcome: "reserved" as const, record: { key: "k", requestHash: "h" } }));
    const app = createActorApp(row.actor, {
      services: operatorMatrixServices,
      operatorAuthority: authority,
      audit,
      idempotencyStore: {
        reserve,
        complete: vi.fn(async () => undefined),
        abandon: vi.fn(async () => undefined),
      } as never,
      toolHandlers: {
        "platform-operations.inspect-catalog-plan": toolHandler,
        "platform-operations.apply-catalog-plan": toolHandler,
        "platform-operations.list-own-listings": toolHandler,
      },
      resourceHandlers: { "chase-sets://platform-operations/catalog-plans/summary": resourceHandler },
    });

    const tools = await postMcp(app, "tools/list");
    const listedTools = (tools.body.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(authority.mock.calls.length).toBeLessThanOrEqual(1);
    expect(listedTools.includes("platform-operations.inspect-catalog-plan")).toBe(row.operatorRead);
    expect(listedTools.includes("platform-operations.apply-catalog-plan")).toBe(row.operatorWrite);
    expect(listedTools.includes("platform-operations.list-own-listings")).toBe(row.commerce);

    const resources = await postMcp(app, "resources/list");
    const listedResources = (resources.body.result as { resources: Array<{ uriTemplate: string }> }).resources.map(
      (resource) => resource.uriTemplate,
    );
    expect(listedResources.includes("chase-sets://platform-operations/catalog-plans/summary")).toBe(row.operatorRead);

    const read = await postMcp(app, "tools/call", { name: "platform-operations.inspect-catalog-plan", arguments: {} });
    const write = await postMcp(app, "tools/call", {
      name: "platform-operations.apply-catalog-plan",
      arguments: { planFingerprint: "plan-7f3a", idempotencyKey: "idem_matrix" },
      confirmation: { confirmed: true, text: "plan-7f3a" },
    });
    const resource = await postMcp(app, "resources/read", {
      uri: "chase-sets://platform-operations/catalog-plans/summary",
    });

    for (const [result, admitted] of [
      [read, row.operatorRead],
      [write, row.operatorWrite],
      [resource, row.operatorRead],
    ] as const) {
      // Rule 2b: a refusal is a plain JSON-RPC denial, never an OAuth scope challenge naming operator scopes.
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("WWW-Authenticate")).toBeNull();
      expect(result.text).not.toContain("operations:");
      expect(result.text.includes(OPERATOR_DENIAL)).toBe(!admitted);
    }
    expect(toolHandler).toHaveBeenCalledTimes(Number(row.operatorRead) + Number(row.operatorWrite));
    expect(resourceHandler).toHaveBeenCalledTimes(Number(row.operatorRead));
    expect(reserve).toHaveBeenCalledTimes(Number(row.operatorWrite));
    const deniedOperatorAudits = audit.mock.calls.filter(
      ([record]) => (record as McpAuditRecord).outcome === "denied",
    ).length;
    expect(deniedOperatorAudits).toBe(Number(!row.operatorRead) * 2 + Number(!row.operatorWrite));
  });

  it("rule 2a: the registry rejects an operator capability that declares required scopes", () => {
    const [service] = operatorMatrixServices;
    const scoped = {
      ...service!,
      tools: service!.tools.map((tool) =>
        tool.permissionBoundary.scope === "operator"
          ? { ...tool, permissionBoundary: { ...tool.permissionBoundary, requiredScopes: ["catalog:read" as const] } }
          : tool,
      ),
    };
    expect(validateMcpServiceCatalog([scoped], ["platform-operations"])).toEqual([
      "platform-operations.inspect-catalog-plan is an operator capability and must declare requiredScopes: [].",
      "platform-operations.apply-catalog-plan is an operator capability and must declare requiredScopes: [].",
    ]);
  });

  it("hides operator capabilities from every actor when no operator authority is composed", async () => {
    const app = createActorApp(platformAdminSession, { services: operatorMatrixServices });
    const tools = await postMcp(app, "tools/list");
    expect((tools.body.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual([
      "platform-operations.list-own-listings",
    ]);
  });

  it("filters operator capabilities on the GET discovery routes with the same predicate", async () => {
    const authority = vi.fn(async () => demoted);
    const app = createActorApp(ownerSession, { services: operatorMatrixServices, operatorAuthority: authority });
    const tools = (await (await app.request("/tools")).json()) as { tools: Array<{ name: string }> };
    const resources = (await (await app.request("/resources")).json()) as { resources: unknown[] };
    const services = (await (await app.request("/services")).json()) as { services: McpServiceDescriptor[] };
    expect(tools.tools.map((tool) => tool.name)).toEqual(["platform-operations.list-own-listings"]);
    expect(resources.resources).toEqual([]);
    expect(JSON.stringify(services.services)).not.toContain("catalog-plan");
  });
});

describe("operator invocation context", () => {
  const offerEconomicsTool = "platform-operations.get-offer-economics-summary";
  const offerEconomicsResource = "chase-sets://platform-operations/offer-economics/summary";
  const operatorWriteGrant = grantActor(["operations:write"]);

  it("runs the offer-economics tool and resource for an operations:write grant with Identity role permissions", async () => {
    const seen: ResolvedActor[] = [];
    const app = createActorApp(operatorWriteGrant, {
      operatorAuthority: async () => grantedPlatformAdmin,
      toolHandlers: {
        [offerEconomicsTool]: vi.fn(async ({ actor: handlerActor }) => {
          seen.push(handlerActor!);
          return { snapshot: {} };
        }),
      },
      resourceHandlers: {
        [offerEconomicsResource]: vi.fn(async ({ actor: handlerActor }) => {
          seen.push(handlerActor!);
          return { snapshot: {} };
        }),
      },
    });

    const tool = await postMcp(app, "tools/call", { name: offerEconomicsTool, arguments: {} });
    const resource = await postMcp(app, "resources/read", { uri: offerEconomicsResource });

    expect(tool.body).toEqual(toolSuccessResponse("request_1", { snapshot: {} }));
    expect(resource.body).toMatchObject({ result: { contents: [{ uri: offerEconomicsResource }] } });
    expect(seen).toHaveLength(2);
    for (const handlerActor of seen) {
      expect(handlerActor).toEqual({
        ...operatorWriteGrant,
        roleKey: "platform-admin",
        permissions: grantedPlatformAdmin.rolePermissions,
      });
      expect(handlerActor.agentGrant).toEqual(operatorWriteGrant.agentGrant);
    }
    // The widened actor is per call: the request actor itself is never mutated or reused.
    expect(operatorWriteGrant.permissions).toEqual([]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("refuses the next call after demotion even though the first call succeeded", async () => {
    const decisions: OperatorAuthorityDecision[] = [grantedPlatformAdmin, demoted];
    const handler = vi.fn(async () => ({ snapshot: {} }));
    const app = createActorApp(operatorWriteGrant, {
      operatorAuthority: async () => decisions.shift()!,
      toolHandlers: { [offerEconomicsTool]: handler },
    });

    expect((await postMcp(app, "tools/call", { name: offerEconomicsTool, arguments: {} })).text).not.toContain(
      OPERATOR_DENIAL,
    );
    expect((await postMcp(app, "tools/call", { name: offerEconomicsTool, arguments: {} })).text).toContain(
      OPERATOR_DENIAL,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "demotion", authority: async () => demoted, reason: "operator-authority-not-platform-admin" },
    {
      label: "revocation",
      authority: async () => ({ kind: "denied", reason: "inactive" }) as const,
      reason: "operator-authority-inactive",
    },
    {
      label: "a mismatched membership",
      authority: async () => ({ kind: "denied", reason: "membership-mismatch" }) as const,
      reason: "operator-authority-membership-mismatch",
    },
    {
      label: "a throwing authority",
      authority: async () => {
        throw new Error("event store unavailable");
      },
      reason: "operator-authority-authority-unavailable",
    },
    { label: "a missing port", authority: undefined, reason: "operator-authority-authority-unavailable" },
  ])("$label blocks before idempotency and the handler with an awaited denied audit", async ({ authority, reason }) => {
    const auditDone = createDeferred();
    const auditRecords: McpAuditRecord[] = [];
    const reserve = vi.fn();
    const handler = vi.fn();
    const app = createActorApp(operatorWriteGrant, {
      services: operatorMatrixServices,
      operatorAuthority: authority as OperatorAuthority | undefined,
      idempotencyStore: { reserve, complete: vi.fn(), abandon: vi.fn() } as never,
      toolHandlers: { "platform-operations.apply-catalog-plan": handler },
      resourceHandlers: { "chase-sets://platform-operations/catalog-plans/summary": handler },
      audit: async (record) => {
        auditRecords.push(record);
        await auditDone.promise;
      },
    });

    let settled = false;
    const pending = postMcp(app, "tools/call", {
      name: "platform-operations.apply-catalog-plan",
      arguments: { planFingerprint: "plan-7f3a", idempotencyKey: "idem_denied" },
      confirmation: { confirmed: true, text: "plan-7f3a" },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(auditRecords).toHaveLength(1));
    expect(settled).toBe(false);
    auditDone.resolve();
    const result = await pending;

    expect(result.body).toEqual(toolErrorResponse("request_1", OPERATOR_DENIAL));
    expect(reserve).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(auditRecords).toEqual([
      expect.objectContaining({
        outcome: "denied",
        method: "tools/call",
        toolName: "platform-operations.apply-catalog-plan",
        actorId: "usr_op",
        agentGrantId: "lpa_operator",
        reason,
      }),
    ]);

    const resource = await postMcp(app, "resources/read", {
      uri: "chase-sets://platform-operations/catalog-plans/summary",
    });
    expect(resource.body).toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      error: { code: -32001, message: OPERATOR_DENIAL },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(auditRecords.at(-1)).toMatchObject({ outcome: "denied", method: "resources/read", reason });
  });

  it("evaluates the operator authority at most once per request", async () => {
    const authority = vi.fn(async () => grantedPlatformAdmin);
    const app = createActorApp(platformAdminSession, {
      services: operatorMatrixServices,
      operatorAuthority: authority,
    });
    await postMcp(app, "tools/list");
    expect(authority).toHaveBeenCalledTimes(1);
    await postMcp(app, "resources/list");
    expect(authority).toHaveBeenCalledTimes(2);
  });

  it("refuses an input-bound operator write whose confirmation text differs from the bound input", async () => {
    const handler = vi.fn();
    const app = createActorApp(platformAdminSession, {
      services: operatorMatrixServices,
      operatorAuthority: async () => grantedPlatformAdmin,
      toolHandlers: { "platform-operations.apply-catalog-plan": handler },
    });
    const result = await postMcp(app, "tools/call", {
      name: "platform-operations.apply-catalog-plan",
      arguments: { planFingerprint: "plan-7f3a", idempotencyKey: "idem_mismatch" },
      confirmation: { confirmed: true, text: "Apply Catalog Plan." },
    });
    expect(result.body).toEqual(
      toolErrorResponse("request_1", "Confirmation text must exactly match the 'planFingerprint' input value."),
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("operator scopes are never advertised", () => {
  it("keeps operations:* out of protected-resource metadata and the default scope list", async () => {
    const app = new Hono().route("/.well-known", createMcpOAuthProtectedResourceMetadataRoutes());
    const metadata = (await (await app.request(MCP_OAUTH_PROTECTED_RESOURCE_METADATA_PATH)).json()) as {
      scopes_supported: string[];
    };
    expect(metadata.scopes_supported).toHaveLength(17);
    expect(JSON.stringify(metadata)).not.toContain("operations:");
    expect(MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED).toEqual(AGENT_OAUTH_COMMERCE_SCOPES);
    expect(MCP_OAUTH_DEFAULT_SCOPES_SUPPORTED.some(isAgentOAuthOperatorScope)).toBe(false);
  });
});
