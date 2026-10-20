import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import { hashRepricingDryRunBody, type RepricingDryRunTrace } from "../../repricing-engine/api/dry-run";
import { listAccountRepricingPolicies } from "../../repricing-policies/read-model/queries";
import { forecastLedgerPolicy } from "../../forecast-ledger/domain/policy";
import { gradingRulesVersion } from "../../forecast-ledger/domain/grade-ledger";
import { listForecastGrades } from "../../forecast-ledger/read-model/queries";
import { discloseForecastGrade, type PricingHealthGrade } from "./grades";
import { readPricingHealthRun } from "../read-model/queries";
import { pricingGoalDefinitions } from "../../repricing-policies/domain/domain";
import type { GoalAdoption } from "../../forecast-ledger/domain/adoption-gate";
import {
  buildCandidateBody,
  candidateMetrics,
  currentAttentionValues,
  isOneRuleUnconditional,
  recommendGoalChange,
  selectableGoalChoices,
  type CandidateMetrics,
  type GoalChoice,
  type Recommendation,
} from "./goal-comparison";

export function createPricingHealthServices({
  db,
  policies,
  repricingEngine,
  repricingPolicies,
  forecastLedger,
}: Readonly<{
  db: PgQueryable;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
  repricingEngine: Pick<RepricingEngineServices, "enqueueDryRun"> &
    Partial<Pick<RepricingEngineServices, "listDryRuns" | "listDryRunTraces">>;
  repricingPolicies: Pick<RepricingPolicyServices, "loadOwnedRepricingPolicy"> &
    Partial<Pick<RepricingPolicyServices, "getHalt">>;
  forecastLedger?: Readonly<{ listGoalAdoptions: () => Promise<readonly GoalAdoption[]> }>;
}>) {
  const currentTarget = async (accountId: string, policyId: string) => {
    const loaded = await repricingPolicies.loadOwnedRepricingPolicy(policyId, accountId);
    const state = loaded?.state;
    if (!state || state.status !== "active" || !state.scope || state.maxChangesPerDay === null || state.name === null)
      return null;
    return {
      policyId,
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
    const adoptions = forecastLedger?.listGoalAdoptions ? await forecastLedger.listGoalAdoptions() : [];
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
      if (!isOneRuleUnconditional(target.rules))
        return {
          policies: activeChoices,
          target: { policyId: target.policyId, name: target.name },
          ...stored,
          grades: [],
          goals: [],
          comparison: [],
          branch: target.rules.length === 0 ? "create-editor" : "advanced-editor",
        };
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
      const goalChoices = await choices();
      const comparison = await readComparisons(accountId, target, goalChoices, repricingEngine);
      const currentTraces =
        stored.run && repricingEngine.listDryRunTraces
          ? await readAllTraces(repricingEngine.listDryRunTraces, accountId, stored.run.dryRunId)
          : [];
      const currentEconomicsListingIds = currentTraces
        .filter((trace) => trace.health?.economics)
        .map((trace) => trace.listingId)
        .sort();
      const recommendation = recommendGoalChange({
        currentHealth: stored.health,
        currentEconomicsListingIds,
        candidates: comparison,
        expectedCandidateCount: goalChoices.length,
        attentionValues: currentAttentionValues(currentTraces),
        haltEngaged: repricingPolicies.getHalt ? (await repricingPolicies.getHalt(accountId)).engaged : false,
      });
      return {
        policies: activeChoices,
        target: { policyId: target.policyId, name: target.name },
        goals: goalChoices,
        comparison,
        recommendation,
        branch: "comparison",
        ...stored,
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
        if (run) runs.push({ goalId: choice.goalId, goalVersion: choice.goalVersion, dryRunId: run.dryRunId });
      }
      return runs;
    },
  };
}

async function readComparisons(
  accountId: string,
  target: Readonly<{ policyId: string; body: Parameters<typeof buildCandidateBody>[0] }>,
  choices: readonly GoalChoice[],
  repricingEngine: Partial<Pick<RepricingEngineServices, "listDryRuns" | "listDryRunTraces">>,
): Promise<readonly CandidateMetrics[]> {
  if (!isOneRuleUnconditional(target.body.rules) || !repricingEngine.listDryRuns || !repricingEngine.listDryRunTraces)
    return [];
  const runs = await repricingEngine.listDryRuns(accountId, 100);
  const byGoal = new Map(choices.map((choice) => [`${choice.goalId}@${choice.goalVersion}`, choice]));
  const results: CandidateMetrics[] = [];
  const seen = new Set<string>();
  for (const run of [...runs].sort(
    (a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.dryRunId.localeCompare(a.dryRunId),
  )) {
    if (run.replacingPolicyId !== target.policyId) continue;
    const anchor = run.body.rules[0]?.directive.anchorChain[0];
    if (!anchor || anchor.source !== "curve-objective") continue;
    const choice = byGoal.get(`${anchor.goalId}@${anchor.goalVersion}`);
    if (!choice) continue;
    const key = `${choice.goalId}@${choice.goalVersion}`;
    if (
      seen.has(key) ||
      run.bodyHash !== hashRepricingDryRunBody(run.body) ||
      run.bodyHash !== hashRepricingDryRunBody(buildCandidateBody(target.body, choice))
    )
      continue;
    seen.add(key);
    const traces = await readAllTraces(repricingEngine.listDryRunTraces, accountId, run.dryRunId);
    results.push(candidateMetrics(choice, run, traces));
  }
  return results.sort((a, b) => a.goalId.localeCompare(b.goalId) || a.goalVersion - b.goalVersion);
}

async function readAllTraces(
  listDryRunTraces: RepricingEngineServices["listDryRunTraces"],
  accountId: string,
  dryRunId: string,
) {
  const all: RepricingDryRunTrace[] = [];
  let after: string | undefined;
  while (true) {
    const page = await listDryRunTraces(accountId, dryRunId, { after, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
    after = page.at(-1)?.listingId;
  }
}

export type PricingHealthData = Readonly<{
  policies: readonly { policyId: string; name: string }[];
  target: { policyId: string; name: string } | null;
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
type PricingHealthServiceImplementation = ReturnType<typeof createPricingHealthServices>;
export type PricingHealthServices = Omit<PricingHealthServiceImplementation, "getHealth" | "compare"> & {
  getHealth: (
    ...args: Parameters<PricingHealthServiceImplementation["getHealth"]>
  ) => Promise<PricingHealthData | null>;
  compare?: PricingHealthServiceImplementation["compare"];
};
