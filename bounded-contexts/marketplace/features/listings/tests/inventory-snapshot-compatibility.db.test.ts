import { listingTestCommand } from "./listing-attempt-test-support";
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
import { directPortInput, draftContext, draftMessage, draftProductMeasure } from "./issue-7169-c4-fixture";

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
    await pools.marketplace.query(
      "INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, product_measure_snapshots) VALUES ('cat_c4', 'Draft card', 'published', $1)",
      [JSON.stringify([draftProductMeasure()])],
    );
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
      body: JSON.stringify({
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        idempotencyKey: "inventory_snapshot_attempt_0000000000000001",
        inventorySnapshot,
      }),
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
      listingTestCommand("listing.create", {
        ...snapshot(),
        inventoryItemId: "inv_null",
        listingIdOverride: "lst_null" as never,
        acquisitionCostAmount: null,
        acquisitionCostCurrencyCode: null,
        shipFromAddress: { ...syntheticAddress, verification: null },
      }),
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
        await expect(
          create({ ...snapshot(), ...change, idempotencyKey: "snapshot_validation_attempt_0001" }, draftContext),
        ).rejects.toThrow();
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

  describe("supply mirror rows the snapshot's account does not own", () => {
    const otherAddress: AddressSnapshot = {
      name: "Other Seller",
      line1: "9 Other Rd",
      city: "Albany",
      state: "NY",
      postalCode: "12207",
      country: "US",
    };
    const seededAt = "2026-10-01T00:00:00.000Z";
    async function seedLocation(accountId: string, isArchived: boolean) {
      await pools.marketplace.query(
        `INSERT INTO marketplace_supply_locations
           (storage_location_id, account_id, name, ship_from_code, ship_from_address, is_archived, updated_at)
         VALUES ($1, $2, 'Other shelf', 'US-NY', $3, $4, $5)`,
        [snapshot().storageLocationId, accountId, JSON.stringify(otherAddress), isArchived, seededAt],
      );
    }
    async function seedItem(accountId: string) {
      await pools.marketplace.query(
        `INSERT INTO marketplace_supply_items
           (item_id, account_id, catalog_catalog_item_id, product_id, selected_options, graded_card,
            storage_location_id, total_quantity, acquisition_cost_amount, acquisition_cost_currency_code,
            last_stream_version, updated_at)
         VALUES ($1, $2, 'cat_c4', 'cat_c4::', '[]'::jsonb, NULL, 'loc_other', 7, 3.00, 'USD', 4, $3)`,
        [snapshot().inventoryItemId, accountId, seededAt],
      );
    }
    const rows = async (table: "marketplace_supply_items" | "marketplace_supply_locations") =>
      (await pools.marketplace.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    const eventCount = async () => (await counts()).events;
    async function expectNotFound(response: Response) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "inventory_item_not_found" } });
    }

    it("answers inventory_item_not_found and leaves another account's item row unchanged", async () => {
      await seedItem("acc_other");
      const before = await rows("marketplace_supply_items");

      await expectNotFound((await post(routeSnapshot())).response);

      expect(await rows("marketplace_supply_items")).toEqual(before);
      expect(await eventCount()).toBe(0);
    });

    it("answers inventory_item_not_found and leaves another account's archived storage location row unchanged", async () => {
      await seedLocation("acc_other", true);
      const before = await rows("marketplace_supply_locations");
      expect(before).toMatchObject([{ account_id: "acc_other", is_archived: true }]);

      await expectNotFound((await post(routeSnapshot())).response);

      expect(await rows("marketplace_supply_locations")).toEqual(before);
      expect(await rows("marketplace_supply_items")).toEqual([]);
      expect(await eventCount()).toBe(0);
    });

    it.each(["item", "location"] as const)(
      "both snapshot creators refuse a snapshot that names another account's %s row",
      async (owned) => {
        const services = owner();
        if (owned === "item") await seedItem("acc_other");
        else await seedLocation("acc_other", false);
        const guarded = owned === "item" ? "marketplace_supply_items" : "marketplace_supply_locations";
        const before = await rows(guarded);

        for (const create of [
          () =>
            services.listings.createListingFromInventorySnapshot(
              listingTestCommand("listing.create", snapshot()),
              draftContext,
            ),
          () => services.listings.createBatchDraftListingFromInventorySnapshot(snapshot(), draftContext),
        ]) {
          await expect(create()).rejects.toMatchObject({ code: "inventory-item-not-found" });
          expect(await rows(guarded)).toEqual(before);
          if (owned === "location") {
            expect(await rows("marketplace_supply_items")).toEqual([]);
          } else {
            // The location write comes first and names no existing row, so the account's own row is written.
            expect(await rows("marketplace_supply_locations")).toMatchObject([{ account_id: "acc_c4" }]);
          }
          expect(await eventCount()).toBe(0);
        }
      },
    );

    it("still updates the account's own rows and creates the Listing", async () => {
      await seedLocation("acc_c4", true);
      await seedItem("acc_c4");

      const { response, services } = await post(routeSnapshot());

      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      await expect(services.listings.loadListingState(id)).resolves.toMatchObject({ status: "draft" });
      expect(await rows("marketplace_supply_locations")).toMatchObject([
        {
          account_id: "acc_c4",
          name: snapshot().storageLocationName,
          ship_from_code: snapshot().shipFromCode,
          is_archived: false,
        },
      ]);
      expect(await rows("marketplace_supply_items")).toMatchObject([
        {
          account_id: "acc_c4",
          storage_location_id: snapshot().storageLocationId,
          total_quantity: snapshot().totalQuantity,
          acquisition_cost_currency_code: "CAD",
          // The snapshot leaves the stream version alone.
          last_stream_version: 4,
        },
      ]);
    });

    it("lets the first Inventory events replace rows a snapshot inserted, under whichever account they name", async () => {
      expect((await post(routeSnapshot())).response.status).toBe(201);
      expect(await rows("marketplace_supply_items")).toMatchObject([{ account_id: "acc_c4", last_stream_version: 0 }]);
      const handlers = buildMarketplaceInventoryProjectionHandlers(pools.marketplace);
      const data = snapshot();

      for (const event of [
        buildTransportEvent("inventory.storage-location.created", {
          storageLocationId: data.storageLocationId,
          accountId: "acc_other",
          name: "Other shelf",
          shipFromCode: "US-NY",
          shipFromAddress: otherAddress,
        }),
        buildTransportEvent("inventory.item.created", {
          ...data,
          itemId: data.inventoryItemId,
          accountId: "acc_other",
          totalQuantity: 9,
        }),
      ]) {
        await handlers[event.type]!(event);
      }

      expect(await rows("marketplace_supply_locations")).toMatchObject([
        { account_id: "acc_other", name: "Other shelf", ship_from_code: "US-NY", ship_from_address: otherAddress },
      ]);
      expect(await rows("marketplace_supply_items")).toMatchObject([
        { account_id: "acc_other", total_quantity: 9, last_stream_version: 1 },
      ]);
    });
  });
});
