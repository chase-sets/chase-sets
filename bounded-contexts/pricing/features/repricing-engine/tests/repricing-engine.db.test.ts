import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { RepricingPolicyId } from "@chase-sets/primitives/typed-ids";
import { module as pricingModule } from "../../../index";
import { buildPricingMarketplaceInputProjectionHandlers } from "../../recommendations/integrations/source/source-projection";
import { buildRepricingPolicyProjectionHandlers } from "../../repricing-policies/read-model/projection";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import type { RepricingPolicyEvaluatedEvent, RepricingPolicyListingTrace } from "../domain/fact";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE, repricingEnginePolicy } from "../domain/policy";
import {
  readProductRoundState,
  recordProductRoundDirection,
  reserveProductRoundCooldown,
} from "../read-model/product-round-state";
import { pricingRepricingEngineSchemaMigrations } from "../read-model/schema";
import { createRepricingEngineRuntime, type RepricingMarketplaceGateway } from "../api/runtime";
import { buildRepricingEvaluationProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["pricing"] as const;

function event(type: string, data: Record<string, unknown>, streamId: string, streamVersion: number) {
  return {
    type,
    streamId,
    streamVersion,
    data,
    timing: { recordedAt: "2026-07-17T12:00:00.000Z" },
  } as never;
}

const context = {
  tenantId: "ten_1" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_seller" as never },
};

const defaultRule: RepricingRule = {
  conditions: [],
  directive: {
    currencyCode: "USD",
    anchorChain: [{ source: "lowest-competing-ask" }, { source: "market-estimate" }],
    offset: { mode: "absolute", amount: "-0.01" },
    floor: { mode: "absolute", amount: "5.00" },
    ceiling: null,
    tolerance: { mode: "absolute", amount: "0.25" },
    rounding: { mode: "none" },
    maxMovePercent: null,
    terminal: { kind: "hold" },
  },
};

describeDb("pricing signal-reactive repricing engine (#4331)", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "pricing_repricing_engine");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.pricing.query(pricingModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });
  afterEach(() => vi.useRealTimers());

  async function seedRound(
    pool: PgTransactionalPool,
    input: Readonly<{
      listingPrices: readonly string[];
      maxChangesPerDay?: number;
      policyId?: RepricingPolicyId;
      rule?: RepricingRule;
      product?: Readonly<{ catalogItemId: string; productId: string }>;
      listingPrefix?: string;
    }>,
  ) {
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    const policyId = input.policyId ?? "rpp_1";
    const seededProduct = input.product ?? { catalogItemId: "cat_1", productId: "cat_1::" };
    const listingIds = input.listingPrices.map((_, index) => `${input.listingPrefix ?? "lst_policy"}_${index + 1}`);
    for (const [index, priceAmount] of input.listingPrices.entries()) {
      const listingId = listingIds[index]!;
      await listingHandlers["marketplace.listing.created"]!(
        event(
          "marketplace.listing.created",
          {
            listingId,
            accountId: "acc_seller",
            ...seededProduct,
            priceAmount,
            priceCurrencyCode: "USD",
            quantityCap: 1,
          },
          `marketplace.listing-${listingId}`,
          1,
        ),
      );
      await listingHandlers["marketplace.listing.published"]!(
        event("marketplace.listing.published", {}, `marketplace.listing-${listingId}`, 2),
      );
    }
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_competitor",
          accountId: "acc_competitor",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        },
        "marketplace.listing-lst_competitor",
        1,
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-lst_competitor", 2),
    );

    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    const policies = createRepricingPolicyRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const created = await policies.commandHandler({
      streamId: policies.streamIdForPolicy(policyId),
      context,
      command: {
        type: "CreateRepricingPolicy",
        policyId,
        accountId: "acc_seller",
        name: "Reactive",
        scope: { kind: "listing-set", listingIds },
        excludedListingIds: [],
        rules: [input.rule ?? defaultRule],
        maxChangesPerDay: input.maxChangesPerDay ?? 100,
        createdAt: "2026-07-17T11:00:00.000Z",
      },
    });
    for (const stored of created.storedEvents) {
      await policyHandlers[stored.eventType]!(toTransportEvent(stored));
    }
    await pool.query(
      `INSERT INTO pricing_market_price_estimates (
         catalog_catalog_item_id, product_id, estimate_version,
         window_started_at, window_ended_at, amount, currency_code,
         band_low_amount, band_high_amount, confidence,
         platform_verified_trade_count, platform_trade_count, external_comp_count,
         previous_amount, estimated_at, fresh_until, disclosure, updated_at
       ) VALUES (
         $1, $2, 2,
         '2026-07-01T00:00:00.000Z', '2026-07-17T12:00:00.000Z', '11.00', 'usd',
         '10.00', '12.00', 'medium', 3, 5, 0,
         '10.00', '2026-07-17T12:00:00.000Z', '2026-07-18T12:00:00.000Z', 'account',
         '2026-07-17T12:00:00.000Z'
       )`,
      [seededProduct.catalogItemId, seededProduct.productId],
    );
    return { listingIds, policyId };
  }

  function gateway(outcomeForListing: (listingId: string) => "applied" | "no_op" | "conflict" | "error") {
    const calls: Array<
      readonly { listingId: string; priceAmount: string; priceCurrencyCode: string; expectedVersion: number }[]
    > = [];
    const pauseCalls: string[] = [];
    const publishCalls: string[] = [];
    const value: RepricingMarketplaceGateway & {
      calls: typeof calls;
      pauseCalls: typeof pauseCalls;
      publishCalls: typeof publishCalls;
    } = {
      calls,
      pauseCalls,
      publishCalls,
      applyBulkListingPriceUpdates: async (body) => {
        calls.push(body.updates);
        return {
          items: body.updates.map((update) => ({
            listingId: update.listingId,
            outcome: outcomeForListing(update.listingId),
          })),
        };
      },
      pauseListing: async (listingId) => {
        pauseCalls.push(listingId);
      },
      publishListing: async (listingId) => {
        publishCalls.push(listingId);
      },
    };
    return value;
  }

  async function evaluationFacts(pool: PgTransactionalPool) {
    const eventStore = createPostgresEventStore({ pool });
    const events = await eventStore.readAll();
    return events.filter((stored) => stored.eventType === "pricing.repricing-policy.evaluated");
  }

  const product = { catalogItemId: "cat_1", productId: "cat_1::" };
  const launch = REPRICING_ENGINE_LAUNCH_POLICY_VALUE;
  const now = "2026-07-17T12:00:00.000Z";

  function signal(eventId: string) {
    return {
      ...product,
      amount: "11.00",
      previousAmount: "10.00",
      context,
      trigger: {
        kind: "market-price-estimated" as const,
        eventId,
        signalVersion: eventId,
        occurredAt: new Date().toISOString(),
      },
    };
  }

  function holdQuery(pool: PgTransactionalPool, matches: (sql: string) => boolean) {
    let resolveReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const updates: Array<number | null | undefined> = [];
    const db: PgTransactionalPool = {
      connect: pool.connect.bind(pool),
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await pool.query<Row>(sql, values);
        if (sql.includes("UPDATE pricing_repricing_product_round_cooldowns")) updates.push(result.rowCount);
        if (!held && matches(sql)) {
          held = true;
          resolveReached();
          await released;
        }
        return result;
      },
    };
    return { db, reached, release, updates };
  }

  it.each(["catalog", "product"] as const)(
    "serializes claimed product rounds through fact append while a different %s runs",
    async (differentKey) => {
      const now = new Date().toISOString();
      const pool = pools.pricing;
      const syntheticProduct = { catalogItemId: "cat_synthetic_f1", productId: "prd_synthetic_f1" };
      const otherProduct = {
        catalogItemId: differentKey === "catalog" ? "cat_synthetic_other" : syntheticProduct.catalogItemId,
        productId: differentKey === "product" ? "prd_synthetic_other" : syntheticProduct.productId,
      };
      const rule = {
        ...defaultRule,
        directive: { ...defaultRule.directive, anchorChain: [{ source: "market-estimate" as const }] },
      };
      const { listingIds } = await seedRound(pool, {
        product: syntheticProduct,
        policyId: "rpp_synthetic_f1" as RepricingPolicyId,
        listingPrefix: "lst_synthetic_f1",
        listingPrices: ["16.00", "17.00"],
        rule,
      });
      await seedRound(pool, {
        product: otherProduct,
        policyId: "rpp_synthetic_other" as RepricingPolicyId,
        listingPrefix: "lst_synthetic_other",
        listingPrices: ["16.00"],
        rule,
      });
      await pool.query("UPDATE pricing_market_price_estimates SET fresh_until = $1", [
        new Date(Date.now() + 86_400_000).toISOString(),
      ]);
      await recordProductRoundDirection(pool, syntheticProduct, "down", launch, now);
      await recordProductRoundDirection(pool, syntheticProduct, "down", launch, now);
      const precondition = holdQuery(
        pool,
        (sql) => sql.includes("SELECT EXISTS (") && sql.includes("FROM pricing_repricing_policies"),
      );
      const store = createPostgresEventStore({ pool });
      let appended!: () => void;
      let releaseAppend!: () => void;
      const factAppended = new Promise<void>((resolve) => {
        appended = resolve;
      });
      const appendReleased = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const winner = createRepricingEngineRuntime({
        db: precondition.db,
        eventStore: {
          ...store,
          appendToStream: async (request) => {
            const result = await store.appendToStream(request);
            appended();
            await appendReleased;
            return result;
          },
        },
      });
      let waiterPid: number | undefined;
      let loserInputReads = 0;
      const loser = createRepricingEngineRuntime({
        eventStore: store,
        db: {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (sql.includes("FROM pricing_repricing_policy_assignments AS assignment")) loserInputReads += 1;
            return pool.query<Row>(sql, values);
          },
          connect: async () => {
            const client = await pool.connect();
            return {
              release: client.release.bind(client),
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                if (sql.includes("pg_advisory_lock(")) {
                  waiterPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                }
                return client.query<Row>(sql, values);
              },
            };
          },
        },
      });
      const other = createRepricingEngineRuntime({ db: pool, eventStore: store });
      const winnerGateway = gateway(() => "applied");
      const loserGateway = gateway(() => "applied");
      const otherGateway = gateway(() => "applied");
      const run = (runtime: typeof winner, name: string, value: RepricingMarketplaceGateway) =>
        runtime.processNextEvaluationJob({
          claimOwnerId: `worker:synthetic-f1-${name}`,
          claimTtlMs: 30_000,
          marketplaceGatewayForAccount: () => value,
        });
      await winner.enqueueMarketPriceSignal({ ...signal("evt_synthetic_f1_winner"), ...syntheticProduct });
      const winnerWork = run(winner, "winner", winnerGateway);
      let loserWork: Promise<number> | undefined;
      try {
        await precondition.reached;
        await loser.enqueueMarketPriceSignal({ ...signal("evt_synthetic_f1_loser"), ...syntheticProduct });
        loserWork = run(loser, "loser", loserGateway);
        await vi.waitFor(async () => {
          expect(waiterPid).toBeDefined();
          const waiting = await pool.query(
            "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted",
            [waiterPid],
          );
          expect(waiting.rows).toHaveLength(1);
        });
        const jobs = await pool.query(
          "SELECT claim_owner_id FROM pricing_repricing_evaluation_jobs WHERE status = 'running'",
        );
        expect(jobs.rows).toHaveLength(2);
        expect(loserInputReads).toBe(0);
        await other.enqueueMarketPriceSignal({ ...signal("evt_synthetic_f1_other"), ...otherProduct });
        expect(await run(other, "other", otherGateway)).toBe(1);
        expect(otherGateway.calls).toHaveLength(1);
        expect(winnerGateway.calls).toHaveLength(0);
        precondition.release();
        await factAppended;
        const frozen = await readProductRoundState(pool, syntheticProduct);
        expect(Date.parse(frozen!.frozen_until!)).toBeGreaterThan(Date.now());
        expect(
          (
            await pool.query(
              "SELECT frozen_until > clock_timestamp() AS future FROM pricing_repricing_product_round_cooldowns WHERE catalog_catalog_item_id = $1 AND product_id = $2",
              [syntheticProduct.catalogItemId, syntheticProduct.productId],
            )
          ).rows,
        ).toEqual([{ future: true }]);
        expect(frozen!.same_direction_rounds).toBe(0);
        expect(loserInputReads).toBe(0);
        expect(loserGateway.calls).toHaveLength(0);
        releaseAppend();
        expect(await winnerWork).toBe(1);
        expect(await loserWork).toBe(1);
        expect(winnerGateway.calls).toHaveLength(1);
        expect(loserGateway.calls).toHaveLength(0);
        expect(loserGateway.pauseCalls).toHaveLength(0);
        expect(loserGateway.publishCalls).toHaveLength(0);
        const facts = (await evaluationFacts(pool)).map(
          ({ payload }) => payload as RepricingPolicyEvaluatedEvent["data"],
        );
        const winningFact = facts.find((fact) => fact.trigger.eventId === "evt_synthetic_f1_winner")!;
        const losingFact = facts.find((fact) => fact.trigger.eventId === "evt_synthetic_f1_loser")!;
        expect(winningFact.spiralBreaker?.tripped).toBe(true);
        expect(losingFact.listings).toHaveLength(listingIds.length);
        for (const trace of losingFact.listings) {
          expect(trace).toMatchObject({
            outcome: "skipped",
            skipReason: "spiral-breaker-frozen",
            frozenUntil: winningFact.spiralBreaker!.frozenUntil,
          });
        }
        expect(losingFact.spiralBreaker).toEqual({
          tripped: false,
          frozenUntil: winningFact.spiralBreaker!.frozenUntil,
        });
      } finally {
        precondition.release();
        releaseAppend();
        await Promise.allSettled([winnerWork, ...(loserWork ? [loserWork] : [])]);
      }
    },
  );

  it.each(["acquire", "input", "pause", "fact", "unlock", "input-and-unlock"] as const)(
    "releases the product lock and preserves the error after %s failure",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const pool = pools.pricing;
      const syntheticProduct = { catalogItemId: "cat_synthetic_failure", productId: "prd_synthetic_failure" };
      await seedRound(pool, {
        product: syntheticProduct,
        listingPrefix: "lst_synthetic_failure",
        listingPrices: ["16.00"],
        rule: {
          ...defaultRule,
          directive: {
            ...defaultRule.directive,
            anchorChain: [{ source: "market-estimate" }],
            terminal: { kind: "pause", reason: "Synthetic unavailable input." },
          },
        },
      });
      if (failure === "pause") await pool.query("DELETE FROM pricing_market_price_estimates");
      const originalError = new Error(`synthetic ${failure} failure`);
      const cleanupError = new Error("synthetic unlock failure");
      const store = createPostgresEventStore({ pool });
      const released = vi.fn();
      let lockPid: number | undefined;
      const runtime = createRepricingEngineRuntime({
        eventStore: {
          ...store,
          appendToStream: async (request) => {
            if (failure === "fact") throw originalError;
            return store.appendToStream(request);
          },
        },
        db: {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (
              (failure === "input" || failure === "input-and-unlock") &&
              sql.includes("FROM pricing_repricing_policy_assignments AS assignment")
            )
              throw originalError;
            return pool.query<Row>(sql, values);
          },
          connect: async () => {
            const client = await pool.connect();
            let lockSession = false;
            return {
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                if (sql.includes("pg_advisory_lock(")) {
                  lockSession = true;
                  lockPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                  if (failure === "acquire") throw originalError;
                }
                if (sql.includes("pg_advisory_unlock(")) {
                  if (failure === "unlock") throw originalError;
                  if (failure === "input-and-unlock") throw cleanupError;
                }
                return client.query<Row>(sql, values);
              },
              release: (error?: unknown) => {
                if (lockSession) released(error);
                client.release(error);
              },
            };
          },
        },
      });
      const failingGateway = {
        ...gateway(() => "applied"),
        pauseListing: async () => {
          throw originalError;
        },
      };
      await runtime.enqueueMarketPriceSignal({ ...signal(`evt_synthetic_failure_${failure}`), ...syntheticProduct });
      await expect(
        runtime.processNextEvaluationJob({
          claimOwnerId: "worker:synthetic-failure",
          claimTtlMs: 30_000,
          marketplaceGatewayForAccount: () => failingGateway,
        }),
      ).rejects.toBe(originalError);
      expect(released).toHaveBeenCalledExactlyOnceWith(failure === "input-and-unlock" ? cleanupError : originalError);
      await vi.waitFor(async () => {
        expect(
          (await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'", [lockPid])).rows,
        ).toHaveLength(0);
      });
      const next = createRepricingEngineRuntime({ db: pool, eventStore: store });
      await next.enqueueMarketPriceSignal({ ...signal(`evt_synthetic_recovery_${failure}`), ...syntheticProduct });
      expect(
        await next.processNextEvaluationJob({
          claimOwnerId: "worker:synthetic-recovery",
          claimTtlMs: 30_000,
          marketplaceGatewayForAccount: () => gateway(() => "applied"),
        }),
      ).toBe(1);
    },
  );

  it.each(["cancelled", "lease-lost", "claim-expired"] as const)(
    "rejects %s work after product admission before inputs, Marketplace, state or facts",
    async (failure) => {
      const pool = pools.pricing;
      const syntheticProduct = { catalogItemId: "cat_synthetic_claim_fence", productId: "prd_synthetic_claim_fence" };
      const { listingIds } = await seedRound(pool, {
        product: syntheticProduct,
        listingPrefix: "lst_synthetic_claim_fence",
        listingPrices: ["16.00"],
        rule: {
          ...defaultRule,
          directive: { ...defaultRule.directive, anchorChain: [{ source: "market-estimate" }] },
        },
      });
      await pool.query("UPDATE pricing_market_price_estimates SET fresh_until = $1", [
        new Date(Date.now() + 86_400_000).toISOString(),
      ]);
      const store = createPostgresEventStore({ pool });
      const append = vi.fn(store.appendToStream);
      const afterAdmissionQueries: string[] = [];
      let admitted = false;
      let waiterPid: number | undefined;
      const runtime = createRepricingEngineRuntime({
        eventStore: { ...store, appendToStream: append },
        db: {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (admitted && !sql.includes("pricing_repricing_evaluation_jobs")) afterAdmissionQueries.push(sql);
            return pool.query<Row>(sql, values);
          },
          connect: async () => {
            const client = await pool.connect();
            return {
              release: client.release.bind(client),
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                if (sql.includes("pg_advisory_lock(")) {
                  waiterPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
                  const result = await client.query<Row>(sql, values);
                  admitted = true;
                  return result;
                }
                return client.query<Row>(sql, values);
              },
            };
          },
        },
      });
      await runtime.enqueueMarketPriceSignal({
        ...signal(`evt_synthetic_claim_fence_${failure}`),
        ...syntheticProduct,
      });
      const lockKey = JSON.stringify([
        "pricing:product-round",
        syntheticProduct.catalogItemId,
        syntheticProduct.productId,
      ]);
      const lockClient = await pool.connect();
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
      const controller = new AbortController();
      const leaseError = new Error("Synthetic platform runner lease lost.");
      let leaseLost = false;
      const staleGateway = gateway(() => "applied");
      const recoveryGateway = gateway(() => "applied");
      const work = runtime.processNextEvaluationJob({
        claimOwnerId: "worker:synthetic-stale-owner",
        claimTtlMs: failure === "claim-expired" ? 100 : 30_000,
        signal: controller.signal,
        throwIfLeaseLost: () => {
          if (leaseLost) throw leaseError;
        },
        marketplaceGatewayForAccount: () => staleGateway,
      });
      const outcome = work.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let recoveryWork: Promise<number> | undefined;
      try {
        await vi.waitFor(async () => {
          expect(waiterPid).toBeDefined();
          expect(
            (
              await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [
                waiterPid,
              ])
            ).rows,
          ).toHaveLength(1);
        });
        if (failure === "cancelled") controller.abort();
        if (failure === "lease-lost") leaseLost = true;
        if (failure === "claim-expired") {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          expect(
            (
              await pool.query(`SELECT claim_owner_id, claimed_until <= clock_timestamp() AS claim_expired,
                next_eligible_at <= clock_timestamp() AS retry_ready FROM pricing_repricing_evaluation_jobs`)
            ).rows,
          ).toEqual([{ claim_owner_id: "worker:synthetic-stale-owner", claim_expired: true, retry_ready: true }]);
          const recovery = createRepricingEngineRuntime({ db: pool, eventStore: store });
          recoveryWork = recovery.processNextEvaluationJob({
            claimOwnerId: "worker:synthetic-recovery-owner",
            claimTtlMs: 30_000,
            marketplaceGatewayForAccount: () => recoveryGateway,
          });
          await vi.waitFor(async () => {
            expect(
              (await pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows,
            ).toHaveLength(2);
          });
        }
        expect(admitted).toBe(false);
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
        const result = await outcome;
        expect(result.value).toBeUndefined();
        if (failure === "lease-lost") expect(result.error).toBe(leaseError);
        else
          expect(result.error).toMatchObject(
            failure === "cancelled"
              ? { message: "Repricing evaluation job was cancelled." }
              : { name: "RepricingEvaluationClaimLostError" },
          );
        expect(admitted).toBe(true);
        expect(afterAdmissionQueries).toEqual([]);
        expect(staleGateway.calls).toEqual([]);
        expect(staleGateway.pauseCalls).toEqual([]);
        expect(staleGateway.publishCalls).toEqual([]);
        expect(append).not.toHaveBeenCalled();
        if (recoveryWork) {
          expect(await recoveryWork).toBe(1);
          expect(recoveryGateway.calls).toHaveLength(1);
          expect(recoveryGateway.calls[0]!.map(({ listingId }) => listingId)).toEqual(listingIds);
          expect(
            (
              await pool.query(
                "SELECT status, claim_owner_id, attempt_count, result FROM pricing_repricing_evaluation_jobs",
              )
            ).rows,
          ).toEqual([
            expect.objectContaining({
              status: "completed",
              claim_owner_id: "worker:synthetic-recovery-owner",
              attempt_count: 2,
              result: expect.objectContaining({ listingsChanged: 1 }),
            }),
          ]);
        } else {
          expect(await evaluationFacts(pool)).toEqual([]);
          expect(await readProductRoundState(pool, syntheticProduct)).toBeNull();
        }
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock_all()");
        lockClient.release();
        await Promise.allSettled([outcome, ...(recoveryWork ? [recoveryWork] : [])]);
      }
    },
  );

  it.each(["complete", "fail-claim-lost", "fail-write-error"] as const)(
    "does not report stale terminal success or replace the operation error after %s",
    async (failure) => {
      const pool = pools.pricing;
      const originalError = new Error("Synthetic round input failure.");
      const cleanupError = new Error("Synthetic terminal persistence failure.");
      let terminalAttempted = false;
      const runtime = createRepricingEngineRuntime({
        eventStore: createPostgresEventStore({ pool }),
        db: {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (failure !== "complete" && sql.includes("FROM pricing_repricing_policy_assignments AS assignment")) {
              throw originalError;
            }
            return pool.query<Row>(sql, values);
          },
          connect: async () => {
            const client = await pool.connect();
            return {
              release: client.release.bind(client),
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                if (
                  sql.includes("WHERE job_id = $1") &&
                  (sql.includes("SET status = 'completed'") || sql.includes("SET status = 'failed'"))
                ) {
                  terminalAttempted = true;
                  if (failure === "fail-write-error") throw cleanupError;
                  await pool.query(
                    `UPDATE pricing_repricing_evaluation_jobs SET claim_owner_id = $1
                    WHERE job_id = $2 AND claim_owner_id = $3`,
                    ["worker:synthetic-terminal-recovery", values![0], "worker:synthetic-terminal-stale"],
                  );
                }
                return client.query<Row>(sql, values);
              },
            };
          },
        },
      });
      await runtime.enqueueMarketPriceSignal(signal(`evt_synthetic_terminal_${failure}`));
      const trip = vi.fn();
      const work = runtime.processNextEvaluationJob({
        claimOwnerId: "worker:synthetic-terminal-stale",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway(() => "applied"),
        onSpiralBreakerTrip: trip,
      });
      if (failure === "complete")
        await expect(work).rejects.toMatchObject({ name: "RepricingEvaluationClaimLostError" });
      else await expect(work).rejects.toBe(originalError);
      expect(terminalAttempted).toBe(true);
      expect(trip).not.toHaveBeenCalled();
      expect((await pool.query("SELECT status, result FROM pricing_repricing_evaluation_jobs")).rows).toEqual([
        { status: "running", result: null },
      ]);
    },
  );

  it.each(["down", "up"] as const)(
    "trips across sellers on three net %s rounds and retains routine state",
    async (direction) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const pool = pools.pricing;
      await seedRound(pool, {
        listingPrices: direction === "down" ? ["16.00", "10.00", "12.00"] : ["8.00", "13.00", "12.00"],
      });
      await pool.query(
        "UPDATE pricing_market_listing_inputs SET seller_account_id = 'acc_other' WHERE listing_id = 'lst_policy_2'",
      );
      const policies = createRepricingPolicyRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
      const created = await policies.commandHandler({
        streamId: policies.streamIdForPolicy("rpp_other"),
        context,
        command: {
          type: "CreateRepricingPolicy",
          policyId: "rpp_other",
          accountId: "acc_other",
          name: "Other seller",
          scope: { kind: "listing-set", listingIds: ["lst_policy_2"] },
          rules: [
            { ...defaultRule, directive: { ...defaultRule.directive, anchorChain: [{ source: "market-estimate" }] } },
          ],
          maxChangesPerDay: 100,
          createdAt: now,
        },
      });
      const handlers = buildRepricingPolicyProjectionHandlers(pool);
      for (const stored of created.storedEvents) await handlers[stored.eventType]!(toTransportEvent(stored));
      const runtime = createRepricingEngineRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
      const marketplace = gateway((id) => (id === "lst_policy_3" ? "no_op" : "applied"));
      const onSpiralBreakerTrip = vi.fn();
      expect(await readProductRoundState(pool, product)).toBeNull();
      for (let index = 1; index <= 3; index += 1) {
        expect(await runtime.enqueueMarketPriceSignal(signal(`evt_trip_${index}`))).toBe(true);
        expect(
          await runtime.processNextEvaluationJob({
            claimOwnerId: "worker:trip",
            claimTtlMs: 30_000,
            marketplaceGatewayForAccount: () => marketplace,
            onSpiralBreakerTrip,
          }),
        ).toBe(1);
        expect(await readProductRoundState(pool, product)).toMatchObject({
          same_direction_rounds: index === 3 ? 0 : index,
          last_direction: index === 3 ? null : direction,
        });
      }
      const frozenUntil = "2026-07-17T14:00:00.000Z";
      expect(onSpiralBreakerTrip).toHaveBeenCalledExactlyOnceWith({
        ...product,
        direction,
        roundCount: 3,
        affectedSellerCount: 2,
        frozenUntil,
      });
      const state = (await readProductRoundState(pool, product))!;
      expect(state.frozen_until).toBe(state.next_eligible_at);
      expect(new Date(state.frozen_until!).toISOString()).toBe(frozenUntil);
      const facts = await evaluationFacts(pool);
      const tripFacts = facts.filter(
        (stored) => (stored.payload as RepricingPolicyEvaluatedEvent["data"]).trigger.eventId === "evt_trip_3",
      );
      expect(tripFacts).toHaveLength(2);
      const projection = buildRepricingEvaluationProjectionHandlers(pool);
      for (const stored of tripFacts) {
        const data = stored.payload as RepricingPolicyEvaluatedEvent["data"];
        expect(data.spiralBreaker).toEqual({ tripped: true, frozenUntil });
        expect(data.listings.length).toBeGreaterThan(0);
        for (const trace of data.listings)
          expect(trace).toMatchObject({ flags: expect.arrayContaining(["spiral-breaker"]), frozenUntil });
        await projection[stored.eventType]!(toTransportEvent(stored));
      }
      const projected = await pool.query<{ listing_traces: RepricingPolicyListingTrace[] }>(
        "SELECT listing_traces FROM pricing_repricing_policy_evaluations",
      );
      expect(projected.rows.flatMap((row) => row.listing_traces)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ listingId: "lst_policy_3", outcome: "skipped", frozenUntil }),
        ]),
      );
      const jobs = await pool.query<{ result: { spiralBreakerTrips: unknown[] } }>(
        "SELECT result FROM pricing_repricing_evaluation_jobs WHERE job_id = 'repricing-evaluation:evt_trip_3'",
      );
      expect(jobs.rows[0]?.result.spiralBreakerTrips).toEqual([onSpiralBreakerTrip.mock.calls[0]![0]]);
    },
  );

  it.each(["opposite", "unchanged", "net-zero"] as const)(
    "resets the retained direction on an %s round",
    async (reset) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const pool = pools.pricing;
      await seedRound(pool, { listingPrices: ["16.00", "16.00"] });
      await pool.query("UPDATE pricing_repricing_policies SET rules = $1", [
        JSON.stringify([
          {
            ...defaultRule,
            directive: {
              ...defaultRule.directive,
              anchorChain: [{ source: "market-estimate" }],
              offset: { mode: "absolute", amount: "0.00" },
            },
          },
        ]),
      ]);
      const runtime = createRepricingEngineRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
      const onSpiralBreakerTrip = vi.fn();
      for (let round = 0; round < 4; round += 1) {
        const prices =
          round === 1
            ? reset === "opposite"
              ? ["8.00", "8.00"]
              : reset === "net-zero"
                ? ["10.00", "12.00"]
                : ["11.00", "11.00"]
            : ["16.00", "16.00"];
        await pool.query(
          "UPDATE pricing_market_listing_inputs SET price_amount = CASE listing_id WHEN 'lst_policy_1' THEN $1::numeric ELSE $2::numeric END WHERE listing_id LIKE 'lst_policy_%'",
          prices,
        );
        await runtime.enqueueMarketPriceSignal(signal(`evt_reset_${round}`));
        await runtime.processNextEvaluationJob({
          claimOwnerId: "worker:reset",
          claimTtlMs: 30_000,
          marketplaceGatewayForAccount: () => gateway(() => "applied"),
          onSpiralBreakerTrip,
        });
        if (round === 1)
          expect(await readProductRoundState(pool, product)).toMatchObject({
            same_direction_rounds: reset === "opposite" ? 1 : 0,
            last_direction: reset === "opposite" ? "up" : null,
          });
      }
      expect(onSpiralBreakerTrip).not.toHaveBeenCalled();
      expect(await readProductRoundState(pool, product)).toMatchObject({
        same_direction_rounds: 2,
        last_direction: "down",
        frozen_until: null,
      });
    },
  );

  it.each(["2026-07-17T14:00:00.000Z", "2026-07-18T14:00:00.000Z"])(
    "blocks every signal and cooling sweeps, then re-enters at %s from zero",
    async (releasedAt) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const pool = pools.pricing;
      await seedRound(pool, { listingPrices: ["16.00"] });
      const runtime = createRepricingEngineRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
      const ask = (id: string) => ({
        listingId: "lst_policy_1",
        trigger: { ...signal(id).trigger, kind: "competing-ask-changed" as const },
        context,
      });
      expect(await runtime.enqueueCompetingAskSignal(ask("evt_cooling"))).toBe(true);
      expect(await runtime.enqueueDailyDriftSweep({ now })).toBe(0);
      await pool.query("DELETE FROM pricing_repricing_evaluation_jobs");
      for (let index = 0; index < 3; index += 1) await recordProductRoundDirection(pool, product, "down", launch, now);
      const frozenState = await readProductRoundState(pool, product);
      expect(await runtime.enqueueMarketPriceSignal(signal("evt_frozen_market"))).toBe(false);
      expect(await runtime.enqueueCompetingAskSignal(ask("evt_frozen_ask"))).toBe(false);
      await pool.query("DELETE FROM pricing_repricing_daily_sweep_cursor");
      await pool.query("DELETE FROM pricing_repricing_evaluation_jobs");
      expect(await runtime.enqueueDailyDriftSweep({ now })).toBe(0);
      expect(await readProductRoundState(pool, product)).toEqual(frozenState);
      expect((await pool.query("SELECT job_id FROM pricing_repricing_evaluation_jobs")).rows).toEqual([]);
      vi.setSystemTime(releasedAt);
      expect(await readProductRoundState(pool, product)).toMatchObject({ same_direction_rounds: 0 });
      expect(await runtime.enqueueCompetingAskSignal(ask("evt_expiry_ask"))).toBe(true);
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:expiry",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway(() => "applied"),
      });
      expect(await readProductRoundState(pool, product)).toMatchObject({
        same_direction_rounds: 1,
        last_direction: "down",
        frozen_until: null,
      });
      vi.setSystemTime(new Date(Date.parse(releasedAt) + 60_000));
      expect(await runtime.enqueueMarketPriceSignal(signal("evt_day_after"))).toBe(true);
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:day-after",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => gateway(() => "applied"),
      });
      expect(await readProductRoundState(pool, product)).toMatchObject({
        same_direction_rounds: 2,
        last_direction: "down",
        frozen_until: null,
      });
    },
  );

  it.each(["price", "pause"] as const)(
    "rejects previously claimed %s work after a post-load freeze with zero Marketplace commands",
    async (action) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const pool = pools.pricing;
      await seedRound(pool, {
        listingPrices: ["16.00", "16.00"],
        ...(action === "pause"
          ? {
              rule: {
                ...defaultRule,
                directive: {
                  ...defaultRule.directive,
                  anchorChain: [{ source: "last-sold" }],
                  terminal: { kind: "pause", reason: "Required input unavailable." },
                },
              },
            }
          : {}),
      });
      const barrier = holdQuery(pool, (sql) => sql.includes("FROM pricing_repricing_policy_assignments AS assignment"));
      const runtime = createRepricingEngineRuntime({ db: barrier.db, eventStore: createPostgresEventStore({ pool }) });
      await runtime.enqueueMarketPriceSignal(signal("evt_claimed"));
      const marketplace = gateway(() => "applied");
      const work = runtime.processNextEvaluationJob({
        claimOwnerId: "worker:claimed",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      await barrier.reached;
      try {
        expect((await pool.query("SELECT status FROM pricing_repricing_evaluation_jobs")).rows).toEqual([
          { status: "running" },
        ]);
        for (let index = 0; index < 3; index += 1)
          await recordProductRoundDirection(pool, product, "down", launch, now);
      } finally {
        barrier.release();
      }
      await work;
      expect(marketplace.calls).toEqual([]);
      expect(marketplace.pauseCalls).toEqual([]);
      expect(marketplace.publishCalls).toEqual([]);
      const facts = await evaluationFacts(pool);
      expect(facts).toHaveLength(1);
      expect((facts[0]!.payload as RepricingPolicyEvaluatedEvent["data"]).listings).toEqual([
        expect.objectContaining({ skipReason: "spiral-breaker-frozen", outcome: "skipped" }),
        expect.objectContaining({ skipReason: "spiral-breaker-frozen", outcome: "skipped" }),
      ]);
    },
  );

  it("clears retained direction when a claimed product has no remaining assignments", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const pool = pools.pricing;
    await recordProductRoundDirection(pool, product, "down", launch, now);
    await recordProductRoundDirection(pool, product, "down", launch, now);
    const runtime = createRepricingEngineRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
    const marketplace = gateway(() => "applied");
    await runtime.enqueueMarketPriceSignal(signal("evt_unassigned"));
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:unassigned",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });
    expect(await readProductRoundState(pool, product)).toMatchObject({
      same_direction_rounds: 0,
      last_direction: null,
      frozen_until: null,
    });
    expect(marketplace.calls).toEqual([]);
    expect(await evaluationFacts(pool)).toEqual([]);
  });

  it.each(["same", "opposite", "undirected", "reservation", "freeze"] as const)(
    "fences a stale round against a newer %s ledger write",
    async (newer) => {
      const pool = pools.pricing;
      await recordProductRoundDirection(pool, product, "down", launch, now);
      const barrier = holdQuery(pool, (sql) => sql.startsWith("SELECT next_eligible_at::text"));
      const stale = recordProductRoundDirection(barrier.db, product, "down", launch, now);
      await barrier.reached;
      try {
        if (newer === "reservation")
          await reserveProductRoundCooldown(
            pool,
            { ...product, triggerEventId: "evt_newer", cooldownMinutes: 30 },
            now,
          );
        else {
          await recordProductRoundDirection(
            pool,
            product,
            newer === "opposite" ? "up" : newer === "undirected" ? null : "down",
            launch,
            now,
          );
          if (newer === "freeze") await recordProductRoundDirection(pool, product, "down", launch, now);
        }
      } finally {
        barrier.release();
      }
      const trip = await stale;
      expect(barrier.updates[0]).toBe(0);
      const state = (await readProductRoundState(pool, product))!;
      if (newer === "same" || newer === "freeze") {
        expect(state.same_direction_rounds).toBe(0);
        expect(new Date(state.frozen_until!).toISOString()).toBe("2026-07-17T14:00:00.000Z");
        expect(Boolean(trip)).toBe(newer === "same");
      } else {
        expect(state).toMatchObject({
          same_direction_rounds: newer === "reservation" ? 2 : 1,
          last_direction: "down",
          frozen_until: null,
        });
        if (newer === "reservation")
          expect(new Date(state.next_eligible_at).toISOString()).toBe("2026-07-17T12:30:00.000Z");
      }
    },
  );

  it("admits only one simultaneous first reservation and counts simultaneous first rounds without lost updates", async () => {
    const pool = pools.pricing;
    const admissions = await Promise.all(
      ["evt_first_a", "evt_first_b"].map((triggerEventId) =>
        reserveProductRoundCooldown(pool, { ...product, triggerEventId, cooldownMinutes: 30 }, now),
      ),
    );
    expect(admissions.sort()).toEqual([false, true]);
    const otherProduct = { ...product, productId: "cat_1::other" };
    const rounds = await Promise.all(
      [1, 2, 3].map(() => recordProductRoundDirection(pool, otherProduct, "up", launch, now)),
    );
    expect(rounds.filter(Boolean)).toEqual([
      { direction: "up", roundCount: 3, frozenUntil: "2026-07-17T14:00:00.000Z" },
    ]);
    expect(await readProductRoundState(pool, product)).toMatchObject({ same_direction_rounds: 0, frozen_until: null });
    expect(await readProductRoundState(pool, otherProduct)).toMatchObject({
      same_direction_rounds: 0,
      last_direction: null,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const runtime = createRepricingEngineRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
    expect(await runtime.enqueueMarketPriceSignal({ ...signal("evt_other_frozen"), ...otherProduct })).toBe(false);
    expect(await runtime.enqueueMarketPriceSignal(signal("evt_not_frozen"))).toBe(true);
  });

  it.each(["reservation", "freeze"] as const)(
    "fences a stale cooldown reservation against a newer %s",
    async (newer) => {
      const pool = pools.pricing;
      await recordProductRoundDirection(pool, product, "down", launch, now);
      const barrier = holdQuery(pool, (sql) => sql.startsWith("SELECT next_eligible_at::text"));
      const stale = reserveProductRoundCooldown(
        barrier.db,
        { ...product, triggerEventId: "evt_stale", cooldownMinutes: 30 },
        now,
      );
      await barrier.reached;
      try {
        if (newer === "reservation")
          await reserveProductRoundCooldown(
            pool,
            { ...product, triggerEventId: "evt_newer", cooldownMinutes: 30 },
            now,
          );
        else
          for (let index = 0; index < 2; index += 1)
            await recordProductRoundDirection(pool, product, "down", launch, now);
      } finally {
        barrier.release();
      }
      expect(await stale).toBe(false);
      expect(barrier.updates).toEqual([0]);
      const row = (
        await pool.query<{ last_trigger_event_id: string; same_direction_rounds: number }>(
          "SELECT last_trigger_event_id, same_direction_rounds FROM pricing_repricing_product_round_cooldowns",
        )
      ).rows[0]!;
      expect(row).toEqual({
        last_trigger_event_id: newer === "reservation" ? "evt_newer" : "",
        same_direction_rounds: newer === "reservation" ? 1 : 0,
      });
    },
  );

  it.each(["boot-first", "ledger-first"])(
    "upgrades a retained ledger %s, twice, without losing the cooldown",
    async (order) => {
      const pool = pools.pricing;
      await pool.query(
        "ALTER TABLE pricing_repricing_product_round_cooldowns DROP COLUMN same_direction_rounds, DROP COLUMN last_direction, DROP COLUMN frozen_until, DROP COLUMN tripped_at",
      );
      await pool.query(
        "INSERT INTO pricing_repricing_product_round_cooldowns VALUES ('cat_1', 'cat_1::', $1, 'evt_retained', $1)",
        [now],
      );
      if (order === "ledger-first") {
        for (const statement of pricingRepricingEngineSchemaMigrations[0]!.statements) await pool.query(statement);
      } else await pool.query(pricingModule.schemaSql);
      expect(await readProductRoundState(pool, product)).toMatchObject({
        same_direction_rounds: 0,
        last_direction: null,
        frozen_until: null,
      });
      const shape = await pool.query(`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'pricing_repricing_product_round_cooldowns'
      AND column_name IN ('same_direction_rounds', 'last_direction', 'frozen_until', 'tripped_at') ORDER BY column_name`);
      expect(shape.rows).toEqual([
        {
          column_name: "frozen_until",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
          column_default: null,
        },
        { column_name: "last_direction", data_type: "text", is_nullable: "YES", column_default: null },
        { column_name: "same_direction_rounds", data_type: "integer", is_nullable: "NO", column_default: "0" },
        { column_name: "tripped_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      ]);
      await bootstrapContextDatabase(pricingModule, pool);
      await bootstrapContextDatabase(pricingModule, pool);
      expect(
        (
          await pool.query(
            "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = '20260914_pricing_repricing_spiral_breaker'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (await pool.query("SELECT last_trigger_event_id FROM pricing_repricing_product_round_cooldowns")).rows,
      ).toEqual([{ last_trigger_event_id: "evt_retained" }]);
      await expect(
        pool.query("UPDATE pricing_repricing_product_round_cooldowns SET last_direction = 'sideways'"),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );

  it("resolves a real stored policy revision without the two new keys", async () => {
    const pool = pools.pricing;
    const { spiralBreakerRounds: _rounds, spiralBreakerFreezeMinutes: _minutes, ...stored } = launch;
    await pool.query(
      `INSERT INTO platform_policy_documents (document_id, policy_key, context_name, schema_summary, status, value, effective_from, created_at, updated_at)
      VALUES ('synthetic-old-repricing-revision', 'pricing.repricing-engine', 'pricing', 'old revision', 'active', $1, '2026-01-01', '2026-01-01', '2026-01-01')`,
      [JSON.stringify(stored)],
    );
    const resolved = await createPolicyResolver({ db: pool }).resolvePolicy(repricingEnginePolicy);
    expect(resolved).toMatchObject({ source: "policy", documentId: "synthetic-old-repricing-revision", value: launch });
  });

  it("records an any-mode round through the persisted policy, product worker, fact, and evaluation projection", async () => {
    const pool = pools.pricing;
    const rule: RepricingRule = {
      conditions: [],
      directive: {
        ...defaultRule.directive,
        anchorChain: [
          {
            source: "lowest-competing-ask",
            strata: "any",
            band: { ground: "market-estimate", minPercentOfGround: 90 },
          },
        ],
        offset: { mode: "absolute", amount: "0.00" },
      },
    };
    const { policyId } = await seedRound(pool, { listingPrices: ["12.00"], rule });
    const eventStore = createPostgresEventStore({ pool });
    const policies = createRepricingPolicyRuntime({ eventStore, db: pool });
    expect((await policies.getRepricingPolicy(policyId))?.rules).toEqual([rule]);
    const competitor = await policies.commandHandler({
      streamId: policies.streamIdForPolicy("rpp_competitor"),
      context,
      command: {
        type: "CreateRepricingPolicy",
        policyId: "rpp_competitor",
        accountId: "acc_competitor",
        name: "Synthetic competing policy",
        scope: { kind: "listing-set", listingIds: ["lst_competitor"] },
        rules: [defaultRule],
        maxChangesPerDay: 100,
        createdAt: new Date().toISOString(),
      },
    });
    for (const stored of competitor.storedEvents) {
      await policies.projectors[0]!.handlers[stored.eventType]!(toTransportEvent(stored));
    }
    await pool.query(
      "UPDATE pricing_market_listing_inputs SET price_amount = '6.00' WHERE listing_id = 'lst_competitor'",
    );
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_hard_competitor",
          accountId: "acc_hard_competitor",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          priceAmount: "10.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        },
        "marketplace.listing-lst_hard_competitor",
        1,
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-lst_hard_competitor", 2),
    );
    await pool.query(
      "UPDATE pricing_market_price_estimates SET amount = '9.00', fresh_until = now() + interval '1 day'",
    );

    const runtime = createRepricingEngineRuntime({ eventStore, db: pool });
    const marketplace = gateway(() => "applied");
    expect(await runtime.enqueueDailyDriftSweep()).toBe(1);
    expect(
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:any-mode",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      }),
    ).toBe(1);
    expect(marketplace.calls.flat()).toContainEqual(
      expect.objectContaining({ listingId: "lst_policy_1", priceAmount: "8.10" }),
    );
    const facts = await evaluationFacts(pool);
    const ownFact = facts.find((stored) => stored.payload.policyId === policyId)!;
    expect(ownFact).toBeDefined();
    const expectedTrace = expect.objectContaining({
      listingId: "lst_policy_1",
      targetPriceAmount: "8.10",
      outcome: "changed",
      anchor: { source: "lowest-competing-ask", amount: "8.10", stratum: "any-ask", contributingListingCount: 2 },
      flags: ["band-binding"],
    });
    expect(ownFact.payload.listings).toEqual([expectedTrace]);
    for (const stored of facts) {
      await runtime.projectors[0]!.handlers[stored.eventType]!(toTransportEvent(stored));
    }
    const recorded = await pool.query<{ listing_traces: readonly RepricingPolicyListingTrace[] }>(
      "SELECT listing_traces FROM pricing_repricing_policy_evaluations WHERE policy_id = $1",
      [policyId],
    );
    expect(recorded.rows[0]?.listing_traces).toEqual([expectedTrace]);
    for (const serialized of [JSON.stringify(ownFact.payload), JSON.stringify(recorded.rows)]) {
      for (const forbidden of ["lst_competitor", "lst_hard_competitor", "pricingMode", "derived"]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("deduplicates a moved estimate reaction, changes only beyond-tolerance listings, and publishes a complete fact", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["10.00", "11.90"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const trigger = {
      kind: "market-price-estimated" as const,
      eventId: "evt_estimate_2",
      signalVersion: "2",
      occurredAt: new Date(Date.now() - 500).toISOString(),
    };
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "10.00",
        trigger,
        context,
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "10.00",
        trigger,
        context,
      }),
    ).resolves.toBe(false);
    const marketplace = gateway((listingId) => (listingId === "lst_policy_1" ? "applied" : "no_op"));
    await expect(
      runtime.processNextEvaluationJob({
        claimOwnerId: "worker:1",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      }),
    ).resolves.toBe(1);

    expect(marketplace.calls[0]).toEqual([
      expect.objectContaining({
        listingId: "lst_policy_1",
        priceAmount: "11.99",
        priceCurrencyCode: "USD",
        expectedVersion: 2,
      }),
      expect.objectContaining({
        listingId: "lst_policy_2",
        priceAmount: "11.99",
        priceCurrencyCode: "USD",
        expectedVersion: 2,
      }),
    ]);
    const facts = await evaluationFacts(pool);
    expect(facts).toHaveLength(1);
    const payload = facts[0]!.payload as {
      listingsEvaluated: number;
      listingsChanged: number;
      listingsSkipped: number;
      listings: readonly { listingId: string; outcome: string; skipReason: string | null }[];
      signalToEvaluationLatencyMs: number;
    };
    expect(payload).toMatchObject({ listingsEvaluated: 2, listingsChanged: 1, listingsSkipped: 1 });
    expect(payload.listings).toEqual([
      expect.objectContaining({ listingId: "lst_policy_1", outcome: "changed", skipReason: null }),
      expect.objectContaining({ listingId: "lst_policy_2", outcome: "skipped", skipReason: "domain-no-op" }),
    ]);
    expect(payload.signalToEvaluationLatencyMs).toBeGreaterThanOrEqual(0);

    const projection = buildRepricingEvaluationProjectionHandlers(pool);
    await projection["pricing.repricing-policy.evaluated"]!({
      type: facts[0]!.eventType,
      data: facts[0]!.payload,
    } as never);
    const page = await pool.query<{ listings_changed: number; listings_skipped: number }>(
      `SELECT listings_changed, listings_skipped FROM pricing_repricing_policy_evaluations`,
    );
    expect(page.rows).toEqual([{ listings_changed: 1, listings_skipped: 1 }]);
  });

  it("enforces the policy's daily budget and records a manual-edit conflict without consuming budget", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00", "9.00"], maxChangesPerDay: 1 });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_budget",
        signalVersion: "3",
        occurredAt: new Date().toISOString(),
      },
      context,
    });
    const marketplace = gateway(() => "conflict");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:budget",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });

    const facts = await evaluationFacts(pool);
    const payload = facts[0]!.payload as {
      listingsChanged: number;
      listings: readonly { listingId: string; skipReason: string | null }[];
    };
    expect(payload.listingsChanged).toBe(0);
    expect(payload.listings).toEqual([
      expect.objectContaining({ listingId: "lst_policy_1", skipReason: "manual-edit-conflict" }),
      expect.objectContaining({ listingId: "lst_policy_2", skipReason: "budget-exhausted" }),
    ]);
    const budget = await pool.query<{ changes_reserved: number }>(
      `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = 'acc_seller'`,
    );
    expect(budget.rows[0]?.changes_reserved).toBe(0);
  });

  it("does not react to an unchanged daily estimate and enqueues each quiet product only once per drift-sweep day", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await expect(
      runtime.enqueueMarketPriceSignal({
        catalogItemId: "cat_1",
        productId: "cat_1::",
        amount: "11.00",
        previousAmount: "11.00",
        trigger: {
          kind: "market-price-estimated",
          eventId: "evt_unchanged",
          signalVersion: "4",
          occurredAt: "2026-07-17T12:00:00.000Z",
        },
        context,
      }),
    ).resolves.toBe(false);
    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T13:00:00.000Z" })).resolves.toBe(1);
    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T14:00:00.000Z" })).resolves.toBe(0);
  });

  it("damps competing-ask cascades with a per-product cooldown", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["100.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const signal = (eventId: string) => ({
      listingId: "lst_competitor",
      trigger: {
        kind: "competing-ask-changed" as const,
        eventId,
        signalVersion: eventId,
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });

    await expect(runtime.enqueueCompetingAskSignal(signal("evt_90"))).resolves.toBe(true);
    await expect(runtime.enqueueCompetingAskSignal(signal("evt_81"))).resolves.toBe(false);
    await expect(runtime.enqueueCompetingAskSignal(signal("evt_72_90"))).resolves.toBe(false);
  });

  it("threads projected grading and listing age into first-match rule selection", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["10.00"] });
    const conditionalRules: readonly RepricingRule[] = [
      {
        conditions: [
          { type: "item-grading", grading: "graded" },
          { type: "listing-age-at-least", days: 10 },
        ],
        directive: { ...defaultRule.directive, offset: { mode: "absolute", amount: "-1.00" } },
      },
      defaultRule,
    ];
    await pool.query(
      `UPDATE pricing_market_listing_inputs
       SET grading = 'graded', created_at = '2026-07-01T00:00:00.000Z'
       WHERE listing_id = $1`,
      [seeded.listingIds[0]],
    );
    await pool.query(`UPDATE pricing_repricing_policies SET rules = $2::jsonb WHERE policy_id = $1`, [
      seeded.policyId,
      JSON.stringify(conditionalRules),
    ]);

    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    const [evaluation] = await runtime.previewProductRound({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      now: "2026-07-17T12:00:00.000Z",
    });
    expect(evaluation).toMatchObject({ ruleIndex: 0, targetPriceAmount: "11.00" });
  });

  it("drains every daily-sweep page in one invocation", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["8.00"] });
    await pool.query(
      `UPDATE pricing_repricing_policies SET scope_kind = 'all-listings', scope_listing_ids = NULL WHERE policy_id = $1`,
      [seeded.policyId],
    );
    await pool.query(
      `INSERT INTO pricing_market_listing_inputs (
         listing_id, seller_account_id, inventory_item_id, catalog_catalog_item_id, product_id,
         price_amount, price_currency_code, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       )
       SELECT 'lst_page_2', seller_account_id, inventory_item_id, catalog_catalog_item_id, 'cat_1::page-2',
              price_amount, price_currency_code, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       FROM pricing_market_listing_inputs WHERE listing_id = $1
       UNION ALL
       SELECT 'lst_page_3', seller_account_id, inventory_item_id, catalog_catalog_item_id, 'cat_1::page-3',
              price_amount, price_currency_code, quantity_cap, status, grading, created_at, updated_at, last_stream_version
       FROM pricing_market_listing_inputs WHERE listing_id = $1`,
      [seeded.listingIds[0]],
    );
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });

    await expect(runtime.enqueueDailyDriftSweep({ now: "2026-07-17T13:00:00.000Z", limit: 1 })).resolves.toBe(3);
    const cursor = await pool.query<{ completed: boolean }>(
      `SELECT completed FROM pricing_repricing_daily_sweep_cursor WHERE sweep_name = 'assigned-products'`,
    );
    expect(cursor.rows[0]?.completed).toBe(true);
  });

  it("shares one seller daily budget across multiple policies", async () => {
    const pool = pools.pricing;
    await seedRound(pool, { listingPrices: ["8.00"], maxChangesPerDay: 1 });
    const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
    await listingHandlers["marketplace.listing.created"]!(
      event(
        "marketplace.listing.created",
        {
          listingId: "lst_policy_two",
          accountId: "acc_seller",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          priceAmount: "8.00",
          priceCurrencyCode: "USD",
          quantityCap: 1,
        },
        "marketplace.listing-lst_policy_two",
        1,
      ),
    );
    await listingHandlers["marketplace.listing.published"]!(
      event("marketplace.listing.published", {}, "marketplace.listing-lst_policy_two", 2),
    );
    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.created"]!(
      event(
        "pricing.repricing-policy.created",
        {
          policyId: "rpp_2",
          accountId: "acc_seller",
          name: "Second",
          scope: { kind: "listing-set", listingIds: ["lst_policy_two"] },
          excludedListingIds: [],
          rules: [defaultRule],
          maxChangesPerDay: 1,
          createdAt: "2026-07-17T11:30:00.000Z",
        },
        "pricing.repricing-policy-rpp_2",
        1,
      ),
    );
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_shared_budget",
        signalVersion: "5",
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });
    const marketplace = gateway(() => "applied");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:shared-budget",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });

    expect(marketplace.calls.flat()).toHaveLength(1);
    const budget = await pool.query<{ changes_reserved: number }>(
      `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets WHERE seller_account_id = 'acc_seller'`,
    );
    expect(budget.rows[0]?.changes_reserved).toBe(1);
  });

  it("pauses on missing policy input and resumes only after the input stays available through hysteresis", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
      const pool = pools.pricing;
      const seeded = await seedRound(pool, { listingPrices: ["10.00"] });
      const pauseRule: RepricingRule = {
        conditions: [],
        directive: {
          ...defaultRule.directive,
          anchorChain: [{ source: "market-estimate" }],
          terminal: { kind: "pause", reason: "Required pricing input is unavailable." },
        },
      };
      await pool.query(`UPDATE pricing_repricing_policies SET rules = $2::jsonb WHERE policy_id = $1`, [
        seeded.policyId,
        JSON.stringify([pauseRule]),
      ]);
      await pool.query(
        `UPDATE pricing_market_price_estimates SET fresh_until = '2026-07-17T11:00:00.000Z' WHERE product_id = 'cat_1::'`,
      );
      const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
      const marketplace = gateway(() => "applied");
      const enqueue = (eventId: string) =>
        runtime.enqueueMarketPriceSignal({
          catalogItemId: "cat_1",
          productId: "cat_1::",
          amount: "11.00",
          previousAmount: "10.00",
          trigger: {
            kind: "market-price-estimated",
            eventId,
            signalVersion: eventId,
            occurredAt: new Date().toISOString(),
          },
          context,
        });

      await enqueue("evt_pause_missing");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:pause",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.pauseCalls).toEqual([seeded.listingIds[0]]);

      const listingHandlers = buildPricingMarketplaceInputProjectionHandlers(pool);
      await listingHandlers["marketplace.listing.paused"]!(
        event(
          "marketplace.listing.paused",
          { reason: "policy-input-missing" },
          `marketplace.listing-${seeded.listingIds[0]}`,
          3,
        ),
      );
      await pool.query(
        `UPDATE pricing_market_price_estimates SET fresh_until = '2026-07-20T00:00:00.000Z' WHERE product_id = 'cat_1::'`,
      );
      vi.setSystemTime(new Date("2026-07-17T12:01:00.000Z"));
      await enqueue("evt_input_returned");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:wait",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.publishCalls).toHaveLength(0);

      vi.setSystemTime(new Date("2026-07-18T00:02:00.000Z"));
      await enqueue("evt_input_stable");
      await runtime.processNextEvaluationJob({
        claimOwnerId: "worker:resume",
        claimTtlMs: 30_000,
        marketplaceGatewayForAccount: () => marketplace,
      });
      expect(marketplace.publishCalls).toEqual([seeded.listingIds[0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a policy pause/revision precondition before Marketplace mutation", async () => {
    const pool = pools.pricing;
    const seeded = await seedRound(pool, { listingPrices: ["8.00"] });
    const runtime = createRepricingEngineRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    await runtime.enqueueMarketPriceSignal({
      catalogItemId: "cat_1",
      productId: "cat_1::",
      amount: "11.00",
      previousAmount: "10.00",
      trigger: {
        kind: "market-price-estimated",
        eventId: "evt_policy_precondition",
        signalVersion: "6",
        occurredAt: "2026-07-17T12:00:00.000Z",
      },
      context,
    });
    const policyHandlers = buildRepricingPolicyProjectionHandlers(pool);
    await policyHandlers["pricing.repricing-policy.paused"]!(
      event(
        "pricing.repricing-policy.paused",
        { pausedAt: "2026-07-17T12:00:01.000Z" },
        `pricing.repricing-policy-${seeded.policyId}`,
        2,
      ),
    );
    const marketplace = gateway(() => "applied");
    await runtime.processNextEvaluationJob({
      claimOwnerId: "worker:precondition",
      claimTtlMs: 30_000,
      marketplaceGatewayForAccount: () => marketplace,
    });
    expect(marketplace.calls).toHaveLength(0);
  });
});
