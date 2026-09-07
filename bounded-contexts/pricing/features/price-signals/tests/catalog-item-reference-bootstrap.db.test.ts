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
import { module as pricingModule } from "../../../index";
import { selectMarketCaptureSignalWork } from "../read-model/provider-observation-writes";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};

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
    const pricing = pricingModule.createServices(pools.pricing, {
      tcgplayerMarketTransport: { kind: "not-mounted" },
      tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    });
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
      eventTypes: declared.eventTypes?.filter(
        (eventType) => !eventType.includes("external-catalog-item-reference"),
      ),
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

    const v6 = createSubscriptionRunner("pricing", pools.pricing, pools.catalog, declared);
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
