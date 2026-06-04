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

function createCatalogRuntime() {
  const catalogRouter = new Hono();
  catalogRouter.get("/source-observations/provider-profiles", (c) => c.json({ items: [] }));
  catalogRouter.post("/source-observations/provider-profiles", (c) => c.json({ created: true }, 201));
  const catalogModule = {
    contextName: "catalog",
    apiMounts: [
      {
        mountPath: "/api/catalog",
        kind: "primary",
        requiresAuth: true,
      },
    ],
    buildApis: () => [catalogRouter],
    projectionHandlerSets: () => [],
  };

  return {
    mountedContexts: [
      {
        contextName: "catalog",
        module: catalogModule,
        services: {},
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module: catalogModule, services: {} }],
    services: {
      auth: {},
      catalog: {},
      identity: {},
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
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

  it("requires catalog manage permission for direct Catalog API mutations", async () => {
    const app = buildPlatformApiApp(createCatalogRuntime(), {
      resolveActor: vi.fn(async () => ({
        sessionId: "sess_1",
        tenantId: "tenant_1",
        userId: "user_1",
        accountId: "account_1",
        membershipId: "member_1",
        roleKey: "catalog-viewer",
        permissions: ["catalog.view"],
      })),
    });

    const readResponse = await app.request("/api/catalog/source-observations/provider-profiles");
    expect(readResponse.status).toBe(200);

    const writeResponse = await app.request("/api/catalog/source-observations/provider-profiles", {
      method: "POST",
      body: JSON.stringify({ version: {} }),
      headers: { "Content-Type": "application/json" },
    });
    expect(writeResponse.status).toBe(403);
    await expect(writeResponse.json()).resolves.toMatchObject({
      error: { code: "authorization_forbidden" },
    });
  });

  it("rejects unauthenticated direct Catalog API requests before mounted Catalog routes run", async () => {
    const app = buildPlatformApiApp(createCatalogRuntime(), {
      resolveActor: vi.fn(async () => null),
    });

    const response = await app.request("/api/catalog/source-observations/provider-profiles");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
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
          enqueueProjectionOperation: vi.fn(async () => {
            throw new Error("not used");
          }),
          claimProjectionOperation: vi.fn(async () => null),
          recordProjectionOperationProgress: vi.fn(async () => false),
          completeProjectionOperation: vi.fn(async () => false),
          failProjectionOperation: vi.fn(async () => false),
          cancelProjectionOperation: vi.fn(async () => false),
          getProjectionOperation: vi.fn(async () => null),
          listProjectionOperationEvents: vi.fn(async () => []),
          waitForProjectionOperationEvents: vi.fn(async () => undefined),
          listProjectionOperations: vi.fn(async () => []),
          summarizeProjectionOperations: vi.fn(async () => ({
            queuedCount: "0",
            runningCount: "0",
            failedCount: "0",
            cancelRequestedCount: "0",
            oldestQueuedAt: null,
            oldestRunningAt: null,
            averageDurationMs: null,
          })),
          claimScheduledRunner: vi.fn(async () => false),
          recordScheduledRunnerCompleted: vi.fn(async () => undefined),
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
      projectionHandlerSets: () => [],
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
            projectionHandlerSets: [],
          },
          {
            contextName: "discovery",
            module: discoveryModule,
            services: {},
            pool: realtimePool,
            projectionHandlerSets: [],
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

  it("registers Inventory import MCP handlers from platform runtime services", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
          inventory: {
            importBatches: {
              createBatch: vi.fn(),
              getBatch: vi.fn(),
              listBatches: vi.fn(),
              commitBatch: vi.fn(),
            },
          },
        },
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
      },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request_1",
        method: "tools/call",
        params: {
          name: "inventory.list-import-sources",
          arguments: {
            accountId: "account_1",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "request_1",
      result: {
        content: [
          {
            type: "json",
            json: {
              items: expect.arrayContaining([expect.objectContaining({ sourceKey: "tcgplayer-csv" })]),
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
              projectionHandlerSets: [],
            },
            detail: {
              getItemDetail: vi.fn(),
              projectionHandlerSets: [],
            },
            market: {},
            projectionHandlerSets: [],
          },
        },
      },
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
              projectionHandlerSets: [],
            },
          },
        },
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
        },
      ],
      buildApis: () => [providerRouter],
      projectionHandlerSets: () => [],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "settlement",
            module,
            services: {},
            pool: {},
            projectionHandlerSets: [],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
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

  it("does not synchronously drain projections after writes", async () => {
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
        },
      ],
      buildApis: () => [writeRouter],
      projectionHandlerSets: () => [{ runOnce }],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "checkout",
            module,
            services: {},
            pool: {},
            projectionHandlerSets: [{ runOnce }],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
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
        },
      ],
      buildApis: () => [writeRouter],
      projectionHandlerSets: () => [{ runOnce }],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "checkout",
            module,
            services: {},
            pool: {},
            projectionHandlerSets: [{ runOnce }],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
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
