import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { module as inventoryModule } from "@chase-sets/inventory";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MarketplaceApiEnv } from "../../../api";
import { createAccountListingRoutes } from "./route";
import { createMarketplaceListingRuntime } from "./runtime";
import { initialMarketplaceListingState } from "../domain/domain";
import { buildMarketplaceInventoryProjectionHandlers } from "../integrations/supply/supply-projection";
import { module as marketplaceModule } from "../../../index";

const context = {
  tenantId: "tnt_snapshot" as never,
  audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
};
const address = {
  name: "Synthetic Seller",
  line1: "1 Test Way",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  verification: null,
};
const verification = {
  status: "corrected",
  source: "synthetic-contract-fixture",
  checkedAt: "2026-10-28T12:00:00Z",
  buyerDecision: "accepted-suggested",
  suggestedAddress: { ...address, verification: undefined },
  messages: ["Synthetic correction"],
};

async function producerSnapshot() {
  const pool: PgTransactionalPool = {
    query: async <Row>(sql: string) => {
      if (sql.includes("FROM inventory_storage_locations"))
        return {
          rows: [
            {
              storage_location_id: "loc_stock",
              account_id: "acc_seller",
              name: "Listing stock",
              ship_from_code: "US-IL",
              ship_from_address: address,
              is_archived: false,
            },
          ] as Row[],
        };
      if (sql.includes("FROM inventory_items AS item")) return { rows: [] };
      throw new Error(`Unexpected producer query: ${sql}`);
    },
    connect: async () => {
      throw new Error("No producer database transaction in this contract test");
    },
  };
  const inventory = inventoryModule.createServices(pool, {});
  // Keep the real public producer and domain; replace only persistence/recovery.
  vi.spyOn(inventory.mutations, "execute").mockImplementation(async (_f, _t, _a, _p, _c, work) => work());
  const { eventStore } = createInMemoryEventStore();
  vi.spyOn(inventory.mutations.eventStore, "readStream").mockImplementation(eventStore.readStream);
  vi.spyOn(inventory.mutations.eventStore, "appendToStream").mockImplementation(eventStore.appendToStream);
  vi.spyOn(inventory.catalogItems, "getCatalogItem").mockResolvedValue({
    catalog_item_id: "cat_raw",
    language_code: "en",
    title: "Synthetic raw product",
    subtitle: null,
    blueprint_id: null,
    status: "active",
    product_schema: null,
    updated_at: "2026-10-28T00:00:00Z",
  });
  return (
    await inventory.items.ensureListingStock(
      {
        accountId: "acc_seller" as never,
        catalogItemId: "cat_raw",
        selectedOptions: [],
        quantity: 2,
      },
      context,
    )
  ).snapshot;
}

function harness() {
  const { eventStore } = createInMemoryEventStore();
  const services = createMarketplaceListingRuntime({
    eventStore,
    db: { query: vi.fn(async () => ({ rows: [] })) },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    commercialTermsResolver: {} as never,
  });
  const create = vi.spyOn(services, "createListingFromInventorySnapshot").mockResolvedValue({
    listingId: "lst_snapshot" as never,
    version: 1,
    feeQuoteFingerprint: null,
    state: initialMarketplaceListingState,
  });
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_snapshot",
      tenantId: "tnt_snapshot",
      membershipId: "mbr_snapshot",
      roleKey: "owner",
      userId: "usr_seller",
      accountId: "acc_seller",
      permissions: ["listings.manage"],
    });
    c.set("context", context);
    await next();
  });
  app.route("/account", createAccountListingRoutes(services));
  return { app, create, services };
}

describe("Inventory Listing stock compatibility", () => {
  it("writes currency and verification through both existing snapshot creators", async () => {
    const snapshot = await producerSnapshot();
    const { verification: _verification, ...suggestedAddress } = address;
    const shipFromAddress = {
      ...address,
      verification: {
        ...verification,
        status: "corrected" as const,
        buyerDecision: "accepted-suggested" as const,
        suggestedAddress,
      },
    };
    for (const method of [
      "createListingFromInventorySnapshot",
      "createBatchDraftListingFromInventorySnapshot",
    ] as const) {
      const writes: { sql: string; values: readonly unknown[] }[] = [];
      // A missing supply read terminates after the real mirror writes, before Listing creation.
      const db = {
        query: async (sql: string, values: readonly unknown[] = []) => {
          writes.push({ sql, values });
          return { rows: [] };
        },
      };
      const { eventStore } = createInMemoryEventStore();
      const runtime = createMarketplaceListingRuntime({
        db,
        eventStore,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
        commercialTermsResolver: {} as never,
      });
      await expect(
        runtime[method](
          {
            ...snapshot,
            accountId: "acc_seller",
            shipFromAddress,
            acquisitionCostAmount: "12.34",
            acquisitionCostCurrencyCode: "CAD",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            importBatchId: "imb_test",
            importRowId: "imr_test",
            listingIdOverride: "lst_test" as never,
          },
          context,
        ),
      ).rejects.toThrow("Inventory item not found.");
      const location = writes.find((write) => write.sql.includes("INSERT INTO marketplace_supply_locations"))!;
      const item = writes.find((write) => write.sql.includes("INSERT INTO marketplace_supply_items"))!;
      expect(JSON.parse(String(location.values[4]))).toEqual(shipFromAddress);
      expect(item.sql).toContain("acquisition_cost_currency_code = EXCLUDED.acquisition_cost_currency_code");
      expect(item.values.slice(8)).toEqual(["12.34", "CAD"]);
    }
  });

  it("projects supplied and legacy currency without inference and registers its upgrade", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildMarketplaceInventoryProjectionHandlers({ query });
    const snapshot = await producerSnapshot();
    for (const currency of ["CAD", null, undefined]) {
      const event = buildTransportEvent("inventory.item.created", {
        ...snapshot,
        itemId: snapshot.inventoryItemId,
        accountId: "acc_seller",
        acquisitionCostAmount: "12.34",
        acquisitionCostCurrencyCode: currency,
      });
      await handlers[event.type]!(event);
      const [sql, values] = query.mock.calls.at(-1)!;
      expect(sql).toContain("acquisition_cost_currency_code = EXCLUDED.acquisition_cost_currency_code");
      expect(values?.[9]).toBe(currency ?? null);
    }
    const migration = marketplaceModule.schemaMigrations?.find(
      (entry) => entry.migrationId === "20261028_marketplace_supply_acquisition_cost_currency",
    );
    expect(migration?.statements).toContain(
      "ALTER TABLE marketplace_supply_items ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL",
    );
  });
  it.each(["json", "multipart"])(
    "accepts the real raw-product ensure snapshot unchanged over %s",
    async (transport) => {
      const snapshot = await producerSnapshot();
      expect(snapshot.acquisitionCostCurrencyCode).toBeNull();
      expect(snapshot.shipFromAddress.verification).toBeNull();
      const { app, create } = harness();
      const body = {
        inventoryItemId: "",
        priceAmount: "999.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        inventorySnapshot: snapshot,
      };
      const form = new FormData();
      for (const [key, value] of Object.entries(body))
        form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      const response = await app.request("/account/listings", {
        method: "POST",
        ...(transport === "json"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : { body: form }),
      });
      expect(await response.json()).not.toHaveProperty("error");
      expect(response.status).toBe(201);
      expect(create).toHaveBeenCalledWith(expect.objectContaining(snapshot), context);
    },
  );

  it("forwards supplied cost denomination and primitive verification without loss", async () => {
    const produced = await producerSnapshot();
    const { verification: _verification, ...suggestedAddress } = address;
    const snapshot = {
      ...produced,
      acquisitionCostAmount: "12.34",
      acquisitionCostCurrencyCode: "CAD",
      shipFromAddress: { ...address, verification: { ...verification, suggestedAddress } },
    };
    const { app, create } = harness();
    const response = await app.request("/account/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priceAmount: "999.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        inventorySnapshot: snapshot,
      }),
    });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining(snapshot), context);
  });

  it.each([
    { label: "snapshot unknown", change: { unknown: true } },
    { label: "address unknown", change: { shipFromAddress: { ...address, unknown: true } } },
    {
      label: "verification unknown",
      change: { shipFromAddress: { ...address, verification: { ...verification, unknown: true } } },
    },
    {
      label: "suggested address unknown",
      change: {
        shipFromAddress: {
          ...address,
          verification: { ...verification, suggestedAddress: { ...address, unknown: true } },
        },
      },
    },
    {
      label: "recursive verification",
      change: {
        shipFromAddress: {
          ...address,
          verification: { ...verification, suggestedAddress: { ...address, verification } },
        },
      },
    },
    ...["verified-by-seller", 3, null].map((status) => ({
      label: `invalid status ${status}`,
      change: { shipFromAddress: { ...address, verification: { ...verification, status } } },
    })),
    ...["2026-10-28", "2026-02-30T12:00:00Z", "2026-10-28T25:00:00Z", "2026-10-28T12:00:00"].map((checkedAt) => ({
      label: `invalid instant ${checkedAt}`,
      change: { shipFromAddress: { ...address, verification: { ...verification, checkedAt } } },
    })),
    {
      label: "empty source",
      change: { shipFromAddress: { ...address, verification: { ...verification, source: " " } } },
    },
    {
      label: "invalid decision",
      change: { shipFromAddress: { ...address, verification: { ...verification, buyerDecision: "auto-approved" } } },
    },
    {
      label: "nontext messages",
      change: { shipFromAddress: { ...address, verification: { ...verification, messages: [42] } } },
    },
    ...[12.34, "-1.00", "1.234", "10000000000.00", "NaN"].map((acquisitionCostAmount) => ({
      label: `invalid amount ${acquisitionCostAmount}`,
      change: { acquisitionCostAmount },
    })),
    ...[123, "US", "usd", "USDD"].map((acquisitionCostCurrencyCode) => ({
      label: `invalid currency ${acquisitionCostCurrencyCode}`,
      change: { acquisitionCostCurrencyCode },
    })),
    { label: "currency without amount", change: { acquisitionCostAmount: null, acquisitionCostCurrencyCode: "CAD" } },
  ])("rejects $label before invoking either creator", async ({ change }) => {
    const { app, create } = harness();
    const snapshot = { ...(await producerSnapshot()), ...change };
    const response = await app.request("/account/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        priceAmount: "999.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        inventorySnapshot: snapshot,
      }),
    });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
