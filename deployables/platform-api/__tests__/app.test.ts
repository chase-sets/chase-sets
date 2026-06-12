import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createUcpEnvelope } from "@chase-sets/platform-runtime/ucp";
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

function platformActor(permissions: readonly string[]) {
  return {
    sessionId: "sess_1",
    tenantId: "tenant_1",
    userId: "user_1",
    accountId: "account_1",
    membershipId: "member_1",
    roleKey: "platform-user",
    permissions,
  };
}

function createEmptyRuntime(services: Record<string, unknown> = {}) {
  return {
    mountedContexts: [],
    mountedModules: [],
    services: {
      auth: {},
      identity: {},
      ...services,
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
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
        mountRole: "active",
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

describe("platform api app wiring", () => {
  it("mounts platform health aliases", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      readinessChecks: [
        {
          name: "control.database",
          check: async () => undefined,
        },
      ],
    });

    const rootResponse = await app.request("/health");
    const apiResponse = await app.request("/api/health/ready");

    expect(rootResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
    await expect(apiResponse.json()).resolves.toEqual({
      status: "ok",
      checks: [{ name: "control.database", status: "ok" }],
    });
  });

  it("mounts projection operations under the same-origin API prefix", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      resolveActor: vi.fn(async () => platformActor(["security.manage"])),
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        status: "ok",
        totalGroups: 0,
      },
      projectionGroups: [],
      projectionStatusSource: "runtime-memory",
    });
  });

  it("requires catalog manage permission for direct Catalog API mutations", async () => {
    const app = buildPlatformApiApp(createCatalogRuntime(), {
      resolveActor: vi.fn(async () => platformActor(["catalog.view"])),
    });

    const readResponse = await app.request("/api/catalog/source-observations/provider-profiles");
    const writeResponse = await app.request("/api/catalog/source-observations/provider-profiles", {
      method: "POST",
      body: JSON.stringify({ version: {} }),
      headers: { "Content-Type": "application/json" },
    });

    expect(readResponse.status).toBe(200);
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

  it("mounts internal realtime status with platform-api context stores", async () => {
    const realtimePool = {
      query: async (sql: string) => {
        if (sql.includes("MAX(outbox_id)")) {
          return { rows: [{ head: "5" }] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
    };
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
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "catalog",
            mountRole: "active",
            module: catalogModule,
            services: {},
            pool: realtimePool,
            projectionHandlerSets: [],
          },
          {
            contextName: "discovery",
            mountRole: "active",
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
    await expect(response.json()).resolves.toMatchObject({
      activeConnectionCount: 3,
      routeTuning: { batchSize: 25 },
      stores: expect.arrayContaining([
        expect.objectContaining({ contextName: "catalog", head: "5" }),
        expect.objectContaining({ contextName: "discovery", head: "5" }),
      ]),
    });
  });

  it("registers Inventory import MCP handlers from platform runtime services", async () => {
    const app = buildPlatformApiApp(
      createEmptyRuntime({
        inventory: {
          importBatches: {
            createBatch: vi.fn(),
            getBatch: vi.fn(),
            listBatches: vi.fn(),
            commitBatch: vi.fn(),
          },
        },
      }),
      {
        resolveActor: vi.fn(async () => platformActor(["inventory.view"])),
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
    const app = buildPlatformApiApp(
      createEmptyRuntime({
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
      }),
    );

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
      createEmptyRuntime({
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
      }),
      {
        resolveActor: vi.fn(async () => ({
          ...platformActor(["orders.view", "orders.manage"]),
          accountId: "acc_buyer",
          roleKey: "buyer",
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
            mountRole: "active",
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
            mountRole: "active",
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
        resolveActor: vi.fn(async () => platformActor(["orders.manage"])),
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
