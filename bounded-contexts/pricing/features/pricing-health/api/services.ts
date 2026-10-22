import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { listAccountRepricingPolicies } from "../../repricing-policies/read-model/queries";
import { forecastLedgerPolicy } from "../../forecast-ledger/domain/policy";
import type { ForecastLedgerServices } from "../../forecast-ledger/api/runtime";
import { gradingRulesVersion } from "../../forecast-ledger/domain/grade-ledger";
import { listForecastGrades } from "../../forecast-ledger/read-model/queries";
import { discloseForecastGrade, type PricingHealthGrade } from "./grades";
import { readCandidateComparison, readComparisonFacts, readPricingHealthRun } from "../read-model/queries";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import {
  buildCandidateBody,
  isOneRuleUnconditional,
  recommendGoalChange,
  selectableGoalChoices,
  type CandidateMetrics,
  type GoalChoice,
  type Recommendation,
} from "./goal-comparison";

export class PricingHealthCandidateRefusedError extends Error {
  constructor() {
    super("pricing_health_candidate_enqueue_refused");
  }
}

export function createPricingHealthServices({
  db,
  policies,
  repricingEngine,
  repricingPolicies,
  forecastLedger,
}: Readonly<{
  db: PgQueryable;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
  repricingEngine: Pick<RepricingEngineServices, "enqueueDryRun" | "getDryRun">;
  repricingPolicies: Pick<RepricingPolicyServices, "loadOwnedRepricingPolicy" | "getHalt">;
  forecastLedger: Pick<ForecastLedgerServices, "listGoalAdoptions">;
}>) {
  const currentTarget = async (accountId: string, policyId: string) => {
    const loaded = await repricingPolicies.loadOwnedRepricingPolicy(policyId, accountId);
    const state = loaded?.state;
    if (!state || state.status !== "active" || !state.scope || state.maxChangesPerDay === null || state.name === null)
      return null;
    return {
      policyId,
      version: loaded.version,
      updatedAt: state.updatedAt,
      name: state.name,
      scope: state.scope,
      rules: state.rules,
      excludedListingIds: state.excludedListingIds,
      maxChangesPerDay: state.maxChangesPerDay,
      body: {
        scope: state.scope,
        excludedListingIds: state.excludedListingIds,
        rules: state.rules,
        maxChangesPerDay: state.maxChangesPerDay,
      },
    };
  };
  const choices = async (): Promise<readonly GoalChoice[]> => {
    const adoptions = await forecastLedger.listGoalAdoptions();
    return selectableGoalChoices(pricingGoalDefinitions(), adoptions);
  };
  return {
    getHealth: async (
      accountId: string,
      policyId: string | undefined,
      now: string,
    ): Promise<PricingHealthData | null> => {
      const active = (await listAccountRepricingPolicies(db, { accountId })).filter(
        ({ status }) => status === "active",
      );
      const activeChoices = active.map(({ policyId, name }) => ({ policyId, name }));
      // An explicit invalid selector never falls back, even when one owned policy exists.
      const selected =
        policyId === undefined ? (active.length === 1 ? active[0] : null) : active.find((p) => p.policyId === policyId);
      if (policyId !== undefined && !selected) return null;
      if (!selected)
        return {
          policies: activeChoices,
          target: null,
          health: null,
          run: null,
          grades: [],
          computing: false,
          goals: [],
          comparison: [],
          branch: "create-editor",
        };
      const target = await currentTarget(accountId, selected.policyId);
      if (!target) return null;
      const stored = await readPricingHealthRun(db, {
        accountId,
        policyId: target.policyId,
        bodyHash: hashRepricingDryRunBody(target),
      });
      const policy = (await policies.resolvePolicy(forecastLedgerPolicy, { at: now })).value;
      const goals = new Map<string, { goalId: string; goalVersion: number }>();
      for (const rule of target.rules)
        for (const anchor of rule.directive.anchorChain) {
          if (anchor.source === "curve-objective")
            goals.set(`${anchor.goalId}@${anchor.goalVersion}`, {
              goalId: anchor.goalId,
              goalVersion: anchor.goalVersion,
            });
        }
      const grades: PricingHealthGrade[] = [];
      for (const goal of goals.values()) {
        const rows = await listForecastGrades(db, {
          ...goal,
          role: "incumbent",
          rulesVersion: gradingRulesVersion(policy),
          latest: { closedOnOrBefore: now.slice(0, 10), horizonsDays: policy.horizonsDays, limit: 100 },
        });
        grades.push(
          ...rows.map((row) => ({ ...goal, ...discloseForecastGrade(row, policy.gradeDisclosureMinimumCount) })),
        );
      }
      if (!isOneRuleUnconditional(target.rules))
        return {
          policies: activeChoices,
          target: { policyId: target.policyId, name: target.name, version: target.version },
          ...stored,
          grades,
          goals: [],
          comparison: [],
          branch: target.rules.length === 0 ? "create-editor" : "advanced-editor",
        };
      const goalChoices = await choices();
      const currentFacts = stored.run
        ? await readComparisonFacts(db, { accountId, dryRunId: stored.run.dryRunId, now })
        : null;
      const currentHealth =
        currentFacts?.evidenceCurrent &&
        (!target.updatedAt || Date.parse(stored.run!.requestedAt) >= Date.parse(target.updatedAt))
          ? stored.health
          : null;
      const comparison: CandidateMetrics[] = [];
      for (const choice of goalChoices) {
        const candidate = await readCandidateComparison(db, repricingEngine, {
          accountId,
          policyId: target.policyId,
          targetRevision: target.version,
          targetUpdatedAt: target.updatedAt,
          body: target.body,
          choice,
          now,
          basisCapturedAt: currentHealth?.capturedAt,
          basisFacts: stored.run && currentFacts ? { dryRunId: stored.run.dryRunId, facts: currentFacts } : undefined,
        });
        if (candidate) comparison.push(candidate);
      }
      const recommendation = recommendGoalChange({
        currentHealth,
        currentEconomicsSet: currentFacts?.economicsSet ?? null,
        candidates: comparison,
        expectedCandidateCount: goalChoices.length,
        attentionValues: currentFacts?.attentionValues,
        haltEngaged: (await repricingPolicies.getHalt(accountId)).engaged,
      });
      return {
        policies: activeChoices,
        target: { policyId: target.policyId, name: target.name, version: target.version },
        goals: goalChoices,
        comparison,
        recommendation,
        branch: "comparison",
        ...stored,
        health: currentHealth,
        run: currentHealth ? stored.run : null,
        computing: stored.computing || comparison.some(({ status }) => status === "queued" || status === "running"),
        grades,
      };
    },
    compute: async (
      accountId: string,
      policyId: string,
      context: Parameters<RepricingEngineServices["enqueueDryRun"]>[1],
    ) => {
      const target = await currentTarget(accountId, policyId);
      if (!target) return null;
      return repricingEngine.enqueueDryRun(
        { sellerAccountId: accountId, replacingPolicyId: target.policyId, body: target },
        context,
      );
    },
    compare: async (
      accountId: string,
      policyId: string,
      context: Parameters<RepricingEngineServices["enqueueDryRun"]>[1],
    ) => {
      const target = await currentTarget(accountId, policyId);
      if (!target || !isOneRuleUnconditional(target.rules)) return null;
      const goalChoices = await choices();
      const runs = [];
      for (const choice of goalChoices) {
        const body = buildCandidateBody(target.body, choice);
        const run = await repricingEngine.enqueueDryRun(
          { sellerAccountId: accountId, replacingPolicyId: target.policyId, body },
          context,
        );
        if (!run) throw new PricingHealthCandidateRefusedError();
        runs.push({ goalId: choice.goalId, goalVersion: choice.goalVersion, dryRunId: run.dryRunId });
      }
      return runs;
    },
  };
}

export type PricingHealthData = Readonly<{
  policies: readonly { policyId: string; name: string }[];
  target: { policyId: string; name: string; version: number } | null;
  health: Awaited<ReturnType<typeof readPricingHealthRun>>["health"];
  run: Awaited<ReturnType<typeof readPricingHealthRun>>["run"];
  grades: readonly PricingHealthGrade[];
  computing: boolean;
  goals?: readonly GoalChoice[];
  comparison?: readonly CandidateMetrics[];
  recommendation?: Recommendation;
  branch?: "comparison" | "advanced-editor" | "create-editor";
  canCompute?: boolean;
}>;
export type PricingHealthServices = ReturnType<typeof createPricingHealthServices>;
