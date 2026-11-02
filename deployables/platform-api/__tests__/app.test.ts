import type { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
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
  EVIDENCE_WINDOW_ADMISSION_HEADER,
  type EvidenceWindowRegistration,
  type PlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { deriveProjectionTriage, deriveWakeAttentionItems } from "@chase-sets/platform-operations/server";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "@chase-sets/platform-runtime/http";
import {
  createUcpEnvelope,
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
  UCP_VERSION,
} from "@chase-sets/platform-runtime/ucp";
import { buildPlatformApiApp, createPlatformApiHost, createSavedListAnalyticsRecorder } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";

const NO_API_ENTRIES: ReturnType<typeof authModule.buildApis> = [];

type InventoryImportMcpService = Parameters<NonNullable<typeof inventoryModule.buildMcpHandlers>>[0]["importBatches"];

function inventoryImportMcpServices() {
  const detail: Awaited<ReturnType<InventoryImportMcpService["getBatch"]>> = {
    batch_id: "imb_1",
    account_id: "acc_1",
    status: "ready-to-commit",
    source_key: "native-csv",
    adapter_version: 1,
    quantity_mode: "add",
    default_storage_location_id: null,
    total_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    committed_count: 0,
    can_commit: true,
    commit_ready_count: 1,
    rows: [],
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:00.000Z",
  };
  const job = (
    context: Parameters<InventoryImportMcpService["enqueueCommitBatchJob"]>[1],
    jobKind: "create" | "commit",
  ): Awaited<ReturnType<InventoryImportMcpService["enqueueCommitBatchJob"]>> => ({
    jobId: `job_${jobKind}_synthetic`,
    jobKind,
    status: "queued",
    payload: { accountId: "acc_1", batchId: "imb_1" },
    progress: { phase: "queued", completed: 0, total: 1, currentRowId: null, message: null },
    result: null,
    errorMessage: null,
    eventContext: context,
    claimOwnerId: null,
    claimedUntil: null,
    attemptCount: 0,
    nextEligibleAt: "2026-10-29T00:00:00.000Z",
    createdAt: "2026-10-29T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-29T00:00:00.000Z",
  });
  return {
    importBatches: {
      getBatch: vi.fn<InventoryImportMcpService["getBatch"]>(async () => detail),
      enqueueCreateBatchJob: vi.fn<InventoryImportMcpService["enqueueCreateBatchJob"]>(async (_params, context) =>
        job(context, "create"),
      ),
      enqueueCommitBatchJob: vi.fn<InventoryImportMcpService["enqueueCommitBatchJob"]>(async (_params, context) =>
        job(context, "commit"),
      ),
    },
  };
}

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

/**
 * The Cart read the composed Checkout MCP handler actually calls, derived from
 * the module's own service contract rather than hand-declared here.
 *
 * A signature change in Checkout breaks this deployable double at compile time,
 * which is the only way a composed-handler test can honestly claim closure.
 */
type CheckoutMcpCartService = Parameters<NonNullable<typeof checkoutModule.buildMcpHandlers>>[0]["cart"];
type CheckoutCartRead = CheckoutMcpCartService["listAuthorizedCartLines"];
type CheckoutCartLineRow = Awaited<ReturnType<CheckoutCartRead>>[number];

function checkoutCartLineRow(overrides: Partial<CheckoutCartLineRow> = {}): CheckoutCartLineRow {
  return {
    buyer_account_id: "acc_1",
    line_id: "cli_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::condition:near-mint",
    item_language_code: "en",
    item_title: "Charizard",
    item_subtitle: null,
    item_image_url: null,
    item_image_srcset: null,
    item_image_loading_url: null,
    item_image_loading_alt: null,
    item_image_loading_srcset: null,
    selected_options: [],
    product_summary: null,
    quantity: 1,
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_1",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [],
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    ...overrides,
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
  projectionGroups: readonly unknown[] = [],
) {
  return {
    mountedContexts: [],
    mountedModules,
    services: {
      auth: {},
      identity: {},
      ...services,
    },
    projectionGroups,
    subscriptionRunners: [],
  } as never;
}

async function withUninstrumentedPlatformApiRuntime(
  action: (runtime: ReturnType<typeof createPlatformApiHost>) => void | Promise<void>,
  hostOptions: Pick<Parameters<typeof createPlatformApiHost>[0], "controlPlane" | "workSignalStore"> = {},
) {
  const pools = createPlatformApiPools({
    runtimeProfile: "public",
    sharedDatabaseUrl: "postgresql://localhost/shared",
    contextDatabaseUrls: {},
    port: 6182,
  });
  try {
    await action(
      createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        ...hostOptions,
        hostPorts: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
      }),
    );
  } finally {
    await closePlatformApiPools(pools);
  }
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
  it("supplies the real recorder to the built Collections host ports", async () => {
    await withUninstrumentedPlatformApiRuntime((runtime) => {
      expect(
        (runtime.services.collections as { savedListAnalyticsRecorder?: unknown }).savedListAnalyticsRecorder,
      ).toEqual(expect.objectContaining({ record: expect.any(Function) }));
    });
  });

  it("starts and serves Collections routes without an observability runtime", async () => {
    await withUninstrumentedPlatformApiRuntime(async (runtime) => {
      const response = await buildPlatformApiApp(runtime).request("/api/collections/account/lists/recent");
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authentication_required" },
      });
    });
  });

  it("supplies the real Saved List recorder in the host composition and keeps failures out of requests", () => {
    const info = vi.fn((_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined);
    const recorder = createSavedListAnalyticsRecorder({ info, warn: vi.fn() });
    recorder.record({
      event: "product_added",
      surface: "search",
      outcome: "added",
      coverage_band: "none",
      estimate_state: "none",
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(Object.keys(info.mock.calls[0]?.[1] ?? {}).sort()).toEqual(
      ["context", "event", "surface", "outcome", "coverage_band", "estimate_state", "type"].sort(),
    );
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      context: "collections",
      event: "product_added",
      surface: "search",
      outcome: "added",
      type: "collections.saved_list.analytics_event",
    });

    const counterFailureLog = {
      info: vi.fn((_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined),
      warn: vi.fn((_message: string, _fields?: Readonly<Record<string, unknown>>) => undefined),
    };
    const counterFailure = vi.fn((_event: unknown) => {
      throw new Error("SYNTHETIC_SAVED_LIST_COUNTER_FAILURE_MARKER");
    });
    const counterFailureRecorder = createSavedListAnalyticsRecorder(counterFailureLog, counterFailure);
    expect(() =>
      counterFailureRecorder.record({
        event: "list_created",
        surface: "search",
        outcome: "none",
        coverage_band: "none",
        estimate_state: "none",
      }),
    ).not.toThrow();
    expect(counterFailure).toHaveBeenCalledTimes(1);
    expect(counterFailureLog.warn).toHaveBeenCalledTimes(1);
    expect(counterFailureLog.warn).toHaveBeenCalledWith("Collections Saved List analytics recorder failed.", {
      failure: "counter",
      type: "collections.saved_list.analytics_recorder_failure",
    });
    expect(counterFailureLog.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(counterFailureLog.warn.mock.calls[0]?.[1])).not.toContain(
      "SYNTHETIC_SAVED_LIST_COUNTER_FAILURE_MARKER",
    );

    const markerLogger = {
      info: vi.fn((_message: string, _fields?: Readonly<Record<string, unknown>>) => {
        throw new Error("SYNTHETIC_SAVED_LIST_FAILURE_MARKER");
      }),
      warn: vi.fn(),
    };
    expect(() =>
      createSavedListAnalyticsRecorder(markerLogger).record({
        event: "list_created",
        surface: "search",
        outcome: "none",
        coverage_band: "none",
        estimate_state: "none",
      }),
    ).not.toThrow();
    expect(markerLogger.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(markerLogger.info.mock.calls[0]?.[1])).not.toContain("SYNTHETIC_SAVED_LIST_FAILURE_MARKER");
  });

  it("keeps every evidence-window route unmounted until dedicated admission is configured", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime());

    const responses = await Promise.all([
      app.request("/internal/evidence-windows/open", { method: "POST" }),
      app.request("/internal/evidence-windows/current"),
      app.request("/internal/evidence-windows/0123456789abcdef0123456789abcdef/close", { method: "POST" }),
      app.request("/internal/evidence-windows/0123456789abcdef0123456789abcdef/sources"),
      app.request("/internal/evidence-windows/0123456789abcdef0123456789abcdef/sources/2a/close", { method: "POST" }),
      app.request("/internal/evidence-windows/0123456789abcdef0123456789abcdef/sources/2a/release", { method: "POST" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it("mounts the three registration-only routes under the dedicated admission contract", async () => {
    const registration: EvidenceWindowRegistration = {
      open: vi.fn(async ({ windowId }) => ({
        windowId,
        state: "open" as const,
        openedAt: "2026-09-05T20:00:00.000Z",
        expiresAt: "2026-09-05T21:00:00.000Z",
        version: 1,
      })),
      current: vi.fn(async () => null),
      close: vi.fn(async ({ windowId }) => ({
        windowId,
        state: "closed" as const,
        closedAt: "2026-09-05T20:30:00.000Z",
        version: 2,
      })),
    };
    const app = buildPlatformApiApp(createEmptyRuntime(), {
      evidenceWindowRegistration: {
        admissionSecret: "synthetic-evidence-window-secret",
        authority: {
          effectiveMode: "test",
          gatewayKinds: { paymentProcessor: "fake", moneyMovement: "stripe" },
        },
        registration,
      },
    });
    const headers = {
      "content-type": "application/json",
      [EVIDENCE_WINDOW_ADMISSION_HEADER]: "synthetic-evidence-window-secret",
    };

    const open = await app.request("/internal/evidence-windows/open", {
      method: "POST",
      headers,
      body: JSON.stringify({ windowId: "0123456789abcdef0123456789abcdef", retentionSeconds: 3_600 }),
    });
    const current = await app.request("/internal/evidence-windows/current", { headers });
    const close = await app.request("/internal/evidence-windows/0123456789abcdef0123456789abcdef/close", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedVersion: 1 }),
    });

    expect([open.status, current.status, close.status]).toEqual([200, 200, 200]);
    await expect(current.json()).resolves.toEqual({ current: null });
    expect(registration.open).toHaveBeenCalledTimes(1);
    expect(registration.current).toHaveBeenCalledTimes(1);
    expect(registration.close).toHaveBeenCalledTimes(1);
  });

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
    const authorizationServer = await app.request(
      "https://marketplace.chasesets.test/.well-known/oauth-authorization-server",
    );
    const { issuer } = (await authorizationServer.json()) as { issuer: string };

    expect(response.status).toBe(200);
    expect(issuer).toBe("https://marketplace.chasesets.test");
    await expect(response.json()).resolves.toEqual({
      resource: "https://marketplace.chasesets.test/mcp",
      authorization_servers: [issuer],
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

  it("names the same authorization-server issuer through the trusted public-origin resolver", async () => {
    const app = buildPlatformApiApp(createEmptyRuntime());
    const forwarded = {
      headers: { "x-forwarded-host": "marketplace.chasesets.test", "x-forwarded-proto": "https" },
    };

    try {
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
      const resourceMetadata = await app.request(
        "http://platform-api.internal:8080/.well-known/oauth-protected-resource",
        forwarded,
      );
      const authorizationServer = await app.request(
        "http://platform-api.internal:8080/.well-known/oauth-authorization-server",
        forwarded,
      );
      const { issuer } = (await authorizationServer.json()) as { issuer: string };

      expect(issuer).toBe("https://marketplace.chasesets.test");
      await expect(resourceMetadata.json()).resolves.toMatchObject({
        resource: "https://marketplace.chasesets.test/mcp",
        authorization_servers: [issuer],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("OAuth authorize requires interactive consent on the mounted platform API", async () => {
    const db = {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes("FROM identity_ucp_oauth_clients")
          ? [
              {
                client_id: "synthetic-client",
                client_name: "Synthetic Agent",
                platform_profile_url: "https://agent.example",
                redirect_uris: ["https://agent.example/callback"],
                scopes: ["payouts:request"],
                grant_types: ["authorization_code"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              },
            ]
          : [],
        rowCount: 1,
      })),
    };
    const resolveActor = vi.fn(async () => ({ ...platformActor([]), sessionId: "synthetic-session" }));
    const app = buildPlatformApiApp(
      createEmptyRuntime({
        auth: {
          db,
          auth: {
            issueOpaqueToken: () => "ucp_consent_synthetic",
            hashSecret: () => "synthetic-hash",
          },
        },
        identity: { linkedPlatformAuthorizations: {} },
      }),
      { resolveActor },
    );
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "synthetic-client",
      redirect_uri: "https://agent.example/callback",
      scope: "payouts:request",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    const response = await app.request(`https://marketplace.chasesets.test/ucp/oauth/authorize?${query}`, {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/account/agents/consent?consent_token=ucp_consent_synthetic");
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO identity_ucp_oauth_consent_requests"))).toBe(
      true,
    );
    expect(
      db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO identity_ucp_oauth_authorization_codes")),
    ).toBe(false);
  });

  it("stock-client discovery chain registers", async () => {
    const authDb = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    const app = buildPlatformApiApp(createEmptyRuntime({ auth: { db: authDb } }));
    // The configured MCP server URL is the only input; every later URL comes from a discovery document.
    const mcpServerUrl = "https://marketplace.chasesets.test/mcp";

    const challenge = await app.request(mcpServerUrl, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call_1",
        method: "tools/call",
        params: { name: "inventory.list-import-sources", arguments: { accountId: "acc_1" } },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(challenge.status).toBe(401);
    const resourceMetadataUrl =
      /resource_metadata="([^"]+)"/.exec(challenge.headers.get("WWW-Authenticate") ?? "")?.[1] ?? "";

    const resourceMetadataResponse = await app.request(resourceMetadataUrl);
    expect(resourceMetadataResponse.status).toBe(200);
    const resourceMetadata = (await resourceMetadataResponse.json()) as {
      resource: string;
      authorization_servers: readonly string[];
      scopes_supported: readonly string[];
    };
    expect(resourceMetadata.resource).toBe(mcpServerUrl);
    expect(resourceMetadata.scopes_supported).toHaveLength(17);
    const [authorizationServerIssuer = ""] = resourceMetadata.authorization_servers;

    const authorizationServerResponse = await app.request(
      `${authorizationServerIssuer}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationServerResponse.status).toBe(200);
    const authorizationServer = (await authorizationServerResponse.json()) as {
      issuer: string;
      registration_endpoint: string;
    };
    expect(authorizationServer.issuer).toBe(authorizationServerIssuer);

    // Synthetic replay of the Claude Code 2.1.296 registration body shape captured by #9232: every advertised
    // scope (18 at capture), a client_name, a loopback redirect, and neither client_uri nor platform_profile_url.
    // The port and server label are synthetic.
    const registration = await app.request(authorizationServer.registration_endpoint, {
      method: "POST",
      body: JSON.stringify({
        client_name: "Claude Code (synthetic-server)",
        redirect_uris: ["http://localhost:49160/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: resourceMetadata.scopes_supported.join(" "),
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(registration.status).toBe(201);
    await expect(registration.json()).resolves.toMatchObject({
      client_name: "Claude Code (synthetic-server)",
      platform_profile_url: "http://localhost:49160",
      redirect_uris: ["http://localhost:49160/callback"],
      scope: [...resourceMetadata.scopes_supported].sort().join(" "),
      token_endpoint_auth_method: "none",
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

  it("wires operations attention reads into the platform API without self-fetching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T00:00:00.000Z"));
    const fetch = vi.spyOn(globalThis, "fetch");
    const controlPlane = {
      listProjectionStatusSnapshots: vi.fn(async () => []),
    } as unknown as PlatformControlPlane;
    const workSignalStore = {
      summarizeProjectionWakeIntents: vi.fn(async () => {
        vi.setSystemTime(new Date("2026-07-22T00:00:01.000Z"));
        return {
          queuedCount: 0,
          claimedCount: 0,
          failedCount: 1,
          expiredCount: 0,
          staleClaimCount: 0,
          oldestQueuedAt: null,
          oldestClaimedAt: null,
        };
      }),
      summarizeProjectionWakeIntentBreakdown: vi.fn(async () => []),
      summarizeCheckpointSignals: vi.fn(async () => ({
        readinessCount: 0,
        expiredReadinessCount: 0,
        latestReadyRecordedAt: null,
        pendingWaiterCount: 0,
        expiredPendingWaiterCount: 0,
        satisfiedWaiterCount: 0,
        oldestPendingWaiterAt: null,
        pendingWaiterOrigins: [],
      })),
    };

    try {
      await withUninstrumentedPlatformApiRuntime(
        async (runtime) => {
          const app = buildPlatformApiApp(runtime, {
            resolveActor: vi.fn(async () => platformActor(["projection-operations.view"])),
            controlPlane,
            workSignalStore,
          });
          fetch.mockClear();
          const response = await app.request("/api/platform/operations-attention");

          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.sources).toEqual([
            expect.objectContaining({ id: "projection-poison-event", status: "available" }),
            expect.objectContaining({ id: "projection-blocked-stream", status: "available" }),
            expect.objectContaining({ id: "wake-stalled-job", status: "available" }),
          ]);
          expect(body.items).toEqual([
            expect.objectContaining({ source: "wake-stalled-job", observedAt: "2026-07-22T00:00:01.000Z" }),
          ]);
          expect(workSignalStore.summarizeProjectionWakeIntents).toHaveBeenCalledTimes(1);
        },
        { controlPlane, workSignalStore },
      );
      expect(
        fetch.mock.calls.filter(([input]) => String(input).includes("/api/platform/operations-attention")),
      ).toHaveLength(0);
    } finally {
      fetch.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "fresh",
      snapshotAt: "2026-07-22T00:00:00.000Z",
      states: ["active", "stale", "expired", "unknown", "unknown"],
    },
    {
      name: "old",
      snapshotAt: "2026-07-22T01:00:00.000Z",
      states: ["expired", "expired", "expired", "unknown", "unknown"],
    },
    { name: "absent", snapshotAt: undefined, states: ["expired", "expired", "expired", "unknown", "unknown"] },
    { name: "partial", snapshotAt: "2026-07-22T", states: ["expired", "expired", "expired", "unknown", "unknown"] },
    { name: "invalid", snapshotAt: "invalid", states: ["expired", "expired", "expired", "unknown", "unknown"] },
  ])("composes canonical projection triage with $name snapshotAt", async ({ snapshotAt, states }) => {
    const projectionGroup = {
      targetContextName: "catalog",
      projectionName: "catalog-item-projection",
      requiredDuringBootstrap: true,
      subscriptionRunners: [],
      refreshStatus: vi.fn(),
      getStatus: () => ({
        targetContextName: "catalog",
        projectionName: "catalog-item-projection",
        projectionRevision: 1,
        storedProjectionRevision: 1,
        revisionStale: false,
        sourceContextNames: ["catalog"],
        ownedTables: [],
        requiredDuringBootstrap: true,
        initialized: true,
        caughtUp: false,
        state: "degraded",
        lastError: "synthetic failure",
        outstandingEventCount: "2",
        blockedStreamCount: 0,
        poisonEventCount: 1,
        updatedAt: "2026-07-22T00:00:00.000Z",
        subscriptions: [],
      }),
    };
    const controlPlane = {
      listProjectionStatusSnapshots: vi.fn(async () => []),
      readWorkerHeartbeatHistory: vi.fn<PlatformControlPlane["readWorkerHeartbeatHistory"]>(async () => ({
        snapshotAt: snapshotAt as string,
        workers: [
          { worker_id: "active", heartbeat_at: "2026-07-22T00:00:00.000Z" },
          { worker_id: "stale", heartbeat_at: "2026-07-21T23:50:00.000Z" },
          { worker_id: "expired", heartbeat_at: "2026-07-21T23:49:59.999Z" },
          { worker_id: "missing-heartbeat" },
          {},
        ],
        summary: {
          activeOrStaleCount: 2,
          expiredTotalCount: 1,
          expiredWithinDiagnosticWindowCount: 1,
          expiredReturnedCount: 1,
          expiredTruncated: false,
          expiredDiagnosticLimit: 100,
          diagnosticWindowMs: 604_800_000,
        },
      })),
      listRunnerStatuses: vi.fn(async () => []),
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
    } satisfies Pick<
      PlatformControlPlane,
      | "listProjectionStatusSnapshots"
      | "readWorkerHeartbeatHistory"
      | "listRunnerStatuses"
      | "listProjectionOperations"
      | "summarizeProjectionOperations"
    >;
    const app = buildPlatformApiApp(createEmptyRuntime({}, [], [projectionGroup]), {
      resolveActor: vi.fn(async () => platformActor(["projection-operations.view"])),
      controlPlane: controlPlane as unknown as PlatformControlPlane,
    });

    const response = await app.request("/api/platform/projections");

    expect(response.status).toBe(200);
    const body = await response.json();
    const canonical = deriveProjectionTriage(body);
    expect(body.attentionItems).toEqual(canonical.attentionItems);
    expect(body.repairQueue).toEqual(canonical.repairQueue);
    expect(body.activeWorkerCount).toBe(canonical.activeWorkerCount);
    expect(body.staleWorkerCount).toBe(canonical.staleWorkerCount);
    expect(body.workers.map((worker: Record<string, unknown>) => worker.worker_state)).toEqual(states);
    expect(body.activeWorkerCount).toBe(snapshotAt === "2026-07-22T00:00:00.000Z" ? 1 : 0);
    expect(body.staleWorkerCount).toBe(snapshotAt === "2026-07-22T00:00:00.000Z" ? 1 : 0);
    expect(body.repairQueue.some((item: { kind: string }) => item.kind === "projection-group")).toBe(true);
    expect(body).not.toHaveProperty("generatedAt");
  });

  it.each(["enabled", "disabled", "unavailable"] as const)(
    "composes canonical wake attention when wake is %s",
    async (state) => {
      const app = buildPlatformApiApp(createEmptyRuntime(), {
        resolveActor: vi.fn(async () => platformActor(["projection-operations.view"])),
        ...(state === "unavailable"
          ? {}
          : {
              workSignalStore: {
                summarizeProjectionWakeIntents: vi.fn(async () => ({
                  queuedCount: 0,
                  claimedCount: 0,
                  failedCount: state === "enabled" ? 2 : 0,
                  expiredCount: state === "enabled" ? 3 : 0,
                  staleClaimCount: state === "enabled" ? 1 : 0,
                  oldestQueuedAt: null,
                  oldestClaimedAt: null,
                })),
                summarizeProjectionWakeIntentBreakdown: vi.fn(async () => []),
                summarizeCheckpointSignals: vi.fn(async () => ({
                  readinessCount: 0,
                  expiredReadinessCount: 0,
                  latestReadyRecordedAt: null,
                  pendingWaiterCount: 0,
                  expiredPendingWaiterCount: state === "enabled" ? 1 : 0,
                  satisfiedWaiterCount: 0,
                  oldestPendingWaiterAt: null,
                  pendingWaiterOrigins: [],
                })),
              },
            }),
      });
      const wakeResponse = await app.request("/api/platform/projections/wake-status");
      expect(wakeResponse.status).toBe(200);
      const body = await wakeResponse.json();
      expect(body.attentionItems).toEqual(deriveWakeAttentionItems(body));
      expect(body.attentionItems.map((item: { id: string }) => item.id)).toEqual(
        state === "enabled"
          ? ["wake-failed-intents", "wake-stale-claims", "wake-expired-intents", "wake-expired-waiters"]
          : [],
      );
    },
  );

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
    const refreshAuthUser = vi.fn(async () => ({
      lastGlobalPosition: "19853",
      state: "caught-up",
      lastError: null,
    }));
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
          {
            targetContextName: "auth",
            projectionName: "auth-identity-user-projection",
            ownedTables: ["auth_identity_users", "auth_identity_user_emails", "auth_identity_user_phones"],
            subscriptionRunners: [{ sourceContextName: "identity", refreshStatus: refreshAuthUser }],
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
    expect(refreshAuthUser).toHaveBeenCalledTimes(1);
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
    const inventoryServices = inventoryImportMcpServices();
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
          idempotencyKey: "51a57702-b343-45a4-9134-8505ad6f3d0a",
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
          batchId: "imb_1",
        },
      },
      {
        name: "inventory.commit-import-batch",
        arguments: {
          accountId: "acc_1",
          batchId: "imb_1",
          reason: "Commit reviewed rows.",
          idempotencyKey: "457de5b5-17db-4396-88c9-fde59639db79",
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
      const body = (await invocationResponse.json()) as { error?: { code: number }; result?: { isError?: boolean } };

      expect(invocationResponse.status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).not.toBe(true);
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
          uri: "chase-sets://inventory/acc_1/import-batches/imb_1",
        },
      }),
    });
    const readResourceBody = (await readResourceResponse.json()) as { error?: { code: number } };

    expect(readResourceResponse.status).toBe(200);
    expect(readResourceBody.error).toBeUndefined();
    expect(inventoryServices.importBatches.getBatch).toHaveBeenCalledWith("imb_1", "acc_1");
    expect(inventoryServices.importBatches.enqueueCreateBatchJob).toHaveBeenCalledOnce();
    expect(inventoryServices.importBatches.enqueueCommitBatchJob).toHaveBeenCalledOnce();

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
            batchId: "imb_1",
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
          resourceUri: "chase-sets://inventory/acc_1/import-batches/imb_1",
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
    const inventoryServices = inventoryImportMcpServices();
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
            uri: "chase-sets://inventory/acc_1/import-batches/imb_1",
          },
          "resource_read_20260728",
        ),
      ),
      headers: statelessMcpHeaders("resources/read", "chase-sets://inventory/acc_1/import-batches/imb_1"),
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
            uri: "chase-sets://inventory/acc_1/import-batches/imb_1",
          }),
        ],
      },
    });
  });

  it("registers Checkout cart MCP handlers from the context module contract", async () => {
    const checkoutServices = {
      cart: {
        listAuthorizedCartLines: vi.fn<CheckoutCartRead>(async () => [checkoutCartLineRow()]),
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
    expect(checkoutServices.cart.listAuthorizedCartLines).toHaveBeenCalledWith({ accountId: "acc_1" });
  });

  it("publishes no cart owner marker through the composed Checkout cart MCP handler", async () => {
    // The row this double returns carries the owner marker, because the real
    // internal row does. Only the boundary mapper can keep it out of the
    // composed response.
    const checkoutServices = {
      cart: {
        listAuthorizedCartLines: vi.fn<CheckoutCartRead>(async () => [
          checkoutCartLineRow({ buyer_account_id: "anon_raw_marker" }),
        ]),
      },
    };
    const app = buildPlatformApiApp(
      createEmptyRuntime({ checkout: checkoutServices }, [{ module: checkoutModule, services: checkoutServices }]),
      { resolveActor: vi.fn(async () => platformActor(["orders.view"])) },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "checkout_cart_owner_free",
        method: "tools/call",
        params: { name: "checkout.get-cart", arguments: { accountId: "acc_1" } },
      }),
    });
    const responseText = await response.text();
    const structured = (JSON.parse(responseText) as { result: { structuredContent: { items: unknown[] } } }).result
      .structuredContent;

    expect(response.status).toBe(200);
    expect(responseText).not.toContain("buyer_account_id");
    expect(responseText).not.toContain("anon_raw_marker");
    expect(Object.keys(structured.items[0] as Record<string, unknown>)).not.toContain("buyer_account_id");
    // Still a real cart line, so the omission above is not an empty payload.
    expect(structured).toMatchObject({ items: [{ line_id: "cli_1", item_title: "Charizard" }] });
  });

  it("publishes a checkout.get-cart output schema that does not promise a cart owner", async () => {
    const app = buildPlatformApiApp(
      createEmptyRuntime({ checkout: { cart: {} } }, [{ module: checkoutModule, services: { cart: {} } }]),
      { resolveActor: vi.fn(async () => platformActor(["orders.view"])) },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools_schema", method: "tools/list" }),
    });
    const body = (await response.json()) as {
      result: { tools: readonly { name: string; outputSchema?: Record<string, unknown> }[] };
    };
    const getCart = body.result.tools.find((tool) => tool.name === "checkout.get-cart");
    const itemSchema = (
      (getCart?.outputSchema?.properties as Record<string, { items?: Record<string, unknown> }>) ?? {}
    ).items?.items as { required?: readonly string[]; properties?: Record<string, unknown> } | undefined;

    // A stale `required` entry would make an SDK client reject the owner-free
    // payload the handler now returns.
    expect(itemSchema?.required).toEqual(["line_id", "quantity"]);
    expect(Object.keys(itemSchema?.properties ?? {})).not.toContain("buyer_account_id");
    expect(Object.keys(itemSchema?.properties ?? {})).toContain("line_id");
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
              getItemDetail: vi.fn(async () => ({
                catalog_item_id: "cat_1",
                slug: "charizard-cat-1",
                title: "Charizard",
                description: "A card.",
                market_listings: [
                  {
                    listing_id: "lst_1",
                    listing_slug: "charizard-lst-1",
                    price_amount: "20.00",
                    price_currency_code: "USD",
                  },
                ],
              })) as never,
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
      ucp: { status: "success" },
      products: [expect.objectContaining({ id: "cat_1" })],
    });
  });

  it("wires Checkout-owned UCP checkout handlers with platform actor context", async () => {
    // Brief create DTO replaces source inputs and verifies the Discovery/Ordering host ports.
    const getPublicListingById = vi.fn(async () => ({
      listing_id: "lst_1",
      catalog_catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      item_title: "Charizard",
      item_subtitle: null,
      product_summary: null,
      selected_options: [],
      visible_quantity: 3,
    }));
    const getPurchase = vi.fn(async () => ({
      order_id: "ord_1",
      status: "pending-payment",
      ready_for_fulfillment_at: null,
      display_reference: "TEST-1",
    }));
    let orders: string[] = [];
    const checkoutSessionId = "chk_0123456789abcdefghijklmnop";
    const createBuyNow = vi.fn(async () => ({ sessionId: checkoutSessionId as never }));
    const getSession = vi.fn(async () => ({
      session_id: checkoutSessionId,
      buyer_account_id: "acc_buyer",
      source_type: "buy-now",
      optimization_goal: "lowest-total",
      fulfillment_preview_revision: null,
      shipping_option: "standard",
      shipping_address: null,
      lines: [],
      order_ids: orders,
      payment_id: null,
      submitted_offer_id: null,
      created_at: "2026-05-16T00:00:00.000Z",
      updated_at: "2026-05-16T00:00:00.000Z",
    }));
    const app = buildPlatformApiApp(
      createEmptyRuntime({
        discovery: { items: { market: { getPublicListingById } } },
        ordering: { orders: { getPurchase } },
        checkout: {
          sessions: {
            commandHandler: vi.fn(),
            createFromCart: vi.fn(),
            createBuyNow,
            resolveEntryAttempt: vi.fn(async () => null),
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
            getLastRecordedQuote: vi.fn(async () => null),
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
        ucp: {
          profileResolver: async () => ({
            ok: true,
            profile: {
              ucp: {
                version: UCP_VERSION,
                services: {},
                payment_handlers: {},
                capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }] },
              },
            },
          }),
        },
      },
    );
    const body = JSON.stringify({ line_items: [{ item: { id: "lst_1" }, quantity: 1 }] });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        revision: "server_revision",
        readyLineKeys: ["lst_1"],
        unavailableLines: [],
        unavailableLineKeys: [],
        materialChangeReasons: [],
        sellerGroups: [],
        totals: {
          itemSubtotalAmount: "20.00",
          shippingAmount: "0.00",
          salesTaxAmount: "0.00",
          totalAmount: "20.00",
          packageCount: 1,
        },
      }),
    );

    try {
      const response = await app.request("/ucp/v1/checkout-sessions", {
        method: "POST",
        body,
        headers: signedUcpHeaders(body),
      });

      expect(response.status).toBe(200);
      expect(getPublicListingById).toHaveBeenCalledExactlyOnceWith("lst_1");
      expect(createBuyNow).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "acc_buyer" }),
        expect.objectContaining({
          audit: expect.objectContaining({ forAccountId: "acc_buyer" }),
        }),
      );
      await expect(response.json()).resolves.toMatchObject({
        ucp: { status: "success" },
        id: checkoutSessionId,
      });
      orders = ["ord_1"];
      await app.request("/ucp/v1/checkout-sessions/chk_0123456789abcdefghijklmnop", {
        headers: { "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"' },
      });
      expect(getPurchase).toHaveBeenCalledExactlyOnceWith("ord_1", "acc_buyer");
    } finally {
      fetch.mockRestore();
    }
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
      createUcpEnvelope("success", {
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
              getItemDetail: vi.fn(async () => ({
                catalog_item_id: "cat_1",
                slug: "charizard-cat-1",
                title: "Charizard",
                description: "A card.",
                market_listings: [
                  {
                    listing_id: "lst_1",
                    listing_slug: "charizard-lst-1",
                    price_amount: "20.00",
                    price_currency_code: "USD",
                  },
                ],
              })) as never,
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
          profileResolver: async () => ({
            ok: true,
            profile: {
              ucp: {
                version: UCP_VERSION,
                services: {},
                payment_handlers: {},
                capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }] },
              },
            },
          }),
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
          arguments: { catalog: { query: "charizard", pagination: { limit: 3 } } },
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
          ucp: { status: "success" },
          products: [expect.objectContaining({ id: "cat_1" })],
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
          "mcp/www_authenticate": 'Bearer realm="Chase Sets", scope="dev.ucp.shopping.checkout:manage"',
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
      result: {
        structuredContent: {
          ucp: { version: UCP_VERSION, status: "error" },
          messages: [
            {
              type: "error",
              code: "idempotency_key_conflict",
              content: "Idempotency-Key was already used with different request parameters.",
              severity: "recoverable",
            },
          ],
        },
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

const PRODUCTION_HOST_FILES = [
  "deployables/platform-api/src/admin-qa-actor-fixtures.ts",
  "deployables/platform-api/src/bootstrap.ts",
  "deployables/platform-api/src/main.ts",
  "deployables/platform-api/src/representative-commerce-state.ts",
  "scripts/replay-projection.ts",
];

it("supplies capability administration authority in every production platform API host", () => {
  const root = repositoryRootFromTests();
  for (const file of PRODUCTION_HOST_FILES) {
    const source = readFileSync(join(root, file), "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const hostPorts: ts.ObjectLiteralExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === "createPlatformApiHost") {
        const options = node.arguments[0];
        expect(options && ts.isObjectLiteralExpression(options), file).toBe(true);
        if (options && ts.isObjectLiteralExpression(options)) {
          const ports = options.properties.find(
            (property) => ts.isPropertyAssignment(property) && property.name.getText(tree) === "hostPorts",
          );
          expect(ports && ts.isPropertyAssignment(ports) && ts.isObjectLiteralExpression(ports.initializer), file).toBe(
            true,
          );
          if (ports && ts.isPropertyAssignment(ports) && ts.isObjectLiteralExpression(ports.initializer)) {
            hostPorts.push(ports.initializer);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    expect(hostPorts, file).toHaveLength(1);
    for (const ports of hostPorts) {
      expect(
        ports.properties.some(
          (property) =>
            (ts.isPropertyAssignment(property) &&
              property.name.getText(tree) === "capabilityAdministrationAuthority") ||
            (file.endsWith("/main.ts") &&
              ts.isSpreadAssignment(property) &&
              property.expression.getText(tree) === "capabilityAdministrationPorts"),
        ),
        `${file} must supply capabilityAdministrationAuthority`,
      ).toBe(true);
    }
  }
});

function verifyHostConstructionCensus(root: string, files = collectRepositorySourceFiles(root)) {
  const callSites = countConstructionCallSites(
    files,
    root,
    "createPlatformApiHost",
    "export function createPlatformApiHost",
  );
  const productionFiles = callSites.filter((entry) => !entry.file.includes("/__tests__/")).map((entry) => entry.file);
  expect(productionFiles.sort(), "the closed production host owner classification").toEqual(PRODUCTION_HOST_FILES);
  expect(callSites.filter((entry) => entry.file.includes("/__tests__/")).map((entry) => entry.file)).toEqual(
    expect.arrayContaining([
      "deployables/platform-api/__tests__/app.test.ts",
      "deployables/platform-api/__tests__/database-pools.test.ts",
    ]),
  );

  const mainSource = readFileSync(join(root, "deployables/platform-api/src/main.ts"), "utf8");
  expect(
    mainSource.includes("providerModeObservation: config.providerModeObservation"),
    "serving host provider observation wiring",
  ).toBe(true);
  const bootstrapSource = readFileSync(join(root, "deployables/platform-api/src/bootstrap.ts"), "utf8");
  expect(bootstrapSource.includes("providerModeObservation")).toBe(false);
  return callSites;
}

function withHostCensusCorpus(action: (root: string) => void) {
  const artifacts = join(repositoryRootFromTests(), "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "host-census-control-")).split("\\").join("/");
  // A fixed fixture reenacts the old 26/21 census before adding an eligible sibling.
  const hostCall = ["createPlatformApiHost", "({});"].join("");
  const sources = [
    ...PRODUCTION_HOST_FILES.map((file) => ({
      file,
      source: `${hostCall}\n${file.endsWith("/main.ts") ? "providerModeObservation: config.providerModeObservation" : ""}`,
    })),
    { file: "deployables/platform-api/__tests__/app.test.ts", source: Array(20).fill(hostCall).join("\n") },
    { file: "deployables/platform-api/__tests__/database-pools.test.ts", source: hostCall },
  ];
  try {
    for (const { file, source } of sources) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  it.each([false, true])(
    "keeps every Payments account route behind actor resolution (additional route: %s)",
    async (additionalRoute) => {
      const registeredModule = paymentsRegistryModule();
      const module = additionalRoute
        ? {
            ...registeredModule,
            buildApis: (services: unknown) => {
              const entries = paymentsApiEntries(registeredModule, services);
              const marketplace = entries.find((entry) => entry.mountPath === "/api/marketplace");
              if (!marketplace) {
                throw new Error("Payments must publish the marketplace mount for the addition control.");
              }
              const protectedRoute = marketplace.router.routes.find(
                (route) => route.method === "GET" && route.path === "/account/payments/:id",
              );
              if (!protectedRoute) {
                throw new Error("Payments must publish the protected payment read for the addition control.");
              }
              marketplace.router.get("/account/census-control/:id", protectedRoute.handler);
              return entries;
            },
          }
        : registeredModule;
      const resolveActor = vi.fn(async () => null);
      const { runtime, serviceCalls, paymentsServices } = createPaymentsHostRuntime({
        observation: SYNTHETIC_HOST_OBSERVATION,
        module,
      });
      const app = buildPlatformApiApp(runtime, { resolveActor });
      const inventory = accountRouteInventory(module, paymentsServices);

      expect(inventory.length, "the mounted account inventory must not be empty").toBeGreaterThan(0);
      expect(inventory).toEqual(
        expect.arrayContaining([
          { method: "POST", path: "/account/payments" },
          { method: "GET", path: "/account/payments/:id" },
        ]),
      );
      if (additionalRoute) {
        expect(inventory).toContainEqual({ method: "GET", path: "/account/census-control/:id" });
      }

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
        expect(resolveActor, `${route.method} ${requestPath} must resolve exactly once`).toHaveBeenCalledTimes(
          index + 1,
        );
        expect(
          serviceCalls.length - serviceCallsBefore,
          `${route.method} ${requestPath} must refuse before any Payments service call`,
        ).toBe(0);
      }

      // A declaration widened to the mount prefix, or a middleware that treats an exact declaration as a
      // prefix, would make these account controls stop resolving; composition refuses that declaration
      // outright, which is asserted in the refusal cases below.
      expect(resolveActor).toHaveBeenCalledTimes(inventory.length);
    },
  );

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

    // Includes the shared-seed bootstrap host, whose owned pools close in finally.
    // AC2's caller-held/standalone seed host in bootstrap-lock-contention.db.test.ts closes its pools in finally.
    const hostCallSites = verifyHostConstructionCensus(repositoryRoot, sourceFiles);
    expect(hostCallSites.map((entry) => entry.file)).toContain(
      "deployables/platform-api/__tests__/bootstrap-lock-contention.db.test.ts",
    );

    const paymentsServiceCallSites = countConstructionCallSites(
      sourceFiles,
      repositoryRoot,
      "createPaymentsServices",
      "export function createPaymentsServices",
    ).map((entry) => entry.file);
    expect(paymentsServiceCallSites.sort()).toEqual([
      "bounded-contexts/payments/features/payments/api/evidence-window-disposition.test.ts",
      "bounded-contexts/payments/features/payments/api/saved-instrument-attempt.db.test.ts",
      "bounded-contexts/payments/features/payments/api/webhook-inbox.db.test.ts",
      "bounded-contexts/payments/features/wallet-funding/api/capture.db.test.ts",
      "bounded-contexts/payments/features/wallet-funding/api/runtime.test.ts",
      "bounded-contexts/payments/index.ts",
      "bounded-contexts/payments/support/runtime-support/seed.ts",
      "bounded-contexts/payments/tests/provider-journal.db.test.ts",
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

  it("discovers and accepts a harmless test-only host construction in an arbitrary eligible sibling", () => {
    withHostCensusCorpus((root) => {
      const before = verifyHostConstructionCensus(root);
      const totalCalls = (sites: typeof before) => sites.reduce((total, entry) => total + entry.count, 0);
      expect(totalCalls(before), "fixed fixture starts at the retired host-call total").toBe(26);
      const sibling = "deployables/platform-api/__tests__/nested/new-host-control.mts";
      mkdirSync(dirname(join(root, sibling)), { recursive: true });
      writeFileSync(join(root, sibling), ["createPlatformApiHost", "({});"].join(""));

      const after = verifyHostConstructionCensus(root);
      expect(after).toContainEqual({ file: sibling, count: 1 });
      expect(totalCalls(after)).toBe(totalCalls(before) + 1);
      expect(() => expect(totalCalls(after)).toBe(26), "the addition rejects the retired literal").toThrow();
    });
  });

  it("discovers and rejects an unclassified production host owner", () => {
    withHostCensusCorpus((root) => {
      const file = join(root, "deployables/platform-api/src/unclassified-host.mts");
      writeFileSync(file, ["createPlatformApiHost", "({});"].join(""));
      expect(() => verifyHostConstructionCensus(root)).toThrow("closed production host owner classification");
    });
  });

  it("rejects a missing required production host owner", () => {
    withHostCensusCorpus((root) => {
      rmSync(join(root, "deployables/platform-api/src/bootstrap.ts"));
      expect(() => verifyHostConstructionCensus(root)).toThrow("closed production host owner classification");
    });
  });

  it("rejects missing provider observation wiring in the serving host", () => {
    withHostCensusCorpus((root) => {
      verifyHostConstructionCensus(root);
      writeFileSync(join(root, "deployables/platform-api/src/main.ts"), ["createPlatformApiHost", "({});"].join(""));
      expect(() => verifyHostConstructionCensus(root)).toThrow("serving host provider observation wiring");
    });
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
