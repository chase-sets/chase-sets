import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { buildAccountCapabilityRegistry } from "@chase-sets/platform-runtime/api";
import {
  UCP_VERSION,
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

function fixture() {
  let actor: ResolvedActor | null = buyer;
  let current = row();
  const createdSessionIds = new Set<string>();
  const getSession = vi.fn(async (sessionId: string, accountId: string) =>
    (sessionId === id || createdSessionIds.has(sessionId)) && accountId === current.buyer_account_id ? current : null,
  );
  const cancelSession = vi.fn(async () => ({
    sessionId: id,
    session: (current = { ...current, cancelled_at: new Date().toISOString() }),
  }));
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
          createBuyNow,
          recordFulfillmentPreview,
          recordOrdersCreated,
          recordPaymentStarted,
          getLastRecordedQuote: vi.fn(async () => ({
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
          })),
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
        },
      },
    },
  };
  const app = buildPlatformApiApp(runtime, {
    resolveActor: async () => actor,
    ucp: {
      idempotencyStore: store,
      signatureVerification: { keyResolver: async () => keys.publicKey.export({ format: "jwk" }) },
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
  });
  const call = async (
    transport: Transport,
    operation: string,
    options: {
      id?: string;
      signature?: "valid" | "partial" | "bad" | "bad-digest" | "no-key";
      key?: string;
      arguments?: Record<string, unknown>;
    } = {},
  ) => {
    const checkoutId = options.id ?? id;
    const path =
      transport === "rest"
        ? operation === "create_checkout"
          ? "/ucp/v1/checkout-sessions"
          : `/ucp/v1/checkout-sessions/${encodeURIComponent(checkoutId)}${operation === "complete_checkout" ? "/complete" : operation === "cancel_checkout" ? "/cancel" : ""}`
        : "/ucp/mcp";
    const method = transport === "rest" && operation === "update_checkout" ? "PUT" : "POST";
    const body =
      transport === "rest"
        ? "{}"
        : JSON.stringify({
            jsonrpc: "2.0",
            id: "synthetic-call",
            method: "tools/call",
            params: {
              name: operation,
              arguments: options.arguments ?? (checkoutId ? { id: checkoutId } : {}),
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
    const response = await app.request(new Request(`https://marketplace.example${path}`, { method, headers, body }));
    const json = await response.json().catch(() => ({ error: { code: response.status } }));
    return transport === "rest" ? json : (json.result?.structuredContent ?? json);
  };
  return {
    call,
    reserve,
    cancelSession,
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
      messages: [{ code: "payment_required", severity: "requires_buyer_input" }],
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
