import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as settlementModule } from "@chase-sets/settlement";
import { buildPlatformApiApp } from "../src/app";

// Seller Desk acceptance gate — the epic capstone that proves the deep modules
// carry the whole seller journey on the MCP connector transport, at parity with
// the web Seller Desk. The web half of the gate is the playwright harness in
// deployables/marketplace/e2e/seller-desk-journey.uat.spec.ts; that half stays
// pending until the redesigned web surfaces land, so this file delivers the
// largest runnable slice now: the full "what needs me -> act -> resolve" journey
// driven through the native MCP SDK over the same platform-api /mcp endpoint an
// external agent connects to.
//
// The single spine both facades consume is the Seller Desk attention queue: the
// web home renders it and the marketplace.get-seller-attention-queue tool returns
// it. The queue read model and its blueprint ordering are unit-proven in
// contracts/seller-attention-queue and contracts/seller-desk; this gate proves
// the connector faithfully carries that queue and that every queue item is
// actionable end to end through the fulfillment and settlement tools.
//
// JOURNEY_COVERAGE is the machine-checkable crosswalk of every journey step and
// its transport status. Steps whose web surface has not landed are marked pending
// against the surface that owns them, so the gate documents the full journey and
// exactly what is outstanding rather than silently dropping it.

type TransportStatus = "live" | "pending";

type JourneyStep = Readonly<{
  id: string;
  job: string;
  // The MCP tools (or reads) that carry this step on the connector transport.
  mcpTools: readonly string[];
  mcp: TransportStatus;
  // The web Seller Desk surface that carries this step, and whether it has landed.
  webSurface: string;
  web: TransportStatus;
  // When web is pending, the surface work it waits on (no live route on main yet).
  webPendingOn?: string;
}>;

const JOURNEY_COVERAGE: readonly JourneyStep[] = [
  {
    id: "attention-queue",
    job: "See everything that needs the seller, most important first.",
    mcpTools: ["marketplace.get-seller-attention-queue"],
    mcp: "live",
    webSurface: "seller-home (/account/desk)",
    web: "pending",
    webPendingOn: "Seller Desk home surface (marketplace-web home, PR 5464)",
  },
  {
    id: "act-ship",
    job: "Pack, buy the label, and dispatch the ship-by shipment the queue flagged.",
    mcpTools: ["fulfillment.list-shipments", "fulfillment.purchase-label", "fulfillment.dispatch-shipment"],
    mcp: "live",
    webSurface: "shipment (/account/desk/shipments/:shipmentId)",
    web: "pending",
    webPendingOn: "Fulfillment command center surface (PR 5462)",
  },
  {
    id: "act-offer",
    job: "Respond to the offer awaiting the seller from the queue.",
    mcpTools: ["marketplace.accept-offer"],
    mcp: "live",
    webSurface: "sell-list (/account/desk/offers)",
    web: "pending",
    webPendingOn: "Offers & sell-list surface (PR 5480)",
  },
  {
    id: "resolve-money",
    job: "Read the wallet and payouts, then request the payout the settlement leg earned.",
    mcpTools: ["settlement.get-wallet", "settlement.list-payouts", "settlement.request-payout"],
    mcp: "live",
    webSurface: "settlement-dashboard (/account/desk/money)",
    web: "pending",
    webPendingOn: "Money dashboard surface (PR 5479)",
  },
  {
    id: "resolve-blocked-payout",
    job: "The blocked payout surfaces as a critical queue item and clears once resolved.",
    mcpTools: ["marketplace.get-seller-attention-queue", "settlement.request-payout"],
    mcp: "live",
    webSurface: "seller-home (/account/desk) + payout (/account/desk/payouts/:payoutId)",
    web: "pending",
    webPendingOn: "Seller Desk home + Money dashboard surfaces (PR 5464, PR 5479)",
  },
];

function agentActor(permissions: readonly string[]) {
  return {
    sessionId: "ucp:grant_seller_desk_journey",
    tenantId: "tenant_1",
    userId: "agent_user_1",
    accountId: "acc_seller",
    membershipId: "member_1",
    roleKey: "agent",
    permissions,
  };
}

// Every read/permission the Seller Desk journey touches: the attention-queue tool
// requires all five seller view permissions, plus the mutation verbs the act legs
// need. Intentionally the full seller grant so the connector proves it can do
// everything the web desk can from one authenticated session.
const SELLER_JOURNEY_PERMISSIONS = [
  "inventory.view",
  "listings.view",
  "listings.manage",
  "offers.view",
  "offers.manage",
  "orders.view",
  "fulfillment.view",
  "fulfillment.manage",
  "payouts.view",
  "payouts.request",
] as const;

function createRuntime(services: Record<string, unknown>, modules: readonly { module: unknown; services: unknown }[]) {
  return {
    mountedContexts: [],
    mountedModules: modules,
    services: {
      auth: {},
      identity: {},
      ...services,
    },
    projectionGroups: [],
    subscriptionRunners: [],
  } as never;
}

async function withMcpClient<T>(
  app: ReturnType<typeof buildPlatformApiApp>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "chase-sets-seller-desk-uat-agent", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://platform-api.test/mcp"), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return app.fetch(request);
    },
  });

  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close();
  }
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = (result as { content?: readonly unknown[] }).content ?? [];
  return content
    .map((entry) =>
      typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string"
        ? entry.text
        : JSON.stringify(entry),
    )
    .join("\n");
}

function expectStructured(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError, textContent(result)).not.toBe(true);
  return result.structuredContent;
}

function callConfirmedTool(
  client: Client,
  request: Parameters<Client["callTool"]>[0] & Readonly<{ confirmation: { confirmed: true; text: string } }>,
) {
  return client.callTool(request as Parameters<Client["callTool"]>[0]);
}

// The two attention-queue shapes the seller sees across the blocked-payout
// resolution. Both are exactly what aggregateSellerAttentionQueue produces for
// the web home (shape and blueprint ordering proven in the contract suites):
// two criticals ahead of the warning, the dated ship-by ahead of the undated
// blocked payout, and the blueprint deep-link routes on every item.
const shipByItem = {
  id: "fulfillment-ship-by:shp_1",
  source: "fulfillment-ship-by",
  entity: "shipment",
  severity: "critical",
  summary: { code: "ship-by-overdue", params: { reference: "SHP-1", dueAt: "2026-07-15T00:00:00.000Z" } },
  deepLink: { surface: "shipment", href: "/account/desk/shipments/shp_1" },
  dueAt: "2026-07-15T00:00:00.000Z",
  observedAt: "2026-07-13T00:00:00.000Z",
} as const;

const blockedPayoutItem = {
  id: "settlement-blocked-payout:payout_1",
  source: "settlement-blocked-payout",
  entity: "payout",
  severity: "critical",
  summary: { code: "payout-blocked", params: { reference: "PO-1", reason: "Payout account verification required" } },
  deepLink: { surface: "payout", href: "/account/desk/payouts/payout_1" },
  dueAt: null,
  observedAt: "2026-07-12T00:00:00.000Z",
} as const;

const offerItem = {
  id: "offer-response:off_1",
  source: "offer-response",
  entity: "offer",
  severity: "warning",
  summary: { code: "offer-awaiting-response", params: { reference: "Charizard ex" } },
  deepLink: { surface: "sell-list", href: "/account/desk/offers" },
  dueAt: null,
  observedAt: "2026-07-11T00:00:00.000Z",
} as const;

type QueueItem = typeof shipByItem | typeof blockedPayoutItem | typeof offerItem;

function emptyBySource() {
  return {
    "fulfillment-ship-by": 0,
    "settlement-blocked-payout": 0,
    "dispute-response": 0,
    "inventory-resolution": 0,
    "offer-response": 0,
    "listing-action": 0,
  };
}

function queueWith(items: readonly QueueItem[]) {
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const bySource = emptyBySource();
  for (const item of items) {
    bySeverity[item.severity] += 1;
    bySource[item.source] += 1;
  }
  return {
    items,
    rollup: { total: items.length, bySeverity, bySource },
    sources: [
      { id: "fulfillment-ship-by", status: "available", itemCount: bySource["fulfillment-ship-by"] },
      { id: "settlement-blocked-payout", status: "available", itemCount: bySource["settlement-blocked-payout"] },
      { id: "inventory-resolution", status: "available", itemCount: 0 },
      { id: "offer-response", status: "available", itemCount: bySource["offer-response"] },
      { id: "listing-action", status: "available", itemCount: 0 },
    ],
    degraded: false,
  };
}

describe("Seller Desk full-journey acceptance gate @seller-desk-journey", () => {
  it("drives the whole seller journey over the MCP connector at web-parity: queue -> ship -> offer -> money, blocked payout surfaces and clears", async () => {
    // The blocked payout is a critical queue item until the seller resolves it via
    // the money leg; after that the next queue load no longer surfaces it.
    let blockedPayoutResolved = false;
    const loadQueue = vi.fn(async () =>
      blockedPayoutResolved
        ? queueWith([shipByItem, offerItem])
        : queueWith([shipByItem, blockedPayoutItem, offerItem]),
    );
    const sellerAttentionQueue = { loadQueue };

    const offer = {
      offer_id: "off_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      catalog_item_id: "cat_1",
      product_id: "product_1",
      status: "accepted",
      price_amount: "24.00",
      quantity_requested: 1,
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    };
    const offerServices = {
      submitOffer: vi.fn(),
      acceptOffer: vi.fn(async () => ({ offerId: "off_1", version: 2 })),
      declineOfferMatch: vi.fn(),
      listSubmittedOffers: vi.fn(async () => ({ items: [], total: 0 })),
      listSellerOfferMatches: vi.fn(async () => ({ items: [offer], total: 1 })),
      getOffer: vi.fn(async () => offer),
      getSubmittedOffer: vi.fn(async () => offer),
      getSellerOfferMatch: vi.fn(async () => offer),
    };
    const listingServices = {
      listSellerListings: vi.fn(async () => ({ items: [], total: 0 })),
      getSellerListing: vi.fn(),
      getSellerListingAvailability: vi.fn(async () => ({ canList: true })),
      listSellerListingFeeLockReport: vi.fn(async () => ({ items: [], total: 0 })),
      listSellerInventoryItemSupply: vi.fn(async () => ({ items: [], total: 0 })),
      createListing: vi.fn(),
      updateListingPrice: vi.fn(),
      publishListing: vi.fn(),
      pauseListing: vi.fn(),
    };

    // Fulfillment stub advances the shipment through the real state machine the
    // command center and the MCP tools share: awaiting-label -> label-attached ->
    // dispatched. getSellerShipment reflects the live status so the tool's legality
    // gate runs for real; buy-label is only legal from awaiting-label and dispatch
    // only from label-attached.
    let shipmentStatus = "awaiting-label";
    let labelStatus = "none";
    const shipmentRow = () => ({
      shipment_id: "shp_1",
      order_id: "order_1",
      seller_account_id: "acc_seller",
      buyer_account_id: "acc_buyer",
      display_reference: "SHP-1",
      status: shipmentStatus,
      label_status: labelStatus,
      carrier_name: "USPS",
      tracking_identifier: shipmentStatus === "awaiting-label" ? null : "9400111899223857463029",
      dispatched_at: shipmentStatus === "dispatched" ? "2026-07-15T00:00:00.000Z" : null,
      delivered_at: null,
      returned_at: null,
      exception_raised_at: null,
      current_exception_type: null,
      current_exception_notes: null,
      postage_provider_events: [],
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    });
    const shipmentServices = {
      listSellerShipments: vi.fn(async () => ({ items: [shipmentRow()], total: 1 })),
      listBuyerShipments: vi.fn(async () => ({ items: [], total: 0 })),
      getSellerShipment: vi.fn(async () => shipmentRow()),
      getBuyerShipment: vi.fn(async () => null),
      purchaseUspsLabel: vi.fn(async () => {
        shipmentStatus = "label-attached";
        labelStatus = "purchased";
        return { shipmentId: "shp_1", version: 2, trackingIdentifier: "9400111899223857463029" };
      }),
      voidLabel: vi.fn(),
      startPackingShipment: vi.fn(),
      packShipment: vi.fn(),
      dispatchShipment: vi.fn(async () => {
        shipmentStatus = "dispatched";
        return { shipmentId: "shp_1", version: 3 };
      }),
      deliverShipment: vi.fn(),
      returnShipment: vi.fn(),
      raiseShipmentException: vi.fn(),
    };

    const wallet = {
      account_id: "acc_seller",
      currency_code: "USD",
      pending_balance_amount: "0.00",
      available_balance_amount: "24.00",
    };
    const payout = {
      payout_id: "payout_1",
      account_id: "acc_seller",
      amount: "24.00",
      currency_code: "USD",
      status: "requested",
      requested_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    };
    const settlementServices = {
      wallets: {
        getWallet: vi.fn(async () => wallet),
        listWalletEntries: vi.fn(async () => ({ items: [], total: 0 })),
      },
      payouts: {
        listPayouts: vi.fn(async () => ({ items: [payout], total: 1 })),
        getPayout: vi.fn(async () => payout),
        requestPayout: vi.fn(async () => {
          // Requesting the payout resolves the blocked-payout blocker, so the next
          // attention-queue load no longer surfaces it.
          blockedPayoutResolved = true;
          return { payoutId: "payout_1", version: 1, payout };
        }),
      },
      payoutReadiness: {
        refreshReadiness: vi.fn(),
        createOnboardingLink: vi.fn(),
      },
    };

    const marketplaceServices = {
      listings: listingServices,
      offers: offerServices,
      reviews: {},
      sellerAttentionQueue,
    };
    const fulfillmentServices = { shipments: shipmentServices };

    const app = buildPlatformApiApp(
      createRuntime(
        {
          marketplace: marketplaceServices,
          fulfillment: fulfillmentServices,
          settlement: settlementServices,
        },
        [
          { module: marketplaceModule, services: marketplaceServices },
          { module: fulfillmentModule, services: fulfillmentServices },
          { module: settlementModule, services: settlementServices },
        ],
      ),
      {
        resolveActor: vi.fn(async () => agentActor([...SELLER_JOURNEY_PERMISSIONS])),
      },
    );

    await withMcpClient(app, async (client) => {
      // The connector exposes the same deep-module tools the web desk drives.
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "marketplace.get-seller-attention-queue",
          "fulfillment.list-shipments",
          "fulfillment.purchase-label",
          "fulfillment.dispatch-shipment",
          "marketplace.accept-offer",
          "settlement.get-wallet",
          "settlement.list-payouts",
          "settlement.request-payout",
        ]),
      );

      // Step 1 — attention queue. The connector returns the exact "what needs me"
      // queue the web home renders: two criticals first, the dated ship-by ahead
      // of the undated blocked payout, then the warning, with blueprint deep-links.
      const openingQueue = expectStructured(
        await client.callTool({
          name: "marketplace.get-seller-attention-queue",
          arguments: { accountId: "acc_seller" },
        }),
      );
      expect(openingQueue).toEqual(queueWith([shipByItem, blockedPayoutItem, offerItem]));
      const openingItems = (openingQueue as { items: readonly (typeof shipByItem)[] }).items;
      expect(openingItems.map((item) => item.source)).toEqual([
        "fulfillment-ship-by",
        "settlement-blocked-payout",
        "offer-response",
      ]);
      // Every queue item's deep link points at a Seller Desk blueprint route.
      expect(openingItems.map((item) => item.deepLink.href)).toEqual([
        "/account/desk/shipments/shp_1",
        "/account/desk/payouts/payout_1",
        "/account/desk/offers",
      ]);

      // Step 2 — act on the ship-by item: list, buy the label, dispatch.
      expect(
        expectStructured(
          await client.callTool({
            name: "fulfillment.list-shipments",
            arguments: { accountId: "acc_seller", side: "sale" },
          }),
        ),
      ).toMatchObject({ accountId: "acc_seller", side: "sale", count: 1 });

      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "fulfillment.purchase-label",
            arguments: {
              accountId: "acc_seller",
              shipmentId: "shp_1",
              reason: "Ship-by deadline reached in the Seller Desk attention queue.",
              idempotencyKey: "seller-desk-buy-label-1",
              confirmationText: "Purchase Label.",
            },
            confirmation: { confirmed: true, text: "Purchase Label." },
          }),
        ),
      ).toMatchObject({ accountId: "acc_seller", shipmentId: "shp_1", status: "label-attached", action: "buy-label" });

      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "fulfillment.dispatch-shipment",
            arguments: {
              accountId: "acc_seller",
              shipmentId: "shp_1",
              reason: "Handed to USPS after buying the label.",
              idempotencyKey: "seller-desk-dispatch-1",
              confirmationText: "Dispatch Shipment.",
            },
            confirmation: { confirmed: true, text: "Dispatch Shipment." },
          }),
        ),
      ).toMatchObject({ accountId: "acc_seller", shipmentId: "shp_1", status: "dispatched", action: "dispatch" });

      // Step 3 — respond to the offer awaiting the seller.
      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "marketplace.accept-offer",
            arguments: {
              accountId: "acc_seller",
              offerId: "off_1",
              listingId: "listing_1",
              feeQuoteFingerprint: "fee_quote_1",
              sourceActionKey: "seller-desk:accept-offer-1",
              idempotencyKey: "seller-desk-accept-offer-1",
              confirmationText: "Accept Offer.",
            },
            confirmation: { confirmed: true, text: "Accept Offer." },
          }),
        ),
      ).toMatchObject({ accountId: "acc_seller", offerId: "off_1", status: "accepted" });

      // Step 4 — resolve money: read wallet and payouts, then request the payout.
      expect(
        expectStructured(
          await client.callTool({ name: "settlement.get-wallet", arguments: { accountId: "acc_seller" } }),
        ),
      ).toMatchObject({ accountId: "acc_seller", wallet });
      expect(
        expectStructured(
          await client.callTool({ name: "settlement.list-payouts", arguments: { accountId: "acc_seller" } }),
        ),
      ).toMatchObject({ accountId: "acc_seller" });

      expect(
        expectStructured(
          await callConfirmedTool(client, {
            name: "settlement.request-payout",
            arguments: {
              accountId: "acc_seller",
              amount: "24.00",
              reason: "Resolve the blocked payout surfaced by the Seller Desk queue.",
              idempotencyKey: "seller-desk-request-payout-1",
              confirmationText: "Request Payout.",
            },
            confirmation: { confirmed: true, text: "Request Payout." },
          }),
        ),
      ).toMatchObject({ accountId: "acc_seller", payoutId: "payout_1", status: "requested" });

      // Step 5 — the blocked payout has cleared. Re-loading the queue no longer
      // surfaces the settlement-blocked-payout item, and the rollup agrees.
      const resolvedQueue = expectStructured(
        await client.callTool({
          name: "marketplace.get-seller-attention-queue",
          arguments: { accountId: "acc_seller" },
        }),
      );
      expect(resolvedQueue).toEqual(queueWith([shipByItem, offerItem]));
      expect((resolvedQueue as { items: readonly (typeof shipByItem)[] }).items.map((item) => item.source)).toEqual([
        "fulfillment-ship-by",
        "offer-response",
      ]);
      expect(
        (resolvedQueue as { rollup: { bySource: Record<string, number> } }).rollup.bySource[
          "settlement-blocked-payout"
        ],
      ).toBe(0);
    });

    // The connector actually exercised each write leg of the journey.
    expect(shipmentServices.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(shipmentServices.dispatchShipment).toHaveBeenCalledTimes(1);
    expect(offerServices.acceptOffer).toHaveBeenCalledTimes(1);
    expect(settlementServices.payouts.requestPayout).toHaveBeenCalledTimes(1);
    expect(loadQueue).toHaveBeenCalledTimes(2);
  });

  it("scopes the attention queue to the authenticated seller account", async () => {
    const loadQueue = vi.fn(async () => queueWith([]));
    const marketplaceServices = {
      listings: {},
      offers: {},
      reviews: {},
      sellerAttentionQueue: { loadQueue },
    };
    const app = buildPlatformApiApp(
      createRuntime({ marketplace: marketplaceServices }, [
        { module: marketplaceModule, services: marketplaceServices },
      ]),
      {
        resolveActor: vi.fn(async () => agentActor([...SELLER_JOURNEY_PERMISSIONS])),
      },
    );

    await withMcpClient(app, async (client) => {
      const crossAccount = await client.callTool({
        name: "marketplace.get-seller-attention-queue",
        arguments: { accountId: "acc_other" },
      });
      expect(crossAccount.isError).toBe(true);
      expect(textContent(crossAccount)).toContain("account");
    });
    expect(loadQueue).not.toHaveBeenCalled();
  });

  it("documents every journey step's transport status, with web-pending steps named against their surface", () => {
    // The MCP connector carries every step of the journey today.
    for (const step of JOURNEY_COVERAGE) {
      expect(step.mcp, `${step.id} must be live on the MCP transport`).toBe("live");
      expect(step.mcpTools.length).toBeGreaterThan(0);
      // Any step still pending on the web transport names the surface it waits on,
      // so nothing is silently dropped from the acceptance gate.
      if (step.web === "pending") {
        expect(step.webPendingOn, `${step.id} web-pending must name its surface`).toBeTruthy();
      }
    }
    // The five canonical journey steps the issue enumerates are all present.
    expect(JOURNEY_COVERAGE.map((step) => step.id)).toEqual([
      "attention-queue",
      "act-ship",
      "act-offer",
      "resolve-money",
      "resolve-blocked-payout",
    ]);
  });
});
