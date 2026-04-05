import { describe, expect, it } from "vitest";
import type { ResolvedActor } from "@chase-sets/identity/server";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import { module as paymentsModule } from "@chase-sets/payments";
import { module as reputationModule } from "@chase-sets/reputation";
import { module as settlementModule } from "@chase-sets/settlement";
import { buildMarketplaceApp } from "../src/app";

const services: ReturnType<typeof discoveryModule.createServices> = {
  items: {
    search: {
      searchItems: async () => ({ items: [], total: 0 }),
      rebuildSearchIndex: async () => {},
      projectors: [],
    },
    detail: {
      getItemDetail: async () => null,
      projectors: [],
    },
    projectors: [],
  },
  categories: {
    listCategories: async () => [],
    projectors: [],
  },
  projectors: [],
};

const marketplaceServices: ReturnType<typeof marketplaceModule.createServices> = {
  listings: {
    commandHandler: async () => ({ version: 1 }),
    createListing: async () => ({ listingId: "lst_1" as never, version: 1 }),
    updateListingPrice: async () => ({ listingId: "lst_1", version: 1 }),
    updateListingQuantityCap: async () => ({ listingId: "lst_1", version: 1 }),
    publishListing: async () => ({ listingId: "lst_1", version: 1 }),
    pauseListing: async () => ({ listingId: "lst_1", version: 1 }),
    withdrawListing: async () => ({ listingId: "lst_1", version: 1 }),
    listSellerListings: async () => ({ items: [], total: 0 }),
    getSellerListing: async () => null,
    getMarketSummaryForItem: async () => ({
      lowest_price_amount: null,
      active_listing_count: 0,
      total_visible_quantity: 0,
    }),
    listItemListings: async () => [],
    getInventoryRecordSupply: async () => null,
    projectors: [],
  },
  offers: {
    commandHandler: async () => ({ version: 1 }),
    submitOffer: async () => ({ offerId: "off_1" as never, version: 1 }),
    acceptOffer: async () => ({ offerId: "off_1" as never, version: 2 }),
    listBuyerOffers: async () => ({ items: [], total: 0 }),
    getBuyerOffer: async () => null,
    listSellerVisibleOffers: async () => ({ items: [], total: 0 }),
    getSellerVisibleOffer: async () => null,
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const inventoryServices: ReturnType<typeof inventoryModule.createServices> = {
  catalogItems: { getCatalogItemSnapshot: async () => null, projectors: [] } as never,
  storageLocations: {} as never,
  records: {} as never,
  holds: {
    commandHandler: async () => ({ version: 1 }),
    createHold: async () => ({ holdId: "hld_1" as never, version: 1 }),
    releaseHold: async () => ({ holdId: "hld_1", version: 2 }),
    getHold: async () => null,
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const fulfillmentServices: ReturnType<typeof fulfillmentModule.createServices> = {
  shipments: {
    commandHandler: async () => ({
      version: 1,
      state: {} as never,
      newEvents: [],
      storedEvents: [],
    }),
    packShipment: async () => ({ shipmentId: "shp_1", version: 2 }),
    attachLabel: async () => ({ shipmentId: "shp_1", version: 3 }),
    dispatchShipment: async () => ({ shipmentId: "shp_1", version: 4 }),
    deliverShipment: async () => ({ shipmentId: "shp_1", version: 5 }),
    returnShipment: async () => ({ shipmentId: "shp_1", version: 6 }),
    raiseShipmentException: async () => ({ shipmentId: "shp_1", version: 7 }),
    listBuyerShipments: async () => ({ items: [], total: 0 }),
    getBuyerShipment: async () => null,
    listSellerShipments: async () => ({ items: [], total: 0 }),
    getSellerShipment: async () => null,
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const orderingServices: ReturnType<typeof orderingModule.createServices> = {
  cart: {
    commandHandler: async () => ({ version: 1 }),
    addLine: async () => ({ lineId: "cli_1" as never, version: 1 }),
    setLineQuantity: async () => ({ lineId: "cli_1" as never, version: 2 }),
    removeLine: async () => ({ lineId: "cli_1" as never, version: 3 }),
    checkout: async () => ({ version: 4 }),
    listCartLines: async () => [],
    projectors: [],
  },
  orders: {
    commandHandler: async () => ({ version: 1 }),
    checkoutCart: async () => ({ orderIds: ["ord_1" as never] }),
    createOrdersFromAcceptedOffer: async () => ({ orderIds: ["ord_1" as never] }),
    cancelBuyerOrder: async () => ({ orderId: "ord_1", version: 2 }),
    cancelSellerOrder: async () => ({ orderId: "ord_1", version: 2 }),
    listBuyerOrders: async () => ({ items: [], total: 0 }),
    getBuyerOrder: async () => null,
    listSellerOrders: async () => ({ items: [], total: 0 }),
    getSellerOrder: async () => null,
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const paymentsServices: ReturnType<typeof paymentsModule.createServices> = {
  payments: {
    commandHandler: async () => ({ version: 1, state: {} as never, newEvents: [], storedEvents: [] }),
    createBuyerPayment: async () => ({
      payment_id: "pay_1",
      buyer_account_id: "acc_1",
      order_ids: ["ord_1"],
      amount: "24.99",
      currency_code: "usd",
      processor_name: "stripe",
      processor_payment_reference: "pi_1",
      processor_client_secret: "pi_1_secret_1",
      processor_status: "requires_payment_method",
      status: "pending-confirmation",
      failure_code: null,
      failure_message: null,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      captured_at: null,
      failed_at: null,
      cancelled_at: null,
      processor_publishable_key: "pk_test_123",
    }),
    getBuyerPayment: async () => null,
    processWebhook: async () => ({ received: true, ignored: false }),
    publicConfig: { processorName: "stripe", publishableKey: "pk_test_123" },
    projectors: [],
  },
  refunds: {
    commandHandler: async () => ({ version: 1, state: {} as never, newEvents: [], storedEvents: [] }),
    issueRefund: async () => ({ refundId: "rfd_1" as never, version: 1 }),
    projectors: [],
  },
  publicConfig: { processorName: "stripe", publishableKey: "pk_test_123" },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const reputationServices: ReturnType<typeof reputationModule.createServices> = {
  reviews: {
    commandHandler: async () => ({
      version: 1,
      state: {} as never,
      newEvents: [],
      storedEvents: [],
    }),
    submitReview: async () => ({ reviewId: "rev_1", version: 1 }),
    updateReview: async () => ({ reviewId: "rev_1", version: 2 }),
    withdrawReview: async () => ({ reviewId: "rev_1", version: 3 }),
    listPublicAccountReviews: async () => ({ items: [], total: 0 }),
    listWrittenReviews: async () => ({ items: [], total: 0 }),
    listReceivedReviews: async () => ({ items: [], total: 0 }),
    getAccountReview: async () => null,
    getPublicAccountSummary: async () => ({
      account_id: "acc_1",
      account_display_name: "Account One",
      average_rating: "5.00",
      review_count: 1,
      rating_1_count: 0,
      rating_2_count: 0,
      rating_3_count: 0,
      rating_4_count: 0,
      rating_5_count: 1,
      updated_at: "2026-04-02T00:00:00.000Z",
    }),
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

const settlementServices: ReturnType<typeof settlementModule.createServices> = {
  wallets: {
    commandHandler: async () => ({ version: 1, state: {} as never, newEvents: [], storedEvents: [] }),
    getWallet: async () => ({
      account_id: "acc_1",
      currency_code: "usd",
      pending_balance_amount: "0.00",
      available_balance_amount: "0.00",
      opened_at: "2026-04-02T00:00:00.000Z",
      updated_at: "2026-04-02T00:00:00.000Z",
    }),
    listWalletEntries: async () => ({ items: [], total: 0 }),
    ensureWallet: async () => {},
    postEntry: async () => ({ accountId: "acc_1" as never, version: 1 }),
    releasePendingEntry: async () => ({ accountId: "acc_1" as never, version: 2 }),
    projectors: [],
  },
  payouts: {
    commandHandler: async () => ({ version: 1, state: {} as never, newEvents: [], storedEvents: [] }),
    listPayouts: async () => ({ items: [], total: 0 }),
    getPayout: async () => null,
    schedulePayout: async () => ({ payoutId: "pyo_1" as never, version: 1 }),
    markPayoutInTransit: async () => ({ payoutId: "pyo_1", version: 2 }),
    completePayout: async () => ({ payoutId: "pyo_1", version: 3 }),
    failPayout: async () => ({ payoutId: "pyo_1", version: 4 }),
    projectors: [],
  },
  projectors: [],
  pool: {} as never,
  db: {} as never,
};

describe("marketplace api host app", () => {
  it("mounts health and the discovery API under /api/marketplace", async () => {
    const app = buildMarketplaceApp({
      discovery: services,
      fulfillment: fulfillmentServices,
      inventory: inventoryServices,
      marketplace: marketplaceServices,
      ordering: orderingServices,
      payments: paymentsServices,
      reputation: reputationServices,
      settlement: settlementServices,
    });

    const healthResponse = await app.fetch(new Request("http://marketplace.test/health"));
    expect(healthResponse.status).toBe(200);

    const legacyResponse = await app.fetch(new Request("http://marketplace.test/api/items"));
    expect(legacyResponse.status).toBe(404);

    const discoveryResponse = await app.fetch(new Request("http://marketplace.test/api/marketplace/items"));
    expect(discoveryResponse.status).toBe(200);
  });

  it("hides empty categories from the marketplace category list", async () => {
    const app = buildMarketplaceApp({
      discovery: {
        ...services,
        categories: {
          ...services.categories,
          listCategories: async () => [
            {
              category_id: "cat_empty",
              key: "empty",
              name: "Empty",
              description: "No items yet",
              status: "active",
              parent_category_id: null,
              parent_category: null,
              display_order: 0,
              item_count: 0,
              updated_at: "2026-03-31T00:00:00.000Z",
            },
            {
              category_id: "cat_pokemon",
              key: "pokemon",
              name: "Pokemon",
              description: "Pokemon cards",
              status: "active",
              parent_category_id: null,
              parent_category: null,
              display_order: 1,
              item_count: 3,
              updated_at: "2026-03-31T00:00:00.000Z",
            },
          ],
        },
      },
      fulfillment: fulfillmentServices,
      inventory: inventoryServices,
      marketplace: marketplaceServices,
      ordering: orderingServices,
      payments: paymentsServices,
      reputation: reputationServices,
      settlement: settlementServices,
    });

    const response = await app.fetch(new Request("http://marketplace.test/api/marketplace/categories"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          category_id: "cat_pokemon",
          key: "pokemon",
          name: "Pokemon",
          description: "Pokemon cards",
          status: "active",
          parent_category_id: null,
          parent_category: null,
          display_order: 1,
          item_count: 3,
          updated_at: "2026-03-31T00:00:00.000Z",
        },
      ],
      total: 1,
      count: 1,
    });
  });

  it("mounts public listing routes under the marketplace API", async () => {
    const app = buildMarketplaceApp({
      discovery: services,
      fulfillment: fulfillmentServices,
      inventory: inventoryServices,
      marketplace: marketplaceServices,
      ordering: orderingServices,
      payments: paymentsServices,
      reputation: reputationServices,
      settlement: settlementServices,
    });

    const response = await app.fetch(
      new Request(
        "http://marketplace.test/api/marketplace/sellable-units/item-1::/market-summary",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      lowest_price_amount: null,
      active_listing_count: 0,
      total_visible_quantity: 0,
    });
  });

  it("mounts buyer offer routes under the marketplace API", async () => {
    const app = buildMarketplaceApp(
      {
        discovery: services,
        fulfillment: fulfillmentServices,
        inventory: inventoryServices,
        marketplace: marketplaceServices,
        ordering: orderingServices,
        payments: paymentsServices,
        reputation: reputationServices,
        settlement: settlementServices,
      },
      {
        resolveActor: async () =>
          ({
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["offers.view", "offers.manage"],
          }) satisfies ResolvedActor,
      },
    );

    const response = await app.fetch(
      new Request("http://marketplace.test/api/marketplace/buyer/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogItemId: "cat_1",
          itemTitle: "Charizard",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
          priceAmount: "10.00",
          quantityRequested: 1,
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "off_1", version: 1 });
  });

  it("mounts buyer cart checkout routes under the marketplace API", async () => {
    const app = buildMarketplaceApp(
      {
        discovery: services,
        fulfillment: fulfillmentServices,
        inventory: inventoryServices,
        marketplace: marketplaceServices,
        ordering: orderingServices,
        payments: paymentsServices,
        reputation: reputationServices,
        settlement: settlementServices,
      },
      {
        resolveActor: async () =>
          ({
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["orders.view", "orders.manage"],
          }) satisfies ResolvedActor,
      },
    );

    const response = await app.fetch(
      new Request("http://marketplace.test/api/marketplace/buyer/cart/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shippingOption: "standard" }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ orderIds: ["ord_1"] });
  });

  it("mounts buyer payment routes under the marketplace API", async () => {
    const app = buildMarketplaceApp(
      {
        discovery: services,
        fulfillment: fulfillmentServices,
        inventory: inventoryServices,
        marketplace: marketplaceServices,
        ordering: orderingServices,
        payments: paymentsServices,
        reputation: reputationServices,
        settlement: settlementServices,
      },
      {
        resolveActor: async () =>
          ({
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["orders.view", "orders.manage"],
          }) satisfies ResolvedActor,
      },
    );

    const response = await app.fetch(
      new Request("http://marketplace.test/api/marketplace/buyer/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: ["ord_1"] }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment_id: "pay_1",
      order_ids: ["ord_1"],
    });
  });

  it("mounts Stripe webhook routes outside marketplace auth", async () => {
    const app = buildMarketplaceApp({
      discovery: services,
      fulfillment: fulfillmentServices,
      inventory: inventoryServices,
      marketplace: marketplaceServices,
      ordering: orderingServices,
      payments: paymentsServices,
      reputation: reputationServices,
      settlement: settlementServices,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/api/payments/stripe/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, ignored: false });
  });

  it("mounts fulfillment routes under the marketplace API", async () => {
    const app = buildMarketplaceApp(
      {
        discovery: services,
        fulfillment: fulfillmentServices,
        inventory: inventoryServices,
        marketplace: marketplaceServices,
        ordering: orderingServices,
        payments: paymentsServices,
        reputation: reputationServices,
        settlement: settlementServices,
      },
      {
        resolveActor: async () =>
          ({
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["fulfillment.view", "fulfillment.manage"],
          }) satisfies ResolvedActor,
      },
    );

    const response = await app.fetch(
      new Request("http://marketplace.test/api/marketplace/seller/shipments"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
  });

  it("mounts public reputation routes under the marketplace API", async () => {
    const app = buildMarketplaceApp({
      discovery: services,
      fulfillment: fulfillmentServices,
      inventory: inventoryServices,
      marketplace: marketplaceServices,
      ordering: orderingServices,
      payments: paymentsServices,
      reputation: reputationServices,
      settlement: settlementServices,
    });

    const response = await app.fetch(
      new Request("http://marketplace.test/api/marketplace/accounts/acc_1/reputation"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      account_id: "acc_1",
      account_display_name: "Account One",
      average_rating: "5.00",
      review_count: 1,
      rating_1_count: 0,
      rating_2_count: 0,
      rating_3_count: 0,
      rating_4_count: 0,
      rating_5_count: 1,
      updated_at: "2026-04-02T00:00:00.000Z",
    });
  });

  it("mounts settlement routes under the settlement API", async () => {
    const app = buildMarketplaceApp(
      {
        discovery: services,
        fulfillment: fulfillmentServices,
        inventory: inventoryServices,
        marketplace: marketplaceServices,
        ordering: orderingServices,
        payments: paymentsServices,
        reputation: reputationServices,
        settlement: settlementServices,
      },
      {
        resolveActor: async () =>
          ({
            sessionId: "ses_1",
            tenantId: "tnt_identity",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["payouts.view", "payouts.manage"],
          }) satisfies ResolvedActor,
      },
    );

    const response = await app.fetch(
      new Request("http://marketplace.test/api/settlement/payouts"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      total: 0,
      count: 0,
    });
  });
});

