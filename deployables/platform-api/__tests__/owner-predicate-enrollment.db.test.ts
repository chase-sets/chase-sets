import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  runInProjectionDbContext,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as catalogModule } from "@chase-sets/catalog";
import { assignSyntheticPromotionCategory } from "@chase-sets/catalog/test-support";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { reservationInput, type RequestTerminalBinding } from "@chase-sets/event-core/owner-stream-reservation";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  initializeConfigurationConsumer,
  openRequestTerminalInTransaction,
  ownerPredicateKey,
  readOwnerPredicateSealInTransaction,
  reserveOwnerPredicateInTransaction,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createId, type ListingId } from "@chase-sets/primitives/typed-ids";
import { module as pricingModule } from "@chase-sets/pricing";
import { repricingEnginePolicy } from "@chase-sets/pricing/server";
import {
  activeProductFreeze,
  readProductRoundState,
  recordProductRoundDirection,
} from "@chase-sets/pricing/test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for owner predicate DB proofs.");
const describeDb = databaseUrl ? describe : describe.skip;
const names = ["catalog", "inventory", "marketplace", "pricing"] as const;
const now = "2026-11-19T12:00:00.000Z";
const consumerIdentity = { storeId: "marketplace", incarnation: "synthetic-owner-predicate-enrollment" };
function quote(accountId: string, amount: string) {
  return {
    accountId,
    accountType: "business" as const,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount: "1.00",
    sellerNetUnitAmount: "9.00",
    marketplaceSalesFeePercentageBps: 1000,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: null,
    shippingAllowancePercentageBps: 0,
    scheduleId: "cts_synthetic",
    agreementId: null,
    resolvedAt: now,
  };
}
const terms: CommercialTermsResolver = {
  resolveListingTerms: async ({ accountId, amount }) => quote(accountId, amount),
  resolveOrderTerms: async () => {
    throw new Error("Unused order terms");
  },
  resolvePublicStandardListingTerms: async () => {
    throw new Error("Unused public terms");
  },
  openListingTermsSession: async ({ accountId }) => ({
    ...quote(accountId, "0.00"),
    quote: (amount) => quote(accountId, amount),
  }),
};
const shipFromAddress = {
  name: "Synthetic",
  line1: "1 Main St",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
};

function observedPool(
  pool: PgTransactionalPool,
  query: (db: PgQueryable) => PgQueryable["query"],
): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return { query: query(client), release: client.release.bind(client) };
    },
  };
}

function gate() {
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    reached: reachedPromise,
    resume,
    async stop() {
      reached();
      await resumed;
    },
  };
}

describeDb("own predicate writer enrollment with Pricing projection delivery held", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<(typeof names)[number]>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, names, "owner_predicate_11591");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    await initializeConfigurationConsumer(pools.marketplace, consumerIdentity);
    for (const owner of ["catalog", "inventory", "pricing"] as const) {
      await initializeConfigurationConsumer(pools[owner], { storeId: owner, incarnation: `synthetic-${owner}` });
    }
    // No subscriptions or projectors are started. Writer decisions use owner persistence only.
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function prepare(owner: PgTransactionalPool, key: string, context: EventStoreContext) {
    const requestId = `synthetic-${createId("evt")}`;
    const target = { sellerAccountId: context.audit.forAccountId, fixture: "synthetic-pricing-decision" };
    const reservation = await withPgTransaction(owner, async (db) => {
      const seal = await readOwnerPredicateSealInTransaction(db, key);
      expect(seal).toBeDefined();
      return reserveOwnerPredicateInTransaction(db, {
        reservationId: requestId,
        operationId: requestId,
        ownerStreamId: key,
        resourceKey: key,
        purpose: "synthetic-pricing-predicate",
        consumer: { ...consumerIdentity, requestId },
        seal: seal!,
        target,
        commandFingerprint: requestId,
      });
    });
    const binding: RequestTerminalBinding = {
      consumerStoreId: consumerIdentity.storeId,
      consumerIncarnation: consumerIdentity.incarnation,
      requestId,
      commandFingerprint: requestId,
      target,
      reservations: [reservationInput(reservation)],
      preparationDeadline: "2099-01-01T00:00:00.000Z",
    };
    await withPgTransaction(pools.marketplace, (db) => openRequestTerminalInTransaction(db, binding));
    return {
      requestId,
      commit: (db = pools.marketplace) =>
        createPostgresEventStore({ pool: db }).appendToStreams!([
          {
            streamId: `marketplace.synthetic-terminal-${requestId}`,
            events: [],
            expectedVersion: 0,
            requestTerminal: binding,
            context,
          },
        ]),
      status: async () =>
        (
          await pools.marketplace.query<{ status: string }>(
            "SELECT status FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2",
            [consumerIdentity.storeId, requestId],
          )
        ).rows[0]?.status,
    };
  }

  function fixture() {
    const accountId = createId("acc");
    const context = {
      tenantId: createId("tnt"),
      audit: { forAccountId: accountId, performedByUserId: createId("usr") },
    };
    const catalogItemId = createId("cat");
    const categoryId = createId("ctg");
    const itemId = createId("inv");
    const locationId = createId("loc");
    const productId = `${catalogItemId}::` as const;
    const catalogServices = (consumerPool = pools.marketplace, db = pools.catalog) =>
      catalogModule.createServices(db, { pricingPredicateConsumerPool: consumerPool });
    const marketplaceServices = (db = pools.marketplace) =>
      marketplaceModule.createServices(db, {
        commercialTermsResolver: terms,
        // Fixture Listings are created for a raw item; most cases never create it in Inventory.
        inventoryItemGradedCardAuthority: { resolve: async () => ({ gradedCard: null }) },
      });
    const actor = {
      accountId,
      tenantId: context.tenantId,
      userId: context.audit.performedByUserId,
      sessionId: createId("ses"),
      membershipId: createId("mbr"),
      roleKey: "manager",
      permissions: ["listings.manage", "catalog.manage"],
    };
    function router(child: unknown) {
      if (!(child instanceof Hono)) throw new Error("Expected a mounted Hono route.");
      const app = new Hono<AuthenticatedApiEnv>();
      app.use("*", async (c, next) => {
        c.set("context", context);
        c.set("actor", actor);
        await next();
      });
      return app.route("/", child);
    }
    /** The supply mirror row a native Listing needs: the Product's Resolved Product Measure. */
    async function mirrorProductMeasure() {
      await pools.marketplace.query(
        `INSERT INTO marketplace_catalog_items (catalog_item_id, title, status, product_measure_snapshots)
         VALUES ($1, 'Synthetic item', 'published', $2)
         ON CONFLICT (catalog_item_id) DO UPDATE SET product_measure_snapshots = EXCLUDED.product_measure_snapshots`,
        [
          catalogItemId,
          JSON.stringify([
            {
              catalogItemId,
              productId,
              selectedOptions: [],
              measureVersion: "pm_synthetic",
              unitLengthInches: 3.5,
              unitWidthInches: 2.5,
              unitHeightInches: 0.01,
              unitWeightOunces: 0.1,
              physicalFlags: ["bendable"],
              stackBehavior: "stackable-thickness",
              source: "profile",
              confidence: "measured",
            },
          ]),
        ],
      );
    }
    return {
      accountId,
      context,
      catalogItemId,
      categoryId,
      itemId,
      productId,
      catalogServices,
      marketplaceServices,
      mirrorProductMeasure,
      catalogKey: ownerPredicateKey("repricing-catalog-category", catalogItemId, categoryId),
      async createCatalogItem() {
        await catalogServices().items.commandHandler({
          streamId: `catalog.item-${catalogItemId}`,
          context,
          command: {
            type: "CreateCatalogItem",
            itemId: catalogItemId,
            title: { defaultLocale: "en", values: { en: "Synthetic item" } },
          },
        });
      },
      categoryRequest(method: "POST" | "DELETE", consumer = pools.marketplace, db = pools.catalog) {
        const mount = catalogModule.buildApis!(catalogServices(consumer, db))[0]!;
        return router(mount.router).request(`/items/${catalogItemId}/categories/${categoryId}`, { method });
      },
      async createFixtureListing(
        publicationScope: "channel-only" | "native" = "channel-only",
        db = pools.marketplace,
        listingIdOverride?: ListingId,
      ) {
        if (publicationScope === "native") await mirrorProductMeasure();
        return marketplaceServices(db).listings.createListingFromInventorySnapshot(
          {
            accountId,
            inventoryItemId: itemId,
            catalogItemId,
            productId,
            selectedOptions: [],
            storageLocationId: locationId,
            storageLocationName: "Synthetic",
            shipFromCode: "60601",
            shipFromAddress,
            totalQuantity: 2,
            availableQuantity: 2,
            acquisitionCostAmount: null,
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
            publicationScope,
            ...(listingIdOverride ? { listingIdOverride } : {}),
            idempotencyKey: `synthetic-create-${itemId}`,
          },
          context,
        );
      },
      withdraw(listingId: string, db = pools.marketplace) {
        const mount = marketplaceModule.buildApis!(marketplaceServices(db))[0]!;
        return router(mount.router).request(`/account/listings/${listingId}/withdraw`, {
          method: "POST",
          headers: { "Idempotency-Key": `synthetic-withdraw-${listingId}` },
        });
      },
      async createInventoryItem(db: PgTransactionalPool) {
        const inventory = inventoryModule.createServices(db, { stockReservationConsumerPool: pools.marketplace });
        return inventory.items.commandHandler({
          streamId: `inventory.item-${itemId}`,
          context,
          command: {
            type: "CreateInventoryItem",
            itemId,
            accountId,
            catalogItemId,
            productId,
            selectedOptions: [],
            storageLocationId: locationId,
            totalQuantity: 10,
            acquisitionOccurrence: { kind: "unknown" },
            commandOccurredAt: now,
          },
        });
      },
      async createInventoryStorage() {
        await inventoryModule.createServices(pools.inventory, {}).storageLocations.commandHandler({
          streamId: `inventory.storage-location-${locationId}`,
          context,
          command: {
            type: "CreateStorageLocation",
            storageLocationId: locationId,
            accountId,
            name: "Synthetic",
            shipFromCode: "60601",
            shipFromAddress,
          },
        });
      },
    };
  }

  it.each([
    ["assign", "POST"],
    ["remove", "DELETE"],
  ] as const)(
    "orders the real Catalog %s route in both terminal races without closing another same-seller decision",
    async (_operation, method) => {
      for (const terminalFirst of [false, true]) {
        const f = fixture();
        await f.createCatalogItem();
        if (method === "DELETE") expect((await f.categoryRequest("POST")).status).toBe(201);
        const affected = await prepare(pools.catalog, f.catalogKey, f.context);
        const unaffected = await prepare(
          pools.catalog,
          ownerPredicateKey("repricing-catalog-category", f.catalogItemId, createId("ctg")),
          f.context,
        );
        if (terminalFirst) await affected.commit();
        expect((await f.categoryRequest(method)).status).toBe(method === "POST" ? 201 : 200);
        if (!terminalFirst) await expect(affected.commit()).rejects.toThrow("already final");
        expect(await affected.status()).toBe(terminalFirst ? "COMMITTED" : "ABORTED");
        await unaffected.commit();
        expect(await unaffected.status()).toBe("COMMITTED");
      }
    },
  );

  it("orders the real withdraw route in both terminal races without closing another same-seller Listing", async () => {
    for (const terminalFirst of [false, true]) {
      const f = fixture();
      const listing = await f.createFixtureListing();
      const affected = await prepare(
        pools.marketplace,
        ownerPredicateKey("repricing-listing", listing.listingId),
        f.context,
      );
      const unaffected = await prepare(
        pools.marketplace,
        ownerPredicateKey("repricing-listing", createId("lst")),
        f.context,
      );
      if (terminalFirst) await affected.commit();
      expect((await f.withdraw(listing.listingId)).status).toBe(200);
      if (!terminalFirst) await expect(affected.commit()).rejects.toThrow("already final");
      expect(await affected.status()).toBe(terminalFirst ? "COMMITTED" : "ABORTED");
      await unaffected.commit();
      expect(await unaffected.status()).toBe("COMMITTED");
    }
  });

  it("keeps a COMMIT already in flight when the Catalog writer closes its generation", async () => {
    const f = fixture();
    await f.createCatalogItem();
    const affected = await prepare(pools.catalog, f.catalogKey, f.context);
    const afterCas = gate();
    const writerEntered = gate();
    const consumer = observedPool(pools.marketplace, (db) => async <Row>(sql: string, values?: readonly unknown[]) => {
      const result = await db.query<Row>(sql, values);
      if (sql.startsWith("UPDATE event_request_terminals") && values?.[2] === "COMMITTED") await afterCas.stop();
      return result;
    });
    const observer = observedPool(pools.marketplace, (db) => async <Row>(sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith("SELECT binding, status FROM event_request_terminals")) await writerEntered.stop();
      return db.query<Row>(sql, values);
    });
    const commit = affected.commit(consumer);
    await Promise.race([
      afterCas.reached,
      commit.then(() => {
        throw new Error("COMMIT gate was bypassed.");
      }),
    ]);
    const writer = f.categoryRequest("POST", observer);
    try {
      await Promise.race([
        writerEntered.reached,
        Promise.resolve(writer).then(() => {
          throw new Error("Writer did not drive the original terminal.");
        }),
      ]);
    } finally {
      afterCas.resume();
      writerEntered.resume();
    }
    await commit;
    expect((await writer).status).toBe(201);
    expect(await affected.status()).toBe("COMMITTED");
  });

  it("wins the original ABORT CAS while a competing COMMIT is starting", async () => {
    const f = fixture();
    const listing = await f.createFixtureListing();
    const affected = await prepare(
      pools.marketplace,
      ownerPredicateKey("repricing-listing", listing.listingId),
      f.context,
    );
    const afterAbort = gate();
    const commitEntered = gate();
    const writerPool = observedPool(
      pools.marketplace,
      (db) =>
        async <Row>(sql: string, values?: readonly unknown[]) => {
          const result = await db.query<Row>(sql, values);
          if (sql.startsWith("UPDATE event_request_terminals") && values?.[2] === "ABORTED") await afterAbort.stop();
          return result;
        },
    );
    const commitPool = observedPool(
      pools.marketplace,
      (db) =>
        async <Row>(sql: string, values?: readonly unknown[]) => {
          if (sql.includes("'request_terminal:'")) await commitEntered.stop();
          return db.query<Row>(sql, values);
        },
    );
    const writer = Promise.resolve(f.withdraw(listing.listingId, writerPool));
    await Promise.race([
      afterAbort.reached,
      writer.then(() => {
        throw new Error("Writer bypassed the original ABORT CAS.");
      }),
    ]);
    const commit = expect(affected.commit(commitPool)).rejects.toThrow("already final");
    try {
      await commitEntered.reached;
    } finally {
      afterAbort.resume();
      commitEntered.resume();
    }
    await commit;
    expect((await writer).status).toBe(200);
    expect(await affected.status()).toBe("ABORTED");
  });

  it("retains the original invalidation after a lost ABORT reply and settles it on restart", async () => {
    const f = fixture();
    await f.createCatalogItem();
    const affected = await prepare(pools.catalog, f.catalogKey, f.context);
    const consumer = observedPool(pools.marketplace, (db) => {
      let aborted = false;
      return async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await db.query<Row>(sql, values);
        if (sql.startsWith("UPDATE event_request_terminals") && values?.[2] === "ABORTED") aborted = true;
        if (sql === "COMMIT" && aborted) throw Object.assign(new Error("Synthetic lost reply"), { code: "ECONNRESET" });
        return result;
      };
    });
    const before = await createPostgresEventStore({ pool: pools.catalog }).readStream({
      streamId: `catalog.item-${f.catalogItemId}`,
    });
    // Model a reconciliation writer working inside an enclosing projection transaction.
    const projectedOwner = createProjectionAwarePool(pools.catalog);
    await expect(
      withPgTransaction(pools.catalog, (db) =>
        runInProjectionDbContext(db, async () => {
          const first = await f.categoryRequest("POST", consumer, projectedOwner);
          expect(first.ok).toBe(false);
          throw new Error("Synthetic projection rollback");
        }),
      ),
    ).rejects.toThrow("Synthetic projection rollback");
    expect(await affected.status()).toBe("ABORTED");
    const invalidation = async () =>
      (
        await pools.catalog.query<{ generation: string; status: string; affected_reservation_ids: string[] }>(
          "SELECT generation::text, status, affected_reservation_ids FROM event_owner_stream_invalidations WHERE owner_stream_id = $1",
          [f.catalogKey],
        )
      ).rows[0];
    const pending = await invalidation();
    expect(pending).toMatchObject({ status: "ABORT-REQUESTED", affected_reservation_ids: [affected.requestId] });
    expect(
      await createPostgresEventStore({ pool: pools.catalog }).readStream({
        streamId: `catalog.item-${f.catalogItemId}`,
      }),
    ).toEqual(before);
    expect((await f.categoryRequest("POST")).status).toBe(201);
    expect(await invalidation()).toEqual({ ...pending, status: "APPLIED" });
    expect(await affected.status()).toBe("ABORTED");
  });

  it("keeps the Listing expected version independent of a settled terminal", async () => {
    const f = fixture();
    const listing = await f.createFixtureListing("native");
    const key = ownerPredicateKey("repricing-listing", listing.listingId);
    const terminal = await prepare(pools.marketplace, key, f.context);
    await terminal.commit();
    const listings = f.marketplaceServices().listings;
    await listings.commandHandler({
      streamId: `marketplace.listing-${listing.listingId}`,
      context: f.context,
      command: {
        type: "UpdateListingPurchaseLimits",
        purchaseLimits: { maxUnitsPerOrder: 1, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
      },
    });
    await expect(
      listings.withdrawListing(
        {
          accountId: f.accountId,
          listingId: listing.listingId,
          expectedVersion: listing.version,
          idempotencyKey: "synthetic-stale-withdrawal",
        },
        f.context,
      ),
    ).rejects.toThrow();
    expect(await terminal.status()).toBe("COMMITTED");
    expect((await listings.loadListingState(listing.listingId)).status).not.toBe("withdrawn");
  });

  const writerKinds = [
    "Marketplace single",
    "Marketplace atomic",
    "Marketplace independent bulk",
    "Marketplace transaction alias",
    "Catalog normal",
    "Catalog promotion",
    "Inventory stock",
    "Pricing configuration",
    "Product freeze",
    "platform policy",
  ] as const;

  async function writer(kind: (typeof writerKinds)[number]) {
    const f = fixture();
    const pricing = (db: PgTransactionalPool) =>
      pricingModule.createServices(db, {
        commercialTermsResolver: terms,
        channelConnectionIdentityReader: { resolve: async () => null },
        pricingPredicateConsumerPool: pools.marketplace,
      });
    switch (kind) {
      case "Marketplace single": {
        const { listingId } = await f.createFixtureListing();
        return {
          owner: pools.marketplace,
          key: ownerPredicateKey("repricing-listing", listingId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            await f.marketplaceServices(db).listings.commandHandler({
              streamId: `marketplace.listing-${listingId}`,
              context: f.context,
              command: { type: "WithdrawListing" },
            });
            expect((await f.marketplaceServices().listings.loadListingState(listingId)).status).toBe("withdrawn");
          },
        };
      }
      case "Marketplace atomic": {
        const listingId = createId("lst");
        return {
          owner: pools.marketplace,
          key: ownerPredicateKey("repricing-listing", listingId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect(await f.createFixtureListing("channel-only", db, listingId)).toMatchObject({
              listingId,
              version: 1,
            });
          },
        };
      }
      case "Marketplace transaction alias": {
        const importRowId = `imr_synthetic_${createId("evt").slice(4)}`;
        const listingId = importRowId.replace(/^imr_/, "lst_");
        await f.mirrorProductMeasure();
        return {
          owner: pools.marketplace,
          key: ownerPredicateKey("repricing-listing", listingId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            const receipt = await f.marketplaceServices(db).inventoryDraftListingConsumer.accept(
              {
                schemaVersion: "inventory-draft-listing/v1",
                messageId: importRowId,
                authority: {
                  accountId: f.accountId,
                  tenantId: f.context.tenantId,
                  performedByUserId: f.context.audit.performedByUserId,
                },
                snapshot: {
                  importBatchId: "imb_synthetic",
                  importRowId,
                  committedAt: now,
                  inventoryItemId: f.itemId,
                  catalogItemId: f.catalogItemId,
                  productId: f.productId,
                  selectedOptions: [],
                  storageLocationId: createId("loc"),
                  storageLocationName: "Synthetic",
                  shipFromCode: "60601",
                  shipFromAddress,
                  totalQuantity: 2,
                  acquisitionCostAmount: null,
                  priceAmount: "10.00",
                  priceCurrencyCode: "USD",
                  quantityCap: 1,
                },
              },
              f.context,
            );
            expect(receipt.listingId).toBe(listingId);
          },
        };
      }
      case "Marketplace independent bulk": {
        const { listingId } = await f.createFixtureListing("native");
        return {
          owner: pools.marketplace,
          key: ownerPredicateKey("repricing-listing", listingId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect(
              await f.marketplaceServices(db).listings.applyBulkListingPriceUpdates(
                {
                  accountId: f.accountId,
                  updates: [
                    {
                      listingId,
                      priceAmount: "12.00",
                      priceCurrencyCode: "USD",
                      idempotencyKey: `repricing:synthetic:product:${listingId}:price`,
                    },
                  ],
                },
                f.context,
              ),
            ).toMatchObject([{ listingId, outcome: "applied" }]);
          },
        };
      }
      case "Catalog normal":
      case "Catalog promotion": {
        await f.createCatalogItem();
        return {
          owner: pools.catalog,
          key: f.catalogKey,
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            if (kind === "Catalog normal")
              expect((await f.categoryRequest("POST", pools.marketplace, db)).status).toBe(201);
            else
              expect(
                (
                  await assignSyntheticPromotionCategory(
                    db,
                    pools.marketplace,
                    f.catalogItemId,
                    f.categoryId,
                    f.context,
                  )
                ).state.categoryIds,
              ).toContain(f.categoryId);
          },
        };
      }
      case "Inventory stock": {
        await f.createInventoryStorage();
        return {
          owner: pools.inventory,
          key: ownerPredicateKey("repricing-stock", f.accountId, f.itemId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect((await f.createInventoryItem(db)).state.totalQuantity).toBe(10);
          },
        };
      }
      case "Pricing configuration":
        return {
          owner: pools.pricing,
          key: ownerPredicateKey("repricing-account", f.accountId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect(
              await pricing(db).repricingPolicies.setHalt(f.accountId, true, f.context, "synthetic-engage"),
            ).toMatchObject({ status: "applied" });
          },
        };
      case "Product freeze": {
        const policy = { ...repricingEnginePolicy.defaultValue, spiralBreakerRounds: 2 };
        const product = { catalogItemId: f.catalogItemId, productId: f.productId };
        await recordProductRoundDirection(pools.pricing, product, "down", policy, now, pools.marketplace);
        return {
          owner: pools.pricing,
          key: ownerPredicateKey("repricing-product-freeze", f.catalogItemId, f.productId),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect(
              await recordProductRoundDirection(db, product, "down", policy, now, pools.marketplace),
            ).toMatchObject({ roundCount: 2 });
            expect(activeProductFreeze(await readProductRoundState(pools.pricing, product), now)).not.toBeNull();
          },
        };
      }
      case "platform policy":
        return {
          owner: pools.pricing,
          key: ownerPredicateKey("repricing-platform-policy", repricingEnginePolicy.policyKey),
          context: f.context,
          write: async (db: PgTransactionalPool) => {
            expect(
              await pricing(db).policies.createPolicyDocumentWithId(
                repricingEnginePolicy,
                `synthetic-${f.accountId}`,
                {
                  status: "active",
                  value: repricingEnginePolicy.defaultValue,
                  effectiveFrom: now,
                  effectiveUntil: null,
                  actorUserId: f.context.audit.performedByUserId,
                },
                f.context,
              ),
            ).toMatchObject({ version: 1 });
          },
        };
    }
  }

  it.each(writerKinds)("detects omission of %s enrollment", async (kind) => {
    for (const omit of [false, true]) {
      const f = await writer(kind);
      const terminal = await prepare(f.owner, f.key, f.context);
      const owner = omit
        ? observedPool(f.owner, (db) => async <Row>(sql: string, values?: readonly unknown[]) => {
            if (
              sql.startsWith("SELECT reservation_id FROM event_owner_stream_reservations WHERE owner_stream_id") &&
              values?.[0] === f.key
            )
              return { rows: [] };
            return db.query<Row>(sql, values);
          })
        : f.owner;
      await f.write(owner);
      if (omit) {
        expect(await terminal.status()).toBe("OPEN");
        await terminal.commit();
      } else {
        expect(await terminal.status()).toBe("ABORTED");
        await expect(terminal.commit()).rejects.toThrow("already final");
      }
    }
  });
});
