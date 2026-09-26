import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_META_CLIENT_INFO_KEY,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_PROTOCOL_VERSION_HEADER,
} from "@chase-sets/platform-runtime/mcp-protocol";
import type { McpAuditSink, McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as orderingModule } from "@chase-sets/ordering";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import * as orderingServer from "@chase-sets/ordering/server";
import * as paymentsServer from "@chase-sets/payments/server";
import type { PaymentsPaymentDetail } from "@chase-sets/payments/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { ProviderWebhookError } from "@chase-sets/http/provider-errors";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { quoteMarketplaceCheckoutFee } from "@chase-sets/payments/server";
import {
  buildAccountCapabilityRegistry,
  resolveApiHostMounts,
  type ApiHostRuntime,
} from "@chase-sets/platform-runtime/api";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { buildPlatformApiApp, type BuildPlatformApiOptions } from "../src/app";
import { createCheckoutClosedMiddleware } from "../src/middleware/checkout-closed";
import type { TenantContextEnv } from "../src/middleware/auth-context";

afterEach(() => vi.restoreAllMocks());

type PaymentRuntime = ReturnType<typeof paymentsModule.createServices>["payments"];
const memoryStores = vi.hoisted(() => new WeakMap<object, ReturnType<typeof createInMemoryEventStore>>());
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  return {
    ...actual,
    createPostgresEventStore: (options: Parameters<typeof actual.createPostgresEventStore>[0]) =>
      memoryStores.get(options.pool)?.eventStore ?? actual.createPostgresEventStore(options),
  };
});

function memoryPool(
  store: ReturnType<typeof createInMemoryEventStore>,
  query: PgQueryable["query"],
): PgTransactionalPool {
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  memoryStores.set(pool, store);
  return pool;
}

const shippingAddress = {
  name: "Synthetic Buyer",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: null,
};
const supplyPreview: orderingServer.CheckoutFulfillmentPreview = {
  revision: "synthetic-supply-ready",
  optimizationGoal: "lowest-total",
  readyLineKeys: ["lst_synthetic"],
  unavailableLineKeys: [],
  sellerGroups: [],
  totals: {
    itemSubtotalAmount: "20.00",
    shippingAmount: "0.00",
    salesTaxAmount: "0.00",
    totalAmount: "20.00",
    packageCount: 1,
  },
  unavailableLines: [],
  materialChangeReasons: [],
};

function stubOrderingTransport() {
  const original = orderingServer.createOrderingRequestApiClient;
  const preview = vi.fn<ReturnType<typeof original>["previewCheckoutFulfillment"]>().mockResolvedValue(supplyPreview);
  const create = vi.fn<ReturnType<typeof original>["createCheckoutOrders"]>();
  vi.spyOn(orderingServer, "createOrderingRequestApiClient").mockImplementation((...args) => ({
    ...original(...args),
    previewCheckoutFulfillment: preview,
    createCheckoutOrders: create,
  }));
  return { preview, create };
}

function fixture(checkoutServices?: ReturnType<typeof checkoutModule.createServices>, paymentRuntime?: PaymentRuntime) {
  const outside = vi.fn((): never => {
    throw new Error("Synthetic fixture forbids database access");
  });
  const pool: PgTransactionalPool = { query: outside, connect: outside };
  const payments = {
    ...paymentsModule.createServices(pool, {}),
    ...(paymentRuntime ? { payments: paymentRuntime } : {}),
  };
  const recordCheckoutEvent =
    vi.fn<
      NonNullable<
        Parameters<typeof checkoutModule.createServices>[1]["checkoutObservabilityTelemetry"]
      >["recordCheckoutEvent"]
    >();
  const checkout =
    checkoutServices ??
    checkoutModule.createServices(pool, { checkoutObservabilityTelemetry: { recordCheckoutEvent } });
  const ordering = orderingModule.createServices(pool, { inventoryCleanupAuthority: { kind: "not-mounted" } });
  const createAccountPayment = vi.spyOn(payments.payments, "createAccountPayment");
  const recoverCheckoutPayment = vi.spyOn(payments.payments, "recoverCheckoutPayment");
  if (!paymentRuntime) {
    createAccountPayment.mockRejectedValue(new Error("Synthetic rejected start"));
    recoverCheckoutPayment.mockRejectedValue(new Error("Synthetic rejected recovery"));
  }
  const mountedModules = [
    { module: paymentsModule, services: payments },
    { module: checkoutModule, services: checkout },
    { module: orderingModule, services: ordering },
  ];
  const runtime: ApiHostRuntime = {
    accountCapabilityRegistry: buildAccountCapabilityRegistry(
      mountedModules.map(({ module }) => ({ contextName: module.contextName, module })),
    ),
    mountedContexts: mountedModules.map((entry) => ({
      ...entry,
      contextName: entry.module.contextName,
      mountRole: "active",
      pool,
      projectionHandlerSets: [],
    })),
    mountedModules,
    services: { payments, checkout, ordering, auth: {}, identity: {} },
    projectionGroups: mountedModules.flatMap(({ module }) =>
      (module.projectionGroups ?? []).map((group) => ({
        ...group,
        projectionRevision: group.projectionRevision ?? 1,
        targetContextName: module.contextName,
        optionalSourceContextNames: group.optionalSourceContextNames ?? [],
        requiredDuringBootstrap: group.requiredDuringBootstrap ?? false,
        subscriptionRunners: [],
        reset: outside,
        getStatus: outside,
        refreshStatus: outside,
        markRevisionSynced: outside,
      })),
    ),
    subscriptionRunners: [],
  };
  const options: BuildPlatformApiOptions = {
    resolveActor: async (request): Promise<ResolvedActor | null> => {
      const roleKey = request.headers.get("x-test-role") ?? "owner";
      if (roleKey === "anonymous") return null;
      return {
        sessionId: "ses_synthetic",
        tenantId: "tnt_synthetic",
        userId: "usr_synthetic",
        accountId: request.headers.get("x-test-account") ?? "acc_synthetic",
        membershipId: "mbr_synthetic",
        roleKey,
        permissions:
          roleKey === "forbidden"
            ? []
            : roleKey.startsWith("guest")
              ? ["guest-checkout.manage"]
              : ["orders.manage", "orders.view"],
      };
    },
  };
  const open = buildPlatformApiApp(runtime, options);
  const closed = buildPlatformApiApp(runtime, { ...options, checkoutClosed: true });
  return {
    runtime,
    options,
    open,
    closed,
    payments,
    checkout,
    ordering,
    createAccountPayment,
    recoverCheckoutPayment,
    recordCheckoutEvent,
    outside,
  };
}

const paymentPaths = ["/payments", "/checkout/recover"];
type CartLine = Awaited<
  ReturnType<ReturnType<typeof checkoutModule.createServices>["cart"]["listAuthorizedCartLines"]>
>[number];
function retainedCartLine(lineId: string): CartLine {
  return {
    buyer_account_id: "acc_synthetic",
    line_id: lineId,
    catalog_catalog_item_id: "cat_synthetic",
    product_id: "cat_synthetic::",
    item_language_code: null,
    item_title: "Synthetic item",
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
    locked_listing_id: "lst_synthetic",
    selected_listing_id: null,
    selected_listing_seller_account_id: null,
    selected_listing_seller_display_name: null,
    selected_listing_seller_slug: null,
    selected_listing_price_amount: null,
    selected_listing_snapshot_source: null,
    selected_listing_snapshot_captured_at: null,
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [
      {
        listing_id: "lst_synthetic",
        seller_account_id: "acc_seller",
        seller_slug: "synthetic-seller",
        seller_display_name: "Synthetic seller",
        seller_average_rating: null,
        seller_review_count: 0,
        price_amount: "20.00",
        price_currency_code: "USD",
        listing_stream_version: 1,
        available_quantity: 1,
        product_summary: null,
        product_measure_snapshot: {
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          selectedOptions: [],
          measureVersion: "synthetic-v1",
          unitLengthInches: 3.5,
          unitWidthInches: 2.5,
          unitHeightInches: 0.02,
          unitWeightOunces: 0.08,
          physicalFlags: ["raw-card"],
          stackBehavior: "stackable-thickness",
          source: "profile",
          confidence: "measured",
        },
      },
    ],
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:00:00.000Z",
  };
}
const closedRoutes = [
  "/account/checkout-sessions",
  ...[
    "shipping-option",
    "authenticity-check-opt-in",
    "shipping-address",
    "fulfillment-preview",
    "optimization-goal",
    "confirm",
  ].map((action) => `/account/checkout-sessions/:sessionId/${action}`),
  "/account/purchases/checkout",
  "/account/purchases/checkout/preview",
  "/account/payments",
  "/account/checkout/recover",
].map((path) => `POST /api/marketplace${path}`);
const preservedRoutes = [
  ...["account", "guest"].flatMap((actor) => [
    ...["", "/readiness", "/bulk", "/:lineId/quantity", "/:lineId/fulfillment", "/:lineId/remove"].map(
      (suffix) => `POST /api/marketplace/${actor}/cart${suffix}`,
    ),
    ...["", "/readiness", "/:lineId/remove"].map((suffix) => `POST /api/marketplace/${actor}/sell-list${suffix}`),
  ]),
  "POST /api/marketplace/guest/cart/merge-to-account",
  "POST /api/marketplace/guest/sell-list/merge-to-account",
  "POST /api/marketplace/account/sell-list/confirm",
  "POST /api/marketplace/account/purchases/:id/cancel",
  "POST /api/marketplace/account/sales/:id/cancel",
  ...[
    "setup-sessions",
    "setup-sessions/:processorSetupReference/reconcile",
    ":instrumentId/default",
    ":instrumentId/remove",
    "reconcile",
  ].map((suffix) => `POST /api/marketplace/account/payment-methods/${suffix}`),
  ...["", "/preview", "/:id/activate", "/:id/clone", "/:id/retire"].map(
    (suffix) => `POST /api/marketplace/admin/postage-policies${suffix}`,
  ),
  "PUT /api/marketplace/admin/postage-policies/:id",
  "POST /api/payments/provider/webhooks",
];

function mountedWrites(runtime: ApiHostRuntime) {
  return [
    ...new Set(
      resolveApiHostMounts(runtime).flatMap((mount) => {
        if (!(mount.router instanceof Hono)) throw new Error(`Unknown router for ${mount.contextName}`);
        return mount.router.routes
          .filter((route) => route.method !== "GET" && route.method !== "ALL")
          .map((route) => `${route.method} ${mount.mountPath}${route.path === "/" ? "" : route.path}`);
      }),
    ),
  ].sort();
}

function ucpHeaders(body: string, key: string) {
  return {
    "content-type": "application/json",
    "UCP-Agent": 'profile="https://synthetic.example/.well-known/ucp"',
    "Idempotency-Key": key,
    "Signature-Input": 'sig1=("@method" "@path" "content-digest");created=1778940000',
    Signature: "sig1=:synthetic:",
    "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
  };
}

function syntheticPayment(paymentId: string, orderId: string): PaymentsPaymentDetail {
  return {
    payment_id: paymentId,
    buyer_account_id: "acc_synthetic",
    order_ids: [orderId],
    amount: "20.00",
    balance_credit_amount: "0.00",
    processor_amount: "20.00",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.00",
    marketplace_checkout_fee_policy_version: null,
    marketplace_checkout_fee_quote_fingerprint: null,
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "19.00",
    seller_payout_amount: "19.00",
    seller_payouts: [],
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "checkout-session",
    processor_payment_reference: `cs_synthetic_${paymentId}`,
    processor_client_secret: null,
    processor_redirect_url: null,
    processor_status: "open",
    source_context: "checkout",
    source_reference_id: null,
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
    processor_publishable_key: null,
    provider_events: [],
  };
}

function nativeTool(
  app: ReturnType<typeof buildPlatformApiApp>,
  name: string,
  args: Record<string, unknown>,
  key: string,
) {
  const confirmationText = name === "checkout.cancel-session" ? "Cancel Checkout Session." : "Select Saved Address.";
  const mutation = name !== "checkout.get-cart";
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2026_07_28,
      [MCP_METHOD_HEADER]: "tools/call",
      [MCP_NAME_HEADER]: name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: key,
      method: "tools/call",
      params: {
        name,
        arguments: {
          accountId: "acc_synthetic",
          ...(mutation ? { idempotencyKey: key, confirmationText } : {}),
          ...args,
        },
        ...(mutation ? { confirmation: { confirmed: true, text: confirmationText } } : {}),
        _meta: {
          [MCP_META_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION_2026_07_28,
          [MCP_META_CLIENT_INFO_KEY]: { name: "synthetic-checkout-closed", version: "1" },
          [MCP_META_CLIENT_CAPABILITIES_KEY]: {},
        },
      },
    }),
  });
}

async function ucpReadOrCancel(
  app: ReturnType<typeof buildPlatformApiApp>,
  operation: "get_checkout" | "cancel_checkout" | "get_order",
  id: string,
  transport: "rest" | "mcp",
) {
  const args = { id };
  const body = JSON.stringify(
    transport === "mcp"
      ? { jsonrpc: "2.0", id: operation, method: "tools/call", params: { name: operation, arguments: args } }
      : args,
  );
  const path =
    operation === "get_order"
      ? `/orders/${id}`
      : `/checkout-sessions/${id}${operation === "cancel_checkout" ? "/cancel" : ""}`;
  const method = transport === "mcp" || operation === "cancel_checkout" ? "POST" : "GET";
  const response = await app.request(transport === "mcp" ? "/ucp/mcp" : `/ucp/v1${path}`, {
    method,
    ...(method === "POST" ? { body } : {}),
    headers: ucpHeaders(method === "POST" ? body : "", `${transport}-${operation}-${id}`),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  return transport === "mcp" ? result.result.structuredContent : result;
}

describe("checkout-closed-agent-rails", () => {
  it("preserves order reads through both closed UCP transports", async () => {
    const f = fixture();
    const order: NonNullable<Awaited<ReturnType<typeof f.ordering.orders.getPurchase>>> = {
      order_id: "ord_synthetic",
      display_reference: "SYNTHETIC",
      source_type: "cart-checkout",
      source_reference_id: "chk_synthetic",
      buyer_account_id: "acc_synthetic",
      buyer_display_name: null,
      seller_account_id: "acc_seller",
      seller_display_name: null,
      shipping_option: "standard",
      item_subtotal_amount: "20.00",
      shipping_base_amount: "0.00",
      shipping_discount_amount: "0.00",
      shipping_allowance_amount: "0.00",
      shipping_overage_amount: "0.00",
      protection_amount: "0.00",
      protection_allowance_amount: "0.00",
      protection_overage_amount: "0.00",
      shipping_charge_amount: "0.00",
      sales_tax_amount: "0.00",
      taxable_amount: "20.00",
      tax_jurisdiction_country: "US",
      tax_jurisdiction_state: "IL",
      tax_rate_bps: 0,
      tax_provider_name: "synthetic",
      tax_provider_quote_reference: null,
      tax_quoted_at: "2026-09-22T00:00:00.000Z",
      total_amount: "20.00",
      marketplace_sales_fee_amount: "1.00",
      seller_net_amount: "19.00",
      seller_item_net_amount: "19.00",
      seller_payout_amount: "19.00",
      shipping_allowance_percentage_bps: 0,
      terms_schedule_id: null,
      terms_agreement_id: null,
      terms_resolved_at: "2026-09-22T00:00:00.000Z",
      shipping_destination_snapshot: shippingAddress,
      shipping_origin_snapshot: shippingAddress,
      status: "pending-payment",
      pending_payment_at: "2026-09-22T00:00:00.000Z",
      payment_deadline_at: null,
      payment_deadline_policy: null,
      created_at: "2026-09-22T00:00:00.000Z",
      updated_at: "2026-09-22T00:00:00.000Z",
      cancelled_at: null,
      cancellation_reason: null,
      ready_for_fulfillment_at: null,
      self_service_cancellation_available: false,
      cancellation_unavailable_reason: "payment-pending",
      line_count: 0,
      total_quantity: 0,
      item_titles: [],
      lines: [],
      inventory_holds: [],
      money_timeline: { refunds: [], support_cases: [], refunded_amount: "0.00", currency_code: "usd" },
    };
    const read = vi.spyOn(f.ordering.orders, "getPurchase").mockResolvedValue(order);
    for (const transport of ["rest", "mcp"] as const) {
      expect(await ucpReadOrCancel(f.closed, "get_order", order.order_id, transport)).toMatchObject({
        ucp: { status: "ok" },
        id: order.order_id,
      });
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(f.outside).not.toHaveBeenCalled();
  });
  it.each([
    ["create_checkout", "POST", "/checkout-sessions"],
    ["update_checkout", "PUT", "/checkout-sessions/chk_synthetic"],
    ["complete_checkout", "POST", "/checkout-sessions/chk_synthetic/complete"],
  ])("refuses %s through real UCP REST and MCP before services or handoff", async (operation, method, path) => {
    const f = fixture();
    const create = vi.spyOn(f.checkout.sessions, "createBuyNow");
    const read = vi.spyOn(f.checkout.sessions, "getSession");
    const body = JSON.stringify({
      id: "chk_synthetic",
      source: {
        type: "buy-now",
        listing_id: "lst_synthetic",
        catalog_item_id: "cat_synthetic",
        product_id: "cat_synthetic::",
        title: "Synthetic item",
        quantity: 1,
      },
    });
    const rest = await f.closed.request(`/ucp/v1${path}`, {
      method,
      body,
      headers: ucpHeaders(body, `rest-${operation}`),
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({
      ucp: { status: "error" },
      messages: [{ severity: "error", code: "checkout_closed" }],
    });
    const mcpBody = JSON.stringify({
      jsonrpc: "2.0",
      id: operation,
      method: "tools/call",
      params: { name: operation, arguments: JSON.parse(body) },
    });
    const mcp = await f.closed.request("/ucp/mcp", {
      method: "POST",
      body: mcpBody,
      headers: ucpHeaders(mcpBody, `mcp-${operation}`),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toMatchObject({
      result: {
        structuredContent: { ucp: { status: "error" }, messages: [{ severity: "error", code: "checkout_closed" }] },
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(f.createAccountPayment).not.toHaveBeenCalled();
    expect(f.outside).not.toHaveBeenCalled();
  });
});

describe("checkout-closed-native-mcp", () => {
  it("wraps the merged override, including dryRun, preserving error wire/audit/replay without delegation", async () => {
    const f = fixture();
    const setAddress = vi
      .spyOn(f.checkout.sessions, "setShippingAddress")
      .mockRejectedValue(new Error("Synthetic setShippingAddress reached"));
    const override = vi.fn<McpToolHandler>(() =>
      f.checkout.sessions.setShippingAddress(
        { sessionId: "chk_synthetic", accountId: "acc_synthetic", shippingAddress },
        { tenantId: "tnt_synthetic", audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } },
      ),
    );
    const audit = vi.fn<McpAuditSink>();
    const closed = buildPlatformApiApp(f.runtime, {
      ...f.options,
      checkoutClosed: true,
      mcp: {
        toolHandlers: { "checkout.select-saved-address": override },
        audit,
        allowInMemoryIdempotencyStoreForTests: true,
      },
    });
    for (const dryRun of [false, true]) {
      const args = { sessionId: "chk_synthetic", shippingAddressId: "adr_synthetic", dryRun };
      const first = await nativeTool(closed, "checkout.select-saved-address", args, `closed-${dryRun}`);
      const firstBody = await first.json();
      expect(first.status).toBe(200);
      expect(firstBody.result).toEqual({ isError: true, content: [{ type: "text", text: "checkout_closed" }] });
      const replay = await nativeTool(closed, "checkout.select-saved-address", args, `closed-${dryRun}`);
      expect(await replay.json()).toEqual(firstBody);
    }
    expect(override).not.toHaveBeenCalled();
    expect(setAddress).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "checkout.select-saved-address",
        outcome: "failed",
        reason: "checkout_closed",
      }),
    );
    expect(f.outside).not.toHaveBeenCalled();
  });

  it("does not install a missing native handler", async () => {
    const f = fixture();
    const runtime = { ...f.runtime, mountedModules: [] };
    const app = buildPlatformApiApp(runtime, { ...f.options, checkoutClosed: true });
    const result = await nativeTool(
      app,
      "checkout.select-saved-address",
      { sessionId: "chk_synthetic", shippingAddressId: "adr_synthetic" },
      "absent",
    );
    expect(await result.text()).not.toContain("checkout_closed");
    expect(f.outside).not.toHaveBeenCalled();
  });
});

describe("checkout-closed-session-lifecycle", () => {
  it("checkout-closed-prestarted-settlement: an authenticated synthetic result still settles C while new starts stay closed", async () => {
    const checkoutStore = createInMemoryEventStore();
    const paymentStore = createInMemoryEventStore();
    const orderStore = createInMemoryEventStore();
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
    };
    let summary: Record<string, unknown> | undefined;
    let cartLineId: string | undefined;
    const checkoutQuery = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
      if (sql.includes("FROM checkout_catalog_items"))
        return { rows: [{ catalog_item_id: "cat_synthetic", status: "active", product_schema: null }] };
      if (sql.includes("checkout_cart_line_pages"))
        return {
          rows:
            cartLineId && !checkoutStore.allEvents.some((event) => event.eventType === "checkout.cart.line-removed")
              ? [retainedCartLine(cartLineId)]
              : [],
        };
      if (sql.includes("INSERT INTO checkout_payment_summary_pages"))
        summary = {
          payment_id: values[0],
          amount: values[3],
          currency_code: values[4],
          status: "pending-confirmation",
        };
      if (sql.includes("UPDATE checkout_payment_summary_pages") && summary) summary.status = values[1];
      return { rows: sql.includes("FROM checkout_payment_summary_pages") && summary ? [summary] : [] };
    });
    const checkoutServices = checkoutModule.createServices(memoryPool(checkoutStore, checkoutQuery), {});
    const sessions = checkoutServices.sessions;
    let sourceClaim: Record<string, unknown> | undefined;
    const orderQuery = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
      if (sql.includes("INSERT INTO ordering_order_source_claims")) {
        sourceClaim = {
          source_type: values[0],
          source_reference_id: values[1],
          buyer_account_id: values[2],
          order_ids: JSON.parse(String(values[3])),
          status: "pending",
        };
        return { rows: [sourceClaim], rowCount: 1 };
      }
      if (sql.includes("FROM ordering_order_source_claims")) return { rows: sourceClaim ? [sourceClaim] : [] };
      if (sql.includes("UPDATE ordering_order_source_claims") && sourceClaim) {
        sourceClaim.status = "created";
        sourceClaim.order_ids = JSON.parse(String(values[3]));
      }
      if (sql.includes("FROM ordering_market_listing_inputs"))
        return {
          rows: [
            {
              listing_id: "lst_synthetic",
              seller_account_id: "acc_seller",
              inventory_item_id: "inv_synthetic",
              catalog_catalog_item_id: "cat_synthetic",
              product_id: "cat_synthetic::",
              item_title: "Synthetic item",
              item_subtitle: null,
              selected_options: [],
              product_summary: null,
              storage_location_name: null,
              ship_from_code: "CHI",
              ship_from_address: shippingAddress,
              price_amount: "20.00",
              marketplace_sales_fee_unit_amount: "1.00",
              seller_net_unit_amount: "19.00",
              shipping_allowance_percentage_bps: 500,
              terms_schedule_id: null,
              terms_agreement_id: null,
              terms_resolved_at: "2026-09-22T00:00:00.000Z",
              fee_locks: [],
              available_quantity: 1,
              max_units_per_order: null,
              max_units_per_day: null,
              max_units_per_customer_account: null,
              product_measure_snapshot: {
                catalogItemId: "cat_synthetic",
                productId: "cat_synthetic::",
                selectedOptions: [],
                measureVersion: "synthetic-v1",
                unitLengthInches: 3.5,
                unitWidthInches: 2.5,
                unitHeightInches: 0.02,
                unitWeightOunces: 0.08,
                physicalFlags: ["raw-card"],
                stackBehavior: "stackable-thickness",
                source: "profile",
                confidence: "measured",
              },
              updated_at: "2026-09-22T00:00:00.000Z",
            },
          ],
        };
      return { rows: [], rowCount: 1 };
    });
    const orderDb = memoryPool(orderStore, orderQuery);
    const realOrdering = orderingModule.createServices(orderDb, {
      inventoryCleanupAuthority: { kind: "not-mounted" },
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "0.00", discountAmount: "0.00", chargeAmount: "0.00" }),
      },
    });
    const orders = realOrdering.orders;
    let orderIds: readonly string[] = [];
    let paymentRow: Awaited<ReturnType<PaymentRuntime["createAccountPayment"]>> | undefined;
    const inbox = new Set<string>();
    const paymentQuery = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
      if (sql.includes("FROM payments_order_inputs"))
        return {
          rows: orderIds.map((orderId) => ({
            order_id: orderId,
            buyer_account_id: "acc_synthetic",
            buyer_email: null,
            seller_account_id: "acc_seller",
            sales_tax_amount: "0.00",
            total_amount: "20.00",
            marketplace_sales_fee_amount: "1.00",
            marketplace_checkout_fee_amount: "0.00",
            seller_net_amount: "19.00",
            seller_item_net_amount: "19.00",
            shipping_allowance_amount: "0.00",
            shipping_overage_amount: "0.00",
            seller_shipping_payout_amount: "0.00",
            seller_payout_amount: "19.00",
            shipping_allowance_percentage_bps: 500,
            terms_schedule_id: null,
            terms_agreement_id: null,
            terms_resolved_at: "2026-09-22T00:00:00.000Z",
            status: "pending-payment",
          })),
        };
      if (sql.includes("INSERT INTO payments_payment_creation_reservations"))
        return {
          rows: [
            {
              payment_id: values[0],
              buyer_account_id: values[1],
              order_set_key: values[2],
              order_ids: values[3],
              source_context: values[4],
              source_reference_id: values[5],
              status: "active",
              created_at: values[6],
              updated_at: values[6],
            },
          ],
        };
      if (sql.includes("FROM payments_provider_customers"))
        return {
          rows: [
            {
              account_id: "acc_synthetic",
              provider: "stripe",
              provider_customer_reference: "cus_synthetic",
              display_name: null,
              email: null,
            },
          ],
        };
      if (sql.includes("FROM payments_provider_webhook_events"))
        return { rows: inbox.has(String(values[0])) ? [{ provider_event_id: values[0] }] : [] };
      if (sql.includes("INSERT INTO payments_provider_webhook_events")) {
        inbox.add(String(values[0]));
        return { rows: [{ provider_event_id: values[0] }], rowCount: 1 };
      }
      if (sql.includes("FROM payments_payment_pages") && paymentRow) return { rows: [paymentRow] };
      return { rows: [], rowCount: 1 };
    });
    const gateway = createFakePaymentProcessorGateway();
    const parse = gateway.parseWebhook;
    const parser = vi.spyOn(gateway, "parseWebhook").mockImplementation(async (input) => {
      if (input.signatureHeader !== "synthetic-authenticated-8075")
        throw new ProviderWebhookError("signature-invalid", "Synthetic signature rejected.");
      return parse(input);
    });
    const payments = paymentsModule.createServices(memoryPool(paymentStore, paymentQuery), {
      processorGateway: gateway,
    }).payments;
    const f = fixture(checkoutServices, payments);
    // Capture the real runtime receipt, not a hand-written payment snapshot.
    f.createAccountPayment.mockRestore();
    const originalCreate = payments.createAccountPayment;
    const create = vi.spyOn(payments, "createAccountPayment").mockImplementation(async (...args) => {
      paymentRow = await originalCreate(...args);
      return paymentRow;
    });
    cartLineId = (
      await checkoutServices.cart.addLine(
        {
          accountId: "acc_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          itemTitle: "Synthetic item",
          itemSubtitle: null,
          itemImageUrl: null,
          productSummary: null,
          quantity: 1,
          selectedOptions: [],
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_synthetic",
        },
        context,
      )
    ).lineId;
    const readiness = await checkoutServices.cart.createReadinessSnapshot({ accountId: "acc_synthetic" });
    expect(readiness.status, JSON.stringify(readiness)).toBe("ready");
    stubOrderingTransport().preview.mockResolvedValue({ ...supplyPreview, readyLineKeys: [cartLineId] });
    const start = await post(f.open, "/checkout-sessions", "acc_synthetic", "owner", "C-start", {
      source: {
        type: "cart",
        readinessSnapshotId: readiness.snapshotId,
        readinessSourceRevision: readiness.sourceRevision,
      },
      entryAttemptKey: "C",
    });
    expect(start.status, await start.clone().text()).toBe(201);
    const sessionId: string = (await start.json()).session_id;
    await sessions.setShippingAddress({ sessionId, accountId: "acc_synthetic", shippingAddress }, context);
    const session = await sessions.getSession(sessionId, "acc_synthetic");
    if (!session) throw new Error("Synthetic C did not start");
    const created = await orders.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_synthetic",
        checkoutSessionId: sessionId,
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress,
        lines: session.lines,
        checkoutReservations: [
          { holdId: "hld_synthetic", sellerAccountId: "acc_seller", inventoryItemId: "inv_synthetic", quantity: 1 },
        ],
      },
      context,
    );
    orderIds = created.orderIds;
    expect(orderIds).toHaveLength(1);
    const createdEvent = orderStore.allEvents.find((event) => event.eventType === "ordering.order.created");
    const requests = createdEvent?.payload.reservationRequests;
    if (!Array.isArray(requests) || requests.length !== 1) throw new Error("Synthetic C reservation missing");
    for (const request of requests) {
      if (typeof request.reservationRequestId !== "string") throw new Error("Synthetic reservation ID missing");
      await orders.commandHandler({
        streamId: `ordering.order-${orderIds[0]}`,
        command: {
          type: "RecordReservationConfirmed",
          reservationRequestId: request.reservationRequestId,
          holdId: "hld_synthetic",
          confirmedAt: "2026-09-22T00:00:00.000Z",
        },
        context,
      });
    }
    await sessions.recordOrdersCreated({ sessionId, accountId: "acc_synthetic", orderIds }, context);
    expect(checkoutStore.allEvents.filter((event) => event.eventType === "checkout.cart.line-removed")).toHaveLength(1);
    expect(await checkoutServices.cart.listAuthorizedCartLines({ accountId: "acc_synthetic" })).toEqual([]);
    expect(paymentStore.allEvents).toHaveLength(0);
    const quote = quoteMarketplaceCheckoutFee({
      orderAmount: "20.00",
      externalBasisAmount: "20.00",
      balanceCreditAmount: "0.00",
      paymentMethodCategory: "card",
    });
    const payment = await post(f.open, "/payments", "acc_synthetic", "owner", "C-payment", {
      orderIds,
      sourceContext: "checkout",
      sourceReferenceId: sessionId,
      marketplaceCheckoutFeeQuoteFingerprint: quote.quote_fingerprint,
    });
    expect(payment.status, await payment.clone().text()).toBe(201);
    if (!paymentRow) throw new Error("Synthetic C payment did not start");
    expect(paymentRow.status).toBe("pending-confirmation");
    await sessions.recordPaymentStarted(
      { sessionId, accountId: "acc_synthetic", paymentId: paymentRow.payment_id },
      context,
    );
    const checkoutBeforeResult = checkoutStore.allEvents.length;
    const summarySubscription = checkoutModule
      .buildSubscriptions?.(checkoutServices)
      .find((subscription) => subscription.projectionName === "checkout.payment-summary-projection");
    if (!summarySubscription) throw new Error("Owning payment summary projection missing");
    const summaryHandlers = summarySubscription.handlers;
    const captureSubscription = orderingModule
      .buildSubscriptions?.(realOrdering)
      .find((subscription) => subscription.projectionName === "ordering-payment-capture");
    if (!captureSubscription) throw new Error("Owning payment capture reaction missing");
    let drained = 0;
    const drain = async () => {
      for (const event of paymentStore.allEvents.slice(drained)) {
        const transport = toTransportEvent(event);
        await summaryHandlers[event.eventType]?.(transport);
        await captureSubscription.handlers[event.eventType]?.(transport);
      }
      drained = paymentStore.allEvents.length;
    };
    await drain();
    const rawBody = JSON.stringify({
      eventId: "evt_synthetic_8075_C",
      kind: "payment-captured",
      processorPaymentReference: paymentRow.processor_payment_reference,
      processorStatus: "complete",
      occurredAt: "2026-09-23T00:00:00.000Z",
    });
    const webhook = (signature: string) =>
      f.closed.request("/api/payments/provider/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", "Stripe-Signature": signature },
        body: rawBody,
      });
    const beforeRejected = paymentStore.allEvents.length;
    expect((await webhook("rejected-synthetic-signature")).status).toBe(400);
    expect(paymentStore.allEvents).toHaveLength(beforeRejected);
    const result = await webhook("synthetic-authenticated-8075");
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toMatchObject({ received: true, ignored: false });
    await drain();
    expect(paymentStore.allEvents.filter((event) => event.eventType === "payments.payment-captured")).toHaveLength(1);
    expect(
      orderStore.allEvents.some((event) => event.eventType === "ordering.order.ready-for-fulfillment-recorded"),
    ).toBe(true);
    expect(await sessions.getPaymentSummary(paymentRow.payment_id)).toMatchObject({
      payment_id: paymentRow.payment_id,
      status: "captured",
    });
    expect(checkoutStore.allEvents).toHaveLength(checkoutBeforeResult);
    const counts = [checkoutStore.allEvents.length, paymentStore.allEvents.length, orderStore.allEvents.length];
    expect(await (await webhook("synthetic-authenticated-8075")).json()).toMatchObject({
      received: true,
      ignored: true,
    });
    await drain();
    expect([checkoutStore.allEvents.length, paymentStore.allEvents.length, orderStore.allEvents.length]).toEqual(
      counts,
    );
    const cancel = await nativeTool(f.closed, "checkout.cancel-session", { sessionId }, "C-cannot-cancel");
    expect((await cancel.json()).result).toEqual({
      isError: true,
      content: [{ type: "text", text: "Checkout sessions cannot be cancelled after payment starts." }],
    });
    for (const path of paymentPaths)
      expect((await post(f.closed, path, "acc_synthetic", "owner", "C-refused-start")).status).toBe(503);
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.recoverCheckoutPayment).not.toHaveBeenCalled();
    expect(parser).toHaveBeenCalledTimes(3);
    expect((await sessions.getSession(sessionId, "acc_synthetic"))?.payment_id).toBe(paymentRow.payment_id);
    const retained = await f.closed.request(`/api/marketplace/account/checkout-sessions/${sessionId}`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      session_id: sessionId,
      order_ids: orderIds,
      payment_id: paymentRow.payment_id,
    });
    expect(await checkoutServices.cart.listAuthorizedCartLines({ accountId: "acc_synthetic" })).toEqual([]);
  });

  it("retains distinct A/B sessions through closed steady state, permits agent cancellation, and reopens A", async () => {
    const store = createInMemoryEventStore();
    let retainedLineId: string | undefined;
    const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql) => ({
      rows: sql.includes("FROM checkout_catalog_items")
        ? [{ catalog_item_id: "cat_synthetic", status: "active", product_schema: null }]
        : sql.includes("checkout_cart_line_pages") && retainedLineId
          ? [retainedCartLine(retainedLineId)]
          : [],
    }));
    const checkoutServices = checkoutModule.createServices(memoryPool(store, query), {});
    const sessions = checkoutServices.sessions;
    const f = fixture(checkoutServices);
    retainedLineId = (
      await f.checkout.cart.addLine(
        {
          accountId: "acc_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          itemTitle: "Synthetic item",
          itemSubtitle: null,
          itemImageUrl: null,
          productSummary: null,
          quantity: 1,
          selectedOptions: [],
          fulfillmentMode: "locked-listing",
          lockedListingId: "lst_synthetic",
        },
        { tenantId: "tnt_synthetic", audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" } },
      )
    ).lineId;
    const orderingTransport = stubOrderingTransport();
    const source = {
      type: "buy-now",
      listingId: "lst_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      itemTitle: "Synthetic item",
      selectedOptions: [],
      quantity: 1,
    };
    const started: string[] = [];
    for (const entryAttemptKey of ["A", "B"]) {
      const response = await post(
        f.open,
        "/checkout-sessions",
        "acc_synthetic",
        "owner",
        `lifecycle-${entryAttemptKey}`,
        { source, entryAttemptKey },
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const body = await response.json();
      expect(typeof body.session_id).toBe("string");
      started.push(body.session_id);
    }
    const [a, b] = started;
    expect(a).not.toBe(b);
    const savedAddressId = createId("adr");
    const savedAddresses = vi.spyOn(f.checkout.sellList, "listShipFromAddresses").mockResolvedValue([
      {
        shipping_address_id: savedAddressId,
        account_id: "acc_synthetic",
        label: "Synthetic home",
        recipient_name: "Synthetic Buyer",
        company: null,
        line1: "100 Market Street",
        line2: null,
        city: "Chicago",
        state: "IL",
        postal_code: "60601",
        country: "US",
        phone: null,
        email: null,
        is_default: true,
        updated_at: "2026-09-22T00:00:00.000Z",
      },
    ]);
    const setAddress = vi.spyOn(sessions, "setShippingAddress");
    const select = await nativeTool(
      buildPlatformApiApp(f.runtime, f.options),
      "checkout.select-saved-address",
      { sessionId: a, shippingAddressId: savedAddressId },
      "lifecycle-open-select",
    );
    expect(await select.json()).toMatchObject({
      result: { structuredContent: { sessionId: a, status: "shipping-address-selected" } },
    });
    expect(savedAddresses).toHaveBeenCalledTimes(1);
    expect(setAddress).toHaveBeenCalledTimes(1);
    const closedSelect = await nativeTool(
      f.closed,
      "checkout.select-saved-address",
      { sessionId: a, shippingAddressId: savedAddressId },
      "lifecycle-closed-select",
    );
    expect(await closedSelect.json()).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "checkout_closed" }] },
    });
    expect(savedAddresses).toHaveBeenCalledTimes(1);
    expect(setAddress).toHaveBeenCalledTimes(1);
    const cartRead = vi.spyOn(f.checkout.cart, "listAuthorizedCartLines");
    const retainedCart = await nativeTool(
      buildPlatformApiApp(f.runtime, { ...f.options, checkoutClosed: true }),
      "checkout.get-cart",
      {},
      "lifecycle-cart-read",
    );
    expect(await retainedCart.json()).toMatchObject({
      result: { structuredContent: { items: [expect.objectContaining({ line_id: retainedLineId })] } },
    });
    expect(cartRead).toHaveBeenCalledTimes(1);
    const beforeClosure = store.allEvents.length;
    for (let steady = 0; steady < 2; steady++) {
      for (const id of started) {
        const read = await f.closed.request(`/api/marketplace/account/checkout-sessions/${id}`);
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({ session_id: id, order_ids: [], payment_id: null });
      }
      expect((await post(f.closed, `/checkout-sessions/${a}/confirm`, "acc_synthetic")).status).toBe(503);
      expect((await post(f.closed, "/payments", "acc_synthetic", "owner", "lifecycle-payment")).status).toBe(503);
      expect(await f.checkout.cart.listAuthorizedCartLines({ accountId: "acc_synthetic" })).toMatchObject([
        { line_id: retainedLineId, quantity: 1 },
      ]);
      for (const transport of ["rest", "mcp"] as const) {
        expect(await ucpReadOrCancel(f.closed, "get_checkout", a, transport)).toMatchObject({ ucp: { status: "ok" } });
      }
    }
    expect(store.allEvents).toHaveLength(beforeClosure);
    const cancel = await nativeTool(f.closed, "checkout.cancel-session", { sessionId: b }, "lifecycle-cancel-B");
    expect(await cancel.json()).toMatchObject({ result: { structuredContent: { sessionId: b, status: "cancelled" } } });
    expect((await sessions.getSession(b, "acc_synthetic"))?.cancelled_at).toBeTruthy();
    expect((await sessions.getSession(a, "acc_synthetic"))?.cancelled_at).toBeNull();
    for (const transport of ["rest", "mcp"] as const) {
      expect(await ucpReadOrCancel(f.closed, "cancel_checkout", b, transport)).toMatchObject({ ucp: { status: "ok" } });
    }
    const reopened = buildPlatformApiApp(f.runtime, { ...f.options, checkoutClosed: false });
    const address = {
      name: "Synthetic Buyer",
      line1: "100 Market Street",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const orderId = createId("ord");
    const paymentId = createId("pay");
    const orders = orderingTransport.create.mockResolvedValue({ orderIds: [orderId] });
    // The transport boundary returns a synthetic payment receipt; C below separately exercises settlement.
    const payment = vi
      .fn<ReturnType<typeof paymentsServer.createPaymentsRequestApiClient>["createAccountPayment"]>()
      .mockResolvedValue(syntheticPayment(paymentId, orderId));
    const originalPaymentsClient = paymentsServer.createPaymentsRequestApiClient;
    vi.spyOn(paymentsServer, "createPaymentsRequestApiClient").mockImplementation((...args) => ({
      ...originalPaymentsClient(...args),
      createAccountPayment: payment,
    }));
    const confirmed = await post(
      reopened,
      `/checkout-sessions/${a}/confirm`,
      "acc_synthetic",
      "owner",
      "lifecycle-reopen",
      {
        shippingAddress: address,
        fulfillmentPreviewRevision: "synthetic-supply-ready",
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|card|synthetic",
      },
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ payment_id: paymentId, order_ids: [orderId], status: "confirmed" });
    expect(orders).toHaveBeenCalledTimes(1);
    expect(payment).toHaveBeenCalledTimes(1);
    const cancelled = await post(
      reopened,
      `/checkout-sessions/${b}/confirm`,
      "acc_synthetic",
      "owner",
      "lifecycle-B-reopen",
      { shippingAddress: address },
    );
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    expect(orders).toHaveBeenCalledTimes(1);
    expect(payment).toHaveBeenCalledTimes(1);
  });
});
function post(
  app: ReturnType<typeof buildPlatformApiApp>,
  path: string,
  account: string,
  role = "owner",
  ip = account,
  body: unknown = { orderIds: ["ord_synthetic"], currencyCode: "usd" },
) {
  return app.request(`/api/marketplace/account${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-account": account,
      "x-test-role": role,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("checkout-closed-route-matrix: shared Payments admission", () => {
  it.each(paymentPaths)("retains permission/limit before context ordering for %s", async (path) => {
    const f = fixture();
    const paymentMount = resolveApiHostMounts(f.runtime).find(
      (mount) => mount.contextName === "payments" && mount.mountPath === "/api/marketplace",
    );
    if (!paymentMount || !(paymentMount.router instanceof Hono)) throw new Error("Mounted Payments router missing");
    const router = paymentMount.router;
    const build = (closed: boolean) => {
      const app = new Hono<TenantContextEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", {
          sessionId: "ses_synthetic",
          tenantId: "tnt_synthetic",
          userId: "usr_synthetic",
          accountId: `context-${path}`,
          membershipId: "mbr_synthetic",
          roleKey: "owner",
          permissions: ["orders.manage"],
        });
        c.set("context", null);
        await next();
      });
      app.use("*", createCheckoutClosedMiddleware(closed));
      app.route(paymentMount.mountPath, router);
      return app;
    };
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `context-${path}` },
      body: "{}",
    };
    expect((await build(false).request(`/api/marketplace/account${path}`, request)).status).toBe(401);
    expect((await build(true).request(`/api/marketplace/account${path}`, request)).status).toBe(503);
    expect(f.createAccountPayment).not.toHaveBeenCalled();
    expect(f.recoverCheckoutPayment).not.toHaveBeenCalled();
  });
  it.each(paymentPaths)("preserves anonymous/forbidden denial bytes and admits no service for %s", async (path) => {
    const f = fixture();
    const log = vi.spyOn(getObservabilityRuntime().logger, "info");
    for (const role of ["anonymous", "forbidden"]) {
      const open = await post(f.open, path, `denial-${path}`, role);
      const closed = await post(f.closed, path, `denial-${path}`, role);
      expect(closed.status).toBe(role === "anonymous" ? 401 : 403);
      expect(await closed.text()).toBe(await open.text());
    }
    expect(log.mock.calls.filter(([message]) => message === "checkout_closed_refusal")).toHaveLength(0);
    expect(f.createAccountPayment).not.toHaveBeenCalled();
    expect(f.recoverCheckoutPayment).not.toHaveBeenCalled();
    expect(f.outside).not.toHaveBeenCalled();
  });

  it.each(["owner", "guest"])(
    "preserves cross-route account buckets in both directions without double charge: %s",
    async (role) => {
      const f = fixture();
      const log = vi.spyOn(getObservabilityRuntime().logger, "info");
      for (const initiallyClosed of [false, true]) {
        const account = `account-${role}-${initiallyClosed}`;
        const first = initiallyClosed ? f.closed : f.open;
        const next = initiallyClosed ? f.open : f.closed;
        for (let i = 0; i < 10; i++) {
          const response = await post(first, paymentPaths[i % 2], account, role);
          expect(response.status).toBe(initiallyClosed ? 503 : 400);
        }
        for (const path of paymentPaths) {
          const response = await post(next, path, account, role);
          expect(response.status).toBe(429);
          expect(await response.json()).toMatchObject({
            error: { code: "rate_limited", surface: "payments.payment.create.account" },
          });
        }
      }
      expect(f.createAccountPayment).toHaveBeenCalledTimes(5);
      expect(f.recoverCheckoutPayment).toHaveBeenCalledTimes(5);
      const refusals = log.mock.calls.filter(([message]) => message === "checkout_closed_refusal");
      expect(refusals).toHaveLength(10);
      expect(refusals.every(([, fields]) => fields?.actorKind === role)).toBe(true);
      expect(f.outside).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "preserves the shared IP bucket across routes and flag changes (initially closed=%s)",
    async (initiallyClosed) => {
      const f = fixture();
      const first = initiallyClosed ? f.closed : f.open;
      const next = initiallyClosed ? f.open : f.closed;
      const ip = initiallyClosed ? "203.0.113.81" : "203.0.113.82";
      for (let i = 0; i < 20; i++) {
        expect((await post(first, paymentPaths[i % 2], `ip-${initiallyClosed}-${i}`, "owner", ip)).status).toBe(
          initiallyClosed ? 503 : 400,
        );
      }
      const response = await post(next, "/payments", `ip-final-${initiallyClosed}`, "guest", ip);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { surface: "payments.payment.create.ip" } });
      expect(f.createAccountPayment).toHaveBeenCalledTimes(initiallyClosed ? 0 : 10);
      expect(f.recoverCheckoutPayment).toHaveBeenCalledTimes(initiallyClosed ? 0 : 10);
      expect(f.outside).not.toHaveBeenCalled();
    },
  );
});

describe("checkout-closed-route-matrix: composition attachment", () => {
  it.each(closedRoutes)("retains anonymous authentication bytes for %s", async (route) => {
    const f = fixture();
    const path = route.slice("POST /api/marketplace/account".length).replace(":sessionId", "chk_synthetic");
    const open = await post(f.open, path, "anonymous-checkout", "anonymous");
    const closed = await post(f.closed, path, "anonymous-checkout", "anonymous");
    expect(open.status).toBe(401);
    expect(closed.status).toBe(401);
    expect(await closed.text()).toBe(await open.text());
    expect(f.outside).not.toHaveBeenCalled();
  });
  it("partitions all mounted Checkout, Ordering and Payments writes, rejecting an unknown sibling", () => {
    const f = fixture();
    const partition = [...closedRoutes, ...preservedRoutes];
    expect(new Set(partition).size).toBe(partition.length);
    expect(mountedWrites(f.runtime)).toEqual(partition.sort());
    expect(partition).not.toContain("POST /api/marketplace/account/unknown-buying-route");
    expect(() =>
      expect([...mountedWrites(f.runtime), "POST /api/marketplace/account/unknown-buying-route"].sort()).toEqual(
        partition,
      ),
    ).toThrow();
    expect(f.outside).not.toHaveBeenCalled();
  });

  it.each(closedRoutes)("refuses the mounted start %s before any database/event write", async (route) => {
    const f = fixture();
    const log = vi.spyOn(getObservabilityRuntime().logger, "info");
    const path = route.slice("POST /api/marketplace/account".length).replace(":sessionId", "chk_synthetic");
    const response = await post(f.closed, path, `matrix-${path}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "checkout_closed" } });
    expect(log.mock.calls.filter(([message]) => message === "checkout_closed_refusal")).toEqual([
      [
        "checkout_closed_refusal",
        {
          type: "checkout_closed_refusal",
          route: `/api/marketplace/account${path}`,
          method: "POST",
          actorKind: "owner",
        },
      ],
    ]);
    expect(f.createAccountPayment).not.toHaveBeenCalled();
    expect(f.recoverCheckoutPayment).not.toHaveBeenCalled();
    expect(f.outside).not.toHaveBeenCalled();
  });

  it.each([
    {
      path: "/checkout-sessions",
      body: { source: { type: "offer-intent" } },
      role: "guest-buyer",
      status: 403,
      code: "account_registration_required",
    },
    {
      path: "/checkout-sessions/chk_synthetic/confirm",
      body: { savedCheckoutInstrumentId: "sci_synthetic" },
      role: "guest-buyer",
      status: 409,
      code: "saved_checkout_instrument_unavailable",
    },
    {
      path: "/checkout-sessions/chk_synthetic/confirm",
      body: { savePaymentMethodForFuture: true },
      role: "guest-buyer",
      status: 409,
      code: "saved_checkout_instrument_unavailable",
    },
    {
      path: "/checkout-sessions/chk_synthetic/confirm",
      body: { promoCode: "synthetic" },
      role: "owner",
      status: 409,
      code: "checkout_economics_unsupported",
    },
    {
      path: "/checkout-sessions/chk_synthetic/confirm",
      body: {
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: "marketplace-checkout-fee-v1|bank-account|25.00",
      },
      role: "owner",
      status: 409,
      code: "payment_quote_required",
    },
  ])("precedes body-derived $code without changing the open route", async ({ path, body, role, status, code }) => {
    const f = fixture();
    const open = await post(f.open, path, `body-${code}`, role, code, body);
    expect(open.status).toBe(status);
    expect(await open.json()).toMatchObject({ error: { code } });
    expect(f.recordCheckoutEvent).toHaveBeenCalledTimes(
      ["saved_checkout_instrument_unavailable", "checkout_economics_unsupported"].includes(code) ? 1 : 0,
    );
    const telemetry = [...f.recordCheckoutEvent.mock.calls];
    const closed = await post(f.closed, path, `body-${code}`, role, code, body);
    expect(closed.status).toBe(503);
    expect(await closed.json()).toMatchObject({ error: { code: "checkout_closed" } });
    expect(f.recordCheckoutEvent.mock.calls).toEqual(telemetry);
    expect(f.outside).not.toHaveBeenCalled();
  });

  it.each(preservedRoutes)("retains the owner response for sibling %s", async (route) => {
    const f = fixture();
    const [method, template] = route.split(" ");
    const path = template.replace(/:[A-Za-z]+/g, "synthetic");
    const request = { method, headers: { "content-type": "application/json", "x-test-role": "anonymous" }, body: "{}" };
    const baseline = await f.open.request(path, request);
    const closed = await f.closed.request(path, request);
    expect(closed.status).toBe(baseline.status);
    expect(await closed.text()).toBe(await baseline.text());
  });
});
