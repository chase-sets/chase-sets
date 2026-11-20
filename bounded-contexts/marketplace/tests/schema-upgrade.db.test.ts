import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, createSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import { buildEventSubscriptionsFromManifest } from "@chase-sets/bounded-context-module";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildMarketplaceListingProjectionHandlers } from "../features/listings/read-model/projection";
import { marketplaceListingSchemaMigrations } from "../features/listings/read-model/schema";
import { module as marketplaceModule } from "../index";
import { marketplaceBuyerOfferPolicySchemaMigrations } from "../features/offer-policy/read-model/schema";
import { buildBuyerOfferPolicyProjectionHandlers } from "../features/offer-policy/read-model/projection";
import { buyerOfferPolicyCodec } from "../features/offer-policy/domain/codec";
import {
  evolveBuyerOfferPolicy,
  initialBuyerOfferPolicyState,
  type BuyerOfferPolicyState,
  type BuyerOfferPolicyPreview,
} from "../features/offer-policy/domain/domain";
import { activate, context, fixture, seedOffer, terms } from "../features/offer-policy/tests/fixtures";
import { createBuyerOfferPolicyRuntime } from "../features/offer-policy/api/runtime";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { managedFixture } from "../features/offers/tests/managed-fixture";
import { buildManagedOfferProjectionHandlers } from "../features/offers/read-model/managed-projection";
import { buildMarketplaceOfferProjectionHandlers } from "../features/offers/read-model/projection";
import { getOfferMatch, listOfferMatches } from "../features/offers/read-model/queries";
import { createMarketplaceListingRuntime } from "../features/listings/api/runtime";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import marketplaceManifest from "../context.json" with { type: "json" };
import type { CreateListingCommand } from "../features/listings/domain/domain";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type HistoricalTerms = typeof terms & { itemCommitmentAllowance?: string };
type HistoricalPolicyState = Omit<BuyerOfferPolicyState, "authority" | "preview"> & {
  consumedItemAmount?: string;
  authority: HistoricalTerms | null;
  preview: (Omit<BuyerOfferPolicyPreview, "terms"> & { terms: HistoricalTerms }) | null;
};
type PolicyProjectionRow = { policy_id: string; state: HistoricalPolicyState; last_stream_version: number };

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

  it("ledgers fresh and amount-only supply upgrades without inventing acquisition currency", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    expect(await readColumnNames(pool, "marketplace_supply_items")).toContain("acquisition_cost_currency_code");
    const migrationId = "20261028_marketplace_supply_acquisition_cost_currency";
    expect(
      (
        await pool.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migrationId }]);
    await pool.query(`ALTER TABLE marketplace_supply_items DROP COLUMN acquisition_cost_currency_code;
      INSERT INTO marketplace_supply_items (item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity, acquisition_cost_amount)
      VALUES ('inv_amount_only', 'acc_legacy', 'cat_legacy', 'cat_legacy::', 'loc_legacy', 2, 5.25)`);
    await pool.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [migrationId]);
    // Execute the registered migration independently: boot SQL must not mask a missing ledger statement.
    const migration = marketplaceModule.schemaMigrations?.find((entry) => entry.migrationId === migrationId);
    expect(migration).toBeDefined();
    for (const statement of migration!.statements ?? []) await pool.query(statement);
    expect(
      (
        await pool.query(
          "SELECT acquisition_cost_amount::text, acquisition_cost_currency_code FROM marketplace_supply_items WHERE item_id = 'inv_amount_only'",
        )
      ).rows,
    ).toEqual([{ acquisition_cost_amount: "5.25", acquisition_cost_currency_code: null }]);
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    expect(
      (
        await pool.query(
          "SELECT acquisition_cost_amount::text, acquisition_cost_currency_code FROM marketplace_supply_items WHERE item_id = 'inv_amount_only'",
        )
      ).rows,
    ).toEqual([{ acquisition_cost_amount: "5.25", acquisition_cost_currency_code: null }]);
    expect(
      (
        await pool.query("SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1", [
          migrationId,
        ])
      ).rows,
    ).toEqual([{ migration_id: migrationId }]);
  });

  it("upgrades native fee constraints and projects real channel-only creation, photos and withdrawal without poison", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(`ALTER TABLE marketplace_listing_pages
      ALTER COLUMN marketplace_sales_fee_unit_amount SET NOT NULL,
      ALTER COLUMN seller_net_unit_amount SET NOT NULL,
      ALTER COLUMN fee_quote_fingerprint SET NOT NULL;
      DELETE FROM bounded_context_schema_migrations
      WHERE migration_id = '20261023_marketplace_listing_channel_only_nullable_fees'`);
    const store = createPostgresEventStore({ pool });
    const runtime = createMarketplaceListingRuntime({
      db: pool,
      eventStore: store,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      commercialTermsResolver: {} as never,
    });
    const create: CreateListingCommand = {
      type: "CreateListing",
      publicationScope: "channel-only",
      listingId: "lst_channel_reader" as never,
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_card",
      catalogItemId: "cat_card",
      productId: "cat_card::" as never,
      itemTitle: "Card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      storageLocationName: null,
      shipFromCode: "US",
      shipFromAddress: {
        name: "Seller",
        company: null,
        line1: "1 Main",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        phone: null,
        email: null,
      },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      feeLock: null,
      quantityCap: 1,
      evidenceRequirements: null,
    };
    const streamId = `marketplace.listing-${create.listingId}`;
    await runtime.commandHandler({ streamId, command: create, context });
    const handlers = buildMarketplaceListingProjectionHandlers(pool);
    const [created] = await store.readStream({ streamId });
    await expect(handlers["marketplace.listing.created"]!(toTransportEvent(created!))).rejects.toMatchObject({
      code: "23502",
    });
    await bootstrapContextDatabase(marketplaceModule, pool);
    const [subscription] = buildEventSubscriptionsFromManifest({
      contextName: "marketplace",
      manifest: marketplaceManifest,
      handlers: { "marketplace.marketplace-listing-projection": () => handlers },
    });
    const runner = createSubscriptionRunner("marketplace", pool, pool, subscription!);
    const project = async () => {
      while ((await runner.runOnce()).processed > 0) {
        /* Drain the registered subscription. */
      }
      expect(await runner.refreshStatus()).toMatchObject({
        blockedStreamCount: 0,
        poisonEventCount: 0,
        lastError: null,
      });
    };
    const read = async (listingId: string) =>
      (
        await pool.query(
          `SELECT status, marketplace_sales_fee_unit_amount::text, seller_net_unit_amount::text,
       fee_quote_fingerprint, terms_schedule_id, terms_agreement_id, terms_resolved_at,
       fee_locks, shipping_allowance_percentage_bps, evidence FROM marketplace_listing_pages WHERE listing_id = $1`,
          [listingId],
        )
      ).rows[0];
    await project();
    const absentFees = {
      marketplace_sales_fee_unit_amount: null,
      seller_net_unit_amount: null,
      fee_quote_fingerprint: null,
      terms_schedule_id: null,
      terms_agreement_id: null,
      terms_resolved_at: null,
      fee_locks: [],
      shipping_allowance_percentage_bps: 0,
    };
    expect(await read(create.listingId)).toMatchObject({ ...absentFees, status: "draft", evidence: [] });
    const asset = {
      role: "source" as const,
      width: 1200,
      height: 1600,
      density: null,
      mediaType: "image/webp" as const,
      storageKey: "photos/reader",
      publicUrl: "https://example.test/reader.webp",
      byteSize: 100,
      generatedAt: "2026-10-23T00:00:00.000Z",
    };
    await runtime.commandHandler({
      streamId,
      context,
      command: {
        type: "AddListingPhotos",
        photos: [
          {
            photoId: "lpho_reader",
            sortOrder: 0,
            uploadedAt: asset.generatedAt,
            assetSet: { kind: "listing-photo", sourceHash: "0123456789abcdef", source: asset, variants: [] },
          },
        ],
      },
    });
    await project();
    expect(await read(create.listingId)).toMatchObject({
      ...absentFees,
      status: "draft",
      evidence: [{ photoId: "lpho_reader" }],
    });
    await runtime.commandHandler({ streamId, context, command: { type: "WithdrawListing" } });
    await project();
    expect(await read(create.listingId)).toMatchObject({
      ...absentFees,
      status: "withdrawn",
      evidence: [{ photoId: "lpho_reader" }],
    });
    const native = {
      ...create,
      listingId: "lst_native_reader" as never,
      publicationScope: "native" as const,
      feeLock: {
        unitCount: 1,
        terms: {
          marketplaceSalesFeePercentageBps: 500,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: null,
          shippingAllowancePercentageBps: 500,
          termsScheduleId: "cts_native",
          termsAgreementId: null,
          termsResolvedAt: "2026-10-23T00:00:00.000Z",
        },
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        feeQuoteFingerprint: "native-reader",
      },
      evidenceRequirements: {
        policyId: null,
        policyVersion: null,
        policyHash: "sha256:policy",
        evaluatedAt: "2026-10-23T00:00:00.000Z",
        requirementHash: "sha256:requirements",
        matchedRuleIds: [],
        explanationCodes: [],
        requirements: {
          minimumPhotoCount: 0,
          requiredSlots: [],
          sellerTrustRequirements: [],
          buyerAcknowledgment: "none" as const,
        },
      },
    } satisfies CreateListingCommand;
    await runtime.commandHandler({ streamId: `marketplace.listing-${native.listingId}`, command: native, context });
    await project();
    expect(await read(native.listingId)).toMatchObject({
      status: "draft",
      marketplace_sales_fee_unit_amount: "0.50",
      seller_net_unit_amount: "9.50",
      fee_quote_fingerprint: "native-reader",
      terms_schedule_id: "cts_native",
      fee_locks: [native.feeLock],
      shipping_allowance_percentage_bps: 500,
    });
    expect((await pool.query("SELECT * FROM event_projection_poison_events")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM event_projection_blocked_streams")).rows).toEqual([]);
  });

  it.each(["amount-only", "price-pair"] as const)(
    "replays prior-schema %s Listing creation as native without rewriting stored payloads",
    async (schema) => {
      const pool = pools.marketplace;
      await bootstrapContextDatabase(marketplaceModule, pool);
      const store = createPostgresEventStore({ pool });
      const payload = {
        listingId: "lst_prior_schema",
        accountId: "acc_seller",
        inventoryItemId: "inv_card",
        catalogItemId: "cat_card",
        productId: "cat_card::",
        itemLanguageCode: "en",
        itemTitle: "Card",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        productMeasureSnapshot: null,
        gradedCard: null,
        storageLocationName: null,
        shipFromCode: "US",
        shipFromAddress: null,
        priceAmount: "10.00",
        ...(schema === "price-pair" ? { priceCurrencyCode: "USD" } : {}),
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "cts_native",
        termsAgreementId: null,
        termsResolvedAt: "2026-01-01T00:00:00.000Z",
        feeQuoteFingerprint: "prior-schema-native",
        feeLocks: [],
        quantityCap: 1,
        purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
        evidenceRequirements: null,
        evidence: [],
      };
      const streamId = "marketplace.listing-lst_prior_schema";
      await store.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [{ eventType: "marketplace.listing.created", payload }],
      });
      const runtime = createMarketplaceListingRuntime({
        db: pool,
        eventStore: store,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
        commercialTermsResolver: {} as never,
      });
      expect(await runtime.loadListingState("lst_prior_schema")).toMatchObject({
        publicationScope: "native",
        nativeVisibility: "enabled",
        nativeFeeState: "enrolled",
        status: "draft",
        priceAmount: "10.00",
        priceCurrencyCode: schema === "price-pair" ? "USD" : null,
        feeQuoteFingerprint: "prior-schema-native",
      });
      expect((await store.readStream({ streamId }))[0]?.payload).toEqual(payload);
    },
  );

  it("keeps fixed demand actionable and managed Match queries closed across target, held, pause, projection lag and stop", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(
      `INSERT INTO marketplace_account_pages (account_id, display_name, status)
       VALUES ('acc_buyer', 'Buyer', 'active'),
              ('acc_one', 'Seller One', 'active'),
              ('acc_two', 'Seller Two', 'active')`,
    );
    const store = createPostgresEventStore({ pool });
    let amount = "10.00";
    let held = false;
    const freshUntil = new Date(Date.now() + 3600000).toISOString();
    const f = await managedFixture(store, {
      evaluateTargets: async (requests) =>
        requests.map((request) => {
          const evidence = { policyRevision: request.policyRevision, marketPrice: { amount, freshUntil } };
          return held
            ? { status: "held" as const, reason: "market-price-unavailable", evidence }
            : { status: "target" as const, unitItemAmount: amount, evidence };
        }),
    });
    await seedOffer(store, "off_fixed");
    const handlers = [
      buildMarketplaceOfferProjectionHandlers(pool),
      buildMarketplaceListingProjectionHandlers(pool),
      buildBuyerOfferPolicyProjectionHandlers(pool),
      buildManagedOfferProjectionHandlers(pool),
    ];
    const project = async () => {
      for (const event of await store.readAll())
        for (const map of handlers) if (map[event.eventType]) await map[event.eventType]!(toTransportEvent(event));
    };
    await project();
    await pool.query(
      "INSERT INTO marketplace_supply_items (item_id, account_id, catalog_catalog_item_id, product_id, storage_location_id, total_quantity) VALUES ('inv_one','acc_one','cat_one','cat_one::','loc_one',100)",
    );
    expect(await getOfferMatch(pool, "off_fixed", "acc_one")).toMatchObject({
      can_fulfill: true,
      managed_status: null,
    });
    expect(await getOfferMatch(pool, "off_one", "acc_one")).toMatchObject({ can_fulfill: true, managed_status: null });
    amount = "12.00";
    const acceptance = await f.acceptance();
    await expect(
      f.offers.acceptOffer(acceptance, {
        ...context,
        audit: { ...context.audit, forAccountId: acceptance.sellerAccountId },
      }),
    ).rejects.toMatchObject({
      code: "managed_offer_refresh_required",
    });
    held = true;
    await f.offers.applyManagedOffer("off_one" as never, "held", context);
    await project();
    expect(await getOfferMatch(pool, "off_one", "acc_one")).toMatchObject({
      can_fulfill: false,
      managed_status: "held",
    });
    const paused = await f.policies.execute(
      "bop_one",
      {
        attemptId: String("pause").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: 3,
        operationId: "pause",
      },
      context,
    );
    expect(await getOfferMatch(pool, "off_one", "acc_one")).toMatchObject({
      can_fulfill: false,
      managed_status: "refresh_required",
    });
    await project();
    expect(await getOfferMatch(pool, "off_one", "acc_one")).toMatchObject({
      can_fulfill: false,
      managed_status: "unavailable",
    });
    await f.policies.execute(
      "bop_one",
      {
        attemptId: String("stop").padEnd(22, "_"),
        type: "StopBuyerOfferPolicy",
        expectedVersion: paused.version,
        operationId: "stop",
      },
      context,
    );
    await project();
    const matches = await listOfferMatches(pool, { sellerAccountId: "acc_one", canFulfill: true });
    expect(matches.items.map((offer) => offer.offer_id)).toEqual(["off_fixed"]);
    expect(await getOfferMatch(pool, "off_one", "acc_one")).toMatchObject({
      can_fulfill: false,
      managed_status: "unavailable",
    });
  });

  it("rolls back a failed acceptance, then races identical retries without duplicate events", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    const f = await managedFixture(store);
    const params = await f.acceptance();
    const before = await store.readAll();
    await pool.query(`CREATE FUNCTION reject_managed_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'marketplace.offer.accepted' THEN
          RAISE EXCEPTION 'injected Offer append failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_managed_acceptance BEFORE INSERT ON event_store_events
      FOR EACH ROW EXECUTE FUNCTION reject_managed_acceptance();`);
    await expect(
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ).rejects.toMatchObject({
      code: "infrastructure_failure",
      details: { cause: "injected Offer append failure" },
    });
    expect(await store.readAll()).toEqual(before);
    expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(3);
    await pool.query(
      "DROP TRIGGER reject_managed_acceptance ON event_store_events; DROP FUNCTION reject_managed_acceptance();",
    );
    const results = await Promise.all([
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ]);
    expect(results[0]).toEqual(results[1]);
    const events = await store.readAll();
    expect(events.slice(before.length).map((event) => event.eventType)).toEqual([
      "marketplace.offer.accepted",
      "marketplace.listing.evidence-requirements-refreshed",
      "marketplace.listing.offer-commitment-recorded",
      "marketplace.seller-listing-availability.commitment-checked",
      "marketplace.mutation-attempt.completed",
    ]);
    const project = buildBuyerOfferPolicyProjectionHandlers(pool);
    for (const event of events) if (project[event.eventType]) await project[event.eventType]!(toTransportEvent(event));
    for (const event of events) if (project[event.eventType]) await project[event.eventType]!(toTransportEvent(event));
    const projection = await pool.query<{ state: object }>(
      "SELECT state FROM marketplace_buyer_offer_policy_pages WHERE policy_id = 'bop_one'",
    );
    expect(projection.rows[0]!.state).not.toHaveProperty("consumedItemAmount");
  });

  it("commits both real DB acceptances across different Offers, Listings and sellers sharing one policy", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await managedFixture({
      ...store,
      appendToStreams: async (inputs) => {
        if (inputs.some((input) => input.events.some((event) => event.eventType === "marketplace.offer.accepted"))) {
          if (++arrivals === 2) release();
          await barrier;
        }
        return store.appendToStreams!(inputs);
      },
    });
    const params = await Promise.all([f.acceptance("one"), f.acceptance("two")]);
    const result = await Promise.allSettled(
      params.map((p) =>
        f.offers.acceptOffer(p, { ...context, audit: { ...context.audit, forAccountId: p.sellerAccountId } }),
      ),
    );
    expect(arrivals).toBe(2);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const events = await f.store.readAll();
    for (const type of [
      "marketplace.offer.accepted",
      "marketplace.listing.offer-commitment-recorded",
      "marketplace.seller-listing-availability.commitment-checked",
    ])
      expect(events.filter((event) => event.eventType === type)).toHaveLength(2);
    expect(events.filter((event) => event.eventType === "marketplace.offer-policy.commitment-consumed")).toEqual([]);
    expect(
      events
        .filter((event) => event.eventType === "marketplace.offer.accepted")
        .map((event) => event.payload.offerId)
        .sort(),
    ).toEqual(["off_one", "off_two"]);
  });

  it.each([false, true])(
    "accepts historical 10.00 authority consumed to 9.00 without a debit; concurrent Pause=%s",
    async (racePause) => {
      const pool = pools.marketplace;
      await bootstrapContextDatabase(marketplaceModule, pool);
      const store = createPostgresEventStore({ pool });
      let pauseAtAppend = false;
      let pause!: () => Promise<unknown>;
      const legacyStore: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (
            pauseAtAppend &&
            inputs.some((input) => input.events.some((event) => event.eventType === "marketplace.offer.accepted"))
          ) {
            pauseAtAppend = false;
            await pause();
          }
          return store.appendToStreams!(
            inputs.map((input) => ({
              ...input,
              events: input.events.map((event) =>
                ["marketplace.offer-policy.previewed", "marketplace.offer-policy.authorized"].includes(event.eventType)
                  ? {
                      ...event,
                      payload: {
                        ...event.payload,
                        terms: { ...(event.payload.terms as object), itemCommitmentAllowance: "10.00" },
                      },
                    }
                  : event,
              ),
            })),
          );
        },
      };
      const f = await managedFixture(legacyStore);
      const authorized = (await store.readStream({ streamId: "marketplace.offer-policy-bop_one" })).at(-1)!;
      const {
        previewId: _previewId,
        policyVersion: _policyVersion,
        terms: _terms,
        outcomes: _outcomes,
        revision: _revision,
        consentedAt: _consentedAt,
        ...audit
      } = authorized.payload;
      await store.appendToStream({
        streamId: authorized.streamId,
        expectedVersion: 3,
        context,
        events: [
          {
            eventType: "marketplace.offer-policy.commitment-consumed",
            payload: {
              ...audit,
              operationId: "historical_acceptance",
              offerId: "off_historical",
              offerVersion: 2,
              revision: 1,
              currency: "USD",
              unitItemAmount: "9.00",
              quantity: 1,
              itemAmount: "9.00",
              consumedItemAmount: "9.00",
              evaluationEvidence: {},
            },
          },
        ],
      });
      f.setTarget({ status: "target", unitItemAmount: "5.00", evidence: {} });
      await f.offers.applyManagedOffer("off_one" as never, "five_dollars", context);
      const params = await f.acceptance();
      pause = () =>
        f.policies.execute(
          "bop_one",
          {
            attemptId: String("racing_pause").padEnd(22, "_"),
            type: "PauseBuyerOfferPolicy",
            expectedVersion: 4,
            operationId: "racing_pause",
          },
          context,
        );
      const sellerContext = { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } };
      if (racePause) {
        pauseAtAppend = true;
        await expect(f.offers.acceptOffer(params, sellerContext)).rejects.toMatchObject({
          code: "managed_offer_conflict",
        });
        expect((await store.readAll()).filter((event) => event.eventType === "marketplace.offer.accepted")).toEqual([]);
        expect((await f.policies.get("bop_one", "acc_buyer")).status).toBe("paused");
      } else {
        await f.offers.acceptOffer(params, sellerContext);
        expect((await store.readStream({ streamId: "marketplace.offer-off_one" })).at(-1)).toMatchObject({
          eventType: "marketplace.offer.accepted",
          payload: { priceAmount: "5.00" },
        });
      }
      const policyEvents = await store.readStream({ streamId: authorized.streamId });
      expect(policyEvents).toHaveLength(racePause ? 5 : 4);
      expect(
        policyEvents.filter((event) => event.eventType === "marketplace.offer-policy.commitment-consumed"),
      ).toHaveLength(1);
    },
  );

  it("removes stored allowance keys once without commands or membership changes and rebuilds clean history", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const { runtime, store } = await fixture();
    await activate(runtime);
    const audit = (await store.readStream({ streamId: "marketplace.offer-policy-bop_one" }))[0]!.payload;
    await store.appendToStream({
      streamId: "marketplace.offer-policy-bop_one",
      expectedVersion: 3,
      context,
      events: [
        {
          eventType: "marketplace.offer-policy.previewed",
          payload: {
            ...audit,
            operationId: "historical_preview",
            previewId: "b".repeat(64),
            policyVersion: 3,
            terms: { ...terms, offers: [{ ...terms.offers[0]!, offerVersion: 2 }] },
          },
        },
        {
          eventType: "marketplace.offer-policy.commitment-consumed",
          payload: {
            ...audit,
            operationId: "historical_accept",
            offerId: "off_historical",
            offerVersion: 2,
            revision: 1,
            currency: "USD",
            unitItemAmount: "9.00",
            quantity: 1,
            itemAmount: "9.00",
            consumedItemAmount: "9.00",
            evaluationEvidence: {},
          },
        },
      ],
    });
    const recorded = (await store.readAll()).map((event) =>
      ["marketplace.offer-policy.previewed", "marketplace.offer-policy.authorized"].includes(event.eventType)
        ? {
            ...event,
            payload: {
              ...event.payload,
              terms: { ...(event.payload.terms as object), itemCommitmentAllowance: "10.00" },
            },
          }
        : event,
    );
    const handlers = buildBuyerOfferPolicyProjectionHandlers(pool);
    for (const event of recorded) await handlers[event.eventType]?.(toTransportEvent(event));
    const clean = (
      await pool.query<PolicyProjectionRow>(
        "SELECT state, last_stream_version FROM marketplace_buyer_offer_policy_pages WHERE policy_id = 'bop_one'",
      )
    ).rows[0]!;
    const membership = (await pool.query("SELECT * FROM marketplace_buyer_offer_policy_memberships ORDER BY offer_id"))
      .rows;
    for (const [index, status] of ["draft", "active", "paused", "stopped"].entries()) {
      const state = {
        ...clean.state,
        policyId: `bop_upgrade_${index}`,
        status,
        consumedItemAmount: "9.00",
        authority: status === "draft" ? null : { ...terms, itemCommitmentAllowance: "10.00" },
        preview:
          status === "draft" || status === "paused"
            ? { previewId: "b".repeat(64), policyVersion: 1, terms: { ...terms, itemCommitmentAllowance: "10.00" } }
            : null,
      };
      await pool.query(
        "INSERT INTO marketplace_buyer_offer_policy_pages (policy_id, buyer_account_id, state, last_stream_version) VALUES ($1, 'acc_buyer', $2::jsonb, 3)",
        [state.policyId, JSON.stringify(state)],
      );
    }
    const before = (
      await pool.query<PolicyProjectionRow>(
        "SELECT policy_id, state, last_stream_version FROM marketplace_buyer_offer_policy_pages ORDER BY policy_id",
      )
    ).rows;
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261013_marketplace_retire_item_commitment_allowance'",
    );
    await bootstrapContextDatabase(marketplaceModule, pool);
    await bootstrapContextDatabase(marketplaceModule, pool);
    const after = (
      await pool.query<PolicyProjectionRow>(
        "SELECT policy_id, state, last_stream_version FROM marketplace_buyer_offer_policy_pages ORDER BY policy_id",
      )
    ).rows;
    expect(after).toEqual(
      before.map((row) => {
        const { consumedItemAmount: _consumed, ...state } = row.state;
        if (state.authority) {
          const { itemCommitmentAllowance: _allowance, ...authority } = state.authority;
          state.authority = authority;
        }
        if (state.preview) {
          const { itemCommitmentAllowance: _allowance, ...previewTerms } = state.preview.terms;
          state.preview = { ...state.preview, terms: previewTerms };
        }
        return { ...row, state };
      }),
    );
    expect(
      (await pool.query("SELECT * FROM marketplace_buyer_offer_policy_memberships ORDER BY offer_id")).rows,
    ).toEqual(membership);
    expect(
      (
        await pool.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20261013_marketplace_retire_item_commitment_allowance'",
        )
      ).rows,
    ).toHaveLength(1);
    await pool.query("TRUNCATE marketplace_buyer_offer_policy_pages, marketplace_buyer_offer_policy_memberships");
    for (const event of recorded) await handlers[event.eventType]?.(toTransportEvent(event));
    const rebuilt = (
      await pool.query<{ state: BuyerOfferPolicyState }>("SELECT state FROM marketplace_buyer_offer_policy_pages")
    ).rows[0]!.state;
    expect(rebuilt).not.toHaveProperty("consumedItemAmount");
    expect(rebuilt.authority).not.toHaveProperty("itemCommitmentAllowance");
    expect(rebuilt.preview!.terms).not.toHaveProperty("itemCommitmentAllowance");
    expect(rebuilt.preview!.previewId).toBe("b".repeat(64));
    expect((await pool.query("SELECT last_stream_version FROM marketplace_buyer_offer_policy_pages")).rows).toEqual([
      { last_stream_version: 5 },
    ]);
    expect(
      (await pool.query("SELECT * FROM marketplace_buyer_offer_policy_memberships ORDER BY offer_id")).rows,
    ).toEqual(membership);
  });

  it("upgrades managed work and private audit tables with indexes and replayable evidence", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    await pool.query(
      "DROP TABLE marketplace_managed_offer_work, marketplace_managed_offer_audit, marketplace_managed_offer_recovery",
    );
    await pool.query(
      "DELETE FROM bounded_context_schema_migrations WHERE migration_id IN ('20260927_marketplace_managed_offer_work', '20260927_marketplace_managed_offer_scheduling')",
    );
    await bootstrapContextDatabase(marketplaceModule, pool);
    const f = await managedFixture(createPostgresEventStore({ pool }));
    f.setTarget({ status: "target", unitItemAmount: "12.00", evidence: { estimateVersion: "2" } });
    await f.offers.applyManagedOffer("off_one" as never, "work_one", context);
    const handlers = buildManagedOfferProjectionHandlers(pool);
    const events = await f.store.readAll();
    for (let replay = 0; replay < 2; replay++)
      for (const event of events)
        if (handlers[event.eventType]) await handlers[event.eventType]!(toTransportEvent(event));
    expect((await pool.query("SELECT status, reason, evidence FROM marketplace_managed_offer_audit")).rows).toEqual([
      { status: "applied", reason: "market-price-target", evidence: { estimateVersion: "2" } },
    ]);
    expect(
      (
        await pool.query(
          "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id IN ('20260927_marketplace_managed_offer_work', '20260927_marketplace_managed_offer_scheduling')",
        )
      ).rows,
    ).toHaveLength(2);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('marketplace_managed_offer_work_runnable_idx','marketplace_offer_managed_product_idx','marketplace_managed_offer_work_priority_idx','marketplace_managed_offer_work_product_idx')",
    );
    expect(indexes.rows).toHaveLength(4);
    await pool.query("INSERT INTO marketplace_managed_offer_recovery (singleton) VALUES (true)");
    expect((await pool.query("SELECT pending_work_ids FROM marketplace_managed_offer_recovery")).rows).toEqual([
      { pending_work_ids: [] },
    ]);
  });

  it("serializes competing PostgreSQL consent bundles without partial policy or membership writes", async () => {
    const pool = pools.marketplace;
    await bootstrapContextDatabase(marketplaceModule, pool);
    const store = createPostgresEventStore({ pool });
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db: pool,
      enforcement: { assertInstalled() {} },
      managedOfferPricing: {
        evaluateTargets: async (requests) =>
          requests.map(() => ({
            status: "held" as const,
            reason: "market-price-unavailable",
            evidence: { marketPrice: null },
          })),
      },
    });
    await seedOffer(store);
    await seedOffer(store, "off_two");
    const previews = [];
    for (const policyId of ["bop_one", "bop_two"]) {
      await runtime.execute(
        policyId,
        {
          attemptId: String("create").padEnd(22, "_"),
          type: "CreateBuyerOfferPolicy",
          expectedVersion: 0,
          operationId: "create",
        },
        context,
      );
      previews.push(
        await runtime.execute(
          policyId,
          {
            attemptId: String("preview").padEnd(22, "_"),
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
            attemptId: String("authorize").padEnd(22, "_"),
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
        attemptId: String("stop").padEnd(22, "_"),
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
