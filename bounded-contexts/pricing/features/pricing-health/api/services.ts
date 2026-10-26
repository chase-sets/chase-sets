import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { RepricingEngineServices } from "../../repricing-engine/api/runtime";
import type { RepricingPolicyServices } from "../../repricing-policies/api/runtime";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import type { RepricingPolicyState } from "../../repricing-policies/domain/domain";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
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
import { createPricingHealthWhatIfAdapter, type PricingHealthWhatIf } from "./portfolio-what-if";
import type { EconomicsServices } from "../../economics/api/services";

export class PricingHealthCandidateRefusedError extends Error {
  constructor() {
    super("pricing_health_candidate_enqueue_refused");
  }
}

export type PricingHealthApplyRefusalCode =
  | "candidate_not_found"
  | "candidate_incomplete"
  | "candidate_foreign"
  | "candidate_stale"
  | "candidate_body_mismatch"
  | "adoption_gate_refused"
  | "halt_engaged"
  | "floor_binding_conflict"
  | "policy_changed"
  | "no_change";

export class PricingHealthApplyRefusedError extends Error {
  public constructor(public readonly code: PricingHealthApplyRefusalCode) {
    super(`pricing_health_apply_refused:${code}`);
    this.name = "PricingHealthApplyRefusedError";
  }
}

export type ApplyGoalRequest = Readonly<{
  dryRunId: string;
  targetRevision: number;
  targetBodyHash: string;
  candidateBodyHash: string;
  goalId: string;
  goalVersion: number;
  parameters: Readonly<Record<string, number>>;
}>;

export type ApplyGoalResult = Readonly<{
  policyId: string;
  previousRevision: number;
  revision: number;
  bodyHash: string;
  dryRunId: string;
  goalId: string;
  goalVersion: number;
  parameters: Readonly<Record<string, number>>;
  state: RepricingPolicyState;
  movement: Readonly<{ raised: number; lowered: number; held: number }>;
  alerts: Readonly<{ floorBinding: number; evidenceFloorBinding: number }>;
}>;

export function createPricingHealthServices({
  db,
  policies,
  repricingEngine,
  repricingPolicies,
  forecastLedger,
  economics,
}: Readonly<{
  db: PgQueryable;
  policies: Pick<PolicyRuntime, "resolvePolicy">;
  repricingEngine: Pick<RepricingEngineServices, "enqueueDryRun" | "getDryRun">;
  repricingPolicies: Pick<
    RepricingPolicyServices,
    "loadOwnedRepricingPolicy" | "executeOwnedRepricingPolicy" | "getHalt"
  >;
  forecastLedger: Pick<ForecastLedgerServices, "listGoalAdoptions">;
  economics?: Pick<EconomicsServices, "resolve">;
}>) {
  const whatIf = economics ? createPricingHealthWhatIfAdapter({ db, economics }) : null;
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
      bodyHash: hashRepricingDryRunBody({
        scope: state.scope,
        excludedListingIds: state.excludedListingIds,
        rules: state.rules,
        maxChangesPerDay: state.maxChangesPerDay,
      }),
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
          whatIf: null,
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
          target: {
            policyId: target.policyId,
            name: target.name,
            version: target.version,
            bodyHash: target.bodyHash,
          },
          ...stored,
          grades,
          goals: [],
          comparison: [],
          branch: target.rules.length === 0 ? "create-editor" : "advanced-editor",
          whatIf: whatIf ? await whatIf.get(accountId, now) : null,
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
        target: {
          policyId: target.policyId,
          name: target.name,
          version: target.version,
          bodyHash: target.bodyHash,
        },
        goals: goalChoices,
        comparison,
        recommendation,
        branch: "comparison",
        ...stored,
        health: currentHealth,
        run: currentHealth ? stored.run : null,
        computing: stored.computing || comparison.some(({ status }) => status === "queued" || status === "running"),
        grades,
        whatIf: whatIf ? await whatIf.get(accountId, now) : null,
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
    applyGoal: async (
      accountId: string,
      policyId: string,
      input: ApplyGoalRequest,
      context: EventStoreContext,
    ): Promise<ApplyGoalResult | null> => {
      const target = await currentTarget(accountId, policyId);
      if (!target) return null;
      if ((await repricingPolicies.getHalt(accountId)).engaged)
        throw new PricingHealthApplyRefusedError("halt_engaged");
      if (input.targetRevision !== target.version || input.targetBodyHash !== target.bodyHash) {
        if (input.targetRevision + 1 === target.version && input.candidateBodyHash === target.bodyHash) {
          const [run, loaded, goalChoices] = await Promise.all([
            repricingEngine.getDryRun(accountId, input.dryRunId),
            repricingPolicies.loadOwnedRepricingPolicy(policyId, accountId),
            choices(),
          ]);
          const selected = goalChoices.find(
            (goal) =>
              goal.goalId === input.goalId &&
              goal.goalVersion === input.goalVersion &&
              JSON.stringify(goal.parameters) === JSON.stringify(input.parameters),
          );
          if (
            run?.status === "completed" &&
            run.completedAt !== null &&
            run.summary !== null &&
            run.replacingPolicyId === policyId &&
            run.bodyHash === target.bodyHash &&
            hashRepricingDryRunBody(run.body) === run.bodyHash &&
            selected
          ) {
            const facts = await readComparisonFacts(db, {
              accountId,
              dryRunId: run.dryRunId,
              now: new Date().toISOString(),
            });
            return {
              policyId,
              previousRevision: input.targetRevision,
              revision: target.version,
              bodyHash: target.bodyHash,
              dryRunId: run.dryRunId,
              goalId: selected.goalId,
              goalVersion: selected.goalVersion,
              parameters: selected.parameters,
              state: loaded!.state,
              movement: {
                raised: facts.raised,
                lowered: facts.lowered,
                held: run.summary.listingsEvaluated - facts.raised - facts.lowered,
              },
              alerts: {
                floorBinding: run.summary?.flags["floor-binding"] ?? 0,
                evidenceFloorBinding: run.summary?.flags["evidence-floor-binding"] ?? 0,
              },
            };
          }
        }
        throw new PricingHealthApplyRefusedError("policy_changed");
      }
      if (!isOneRuleUnconditional(target.rules)) throw new PricingHealthApplyRefusedError("candidate_stale");
      const run = await repricingEngine.getDryRun(accountId, input.dryRunId);
      if (!run) throw new PricingHealthApplyRefusedError("candidate_not_found");
      if (run.replacingPolicyId !== policyId) throw new PricingHealthApplyRefusedError("candidate_foreign");
      if (run.status !== "completed" || run.completedAt === null || run.consumedAt !== null || run.summary === null)
        throw new PricingHealthApplyRefusedError("candidate_incomplete");
      if (run.bodyHash !== input.candidateBodyHash || hashRepricingDryRunBody(run.body) !== run.bodyHash)
        throw new PricingHealthApplyRefusedError("candidate_body_mismatch");

      const selected = (await choices()).find(
        (goal) =>
          goal.goalId === input.goalId &&
          goal.goalVersion === input.goalVersion &&
          JSON.stringify(goal.parameters) === JSON.stringify(input.parameters),
      );
      if (!selected) throw new PricingHealthApplyRefusedError("adoption_gate_refused");
      const expectedBody = buildCandidateBody(target.body, selected);
      if (hashRepricingDryRunBody(expectedBody) !== run.bodyHash)
        throw new PricingHealthApplyRefusedError("candidate_stale");

      const facts = await readComparisonFacts(db, { accountId, dryRunId: run.dryRunId, now: new Date().toISOString() });
      if (!facts.evidenceCurrent) throw new PricingHealthApplyRefusedError("candidate_stale");
      const floorBinding = run.summary.flags["floor-binding"] ?? 0;
      const evidenceFloorBinding = run.summary.flags["evidence-floor-binding"] ?? 0;
      if (floorBinding > 0 || evidenceFloorBinding > 0)
        throw new PricingHealthApplyRefusedError("floor_binding_conflict");

      if (hashRepricingDryRunBody(expectedBody) === target.bodyHash)
        throw new PricingHealthApplyRefusedError("no_change");
      let state: RepricingPolicyState;
      try {
        state = (await repricingPolicies.executeOwnedRepricingPolicy({
          policyId,
          accountId,
          context,
          command: {
            type: "ReviseRepricingPolicy",
            name: target.name,
            ...expectedBody,
            revisedAt: new Date().toISOString(),
          },
        })) as RepricingPolicyState;
      } catch (error) {
        const latest = await currentTarget(accountId, policyId);
        if (latest && latest.version !== target.version) throw new PricingHealthApplyRefusedError("policy_changed");
        throw error;
      }
      return {
        policyId,
        previousRevision: target.version,
        revision: target.version + 1,
        bodyHash: hashRepricingDryRunBody(expectedBody),
        dryRunId: run.dryRunId,
        goalId: selected.goalId,
        goalVersion: selected.goalVersion,
        parameters: selected.parameters,
        state,
        movement: {
          raised: facts.raised,
          lowered: facts.lowered,
          held: run.summary.listingsEvaluated - facts.raised - facts.lowered,
        },
        alerts: { floorBinding, evidenceFloorBinding },
      };
    },
  };
}

export type PricingHealthData = Readonly<{
  policies: readonly { policyId: string; name: string }[];
  target: { policyId: string; name: string; version: number; bodyHash?: string } | null;
  health: Awaited<ReturnType<typeof readPricingHealthRun>>["health"];
  run: Awaited<ReturnType<typeof readPricingHealthRun>>["run"];
  grades: readonly PricingHealthGrade[];
  computing: boolean;
  goals?: readonly GoalChoice[];
  comparison?: readonly CandidateMetrics[];
  recommendation?: Recommendation;
  branch?: "comparison" | "advanced-editor" | "create-editor";
  canCompute?: boolean;
  whatIf?: PricingHealthWhatIf | null;
}>;
export type PricingHealthServices = ReturnType<typeof createPricingHealthServices>;
