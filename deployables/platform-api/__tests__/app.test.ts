import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
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

  it("lets the Auth session route wait for fresh session and membership projections before resolving the actor", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    let membershipFresh = false;
    const authServices = {
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM identity_session_tokens")) {
            return {
              rows: [
                {
                  session_id: "ses_1",
                  token_hash: "hashed_session_token",
                  expires_at: expiresAt,
                },
              ],
            };
          }

          throw new Error(`Unexpected auth db query: ${sql}`);
        }),
      },
      auth: {
        hashSecret: (secret: string) => `hashed_${secret}`,
      },
      identity: {
        bootstrapTenantId: "tenant_auth",
        getActiveMembershipForUserAccount: vi.fn(async () =>
          membershipFresh
            ? {
                membership_id: "mem_1",
                user_id: "usr_1",
                account_id: "acc_1",
                role_key: "owner",
                role_permissions: ["accounts.view"],
                status: "active",
                updated_at: new Date().toISOString(),
              }
            : null,
        ),
      },
      sessions: {
        getSession: vi.fn(async () => ({
          session_id: "ses_1",
          user_id: "usr_1",
          user_display_name: null,
          user_primary_email: "seller@example.test",
          account_id: "acc_1",
          account_display_name: "Seller",
          account_name: "Seller",
          available_account_ids: ["acc_1"],
          authentication_method: "password",
          status: "active",
          expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })),
        getSessionState: vi.fn(async () => null),
      },
    };
    const refreshAuthSession = vi.fn(async () => ({
      lastGlobalPosition: "4735",
      state: "caught-up",
      lastError: null,
    }));
    const refreshAuthMembership = vi.fn(async () => {
      membershipFresh = true;
      return {
        lastGlobalPosition: "19853",
        state: "caught-up",
        lastError: null,
      };
    });
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "auth",
            mountRole: "active",
            module: authModule,
            services: authServices,
            pool: {},
            projectionHandlerSets: [],
          },
        ],
        mountedModules: [{ module: authModule, services: authServices }],
        services: {
          auth: authServices,
          identity: {},
        },
        projectionGroups: [
          {
            targetContextName: "auth",
            projectionName: "auth-session-projection",
            ownedTables: ["identity_sessions", "identity_session_lookup"],
            subscriptionRunners: [{ sourceContextName: "auth", refreshStatus: refreshAuthSession }],
          },
          {
            targetContextName: "auth",
            projectionName: "auth-identity-membership-projection",
            ownedTables: ["auth_identity_memberships", "auth_identity_user_memberships"],
            subscriptionRunners: [{ sourceContextName: "identity", refreshStatus: refreshAuthMembership }],
          },
        ],
        subscriptionRunners: [],
      } as never,
      {
        readConsistency: {
          timeoutMs: 0,
          pollIntervalMs: 1,
        },
      },
    );
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        { sourceContextName: "auth", maxGlobalPosition: "4735", eventIds: ["evt_auth"] },
        { sourceContextName: "identity", maxGlobalPosition: "19853", eventIds: ["evt_identity"] },
      ],
    });

    const response = await app.request("/api/auth/session", {
      headers: {
        cookie: "chase_sets_session=session_token",
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: receipt,
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "auth",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actor: {
        sessionId: "ses_1",
        userId: "usr_1",
        accountId: "acc_1",
        membershipId: "mem_1",
      },
    });
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
    expect(refreshAuthMembership).toHaveBeenCalledTimes(1);
    expect(authServices.identity.getActiveMembershipForUserAccount).toHaveBeenCalledWith("usr_1", "acc_1");
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
    const importBatchDetail = {
      batchId: "batch_1",
      accountId: "account_1",
      rows: [],
    };
    const auditRecords: unknown[] = [];
    const app = buildPlatformApiApp(
      createEmptyRuntime({
        inventory: {
          importBatches: {
            createBatch: vi.fn(async () => importBatchDetail),
            getBatch: vi.fn(async () => importBatchDetail),
            listBatches: vi.fn(),
            commitBatch: vi.fn(async () => ({ ...importBatchDetail, committed: true })),
          },
        },
      }),
      {
        resolveActor: vi.fn(async () => platformActor(["inventory.view", "inventory.manage"])),
        mcp: {
          audit: (record) => {
            auditRecords.push(record);
          },
        },
      },
    );

    const toolsResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools_1",
        method: "tools/list",
      }),
    });
    await expect(toolsResponse.json()).resolves.toMatchObject({
      result: {
        tools: [
          expect.objectContaining({ name: "inventory.list-import-sources" }),
          expect.objectContaining({ name: "inventory.create-import-batch" }),
          expect.objectContaining({ name: "inventory.get-import-batch" }),
          expect.objectContaining({ name: "inventory.commit-import-batch" }),
        ],
      },
    });

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

    const toolInvocations = [
      {
        name: "inventory.create-import-batch",
        arguments: {
          accountId: "account_1",
          sourceKey: "tcgplayer-csv",
          quantityMode: "add",
          csvText: "title,quantity\nCharizard,1",
          idempotencyKey: "idem_create_batch",
          confirmationText: "Create Inventory Import Batch.",
        },
        confirmation: {
          confirmed: true,
          text: "Create Inventory Import Batch.",
        },
      },
      {
        name: "inventory.get-import-batch",
        arguments: {
          accountId: "account_1",
          batchId: "batch_1",
        },
      },
      {
        name: "inventory.commit-import-batch",
        arguments: {
          accountId: "account_1",
          batchId: "batch_1",
          reason: "Commit reviewed rows.",
          idempotencyKey: "idem_commit_batch",
          confirmationText: "Commit Inventory Import Batch.",
        },
        confirmation: {
          confirmed: true,
          text: "Commit Inventory Import Batch.",
        },
      },
    ];

    for (const invocation of toolInvocations) {
      const invocationResponse = await app.request("/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: invocation.name,
          method: "tools/call",
          params: invocation,
        }),
      });
      const body = (await invocationResponse.json()) as { error?: { code: number } };

      expect(invocationResponse.status).toBe(200);
      expect(body.error).toBeUndefined();
    }

    const resourcesResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "resources_1",
        method: "resources/list",
      }),
    });
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: [
          expect.objectContaining({
            uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          }),
        ],
      },
    });

    const readResourceResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "resource_read_1",
        method: "resources/read",
        params: {
          uri: "chase-sets://inventory/account_1/import-batches/batch_1",
        },
      }),
    });
    const readResourceBody = (await readResourceResponse.json()) as { error?: { code: number } };

    expect(readResourceResponse.status).toBe(200);
    expect(readResourceBody.error).toBeUndefined();

    const deniedResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mismatched_confirmation",
        method: "tools/call",
        params: {
          name: "inventory.commit-import-batch",
          arguments: {
            accountId: "account_1",
            batchId: "batch_1",
            reason: "Commit reviewed rows.",
            confirmationText: "Commit inventory import batch.",
          },
          confirmation: {
            confirmed: true,
            text: "Commit inventory import batch.",
          },
        },
      }),
    });

    expect(deniedResponse.status).toBe(200);
    expect(auditRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "allowed",
          method: "tools/call",
          toolName: "inventory.list-import-sources",
          actorId: "user_1",
          accountId: "account_1",
          auditEventName: "mcp.inventory.list-import-sources",
          targetType: "import-source-profile",
        }),
        expect.objectContaining({
          outcome: "allowed",
          method: "resources/read",
          resourceUri: "chase-sets://inventory/account_1/import-batches/batch_1",
          actorId: "user_1",
          accountId: "account_1",
          auditEventName: "mcp.inventory.resources.read",
          targetType: "Inventory Import Batch",
        }),
        expect.objectContaining({
          outcome: "denied",
          method: "tools/call",
          toolName: "inventory.commit-import-batch",
          reason: "Confirmation text must exactly match 'Commit Inventory Import Batch.'.",
        }),
      ]),
    );
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
