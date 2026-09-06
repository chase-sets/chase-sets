import type { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import {
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_META_CLIENT_INFO_KEY,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_PROTOCOL_VERSION_HEADER,
} from "@chase-sets/platform-runtime/mcp-protocol";
import {
  createUcpEnvelope,
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
} from "@chase-sets/platform-runtime/ucp";
import { buildPlatformApiApp } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const NO_API_ENTRIES: ReturnType<typeof authModule.buildApis> = [];

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
    accountId: "acc_1",
    membershipId: "member_1",
    roleKey: "platform-user",
    permissions,
  };
}

function createEmptyRuntime(
  services: Record<string, unknown> = {},
  mountedModules: readonly { module: unknown; services: unknown }[] = [],
) {
  return {
    mountedContexts: [],
    mountedModules,
    services: {
      auth: {},
      identity: {},
      ...services,
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
}

function statelessMcpMeta() {
  return {
    [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION_2026_07_28,
    [MCP_META_CLIENT_INFO_KEY]: {
      name: "platform-api-vitest",
      version: "0.1.0",
    },
    [MCP_META_CLIENT_CAPABILITIES_KEY]: {},
  };
}

function statelessMcpRequest(method: string, params: Readonly<Record<string, unknown>> = {}, id = method) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: statelessMcpMeta(),
    },
  };
}

function statelessMcpHeaders(method: string, name?: string) {
  return {
    "Content-Type": "application/json",
    [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2026_07_28,
    [MCP_METHOD_HEADER]: method,
    ...(name ? { [MCP_NAME_HEADER]: name } : {}),
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
    buildApis: () => [{ mountPath: "/api/catalog", contextMountOrdinal: 1, router: catalogRouter }],
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

function createIdentityRuntime(services: Record<string, unknown>) {
  const commandHandler = vi.fn(async () => ({ version: 1, state: { status: "active" } }));
  const emptyList = vi.fn(async () => ({ items: [], total: 0 }));
  const authServices = {
    db: {
      query: vi.fn(async () => ({ rows: [] })),
    },
    auth: {
      hashSecret: (secret: string) => `hashed_${secret}`,
    },
    identity: {
      bootstrapTenantId: "tenant_identity",
      getUser: vi.fn(async () => null),
      getActiveMembershipForUserAccount: vi.fn(async () => null),
    },
  };
  const identityServices = {
    bootstrapTenantId: "tenant_identity",
    db: {
      query: vi.fn(async () => ({ rows: [] })),
    },
    accounts: {
      commandHandler,
      listAccounts: emptyList,
      getAccount: vi.fn(async () => null),
      getAccountForRead: vi.fn(async () => null),
      getAccountState: vi.fn(async () => null),
      projectors: [],
    },
    users: {
      commandHandler,
      listUsers: emptyList,
      getUser: vi.fn(async () => null),
      getUserState: vi.fn(async () => null),
      getUserBySocialLogin: vi.fn(async () => null),
      projectors: [],
    },
    memberships: {
      commandHandler,
      listMemberships: emptyList,
      getActiveMembershipForUserAccount: vi.fn(async () => null),
      getMembershipState: vi.fn(async () => null),
      projectors: [],
    },
    invitations: {
      commandHandler,
      listInvitations: emptyList,
      getInvitation: vi.fn(async () => null),
      projectors: [],
    },
    apiKeys: {
      commandHandler,
      listApiKeys: emptyList,
      getApiKey: vi.fn(async () => null),
      projectors: [],
    },
    shippingAddresses: {
      commandHandler,
      listShippingAddresses: vi.fn(async () => []),
      projectors: [],
    },
    preferences: {
      commandHandler,
      getUserPreferences: vi.fn(async () => null),
      projectors: [],
    },
    linkedPlatformAuthorizations: {
      resolveAccessToken: vi.fn(async () => null),
    },
    projectors: [],
    ...services,
  };

  return {
    mountedContexts: [
      {
        contextName: "identity",
        mountRole: "active",
        module: identityModule,
        services: identityServices,
        pool: {},
        projectionHandlerSets: [],
      },
    ],
    mountedModules: [{ module: identityModule, services: identityServices }],
    services: {
      auth: authServices,
      identity: identityServices,
    },
    projectionGroups: identityModule.projectionGroups?.map((group) => ({
      targetContextName: "identity",
      projectionName: group.projectionName,
      ownedTables: group.ownedTables,
      subscriptionRunners: [],
    })),
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

  it("serves OAuth protected-resource metadata for native MCP connector bootstrap", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime());

    const response = await app.request("https://marketplace.chasesets.test/.well-known/oauth-protected-resource");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: "https://marketplace.chasesets.test/mcp",
      authorization_servers: ["https://marketplace.chasesets.test/.well-known/oauth-authorization-server"],
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

  it("serves OAuth authorization-server metadata with dynamic client registration", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime());

    const response = await app.request("https://marketplace.chasesets.test/.well-known/oauth-authorization-server");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer: "https://marketplace.chasesets.test",
      authorization_endpoint: "https://marketplace.chasesets.test/ucp/oauth/authorize",
      token_endpoint: "https://marketplace.chasesets.test/ucp/oauth/token",
      registration_endpoint: "https://marketplace.chasesets.test/ucp/oauth/register",
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("mounts projection operations under the same-origin API prefix", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      resolveActor: vi.fn(async () => platformActor(["projection-operations.view"])),
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

  it("routes dotted projection names through projection operation retry endpoints", async () => {
    const enqueueProjectionOperation = vi.fn(async () => ({
      operationId: "op_retry",
      operationKind: "retry-blocked-stream",
      state: "queued",
      contextName: "checkout",
      projectionName: null,
      projectionKey: "checkout.checkout.session-projection",
      streamId: "checkout.session-1",
      requestedByUserId: "user_1",
      requestedByAccountId: "acc_1",
      claimOwnerId: null,
      claimFencingToken: null,
      claimedUntil: null,
      progress: {},
      result: null,
      error: null,
      requestedAt: "2026-06-29T00:00:00.000Z",
      startedAt: null,
      updatedAt: "2026-06-29T00:00:00.000Z",
      completedAt: null,
    }));
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      resolveActor: vi.fn(async () => platformActor(["projection-operations.view", "projection-operations.operate"])),
      controlPlane: {
        enqueueProjectionOperation,
      } as never,
    });

    const response = await app.request(
      "/api/platform/projections/checkout.checkout.session-projection/blocked-streams/checkout.session-1/retry",
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    expect(enqueueProjectionOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        contextName: "checkout",
        projectionKey: "checkout.checkout.session-projection",
        streamId: "checkout.session-1",
      }),
    );
  });

  it("keeps marketplace platform surfaces out of the landing runtime profile", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      runtimeProfile: "landing",
      adminRegistrationEnabled: false,
    });

    const registrationResponse = await app.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.test" }),
      headers: { "Content-Type": "application/json" },
    });
    const nativeMcpResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    });
    const ucpResponse = await app.request("/ucp/v1/catalog/search", {
      method: "POST",
      body: JSON.stringify({ query: "charizard" }),
      headers: { "Content-Type": "application/json" },
    });
    const realtimeStatusResponse = await app.request("/internal/realtime/status");

    expect(registrationResponse.status).toBe(403);
    await expect(registrationResponse.json()).resolves.toMatchObject({
      error: { code: "registration_disabled" },
    });
    expect(nativeMcpResponse.status).toBe(404);
    expect(ucpResponse.status).toBe(404);
    expect(realtimeStatusResponse.status).toBe(404);
  });

  it("rejects hostile Origin headers on composed MCP endpoints", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      resolveActor: vi.fn(async () => platformActor(["inventory.view"])),
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" });

    for (const endpoint of ["/mcp", "/ucp/mcp"]) {
      const response = await app.request(`https://marketplace.chasesets.test${endpoint}`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: -32003,
          message: "Invalid Origin header for MCP endpoint.",
        },
      });
    }
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

  it("rejects forged identity context headers on the mounted Identity consent API", async () => {
    const listConsents = vi.fn(async () => ({ items: [], total: 0 }));
    const app = buildPlatformApiApp(
      createIdentityRuntime({
        consents: {
          commandHandler: vi.fn(),
          listConsents,
          projectors: [],
        },
      }),
      { internalAuthSecret: "internal_secret" },
    );

    const response = await app.request("/api/identity/consents?userId=usr_victim&accountId=acc_victim", {
      headers: {
        "x-tenant-id": "tenant_forged",
        "x-user-id": "usr_attacker",
        "x-account-id": "acc_attacker",
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(listConsents).not.toHaveBeenCalled();
  });

  it("allows anonymous auth and identity routes declared by mounted modules", async () => {
    const resolveActor = vi.fn(async () => null);
    const anonymousRouter = new Hono();
    anonymousRouter.post("/public-token", (c) => {
      expect((c as unknown as { get(key: "actor"): unknown }).get("actor")).toBeNull();
      expect((c as unknown as { get(key: "context"): { tenantId: string } }).get("context").tenantId).toBe(
        "tenant_auth",
      );
      return c.json({ ok: true });
    });
    const module = {
      contextName: "identity",
      apiMounts: [
        {
          mountPath: "/api/identity",
          kind: "primary",
          requiresAuth: true,
        },
      ],
      anonymousRoutes: [{ routePath: "/api/identity/public-token", methods: ["POST"] }],
      buildApis: () => [{ mountPath: "/api/identity", contextMountOrdinal: 1, router: anonymousRouter }],
      projectionHandlerSets: () => [],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "identity",
            mountRole: "active",
            module,
            services: {},
            pool: {},
            projectionHandlerSets: [],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {
            identity: {
              bootstrapTenantId: "tenant_auth",
            },
          },
          identity: {},
        },
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      { resolveActor },
    );

    const response = await app.request("/api/identity/public-token", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(resolveActor).toHaveBeenCalledTimes(1);
  });

  it("lets the Auth session route wait for fresh session and membership projections before resolving the actor", async () => {
    type AuthenticatedSessionRead = NonNullable<
      Awaited<ReturnType<Parameters<typeof authModule.buildApis>[0]["sessions"]["readAuthenticatedSession"]>>
    >;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const syntheticAuthenticatedAt = new Date(Date.now() - 1_000).toISOString();
    const syntheticAuthenticatedSession: AuthenticatedSessionRead = {
      state: {
        id: "ses_1",
        userId: "usr_1",
        accountId: "acc_1",
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
        status: "active",
        expiresAt,
      },
      authenticatedAt: syntheticAuthenticatedAt,
    };
    let membershipFresh = false;
    const authServices = {
      db: {
        query: vi.fn(async () => ({
          rows: [
            {
              session_id: "ses_1",
              token_hash: "hashed_session_token",
              expires_at: expiresAt,
            },
          ],
        })),
      },
      auth: {
        hashSecret: (secret: string) => `hashed_${secret}`,
      },
      identity: {
        bootstrapTenantId: "tenant_auth",
        getUser: vi.fn(async () => null),
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
        readAuthenticatedSession: vi.fn(async (sessionId: string) =>
          sessionId === "ses_1" ? syntheticAuthenticatedSession : null,
        ),
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
      buildApis: () => NO_API_ENTRIES,
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

  it("registers Inventory import MCP handlers from the context module contract", async () => {
    const importBatchDetail = {
      batchId: "batch_1",
      accountId: "acc_1",
      rows: [],
    };
    const inventoryServices = {
      importBatches: {
        createBatch: vi.fn(async () => importBatchDetail),
        getBatch: vi.fn(async () => importBatchDetail),
        listBatches: vi.fn(),
        commitBatch: vi.fn(async () => ({ ...importBatchDetail, committed: true })),
      },
    };
    const auditRecords: unknown[] = [];
    const app = buildPlatformApiApp(
      createEmptyRuntime({ inventory: inventoryServices }, [{ module: inventoryModule, services: inventoryServices }]),
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
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "inventory.list-import-sources" }),
          expect.objectContaining({ name: "inventory.create-import-batch" }),
          expect.objectContaining({ name: "inventory.get-import-batch" }),
          expect.objectContaining({ name: "inventory.commit-import-batch" }),
        ]),
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
            accountId: "acc_1",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "request_1",
      result: {
        structuredContent: {
          items: expect.arrayContaining([expect.objectContaining({ sourceKey: "tcgplayer-csv" })]),
        },
        content: [
          {
            type: "text",
            text: expect.stringContaining("tcgplayer-csv"),
          },
        ],
      },
    });

    const toolInvocations = [
      {
        name: "inventory.create-import-batch",
        arguments: {
          accountId: "acc_1",
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
          accountId: "acc_1",
          batchId: "batch_1",
        },
      },
      {
        name: "inventory.commit-import-batch",
        arguments: {
          accountId: "acc_1",
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
        resources: expect.arrayContaining([
          expect.objectContaining({
            uriTemplate: "chase-sets://inventory/{accountId}/import-batches/{batchId}",
          }),
        ]),
      },
    });

    const readResourceResponse = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "resource_read_1",
        method: "resources/read",
        params: {
          uri: "chase-sets://inventory/acc_1/import-batches/batch_1",
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
            accountId: "acc_1",
            batchId: "batch_1",
            reason: "Commit reviewed rows.",
            idempotencyKey: "commit_mismatched_confirmation",
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
          accountId: "acc_1",
          auditEventName: "mcp.inventory.list-import-sources",
          targetType: "import-source-profile",
        }),
        expect.objectContaining({
          outcome: "allowed",
          method: "resources/read",
          resourceUri: "chase-sets://inventory/acc_1/import-batches/batch_1",
          actorId: "user_1",
          accountId: "acc_1",
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

  it("serves stateless native MCP requests across composed platform API instances without session affinity", async () => {
    const importBatchDetail = {
      batchId: "batch_1",
      accountId: "acc_1",
      rows: [],
    };
    const inventoryServices = {
      importBatches: {
        createBatch: vi.fn(async () => importBatchDetail),
        getBatch: vi.fn(async () => importBatchDetail),
        listBatches: vi.fn(),
        commitBatch: vi.fn(async () => ({ ...importBatchDetail, committed: true })),
      },
    };
    const createApp = () =>
      buildPlatformApiApp(
        createEmptyRuntime({ inventory: inventoryServices }, [
          { module: inventoryModule, services: inventoryServices },
        ]),
        {
          resolveActor: vi.fn(async () => platformActor(["inventory.view", "inventory.manage"])),
        },
      );
    const firstInstance = createApp();
    const secondInstance = createApp();

    const toolsResponse = await firstInstance.request("/mcp", {
      method: "POST",
      body: JSON.stringify(statelessMcpRequest("tools/list", {}, "tools_20260728")),
      headers: statelessMcpHeaders("tools/list"),
    });
    const toolCallResponse = await secondInstance.request("/mcp", {
      method: "POST",
      body: JSON.stringify(
        statelessMcpRequest(
          "tools/call",
          {
            name: "inventory.list-import-sources",
            arguments: {
              accountId: "acc_1",
            },
          },
          "tool_call_20260728",
        ),
      ),
      headers: statelessMcpHeaders("tools/call", "inventory.list-import-sources"),
    });
    const resourceResponse = await firstInstance.request("/mcp", {
      method: "POST",
      body: JSON.stringify(
        statelessMcpRequest(
          "resources/read",
          {
            uri: "chase-sets://inventory/acc_1/import-batches/batch_1",
          },
          "resource_read_20260728",
        ),
      ),
      headers: statelessMcpHeaders("resources/read", "chase-sets://inventory/acc_1/import-batches/batch_1"),
    });

    expect(toolsResponse.status).toBe(200);
    expect(toolCallResponse.status).toBe(200);
    expect(resourceResponse.status).toBe(200);
    expect(toolsResponse.headers.get("Mcp-Session-Id")).toBeNull();
    expect(toolCallResponse.headers.get("Mcp-Session-Id")).toBeNull();
    expect(resourceResponse.headers.get("Mcp-Session-Id")).toBeNull();
    await expect(toolsResponse.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: "inventory.list-import-sources" })]),
      },
    });
    await expect(toolCallResponse.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          items: expect.arrayContaining([expect.objectContaining({ sourceKey: "tcgplayer-csv" })]),
        },
      },
    });
    await expect(resourceResponse.json()).resolves.toMatchObject({
      result: {
        contents: [
          expect.objectContaining({
            uri: "chase-sets://inventory/acc_1/import-batches/batch_1",
          }),
        ],
      },
    });
  });

  it("registers Checkout cart MCP handlers from the context module contract", async () => {
    const checkoutServices = {
      cart: {
        listCartLines: vi.fn(async (accountId: string) => [
          {
            line_id: "cli_1",
            buyer_account_id: accountId,
            catalog_item_id: "cat_1",
            product_id: "cat_1::condition:near-mint",
            item_title: "Charizard",
            quantity: 1,
            updated_at: "2026-07-07T00:00:00.000Z",
          },
        ]),
      },
    };
    const app = buildPlatformApiApp(
      createEmptyRuntime({ checkout: checkoutServices }, [{ module: checkoutModule, services: checkoutServices }]),
      {
        resolveActor: vi.fn(async () => platformActor(["orders.view"])),
      },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "checkout_cart",
        method: "tools/call",
        params: {
          name: "checkout.get-cart",
          arguments: {
            accountId: "acc_1",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          accountId: "acc_1",
          total: 1,
          items: [expect.objectContaining({ line_id: "cli_1", item_title: "Charizard" })],
        },
      },
    });
    expect(checkoutServices.cart.listCartLines).toHaveBeenCalledWith("acc_1");
  });

  it("lists only public Discovery capabilities for anonymous native MCP discovery through the composed platform API", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime());

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools_1",
        method: "tools/list",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        tools: Array<{ name: string; annotations: { requiredPermissions: string[]; availability: string } }>;
      };
    };
    const toolNames = body.result.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([
      "discovery.get-chatgpt-product-feed",
      "discovery.get-item-detail",
      "discovery.search-market",
    ]);
    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "discovery.search-market",
          annotations: expect.objectContaining({
            availability: "available",
            requiredPermissions: [],
          }),
        }),
      ]),
    );
    expect(toolNames).not.toContain("inventory.list-import-sources");
    expect(toolNames).not.toContain("checkout.get-cart");
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
            resumeOrderCartCleanup:
              vi.fn<Parameters<typeof createCheckoutUcpHandlers>[0]["sessions"]["resumeOrderCartCleanup"]>(),
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

  it("exercises UCP MCP discovery, tool calls, resources, and idempotency through the composed platform API", async () => {
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
    const completeCheckout = vi.fn(async () =>
      createUcpEnvelope("ok", {
        checkout: { id: `chk_${completeCheckout.mock.calls.length}` },
      }),
    );
    const checkoutSessions = {
      commandHandler: vi.fn(),
      createFromCart: vi.fn(),
      createBuyNow: vi.fn(),
      createOfferIntent: vi.fn(),
      selectShippingOption: vi.fn(),
      selectOptimizationGoal: vi.fn(),
      recordFulfillmentPreview: vi.fn(),
      setShippingAddress: vi.fn(),
      recordOrdersCreated: vi.fn(),
      resumeOrderCartCleanup:
        vi.fn<Parameters<typeof createCheckoutUcpHandlers>[0]["sessions"]["resumeOrderCartCleanup"]>(),
      recordPaymentStarted: vi.fn(),
      recordOfferSubmitted: vi.fn(),
      getSession: vi.fn(),
      projectionHandlerSets: [],
    };
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
        checkout: {
          sessions: checkoutSessions,
        },
      }),
      {
        ucp: {
          mcpToolHandlers: {
            complete_checkout: completeCheckout,
          },
        },
      },
    );

    const toolsResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    });
    const resourcesResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "resources", method: "resources/list" }),
    });
    const resourceReadResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "resource-read",
        method: "resources/read",
        params: { uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI },
      }),
    });
    const searchResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "search",
        method: "tools/call",
        params: {
          name: "search_catalog",
          arguments: { query: "charizard", limit: 3 },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const unauthorizedResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "checkout-read",
        method: "tools/call",
        params: {
          name: "get_checkout",
          arguments: { id: "chk_1" },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const firstCompleteBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "complete-1",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const replayCompleteBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "complete-2",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const conflictCompleteBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "complete-3",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_2" },
      },
    });
    const firstCompleteResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: firstCompleteBody,
      headers: signedUcpHeaders(firstCompleteBody),
    });
    const replayCompleteResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: replayCompleteBody,
      headers: signedUcpHeaders(replayCompleteBody),
    });
    const conflictCompleteResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: conflictCompleteBody,
      headers: signedUcpHeaders(conflictCompleteBody),
    });

    expect(toolsResponse.status).toBe(200);
    const toolsBody = await toolsResponse.json();
    expect(toolsBody.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "search_catalog" }),
        expect.objectContaining({ name: "complete_checkout" }),
      ]),
    );
    expect(resourcesResponse.status).toBe(200);
    await expect(resourcesResponse.json()).resolves.toMatchObject({
      result: {
        resources: expect.arrayContaining([
          expect.objectContaining({ uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI }),
          expect.objectContaining({ uri: UCP_MCP_CART_REVIEW_RESOURCE_URI }),
          expect.objectContaining({ uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI }),
        ]),
      },
    });
    expect(resourceReadResponse.status).toBe(200);
    await expect(resourceReadResponse.json()).resolves.toMatchObject({
      result: {
        contents: [
          expect.objectContaining({
            uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
            text: expect.stringContaining("Chase Sets Product Cards"),
          }),
        ],
      },
    });
    expect(searchResponse.status).toBe(200);
    expect(searchItems).toHaveBeenCalledWith(expect.objectContaining({ search: "charizard", limit: 3 }));
    await expect(searchResponse.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          ucp: { status: "ok" },
          products: [{ id: "cat_1", title: "Charizard" }],
        },
      },
    });
    expect(unauthorizedResponse.status).toBe(200);
    await expect(unauthorizedResponse.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          ucp: { status: "error" },
          messages: [{ code: "authentication_required" }],
        },
        _meta: {
          "mcp/www_authenticate": 'Bearer realm="Chase Sets", scope="checkout:read"',
        },
      },
    });
    expect(completeCheckout).toHaveBeenCalledTimes(1);
    await expect(firstCompleteResponse.json()).resolves.toMatchObject({
      result: { structuredContent: { checkout: { id: "chk_1" } } },
    });
    await expect(replayCompleteResponse.json()).resolves.toMatchObject({
      result: { structuredContent: { checkout: { id: "chk_1" } } },
    });
    expect(conflictCompleteResponse.status).toBe(200);
    await expect(conflictCompleteResponse.json()).resolves.toMatchObject({
      error: {
        message: "Idempotency-Key was already used with different request parameters.",
      },
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
      buildApis: () => [{ mountPath: "/api/settlement/provider", contextMountOrdinal: 1, router: providerRouter }],
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
      buildApis: () => [{ mountPath: "/api/marketplace", contextMountOrdinal: 1, router: writeRouter }],
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

// -------------------------------------------------------------------------------------------------
// Provider mode observation through the complete mounted request (#7414).
//
// Every case below drives the real Payments module through `buildPlatformApiApp`, so the evidence is
// the complete mounted request rather than a focused handler.
// -------------------------------------------------------------------------------------------------

const PROVIDER_MODE_PATH = "/api/marketplace/payment-provider-mode";

const SYNTHETIC_HOST_OBSERVATION = {
  mode: "test",
  paymentProcessorKind: "fake",
  moneyMovementKind: "stripe",
  deploymentEnvironment: "dev",
} as const;

const PLANTED_HOST_MARKER = "sk_test_PLANTEDHOSTMARKER";

type PaymentsHostModule = Readonly<Record<string, unknown>>;

function paymentsRegistryModule(): PaymentsHostModule {
  const entry = apiContextRegistry.find((candidate) => candidate.contextName === "payments");
  if (!entry) {
    throw new Error("The Payments context must be registered for the mounted observation cases.");
  }
  return entry.module as unknown as PaymentsHostModule;
}

function createRecordingServiceProxy(calls: string[], path: string): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_target, property) {
      if (property === "then") {
        return undefined;
      }
      return createRecordingServiceProxy(calls, `${path}.${String(property)}`);
    },
    has() {
      return true;
    },
    apply() {
      calls.push(path);
      return createRecordingServiceProxy(calls, path);
    },
  });
}

function createPaymentsHostRuntime(
  options: Readonly<{
    observation?: unknown;
    module?: PaymentsHostModule;
    extraContexts?: readonly Readonly<{ contextName: string; module: unknown }>[];
  }> = {},
) {
  const serviceCalls: string[] = [];
  const paymentsServices = {
    payments: createRecordingServiceProxy(serviceCalls, "payments"),
    refunds: createRecordingServiceProxy(serviceCalls, "refunds"),
    publicConfig: {
      processorName: "stripe",
      publishableKey: null,
      confirmationExperience: "processor-managed-form",
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    },
    projectors: [],
    pool: createRecordingServiceProxy(serviceCalls, "pool"),
    db: createRecordingServiceProxy(serviceCalls, "db"),
    providerModeObservation: options.observation,
  };
  const paymentsHostModule = options.module ?? paymentsRegistryModule();
  const mountedContexts = [
    {
      contextName: "payments",
      mountRole: "active",
      module: paymentsHostModule,
      services: paymentsServices,
      pool: paymentsServices.pool,
      projectionHandlerSets: [],
    },
    ...(options.extraContexts ?? []).map((extra) => ({
      contextName: extra.contextName,
      mountRole: "active",
      module: extra.module,
      services: {},
      pool: {},
      projectionHandlerSets: [],
    })),
  ];

  return {
    serviceCalls,
    paymentsServices,
    runtime: {
      mountedContexts,
      mountedModules: mountedContexts.map((entry) => ({ module: entry.module, services: entry.services })),
      services: {
        auth: { identity: { bootstrapTenantId: "tenant_auth" } },
        identity: {},
        payments: paymentsServices,
      },
      projectionGroups: mountedProjectionGroups(mountedContexts),
      subscriptionRunners: [],
    } as never,
  };
}

/** Mirrors the host's own projection-group binding so declared read-freshness routes resolve. */
function mountedProjectionGroups(
  mountedContexts: readonly Readonly<{ contextName: string; module: unknown }>[],
): readonly unknown[] {
  return mountedContexts.flatMap((entry) => {
    const module = entry.module as Readonly<{
      projectionGroups?: readonly Readonly<{
        projectionName: string;
        projectionRevision?: number;
        sourceContextNames: readonly string[];
        optionalSourceContextNames?: readonly string[];
        ownedTables: readonly string[];
        resetStrategy: string;
        requiredDuringBootstrap?: boolean;
      }>[];
    }>;
    return (module.projectionGroups ?? []).map((group) => ({
      projectionName: group.projectionName,
      projectionRevision: group.projectionRevision ?? 1,
      targetContextName: entry.contextName,
      sourceContextNames: group.sourceContextNames,
      optionalSourceContextNames: group.optionalSourceContextNames ?? [],
      ownedTables: group.ownedTables,
      resetStrategy: group.resetStrategy,
      requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
      subscriptionRunners: [],
      reset: async () => {},
      getStatus: () => ({}),
      refreshStatus: async () => ({}),
      markRevisionSynced: async () => {},
    }));
  });
}

type PaymentsApiEntry = Readonly<{
  mountPath: string;
  contextMountOrdinal: number;
  router: Hono;
}>;

function paymentsApiEntries(module: PaymentsHostModule, services: unknown): readonly PaymentsApiEntry[] {
  const buildApis = module.buildApis;
  if (typeof buildApis !== "function") {
    throw new Error("The Payments module must publish buildApis.");
  }
  return Reflect.apply(buildApis, module, [services]) as readonly PaymentsApiEntry[];
}

function mountedPaymentsRoutes(module: PaymentsHostModule, services: unknown) {
  const entries = paymentsApiEntries(module, services);
  const marketplaceEntry = entries.find((entry) => entry.mountPath === "/api/marketplace");
  if (!marketplaceEntry) {
    throw new Error("Payments must publish a /api/marketplace mount.");
  }
  return marketplaceEntry.router;
}

function materializePathParameters(path: string) {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `syn_${segment.slice(1)}` : segment))
    .join("/");
}

function accountRouteInventory(module: PaymentsHostModule, services: unknown) {
  const seen = new Set<string>();
  const inventory: { method: string; path: string }[] = [];
  for (const route of mountedPaymentsRoutes(module, services).routes) {
    if (route.method === "ALL" || !route.path.startsWith("/account")) {
      continue;
    }
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    inventory.push({ method: route.method, path: route.path });
  }
  return inventory;
}

function anonymousDeclarationModule(declaration: unknown) {
  return { ...paymentsRegistryModule(), anonymousRoutes: declaration };
}

function repositoryRootFromTests() {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function collectRepositorySourceFiles(root: string): string[] {
  const skipped = new Set([".git", ".cache", ".next", ".turbo", ".vite", "artifacts", "dist", "node_modules", "out"]);
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) {
          walk(join(directory, entry.name));
        }
        continue;
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) {
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return files.map((file) => file.split("\\").join("/"));
}

function countConstructionCallSites(files: readonly string[], root: string, callee: string, declaration: string) {
  const callSites: { file: string; count: number }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8").split(declaration).join("");
    const count = source.split(`${callee}(`).length - 1;
    if (count > 0) {
      callSites.push({ file: file.slice(root.length + 1), count });
    }
  }
  return callSites;
}

describe("platform API payment provider mode observation", () => {
  it("serves the configured provider mode observation without resolving an actor", async () => {
    const resolveActor = vi.fn(async () => null);
    const { runtime, serviceCalls } = createPaymentsHostRuntime({ observation: SYNTHETIC_HOST_OBSERVATION });
    const app = buildPlatformApiApp(runtime, { resolveActor });

    const serviceCallsBefore = serviceCalls.length;
    const resolverCallsBefore = resolveActor.mock.calls.length;
    const response = await app.request(PROVIDER_MODE_PATH);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject(SYNTHETIC_HOST_OBSERVATION);
    expect(typeof (body as { observedAt?: unknown }).observedAt).toBe("string");
    expect(resolveActor.mock.calls.length - resolverCallsBefore, "resolver delta must be 0").toBe(0);
    expect(serviceCalls.length - serviceCallsBefore, "no Payments service or database call").toBe(0);

    // The complete mounted request performs zero actor resolution whether or not it carries a
    // credential, because the exempt path never reads one.
    const credentialBearing = await app.request(PROVIDER_MODE_PATH, {
      headers: { Authorization: "Bearer synthetic-probe-token" },
    });
    expect(credentialBearing.status).toBe(200);
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it("fails the mounted missing observation before resolving an actor", async () => {
    const resolveActor = vi.fn(async () => null);
    const transport = vi.spyOn(globalThis, "fetch");
    const { runtime, serviceCalls } = createPaymentsHostRuntime({ observation: undefined });
    const app = buildPlatformApiApp(runtime, { resolveActor });

    const response = await app.request(PROVIDER_MODE_PATH);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: "payment_provider_mode_observation_unavailable", message: "Request failed." },
    });
    expect(resolveActor, "resolver delta must be 0 on the missing observation").not.toHaveBeenCalled();
    expect(serviceCalls, "no Payments service, database or provider call").toEqual([]);
    expect(text).not.toContain("PLANTEDHOSTMARKER");
    expect(JSON.stringify([...response.headers.entries()])).not.toContain("PLANTEDHOSTMARKER");

    // A hostile observation carrying a planted marker also fails closed and never echoes it into the
    // body, a header, or the emitted telemetry.
    const hostile = createPaymentsHostRuntime({
      observation: { ...SYNTHETIC_HOST_OBSERVATION, secretKey: PLANTED_HOST_MARKER },
    });
    const hostileResponse = await buildPlatformApiApp(hostile.runtime, {
      resolveActor: vi.fn(async () => null),
    }).request(PROVIDER_MODE_PATH);
    const hostileText = await hostileResponse.text();
    expect(hostileResponse.status).toBe(500);
    expect(hostileText).not.toContain("PLANTEDHOSTMARKER");

    // The only outbound traffic this process makes is the loopback observability exporter; no request
    // reaches a provider, and nothing it carries repeats the planted marker.
    const outboundTargets = transport.mock.calls.map(([input]) => String(input));
    expect(outboundTargets.filter((target) => !target.startsWith("http://localhost:"))).toEqual([]);
    expect(JSON.stringify(transport.mock.calls)).not.toContain("PLANTEDHOSTMARKER");
    transport.mockRestore();

    // Manifest-deletion mutant. A Payments clone with `anonymousRoutes: []` keeps the bounded 500 but
    // moves the resolver delta from 0 to 1, which is what makes the delta above load-bearing.
    const clonedResolveActor = vi.fn(async () => null);
    const cloned = createPaymentsHostRuntime({
      observation: undefined,
      module: anonymousDeclarationModule([]),
    });
    const clonedResponse = await buildPlatformApiApp(cloned.runtime, { resolveActor: clonedResolveActor }).request(
      PROVIDER_MODE_PATH,
    );

    expect(clonedResponse.status).toBe(500);
    expect(clonedResolveActor, "the deletion mutant must resolve the actor").toHaveBeenCalledTimes(1);
  });

  it("keeps every Payments account route behind actor resolution", async () => {
    const resolveActor = vi.fn(async () => null);
    const { runtime, serviceCalls, paymentsServices } = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
    });
    const app = buildPlatformApiApp(runtime, { resolveActor });
    const inventory = accountRouteInventory(paymentsRegistryModule(), paymentsServices);

    expect(inventory, "the complete mounted account inventory").toHaveLength(16);

    for (const [index, route] of inventory.entries()) {
      const serviceCallsBefore = serviceCalls.length;
      const requestPath = `/api/marketplace${materializePathParameters(route.path)}`;
      const response = await app.request(requestPath, {
        method: route.method,
        ...(route.method === "GET" || route.method === "HEAD"
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: "{}" }),
      });

      expect(response.status, `${route.method} ${requestPath} must refuse an anonymous request`).toBe(401);
      expect(resolveActor, `${route.method} ${requestPath} must resolve exactly once`).toHaveBeenCalledTimes(index + 1);
      expect(
        serviceCalls.length - serviceCallsBefore,
        `${route.method} ${requestPath} must refuse before any Payments service call`,
      ).toBe(0);
    }

    // A declaration widened to the mount prefix, or a middleware that treats an exact declaration as a
    // prefix, would make these sixteen controls stop resolving; composition refuses that declaration
    // outright, which is asserted in the refusal cases below.
    expect(resolveActor).toHaveBeenCalledTimes(inventory.length);
  });

  it("keeps sibling platform actor consumers behind actor resolution", async () => {
    const resolveActor = vi.fn(async () => null);
    const siblingRouter = new Hono();
    siblingRouter.get("/items", (c) => c.json({ items: [] }));
    const siblingModule = {
      contextName: "catalog",
      apiMounts: [{ mountPath: "/api/catalog", kind: "primary", requiresAuth: true }],
      buildApis: () => [{ mountPath: "/api/catalog", contextMountOrdinal: 1, router: siblingRouter }],
      projectionHandlerSets: () => [],
    };
    const { runtime } = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      extraContexts: [{ contextName: "catalog", module: siblingModule }],
    });
    const app = buildPlatformApiApp(runtime, { resolveActor });

    const siblingRequests = [
      "/api/platform/projections",
      "/mcp",
      "/ucp/v1/products",
      "/ucp/mcp",
      "/api/catalog/items",
    ] as const;

    const siblingDeltas: Record<string, number> = {};
    for (const path of siblingRequests) {
      const before = resolveActor.mock.calls.length;
      await app.request(path, { method: "GET" });
      const delta = resolveActor.mock.calls.length - before;
      expect(delta, `${path} must retain resolver invocation`).toBeGreaterThanOrEqual(1);
      siblingDeltas[path] = delta;
    }

    // The exemption reaches only the exact declared observation request.
    const before = resolveActor.mock.calls.length;
    const exempt = await app.request(PROVIDER_MODE_PATH);
    expect(exempt.status).toBe(200);
    expect(resolveActor.mock.calls.length - before, "only the declared request is exempt").toBe(0);

    // Discriminating control: the same sibling requests against a host whose Payments module declares
    // no anonymous route produce byte-identical resolver deltas, so the declaration changes nothing
    // for any other platform actor consumer.
    const controlResolveActor = vi.fn(async () => null);
    const control = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      module: anonymousDeclarationModule([]),
      extraContexts: [{ contextName: "catalog", module: siblingModule }],
    });
    const controlApp = buildPlatformApiApp(control.runtime, { resolveActor: controlResolveActor });
    const controlDeltas: Record<string, number> = {};
    for (const path of siblingRequests) {
      const controlBefore = controlResolveActor.mock.calls.length;
      await controlApp.request(path, { method: "GET" });
      controlDeltas[path] = controlResolveActor.mock.calls.length - controlBefore;
    }
    expect(siblingDeltas).toEqual(controlDeltas);
  });

  it("refuses a prefix anonymous declaration on the platform actor path", () => {
    const { runtime } = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      module: anonymousDeclarationModule([{ routePath: "/api/marketplace", methods: ["GET"], match: "prefix" }]),
    });

    expect(() => buildPlatformApiApp(runtime, { resolveActor: vi.fn(async () => null) })).toThrow(
      "payments anonymous route /api/marketplace must match exactly; prefix matching is not permitted on the platform actor path.",
    );

    // A parameterised or non-absolute path is refused for the same reason.
    for (const routePath of ["/api/marketplace/:id", "/marketplace/payment-provider-mode", "/api/marketplace/"]) {
      const parameterised = createPaymentsHostRuntime({
        observation: SYNTHETIC_HOST_OBSERVATION,
        module: anonymousDeclarationModule([{ routePath, methods: ["GET"] }]),
      });
      expect(() => buildPlatformApiApp(parameterised.runtime, { resolveActor: vi.fn(async () => null) })).toThrow(
        `payments anonymous route ${routePath} must be an exact absolute path beginning /api/ with no parameter or wildcard.`,
      );
    }

    // Positive control: the exact Payments declaration still constructs.
    const exact = createPaymentsHostRuntime({ observation: SYNTHETIC_HOST_OBSERVATION });
    expect(() => buildPlatformApiApp(exact.runtime, { resolveActor: vi.fn(async () => null) })).not.toThrow();
  });

  it("refuses a non-safe anonymous method on the platform actor path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { runtime } = createPaymentsHostRuntime({
        observation: SYNTHETIC_HOST_OBSERVATION,
        module: anonymousDeclarationModule([{ routePath: PROVIDER_MODE_PATH, methods: [method] }]),
      });

      expect(() => buildPlatformApiApp(runtime, { resolveActor: vi.fn(async () => null) })).toThrow(
        `payments anonymous route ${PROVIDER_MODE_PATH} must declare only safe methods on the platform actor path.`,
      );
    }

    // Positive control: GET and HEAD are admitted.
    const safe = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      module: anonymousDeclarationModule([{ routePath: PROVIDER_MODE_PATH, methods: ["GET", "HEAD"] }]),
    });
    expect(() => buildPlatformApiApp(safe.runtime, { resolveActor: vi.fn(async () => null) })).not.toThrow();
  });

  it("leaves auth and identity anonymous declarations unchanged", async () => {
    // The identity precedent declares an anonymous POST. The non-auth/identity refusal must not reach
    // it: it still constructs, still serves, and still resolves the actor exactly once.
    const resolveActor = vi.fn(async () => null);
    const identityRouter = new Hono();
    identityRouter.post("/public-token", (c) => c.json({ ok: true }));
    const identityHostModule = {
      contextName: "identity",
      apiMounts: [{ mountPath: "/api/identity", kind: "primary", requiresAuth: true }],
      anonymousRoutes: [{ routePath: "/api/identity/public-token", methods: ["POST"], match: "prefix" }],
      buildApis: () => [{ mountPath: "/api/identity", contextMountOrdinal: 1, router: identityRouter }],
      projectionHandlerSets: () => [],
    };
    const { runtime } = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      extraContexts: [{ contextName: "identity", module: identityHostModule }],
    });

    const app = buildPlatformApiApp(runtime, { resolveActor });
    const response = await app.request("/api/identity/public-token", { method: "POST" });

    expect(response.status).toBe(200);
    expect(resolveActor).toHaveBeenCalledTimes(1);
  });

  it("closes every platform host, Payments service and platform actor middleware consumer", () => {
    const repositoryRoot = repositoryRootFromTests().split("\\").join("/");
    const sourceFiles = collectRepositorySourceFiles(repositoryRoot);

    const hostCallSites = countConstructionCallSites(
      sourceFiles,
      repositoryRoot,
      "createPlatformApiHost",
      "export function createPlatformApiHost",
    );
    const hostCallCount = hostCallSites.reduce((total, entry) => total + entry.count, 0);
    const productionHostFiles = hostCallSites
      .filter((entry) => !entry.file.includes("/__tests__/"))
      .map((entry) => entry.file);

    // Re-derived at the dispatch base rather than carried forward.
    expect(hostCallCount).toBe(23);
    expect(productionHostFiles.sort()).toEqual([
      "deployables/platform-api/src/admin-qa-actor-fixtures.ts",
      "deployables/platform-api/src/bootstrap.ts",
      "deployables/platform-api/src/main.ts",
      "deployables/platform-api/src/representative-commerce-state.ts",
      "scripts/replay-projection.ts",
    ]);
    expect(
      hostCallSites.filter((entry) => entry.file.includes("/__tests__/")).reduce((total, e) => total + e.count, 0),
    ).toBe(18);

    // Only the serving composition root supplies the port, and the manifest declares it once.
    const mainSource = readFileSync(join(repositoryRoot, "deployables/platform-api/src/main.ts"), "utf8");
    expect(mainSource.includes("providerModeObservation: config.providerModeObservation")).toBe(true);
    const bootstrapSource = readFileSync(join(repositoryRoot, "deployables/platform-api/src/bootstrap.ts"), "utf8");
    expect(bootstrapSource.includes("providerModeObservation")).toBe(false);

    const paymentsServiceCallSites = countConstructionCallSites(
      sourceFiles,
      repositoryRoot,
      "createPaymentsServices",
      "export function createPaymentsServices",
    ).map((entry) => entry.file);
    expect(paymentsServiceCallSites.sort()).toEqual([
      "bounded-contexts/payments/index.ts",
      "bounded-contexts/payments/support/runtime-support/seed.ts",
    ]);
    const seedSource = readFileSync(
      join(repositoryRoot, "bounded-contexts/payments/support/runtime-support/seed.ts"),
      "utf8",
    );
    expect(seedSource.includes("providerModeObservation"), "the seed caller omits the port").toBe(false);

    const middlewareCallSites = countConstructionCallSites(
      sourceFiles,
      repositoryRoot,
      "createPlatformActorMiddleware",
      "export function createPlatformActorMiddleware",
    ).filter((entry) => entry.file.startsWith("deployables/platform-api/src/"));
    expect(middlewareCallSites.map((entry) => entry.count)).toEqual([1]);

    // The manifest declares exactly the one exempt route, and no other context outside the auth
    // composition declares an anonymous route at all.
    const paymentsManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "bounded-contexts/payments/context.json"), "utf8"),
    ) as Readonly<{ anonymousRoutes?: readonly unknown[]; hostPorts: readonly { portName: string }[] }>;
    expect(paymentsManifest.anonymousRoutes).toEqual([{ routePath: PROVIDER_MODE_PATH, methods: ["GET"] }]);
    expect(paymentsManifest.hostPorts.map((port) => port.portName)).toContain("providerModeObservation");
  });

  it("turns red when the manifest declaration is deleted", async () => {
    // Manifest-deletion mutant for the caller closure above: without the declaration the exempt route
    // is no longer exempt, so the mounted observation request resolves the actor.
    const resolveActor = vi.fn(async () => null);
    const { runtime } = createPaymentsHostRuntime({
      observation: SYNTHETIC_HOST_OBSERVATION,
      module: anonymousDeclarationModule([]),
    });

    const response = await buildPlatformApiApp(runtime, { resolveActor }).request(PROVIDER_MODE_PATH);

    expect(response.status).toBe(200);
    expect(resolveActor, "the deleted declaration must restore actor resolution").toHaveBeenCalledTimes(1);
  });

  it("removes the observation without changing prior routes", async () => {
    // Rollback model: the manifest declaration and the root route registration are withdrawn while
    // every prior account route keeps the handler it has today.
    const resolveActor = vi.fn(async () => null);
    const { paymentsServices } = createPaymentsHostRuntime({ observation: SYNTHETIC_HOST_OBSERVATION });
    const currentRouter = mountedPaymentsRoutes(paymentsRegistryModule(), paymentsServices);
    const rolledBackRouter = new Hono();
    for (const route of currentRouter.routes) {
      if (route.path === "/payment-provider-mode") {
        continue;
      }
      rolledBackRouter.on([route.method], [route.path], route.handler);
    }

    const currentEntries = paymentsApiEntries(paymentsRegistryModule(), paymentsServices);
    const rolledBackModule = {
      ...paymentsRegistryModule(),
      anonymousRoutes: [],
      buildApis: () =>
        currentEntries.map((entry) =>
          entry.mountPath === "/api/marketplace" ? { ...entry, router: rolledBackRouter } : entry,
        ),
    };
    const rolledBack = createPaymentsHostRuntime({ observation: undefined, module: rolledBackModule });
    const app = buildPlatformApiApp(rolledBack.runtime, { resolveActor });

    const removed = await app.request(PROVIDER_MODE_PATH);
    expect(removed.status, "the observation path is absent after rollback").toBe(404);

    const inventory = accountRouteInventory(paymentsRegistryModule(), paymentsServices);
    const resolverCallsBeforeInventory = resolveActor.mock.calls.length;
    for (const route of inventory) {
      const requestPath = `/api/marketplace${materializePathParameters(route.path)}`;
      const response = await app.request(requestPath, {
        method: route.method,
        ...(route.method === "GET" || route.method === "HEAD"
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: "{}" }),
      });
      expect(response.status, `${route.method} ${requestPath} must be unchanged after rollback`).toBe(401);
    }
    expect(resolveActor.mock.calls.length - resolverCallsBeforeInventory).toBe(inventory.length);
  });
});
