import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as pricingModule } from "../../../index";
import { projectListingOutcomeFacts } from "../read-model/listing-outcomes";
import { getRepricingAttentionSummary, listRepricingActivity, repricingActivityFilters } from "../api/activity";
import type { RepricingEvaluationSkipReason, RepricingPolicyEvaluatedEvent } from "../domain/fact";
import { createRepricingActivityServices } from "../api/activity-route";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const now = "2026-09-16T12:00:00.000Z";
const freeze = "2026-09-16T14:00:00.000Z";
const skipReasons: RepricingEvaluationSkipReason[] = [
  "within-tolerance",
  "anchor-chain-exhausted",
  "terminal-hold",
  "terminal-pause",
  "terminal-notify-only",
  "currency-input-incomplete-or-mismatched",
  "budget-exhausted",
  "manual-edit-conflict",
  "domain-no-op",
  "policy-precondition-failed",
  "spiral-breaker-frozen",
  "resume-hysteresis",
  "repause-cooldown",
  "command-error",
];

describeDb("repricing activity and attention", () => {
  let pools: Readonly<Record<"pricing", PgTransactionalPool>>;
  let db: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "repricing_activity_7912");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    db = pools.pricing;
    await resetMultiContextTestSchemas(pools);
    await db.query(pricingModule.schemaSql);
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE pricing_repricing_listing_outcome_facts, pricing_repricing_listing_outcomes,
      pricing_repricing_policy_listing_pauses, pricing_repricing_policies, pricing_repricing_halts,
      pricing_repricing_daily_change_budgets`);
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function seedPolicy(account: string, policy: string) {
    await db.query(
      `INSERT INTO pricing_repricing_policies
      (policy_id, seller_account_id, name, status, scope_kind, rules, max_changes_per_day, created_at, updated_at)
      VALUES ($1, $2, $1, 'active', 'all-listings', '[]', 10, $3, $3)`,
      [policy, account, now],
    );
  }
  async function seed(
    account: string,
    policy: string,
    listing: string,
    options: {
      skip?: RepricingEvaluationSkipReason;
      floor?: boolean;
      frozen?: string;
      at?: string;
    } = {},
  ) {
    const evaluatedAt = options.at ?? now;
    const data: RepricingPolicyEvaluatedEvent["data"] = {
      schemaVersion: 1,
      evaluationId: `evaluation-${listing}`,
      sellerAccountId: account,
      policyId: policy,
      policyRevision: "1",
      catalogItemId: "catalog-a",
      productId: "product-a",
      evaluatedAt,
      trigger: { kind: "daily-drift-sweep", eventId: "event-a", signalVersion: "1", occurredAt: evaluatedAt },
      listingsEvaluated: 1,
      listingsChanged: options.skip ? 0 : 1,
      listingsSkipped: options.skip ? 1 : 0,
      signalToEvaluationLatencyMs: 0,
      listings: [
        {
          listingId: listing,
          currentPriceAmount: "10.00",
          targetPriceAmount: "5.00",
          ruleIndex: 0,
          anchor: null,
          exhaustedAnchors: [],
          clamps: { floor: options.floor ?? false, ceiling: false, maxMove: false },
          flags: [],
          outcome: options.skip ? "skipped" : "changed",
          skipReason: options.skip ?? null,
          frozenUntil: options.frozen,
        },
      ],
    };
    await withPgTransaction(db, (tx) => projectListingOutcomeFacts(tx, data, "1"));
  }
  async function pause(listing: string, policy: string, resumed = false) {
    await db.query(
      `INSERT INTO pricing_repricing_policy_listing_pauses
      (listing_id, policy_id, paused_at, resumed_at, updated_at) VALUES ($1, $2, $3, $4, $3)`,
      [listing, policy, now, resumed ? now : null],
    );
  }
  const page = (policyId: string, filter?: (typeof repricingActivityFilters)[number], after?: string) =>
    listRepricingActivity(db, { accountId: "account-a", policyId, filter, after, limit: 2, now });

  it("filter counts reconcile to complete current-state paging for every filter and policy", async () => {
    await seedPolicy("account-a", "policy-a");
    await seedPolicy("account-a", "policy-b");
    await seedPolicy("account-b", "foreign");
    for (const skip of skipReasons) {
      await seed("account-a", "policy-a", `a-${skip}`, { skip });
      await seed("account-b", "foreign", `foreign-${skip}`, { skip, floor: true, frozen: freeze });
    }
    for (let i = 0; i < 5; i++) {
      await seed("account-a", "policy-a", `floor-${i}`, { floor: true, frozen: freeze });
      await pause(`floor-${i}`, "policy-a", i === 4);
    }
    await seed("account-a", "policy-b", "b-one", { skip: "budget-exhausted" });
    // Same listing, different policy: the pause must not bleed into the current outcome.
    await pause("b-one", "policy-a");
    const countsA = (await page("policy-a")).filterCounts;
    const countsB = (await page("policy-b")).filterCounts;
    expect(countsA).not.toEqual(countsB);
    expect(countsA["paused-for-missing-input"]).toBe(4);
    expect(countsA["floor-binding"]).toBe(5);
    expect(countsB["paused-for-missing-input"]).toBe(0);
    for (const policyId of ["policy-a", "policy-b"]) {
      for (const filter of repricingActivityFilters) {
        let after: string | undefined;
        const listings: string[] = [];
        const counts = (await page(policyId, filter)).filterCounts;
        do {
          const result = await page(policyId, filter, after);
          expect(result.filterCounts).toEqual(counts);
          expect(result.rows.length).toBeLessThanOrEqual(2);
          listings.push(...result.rows.map((row) => row.listingId));
          after = result.next ?? undefined;
        } while (after);
        expect(new Set(listings).size).toBe(listings.length);
        expect(listings.length).toBe(counts[filter]);
        expect(listings.some((id) => id.startsWith("foreign"))).toBe(false);
      }
    }
    const query = vi.spyOn(db, "query");
    try {
      const result = await page("policy-a", "spiral-breaker");
      expect(query).toHaveBeenCalledTimes(2);
      expect(result.rows.every((row) => row.affectedListingCount === 5)).toBe(true);
    } finally {
      query.mockRestore();
    }
  });

  it("attention uses retained facts, UTC-day budgets, active pauses and account halt without live breaker reads", async () => {
    await seedPolicy("account-a", "policy-a");
    await seedPolicy("account-b", "foreign");
    await seed("account-a", "policy-a", "old-floor", { floor: true, at: "2026-09-09T12:00:00.000Z", frozen: freeze });
    await seed("account-a", "policy-a", "new-floor", { floor: true, at: "2026-09-09T12:00:00.001Z", frozen: freeze });
    await seed("account-a", "policy-a", "budget", { skip: "budget-exhausted", at: "2026-09-16T00:00:00.000Z" });
    await seed("account-a", "policy-a", "yesterday", { skip: "budget-exhausted", at: "2026-09-15T23:59:59.999Z" });
    await seed("account-a", "policy-a", "tomorrow", { skip: "budget-exhausted", at: "2026-09-17T00:00:00.000Z" });
    await seed("account-a", "policy-a", "expired-freeze", { frozen: now });
    await seed("account-b", "foreign", "foreign", { floor: true, at: "2026-01-01T00:00:00.000Z", frozen: freeze });
    await pause("old-floor", "policy-a");
    await pause("new-floor", "policy-a", true);
    await pause("foreign", "foreign");
    await db.query(
      `INSERT INTO pricing_repricing_daily_change_budgets VALUES ('account-a', '2026-09-16', 10, $1), ('account-b', '2026-09-16', 500, $1)`,
      [now],
    );
    await db.query(
      `INSERT INTO pricing_repricing_halts VALUES ('account-a', true, $1, NULL, $1, 1), ('account-b', false, NULL, $1, $1, 1)`,
      [now],
    );
    const query = vi.spyOn(db, "query");
    try {
      const result = await getRepricingAttentionSummary(db, { accountId: "account-a", now, floorBindingAlertDays: 7 });
      expect(query).toHaveBeenCalledTimes(5);
      expect(query.mock.calls.some(([sql]) => sql.includes("product_round_cooldowns"))).toBe(false);
      expect(result).toEqual({
        floorBinding: 1,
        pausedForMissingInput: 1,
        budgetExhaustedToday: [{ policyId: "policy-a", count: 1 }],
        haltEngaged: true,
        frozenProducts: [
          { productKey: { catalogItemId: "catalog-a", productId: "product-a" }, listingCount: 2, frozenUntil: freeze },
        ],
      });
    } finally {
      query.mockRestore();
    }
    const nextDay = await getRepricingAttentionSummary(db, {
      accountId: "account-a",
      now: "2026-09-17T12:00:00.000Z",
      floorBindingAlertDays: 7,
    });
    expect(nextDay).toMatchObject({ floorBinding: 2, frozenProducts: [] });
    const services = createRepricingActivityServices(db);
    expect(await services.getAccountRepricingPolicy("account-a", "foreign")).toBeNull();
    expect(await services.attention("account-b", now)).toMatchObject({
      floorBinding: 1,
      pausedForMissingInput: 1,
      haltEngaged: false,
    });
    expect(await getRepricingAttentionSummary(db, { accountId: "absent", now, floorBindingAlertDays: 7 })).toEqual({
      floorBinding: 0,
      pausedForMissingInput: 0,
      budgetExhaustedToday: [],
      haltEngaged: false,
      frozenProducts: [],
    });
  });
});
