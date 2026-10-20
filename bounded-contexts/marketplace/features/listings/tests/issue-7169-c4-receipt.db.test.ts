import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CommercialTermsResolver } from "../../../api";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { directPortInput, draftContext, draftMessage } from "./issue-7169-c4-fixture";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = adminUrl ? describe : describe.skip;
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
    scheduleId: "cts_c4",
    agreementId: null,
    resolvedAt: "2026-10-19T12:00:00.000Z",
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

describeDb("issue-7169-c4-draft-receipt PostgreSQL", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"marketplace">>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminUrl!, ["marketplace"], "marketplace_c4_receipt");
    await ensureMultiContextTestDatabases(adminUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pool);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  const services = (db: PgTransactionalPool) => createMarketplaceServices(db, { commercialTermsResolver: terms });

  async function counts() {
    return (
      await pool.query(`SELECT
      (SELECT count(*)::int FROM event_store_events) AS facts,
      (SELECT count(*)::int FROM event_store_events WHERE event_type = 'marketplace.listing.created') AS drafts,
      (SELECT count(*)::int FROM event_store_events WHERE event_type = 'marketplace.listing.published') AS publications,
      (SELECT count(*)::int FROM marketplace_inventory_draft_receipts) AS receipts,
      (SELECT count(*)::int FROM marketplace_supply_items) AS items,
      (SELECT count(*)::int FROM marketplace_supply_locations) AS locations,
      (SELECT count(*)::int FROM marketplace_listing_pages) AS pages`)
    ).rows[0];
  }

  function faultyPool(at: "receipt" | "commit" | "reply"): PgTransactionalPool {
    return {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            if (at === "receipt" && sql.includes("INSERT INTO marketplace_inventory_draft_receipts"))
              throw new Error("synthetic receipt kill");
            if (at === "commit" && sql === "COMMIT") throw new Error("synthetic pre-commit kill");
            const result = await client.query<Row>(sql, values);
            if (at === "reply" && sql === "COMMIT") throw new Error("synthetic reply loss after commit");
            return result;
          },
        };
      },
    };
  }

  it("coalesces concurrent independent connections and day-after delivery into exactly one receipt and draft", async () => {
    const consumer = services(pool).inventoryDraftListingConsumer;
    const results = await Promise.all(Array.from({ length: 6 }, () => consumer.accept(draftMessage(), draftContext)));
    for (const receipt of results) expect(receipt).toEqual(results[0]);
    expect(await counts()).toEqual({
      facts: 2,
      drafts: 1,
      publications: 0,
      receipts: 1,
      items: 1,
      locations: 1,
      pages: 0,
    });
    await bootstrapContextDatabase(marketplaceModule, pool);
    expect(await services(pool).inventoryDraftListingConsumer.accept(draftMessage(), draftContext)).toEqual(results[0]);
    expect(await counts()).toEqual({
      facts: 2,
      drafts: 1,
      publications: 0,
      receipts: 1,
      items: 1,
      locations: 1,
      pages: 0,
    });
    expect(
      (await pool.query("SELECT relpersistence FROM pg_class WHERE relname = 'marketplace_inventory_draft_receipts'"))
        .rows[0]?.relpersistence,
    ).toBe("p");
  });

  it("forwards a non-USD message through the creator and stores canonical currency and null limits", async () => {
    const message = { ...draftMessage(), snapshot: { ...draftMessage().snapshot, priceCurrencyCode: "CAD" as const } };
    const owner = services(pool);
    const receipt = await owner.inventoryDraftListingConsumer.accept(message, draftContext);
    expect((await owner.listings.loadListingState(receipt.listingId)).priceCurrencyCode).toBe("CAD");
    expect((await owner.listings.loadListingState(receipt.listingId)).purchaseLimits).toEqual({
      maxUnitsPerOrder: null,
      maxUnitsPerDay: null,
      maxUnitsPerCustomerAccount: null,
    });
    expect(await owner.inventoryDraftListingConsumer.accept(message, draftContext)).toEqual(receipt);
    expect((await counts())?.drafts).toBe(1);
  });

  it("keeps fresh-message and direct-port listing state equivalent apart from identity and option order", async () => {
    const owner = services(pool);
    const message = {
      ...draftMessage(),
      messageId: "imr_c4_2" as const,
      snapshot: { ...draftMessage().snapshot, importRowId: "imr_c4_2" as const },
    };
    const direct = await owner.listings.createBatchDraftListingFromInventorySnapshot(
      { ...directPortInput(), importRowId: "imr_c4_2", listingIdOverride: "lst_c4_2" as never },
      draftContext,
    );
    const receipt = await owner.inventoryDraftListingConsumer.accept(message, draftContext);
    const directState = await owner.listings.loadListingState(direct.listingId);
    const messageState = await owner.listings.loadListingState(receipt.listingId);
    const comparable = (state: typeof directState) => ({
      accountId: state.accountId,
      inventoryItemId: state.inventoryItemId,
      catalogItemId: state.catalogItemId,
      productId: state.productId,
      selectedOptions: [...state.selectedOptions].sort((left, right) =>
        left.dimensionId.localeCompare(right.dimensionId),
      ),
      gradedCard: state.gradedCard,
      storageLocationName: state.storageLocationName,
      shipFromCode: state.shipFromCode,
      shipFromAddress: state.shipFromAddress,
      priceAmount: state.priceAmount,
      priceCurrencyCode: state.priceCurrencyCode,
      quantityCap: state.quantityCap,
      purchaseLimits: state.purchaseLimits,
    });
    expect(comparable(messageState)).toEqual(comparable(directState));
  });

  it("serializes a real legacy direct writer against a consumer without a second creation or capacity fact", async () => {
    const owner = services(pool);
    const message = draftMessage();
    const [direct, receipt] = await Promise.all([
      owner.listings.createBatchDraftListingFromInventorySnapshot(directPortInput(), draftContext),
      owner.inventoryDraftListingConsumer.accept(message, draftContext),
    ]);
    expect(receipt.listingId).toBe(direct.listingId);
    expect(receipt.feeQuoteFingerprint).toBe(direct.feeQuoteFingerprint);
    expect(await counts()).toEqual({
      facts: 2,
      drafts: 1,
      publications: 0,
      receipts: 1,
      items: 1,
      locations: 1,
      pages: 0,
    });
  });

  it.each(["ledger", "trigger", "durability"] as const)(
    "refuses a missing exact %s prerequisite despite unrelated installed schema",
    async (missing) => {
      if (missing === "ledger")
        await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          "20261019_marketplace_inventory_draft_receipts_v1",
        ]);
      if (missing === "trigger")
        await pool.query(
          "ALTER TABLE marketplace_inventory_draft_receipts DISABLE TRIGGER marketplace_inventory_draft_receipts_immutable",
        );
      if (missing === "durability") await pool.query("ALTER TABLE marketplace_inventory_draft_receipts SET UNLOGGED");
      await expect(
        services(pool).inventoryDraftListingConsumer.accept(draftMessage(), draftContext),
      ).rejects.toMatchObject({ code: "inventory-draft-unavailable" });
      expect(await counts()).toEqual({
        facts: 0,
        drafts: 0,
        publications: 0,
        receipts: 0,
        items: 0,
        locations: 0,
        pages: 0,
      });
    },
  );

  it.each(["receipt", "commit"] as const)(
    "rolls back all listing/capacity facts, projections and receipt after a %s kill",
    async (at) => {
      await expect(
        services(faultyPool(at)).inventoryDraftListingConsumer.accept(draftMessage(), draftContext),
      ).rejects.toThrow();
      expect(await counts()).toEqual({
        facts: 0,
        drafts: 0,
        publications: 0,
        receipts: 0,
        items: 0,
        locations: 0,
        pages: 0,
      });
      await services(pool).inventoryDraftListingConsumer.accept(draftMessage(), draftContext);
      expect((await counts())?.receipts).toBe(1);
    },
  );

  it("reconciles durable acceptance after reply loss using only the original receipt", async () => {
    await expect(
      services(faultyPool("reply")).inventoryDraftListingConsumer.accept(draftMessage(), draftContext),
    ).rejects.toThrow();
    const consumer = services(pool).inventoryDraftListingConsumer;
    const receipt = await consumer.readReceipt("imr_c4_1", draftContext);
    expect(receipt).not.toBeNull();
    expect(await consumer.accept(draftMessage(), draftContext)).toEqual(receipt);
    expect((await counts())?.facts).toBe(2);
  });

  it("rejects changed intent and cross-authority delivery without disclosing or mutating the receipt", async () => {
    const consumer = services(pool).inventoryDraftListingConsumer;
    const message = draftMessage();
    const receipt = await consumer.accept(message, draftContext);
    const before = await counts();
    await expect(
      consumer.accept({ ...message, snapshot: { ...message.snapshot, quantityCap: 1 } }, draftContext),
    ).rejects.toMatchObject({ code: "inventory-draft-conflict" });
    const other = { ...draftContext, tenantId: "tnt_other" as never };
    await expect(
      consumer.accept({ ...message, authority: { ...message.authority, tenantId: "tnt_other" } }, other),
    ).rejects.toMatchObject({ code: "inventory-draft-conflict" });
    expect(await consumer.readReceipt(message.messageId, other)).toBeNull();
    expect(await consumer.readReceipt(message.messageId, draftContext)).toEqual(receipt);
    expect(await counts()).toEqual(before);
    for (const sql of [
      "UPDATE marketplace_inventory_draft_receipts SET intent_hash = repeat('b',64)",
      "DELETE FROM marketplace_inventory_draft_receipts",
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: "23514" });
  });

  it("issue-7169-c4-consumer-rollout: boot ledger precedes writers; mixed direct readers reconcile without duplicate drafts", async () => {
    const ledger = await pool.query(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
      ["20261019_marketplace_inventory_draft_receipts_v1"],
    );
    expect(ledger.rows).toHaveLength(1);
    const old = services(pool).listings;
    const message = draftMessage();
    const direct = await old.createBatchDraftListingFromInventorySnapshot(
      {
        ...directPortInput(),
      },
      draftContext,
    );
    const before = await counts();
    const receipt = await services(pool).inventoryDraftListingConsumer.accept(message, draftContext);
    expect(receipt).toMatchObject({
      source: "legacy-draft",
      listingId: direct.listingId,
      listingVersion: direct.version,
    });
    expect(await old.loadListingState(direct.listingId)).toMatchObject({ status: "draft" });
    expect(await counts()).toEqual({ ...before, receipts: 1 });
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    expect(await services(pool).inventoryDraftListingConsumer.accept(message, draftContext)).toEqual(receipt);
    expect((await counts())?.facts).toBe(before?.facts);
  });

  it("rejects old-invalid/partial schema instead of recording a successful consumer prerequisite", async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(marketplaceModule.schemaSql);
    await pool.query("CREATE TABLE marketplace_inventory_draft_receipts (message_id text PRIMARY KEY)");
    await expect(bootstrapContextDatabase(marketplaceModule, pool)).rejects.toThrow(
      "Invalid Inventory draft receipt schema.",
    );
    expect(
      (
        await pool.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          "20261019_marketplace_inventory_draft_receipts_v1",
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(
      services(pool).inventoryDraftListingConsumer.accept(draftMessage(), draftContext),
    ).rejects.toMatchObject({ code: "inventory-draft-unavailable" });
    expect((await pool.query("SELECT count(*)::int AS count FROM event_store_events")).rows[0]?.count).toBe(0);
  });

  it("rolls back a mid-migration crash and installs the ledger and immutable reader on the next boot", async () => {
    await resetMultiContextTestSchemas(pools);
    const interrupted: PgTransactionalPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            if (sql.includes("CREATE TRIGGER marketplace_inventory_draft_receipts_immutable"))
              throw new Error("synthetic migration death");
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    await expect(bootstrapContextDatabase(marketplaceModule, interrupted)).rejects.toThrow("synthetic migration death");
    expect(
      (await pool.query("SELECT to_regclass('marketplace_inventory_draft_receipts') AS name")).rows[0]?.name,
    ).toBeNull();
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    const receipt = await services(pool).inventoryDraftListingConsumer.accept(draftMessage(), draftContext);
    expect(receipt.listingId).toBe("lst_c4_1");
  });
});
