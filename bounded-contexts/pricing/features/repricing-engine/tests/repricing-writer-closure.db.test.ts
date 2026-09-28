import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresEventStore,
  eventCorePostgresSchemaSql,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  createMultiContextTestPools,
  resetMultiContextTestSchemas,
  closeMultiContextTestPools,
} from "@chase-sets/bounded-context-runtime/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as pricingModule } from "../../../index";
import { createPricingServices, type PricingHostPorts } from "../../../support/runtime-support/services";
import { fixture } from "./listing-authority-fixture";
import { createPricingProductRoundAuthority } from "../api/listing-authority-product-state";
import { createPricingEvaluationBudget } from "../api/listing-authority-sql";
import { readPricingAuthorityInputs } from "../api/listing-authority-inputs";
import { repricingEnginePolicy, decodeRepricingEnginePolicyValue } from "../domain/policy";
import { buildPricingMarketplaceInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { buildRepricingPolicyProjectionHandlers } from "../../repricing-policies/read-model/projection";
import { buildPricingMarketEstimateProjectionHandlers } from "../../market-estimates/read-model/projection";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Writer closure SQL proof requires TEST_DATABASE_URL; it cannot be skipped.");
const contexts = ["pricing", "marketplace"] as const;

describe("Pricing writer closure through production composition", () => {
  let pools: Readonly<Record<(typeof contexts)[number], PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, contexts, "pricing_writer_closure");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
    await pools.marketplace.query(eventCorePostgresSchemaSql);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function setup() {
    const sourceStore = createPostgresEventStore({ pool: pools.pricing });
    const consumerStore = createPostgresEventStore({ pool: pools.marketplace });
    const f = await fixture({
      sourceStore,
      consumerStore,
      db: pools.pricing,
      budget: createPricingEvaluationBudget(pools.pricing),
    });
    const ports: PricingHostPorts = {
      tcgplayerMarketTransport: { kind: "not-mounted" },
      tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
      commercialTermsResolver: createNoopCommercialTermsResolver(),
      channelConnectionIdentityReader: { resolve: async () => null },
      pricingListingAuthorityConsumer: () => f.fence.forParticipant("pricing"),
    };
    const services = createPricingServices(pools.pricing, ports);
    const market = buildPricingMarketplaceInputProjectionHandlers(pools.pricing);
    for (const event of await f.external.readAll()) await market[event.eventType]?.(toTransportEvent(event));
    const projections = {
      ...buildRepricingPolicyProjectionHandlers(pools.pricing),
      ...buildPricingMarketEstimateProjectionHandlers(pools.pricing),
    };
    for (const event of await sourceStore.readAll()) await projections[event.eventType]?.(toTransportEvent(event));
    return { ...f, services, ports, sourceStore, consumerStore };
  }

  it("fails closed before constructing services without the consumer resolver", () => {
    expect(() =>
      createPricingServices(pools.pricing, {
        tcgplayerMarketTransport: { kind: "not-mounted" },
        tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
        commercialTermsResolver: createNoopCommercialTermsResolver(),
        channelConnectionIdentityReader: { resolve: async () => null },
      } as unknown as PricingHostPorts),
    ).toThrow("consumer resolver host port");
  });

  it("records the controller discriminator's threshold conflict without changing launch semantics", () => {
    expect(() =>
      decodeRepricingEnginePolicyValue({ ...repricingEnginePolicy.defaultValue, spiralBreakerRounds: 1 }),
    ).toThrow("spiralBreakerRounds must be between 2 and 10");
  });

  for (const guarded of [true, false]) {
    it(`${guarded ? "guarded source" : "production worker"} Product writer fences a retained consumer append`, async () => {
      const f = await setup();
      const at = new Date().toISOString();
      const product = { catalogItemId: f.request.catalogItemId, productId: f.request.productId };
      const productRounds = createPricingProductRoundAuthority(pools.pricing, f.services.listingAuthority.source);
      // The unchanged production decoder requires 2..10 rounds. Two prior up rounds make this next round trip
      // under the unchanged default of three; FINAL's requested value 1 is separately reported as a blocker.
      for (let index = 0; index < 2; index++)
        await productRounds.record(
          product,
          "up",
          repricingEnginePolicy.defaultValue,
          at,
          `synthetic-prior-${index}`,
          f.context,
        );
      const refreshed = await f.services.listingAuthority.evaluate(
        { ...f.request, evaluationId: "synthetic-after-prior-rounds" },
        f.context,
      );
      const operation = await f.fence.open(
        { ...f.input, command: { ...f.input.command, decision: refreshed.decision } },
        f.context,
      );
      const grant = await f.services.listingAuthority.source.prepare(operation, f.context);
      const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
      const business = {
        streamId: "marketplace.synthetic-r14-pricing-business",
        expectedVersion: 0 as const,
        context: f.context,
        events: [{ eventType: "marketplace.synthetic-r14-pricing-business", payload: {} }],
      };
      const before = Number(
        (
          await pools.pricing.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pricing_authority_sql_mutations WHERE mutation_id LIKE 'direction-%'",
          )
        ).rows[0]!.count,
      );
      if (guarded)
        await productRounds.record(
          product,
          "up",
          repricingEnginePolicy.defaultValue,
          at,
          "synthetic-r14-round",
          f.context,
        );
      else {
        await f.services.repricingEngine.enqueueMarketPriceSignal({
          ...product,
          amount: "12.00",
          previousAmount: "11.00",
          trigger: {
            kind: "market-price-estimated",
            eventId: "synthetic-r14-round",
            signalVersion: "1",
            occurredAt: at,
          },
          context: f.context,
        });
        expect(
          await f.services.repricingEngine.processNextEvaluationJob({
            claimOwnerId: "synthetic-writer-proof",
            claimTtlMs: 30_000,
            marketplaceGatewayForAccount: () => ({
              pauseListing: async () => {
                throw new Error("Unexpected pause");
              },
              publishListing: async () => {
                throw new Error("Unexpected publish");
              },
              applyBulkListingPriceUpdates: async ({ updates }) => {
                expect(
                  (
                    await pools.pricing.query(
                      "SELECT 1 FROM pg_locks WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND locktype = 'advisory'",
                    )
                  ).rows,
                ).toHaveLength(0);
                expect((pools.pricing as unknown as { totalCount: number; idleCount: number }).totalCount).toBe(
                  (pools.pricing as unknown as { idleCount: number }).idleCount,
                );
                return { items: updates.map(({ listingId }) => ({ listingId, outcome: "applied" as const })) };
              },
            }),
          }),
        ).toBe(1);
      }
      const effects =
        Number(
          (
            await pools.pricing.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM pricing_authority_sql_mutations WHERE mutation_id LIKE 'direction-%'",
            )
          ).rows[0]!.count,
        ) - before;
      expect(effects).toBe(1);
      const state = (
        await pools.pricing.query<{ frozen_until: string | null }>(
          "SELECT frozen_until FROM pricing_repricing_product_round_cooldowns",
        )
      ).rows[0]!;
      expect(state.frozen_until).not.toBeNull();
      await expect(
        readPricingAuthorityInputs({ eventStore: f.sourceStore, db: pools.pricing }, f.request, at),
      ).rejects.toThrow("Spiral Breaker");
      await expect(f.consumerStore.appendToStreams!([...terminal, business])).rejects.toBeDefined();
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      expect(await f.consumerStore.readStream({ streamId: business.streamId })).toHaveLength(0);
    });
  }

  it("recovers prepared Product invalidation on restart using its own SQL cursor", async () => {
    const f = await setup();
    const operation = await f.fence.open(f.input, f.context);
    await f.services.listingAuthority.source.prepare(operation, f.context);
    const unavailable = createPricingServices(pools.pricing, {
      ...f.ports,
      pricingListingAuthorityConsumer: () => ({
        inspect: async () => {
          throw new Error("Synthetic remote unavailable");
        },
        invalidate: async () => {
          throw new Error("Synthetic remote unavailable");
        },
      }),
    });
    await expect(
      createPricingProductRoundAuthority(pools.pricing, unavailable.listingAuthority.source).record(
        { catalogItemId: f.request.catalogItemId, productId: f.request.productId },
        "up",
        repricingEnginePolicy.defaultValue,
        new Date().toISOString(),
        "synthetic-recovery",
        f.context,
      ),
    ).rejects.toThrow("unresolved");
    expect((await pools.pricing.query("SELECT * FROM pricing_repricing_product_round_cooldowns")).rows).toHaveLength(0);
    const restarted = createPricingServices(pools.pricing, f.ports);
    const result = await restarted.recoverListingAuthority();
    expect(result.find((entry) => entry.writer === "product")?.outcomes).toEqual([
      expect.objectContaining({ status: "resumed" }),
    ]);
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect(
      (await pools.pricing.query("SELECT same_direction_rounds FROM pricing_repricing_product_round_cooldowns")).rows,
    ).toEqual([{ same_direction_rounds: 1 }]);
    expect(
      (await pools.pricing.query("SELECT writer FROM pricing_authority_recovery_cursors ORDER BY writer")).rows,
    ).toEqual([{ writer: "activation" }, { writer: "event" }, { writer: "product" }]);
  });

  it("reclaims the same round after gateway success, retains failed admission without TTL, and records recovery", async () => {
    const f = await setup();
    // These setup evaluations have never granted a consumer. Isolate the interim worker budget path.
    await pools.pricing.query("DELETE FROM pricing_evaluation_budget_admissions");
    await pools.pricing.query("DELETE FROM pricing_repricing_daily_change_budgets");
    let crash = true;
    const failingPool: PgTransactionalPool = {
      query: pools.pricing.query.bind(pools.pricing),
      connect: async () => {
        const client = await pools.pricing.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (crash && sql.includes("SET same_direction_rounds")) {
              crash = false;
              throw new Error("Synthetic crash after gateway before direction");
            }
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    const first = createPricingServices(failingPool, f.ports);
    const enqueue = (eventId: string) =>
      first.repricingEngine.enqueueMarketPriceSignal({
        catalogItemId: f.request.catalogItemId,
        productId: f.request.productId,
        amount: "12.00",
        previousAmount: "11.00",
        context: f.context,
        trigger: { kind: "market-price-estimated", eventId, signalVersion: "1", occurredAt: new Date().toISOString() },
      });
    let calls = 0;
    const run = (services: typeof first, claimOwnerId: string) =>
      services.repricingEngine.processNextEvaluationJob({
        claimOwnerId,
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => ({
          pauseListing: async () => {
            throw new Error("Unexpected pause");
          },
          publishListing: async () => {
            throw new Error("Unexpected publish");
          },
          applyBulkListingPriceUpdates: async ({ updates }) => {
            calls++;
            return { items: updates.map(({ listingId }) => ({ listingId, outcome: "applied" as const })) };
          },
        }),
      });
    await enqueue("synthetic-crashed-round");
    await expect(run(first, "synthetic-before-crash")).rejects.toThrow("unresolved");
    expect(calls).toBe(1);
    const pending = await pools.pricing.query<{ payload: { intent: { mutationId: string } } }>(
      "SELECT payload FROM event_store_events WHERE event_type = 'pricing.listing-authority.invalidation-started' AND payload->'intent'->>'mutationId' LIKE 'direction-%'",
    );
    expect(pending.rows).toHaveLength(1);
    const mutationId = pending.rows[0]!.payload.intent.mutationId;
    const before = (await pools.pricing.query("SELECT changes_reserved FROM pricing_repricing_daily_change_budgets"))
      .rows;
    expect(before).toEqual([{ changes_reserved: 1 }]);
    expect((await pools.pricing.query("SELECT * FROM pricing_evaluation_budget_admissions")).rows).toHaveLength(0);
    await pools.pricing.query(
      "UPDATE pricing_repricing_round_admissions SET admitted_at = now() - interval '10 years'",
    );
    await enqueue("synthetic-contending-round");
    const restarted = createPricingServices(pools.pricing, f.ports);
    expect(await run(restarted, "synthetic-contender")).toBe(0);
    expect(calls).toBe(1);
    expect(
      (await pools.pricing.query("SELECT changes_reserved FROM pricing_repricing_daily_change_budgets")).rows,
    ).toEqual(before);
    expect((await pools.pricing.query("SELECT status FROM pricing_repricing_round_admissions")).rows).toEqual([
      { status: "active" },
    ]);
    expect((await pools.pricing.query("SELECT * FROM pricing_repricing_product_round_cooldowns")).rows).toHaveLength(0);
    expect(
      await restarted.repricingEngine.resumeFailedRound(
        "repricing-evaluation:synthetic-crashed-round",
        "Synthetic operator-recorded recovery",
      ),
    ).toBe(true);
    expect(await run(restarted, "synthetic-resumed-round")).toBe(1);
    expect(calls).toBe(1);
    expect(
      (
        await pools.pricing.query(
          "SELECT mutation_id FROM pricing_authority_sql_mutations WHERE mutation_id LIKE 'direction-%'",
        )
      ).rows,
    ).toEqual([{ mutation_id: mutationId }]);
    expect(
      (await pools.pricing.query("SELECT same_direction_rounds FROM pricing_repricing_product_round_cooldowns")).rows,
    ).toEqual([{ same_direction_rounds: 1 }]);
    expect(
      (await pools.pricing.query("SELECT changes_reserved FROM pricing_repricing_daily_change_budgets")).rows,
    ).toEqual(before);
    expect(
      (await pools.pricing.query("SELECT status, closure_reason FROM pricing_repricing_round_admissions")).rows,
    ).toEqual([{ status: "completed", closure_reason: "Synthetic operator-recorded recovery" }]);
  });
});
