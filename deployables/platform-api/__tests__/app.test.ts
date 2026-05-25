import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { HealthProjectionReplaySummary } from "@chase-sets/platform-runtime/health";
import { createUcpEnvelope } from "@chase-sets/ucp";
import { buildPlatformApiApp } from "../src/app";

function signedUcpHeaders(body: string) {
  return {
    "Content-Type": "application/json",
    "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    "Idempotency-Key": "idem_platform_test",
    "Signature-Input": 'sig1=("@method" "@path" "content-digest");created=1778940000',
    Signature: "sig1=:placeholder:",
    "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
  };
}

describe("platform api app", () => {
  it("mounts the health route", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        getProjectionReplay: vi.fn(
          async () =>
            ({
              status: "ok",
              totalGroups: 0,
              requiredGroups: 0,
              initializedGroups: 0,
              caughtUpGroups: 0,
              behindGroups: 0,
              staleGroups: 0,
              runningGroups: 0,
              errorGroups: 0,
              contexts: [],
            }) satisfies HealthProjectionReplaySummary,
        ),
      },
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
  });

  it("keeps projection replay out of readiness", async () => {
    const getProjectionReplay = vi.fn(async () => {
      throw new Error("projection replay unavailable");
    });
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        getProjectionReplay,
        readinessChecks: [
          {
            name: "control.database",
            check: async () => undefined,
          },
        ],
      },
    );

    const response = await app.request("/health/ready");

    expect(response.status).toBe(200);
    expect(getProjectionReplay).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checks: [{ name: "control.database", status: "ok" }],
    });
  });

  it("mounts API-prefixed health for ingress smoke checks", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        readinessChecks: [
          {
            name: "control.database",
            check: async () => undefined,
          },
        ],
      },
    );

    const response = await app.request("/api/health/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      checks: [{ name: "control.database", status: "ok" }],
    });
  });

  it("requires platform operations permission for projection operations", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "catalog-admin",
          permissions: ["catalog.view"],
        })),
      },
    );

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(403);
  });

  it("mounts projection operations under the same-origin API prefix", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "platform-admin",
          permissions: ["security.manage"],
        })),
      },
    );

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        status: "ok",
        totalGroups: 0,
      },
      projectionGroups: [],
      blockedProjections: [],
      projectionStatusSource: "runtime-memory",
      workers: [],
      runners: [],
    });
  });

  it("serves projection operations from worker snapshots without live refresh", async () => {
    const refreshStatus = vi.fn(async () => {
      throw new Error("Projection operations should not live refresh by default.");
    });
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [
          {
            targetContextName: "inventory",
            projectionName: "inventory-catalog-item-projection",
            refreshStatus,
            getStatus: () => ({
              targetContextName: "inventory",
              projectionName: "inventory-catalog-item-projection",
              projectionRevision: 1,
              storedProjectionRevision: 1,
              revisionStale: false,
              sourceContextNames: ["catalog"],
              ownedTables: ["inventory_catalog_items"],
              requiredDuringBootstrap: true,
              initialized: false,
              caughtUp: false,
              state: "behind",
              lastError: null,
              outstandingEventCount: "10",
              blockedStreamCount: 0,
              poisonEventCount: 0,
              updatedAt: "2026-05-25T00:00:00.000Z",
              subscriptions: [],
            }),
          },
        ],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "platform-admin",
          permissions: ["security.manage"],
        })),
        controlPlane: {
          bootstrap: vi.fn(async () => undefined),
          acquireLease: vi.fn(async () => null),
          renewLease: vi.fn(async () => false),
          releaseLease: vi.fn(async () => undefined),
          heartbeatWorker: vi.fn(async () => undefined),
          recordRunnerStatus: vi.fn(async () => undefined),
          recordProjectionStatusSnapshot: vi.fn(async () => undefined),
          listProjectionStatusSnapshots: vi.fn(async () => [
            {
              projection_key: "inventory.inventory-catalog-item-projection",
              target_context_name: "inventory",
              projection_name: "inventory-catalog-item-projection",
              runner_name: "inventory.inventory-catalog-item-projection",
              owner_id: "worker-a",
              status: {
                targetContextName: "inventory",
                projectionName: "inventory-catalog-item-projection",
                projectionRevision: 1,
                storedProjectionRevision: 1,
                revisionStale: false,
                sourceContextNames: ["catalog"],
                ownedTables: ["inventory_catalog_items"],
                requiredDuringBootstrap: true,
                initialized: true,
                caughtUp: false,
                state: "running",
                lastError: null,
                outstandingEventCount: "42",
                blockedStreamCount: 0,
                poisonEventCount: 0,
                updatedAt: "2026-05-25T00:00:00.000Z",
                subscriptions: [],
              },
              updated_at: new Date().toISOString(),
            },
          ]),
          listWorkerHeartbeats: vi.fn(async () => []),
          listRunnerStatuses: vi.fn(async () => []),
          listLeases: vi.fn(async () => []),
        },
      },
    );

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    expect(refreshStatus).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      projectionStatusSource: "worker-snapshot",
      projectionGroups: [
        {
          targetContextName: "inventory",
          projectionName: "inventory-catalog-item-projection",
          state: "running",
          outstandingEventCount: "42",
          snapshot: {
            runnerName: "inventory.inventory-catalog-item-projection",
            ownerId: "worker-a",
          },
        },
      ],
    });
  });

  it("mounts the internal realtime status route", async () => {
    const discoveryModule = {
      contextName: "discovery",
      apiMounts: [],
      buildApis: () => [],
      projectors: () => [],
    };
    const catalogModule = {
      ...discoveryModule,
      contextName: "catalog",
    };
    const realtimePool = {
      query: async (sql: string) => {
        if (sql.includes("MAX(outbox_id)")) {
          return { rows: [{ head: "5" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "catalog",
            module: catalogModule,
            services: {},
            pool: realtimePool,
            projectors: [],
          },
          {
            contextName: "discovery",
            module: discoveryModule,
            services: {},
            pool: realtimePool,
            projectors: [],
          },
        ],
        mountedModules: [
          { module: catalogModule, services: {} },
          { module: discoveryModule, services: {} },
        ],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        realtimeActiveConnectionCount: () => 3,
        realtimeRouteTuning: {
          batchSize: 25,
        },
      },
    );

    const response = await app.request("/internal/realtime/status");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      activeConnectionCount: 3,
      routeTuning: { batchSize: 25 },
    });
    expect(body.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contextName: "catalog", head: "5" }),
        expect.objectContaining({ contextName: "discovery", head: "5" }),
      ]),
    );
  });

  it("mounts the MCP JSON-RPC bridge with platform actor resolution", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "manager",
          permissions: ["inventory.view"],
        })),
        mcp: {
          toolHandlers: {
            "inventory.list-items": vi.fn(async ({ actor }) => ({
              accountId: actor?.accountId,
              items: [],
            })),
          },
        },
      },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request_1",
        method: "tools/call",
        params: {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      result: {
        content: [
          {
            type: "json",
            json: {
              accountId: "account_1",
              items: [],
            },
          },
        ],
      },
    });
  });

  it("mounts the UCP profile, REST, and MCP surfaces", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        ucp: {
          restHandlers: {
            search_catalog: vi.fn(async () => createUcpEnvelope("ok", { products: [] })),
          },
        },
      },
    );

    const profileResponse = await app.request("https://marketplace.example/.well-known/ucp");
    expect(profileResponse.status).toBe(200);
    await expect(profileResponse.json()).resolves.toMatchObject({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            { transport: "rest", endpoint: "https://marketplace.example/ucp/v1" },
            { transport: "mcp", endpoint: "https://marketplace.example/ucp/mcp" },
          ],
        },
      },
    });

    const restResponse = await app.request("/ucp/v1/catalog/search", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(restResponse.status).toBe(200);
    await expect(restResponse.json()).resolves.toMatchObject({ products: [] });

    const mcpResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
    });
    expect(mcpResponse.status).toBe(200);
    await expect(mcpResponse.json()).resolves.toMatchObject({
      result: {
        tools: [
          { name: "search_catalog" },
          { name: "lookup_catalog" },
          { name: "get_product" },
          { name: "create_checkout" },
          { name: "get_checkout" },
          { name: "update_checkout" },
          { name: "complete_checkout" },
          { name: "cancel_checkout" },
          { name: "get_order" },
        ],
      },
    });
  });

  it("wires Discovery-owned UCP catalog search handlers from runtime services", async () => {
    const searchItems = vi.fn(async () => ({
      items: [
        {
          catalog_item_id: "cat_1",
          slug: "charizard-cat_1",
          language_code: "en",
          title_i18n: {},
          title: "Charizard",
          subtitle_i18n: {},
          subtitle: null,
          description_i18n: {},
          description: "A card.",
          blueprint_id: null,
          blueprint_name: null,
          status: "active",
          category_names: [],
          category_slugs: [],
          tags: [],
          image_urls: [],
          product_asset_sets: [],
          image_fallback: null,
          market_summary: null,
          updated_at: "2026-05-16T00:00:00.000Z",
        },
      ],
      total: 1,
      nextCursor: null,
    }));
    const app = buildPlatformApiApp({
      mountedContexts: [],
      mountedModules: [],
      services: {
        auth: {},
        identity: {},
        discovery: {
          items: {
            search: {
              searchItems,
              rebuildSearchIndex: vi.fn(),
              projectors: [],
            },
            detail: {
              getItemDetail: vi.fn(),
              projectors: [],
            },
            market: {},
            projectors: [],
          },
        },
      },
      projectors: [],
      projectionGroups: [],
      subscriptionRunners: [],
    } as never);

    const response = await app.request("/ucp/v1/catalog/search", {
      method: "POST",
      body: JSON.stringify({ query: "charizard" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(searchItems).toHaveBeenCalledWith(expect.objectContaining({ search: "charizard" }));
    await expect(response.json()).resolves.toMatchObject({
      ucp: { status: "ok" },
      products: [{ id: "cat_1", title: "Charizard" }],
    });
  });

  it("wires Checkout-owned UCP checkout handlers with platform actor context", async () => {
    const createBuyNow = vi.fn(async () => ({ sessionId: "chk_1" as never }));
    const getSession = vi.fn(async () => ({
      session_id: "chk_1",
      buyer_account_id: "acc_buyer",
      source_type: "buy-now",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      shipping_option: "standard",
      shipping_address: null,
      lines: [],
      order_ids: [],
      payment_id: null,
      submitted_offer_id: null,
      created_at: "2026-05-16T00:00:00.000Z",
      updated_at: "2026-05-16T00:00:00.000Z",
    }));
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
          checkout: {
            sessions: {
              commandHandler: vi.fn(),
              createFromCart: vi.fn(),
              createBuyNow,
              createOfferIntent: vi.fn(),
              selectShippingOption: vi.fn(),
              selectOptimizationGoal: vi.fn(),
              recordFulfillmentPreview: vi.fn(),
              setShippingAddress: vi.fn(),
              recordOrdersCreated: vi.fn(),
              recordPaymentStarted: vi.fn(),
              recordOfferSubmitted: vi.fn(),
              getSession,
              projectors: [],
            },
          },
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "acc_buyer",
          membershipId: "member_1",
          roleKey: "buyer",
          permissions: ["orders.view", "orders.manage"],
        })),
      },
    );
    const body = JSON.stringify({
      source: {
        type: "buy-now",
        listing_id: "lst_1",
        catalog_item_id: "cat_1",
        product_id: "cat_1::form:raw",
        title: "Charizard",
        quantity: 1,
      },
    });

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedUcpHeaders(body),
    });

    expect(response.status).toBe(200);
    expect(createBuyNow).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_buyer" }),
      expect.objectContaining({
        audit: expect.objectContaining({ forAccountId: "acc_buyer" }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ucp: { status: "ok" },
      checkout: { id: "chk_1" },
    });
  });

  it("keeps provider webhook mounts unauthenticated and preserves raw request bodies", async () => {
    const resolveActor = vi.fn(async () => {
      throw new Error("Provider webhooks must not require marketplace auth.");
    });
    const rawBody = '{\n  "type": "payout.failed"\n}';
    let observedActor: unknown = "unset";
    let observedRawBody = "";

    const providerRouter = new Hono();
    providerRouter.post("/money-movement/webhooks", async (c) => {
      observedActor = (c as unknown as { get(key: "actor"): unknown }).get("actor");
      observedRawBody = await c.req.raw.text();

      return c.json({ received: true });
    });

    const module = {
      contextName: "settlement",
      apiMounts: [
        {
          mountPath: "/api/settlement/provider",
          kind: "additional",
          requiresAuth: false,
          drainProjectorsOnWrite: false,
        },
      ],
      buildApis: () => [providerRouter],
      projectors: () => [],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "settlement",
            module,
            services: {},
            pool: {},
            projectors: [],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor,
      },
    );

    const response = await app.request("/api/settlement/provider/money-movement/webhooks", {
      method: "POST",
      body: rawBody,
      headers: {
        Authorization: "Bearer not-used-for-provider-webhooks",
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    expect(resolveActor).not.toHaveBeenCalled();
    expect(observedActor).toBeUndefined();
    expect(observedRawBody).toBe(rawBody);
  });

  it("drains projectors after writes only when write-drain consistency is explicitly enabled", async () => {
    const writeRouter = new Hono();
    writeRouter.post("/cart", async (c) => c.json({ status: "added" }, 201));

    const runOnce = vi.fn().mockResolvedValueOnce({ processed: 1 }).mockResolvedValueOnce({ processed: 0 });
    const module = {
      contextName: "checkout",
      apiMounts: [
        {
          mountPath: "/api/marketplace",
          kind: "primary",
          requiresAuth: true,
          drainProjectorsOnWrite: true,
        },
      ],
      buildApis: () => [writeRouter],
      projectors: () => [{ runOnce }],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "checkout",
            module,
            services: {},
            pool: {},
            projectors: [{ runOnce }],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [{ runOnce }],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "buyer",
          permissions: ["orders.manage"],
        })),
        writeConsistencyDrainEnabled: true,
      },
    );

    const response = await app.request("/api/marketplace/cart", {
      method: "POST",
      body: JSON.stringify({ productId: "prod_1" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("keeps write-drain consistency disabled by default", async () => {
    const writeRouter = new Hono();
    writeRouter.post("/cart", async (c) => c.json({ status: "added" }, 201));

    const runOnce = vi.fn();
    const module = {
      contextName: "checkout",
      apiMounts: [
        {
          mountPath: "/api/marketplace",
          kind: "primary",
          requiresAuth: true,
          drainProjectorsOnWrite: true,
        },
      ],
      buildApis: () => [writeRouter],
      projectors: () => [{ runOnce }],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "checkout",
            module,
            services: {},
            pool: {},
            projectors: [{ runOnce }],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [{ runOnce }],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "buyer",
          permissions: ["orders.manage"],
        })),
      },
    );

    const response = await app.request("/api/marketplace/cart", {
      method: "POST",
      body: JSON.stringify({ productId: "prod_1" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(runOnce).not.toHaveBeenCalled();
  });
});
