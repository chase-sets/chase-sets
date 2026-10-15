import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import { fixedPercentileGoal } from "../../repricing-policies/domain/goals/fixed-percentile";
import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";
import { targetHorizonGoal } from "../../repricing-policies/domain/goals/target-horizon";
import { createForecastLedgerRuntime, latestGradePair } from "../api/runtime";
import { decideAdoption, goalAdoptions, type AdoptionGradePair } from "../domain/adoption-gate";
import { gradingRulesVersion } from "../domain/grade-ledger";
import type { ForecastGrade } from "../domain/grading";
import { FORECAST_LEDGER_LAUNCH_POLICY_VALUE, type ForecastLedgerPolicyValue } from "../domain/policy";
import type { StoredForecastGrade } from "../read-model/queries";

const grade = (brier: number, count = 40): ForecastGrade => ({
  count,
  soldShare: 0.5,
  expectedShare: 0.5,
  brier,
  baseRateBrier: 0.25,
  deciles: [],
});
const pair = (shadow: number | null, incumbent: number | null): AdoptionGradePair => ({
  closedOn: "2026-09-01",
  forecastKind: "curve",
  model: "pooled-supply-v1",
  horizonDays: 21,
  shadow: shadow === null ? null : grade(shadow),
  incumbent: incumbent === null ? null : grade(incumbent),
});
const version = (goal: PricingGoalDefinition, goalVersion: number, lifecycle: PricingGoalDefinition["lifecycle"]) => ({
  ...goal,
  version: goalVersion,
  lifecycle,
});

describe("Adoption Gate", () => {
  it("promotes a shadow version only when its adopted forecast grades at or better than the incumbent", () => {
    expect(decideAdoption(pair(0.2, 0.21))).toEqual({ promotable: true, reason: null });
    expect(decideAdoption(pair(0.21, 0.21))).toEqual({ promotable: true, reason: null });
    expect(decideAdoption(pair(0.22, 0.21))).toEqual({
      promotable: false,
      reason: "shadow-grade-worse-than-incumbent",
    });
    expect(decideAdoption(pair(null, 0.21))).toEqual({ promotable: false, reason: "shadow-grade-missing" });
    expect(decideAdoption(null)).toEqual({ promotable: false, reason: "shadow-grade-missing" });
    expect(decideAdoption(pair(0.2, null))).toEqual({ promotable: false, reason: "incumbent-grade-missing" });
  });

  it("keeps a version-1 goal selectable without a grade and refuses a later version graded worse than its newest earlier non-shadow version", () => {
    const definitions = [
      fixedPercentileGoal,
      version(fixedPercentileGoal, 2, "retired"),
      version(fixedPercentileGoal, 3, "selectable"),
      targetHorizonGoal,
      version(targetHorizonGoal, 2, "shadow"),
    ];
    const grades = new Map([
      ["fixed-percentile@3<2", pair(0.26, 0.2)],
      ["target-horizon@2<1", pair(0.18, 0.2)],
    ]);
    const adoptions = goalAdoptions(definitions, (goalId, goalVersion, incumbentVersion) => {
      return grades.get(`${goalId}@${goalVersion}<${incumbentVersion}`) ?? null;
    });
    expect(adoptions.map(({ grades: _grades, ...adoption }) => adoption)).toEqual([
      {
        goalId: "fixed-percentile",
        goalVersion: 1,
        lifecycle: "selectable",
        incumbentVersion: null,
        selectable: true,
        promotable: true,
        reason: null,
      },
      {
        goalId: "fixed-percentile",
        goalVersion: 3,
        lifecycle: "selectable",
        incumbentVersion: 2,
        selectable: false,
        promotable: false,
        reason: "shadow-grade-worse-than-incumbent",
      },
      {
        goalId: "target-horizon",
        goalVersion: 1,
        lifecycle: "selectable",
        incumbentVersion: null,
        selectable: true,
        promotable: true,
        reason: null,
      },
      {
        goalId: "target-horizon",
        goalVersion: 2,
        lifecycle: "shadow",
        incumbentVersion: 1,
        selectable: false,
        promotable: true,
        reason: null,
      },
    ]);
  });

  it("compares the newest closed shadow grade with the incumbent's grade of the same day and model", () => {
    const stored = (closedOn: string, model: string, brier: number, count = 40): StoredForecastGrade => ({
      closedOn,
      forecastKind: "curve",
      model,
      horizonDays: 21,
      grade: grade(brier, count),
    });
    const shadow = [stored("2026-09-02", "builder-v2", 0.3, 10), stored("2026-09-02", "builder-v1", 0.19, 30)];
    const incumbent = [stored("2026-09-02", "builder-v1", 0.2), stored("2026-09-01", "builder-v2", 0.1)];
    expect(latestGradePair(shadow, incumbent)).toEqual({
      closedOn: "2026-09-02",
      forecastKind: "curve",
      model: "builder-v1",
      horizonDays: 21,
      shadow: grade(0.19, 30),
      incumbent: grade(0.2),
    });
    expect(latestGradePair([], incumbent)).toBeNull();
  });

  it("surfaces the refusal reason through the authoring prerequisites", async () => {
    const graded = new Map<string, readonly Readonly<{ closed_on: string; model: string; grade: ForecastGrade }>[]>([
      ["fixed-percentile@2:shadow", [{ closed_on: "2026-09-02", model: "pooled-supply-v1", grade: grade(0.24) }]],
      ["fixed-percentile@1:incumbent", [{ closed_on: "2026-09-02", model: "pooled-supply-v1", grade: grade(0.2) }]],
    ]);
    const reads: unknown[][] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM pricing_forecast_grades")) {
          reads.push(params);
          return { rows: graded.get(`${params[0]}@${params[1]}:${params[2]}`) ?? [] };
        }
        return { rows: [{ listingCurrencyCodes: ["USD"], hasCostBasis: true }] };
      },
    } as unknown as PgQueryable & PgTransactionalPool;
    const policies = {
      resolvePolicy: async (definition: { defaultValue: unknown }) => ({ value: definition.defaultValue }),
    } as unknown as Pick<PolicyRuntime, "resolvePolicy">;
    const { eventStore } = createInMemoryEventStore();
    const forecastLedger = createForecastLedgerRuntime({
      pool: db,
      eventStore,
      policies,
      goalDefinitions: () => [fixedPercentileGoal, version(fixedPercentileGoal, 2, "selectable")],
    });
    const repricingPolicies = createRepricingPolicyRuntime({
      eventStore,
      db,
      goalAdoptions: () => forecastLedger.listGoalAdoptions(),
    });

    const prerequisites = await repricingPolicies.getAuthoringPrerequisites("acc_seller");

    expect(prerequisites).toEqual({
      listingCurrencyCodes: ["USD"],
      hasCostBasis: true,
      goalAdoption: [
        {
          goalId: "fixed-percentile",
          goalVersion: 1,
          lifecycle: "selectable",
          incumbentVersion: null,
          selectable: true,
          promotable: true,
          reason: null,
        },
        {
          goalId: "fixed-percentile",
          goalVersion: 2,
          lifecycle: "selectable",
          incumbentVersion: 1,
          selectable: false,
          promotable: false,
          reason: "shadow-grade-worse-than-incumbent",
        },
      ],
    });
    // The gate reads the policy's adopted Forecast Kind at its horizon, under the grading rules in force.
    const { adoptedForecastKind, adoptionHorizonDays } = FORECAST_LEDGER_LAUNCH_POLICY_VALUE;
    const rulesVersion = gradingRulesVersion(FORECAST_LEDGER_LAUNCH_POLICY_VALUE);
    expect(reads).toEqual([
      ["fixed-percentile", 2, "shadow", adoptedForecastKind, adoptionHorizonDays, rulesVersion],
      ["fixed-percentile", 1, "incumbent", adoptedForecastKind, adoptionHorizonDays, rulesVersion],
    ]);
    // The gate compared the newest closed day's grades, which stay out of the seller's response.
    expect((await forecastLedger.listGoalAdoptions())[1]!.grades).toMatchObject({
      closedOn: "2026-09-02",
      shadow: { brier: 0.24 },
      incumbent: { brier: 0.2 },
    });
  });

  it("identifies grading rules by their grace, every horizon, and the grading implementation", () => {
    const launch = gradingRulesVersion(FORECAST_LEDGER_LAUNCH_POLICY_VALUE);
    expect(gradingRulesVersion({ ...FORECAST_LEDGER_LAUNCH_POLICY_VALUE })).toBe(launch);
    expect(gradingRulesVersion({ ...FORECAST_LEDGER_LAUNCH_POLICY_VALUE, graceDays: 0 })).not.toBe(launch);
    // A horizon added below the longest leaves the cohort window alone but still changes the rules.
    expect(gradingRulesVersion({ ...FORECAST_LEDGER_LAUNCH_POLICY_VALUE, horizonsDays: [14, 21, 25, 28] })).not.toBe(
      launch,
    );
    // Which grade the gate compares is not a grading rule.
    const adoptedAt14: ForecastLedgerPolicyValue = { ...FORECAST_LEDGER_LAUNCH_POLICY_VALUE, adoptionHorizonDays: 14 };
    expect(gradingRulesVersion(adoptedAt14)).toBe(launch);
  });

  it("compares only grades taken under the grading rules in force, so a rule change refuses a shadow version until it is regraded", async () => {
    const launch = FORECAST_LEDGER_LAUNCH_POLICY_VALUE;
    const noGrace = { ...launch, graceDays: 0 };
    const stored: Array<
      Readonly<{ scope: string; rules_version: string; closed_on: string; model: string; grade: ForecastGrade }>
    > = [
      {
        scope: "fixed-percentile@2:shadow",
        rules_version: gradingRulesVersion(launch),
        closed_on: "2026-09-02",
        model: "pooled-supply-v1",
        grade: grade(0.18),
      },
      {
        scope: "fixed-percentile@1:incumbent",
        rules_version: gradingRulesVersion(launch),
        closed_on: "2026-09-02",
        model: "pooled-supply-v1",
        grade: grade(0.2),
      },
    ];
    const db = {
      query: async (_sql: string, params: readonly unknown[] = []) => ({
        rows: stored.filter(
          (row) => row.scope === `${params[0]}@${params[1]}:${params[2]}` && row.rules_version === params[5],
        ),
      }),
    } as unknown as PgQueryable & PgTransactionalPool;
    let policy = launch;
    const { eventStore } = createInMemoryEventStore();
    const forecastLedger = createForecastLedgerRuntime({
      pool: db,
      eventStore,
      policies: { resolvePolicy: async () => ({ value: policy }) } as unknown as Pick<PolicyRuntime, "resolvePolicy">,
      goalDefinitions: () => [fixedPercentileGoal, version(fixedPercentileGoal, 2, "shadow")],
    });
    const shadowVersion = async () => {
      const { promotable, reason } = (await forecastLedger.listGoalAdoptions())[1]!;
      return { promotable, reason };
    };

    expect(await shadowVersion()).toEqual({ promotable: true, reason: null });
    // Grace drops to zero: the grades taken with two days of grace no longer count.
    policy = noGrace;
    expect(await shadowVersion()).toEqual({ promotable: false, reason: "shadow-grade-missing" });
    // Regraded without grace, the shadow version grades worse than its incumbent.
    stored.push(
      {
        scope: "fixed-percentile@2:shadow",
        rules_version: gradingRulesVersion(noGrace),
        closed_on: "2026-09-02",
        model: "pooled-supply-v1",
        grade: grade(0.3),
      },
      {
        scope: "fixed-percentile@1:incumbent",
        rules_version: gradingRulesVersion(noGrace),
        closed_on: "2026-09-02",
        model: "pooled-supply-v1",
        grade: grade(0.2),
      },
    );
    expect(await shadowVersion()).toEqual({ promotable: false, reason: "shadow-grade-worse-than-incumbent" });
  });
});
