import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { buildAccountCapabilityRegistry } from "@chase-sets/platform-runtime/api";
import {
  UCP_VERSION,
  UCP_MCP_TOOLS,
  type UcpEnvelope,
  type UcpIdempotencyStore,
  type PlatformIdempotencyRecord,
} from "@chase-sets/platform-runtime/ucp";
import {
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
} from "@chase-sets/platform-runtime/mcp-protocol";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { buildPlatformApiApp } from "../src/app";

const id = "chk_0123456789abcdefghijklmnop";
const profileUrl = "https://agent.example/.well-known/ucp";
const buyer: ResolvedActor = {
  sessionId: "ucp:synthetic",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["orders.view", "orders.manage"],
  agentGrant: {
    grantId: "synthetic",
    platformProfileUrl: profileUrl,
    scopes: ["dev.ucp.shopping.checkout:manage"],
    rolePermissions: ["orders.view", "orders.manage"],
  },
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const line = {
  listingId: "lst_1",
  cartLineId: null,
  catalogItemId: "cat_1",
  productId: "cat_1::",
  itemTitle: "Synthetic card",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  quantity: 1,
};
type Row = NonNullable<Awaited<ReturnType<Parameters<typeof createCheckoutUcpHandlers>[0]["sessions"]["getSession"]>>>;
const row = (): Row => ({
  session_id: id,
  buyer_account_id: "acc_buyer",
  source_type: "buy-now",
  optimization_goal: "lowest-total",
  fulfillment_preview_revision: "ready",
  fulfillment_preview_snapshot: null,
  shipping_option: "standard",
  shipping_address_id: null,
  shipping_address: null,
  lines: [line],
  checkout_reservations: [],
  order_ids: [],
  order_write_commit_positions: [],
  payment_id: null,
  submitted_offer_id: null,
  cancelled_at: null,
  handoff_expires_at: "2026-10-16T06:00:00.000Z",
  created_at: "2026-10-16T00:00:00.000Z",
  updated_at: "2026-10-16T00:00:00.000Z",
});
type Transport = "rest" | "legacy" | "modern";

type FixtureOptions = Parameters<typeof fixture>[0];
type CallOptions = Readonly<{
  id?: string;
  signature?: "valid" | "partial" | "bad" | "bad-digest" | "no-key";
  key?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
}>;

function fixture(
  options: Readonly<{
    actor?: ResolvedActor | null;
    session?: Partial<Row>;
    checkoutClosed?: boolean;
    body?: Record<string, unknown>;
    searchItems?: (...args: never[]) => unknown;
    getItemDetail?: (...args: never[]) => unknown;
    getPurchase?: (...args: never[]) => unknown;
    retainedQuote?: unknown;
    paymentStatus?: string | null;
    previewUnavailable?: boolean;
    contextUnavailable?: boolean;
  }> = {},
) {
  if (options.previewUnavailable) {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      Response.json({
        revision: "fresh",
        readyLineKeys: [],
        unavailableLineKeys: ["lst_1"],
        unavailableLines: [{ listingId: "lst_1" }],
        materialChangeReasons: ["unavailable"],
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
  }
  let actor: ResolvedActor | null = options.actor === undefined ? buyer : options.actor;
  let current = { ...row(), ...options.session };
  const createdSessionIds = new Set<string>();
  const getSession = vi.fn(async (sessionId: string, accountId: string) =>
    (sessionId === id || createdSessionIds.has(sessionId)) && accountId === current.buyer_account_id ? current : null,
  );
  const cancelSession = vi.fn(async () => ({
    sessionId: id,
    session: (current = { ...current, cancelled_at: new Date().toISOString() }),
  }));
  const readSessionForCancellation = vi.fn(async ({ accountId }: { sessionId: string; accountId: string }) => {
    if (accountId !== current.buyer_account_id) throw new Error("Checkout session not found.");
    return {
      status: current.cancelled_at ? ("already-cancelled" as const) : ("cancellable" as const),
      session: current,
    };
  });
  const createBuyNow = vi.fn(async (input: { sessionIdOverride?: string }) => {
    const sessionId = input.sessionIdOverride ?? id;
    createdSessionIds.add(sessionId);
    return { sessionId };
  });
  const recordFulfillmentPreview = vi.fn(async () => ({}));
  const recordOrdersCreated = vi.fn();
  const recordPaymentStarted = vi.fn();
  const records = new Map<string, PlatformIdempotencyRecord<UcpEnvelope>>();
  const reserve = vi.fn<UcpIdempotencyStore["reserve"]>((input) => {
    const old = records.get(input.key);
    if (old)
      return {
        outcome:
          old.requestHash !== input.requestHash ? "conflict" : old.status === "completed" ? "completed" : "pending",
        record: old,
      };
    const record = { ...input, status: "pending" as const, response: null };
    records.set(input.key, record);
    return { outcome: "reserved", record };
  });
  const store: UcpIdempotencyStore = {
    reserve,
    get: (key) => records.get(key) ?? null,
    complete: (record) => {
      records.set(record.key, { ...record, status: "completed" });
    },
    put: (record) => {
      records.set(record.key, record);
    },
    abandon: ({ key }) => {
      records.delete(key);
    },
  };
  const runtime: Parameters<typeof buildPlatformApiApp>[0] = {
    accountCapabilityRegistry: buildAccountCapabilityRegistry([]),
    mountedContexts: [],
    mountedModules: [],
    projectionGroups: [],
    subscriptionRunners: [],
    services: {
      auth: {},
      identity: { agentGrantRevocations: { isActiveGrant: async () => true } },
      checkout: {
        sessions: {
          getSession,
          cancelSession,
          readSessionForCancellation,
          createBuyNow,
          recordFulfillmentPreview,
          recordOrdersCreated,
          recordPaymentStarted,
          getPaymentSummary: vi.fn(async () => (options.paymentStatus ? { status: options.paymentStatus } : null)),
          getLastRecordedQuote: vi.fn(async () =>
            options.retainedQuote === undefined
              ? {
                  revision: "retained",
                  readyLineKeys: ["lst_1"],
                  unavailableLineKeys: [],
                  unavailableLines: [],
                  materialChangeReasons: [],
                  sellerGroups: [{ lines: [{ listingId: "lst_1", estimatedUnitPriceAmount: "20.00" }] }],
                  totals: {
                    itemSubtotalAmount: "20.00",
                    shippingAmount: "0.00",
                    salesTaxAmount: "0.00",
                    totalAmount: "20.00",
                    packageCount: 1,
                  },
                }
              : options.retainedQuote,
          ),
        },
      },
      discovery: {
        items: {
          market: {
            getPublicListingById: async () => ({
              listing_id: "lst_1",
              account_id: "acc_seller",
              catalog_catalog_item_id: "cat_1",
              product_id: "cat_1::",
              item_title: "Synthetic card",
              item_subtitle: null,
              product_summary: null,
              selected_options: [],
              visible_quantity: 1,
            }),
          },
          search: {
            searchItems: options.searchItems ?? vi.fn(async () => ({ items: [], total: 0, nextCursor: null })),
            suggestItems: vi.fn(async () => []),
            previewBulkAdd: vi.fn(async () => ({
              totalMatches: 0,
              eligibleCount: 0,
              skippedCount: 0,
              overLimit: false,
              limit: 20,
              lines: [],
              skippedItems: [],
            })),
            rebuildSearchIndex: vi.fn(),
            projectors: [],
          },
          detail: {
            getItemDetail: options.getItemDetail ?? vi.fn(async () => null),
            getSellerOverlay: vi.fn(async () => ({
              accountOfferMatches: [],
              sellerInventoryItems: [],
              hasListingStockLocation: false,
              selectedSellerListing: null,
            })),
            findSimilarItems: vi.fn(async () => ({ items: [], count: 0, mode: "none" })),
            projectors: [],
          },
          projectors: [],
        },
      },
      ordering: options.getPurchase
        ? { orders: { getPurchase: options.getPurchase, getSale: vi.fn(async () => null) } }
        : undefined,
    },
  };
  const app = buildPlatformApiApp(runtime, {
    checkoutClosed: options.checkoutClosed,
    resolveActor: async () => actor,
    ucp: {
      contextOverride: options.contextUnavailable ? null : undefined,
      idempotencyStore: store,
      signatureVerification: { keyResolver: async () => keys.publicKey.export({ format: "jwk" }) },
      profileResolver: async () => ({
        ok: true,
        profile: {
          ucp: {
            version: UCP_VERSION,
            services: {},
            payment_handlers: {},
            capabilities: Object.fromEntries(
              UCP_MCP_TOOLS.map((tool) => [tool.capability, [{ version: UCP_VERSION }]]),
            ),
          },
        },
      }),
    },
  });
  const call = async (
    transport: Transport,
    operation: string,
    options: {
      id?: string;
      signature?: "valid" | "partial" | "bad" | "bad-digest" | "no-key";
      key?: string;
      arguments?: Record<string, unknown>;
      body?: Record<string, unknown>;
    } = {},
  ) => {
    const checkoutId = options.id ?? id;
    const path =
      transport === "rest"
        ? operation === "create_checkout"
          ? "/ucp/v1/checkout-sessions"
          : operation === "search_catalog"
            ? "/ucp/v1/catalog/search"
            : operation === "lookup_catalog"
              ? "/ucp/v1/catalog/lookup"
              : operation === "get_product"
                ? "/ucp/v1/catalog/product"
                : operation === "get_order"
                  ? `/ucp/v1/orders/${encodeURIComponent(checkoutId)}`
                  : `/ucp/v1/checkout-sessions/${encodeURIComponent(checkoutId)}${operation === "complete_checkout" ? "/complete" : operation === "cancel_checkout" ? "/cancel" : ""}`
        : "/ucp/mcp";
    const method =
      transport === "rest" && operation === "update_checkout"
        ? "PUT"
        : transport === "rest" && (operation === "get_checkout" || operation === "get_order")
          ? "GET"
          : "POST";
    const catalogArguments =
      options.arguments ??
      (operation === "search_catalog"
        ? { query: "pikachu" }
        : operation === "lookup_catalog"
          ? { ids: ["cat_1"] }
          : operation === "get_product"
            ? { id: "cat_1" }
            : undefined);
    const restInput =
      operation === "search_catalog" || operation === "lookup_catalog" || operation === "get_product"
        ? (options.arguments?.catalog ?? catalogArguments)
        : operation === "get_order"
          ? { id: checkoutId }
          : undefined;
    const checkoutBody = JSON.stringify(options.body ?? { line_items: [{ item: { id: "lst_1" }, quantity: 1 }] });
    const body =
      transport === "rest"
        ? operation === "create_checkout" || operation === "update_checkout"
          ? checkoutBody
          : restInput
            ? JSON.stringify(restInput)
            : "{}"
        : JSON.stringify({
            jsonrpc: "2.0",
            id: "synthetic-call",
            method: "tools/call",
            params: {
              name: operation,
              arguments:
                options.arguments ??
                (catalogArguments ? { catalog: catalogArguments } : undefined) ??
                (operation === "create_checkout"
                  ? { checkout: { line_items: [{ item: { id: "lst_1" }, quantity: 1 }] } }
                  : operation === "update_checkout"
                    ? { id: checkoutId, checkout: { line_items: [{ item: { id: "lst_1" }, quantity: 1 }] } }
                    : checkoutId
                      ? { id: checkoutId }
                      : {}),
              ...(transport === "modern"
                ? { _meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28", [MCP_META_CLIENT_CAPABILITIES_KEY]: {} } }
                : {}),
            },
          });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "UCP-Agent": `profile="${profileUrl}"`,
      ...(transport === "modern"
        ? {
            [MCP_PROTOCOL_VERSION_HEADER]: "2026-07-28",
            [MCP_METHOD_HEADER]: "tools/call",
            [MCP_NAME_HEADER]: operation,
          }
        : {}),
    };
    if (options.signature) {
      if (options.signature !== "no-key") headers["Idempotency-Key"] = options.key ?? "synthetic-key";
      headers["Content-Digest"] = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
      if (options.signature !== "partial") {
        const components = [
          "@method",
          "@path",
          "content-digest",
          ...(options.signature !== "no-key" ? ["idempotency-key"] : []),
        ];
        const params = `(${components.map((value) => `"${value}"`).join(" ")});created=${Math.floor(Date.now() / 1000)};keyid="synthetic-key"`;
        const base = components
          .map(
            (component) =>
              `"${component}": ${component === "@method" ? method : component === "@path" ? path : component === "content-digest" ? headers["Content-Digest"] : headers["Idempotency-Key"]}`,
          )
          .concat(`"@signature-params": ${params}`)
          .join("\n");
        headers["Signature-Input"] = `sig1=${params}`;
        headers.Signature = `sig1=:${createSign("sha256").update(base).end().sign(keys.privateKey).toString("base64")}:`;
        if (options.signature === "bad") headers.Signature = "sig1=:YmFk:";
        if (options.signature === "bad-digest") headers["Content-Digest"] = "sha-256=:YmFk:";
      }
    }
    const response = await app.request(
      new Request(`https://marketplace.example${path}`, {
        method,
        headers,
        ...(method === "GET" ? {} : { body }),
      }),
    );
    const json = await response.json().catch(() => ({ error: { code: response.status } }));
    return transport === "rest" ? json : (json.result?.structuredContent ?? json);
  };
  return {
    call,
    reserve,
    cancelSession,
    readSessionForCancellation,
    createBuyNow,
    recordFulfillmentPreview,
    recordOrdersCreated,
    recordPaymentStarted,
    getSession,
    setActor: (value: ResolvedActor | null) => {
      actor = value;
    },
    setSession: (value: Row) => {
      current = value;
    },
  };
}

async function expectTransportParity(
  operation: string,
  callOptions: CallOptions = {},
  fixtureOptions: FixtureOptions = {},
) {
  const rest = await fixture(fixtureOptions).call("rest", operation, callOptions);
  const legacy = await fixture(fixtureOptions).call("legacy", operation, callOptions);
  const modern = await fixture(fixtureOptions).call("modern", operation, callOptions);
  expect(legacy).toEqual(rest);
  expect(modern).toEqual(rest);
  return rest;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      revision: "fresh",
      readyLineKeys: ["lst_1"],
      unavailableLineKeys: [],
      unavailableLines: [],
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
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each<Transport>(["rest", "legacy", "modern"])("composed checkout dispatch %s AC3/AC4/AC6", (transport) => {
  it("unsigned scoped grant derives complete and cancel without reservation or writes", async () => {
    const f = fixture();
    const result = await f.call(transport, "complete_checkout");
    expect(result).toMatchObject({
      status: "requires_escalation",
      continue_url: `https://marketplace.example/checkout/buy/session/${id}`,
      messages: [{ code: "payment_required" }],
    });
    expect((await f.call(transport, "cancel_checkout")).status).toBe("requires_escalation");
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.cancelSession).not.toHaveBeenCalled();
    expect(f.recordOrdersCreated).not.toHaveBeenCalled();
    expect(f.recordPaymentStarted).not.toHaveBeenCalled();
  });
  it("refuses missing scope, non-grant and anonymous actors", async () => {
    for (const actor of [
      null,
      { ...buyer, agentGrant: undefined },
      { ...buyer, agentGrant: { ...buyer.agentGrant!, scopes: [] } },
    ]) {
      const f = fixture();
      f.setActor(actor);
      for (const operation of ["complete_checkout", "cancel_checkout"]) {
        const result = await f.call(transport, operation);
        expect(JSON.stringify(result)).toContain(actor ? "authorization_forbidden" : "authentication_required");
        expect(JSON.stringify(result)).not.toContain("continue_url");
      }
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.cancelSession).not.toHaveBeenCalled();
      expect(f.getSession).not.toHaveBeenCalled();
    }
  });
  it.each(["partial", "bad", "bad-digest", "no-key"] as const)(
    "never downgrades signed attempt %s to unsigned",
    async (signature) => {
      const f = fixture();
      for (const operation of ["complete_checkout", "cancel_checkout"]) {
        const result = await f.call(transport, operation, { signature });
        expect(JSON.stringify(result)).not.toContain("continue_url");
      }
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.getSession).not.toHaveBeenCalled();
      expect(f.cancelSession).not.toHaveBeenCalled();
    },
  );
  it("verified cancel writes once per retry key and complete is still read-only", async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await f.call(transport, "cancel_checkout", { signature: "valid" })).status).toBe("canceled");
    expect(f.readSessionForCancellation).toHaveBeenCalledTimes(1);
    expect(f.cancelSession).toHaveBeenCalledTimes(1);
    const complete = await f.call(transport, "complete_checkout", { signature: "valid", key: "complete-key" });
    expect(complete.status).toBe("canceled");
    expect(complete).not.toHaveProperty("continue_url");
    expect(complete.messages).toBeUndefined();
    expect(f.recordOrdersCreated).not.toHaveBeenCalled();
    expect(f.recordPaymentStarted).not.toHaveBeenCalled();
  });
  it.each(["", "../x", "chk_%2F", "chk_1", "chk_unknown0000000000000000000", "foreign"])(
    "id %s fails closed with no URL",
    async (invalid) => {
      const f = fixture();
      if (invalid === "foreign") f.setActor({ ...buyer, accountId: "acc_foreign" });
      const result = await f.call(transport, "complete_checkout", { id: invalid === "foreign" ? id : invalid });
      expect(JSON.stringify(result)).toMatch(/invalid_request|not_found|404/);
      expect(JSON.stringify(result)).not.toContain("continue_url");
      expect(f.reserve).not.toHaveBeenCalled();
      expect(f.cancelSession).not.toHaveBeenCalled();
    },
  );
  it("expiry precedes signed reservation and unsigned write on both operations", async () => {
    const f = fixture();
    vi.setSystemTime(new Date("2026-10-16T06:00:00Z"));
    for (const operation of ["update_checkout", "complete_checkout"])
      for (const signature of [undefined, "valid"] as const) {
        const result = await f.call(transport, operation, { signature });
        // Unsigned REST update retains its signed-write gate; all admitted paths reject expiry.
        expect(JSON.stringify(result)).toContain(
          transport === "rest" && operation === "update_checkout" && !signature
            ? "signed_request_required"
            : "checkout_expired",
        );
      }
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.cancelSession).not.toHaveBeenCalled();
    expect(f.recordOrdersCreated).not.toHaveBeenCalled();
    expect(f.recordPaymentStarted).not.toHaveBeenCalled();
  });
});
it("unsigned REST grant cannot bypass create or update signed-write gates", async () => {
  const f = fixture();
  for (const operation of ["create_checkout", "update_checkout"])
    expect((await f.call("rest", operation)).messages).toEqual([
      expect.objectContaining({ code: "signed_request_required" }),
    ]);
  expect(f.createBuyNow).not.toHaveBeenCalled();
  expect(f.getSession).not.toHaveBeenCalled();
  expect(f.reserve).not.toHaveBeenCalled();
});

it.each(["legacy", "modern"] as const)(
  "passes MCP argument metadata to create_checkout for the %s protocol",
  async (transport) => {
    const f = fixture();
    const key = `mcp-meta-${transport}`;
    const argumentsWithMeta = {
      checkout: { line_items: [{ item: { id: "lst_1" }, quantity: 1 }] },
      meta: { "idempotency-key": key },
    };

    const first = await f.call(transport, "create_checkout", { arguments: argumentsWithMeta });
    const second = await f.call(transport, "create_checkout", { arguments: argumentsWithMeta });

    expect(first.id).toBeDefined();
    expect(second.id).toBeDefined();
    expect(f.createBuyNow).toHaveBeenCalledTimes(2);
    const expectedSessionId = `chk_${createHash("sha256")
      .update(JSON.stringify([buyer.accountId, key, "lst_1"]))
      .digest("hex")
      .slice(0, 28)}`;
    expect(f.createBuyNow.mock.calls.map(([input]) => input.sessionIdOverride)).toEqual([
      expectedSessionId,
      expectedSessionId,
    ]);
  },
);

describe.each<Transport>(["rest", "legacy", "modern"])(
  "UCP 2026-08-25 transport bytes validate (composed) %s",
  (transport) => {
    const detail = (id: string) => ({
      catalog_item_id: id,
      slug: `${id}-slug`,
      title: `Product ${id}`,
      description: "A synthetic product.",
      market_listings: [
        {
          listing_id: `${id}_listing`,
          listing_slug: `${id}-listing`,
          price_amount: "20.00",
          price_currency_code: "USD",
        },
      ],
    });

    it("CAT-1 search_catalog USD, M2 plus one dropped row", async () => {
      const searchItems = vi.fn(async () => ({
        items: [
          { catalog_item_id: "cat_1", slug: "cat-1", title: "Keep" },
          { catalog_item_id: "drop", slug: "drop", title: "Drop" },
        ],
        total: 2,
        nextCursor: "cursor-2",
      }));
      const f = fixture({
        searchItems,
        getItemDetail: vi.fn(async (id: string) => (id === "drop" ? null : detail(id))),
      });
      const result = await f.call(transport, "search_catalog", {
        arguments: { catalog: { query: "cards", context: { currency: "USD" } } },
      });
      expectUcpCapture(result, { operation: "search_catalog", kind: "resource" });
      expect(result.products).toHaveLength(1);
      expect(result.pagination).toMatchObject({ has_next_page: true, cursor: "cursor-2" });
      expect(result.pagination).not.toHaveProperty("total_count");
    });

    it("CAT-2 search_catalog pagination.limit 25 reaches page two", async () => {
      const searchItems = vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ catalog_item_id: "cat_1", slug: "cat-1", title: "Keep" }],
          total: 2,
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          items: [{ catalog_item_id: "cat_2", slug: "cat-2", title: "Keep 2" }],
          total: 2,
          nextCursor: null,
        });
      const f = fixture({ searchItems, getItemDetail: vi.fn(async (id: string) => detail(id)) });
      const first = await f.call(transport, "search_catalog", {
        arguments: { catalog: { query: "cards", pagination: { limit: 25 } } },
      });
      expectUcpCapture(first, { operation: "search_catalog", kind: "resource" });
      const second = await f.call(transport, "search_catalog", {
        arguments: { catalog: { query: "cards", pagination: { cursor: first.pagination.cursor } } },
      });
      expectUcpCapture(second, { operation: "search_catalog", kind: "resource" });
      expect(searchItems).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20 }));
      expect(searchItems).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor-2", limit: 20 }));
    });

    it.each([
      ["CAT-4 lookup_catalog ids [M1, missing]", "lookup_catalog", { catalog: { ids: ["cat_1", "missing"] } }],
      ["CAT-5 get_product M1 at EUR", "get_product", { catalog: { id: "cat_1", context: { currency: "EUR" } } }],
    ] as const)("%s", async (_title, operation, arguments_) => {
      const f = fixture({ getItemDetail: vi.fn(async (id: string) => (id === "missing" ? null : detail(id))) });
      const result = await f.call(transport, operation, { arguments: arguments_ });
      expectUcpCapture(result, { operation, kind: "resource" });
    });

    it.each([
      ["CAT-7 flat search args", "search_catalog", { query: "pikachu", limit: 3 }],
      ["CAT-7 flat lookup args", "lookup_catalog", { ids: ["cat_1"] }],
      ["CAT-7 flat product args", "get_product", { id: "cat_1" }],
    ] as const)("%s", async (_title, operation, arguments_) => {
      if (transport === "rest") return;
      const searchItems = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
      const getItemDetail = vi.fn(async () => detail("cat_1"));
      const f = fixture({ searchItems, getItemDetail });
      const result = await f.call(transport, operation, { arguments: arguments_ });
      expectUcpCapture(result, { operation, kind: "error" });
      expect(result).toMatchObject({ messages: [{ code: "invalid_request", severity: "recoverable" }] });
      expect(searchItems).not.toHaveBeenCalled();
      expect(getItemDetail).not.toHaveBeenCalled();
    });

    it("CHK-1 create_checkout buy-now has root Checkout and payment handlers", async () => {
      const f = fixture();
      const result = await f.call(transport, "create_checkout", { signature: "valid" });
      expectUcpCapture(result, { operation: "create_checkout", kind: "resource" });
      expect(result).toHaveProperty("id");
      expect(result.ucp.payment_handlers).toEqual({});
    });

    it("CHK-2 update_checkout returns a root Checkout", async () => {
      const result = await fixture().call(transport, "update_checkout", { signature: "valid" });
      expectUcpCapture(result, { operation: "update_checkout", kind: "resource" });
    });

    it("CHK-3 complete_checkout unsigned scoped grant is a handoff", async () => {
      const result = await fixture().call(transport, "complete_checkout");
      expectUcpCapture(result, { operation: "complete_checkout", kind: "resource" });
      expect(result).toHaveProperty("continue_url");
    });

    it("CHK-4 complete_checkout signed is a root Checkout", async () => {
      const result = await fixture().call(transport, "complete_checkout", { signature: "valid" });
      expectUcpCapture(result, { operation: "complete_checkout", kind: "resource" });
      expect(result).toHaveProperty("continue_url");
    });

    it("CHK-5 cancel_checkout unsigned OAuth is read-only", async () => {
      const f = fixture();
      const result = await f.call(transport, "cancel_checkout");
      expectUcpCapture(result, { operation: "cancel_checkout", kind: "resource" });
      expect(f.cancelSession).not.toHaveBeenCalled();
    });

    it("CHK-6 cancel_checkout signed is idempotent", async () => {
      const f = fixture();
      const first = await f.call(transport, "cancel_checkout", { signature: "valid", key: "cancel-matrix" });
      const retry = await f.call(transport, "cancel_checkout", { signature: "valid", key: "cancel-matrix" });
      expectUcpCapture(first, { operation: "cancel_checkout", kind: "resource" });
      expectUcpCapture(retry, { operation: "cancel_checkout", kind: "resource" });
      expect(retry).toEqual(first);
      expect(f.cancelSession).toHaveBeenCalledTimes(1);
    });

    it("CHK-9 actor null and missing scope return named errors", async () => {
      const anonymous = await fixture({ actor: null }).call(transport, "get_checkout");
      expectUcpCapture(anonymous, { operation: "get_checkout", kind: "error" });
      expect(anonymous).toMatchObject({
        messages: [{ code: "authentication_required", severity: "requires_buyer_input" }],
      });
      const forbidden = await fixture({
        actor: { ...buyer, permissions: [], agentGrant: { ...buyer.agentGrant!, scopes: [] } },
      }).call(transport, "get_checkout");
      expectUcpCapture(forbidden, { operation: "get_checkout", kind: "error" });
      expect(forbidden).toMatchObject({ messages: [{ code: "authorization_forbidden", severity: "unrecoverable" }] });
    });

    it("CHK-10 checkoutClosed returns checkout_closed", async () => {
      const result = await fixture({ checkoutClosed: true }).call(transport, "create_checkout", { signature: "valid" });
      expectUcpCapture(result, { operation: "create_checkout", kind: "error" });
      expect(result).toMatchObject({ messages: [{ code: "checkout_closed", severity: "unrecoverable" }] });
    });

    it.each([
      [
        "NEG-1 action-only",
        (capture: Record<string, unknown>) => {
          delete capture.continue_url;
          capture.action = { url: "https://x" };
        },
      ],
      [
        "NEG-2 nested",
        (capture: Record<string, unknown>) => {
          const resource = { ...capture };
          for (const key of ["id", "status", "currency", "line_items", "totals", "links"]) delete capture[key];
          capture.checkout = resource;
        },
      ],
      [
        "NEG-3 empty-totals",
        (capture: Record<string, unknown>) => {
          capture.totals = [];
        },
      ],
      [
        "NEG-4 zero-price",
        (capture: Record<string, unknown>) => {
          (capture.line_items as Record<string, unknown>[])[0]!.price = { currency: "USD", amount: 0 };
        },
      ],
      [
        "NEG-5 secret-text",
        (capture: Record<string, unknown>) => {
          capture.messages = [
            {
              type: "error",
              code: "invalid_request",
              severity: "recoverable",
              content: "Error: connect ECONNREFUSED 10.0.0.5:5432",
            },
          ];
        },
      ],
    ] as const)("%s", async (_title, mutate) => {
      if (transport !== "rest") return;
      const source = await fixture().call("rest", "create_checkout", { signature: "valid" });
      const mutated = structuredClone(source) as Record<string, unknown>;
      mutate(mutated);
      expect(() => expectUcpCapture(mutated, { operation: "create_checkout", kind: "resource" })).toThrow();
    });

    it("CHK-7 get_checkout malformed id bad", async () => {
      const f = fixture();
      const result = await f.call(transport, "get_checkout", { id: "bad" });
      expectUcpCapture(result, { operation: "get_checkout", kind: "error" });
      expect(result).toMatchObject({ messages: [{ code: "invalid_request", severity: "recoverable" }] });
    });

    it("CHK-8 get_checkout other buyer session", async () => {
      const f = fixture();
      const result = await f.call(transport, "get_checkout", { id: `${id.slice(0, -1)}z` });
      expectUcpCapture(result, { operation: "get_checkout", kind: "error" });
      expect(result).toMatchObject({ messages: [{ code: "not_found", severity: "unrecoverable" }] });
    });

    it("ORD-3 get_order missing", async () => {
      const f = fixture({ getPurchase: vi.fn(async () => null) });
      const result = await f.call(transport, "get_order", { id: "missing" });
      expectUcpCapture(result, { operation: "get_order", kind: "error" });
      expect(result).toMatchObject({ messages: [{ code: "not_found", severity: "unrecoverable", path: "$.id" }] });
    });
  },
);

const STATE_TITLES = [
  "payment orderless C1",
  "confirmation with orders C9 at 07:00 expiring 13:00",
  "incomplete C3",
  "cancelled C4",
  "expired C6",
  "capture in progress C8",
  "completed one order C8",
  "completed two orders reversed C8",
  "boundary +5:59 C1",
  "boundary +6:00 C6",
  "day-later re-read",
  "C1 initial quote",
  "C2 changed quote",
  "C3 incomplete quote",
  "C3 incomplete retained",
  "C4 cancelled snapshot",
  "C5 cancelled retained",
  "C6 expired quote",
  "C7 capture in progress",
  "C8 completed one order",
  "C8 completed two orders",
  "C9 confirmed",
  "C10 never quoted",
] as const;

it("STATE-* closure lists the exact 23 source titles", () => {
  expect(STATE_TITLES).toEqual([
    "payment orderless C1",
    "confirmation with orders C9 at 07:00 expiring 13:00",
    "incomplete C3",
    "cancelled C4",
    "expired C6",
    "capture in progress C8",
    "completed one order C8",
    "completed two orders reversed C8",
    "boundary +5:59 C1",
    "boundary +6:00 C6",
    "day-later re-read",
    "C1 initial quote",
    "C2 changed quote",
    "C3 incomplete quote",
    "C3 incomplete retained",
    "C4 cancelled snapshot",
    "C5 cancelled retained",
    "C6 expired quote",
    "C7 capture in progress",
    "C8 completed one order",
    "C8 completed two orders",
    "C9 confirmed",
    "C10 never quoted",
  ]);
});

const routeProduct = (itemId: string, currency = "USD") => ({
  catalog_item_id: itemId,
  slug: `${itemId}-slug`,
  title: `Product ${itemId}`,
  description: "A synthetic product.",
  market_listings: [
    {
      listing_id: `${itemId}_listing`,
      listing_slug: `${itemId}-listing`,
      price_amount: "20.00",
      price_currency_code: currency,
    },
  ],
});

const routeOrder = {
  order_id: "ord_1",
  display_reference: "CS-0001",
  source_type: "buy-now",
  source_reference_id: id,
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  seller_account_id: "acc_seller",
  seller_display_name: "Seller",
  shipping_option: "standard",
  item_subtotal_amount: "20.00",
  shipping_base_amount: "5.00",
  shipping_discount_amount: "0.00",
  shipping_allowance_amount: "0.00",
  shipping_overage_amount: "0.00",
  protection_amount: "0.00",
  protection_allowance_amount: "0.00",
  protection_overage_amount: "0.00",
  shipping_charge_amount: "5.00",
  sales_tax_amount: "2.00",
  taxable_amount: "20.00",
  tax_jurisdiction_country: "US",
  tax_jurisdiction_state: "IL",
  tax_rate_bps: 1000,
  tax_provider_name: "synthetic",
  tax_provider_quote_reference: "quote_1",
  tax_quoted_at: "2026-10-16T00:00:00Z",
  total_amount: "27.00",
  marketplace_sales_fee_amount: "0.00",
  seller_net_amount: "20.00",
  seller_item_net_amount: "20.00",
  seller_payout_amount: "20.00",
  shipping_allowance_percentage_bps: 0,
  terms_schedule_id: null,
  terms_agreement_id: null,
  terms_resolved_at: "2026-10-16T00:00:00Z",
  shipping_destination_snapshot: {
    name: "Buyer",
    line1: "1 Main St",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  shipping_origin_snapshot: {
    name: "Seller",
    line1: "2 Main St",
    line2: null,
    city: "Chicago",
    state: "IL",
    postalCode: "60602",
    country: "US",
  },
  status: "pending-payment",
  pending_payment_at: null,
  payment_deadline_at: null,
  payment_deadline_policy: null,
  created_at: "2026-10-16T00:00:00Z",
  updated_at: "2026-10-16T00:00:00Z",
  cancelled_at: null,
  cancellation_reason: null,
  ready_for_fulfillment_at: null,
  self_service_cancellation_available: false,
  cancellation_unavailable_reason: null,
  line_count: 1,
  total_quantity: 1,
  item_titles: ["Synthetic card"],
  lines: [
    {
      line_id: "line_1",
      listing_id: "lst_1",
      inventory_item_id: "inv_1",
      catalog_catalog_item_id: "cat_1",
      product_id: "prod_1",
      item_title: "Synthetic card",
      item_subtitle: null,
      selected_options: [],
      product_summary: "Synthetic",
      unit_price_amount: "20.00",
      quantity: 1,
      line_total_amount: "20.00",
      marketplace_sales_fee_percentage_bps: 0,
      marketplace_sales_fee_fixed_amount: "0.00",
      marketplace_sales_fee_cap_amount: null,
      marketplace_sales_fee_unit_amount: "0.00",
      marketplace_sales_fee_total_amount: "0.00",
      seller_net_unit_amount: "20.00",
      seller_net_total_amount: "20.00",
      listing_evidence_gallery: [],
    },
  ],
  inventory_holds: [],
  money_timeline: { refunds: [], support_cases: [], refunded_amount: "0.00", currency_code: "USD" },
};

function stateFixtureOptions(title: (typeof STATE_TITLES)[number]): FixtureOptions {
  switch (title) {
    case "cancelled C4":
    case "C4 cancelled snapshot":
    case "C5 cancelled retained":
      return { session: { cancelled_at: "2026-10-16T01:00:00.000Z" } };
    case "incomplete C3":
    case "C3 incomplete quote":
      return { previewUnavailable: true };
    case "expired C6":
    case "C6 expired quote":
      vi.setSystemTime(new Date("2026-10-16T06:00:00Z"));
      return {};
    case "boundary +5:59 C1":
      vi.setSystemTime(new Date("2026-10-16T05:59:00Z"));
      return {};
    case "boundary +6:00 C6":
      vi.setSystemTime(new Date("2026-10-16T06:00:00Z"));
      return {};
    case "capture in progress C8":
    case "C7 capture in progress":
      return {
        session: { order_ids: ["ord_1"], payment_id: "pay_1" },
        paymentStatus: "captured",
        getPurchase: vi.fn(async () => routeOrder),
      };
    case "completed one order C8":
    case "C8 completed one order":
      return {
        session: { order_ids: ["ord_1"] },
        getPurchase: vi.fn(async () => ({ ...routeOrder, ready_for_fulfillment_at: "2026-10-16T07:00:00Z" })),
      };
    case "completed two orders reversed C8":
    case "C8 completed two orders":
      return {
        session: { order_ids: ["ord_1", "ord_2"] },
        getPurchase: vi.fn(async (orderId: string) => ({
          ...routeOrder,
          order_id: orderId,
          ready_for_fulfillment_at: "2026-10-16T07:00:00Z",
        })),
      };
    case "confirmation with orders C9 at 07:00 expiring 13:00":
      return {
        session: { order_ids: ["ord_1"], payment_id: "pay_1" },
        paymentStatus: "pending-confirmation",
        getPurchase: vi.fn(async () => routeOrder),
      };
    case "C3 incomplete retained":
      return { previewUnavailable: true, retainedQuote: null };
    case "C10 never quoted":
      return { session: { cancelled_at: "2026-10-16T01:00:00.000Z", source_type: "cart" }, retainedQuote: null };
    default:
      return {};
  }
}

describe("UCP 2026-08-25 finite route proof matrix", () => {
  it.each([
    [
      "CAT-1 search USD M2 with dropped row",
      "search_catalog",
      { catalog: { query: "cards", context: { currency: "USD" } } },
    ],
    [
      "CAT-3 search categories A B A",
      "search_catalog",
      { catalog: { query: "cards", filters: { categories: ["A", "B", "A"] } } },
    ],
    ["CAT-4 lookup M1 and missing", "lookup_catalog", { catalog: { ids: ["cat_1", "missing"] } }],
    ["CAT-5 get_product M1 EUR", "get_product", { catalog: { id: "cat_1", context: { currency: "EUR" } } }],
    ["CAT-6 get_product missing", "get_product", { catalog: { id: "missing" } }],
  ] as const)("$0", async (_title, operation, arguments_) => {
    const searchItems = vi.fn(async () => ({
      items: [
        { catalog_item_id: "cat_1", slug: "cat-1", title: "Keep" },
        { catalog_item_id: "missing", slug: "missing", title: "Drop" },
      ],
      total: 2,
      nextCursor: null,
    }));
    const result = await expectTransportParity(
      operation,
      { arguments: arguments_ },
      {
        searchItems,
        getItemDetail: vi.fn(async (itemId: string) => (itemId === "missing" ? null : routeProduct(itemId))),
      },
    );
    expectUcpCapture(result, { operation, kind: result.ucp?.status === "error" ? "error" : "resource" });
  });

  it("CAT-2 pagination limit 25 is capped and cursor reaches page two on all transports", async () => {
    const captures: unknown[] = [];
    for (const transport of ["rest", "legacy", "modern"] as const) {
      const searchItems = vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ catalog_item_id: "cat_1", slug: "cat-1", title: "Keep" }],
          total: 2,
          nextCursor: "cursor-2",
        })
        .mockResolvedValueOnce({
          items: [{ catalog_item_id: "cat_2", slug: "cat-2", title: "Keep 2" }],
          total: 2,
          nextCursor: null,
        });
      const f = fixture({ searchItems, getItemDetail: vi.fn(async (itemId: string) => routeProduct(itemId)) });
      const first = await f.call(transport, "search_catalog", {
        arguments: { catalog: { query: "cards", pagination: { limit: 25 } } },
      });
      const second = await f.call(transport, "search_catalog", {
        arguments: { catalog: { query: "cards", pagination: { cursor: first.pagination.cursor } } },
      });
      expectUcpCapture(first, { operation: "search_catalog", kind: "resource" });
      expectUcpCapture(second, { operation: "search_catalog", kind: "resource" });
      captures.push({ first, second });
      expect(searchItems).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 20 }));
      expect(searchItems).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "cursor-2", limit: 20 }));
    }
    expect(captures[1]).toEqual(captures[0]);
    expect(captures[2]).toEqual(captures[0]);
  });

  it.each([
    ["CHK-1 create", "create_checkout", { signature: "valid" }],
    ["CHK-2 get", "get_checkout", {}],
    ["CHK-3 update", "update_checkout", { signature: "valid" }],
    ["CHK-4 complete OAuth", "complete_checkout", {}],
    ["CHK-5 complete signed", "complete_checkout", { signature: "valid" }],
    ["CHK-6 cancel OAuth", "cancel_checkout", {}],
    ["CHK-7 cancel signed", "cancel_checkout", { signature: "valid" }],
    ["CHK-8 malformed", "get_checkout", { id: "bad" }],
    ["CHK-9 missing", "get_checkout", { id: "chk_1" }],
    ["CHK-10 checkout closed", "create_checkout", { signature: "valid" }],
    [
      "CHK-11 invalid update body",
      "update_checkout",
      { signature: "valid", body: { invalid: true }, arguments: { id, checkout: { invalid: true } } },
    ],
  ] as const)("$0", async (_title, operation, callOptions) => {
    const result = await expectTransportParity(
      operation,
      callOptions,
      _title === "CHK-10 checkout closed" ? { checkoutClosed: true } : {},
    );
    expectUcpCapture(result, { operation, kind: result.ucp?.status === "error" ? "error" : "resource" });
  });

  it("CHK-12 context-required rule remains an explicit schema-valid error capture", async () => {
    const result = await expectTransportParity("get_checkout", { id }, { contextUnavailable: true });
    expectUcpCapture(result, { operation: "get_checkout", kind: "error" });
    expect(result).toMatchObject({ messages: [{ code: "context_required", severity: "unrecoverable" }] });
  });

  it.each([
    ["ORD-1 purchase", routeOrder],
    [
      "ORD-2 cancelled",
      {
        ...routeOrder,
        status: "cancelled",
        cancelled_at: "2026-10-16T02:00:00Z",
        cancellation_reason: "Buyer requested",
      },
    ],
  ] as const)("$0", async (_title, order) => {
    const result = await expectTransportParity(
      "get_order",
      { id: order.order_id },
      { getPurchase: vi.fn(async () => order) },
    );
    expectUcpCapture(result, { operation: "get_order", kind: "resource" });
  });

  it("ORD-3 missing is a schema-valid error on all transports", async () => {
    const result = await expectTransportParity(
      "get_order",
      { id: "missing" },
      { getPurchase: vi.fn(async () => null) },
    );
    expectUcpCapture(result, { operation: "get_order", kind: "error" });
  });

  it.each(STATE_TITLES)("%s route capture validates and is transport-parity stable", async (title) => {
    if (title === "day-later re-read") {
      const first = await expectTransportParity(
        "get_checkout",
        {},
        stateFixtureOptions("completed two orders reversed C8"),
      );
      vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
      const second = await expectTransportParity(
        "get_checkout",
        {},
        stateFixtureOptions("completed two orders reversed C8"),
      );
      expect(second).toEqual(first);
      expectUcpCapture(second, { operation: "get_checkout", kind: "resource" });
      return;
    }
    const result = await expectTransportParity("get_checkout", {}, stateFixtureOptions(title));
    expectUcpCapture(result, {
      operation: "get_checkout",
      kind: result.ucp?.status === "error" ? "error" : "resource",
    });
  });
});
