import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildMarketplaceListingProjectionHandlers } from "../features/listings/read-model/projection";
import { marketplaceListingSchemaMigrations } from "../features/listings/read-model/schema";
import { module as marketplaceModule } from "../index";
import { marketplaceBuyerOfferPolicySchemaMigrations } from "../features/offer-policy/read-model/schema";
import { buildBuyerOfferPolicyProjectionHandlers } from "../features/offer-policy/read-model/projection";
import { buyerOfferPolicyCodec } from "../features/offer-policy/domain/codec";
import { evolveBuyerOfferPolicy, initialBuyerOfferPolicyState } from "../features/offer-policy/domain/domain";
import { activate, context, fixture, seedOffer, terms } from "../features/offer-policy/tests/fixtures";
import { createBuyerOfferPolicyRuntime } from "../features/offer-policy/api/runtime";
import { toTransportEvent } from "@chase-sets/event-core/transport";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

async function readColumnNames(pool: PgTransactionalPool, tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

describeDb("marketplace schema upgrades", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["marketplace"], "marketplace_schema_upgrade");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => resetMultiContextTestSchemas(pools));
  afterAll(async () => closeMultiContextTestPools(pools));

  it("serializes competing PostgreSQL consent bundles without partial policy or membership writes", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db: pool,
      enforcement: { assertInstalled() {} },
    });
    await seedOffer(store);
    await seedOffer(store, "off_two");
    const previews = [];
    for (const policyId of ["bop_one", "bop_two"]) {
      await runtime.execute(
        policyId,
        { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
        context,
      );
      previews.push(
        await runtime.execute(
          policyId,
          {
            type: "PreviewBuyerOfferPolicy",
            expectedVersion: 1,
            operationId: "preview",
            terms: { ...terms, offers: [...terms.offers, { ...terms.offers[0]!, offerId: "off_two" }] },
          },
          context,
        ),
      );
    }
    const results = await Promise.allSettled(
      previews.map((p) =>
        runtime.execute(
          p.policyId!,
          {
            type: "AuthorizeBuyerOfferPolicy",
            expectedVersion: p.version,
            operationId: "authorize",
            previewId: p.preview!.previewId,
            consent: true,
          },
          context,
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? "bop_one" : "bop_two";
    const loser = winner === "bop_one" ? "bop_two" : "bop_one";
    expect((await runtime.get(winner, "acc_buyer")).status).toBe("active");
    expect((await runtime.get(loser, "acc_buyer")).status).toBe("draft");
    for (const id of ["off_one", "off_two"]) {
      const events = await store.readStream({ streamId: `marketplace.offer-${id}` });
      expect(events).toHaveLength(2);
      expect(events[1]!.payload.policyId).toBe(winner);
    }
  });

  it("installs policy tables on existing schemas via the ledger and replays private authority without resetting it", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query("DROP TABLE marketplace_buyer_offer_policy_pages, marketplace_buyer_offer_policy_memberships");
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260927_marketplace_buyer_offer_policy'",
    );
    for (const statement of marketplaceBuyerOfferPolicySchemaMigrations[0]!.statements) await pool.query(statement);
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    const ledger = await pool.query(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260927_marketplace_buyer_offer_policy'",
    );
    expect(ledger.rows).toHaveLength(1);
    expect(await readColumnNames(pool, "marketplace_buyer_offer_policy_pages")).toEqual([
      "buyer_account_id",
      "last_stream_version",
      "policy_id",
      "state",
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE 'marketplace_buyer_offer_policy_%'",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "marketplace_buyer_offer_policy_account_idx",
        "marketplace_buyer_offer_policy_membership_idx",
      ]),
    );
    const { runtime, store } = await fixture();
    await activate(runtime);
    await runtime.execute(
      "bop_one",
      {
        type: "StopBuyerOfferPolicy",
        expectedVersion: 3,
        operationId: "stop",
      },
      context,
    );
    const events = await store.readAll();
    const handlers = buildBuyerOfferPolicyProjectionHandlers(pool);
    for (const event of events) await handlers[event.eventType]?.(toTransportEvent(event));
    const state = (await store.readStream({ streamId: "marketplace.offer-policy-bop_one" }))
      .map(buyerOfferPolicyCodec.decode)
      .reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState);
    expect(
      (await pool.query("SELECT state FROM marketplace_buyer_offer_policy_pages WHERE policy_id = 'bop_one'")).rows,
    ).toEqual([{ state }]);
    for (const event of [...events].reverse()) await handlers[event.eventType]?.(toTransportEvent(event));
    expect(
      (await pool.query("SELECT state FROM marketplace_buyer_offer_policy_pages WHERE policy_id = 'bop_one'")).rows,
    ).toEqual([{ state }]);
    expect(
      (await pool.query("SELECT offer_id, policy_id FROM marketplace_buyer_offer_policy_memberships")).rows,
    ).toEqual([{ offer_id: "off_one", policy_id: "bop_one" }]);
    await expect(
      pool.query(
        `INSERT INTO marketplace_buyer_offer_policy_memberships (offer_id, policy_id, buyer_account_id)
       VALUES ('off_one', 'bop_other', 'acc_buyer')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("records the review-hold stream-version migration once across fresh boots", async () => {
    const pool = pools.marketplace;

    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);

    expect(await readColumnNames(pool, "marketplace_review_hold_pages")).toContain("last_stream_version");
    const migration = await pool.query<{ applied_count: string }>(
      `SELECT COUNT(*) AS applied_count
       FROM bounded_context_schema_migrations
       WHERE migration_id = '20260720_marketplace_review_hold_stream_version'`,
    );
    expect(migration.rows).toEqual([{ applied_count: "1" }]);
  });

  it("adds nullable price currency without backfill and fences repaired pairs by listing stream version", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(
      `INSERT INTO marketplace_listing_pages (
         listing_id, account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         ship_from_address, price_amount, marketplace_sales_fee_unit_amount, seller_net_unit_amount,
         fee_quote_fingerprint, quantity_cap
       ) VALUES ('lst_legacy_currency', 'acc_seller', 'inv_legacy', 'cat_legacy', 'cat_legacy::',
         '{}'::jsonb, 20.00, 1.00, 19.00, 'fee_legacy', 1)`,
    );
    await pool.query(`DELETE FROM bounded_context_schema_migrations
      WHERE migration_id = '20260907_marketplace_listing_price_currency'`);
    await pool.query(
      `ALTER TABLE marketplace_listing_pages DROP COLUMN price_currency_code, DROP COLUMN listing_stream_version`,
    );
    await pool.query(`ALTER TABLE marketplace_anonymous_listing_draft_intents DROP COLUMN price_currency_code`);

    await bootstrapContextDatabase(marketplaceModule, pool);

    const legacy = await pool.query<{
      price_amount: string;
      price_currency_code: string | null;
      listing_stream_version: number | null;
    }>(
      `SELECT price_amount::text, price_currency_code, listing_stream_version
       FROM marketplace_listing_pages
       WHERE listing_id = 'lst_legacy_currency'`,
    );
    expect(legacy.rows).toEqual([{ price_amount: "20.00", price_currency_code: null, listing_stream_version: null }]);

    const migration = marketplaceListingSchemaMigrations.find(
      (candidate) => candidate.migrationId === "20260907_marketplace_listing_price_currency",
    );
    expect(migration).toBeDefined();
    expect(migration!.statements.join("\n")).not.toMatch(/\bUPDATE\b/i);

    const handlers = buildMarketplaceListingProjectionHandlers(pool);
    const pair = {
      priceAmount: "20.00",
      priceCurrencyCode: "EUR",
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "19.00",
      shippingAllowancePercentageBps: 500,
      termsScheduleId: "cts_default",
      termsAgreementId: null,
      termsResolvedAt: "2026-09-07T05:00:00.000Z",
      feeQuoteFingerprint: "fee_eur",
      feeLocks: [],
    };
    await handlers["marketplace.listing.price-updated"]!(
      buildTransportEvent("marketplace.listing.price-updated", pair, {
        streamId: "marketplace.listing-lst_legacy_currency",
        streamVersion: 2,
      }),
    );
    await handlers["marketplace.listing.price-updated"]!(
      buildTransportEvent(
        "marketplace.listing.price-updated",
        { ...pair, priceAmount: "10.00", priceCurrencyCode: null },
        { streamId: "marketplace.listing-lst_legacy_currency", streamVersion: 1 },
      ),
    );

    const repaired = await pool.query<{
      price_amount: string;
      price_currency_code: string | null;
      listing_stream_version: number | null;
    }>(
      `SELECT price_amount::text, price_currency_code, listing_stream_version
       FROM marketplace_listing_pages
       WHERE listing_id = 'lst_legacy_currency'`,
    );
    expect(repaired.rows).toEqual([{ price_amount: "20.00", price_currency_code: "EUR", listing_stream_version: 2 }]);
  });

  it("converges deployed seller-metrics tables to the complete fresh schema", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const freshSourceColumns = await readColumnNames(pool, "marketplace_seller_metrics_support_request_sources");
    const freshSummaryColumns = await readColumnNames(pool, "marketplace_seller_metrics_summary_pages");

    await pool.query("ALTER TABLE marketplace_seller_metrics_support_request_sources DROP COLUMN responsibility");
    await pool.query("ALTER TABLE marketplace_seller_metrics_summary_pages DROP COLUMN missing_responsibility_count");
    await pool.query(`DELETE FROM bounded_context_schema_migrations
      WHERE migration_id IN (
        '20260718_marketplace_seller_metrics_support_responsibility',
        '20260718_marketplace_seller_metrics_missing_responsibility_count'
      )`);
    await bootstrapContextDatabase(marketplaceModule, pool);

    expect(await readColumnNames(pool, "marketplace_seller_metrics_support_request_sources")).toEqual(
      freshSourceColumns,
    );
    expect(await readColumnNames(pool, "marketplace_seller_metrics_summary_pages")).toEqual(freshSummaryColumns);
    const migrations = await pool.query<{ migration_id: string }>(`SELECT migration_id
      FROM bounded_context_schema_migrations
      WHERE migration_id IN (
        '20260718_marketplace_seller_metrics_support_responsibility',
        '20260718_marketplace_seller_metrics_missing_responsibility_count'
      )
      ORDER BY migration_id`);
    expect(migrations.rows).toEqual([
      { migration_id: "20260718_marketplace_seller_metrics_missing_responsibility_count" },
      { migration_id: "20260718_marketplace_seller_metrics_support_responsibility" },
    ]);
  });
});
