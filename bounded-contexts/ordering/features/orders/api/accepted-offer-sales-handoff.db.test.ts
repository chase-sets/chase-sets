import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBoundedContextModule, type BcApiEntry } from "@chase-sets/bounded-context-module";
import { attachReadConsistencyMiddleware, bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createAccountUserTestRequestContext,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { compactSubscriptionApplicationLedger } from "../../../../../infrastructure/bounded-context-runtime/subscription-store";
import { getEventCommitMetadata, recordCommittedEvents, runWithEventCommitMetadata } from "@chase-sets/event-core";
import { globalPositionFromBigInt } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { Hono } from "hono";
import { module as orderingModule, contextManifest } from "../../../index";
import { buildOrderingApi, type OrderingApiEnv } from "../../../api";
import type { OrderingServices } from "../../../support/runtime-support/services";
import { context, productMeasureForCandidate, shipFromAddress, shippingAddress } from "./runtime-test-harness";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseUrl ? describe : describe.skip;
const seller = "acc_handoff_seller";
const reactionName = "ordering-marketplace-offer-acceptance";
const projectionName = "ordering-order-projection";
const sourceModule = defineBoundedContextModule({
  manifest: { contextName: "marketplace", apiBasePath: "/api/marketplace", streamPrefix: "marketplace." },
  schemaSql: "",
  createServices: () => ({}),
  buildApis: (): readonly BcApiEntry[] => [],
});

describeDb("accepted Offer to receipted Sales on independent stores", () => {
  let pools: Readonly<Record<"marketplace" | "ordering", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, ["marketplace", "ordering"], "offer_sales_handoff");
    expect(urls.marketplace).not.toBe(urls.ordering);
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(sourceModule, pools.marketplace);
    await bootstrapContextDatabase(orderingModule, pools.ordering);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function compose(poisonProjection = false) {
    const module = {
      ...orderingModule,
      createServices: (...args: Parameters<typeof orderingModule.createServices>) => {
        const services = orderingModule.createServices(...args);
        return {
          ...services,
          projectors: services.projectors.map((projection) =>
            projection.projectionName !== projectionName || !poisonProjection
              ? projection
              : {
                  ...projection,
                  handlers: {
                    ...projection.handlers,
                    "ordering.order.created": async (
                      ...handlerArgs: Parameters<NonNullable<(typeof projection.handlers)[string]>>
                    ) => {
                      await projection.handlers["ordering.order.created"]!(...handlerArgs);
                      throw new Error("test-only Order projection failure");
                    },
                  },
                },
          ),
        };
      },
    };
    const otherSources = [
      ...new Set([
        ...contextManifest.eventSubscriptions.map((subscription) => subscription.sourceContextName),
        ...contextManifest.eventReactions.map((reaction) => reaction.sourceContextName),
      ]),
    ].filter((name) => name !== "ordering");
    const runtime = createMountedContextTestRuntime([
      ...otherSources.map((contextName) => ({
        contextName,
        module: sourceModule,
        pool: pools.marketplace,
        ports: {},
        mountRole: "source-only" as const,
      })),
      {
        contextName: "ordering",
        module,
        pool: pools.ordering,
        ports: { inventoryCleanupAuthority: { kind: "not-mounted" as const } },
      },
    ]);
    const reaction = runtime.subscriptionRunners.find((runner) => runner.projectionName === reactionName)!;
    const projection = runtime.subscriptionRunners.find((runner) => runner.projectionName === projectionName)!;
    expect(reaction).toBeDefined();
    expect(projection).toBeDefined();
    const services = runtime.mountedContexts.find((entry) => entry.contextName === "ordering")!
      .services as OrderingServices;
    const app = new Hono<OrderingApiEnv>();
    const actorContext = createAccountUserTestRequestContext({
      actor: { accountId: seller, permissions: ["orders.view"] },
    });
    app.use("*", async (c, next) => {
      c.set("actor", actorContext.actor);
      c.set("context", actorContext.context);
      await next();
    });
    attachReadConsistencyMiddleware(
      app,
      [
        {
          contextName: "ordering",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: orderingModule.apiMounts?.[0]?.readFreshnessRoutes,
        },
      ],
      runtime.projectionGroups,
      { timeoutMs: 0 },
    );
    app.route("/api/marketplace", buildOrderingApi(services));
    return { reaction, projection, app };
  }

  async function supply(suffix: string) {
    const candidate = {
      listingId: `lst_${suffix}`,
      sellerAccountId: seller,
      inventoryItemId: `inv_${suffix}`,
      catalogItemId: `cat_${suffix}`,
      productId: `cat_${suffix}::`,
      itemTitle: "Card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      storageLocationName: null,
      shipFromCode: "CHI",
      priceAmount: "150.00",
      availableQuantity: 10,
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    await pools.ordering.query(
      `INSERT INTO ordering_inventory_item_inputs (item_id, seller_account_id, catalog_catalog_item_id, product_id, total_quantity, updated_at, last_stream_version)
       VALUES ($1, $2, $3, $4, 10, now(), 1)`,
      [candidate.inventoryItemId, seller, candidate.catalogItemId, candidate.productId],
    );
    await pools.ordering.query(
      `INSERT INTO ordering_market_listing_inputs
       (listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id, item_title,
        ship_from_code, ship_from_address, product_measure_snapshot, price_amount, price_currency_code,
        listing_stream_version, marketplace_sales_fee_unit_amount, seller_net_unit_amount, terms_resolved_at,
        quantity_cap, max_units_per_day, max_units_per_customer_account, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Card', 'CHI', $6::jsonb, $7::jsonb, 150, 'USD', 1, 1, 149, now(), 10, 10, 10, 'active', now())`,
      [
        candidate.listingId,
        seller,
        candidate.inventoryItemId,
        candidate.catalogItemId,
        candidate.productId,
        JSON.stringify(shipFromAddress),
        JSON.stringify(productMeasureForCandidate(candidate)),
      ],
    );
    return {
      offerId: `off_${suffix}`,
      buyerAccountId: String(context.audit.forAccountId),
      sellerAccountId: seller,
      listingId: candidate.listingId,
      inventoryItemId: candidate.inventoryItemId,
      listingVersion: 1,
      catalogItemId: candidate.catalogItemId,
      productId: candidate.productId,
      itemTitle: "Card",
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      priceAmount: "150.00",
      priceCurrencyCode: "USD",
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "1.00",
      marketplaceSalesFeeCapAmount: null,
      marketplaceSalesFeeUnitAmount: "1.00",
      sellerNetUnitAmount: "149.00",
      shippingAllowancePercentageBps: 500,
      termsScheduleId: null,
      termsAgreementId: null,
      termsResolvedAt: "2026-09-01T00:00:00.000Z",
      feeQuoteFingerprint: "sha256:handoff-synthetic",
      listingEvidencePolicyId: null,
      listingEvidencePolicyVersion: null,
      listingEvidencePolicyHash: "sha256:handoff-synthetic",
      listingEvidenceSnapshot: {
        schemaVersion: 1,
        policyHash: "sha256:handoff-synthetic",
        snapshotHash: "sha256:handoff-synthetic",
        createdAt: "2026-09-01T00:00:00.000Z",
        evidence: [],
      },
      shippingDestinationSnapshot: shippingAddress,
      quantityRequested: 1,
      acceptedAt: "2026-09-01T00:00:00.000Z",
    };
  }

  async function cap(value: number) {
    await pools.ordering.query(
      `INSERT INTO ordering_seller_order_capacity_inputs (seller_account_id, max_open_orders, updated_at)
       VALUES ($1, $2, now()) ON CONFLICT (seller_account_id) DO UPDATE SET max_open_orders = EXCLUDED.max_open_orders`,
      [seller, value],
    );
  }

  async function filler(contextName: "marketplace" | "ordering", count: number, suffix: string) {
    if (count <= 0) return;
    await createPostgresEventStore({ pool: pools[contextName] }).appendToStream({
      streamId: `${contextName}.handoff-filler-${suffix}`,
      expectedVersion: "no_stream",
      context,
      events: Array.from({ length: count }, () => ({ eventType: `${contextName}.handoff-filler`, payload: {} })),
    });
  }

  async function head(contextName: "marketplace" | "ordering") {
    return Number(
      (
        await pools[contextName].query<{ position: string }>(
          "SELECT COALESCE(MAX(global_position), 0)::text AS position FROM event_store_events",
        )
      ).rows[0]!.position,
    );
  }

  async function accept(
    data: Awaited<ReturnType<typeof supply>> & { acceptanceBatchId?: string; acceptanceBatchSize?: number },
    relation: "above" | "equal",
  ) {
    // Position the next source acceptance against the next destination append, never edit a sequence.
    if (relation === "above")
      await filler(
        "marketplace",
        Math.max(0, (await head("ordering")) + 50 - (await head("marketplace"))),
        data.offerId,
      );
    else {
      const delta = (await head("marketplace")) - (await head("ordering"));
      if (delta > 0) await filler("ordering", delta, data.offerId);
      if (delta < 0) await filler("marketplace", -delta, data.offerId);
    }
    return runWithEventCommitMetadata(async () => {
      const events = await createPostgresEventStore({ pool: pools.marketplace }).appendToStream({
        streamId: `marketplace.offer-${data.offerId}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "marketplace.offer.accepted", payload: data }],
      });
      recordCommittedEvents(events);
      return getEventCommitMetadata().sources;
    });
  }

  function read(app: Hono<OrderingApiEnv>, sources: readonly SourceCommitPosition[]) {
    return app.request("/api/marketplace/account/sales", {
      headers: {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({ observedAtMs: Date.now(), sources }),
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "ordering",
      },
    });
  }

  async function assertOrder(response: Response, reference: string, lineCount = 1) {
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ source_type: "offer-acceptance", source_reference_id: reference });
    const lines = await pools.ordering.query("SELECT order_id FROM ordering_order_line_pages WHERE order_id = $1", [
      result.items[0].order_id,
    ]);
    expect(lines.rows).toHaveLength(lineCount);
  }

  async function assertRelation(
    sources: readonly SourceCommitPosition[],
    relation: "above" | "equal",
    reference: string,
  ) {
    const output = await pools.ordering.query<{ position: string }>(
      "SELECT global_position::text AS position FROM event_store_events WHERE event_type = 'ordering.order.created' AND payload->>'sourceReferenceId' = $1",
      [reference],
    );
    expect(output.rows).toHaveLength(1);
    const sourcePosition = BigInt(
      sources.find((source) => source.sourceContextName === "marketplace")!.maxGlobalPosition,
    );
    const destinationPosition = BigInt(output.rows[0]!.position);
    if (relation === "above") expect(sourcePosition).toBeGreaterThan(destinationPosition);
    else expect(sourcePosition).toBe(destinationPosition);
  }

  for (const relation of ["above", "equal"] as const) {
    it.each(["held", "reaction poison", "projection poison", "unrelated poison", "compacted"])(
      `${relation}: %s refuses stale Sales and recovers on the same receipt`,
      async (control) => {
        let runtime = compose(control === "projection poison" || control === "unrelated poison");
        if (control === "unrelated poison") {
          const earlier = await supply("earlier");
          const earlierReceipt = await accept(earlier, relation);
          await runtime.reaction.runOnce();
          await runtime.projection.runOnce();
          expect((await runtime.projection.refreshStatus()).poisonEventCount).toBe(1);
          expect(earlierReceipt).toHaveLength(1);
          runtime = compose();
        }
        const offer = await supply("subject");
        if (control === "reaction poison") {
          await cap(1);
          await pools.ordering.query(
            "INSERT INTO ordering_seller_open_order_claims (order_id, seller_account_id) VALUES ('ord_existing_capacity_claim', $1)",
            [seller],
          );
        }
        const receipt = await accept(offer, relation);
        await runtime.reaction.runOnce();
        if (control === "reaction poison") {
          const refused = await read(runtime.app, receipt);
          expect(refused.status).toBe(500);
          expect(await refused.json()).toMatchObject({
            error: { code: "internal_error", pending: [expect.objectContaining({ projectionName: reactionName })] },
          });
          await cap(10);
          await runtime.reaction.retryBlockedStream(`marketplace.offer-${offer.offerId}`);
        }
        if (control === "projection poison") {
          await runtime.projection.runOnce();
          const refused = await read(runtime.app, receipt);
          expect(refused.status).toBe(500);
          expect(await refused.json()).toMatchObject({
            error: { code: "internal_error", pending: [expect.objectContaining({ projectionName })] },
          });
          const order = await pools.ordering.query<{ stream_id: string }>(
            "SELECT stream_id FROM event_store_events WHERE event_type = 'ordering.order.created'",
          );
          runtime = compose();
          await runtime.projection.retryBlockedStream(order.rows[0]!.stream_id);
        } else {
          const held = await read(runtime.app, receipt);
          expect(held.status).toBe(503);
          expect(await held.json()).toMatchObject({ error: { code: "projection_freshness_timeout" } });
          await runtime.projection.runOnce();
        }
        await assertRelation(receipt, relation, offer.offerId);
        await assertOrder(await read(runtime.app, receipt), offer.offerId);
        if (control === "compacted") {
          await compactSubscriptionApplicationLedger(
            pools.ordering,
            runtime.reaction.checkpointKey,
            globalPositionFromBigInt(BigInt(receipt[0]!.maxGlobalPosition) + 10_001n),
          );
          const removed = await pools.ordering.query(
            "SELECT event_id FROM event_subscription_applications WHERE projection_key = $1",
            [runtime.reaction.checkpointKey],
          );
          expect(removed.rows).toHaveLength(0);
          const unknown = await read(runtime.app, receipt);
          expect(unknown.status).toBe(503);
          expect(await unknown.json()).toMatchObject({ error: { code: "projection_freshness_timeout" } });
        }
      },
    );
  }

  it("records no output for the first batch member; merged receipt waits, then replay preserves one two-line Order", async () => {
    const runtime = compose();
    const batch = { acceptanceBatchId: "batch_subject", acceptanceBatchSize: 2 };
    const first = await accept({ ...(await supply("first")), ...batch }, "above");
    await runtime.reaction.runOnce();
    const record = await pools.ordering.query<{ output_global_positions: string[] | null }>(
      "SELECT output_global_positions FROM event_subscription_applications WHERE projection_key = $1",
      [runtime.reaction.checkpointKey],
    );
    expect(record.rows).toEqual([{ output_global_positions: [] }]);
    const firstRead = await read(runtime.app, first);
    expect(firstRead.status).toBe(200);
    expect(await firstRead.json()).toMatchObject({ items: [], total: 0 });
    const second = await accept({ ...(await supply("second")), ...batch }, "above");
    await runtime.reaction.runOnce();
    const merged = [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: second[0]!.maxGlobalPosition,
        eventIds: [...first[0]!.eventIds, ...second[0]!.eventIds],
      },
    ];
    expect((await read(runtime.app, merged)).status).toBe(503);
    await runtime.projection.runOnce();
    await assertOrder(await read(runtime.app, merged), batch.acceptanceBatchId, 2);
    await runtime.reaction.reset();
    await runtime.reaction.runOnce();
    await assertOrder(await read(runtime.app, merged), batch.acceptanceBatchId, 2);
  });
});
