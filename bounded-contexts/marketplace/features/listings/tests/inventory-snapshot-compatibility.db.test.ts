import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { normalizeAddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { MarketplaceApiEnv, CommercialTermsResolver } from "../../../api";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { createAccountListingRoutes } from "../api/route";
import { buildMarketplaceInventoryProjectionHandlers } from "../integrations/supply/supply-projection";
import { getInventoryItemSupply, listSellerInventoryItemSupply } from "../read-model/queries";
import { directPortInput, draftContext, draftMessage } from "./issue-7169-c4-fixture";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = adminUrl ? describe : describe.skip;
const syntheticAddress: AddressSnapshot = {
  name: "Synthetic Seller",
  line1: "1 Test Way",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  verification: {
    status: "corrected",
    source: "synthetic-contract-fixture",
    checkedAt: "2026-10-28T12:00:00Z",
    buyerDecision: "accepted-suggested",
    messages: ["Synthetic correction"],
    suggestedAddress: {
      name: "Synthetic Seller",
      line1: "2 Test Way",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
  },
};
const terms: CommercialTermsResolver = {
  resolveListingTerms: async ({ accountId, amount }) => ({
    accountId,
    accountType: "business",
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount: "1.00",
    sellerNetUnitAmount: "9.00",
    marketplaceSalesFeePercentageBps: 1000,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: null,
    shippingAllowancePercentageBps: 0,
    scheduleId: "cts_snapshot",
    agreementId: null,
    resolvedAt: "2026-10-28T12:00:00Z",
  }),
  resolveOrderTerms: async () => {
    throw new Error("Unused order terms");
  },
  resolvePublicStandardListingTerms: async () => {
    throw new Error("Unused public terms");
  },
  openListingTermsSession: async () => {
    throw new Error("Unused bulk terms");
  },
};

describeDb("Inventory snapshot PostgreSQL compatibility", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"marketplace">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminUrl!, ["marketplace"], "marketplace_snapshot_10599");
    await ensureMultiContextTestDatabases(adminUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  const owner = () => createMarketplaceServices(pools.marketplace, { commercialTermsResolver: terms });
  const snapshot = () => ({
    ...directPortInput(),
    shipFromAddress: syntheticAddress,
    acquisitionCostAmount: "12.34",
    acquisitionCostCurrencyCode: "CAD",
  });
  async function counts() {
    return (
      await pools.marketplace.query(`SELECT
      (SELECT count(*)::int FROM marketplace_supply_items) AS items,
      (SELECT count(*)::int FROM marketplace_supply_locations) AS locations,
      (SELECT count(*)::int FROM event_store_events) AS events`)
    ).rows[0];
  }
  function app() {
    const services = owner();
    const routes = new Hono<MarketplaceApiEnv>();
    routes.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_snapshot",
        tenantId: "tnt_c4",
        membershipId: "mbr_snapshot",
        roleKey: "owner",
        userId: "usr_c4",
        accountId: "acc_c4",
        permissions: ["listings.manage"],
      });
      c.set("context", draftContext);
      await next();
    });
    routes.route("/account", createAccountListingRoutes(services.listings));
    return { routes, services };
  }
  async function post(inventorySnapshot: unknown) {
    const { routes, services } = app();
    const response = await routes.request("/account/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceAmount: "10.00", priceCurrencyCode: "USD", quantityCap: 1, inventorySnapshot }),
    });
    return { response, services };
  }
  function routeSnapshot() {
    const {
      accountId: _account,
      importBatchId: _batch,
      importRowId: _row,
      listingIdOverride: _id,
      priceAmount: _price,
      priceCurrencyCode: _currency,
      quantityCap: _cap,
      ...value
    } = snapshot();
    return value;
  }

  it("retains synthetic non-null cost and verification through HTTP, SQL reads and Listing normalization", async () => {
    const { response, services } = await post(routeSnapshot());
    expect(response.status).toBe(201);
    const result = (await response.json()) as { id: string };
    const supply = await getInventoryItemSupply(pools.marketplace, snapshot().inventoryItemId, "acc_c4");
    expect(supply).toMatchObject({
      acquisition_cost_amount: "12.34",
      acquisition_cost_currency_code: "CAD",
      ship_from_address: syntheticAddress,
    });
    expect((await listSellerInventoryItemSupply(pools.marketplace, { accountId: "acc_c4" })).items[0]).toMatchObject({
      acquisition_cost_currency_code: "CAD",
    });
    expect((await services.listings.loadListingState(result.id)).shipFromAddress).toEqual(
      normalizeAddressSnapshot(syntheticAddress),
    );
    expect(
      (
        await pools.marketplace.query(
          "SELECT acquisition_cost_amount::text, acquisition_cost_currency_code FROM marketplace_supply_items",
        )
      ).rows[0],
    ).toEqual({ acquisition_cost_amount: "12.34", acquisition_cost_currency_code: "CAD" });
  });

  it("keeps explicit nulls and legacy amount-only direct/batch/import inputs as unknown denomination", async () => {
    const services = owner();
    const nullResult = await services.listings.createListingFromInventorySnapshot(
      {
        ...snapshot(),
        inventoryItemId: "inv_null",
        listingIdOverride: "lst_null" as never,
        acquisitionCostAmount: null,
        acquisitionCostCurrencyCode: null,
        shipFromAddress: { ...syntheticAddress, verification: null },
      },
      draftContext,
    );
    expect(nullResult.state.shipFromAddress?.verification).toBeNull();
    const legacy = { ...directPortInput(), acquisitionCostAmount: "5.00" };
    await services.listings.createBatchDraftListingFromInventorySnapshot(legacy, draftContext);
    await services.listings.createBatchDraftListingFromInventorySnapshot(legacy, draftContext);
    const message = {
      ...draftMessage(),
      messageId: "imr_legacy_2",
      snapshot: {
        ...draftMessage().snapshot,
        importRowId: "imr_legacy_2",
        inventoryItemId: "inv_import_legacy",
        acquisitionCostAmount: "7.00",
      },
    };
    await services.inventoryDraftListingConsumer.accept(message, draftContext);
    expect(
      (
        await pools.marketplace.query(
          "SELECT item_id, acquisition_cost_amount::text, acquisition_cost_currency_code FROM marketplace_supply_items ORDER BY item_id",
        )
      ).rows,
    ).toEqual([
      { item_id: "inv_c4", acquisition_cost_amount: "5.00", acquisition_cost_currency_code: null },
      { item_id: "inv_import_legacy", acquisition_cost_amount: "7.00", acquisition_cost_currency_code: null },
      { item_id: "inv_null", acquisition_cost_amount: null, acquisition_cost_currency_code: null },
    ]);
  });

  it.each([
    { unexpected: true },
    { shipFromAddress: { ...syntheticAddress, verification: { ...syntheticAddress.verification, unexpected: true } } },
    {
      shipFromAddress: {
        ...syntheticAddress,
        verification: { ...syntheticAddress.verification, checkedAt: "2026-10-28" },
      },
    },
    { acquisitionCostAmount: "10000000000.00" },
    { acquisitionCostCurrencyCode: "usd" },
  ])("refuses malformed HTTP snapshots without either mirror or Listing writes: %j", async (change) => {
    const before = await counts();
    expect((await post({ ...routeSnapshot(), ...change })).response.status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it("rejects invalid shared creator cost/address before the first mirror write", async () => {
    const services = owner();
    for (const create of [
      services.listings.createListingFromInventorySnapshot,
      services.listings.createBatchDraftListingFromInventorySnapshot,
    ]) {
      for (const change of [
        { acquisitionCostAmount: "-1.00" },
        { acquisitionCostCurrencyCode: "usd" },
        {
          shipFromAddress: {
            ...syntheticAddress,
            verification: { ...syntheticAddress.verification!, checkedAt: "2026-10-28" },
          },
        },
      ]) {
        await expect(create({ ...snapshot(), ...change }, draftContext)).rejects.toThrow();
        expect(await counts()).toEqual({ items: 0, locations: 0, events: 0 });
      }
    }
  });

  it("rebuilds supplied and legacy Inventory events with currency honesty and repeat fences", async () => {
    const pool = pools.marketplace;
    const handlers = buildMarketplaceInventoryProjectionHandlers(pool);
    const data = snapshot();
    const location = buildTransportEvent("inventory.storage-location.created", {
      storageLocationId: data.storageLocationId,
      accountId: data.accountId,
      name: data.storageLocationName,
      shipFromCode: data.shipFromCode,
      shipFromAddress: syntheticAddress,
    });
    const current = buildTransportEvent("inventory.item.created", { ...data, itemId: "inv_current" });
    const { acquisitionCostCurrencyCode: _currency, ...old } = data;
    const legacy = buildTransportEvent("inventory.item.created", { ...old, itemId: "inv_legacy" });
    const project = async () => {
      for (const event of [location, current, legacy, current, legacy]) await handlers[event.type]!(event);
      expect(
        (
          await pool.query(
            "SELECT item_id, acquisition_cost_currency_code FROM marketplace_supply_items ORDER BY item_id",
          )
        ).rows,
      ).toEqual([
        { item_id: "inv_current", acquisition_cost_currency_code: "CAD" },
        { item_id: "inv_legacy", acquisition_cost_currency_code: null },
      ]);
      expect((await getInventoryItemSupply(pool, "inv_current", data.accountId))?.ship_from_address).toEqual(
        syntheticAddress,
      );
    };
    await project();
    await pool.query("TRUNCATE marketplace_supply_items, marketplace_supply_locations");
    await project();
  });
});
