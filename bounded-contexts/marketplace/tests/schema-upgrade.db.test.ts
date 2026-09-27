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
import { createListingRequestExecutor } from "../features/listings/api/listing-request";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createListingTargetRuntime } from "../features/listings/api/target-runtime";
import { marketplaceListingCodec } from "../features/listings/domain/codec";
import { evolveMarketplaceListing, initialMarketplaceListingState } from "../features/listings/domain/domain";

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

  it("upgrades pre-target Listing storage and replays disabled target authority without native publication", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query("DROP TABLE marketplace_listing_target_prices, marketplace_listing_native_authority");
    await pool.query(`ALTER TABLE marketplace_listing_pages DROP COLUMN fee_stream_version,
      DROP COLUMN quantity_stream_version, DROP COLUMN purchase_limits_stream_version, DROP COLUMN evidence_requirements_stream_version,
      ALTER COLUMN marketplace_sales_fee_unit_amount SET NOT NULL,
      ALTER COLUMN seller_net_unit_amount SET NOT NULL, ALTER COLUMN fee_quote_fingerprint SET NOT NULL`);
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20260927_marketplace_listing_target_authority'",
    );
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    const ledger = await pool.query(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260927_marketplace_listing_target_authority'",
    );
    expect(ledger.rows).toHaveLength(1);
    expect(await readColumnNames(pool, "marketplace_listing_pages")).toContain("fee_stream_version");
    const project = buildMarketplaceListingProjectionHandlers(pool);
    const fact = (type: string, data: Record<string, unknown>, revision: number) =>
      buildTransportEvent(type, data, {
        id: `event_synthetic_${revision}`,
        streamId: "marketplace.listing-lst_synthetic",
        streamVersion: revision,
        audit: { forAccountId: "account_synthetic", performedByUserId: "user_synthetic" },
        timing: { occurredAt: "2026-09-27T12:00:00.000Z", recordedAt: "2026-09-27T12:00:00.000Z" },
      });
    const noFees = {
      marketplaceSalesFeeUnitAmount: null,
      sellerNetUnitAmount: null,
      shippingAllowancePercentageBps: 0,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: null,
      feeQuoteFingerprint: null,
      feeLocks: [],
    };
    const created = fact(
      "marketplace.listing.created",
      {
        ...noFees,
        schemaVersion: 2,
        publicationScope: "channel-only",
        nativeVisibility: "disabled",
        nativeFeeState: "not-enrolled",
        listingId: "lst_synthetic",
        accountId: "account_synthetic",
        inventoryItemId: "inventory_synthetic",
        catalogItemId: "catalog_synthetic",
        productId: "catalog_synthetic::",
        itemTitle: "Synthetic",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        storageLocationName: null,
        shipFromCode: null,
        shipFromAddress: {},
        priceAmount: "10.00",
        priceCurrencyCode: "CAD",
        quantityCap: 2,
        evidenceRequirements: null,
        evidence: [],
      },
      1,
    );
    await project[created.type]!(created);
    const targetFact = (connectionId: string, revision: number, priceCurrencyCode: string) =>
      fact(
        "marketplace.listing.target-price-accepted",
        {
          schemaVersion: 1,
          acceptedTargetPrice: {
            schemaVersion: 1,
            accountId: "account_synthetic",
            listingId: "lst_synthetic",
            target: { kind: "channel-connection", connectionId },
            priceAmount: "15.00",
            priceCurrencyCode,
            targetPriceRevision: revision,
            listingRevision: revision,
            acceptedByUserId: "user_synthetic",
            acceptedAt: "2026-09-27T12:00:00.000Z",
            sourceEventId: `event_synthetic_${revision}`,
            decision: {
              kind: "pricing-evaluation",
              evaluationId: "evaluation_synthetic",
              evaluationRevision: "1",
              policyId: "policy_synthetic",
              policyRevision: "1",
              goal: null,
              inputEvidenceRefs: [],
              curveEvidenceRefs: [],
              economicsSourceRevision: null,
              economicsOverrideRevision: null,
              basePriceRevision: 1,
              standingAuthorizationId: "authorization_synthetic",
              standingAuthorizationRevision: "1",
            },
            connectionAuthority: {
              connectionId,
              providerKey: "synthetic",
              environment: "sandbox",
              identityRevision: 1,
            },
          },
        },
        revision,
      );
    const events = [
      targetFact("connection_two", 3, "EUR"),
      targetFact("connection_one", 2, "CAD"),
      fact("marketplace.listing.paused", { reason: "seller" }, 6),
      fact("marketplace.listing.resumed", { pauseReason: "seller" }, 5),
      fact(
        "marketplace.listing.channel-activated",
        { connectionId: "connection_one", targetPriceRevision: 2, allocationRevision: 1 },
        4,
      ),
    ];
    for (const event of events) await project[event.type]!(event);
    await project[created.type]!(created);
    expect(
      (
        await pool.query(
          "SELECT status, marketplace_sales_fee_unit_amount, seller_net_unit_amount, fee_quote_fingerprint FROM marketplace_listing_pages",
        )
      ).rows,
    ).toEqual([
      {
        status: "paused",
        marketplace_sales_fee_unit_amount: null,
        seller_net_unit_amount: null,
        fee_quote_fingerprint: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT native_visibility, publication_revision, status, status_revision FROM marketplace_listing_native_authority",
        )
      ).rows,
    ).toEqual([{ native_visibility: "disabled", publication_revision: null, status: "paused", status_revision: 6 }]);
    const targets = await pool.query(
      "SELECT target_key, price_revision, activation_revision, accepted_price->>'priceCurrencyCode' AS currency FROM marketplace_listing_target_prices ORDER BY target_key",
    );
    expect(targets.rows).toEqual([
      { target_key: "channel-connection:connection_one", price_revision: 2, activation_revision: 4, currency: "CAD" },
      { target_key: "channel-connection:connection_two", price_revision: 3, activation_revision: 0, currency: "EUR" },
      { target_key: "native-marketplace", price_revision: 1, activation_revision: 0, currency: "CAD" },
    ]);
    await expect(
      project["marketplace.listing.target-price-accepted"]!(
        fact("marketplace.listing.target-price-accepted", { schemaVersion: 99 }, 7),
      ),
    ).rejects.toThrow();
    expect((await pool.query("SELECT listing_revision FROM marketplace_listing_native_authority")).rows).toEqual([
      { listing_revision: 6 },
    ]);
    expect(
      (await pool.query("SELECT generated_at IS NOT NULL AS generated FROM marketplace_listing_target_prices")).rows,
    ).toEqual([{ generated: true }, { generated: true }, { generated: true }]);
  });

  it("atomically rolls back Listing request results with owner writes and resolves concurrent complete-command retries", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    const execute = createListingRequestExecutor(store);
    const request = {
      accountId: context.audit.forAccountId,
      idempotencyKey: "listing-atomic-synthetic",
      command: { type: "AcceptListingTargetPrice", priceAmount: "10.00", priceCurrencyCode: "CAD" },
      context,
    };
    const prepare = (guardVersion: number) => async () => ({
      result: { listingId: "lst_atomic_synthetic", version: 1 },
      appends: [
        { streamId: "synthetic-authority", expectedVersion: guardVersion, context, events: [] },
        {
          streamId: "marketplace.listing-lst_atomic_synthetic",
          expectedVersion: 0,
          context,
          events: [{ eventType: "marketplace.listing.paused", payload: { reason: "seller" } }],
        },
      ],
    });
    await expect(execute({ ...request, prepare: prepare(1) })).rejects.toThrow();
    expect(await store.readAll()).toHaveLength(0);
    const [first, retry] = await Promise.all([
      execute({ ...request, prepare: prepare(0) }),
      execute({ ...request, prepare: prepare(0) }),
    ]);
    expect(retry).toEqual(first);
    expect(await store.readAll()).toHaveLength(2);
    await expect(
      execute({ ...request, command: { ...request.command, priceCurrencyCode: "USD" }, prepare: prepare(0) }),
    ).rejects.toThrow("different command");
    expect(await store.readAll()).toHaveLength(2);
  });

  it("runs canonical native batches and concurrent external acceptance through PostgreSQL with durable no-op and guard rollback", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    const accountId = context.audit.forAccountId;
    const guards = [{ streamId: "synthetic-listing-authority", expectedVersion: 0 }];
    for (const listingId of ["lst_one", "lst_two"]) {
      await store.appendToStream({
        streamId: `marketplace.listing-${listingId}`,
        expectedVersion: 0,
        context,
        events: [
          {
            eventType: "marketplace.listing.created",
            payload: {
              schemaVersion: 2,
              publicationScope: "channel-only",
              nativeVisibility: "disabled",
              nativeFeeState: "not-enrolled",
              listingId,
              accountId,
              inventoryItemId: "inv_synthetic",
              catalogItemId: "cat_synthetic",
              productId: "cat_synthetic::",
              itemTitle: "Synthetic",
              itemSubtitle: null,
              selectedOptions: [],
              productSummary: null,
              storageLocationName: null,
              shipFromCode: null,
              shipFromAddress: {},
              priceAmount: "10.00",
              priceCurrencyCode: "CAD",
              marketplaceSalesFeeUnitAmount: null,
              sellerNetUnitAmount: null,
              shippingAllowancePercentageBps: 0,
              termsScheduleId: null,
              termsAgreementId: null,
              termsResolvedAt: null,
              feeQuoteFingerprint: null,
              feeLocks: [],
              quantityCap: 1,
              evidenceRequirements: null,
              evidence: [],
            },
          },
        ],
      });
    }
    const runtime = createListingTargetRuntime({
      eventStore: store,
      authority: {
        authorizeManage: async () => ({ value: true, guards }),
        verifyDecision: async () => ({ value: true, guards }),
        resolveConnection: async ({ connectionId }) => ({
          value: { accountId, connectionId, providerKey: "synthetic", environment: "sandbox", identityRevision: 1 },
          guards,
        }),
        resolveAllocation: async () => ({ value: null, guards: [] }),
        authorizeResume: async () => ({ value: false, guards: [] }),
      },
      load: async (listingId) => {
        const events = await readCompleteStream(store, { streamId: `marketplace.listing-${listingId}` });
        return {
          state: events.reduce(
            (state, event) => evolveMarketplaceListing(state, marketplaceListingCodec.decode(event)),
            initialMarketplaceListingState,
          ),
          version: events.at(-1)?.streamVersion ?? 0,
        };
      },
      prepareNativeEnable: async () => {
        throw new Error("Synthetic fixture never enables native publication.");
      },
      capacityAppends: async () => [],
    });
    const updates = ["lst_one", "lst_two"].map((listingId) => ({
      listingId,
      priceAmount: "12.00",
      priceCurrencyCode: "CAD",
      expectedVersion: 1,
      idempotencyKey: `native-${listingId}`,
    }));
    expect(await runtime.applyNativePrices({ accountId, updates }, context)).toEqual(
      updates.map(({ listingId }) => ({ listingId, version: 2, outcome: "applied" })),
    );
    expect(await runtime.applyNativePrices({ accountId, updates }, context)).toEqual(
      updates.map(({ listingId }) => ({ listingId, version: 2, outcome: "applied" })),
    );
    const input = {
      accountId,
      listingId: "lst_one",
      target: { kind: "channel-connection" as const, connectionId: "con_synthetic" },
      priceAmount: "15.00",
      priceCurrencyCode: "EUR",
      expectedListingVersion: 2,
      expectedTargetPriceRevision: 0,
      idempotencyKey: "external-concurrent",
      decision: {
        kind: "pricing-evaluation" as const,
        evaluationId: "synthetic-evaluation",
        evaluationRevision: "1",
        policyId: "synthetic-policy",
        policyRevision: "1",
        goal: null,
        inputEvidenceRefs: [],
        curveEvidenceRefs: [],
        economicsSourceRevision: null,
        economicsOverrideRevision: null,
        basePriceRevision: 2,
        standingAuthorizationId: "synthetic-standing",
        standingAuthorizationRevision: "1",
      },
    };
    const [first, retry] = await Promise.all([
      runtime.acceptListingTargetPrice(input, context),
      runtime.acceptListingTargetPrice(input, context),
    ]);
    expect(first).toEqual(retry);
    await expect(runtime.acceptListingTargetPrice({ ...input, priceCurrencyCode: "USD" }, context)).rejects.toThrow(
      "different command",
    );
    const noOp = { ...updates[1]!, expectedVersion: 2, idempotencyKey: "durable-no-op" };
    const noOpResult = await runtime.applyNativePrices({ accountId, updates: [noOp] }, context);
    expect(noOpResult).toEqual([{ listingId: "lst_two", version: 2, outcome: "no_op" }]);
    await runtime.updateNativePrice(
      { ...noOp, accountId, priceAmount: "14.00", idempotencyKey: "later-native" },
      context,
    );
    expect(await runtime.applyNativePrices({ accountId, updates: [noOp] }, context)).toEqual(noOpResult);
    await store.appendToStream({
      streamId: guards[0]!.streamId,
      expectedVersion: 0,
      context,
      events: [{ eventType: "synthetic.authority.changed", payload: {} }],
    });
    const count = (await store.readAll()).length;
    expect(
      await runtime.applyNativePrices(
        {
          accountId,
          updates: [{ ...noOp, expectedVersion: 3, priceAmount: "16.00", idempotencyKey: "stale-authority" }],
        },
        context,
      ),
    ).toMatchObject([{ outcome: "conflict" }]);
    expect(await store.readAll()).toHaveLength(count);
    expect((await store.readStream({ streamId: "marketplace.listing-lst_two" })).at(-1)?.payload.priceAmount).toBe(
      "14.00",
    );
  });

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
