import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import type { PricingApiEnv } from "../../../api";
import { getRepricingAuthoringPrerequisites } from "../read-model/controls";
import { createRepricingPolicyRuntime } from "../api/runtime";
import { createRepricingPolicyRoutes } from "../api/route";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("authoring prerequisites", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "authoring_prerequisites_7915");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  const read = (account = "acc_a") => getRepricingAuthoringPrerequisites(pools.pricing, account);
  async function listing(
    id: string,
    currency: string | null,
    inventory: string | null = null,
    account = "acc_a",
    status = "active",
  ) {
    await pools.pricing.query(
      `INSERT INTO pricing_market_listing_inputs
      (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, price_amount, price_currency_code, quantity_cap, status, updated_at)
      VALUES ($1, $2, $3, 'cat_synthetic', 'prod_synthetic', 10, $4, 1, $5, now())`,
      [id, account, inventory, currency, status],
    );
  }
  async function inventory(id: string, amount: string | null, account = "acc_a") {
    await pools.pricing.query(
      `INSERT INTO pricing_inventory_item_inputs
      (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, acquisition_cost_amount, acquisition_cost_currency_code, updated_at, last_stream_version)
      VALUES ($1, $2, 'cat_synthetic', 'prod_synthetic', 1, $3, NULL, now(), 1)`,
      [id, account, amount],
    );
  }
  function route(accountId = "acc_a") {
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", {
        sessionId: "ses_synthetic",
        tenantId: "tnt_identity",
        userId: "usr_synthetic",
        accountId,
        membershipId: "mbr_synthetic",
        roleKey: "viewer",
        permissions: ["pricing.view"],
      });
      return next();
    });
    const { eventStore } = createInMemoryEventStore();
    app.route(
      "/policies",
      createRepricingPolicyRoutes({
        ...createRepricingPolicyRuntime({ eventStore, db: pools.pricing }),
        activateRepricingPolicy: async () => null,
      }),
    );
    return app;
  }
  it("reads zero/one/multiple sorted currencies, duplicate/null and withdrawn-listing cases without scope, assignment or halt filters", async () => {
    expect(await read()).toEqual({ listingCurrencyCodes: [], hasCostBasis: false });
    await listing("lst_null", null);
    expect(await read()).toEqual({ listingCurrencyCodes: [], hasCostBasis: false });
    await listing("lst_usd", "USD");
    await listing("lst_duplicate", "USD");
    expect(await read()).toEqual({ listingCurrencyCodes: ["USD"], hasCostBasis: false });
    await inventory("inv_withdrawn", "0");
    await listing("lst_withdrawn", "CAD", "inv_withdrawn", "acc_a", "withdrawn");
    await pools.pricing
      .query(`INSERT INTO pricing_repricing_halts (seller_account_id, engaged, engaged_at, released_at, updated_at, last_stream_version)
      VALUES ('acc_a', true, now(), NULL, now(), 1)`);
    expect(await read()).toEqual({ listingCurrencyCodes: ["CAD", "USD"], hasCostBasis: true });
    const response = await route().request("/policies/authoring-prerequisites");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await read());
    const spoof = await route().request("/policies/authoring-prerequisites?accountId=acc_b");
    expect(spoof.status).toBe(400);
  });
  it("joins the exact listed item and seller: unlisted, same-product other-item and foreign costs never supply A's evidence", async () => {
    await listing("lst_a", "USD", "inv_a");
    await inventory("inv_a", null);
    await inventory("inv_unlisted", "4");
    await inventory("inv_foreign", "6", "acc_b");
    await listing("lst_bad_link", null, "inv_foreign");
    const expected = { listingCurrencyCodes: ["USD"], hasCostBasis: false };
    expect(await read()).toEqual(expected);
    await listing("lst_b", "EUR", "inv_foreign", "acc_b");
    expect(await read()).toEqual(expected);
    expect(await read("acc_b")).toEqual({ listingCurrencyCodes: ["EUR"], hasCostBasis: true });
    await pools.pricing.query(
      "UPDATE pricing_inventory_item_inputs SET acquisition_cost_amount = 999 WHERE seller_account_id = 'acc_b'",
    );
    expect(await (await route().request("/policies/authoring-prerequisites")).json()).toEqual(expected);
    await pools.pricing.query(
      "UPDATE pricing_inventory_item_inputs SET acquisition_cost_amount = 0 WHERE item_id = 'inv_a'",
    );
    expect(await read()).toEqual({ ...expected, hasCostBasis: true });
    await pools.pricing.query(
      "UPDATE pricing_inventory_item_inputs SET acquisition_cost_amount = 5 WHERE item_id = 'inv_a'",
    );
    expect(await read()).toEqual({ ...expected, hasCostBasis: true });
  });
});
