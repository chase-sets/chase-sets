import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, createSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "@chase-sets/catalog";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as pricingModule } from "../../../index";
import { selectMarketCaptureSignalWork } from "../read-model/provider-observation-writes";
import { Hono } from "hono";
import { buildPricingApi, type PricingApiEnv } from "../../../api";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildPricingCatalogInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const syntheticPricingHostPorts = {
  tcgplayerMarketTransport: { kind: "not-mounted" },
  tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies Parameters<typeof pricingModule.createServices>[1];

describeDb("Pricing Catalog v5-to-v6 historical bootstrap", () => {
  let pools: Readonly<Record<"catalog" | "pricing", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["catalog", "pricing"],
      "pricing_catalog_v6_bootstrap",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("replays a pre-upgrade product link from the null v6 checkpoint after v5 is advanced", async () => {
    const catalog = catalogModule.createServices(pools.catalog, {});
    const pricing = pricingModule.createServices(pools.pricing, syntheticPricingHostPorts);
    await command(catalog.items.commandHandler, "catalog.item-cat_synthetic", {
      type: "CreateCatalogItem",
      itemId: "cat_synthetic",
      title: localized("Synthetic Card"),
      subtitle: localized("Synthetic Set"),
      description: localized("Synthetic bootstrap fixture"),
    });
    await command(catalog.items.commandHandler, "catalog.item-cat_synthetic", {
      type: "LinkExternalCatalogItemReference",
      providerKey: "tcgplayer",
      externalKey: "product:7001",
    });
    await command(catalog.items.commandHandler, "catalog.item-cat_synthetic", {
      type: "LinkExternalProductReference",
      providerKey: "tcgplayer",
      externalKey: "sku:9001",
      selectedOptions: [],
    });

    const declared = pricingModule
      .buildSubscriptions?.(pricing)
      .find((entry) => entry.projectionName === "pricing-catalog-input-projection");
    if (!declared) throw new Error("Pricing Catalog subscription is missing.");
    const v5 = createSubscriptionRunner("pricing", pools.pricing, pools.catalog, {
      ...declared,
      subscriptionVersion: 5,
      eventTypes: declared.eventTypes?.filter((eventType) => !eventType.includes("external-catalog-item-reference")),
    });
    while ((await v5.runOnce()).processed > 0) {
      // Drain the real historical v5 checkpoint to source head.
    }
    const v5Checkpoint = await pools.pricing.query<{ last_global_position: string }>(
      `SELECT last_global_position::text
       FROM event_subscription_checkpoints
       WHERE checkpoint_key = $1`,
      [v5.checkpointKey],
    );
    expect(Number(v5Checkpoint.rows[0]?.last_global_position)).toBeGreaterThan(0);
    await expect(selectMarketCaptureSignalWork(pools.pricing, "tcgplayer", 1)).resolves.toEqual([]);

    const v6 = createSubscriptionRunner("pricing", pools.pricing, pools.catalog, {
      ...declared, subscriptionVersion: 6,
      eventTypes: declared.eventTypes?.filter((eventType) => !eventType.startsWith("catalog.category.")),
    });
    expect(v6.subscriptionVersion).toBe(6);
    while ((await v6.runOnce()).processed > 0) {
      // The disjoint v6 checkpoint starts at zero and replays Catalog history.
    }
    await expect(selectMarketCaptureSignalWork(pools.pricing, "tcgplayer", 1)).resolves.toEqual([
      expect.objectContaining({ productExternalKey: "product:7001", productId: 7001, catalogItemId: "cat_synthetic" }),
    ]);

    await v6.reset();
    const resetCheckpoint = await pools.pricing.query(
      `SELECT checkpoint_key FROM event_subscription_checkpoints WHERE checkpoint_key = $1`,
      [v6.checkpointKey],
    );
    expect(resetCheckpoint.rows).toEqual([]);
    while ((await v6.runOnce()).processed > 0) {
      // replay-only reset reuses the idempotent handler without deleting owned input truth
    }
    await expect(selectMarketCaptureSignalWork(pools.pricing, "tcgplayer", 1)).resolves.toHaveLength(1);
  });
  it("v7 replays renamed category names on a populated database, fences older events and boots twice", async () => {
    const catalog = catalogModule.createServices(pools.catalog, {});
    const pricing = pricingModule.createServices(pools.pricing, syntheticPricingHostPorts);
    const categoryId = "ctg_synthetic_7911";
    const streamId = `catalog.category-${categoryId}`;
    await catalog.categories.commandHandler({ streamId, context, command: { type: "CreateCategory", categoryId, key: "synthetic-7911", name: localized("Before") } });
    await catalog.categories.commandHandler({ streamId, context, command: { type: "PublishCategory" } });
    const declared = pricingModule.buildSubscriptions?.(pricing).find((entry) => entry.projectionName === "pricing-catalog-input-projection");
    if (!declared) throw new Error("Pricing catalog subscription missing.");
    const v6 = createSubscriptionRunner("pricing", pools.pricing, pools.catalog, { ...declared, subscriptionVersion: 6, eventTypes: declared.eventTypes?.filter((type) => !type.startsWith("catalog.category.")) });
    while ((await v6.runOnce()).processed > 0) {}
    await pools.pricing.query("INSERT INTO pricing_catalog_category_inputs (category_id, name, status, updated_at, last_stream_version) VALUES ($1, 'Before', 'active', now(), 2)", [categoryId]);
    await pools.pricing.query("INSERT INTO pricing_catalog_item_inputs (catalog_item_id, title, status, category_ids, updated_at) VALUES ('cat_synthetic_7911', 'Synthetic', 'active', ARRAY[$1::text], now())", [categoryId]);
    await pools.pricing.query("INSERT INTO pricing_market_listing_inputs (listing_id, seller_account_id, catalog_catalog_item_id, product_id, price_amount, quantity_cap, status, updated_at) VALUES ('lst_synthetic_7911', 'acc_synthetic', 'cat_synthetic_7911', 'prod_synthetic', 10, 1, 'active', now())");
    await catalog.categories.commandHandler({ streamId, context, command: { type: "ReviseCategory", key: "synthetic-7911", name: localized("Renamed") } });
    const v7 = createSubscriptionRunner("pricing", pools.pricing, pools.catalog, declared);
    expect(v7.subscriptionVersion).toBe(7);
    const app = new Hono<PricingApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { sessionId: "ses_synthetic", tenantId: context.tenantId, userId: context.audit.performedByUserId, accountId: c.req.header("x-synthetic-account") ?? "acc_synthetic", membershipId: "mbr_synthetic", roleKey: "owner", permissions: ["pricing.view"] });
      return next();
    });
    app.route("/", buildPricingApi(pricing));
    for (let boot = 0; boot < 2; boot++) {
      await bootstrapContextDatabase(pricingModule, pools.pricing);
      while ((await v7.runOnce()).processed > 0) {}
      expect(await (await app.request("/account/repricing-policies/categories")).json()).toEqual([{ id: categoryId, name: "Renamed", status: "active", listingCount: 1 }]);
      expect(await (await app.request("/account/repricing-policies/categories", { headers: { "x-synthetic-account": "acc_foreign" } })).json()).toEqual([{ id: categoryId, name: "Renamed", status: "active", listingCount: 0 }]);
      const old = (await createPostgresEventStore({ pool: pools.catalog }).readStream({ streamId }))[0]!;
      await buildPricingCatalogInputProjectionHandlers(pools.pricing)[old.eventType]!(toTransportEvent(old));
      await v7.reset();
    }
  });
});

async function command<Command>(
  handler: (input: { streamId: string; command: Command; context: EventStoreContext }) => Promise<unknown>,
  streamId: string,
  commandValue: Command,
) {
  return handler({ streamId, command: commandValue, context });
}

function localized(value: string) {
  return { defaultLocale: "en" as const, values: { en: value } };
}
