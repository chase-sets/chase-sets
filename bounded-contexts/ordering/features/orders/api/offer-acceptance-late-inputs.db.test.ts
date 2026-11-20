import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase, getProjectionGroup, syncProjectionGroup } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { MarketplaceListingCreatedPayload, MarketplaceOfferAcceptedPayload } from "@chase-sets/event-core";
import { isTransientProjectionError } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { isoUtcFromDate } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { contextManifest, module as orderingModule } from "../../../index";
import type { OrderingServices } from "../../../support/runtime-support/services";
import {
  getOrderingSupplyCandidateByListingId,
  hasAcceptedOfferSupplyInputs,
} from "../integrations/supply/supply-queries";
import { context, productMeasureForCandidate, shipFromAddress, shippingAddress } from "./runtime-test-harness";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;
const sourceModule = defineBoundedContextModule({
  manifest: { contextName: "marketplace", apiBasePath: "/api/marketplace", streamPrefix: "marketplace." },
  schemaSql: "",
  createServices: () => ({}),
  buildApis: () => [],
});
const sellerAccountId = "acc_late_input_seller" as AccountId;
const inventoryProjectionName = "ordering-inventory-supply-input-projection";
const inventoryCompanionFacts = [
  "inventory.item.stock-authority-claimed",
  "inventory.item.offline-sale-recorded",
] as const;
const terms = {
  marketplaceSalesFeePercentageBps: 300,
  marketplaceSalesFeeFixedAmount: "1.00",
  marketplaceSalesFeeCapAmount: "4.50",
  shippingAllowancePercentageBps: 400,
  termsScheduleId: "terms_fill",
  termsAgreementId: "agreement_fill",
  termsResolvedAt: "2026-10-05T00:00:00.000Z",
};

function fill(suffix: string, overrides: Partial<MarketplaceOfferAcceptedPayload> = {}) {
  const offer: MarketplaceOfferAcceptedPayload = {
    offerId: `off_${suffix}`,
    buyerAccountId: context.audit.forAccountId,
    sellerAccountId,
    listingId: `lst_${suffix}`,
    inventoryItemId: `inv_${suffix}`,
    listingVersion: 1,
    catalogItemId: `cat_${suffix}`,
    productId: `cat_${suffix}::`,
    itemTitle: "Card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    priceAmount: "150.00",
    priceCurrencyCode: "USD",
    ...terms,
    marketplaceSalesFeeUnitAmount: "4.50",
    sellerNetUnitAmount: "145.50",
    feeQuoteFingerprint: "sha256:synthetic-fill-fee",
    listingEvidencePolicyId: null,
    listingEvidencePolicyVersion: null,
    listingEvidencePolicyHash: "sha256:synthetic-fill-policy",
    listingEvidenceSnapshot: {
      schemaVersion: 1,
      policyHash: "sha256:synthetic-fill-policy",
      snapshotHash: "sha256:synthetic-fill-evidence",
      createdAt: terms.termsResolvedAt,
      evidence: [],
    },
    shippingDestinationSnapshot: shippingAddress,
    quantityRequested: 1,
    acceptanceBatchId: null,
    acceptanceBatchSize: null,
    acceptedAt: new Date().toISOString(),
    ...overrides,
  };
  const feeLocks = [
    {
      unitCount: 1,
      terms,
      marketplaceSalesFeeUnitAmount: offer.marketplaceSalesFeeUnitAmount,
      sellerNetUnitAmount: offer.sellerNetUnitAmount,
      feeQuoteFingerprint: offer.feeQuoteFingerprint,
    },
  ];
  const listing: MarketplaceListingCreatedPayload = {
    listingId: offer.listingId,
    accountId: sellerAccountId,
    inventoryItemId: offer.inventoryItemId,
    catalogItemId: offer.catalogItemId,
    productId: offer.productId,
    itemTitle: "Committed Listing card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    storageLocationName: null,
    shipFromCode: "AUS",
    shipFromAddress,
    productMeasureSnapshot: productMeasureForCandidate({
      ...offer,
      storageLocationName: null,
      shipFromCode: "AUS",
      availableQuantity: 1,
      updatedAt: offer.acceptedAt,
    }),
    priceAmount: offer.priceAmount,
    priceCurrencyCode: "USD",
    ...terms,
    marketplaceSalesFeeUnitAmount: offer.marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: offer.sellerNetUnitAmount,
    feeLocks,
    quantityCap: 1,
  };
  return { offer, listing };
}

describeDb("Ordering accepted Offers with late supply inputs", () => {
  let pools: Readonly<Record<"marketplace" | "inventory" | "ordering", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseUrl!,
      ["marketplace", "inventory", "ordering"],
      "offer_late_inputs",
    );
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    for (const source of ["marketplace", "inventory"] as const) {
      await bootstrapContextDatabase({ contextName: source, schemaSql: "" }, pools[source]);
    }
    await bootstrapContextDatabase(orderingModule, pools.ordering);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function mount({
    legacyInventoryProjection = false,
    inventoryBatchSize,
  }: { legacyInventoryProjection?: boolean; inventoryBatchSize?: number } = {}) {
    const sources = new Set([
      ...contextManifest.eventSubscriptions.map((entry) => entry.sourceContextName),
      ...contextManifest.eventReactions.map((entry) => entry.sourceContextName),
    ]);
    sources.delete("ordering");
    const runtime = createMountedContextTestRuntime([
      ...[...sources].map((contextName) => ({
        contextName,
        module: sourceModule,
        pool: contextName === "inventory" ? pools.inventory : pools.marketplace,
        ports: {},
        mountRole: "source-only" as const,
      })),
      {
        contextName: "ordering",
        module:
          legacyInventoryProjection || inventoryBatchSize !== undefined
            ? {
                ...orderingModule,
                buildSubscriptions: (services) =>
                  orderingModule.buildSubscriptions!(services).map((subscription) => {
                    if (subscription.projectionName !== inventoryProjectionName) return subscription;
                    if (!legacyInventoryProjection) return { ...subscription, batchSize: inventoryBatchSize };
                    const handlers = Object.fromEntries(
                      Object.entries(subscription.handlers).filter(
                        ([type]) => !inventoryCompanionFacts.some((companion) => companion === type),
                      ),
                    );
                    return { ...subscription, handlers, eventTypes: Object.keys(handlers) };
                  }),
                buildProjectionGroups: () =>
                  orderingModule
                    .buildProjectionGroups()
                    .map((group) =>
                      legacyInventoryProjection && group.projectionName === inventoryProjectionName
                        ? { ...group, projectionRevision: 1 }
                        : group,
                    ),
              }
            : orderingModule,
        pool: pools.ordering,
        ports: { inventoryCleanupAuthority: { kind: "not-mounted" as const } },
      },
    ]);
    const runner = (projectionName: string) =>
      runtime.subscriptionRunners.find(
        (entry) => entry.projectionName === projectionName && entry.sourceContextName !== "catalog",
      )!;
    return {
      reaction: runner("ordering-marketplace-offer-acceptance"),
      listings: runner("ordering-marketplace-supply-input-projection"),
      inventory: runner(inventoryProjectionName),
      inventoryGroup: getProjectionGroup(runtime, "ordering", inventoryProjectionName),
      orders: runner("ordering-order-projection"),
      services: runtime.mountedContexts.find((entry) => entry.contextName === "ordering")!.services as OrderingServices,
    };
  }

  async function commitFill({ offer, listing }: ReturnType<typeof fill>, recordedMinutesAgo = 0) {
    const store = createPostgresEventStore({
      pool: pools.marketplace,
      now: () => isoUtcFromDate(new Date(Date.now() - recordedMinutesAgo * 60_000)),
    });
    const [, accepted] = await withPgTransaction(pools.marketplace, (db) =>
      store.appendToStreamsInTransaction(db, [
        {
          streamId: `marketplace.listing-${listing.listingId}`,
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "marketplace.listing.created", payload: listing }],
        },
        {
          streamId: `marketplace.offer-${offer.offerId}`,
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "marketplace.offer.accepted", payload: offer }],
        },
      ]),
    );
    return accepted!.storedEvents[0]!;
  }

  const inventoryStreamId = (offer: MarketplaceOfferAcceptedPayload) => `inventory.item-${offer.inventoryItemId}`;

  async function createInventory(offer: MarketplaceOfferAcceptedPayload, totalQuantity = 1) {
    const [created] = await createPostgresEventStore({ pool: pools.inventory }).appendToStream({
      streamId: inventoryStreamId(offer),
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: offer.inventoryItemId,
            accountId: sellerAccountId,
            catalogItemId: offer.catalogItemId,
            productId: offer.productId,
            totalQuantity,
          },
        },
      ],
    });
    return created!;
  }

  async function adjustInventory(offer: MarketplaceOfferAcceptedPayload, quantityDelta: number, expectedVersion = 1) {
    const [adjusted] = await createPostgresEventStore({ pool: pools.inventory }).appendToStream({
      streamId: inventoryStreamId(offer),
      expectedVersion,
      context,
      events: [
        {
          eventType: "inventory.item.adjusted",
          payload: { itemId: offer.inventoryItemId, quantityDelta },
        },
      ],
    });
    return adjusted!;
  }

  async function commitHold(offer: MarketplaceOfferAcceptedPayload, holdId: string) {
    const store = createPostgresEventStore({ pool: pools.inventory });
    const [claim, placed] = await withPgTransaction(pools.inventory, (db) =>
      store.appendToStreamsInTransaction(db, [
        {
          streamId: inventoryStreamId(offer),
          expectedVersion: 1,
          context,
          events: [
            {
              eventType: "inventory.item.stock-authority-claimed",
              payload: {
                itemId: offer.inventoryItemId,
                authorityRef: holdId,
                operation: "hold-placement",
                quantity: 1,
              },
            },
          ],
        },
        {
          streamId: `inventory.hold-${holdId}`,
          expectedVersion: "no_stream",
          context,
          events: [
            {
              eventType: "inventory.hold.placed",
              payload: {
                holdId,
                itemId: offer.inventoryItemId,
                accountId: sellerAccountId,
                quantity: 1,
                reason: "Existing hold",
                notes: null,
                purpose: "manual",
                sourceRef: null,
                expiresAt: null,
              },
            },
          ],
        },
      ]),
    );
    return { claim: claim!.storedEvents[0]!, hold: placed!.storedEvents[0]! };
  }

  async function createdOrders() {
    const result = await pools.ordering.query<{ payload: { orderId: string } }>(
      "SELECT payload FROM event_store_events WHERE event_type = 'ordering.order.created'",
    );
    return result.rows.map((row) => row.payload);
  }

  async function expectWait(reaction: ReturnType<typeof mount>["reaction"], checkpoint = ZERO_GLOBAL_POSITION) {
    const result = await reaction.runOnce().then(
      () => ({ transient: false }),
      (error: unknown) => ({ transient: isTransientProjectionError(error) }),
    );
    expect(result.transient).toBe(true);
    expect(await reaction.refreshStatus()).toMatchObject({
      lastGlobalPosition: checkpoint,
      blockedStreamCount: 0,
      poisonEventCount: 0,
    });
    expect(await createdOrders()).toEqual([]);
  }

  it("waits for a Listing committed with the acceptance and creates one Order after restart", async () => {
    const fixture = fill("listing");
    const first = mount();
    await createInventory(fixture.offer);
    await first.inventory.runOnce();
    const accepted = await commitFill(fixture);
    await expectWait(first.reaction);
    expect((await pools.ordering.query("SELECT offer_id FROM ordering_offer_acceptance_inputs")).rows).toEqual([]);

    const restarted = mount();
    await restarted.listings.runOnce();
    expect(await restarted.reaction.runOnce()).toMatchObject({ lastGlobalPosition: accepted.globalPosition });
    await restarted.reaction.runOnce();
    expect(await createdOrders()).toEqual([
      expect.objectContaining({ sourceType: "offer-acceptance", sourceReferenceId: fixture.offer.offerId }),
    ]);
  });

  it.each(["missing", "stale"] as const)("waits for %s Inventory input until its event projects", async (input) => {
    const fixture = fill("inventory", input === "stale" ? { inventoryItemVersion: 2 } : {});
    const { reaction, listings, inventory } = mount();
    await createInventory(fixture.offer);
    if (input === "stale") {
      await inventory.runOnce();
      await adjustInventory(fixture.offer, 1);
    }
    const accepted = await commitFill(fixture);
    await listings.runOnce();

    await expectWait(reaction);
    await inventory.runOnce();
    expect(await reaction.runOnce()).toMatchObject({ lastGlobalPosition: accepted.globalPosition });
    await reaction.runOnce();
    expect(await createdOrders()).toEqual([expect.objectContaining({ sourceReferenceId: fixture.offer.offerId })]);
  });

  it.each(inventoryCompanionFacts)("replays %s and creates one Order at that Inventory version", async (fact) => {
    const isHold = fact === "inventory.item.stock-authority-claimed";
    const fixture = fill("companion", { inventoryItemVersion: isHold ? 2 : 3 });
    const { offer } = fixture;
    const store = createPostgresEventStore({ pool: pools.inventory });
    await createInventory(offer, 3);
    if (isHold) {
      await commitHold(offer, "inh_existing");
    } else {
      await store.appendToStream({
        streamId: inventoryStreamId(offer),
        expectedVersion: 1,
        context,
        events: [
          {
            eventType: "inventory.item.adjusted",
            payload: {
              itemId: offer.inventoryItemId,
              quantityDelta: -1,
              reason: "Offline sale",
              reasonCode: "sold-offline",
            },
          },
          {
            eventType: fact,
            payload: {
              itemId: offer.inventoryItemId,
              quantity: 1,
              salePriceAmount: null,
              channel: "card-show",
              storageLocationId: "sl_companion",
              acquisitionCostAmount: null,
              recordedAt: offer.acceptedAt,
            },
          },
        ],
      });
    }

    const tail = await createInventory(fill("checkpoint_tail").offer);
    const legacy = mount({ legacyInventoryProjection: true });
    await syncProjectionGroup(legacy.inventoryGroup);
    expect(await legacy.inventory.refreshStatus()).toMatchObject({ lastGlobalPosition: tail.globalPosition });
    const inventoryInput = async () =>
      (
        await pools.ordering.query(
          `SELECT total_quantity, last_stream_version FROM ordering_inventory_item_inputs WHERE item_id = $1`,
          [offer.inventoryItemId],
        )
      ).rows;
    const totalQuantity = isHold ? 3 : 2;
    expect(await inventoryInput()).toEqual([{ total_quantity: totalQuantity, last_stream_version: isHold ? 1 : 2 }]);

    const { reaction, listings, inventoryGroup } = mount();
    const accepted = await commitFill(fixture);
    await listings.runOnce();
    await expectWait(reaction);
    expect(await inventoryGroup.refreshStatus()).toMatchObject({ storedProjectionRevision: 1, revisionStale: true });

    await syncProjectionGroup(inventoryGroup);
    expect(await inventoryGroup.refreshStatus()).toMatchObject({ storedProjectionRevision: 2, revisionStale: false });
    expect(await inventoryInput()).toEqual([
      { total_quantity: totalQuantity, last_stream_version: offer.inventoryItemVersion },
    ]);
    expect(
      (
        await pools.ordering.query("SELECT quantity, status FROM ordering_inventory_hold_inputs WHERE item_id = $1", [
          offer.inventoryItemId,
        ])
      ).rows,
    ).toEqual(isHold ? [{ quantity: 1, status: "active" }] : []);
    expect(await reaction.runOnce()).toMatchObject({ lastGlobalPosition: accepted.globalPosition });
    await reaction.runOnce();
    expect(await createdOrders()).toEqual([expect.objectContaining({ sourceReferenceId: offer.offerId })]);
  });

  it("retries between the claim and hold pages and rejects when the hold exhausts stock", async () => {
    const fixture = fill("hold_page_split", { inventoryItemVersion: 2 });
    const { offer } = fixture;
    const holdId = "inh_page_split";
    const first = mount({ inventoryBatchSize: 1 });
    await createInventory(offer);
    const { claim, hold } = await commitHold(offer, holdId);
    const accepted = await commitFill(fixture);
    await first.listings.runOnce();

    const itemInput = async () =>
      (
        await pools.ordering.query(
          "SELECT total_quantity, last_stream_version FROM ordering_inventory_item_inputs WHERE item_id = $1",
          [offer.inventoryItemId],
        )
      ).rows;
    const pendingClaim = async () =>
      (
        await pools.ordering.query(
          "SELECT item_id, item_stream_version FROM ordering_inventory_pending_hold_claims WHERE hold_id = $1",
          [holdId],
        )
      ).rows;
    const holdInput = async () =>
      (
        await pools.ordering.query("SELECT quantity, status FROM ordering_inventory_hold_inputs WHERE hold_id = $1", [
          holdId,
        ])
      ).rows;

    await first.inventory.runOnce(); // Inventory item creation
    expect(await first.inventory.runOnce()).toMatchObject({ lastGlobalPosition: claim.globalPosition });
    await expectWait(first.reaction);
    expect(await itemInput()).toEqual([{ total_quantity: 1, last_stream_version: 1 }]);
    expect(await pendingClaim()).toEqual([{ item_id: offer.inventoryItemId, item_stream_version: 2 }]);
    expect(await holdInput()).toEqual([]);

    const restarted = mount({ inventoryBatchSize: 1 });
    expect(await restarted.inventory.runOnce()).toMatchObject({ lastGlobalPosition: hold.globalPosition });
    expect(await itemInput()).toEqual([{ total_quantity: 1, last_stream_version: 2 }]);
    expect(await pendingClaim()).toEqual([]);
    expect(await holdInput()).toEqual([{ quantity: 1, status: "active" }]);
    expect(await restarted.reaction.runOnce()).toMatchObject({
      lastGlobalPosition: accepted.globalPosition,
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    expect(
      (
        await pools.ordering.query("SELECT error_message FROM event_projection_poison_events WHERE event_id = $1", [
          accepted.eventId,
        ])
      ).rows,
    ).toEqual([{ error_message: `Committed Listing ${fixture.listing.listingId} is not available in Ordering.` }]);
    expect(await createdOrders()).toEqual([]);
  });

  it("waits for a poisoned hold despite a newer item version and finds exhausted supply after retry", async () => {
    const fixture = fill("hold_poison", { inventoryItemVersion: 2 });
    const unrelated = fill("hold_poison_unrelated", { inventoryItemVersion: 1 });
    const { offer } = fixture;
    const { inventory, listings, reaction } = mount({ inventoryBatchSize: 1 });
    const db = pools.ordering;

    await createInventory(unrelated.offer);
    await createInventory(offer, 2);
    const { claim, hold } = await commitHold(offer, "inh_poisoned");
    const adjusted = await adjustInventory(offer, -1, 2);
    await commitFill(fixture);
    await commitFill(unrelated);
    await listings.runOnce();

    await db.query(`ALTER TABLE ordering_inventory_hold_inputs
      ADD CONSTRAINT synthetic_hold_projection_failure CHECK (hold_id <> 'inh_poisoned')`);
    await inventory.runOnce(); // Unrelated item creation
    await inventory.runOnce(); // Target item creation
    expect(await inventory.runOnce()).toMatchObject({ lastGlobalPosition: claim.globalPosition });
    expect(await inventory.runOnce()).toMatchObject({
      lastGlobalPosition: hold.globalPosition,
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    expect(await inventory.runOnce()).toMatchObject({ lastGlobalPosition: adjusted.globalPosition });

    const itemInput = async () =>
      (
        await db.query(
          "SELECT total_quantity, last_stream_version FROM ordering_inventory_item_inputs WHERE item_id = $1",
          [offer.inventoryItemId],
        )
      ).rows;
    const isReady = () => hasAcceptedOfferSupplyInputs(db, offer.listingId, offer.inventoryItemId, 2);
    expect(await itemInput()).toEqual([{ total_quantity: 1, last_stream_version: 3 }]);
    expect(await isReady()).toBe(false);
    expect(await hasAcceptedOfferSupplyInputs(db, unrelated.offer.listingId, unrelated.offer.inventoryItemId, 1)).toBe(
      true,
    );
    await expectWait(reaction);

    const loadCommittedCandidate = () =>
      getOrderingSupplyCandidateByListingId(db, offer.listingId, { allowCommitted: true });
    expect(await loadCommittedCandidate()).toMatchObject({ availableQuantity: 1 });
    await db.query(`ALTER TABLE ordering_inventory_hold_inputs DROP CONSTRAINT synthetic_hold_projection_failure`);
    expect(await inventory.retryBlockedStream(hold.streamId)).toMatchObject({ state: "resolved", appliedEvents: 1 });
    expect(await itemInput()).toEqual([{ total_quantity: 1, last_stream_version: 3 }]);
    expect(await isReady()).toBe(true);
    expect(await loadCommittedCandidate()).toBeNull();
  });

  it("rejects fresh but exhausted supply without a transient retry", async () => {
    const fixture = fill("exhausted", { inventoryItemVersion: 2 });
    const { reaction, listings, inventory } = mount();
    await createInventory(fixture.offer);
    await adjustInventory(fixture.offer, -1);
    const accepted = await commitFill(fixture);
    await listings.runOnce();
    await inventory.runOnce();

    expect(await reaction.runOnce()).toMatchObject({
      lastGlobalPosition: accepted.globalPosition,
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    expect(
      (
        await pools.ordering.query("SELECT error_message FROM event_projection_poison_events WHERE event_id = $1", [
          accepted.eventId,
        ])
      ).rows,
    ).toEqual([
      {
        error_message: `Committed Listing ${fixture.listing.listingId} is not available in Ordering.`,
      },
    ]);
    expect(await createdOrders()).toEqual([]);
    await reaction.runOnce();
    expect(await createdOrders()).toEqual([]);
  });

  it("blocks an expired missing input and creates exactly one Order on blocked-stream Retry", async () => {
    const fixture = fill("expired");
    const { reaction, listings, inventory } = mount();
    await createInventory(fixture.offer);
    await inventory.runOnce();
    const accepted = await commitFill(fixture, 16);

    expect(await reaction.runOnce()).toMatchObject({
      lastGlobalPosition: accepted.globalPosition,
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    expect(await createdOrders()).toEqual([]);
    await listings.runOnce();
    expect(await reaction.retryBlockedStream(accepted.streamId)).toMatchObject({ state: "resolved", appliedEvents: 1 });
    expect(await reaction.retryBlockedStream(accepted.streamId)).toMatchObject({ state: "already-resolved" });
    expect(await reaction.refreshStatus()).toMatchObject({
      state: "caught-up",
      blockedStreamCount: 0,
      poisonEventCount: 0,
    });
    expect(await createdOrders()).toEqual([expect.objectContaining({ sourceReferenceId: fixture.offer.offerId })]);
  });

  it.each([0, 16])("checks the first batch member's version and recorded age of %i minutes", async (firstAge) => {
    const batch = { acceptanceBatchId: "batch_late_input", acceptanceBatchSize: 2 };
    const first = fill("batch_first", { ...batch, inventoryItemVersion: 2 });
    const last = fill("batch_last", batch);
    const { reaction, listings, inventory } = mount();
    await createInventory(first.offer);
    await createInventory(last.offer);
    await inventory.runOnce();
    await adjustInventory(first.offer, 1);
    const firstAccepted = await commitFill(first, firstAge);
    const lastAccepted = await commitFill(last);
    await listings.runOnce();

    if (firstAge === 0) {
      await expectWait(reaction, firstAccepted.globalPosition);
      await inventory.runOnce();
      expect(await reaction.runOnce()).toMatchObject({ lastGlobalPosition: lastAccepted.globalPosition });
    } else {
      expect(await reaction.runOnce()).toMatchObject({
        state: "degraded",
        lastGlobalPosition: lastAccepted.globalPosition,
        blockedStreams: 1,
        poisonEvents: 1,
      });
      expect(await createdOrders()).toEqual([]);
      await inventory.runOnce();
      expect(await reaction.retryBlockedStream(lastAccepted.streamId)).toMatchObject({
        state: "resolved",
        appliedEvents: 1,
      });
    }
    await reaction.runOnce();
    expect(await createdOrders()).toEqual([
      expect.objectContaining({
        sourceReferenceId: batch.acceptanceBatchId,
        lines: [
          expect.objectContaining({ listingId: first.listing.listingId }),
          expect.objectContaining({ listingId: last.listing.listingId }),
        ],
      }),
    ]);
  });

  it.each([
    { lastAge: 16, outcome: "poisons immediately when a young miss sorts before an expired miss" },
    { lastAge: 0, outcome: "retries when all stale members are still young" },
  ])("$outcome", async ({ lastAge }) => {
    const batch = { acceptanceBatchId: "batch_two_stale", acceptanceBatchSize: 2, inventoryItemVersion: 2 };
    const first = fill("batch_a", batch);
    const last = fill("batch_z", batch);
    const { reaction, listings, inventory } = mount();
    await createInventory(first.offer);
    await createInventory(last.offer);
    await inventory.runOnce();
    await adjustInventory(first.offer, 1);
    await adjustInventory(last.offer, 1);
    const lastAccepted = await commitFill(last, lastAge);
    const firstAccepted = await commitFill(first);
    await listings.runOnce();

    if (lastAge === 0) {
      await expectWait(reaction, lastAccepted.globalPosition);
    } else {
      expect(await reaction.runOnce()).toMatchObject({
        state: "degraded",
        lastGlobalPosition: firstAccepted.globalPosition,
        blockedStreams: 1,
        poisonEvents: 1,
      });
      expect(
        (
          await pools.ordering.query("SELECT error_message FROM event_projection_poison_events WHERE event_id = $1", [
            firstAccepted.eventId,
          ])
        ).rows,
      ).toEqual([{ error_message: `Committed Listing ${last.listing.listingId} is not available in Ordering.` }]);
      expect(await createdOrders()).toEqual([]);
    }
    expect((await pools.ordering.query("SELECT offer_id FROM ordering_offer_acceptance_inputs")).rows).toEqual([
      { offer_id: last.offer.offerId },
    ]);

    await inventory.runOnce();
    if (lastAge > 0) {
      expect(await reaction.retryBlockedStream(firstAccepted.streamId)).toMatchObject({
        state: "resolved",
        appliedEvents: 1,
      });
    } else {
      expect(await reaction.runOnce()).toMatchObject({ lastGlobalPosition: firstAccepted.globalPosition });
    }
    await reaction.runOnce();
    expect(await createdOrders()).toEqual([expect.objectContaining({ sourceReferenceId: batch.acceptanceBatchId })]);
  });

  it("uses the draft committed Listing, locked terms and accepted evidence and cancels normally", async () => {
    const fixture = fill("draft");
    const { reaction, listings, inventory, orders, services } = mount();
    await createInventory(fixture.offer);
    await commitFill(fixture);
    await listings.runOnce();
    await inventory.runOnce();
    expect(
      (
        await pools.ordering.query(
          "SELECT status, fee_locks FROM ordering_market_listing_inputs WHERE listing_id = $1",
          [fixture.listing.listingId],
        )
      ).rows,
    ).toEqual([{ status: "draft", fee_locks: fixture.listing.feeLocks }]);

    await reaction.runOnce();
    const created = await createdOrders();
    expect(created).toEqual([
      expect.objectContaining({
        sourceType: "offer-acceptance",
        sourceReferenceId: fixture.offer.offerId,
        commercialTermsSnapshot: expect.objectContaining({
          shippingAllowancePercentageBps: terms.shippingAllowancePercentageBps,
          termsScheduleId: terms.termsScheduleId,
          termsAgreementId: terms.termsAgreementId,
          termsResolvedAt: terms.termsResolvedAt,
        }),
        lines: [
          expect.objectContaining({
            listingId: fixture.listing.listingId,
            inventoryItemId: fixture.offer.inventoryItemId,
            itemTitle: fixture.listing.itemTitle,
            unitPriceAmount: fixture.offer.priceAmount,
            marketplaceSalesFeePercentageBps: terms.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: terms.marketplaceSalesFeeFixedAmount,
            marketplaceSalesFeeCapAmount: terms.marketplaceSalesFeeCapAmount,
            marketplaceSalesFeeUnitAmount: fixture.offer.marketplaceSalesFeeUnitAmount,
            sellerNetUnitAmount: fixture.offer.sellerNetUnitAmount,
            listingEvidenceSnapshot: fixture.offer.listingEvidenceSnapshot,
          }),
        ],
      }),
    ]);
    await orders.runOnce();
    const orderId = created[0]!.orderId;
    await services.orders.cancelPurchase({ orderId, buyerAccountId: fixture.offer.buyerAccountId }, context);
    await orders.runOnce();
    expect(await services.orders.getPurchase(orderId, fixture.offer.buyerAccountId)).toMatchObject({
      status: "cancelled",
    });
  });
});
