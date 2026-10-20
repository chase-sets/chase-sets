import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createPricingHealthServices } from "../api/services";
import { createForecastLedgerRuntime } from "../../forecast-ledger/api/runtime";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import { createRepricingDryRunServices, type RepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import {
  summarizeHealth,
  type RepricingHealthContribution,
  type RepricingHealthSummary,
} from "../../repricing-engine/api/health-summary";
import { REPRICING_ENGINE_LAUNCH_POLICY_VALUE } from "../../repricing-engine/domain/policy";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";
import { projectSyntheticPricingHealthPolicy } from "../../../support/runtime-support/pricing-health-browser-seed";

export const comparisonNow = "2026-10-20T00:00:00.000Z";
export const comparisonPolicyId = "rpp_synthetic_comparison";
export const comparisonAccountId = "acc_7910";

export const comparisonAdvancedTargets = [
  [
    "multi-rule",
    [
      { ...dryRunBody.rules[0]!, conditions: [{ type: "quantity-at-least", quantity: 3 }] },
      { ...dryRunBody.rules[0]!, conditions: [{ type: "quantity-at-least", quantity: 2 }] },
      ...dryRunBody.rules,
    ],
  ],
  [
    "conditional",
    [{ ...dryRunBody.rules[0]!, conditions: [{ type: "quantity-at-least", quantity: 2 }] }, ...dryRunBody.rules],
  ],
] as const;

export function comparisonTestServices(db: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool: db });
  const policies = createPolicyRuntime({ eventStore, db });
  const forecastLedger = createForecastLedgerRuntime({
    pool: db,
    eventStore,
    policies,
    goalDefinitions: pricingGoalDefinitions,
  });
  const repricingPolicies = createRepricingPolicyRuntime({
    eventStore,
    db,
    goalAdoptions: forecastLedger.listGoalAdoptions,
  });
  const repricingEngine = createRepricingDryRunServices(db, async () => REPRICING_ENGINE_LAUNCH_POLICY_VALUE, {
    resolve: async () => {
      throw new Error("Synthetic stored-run fixture must not resolve live Economics.");
    },
  });
  const health = createPricingHealthServices({
    db,
    policies,
    forecastLedger,
    repricingPolicies,
    repricingEngine,
  });
  return { health, policies: repricingPolicies, worker: repricingEngine, forecastLedger };
}

export async function createComparisonPolicy(
  db: PgTransactionalPool,
  services: ReturnType<typeof comparisonTestServices>,
  rules = dryRunBody.rules,
) {
  await services.policies.commandHandler({
    streamId: services.policies.streamIdForPolicy(comparisonPolicyId),
    context: dryRunContext,
    command: {
      ...dryRunBody,
      rules,
      type: "CreateRepricingPolicy",
      policyId: comparisonPolicyId,
      accountId: comparisonAccountId,
      name: "Synthetic health policy comparison",
      createdAt: comparisonNow,
    },
  });
  await projectSyntheticPricingHealthPolicy(db, { policyId: comparisonPolicyId, accountId: comparisonAccountId });
}

export function comparisonContribution(index = 1): RepricingHealthContribution {
  return {
    listingId: `lst_7910_${String(index).padStart(8, "0")}`,
    quantity: 1,
    currentPriceAmount: "20.00",
    effectivePriceAmount: "20.00",
    currencyCode: "USD",
    modeled: {
      medianDays: 5,
      curveVersion: 1,
      builtAt: comparisonNow,
      policyRevisionId: "synthetic-policy",
      forecastStatus: "interpolated",
    },
    modeledReason: null,
    economics: {
      resolution: "resolved",
      unitCostAmount: "1.00",
      turnaroundDays: 1,
      dailyReturnHurdle: 0.01,
      costBasisSourceKinds: ["inventory-observation"],
      dailyReturnHurdleSourceKind: "policy-owned",
      netProceedsAmount: "18.00",
    },
    economicsReason: null,
    risk: "none",
  };
}

export function comparisonSummary(
  contributions: readonly RepricingHealthContribution[],
  profit = 2,
  capitalTurn = 0.1,
  wait = 5,
): RepricingHealthSummary {
  const summary = summarizeHealth(contributions, comparisonNow);
  return {
    ...summary,
    currencies: Object.fromEntries(
      Object.entries(summary.currencies).map(([currency, value]) => [
        currency,
        {
          ...value,
          profitPerDay: { ...value.profitPerDay, value: profit },
          capitalTurn: { ...value.capitalTurn, value: capitalTurn },
          expectedWait: { medianDays: wait, p90Days: wait },
        },
      ]),
    ),
  };
}

/** Synthetic stored A1 facts isolate S12/readback; durable worker math is proven separately over 501 products. */
export async function storeComparisonRun(
  db: PgTransactionalPool,
  services: ReturnType<typeof comparisonTestServices>,
  input: Readonly<{
    body: RepricingDryRunBody;
    health: RepricingHealthSummary;
    contributions: readonly RepricingHealthContribution[];
    requestedAt?: string;
    floorBinding?: boolean;
  }>,
) {
  const run = (await services.worker.enqueueDryRun(
    { sellerAccountId: comparisonAccountId, replacingPolicyId: comparisonPolicyId, body: input.body },
    dryRunContext,
  ))!;
  const requestedAt = input.requestedAt ?? "2026-10-20T00:00:01.000Z";
  await db.query(
    `UPDATE pricing_repricing_dry_runs SET status='completed', requested_at=$2, completed_at=$2,
    health=$3::jsonb, summary=$4::jsonb WHERE dry_run_id=$1`,
    [
      run.dryRunId,
      requestedAt,
      JSON.stringify(input.health),
      JSON.stringify({
        listingsEvaluated: input.contributions.length,
        outcomes: { skipped: input.contributions.length },
        skipReasons: { "within-tolerance": input.contributions.length },
        flags: {},
        deltaBuckets: {},
        withinTolerance: input.contributions.length,
      }),
    ],
  );
  for (const contribution of input.contributions)
    await db.query(
      `INSERT INTO pricing_repricing_dry_run_traces
    (dry_run_id,seller_account_id,listing_id,outcome,skip_reason,flags,delta_cents,trace,health)
    VALUES ($1,$2,$3,'skipped','within-tolerance',$4,0,'{}'::jsonb,$5::jsonb)`,
      [
        run.dryRunId,
        comparisonAccountId,
        contribution.listingId,
        input.floorBinding ? ["floor-binding"] : [],
        JSON.stringify(contribution),
      ],
    );
  return run.dryRunId;
}
