import { moneyToCents } from "@chase-sets/primitives/money";
import type { GoalAdoption } from "../../forecast-ledger/domain/adoption-gate";
import type { RepricingDryRun, RepricingDryRunBody, RepricingDryRunTrace } from "../../repricing-engine/api/dry-run";
import type { RepricingRule, RepricingRuleDirective } from "../../repricing-policies/domain/domain";
import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";

export type GoalChoice = Readonly<{
  goalId: string;
  goalVersion: number;
  label: string;
  explanation: string;
  lifecycle: "selectable";
  parameterSchema: PricingGoalDefinition["parameterSchema"];
  parameters: Readonly<Record<string, number>>;
  requiresEconomics: boolean;
  economics: Readonly<{ required: boolean; reason: string | null }>;
}>;

export type CandidateMetrics = Readonly<{
  goalId: string;
  goalVersion: number;
  dryRunId: string;
  status: RepricingDryRun["status"];
  requestedAt: string;
  completedAt: string | null;
  bodyHash: string;
  targetPolicyId: string;
  scopeLabel: "Entire selected policy candidate scope";
  listingCount: number | null;
  raised: number | null;
  lowered: number | null;
  held: number | null;
  value: Readonly<Record<string, string>> | null;
  medianWaitDays: Readonly<Record<string, number | null>> | null;
  p90WaitDays: Readonly<Record<string, number | null>> | null;
  coverage: Readonly<Record<string, number>> | null;
  profitPerDay: Readonly<Record<string, number | null>> | null;
  economicsListingIds: readonly string[];
  affectedListedValue: number | null;
  flags: Readonly<Record<string, number>>;
}>;

export type Recommendation = Readonly<{
  kind: "compute-verdict" | "halted" | "switch" | "attention" | "no-change" | "compare-goals" | "refresh";
  text: string;
  goalId?: string;
  goalVersion?: number;
  delta?: number;
  waitDelta?: number | null;
  raised?: number;
  lowered?: number;
  held?: number;
  reason?: string;
}>;

export function selectableGoalChoices(
  definitions: readonly PricingGoalDefinition[],
  adoptions: readonly GoalAdoption[],
  label: (definition: PricingGoalDefinition, parameters: Readonly<Record<string, number>>) => string = defaultGoalLabel,
  explanation: (definition: PricingGoalDefinition) => string = (definition) =>
    `${definition.id} version ${definition.version}`,
): readonly GoalChoice[] {
  const adoptionByKey = new Map(adoptions.map((entry) => [`${entry.goalId}@${entry.goalVersion}`, entry]));
  return definitions
    .filter((definition) => adoptionByKey.get(`${definition.id}@${definition.version}`)?.selectable === true)
    .map((definition) => {
      const parameters = Object.fromEntries(
        Object.entries(definition.parameterSchema).map(([key, bounds]) => [key, bounds.default]),
      );
      return {
        goalId: definition.id,
        goalVersion: definition.version,
        label: label(definition, parameters),
        explanation: explanation(definition),
        lifecycle: "selectable" as const,
        parameterSchema: definition.parameterSchema,
        parameters,
        requiresEconomics: definition.requiresEconomics,
        economics: {
          required: definition.requiresEconomics,
          reason: definition.requiresEconomics ? "Resolved per candidate listing at capture time." : null,
        },
      };
    });
}

export function isOneRuleUnconditional(rules: readonly RepricingRule[]): boolean {
  return rules.length === 1 && rules[0]?.conditions.length === 0;
}

export function replaceGoalDirective(
  directive: RepricingRuleDirective,
  choice: Pick<GoalChoice, "goalId" | "goalVersion" | "parameters">,
): RepricingRuleDirective {
  return {
    ...directive,
    anchorChain: [
      {
        source: "curve-objective",
        goalId: choice.goalId,
        goalVersion: choice.goalVersion,
        parameters: { ...choice.parameters },
      },
    ],
  };
}

export function buildCandidateBody(
  target: Readonly<Pick<RepricingDryRunBody, "scope" | "excludedListingIds" | "rules" | "maxChangesPerDay">>,
  choice: Pick<GoalChoice, "goalId" | "goalVersion" | "parameters">,
): RepricingDryRunBody {
  if (!isOneRuleUnconditional(target.rules)) throw new Error("Goal candidates require one unconditional rule.");
  return {
    scope: target.scope,
    excludedListingIds: [...(target.excludedListingIds ?? [])],
    maxChangesPerDay: target.maxChangesPerDay,
    rules: [
      {
        ...target.rules[0]!,
        directive: replaceGoalDirective(target.rules[0]!.directive, choice),
      },
    ],
  };
}

export function candidateMetrics(
  choice: Pick<GoalChoice, "goalId" | "goalVersion">,
  run: RepricingDryRun,
  traces: readonly RepricingDryRunTrace[],
): CandidateMetrics {
  const raised = traces.filter((trace) => {
    const target = cents(trace.targetPriceAmount);
    const current = cents(trace.currentPriceAmount);
    return trace.outcome === "changed" && target !== null && current !== null && target > current;
  }).length;
  const lowered = traces.filter((trace) => {
    const target = cents(trace.targetPriceAmount);
    const current = cents(trace.currentPriceAmount);
    return trace.outcome === "changed" && target !== null && current !== null && target < current;
  }).length;
  const listingCount = run.summary?.listingsEvaluated ?? (run.status === "completed" ? traces.length : null);
  const held = listingCount === null ? null : Math.max(0, listingCount - raised - lowered);
  const values: Record<string, string> = {};
  const medianWaitDays: Record<string, number | null> = {};
  const p90WaitDays: Record<string, number | null> = {};
  const coverage: Record<string, number> = {};
  const profitPerDay: Record<string, number | null> = {};
  const economicsListingIds = new Set<string>();
  const health = run.health;
  if (health) {
    for (const [currency, summary] of Object.entries(health.currencies)) {
      values[currency] = summary.modeledValueAmount;
      medianWaitDays[currency] = summary.expectedWait.medianDays;
      p90WaitDays[currency] = summary.expectedWait.p90Days;
      coverage[currency] = summary.coverage.unitRatio;
      profitPerDay[currency] = summary.profitPerDay.value;
    }
  }
  for (const trace of traces) {
    const healthTrace = trace.health;
    if (healthTrace?.economics) economicsListingIds.add(trace.listingId);
  }
  const affectedListedValue = traces.reduce((total, trace) => {
    const target = cents(trace.targetPriceAmount);
    const current = cents(trace.currentPriceAmount);
    return total + (target !== null && current !== null && target !== current ? current : 0);
  }, 0);
  return {
    goalId: choice.goalId,
    goalVersion: choice.goalVersion,
    dryRunId: run.dryRunId,
    status: run.status,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    bodyHash: run.bodyHash,
    targetPolicyId: run.replacingPolicyId ?? "",
    scopeLabel: "Entire selected policy candidate scope",
    listingCount,
    raised,
    lowered,
    held,
    value: health ? values : null,
    medianWaitDays: health ? medianWaitDays : null,
    p90WaitDays: health ? p90WaitDays : null,
    coverage: health ? coverage : null,
    profitPerDay: health ? profitPerDay : null,
    economicsListingIds: [...economicsListingIds].sort(),
    affectedListedValue: health ? affectedListedValue : null,
    flags: run.summary?.flags ?? {},
  };
}

type RecommendationHealth = Readonly<{
  currencies: Readonly<
    Record<
      string,
      Readonly<{
        profitPerDay: Readonly<{ value: number | null }>;
        coverage: Readonly<{ listingRatio: number }>;
        valueAtRisk: Readonly<{
          hopeless: Readonly<{ valueAmount: string }>;
          slow: Readonly<{ valueAmount: string }>;
        }>;
        curveAge: Readonly<{ staleCount: number }>;
        expectedWait?: Readonly<{ medianDays: number | null }>;
      }>
    >
  >;
}>;

const attentionOrder = ["economics", "value-at-risk", "floor-binding", "stale-curve"] as const;
type AttentionReason = (typeof attentionOrder)[number];

export function currentAttentionValues(
  traces: readonly RepricingDryRunTrace[],
): Readonly<Record<AttentionReason, number>> {
  const values = { economics: 0, "value-at-risk": 0, "floor-binding": 0, "stale-curve": 0 };
  for (const trace of traces) {
    const health = trace.health;
    if (!health) continue;
    const value = (cents(health.currentPriceAmount) ?? 0) * health.quantity;
    if (health.modeled && !health.economics) values.economics += value;
    if (health.risk === "hopeless" || health.risk === "slow") values["value-at-risk"] += value;
    if (trace.clamps.floor) values["floor-binding"] += value;
    if (health.modeledReason === "stale-curve") values["stale-curve"] += value;
  }
  return values;
}

export function recommendGoalChange(
  input: Readonly<{
    currentHealth: RecommendationHealth | null;
    currentEconomicsListingIds: readonly string[];
    candidates: readonly CandidateMetrics[];
    haltEngaged: boolean;
    expectedCandidateCount?: number;
    attentionValues?: Readonly<Partial<Record<AttentionReason, number>>>;
  }>,
): Recommendation {
  if (!input.currentHealth) return { kind: "compute-verdict", text: "Compute verdict" };
  if (input.haltEngaged) return { kind: "halted", text: "Repricing is halted" };
  const currentCurrencies = Object.keys(input.currentHealth.currencies);
  const complete = input.candidates.filter((candidate) => candidate.status === "completed" && candidate.value !== null);
  if (complete.some((candidate) => !sameSet(candidate.economicsListingIds, input.currentEconomicsListingIds)))
    return { kind: "refresh", text: "Refresh comparison" };
  const eligible = complete.filter(
    (candidate) =>
      currentCurrencies.length === 1 &&
      Object.keys(candidate.value ?? {}).length === 1 &&
      Object.keys(candidate.value ?? {})[0] === currentCurrencies[0],
  );
  const currency = currentCurrencies[0];
  const currentProfit = currency ? input.currentHealth.currencies[currency]?.profitPerDay.value : null;
  const better = eligible
    .filter(
      (candidate) =>
        currency &&
        currentProfit !== null &&
        currentProfit !== undefined &&
        Number.isFinite(currentProfit) &&
        Math.round((candidate.profitPerDay?.[currency] ?? Number.NEGATIVE_INFINITY) * 100) >
          Math.round(currentProfit * 100),
    )
    .sort((a, b) => (b.profitPerDay?.[currency!] ?? -Infinity) - (a.profitPerDay?.[currency!] ?? -Infinity))[0];
  if (better && currency) {
    const next = better.profitPerDay?.[currency] ?? 0;
    const currentWait = input.currentHealth.currencies[currency]?.expectedWait?.medianDays;
    const nextWait = better.medianWaitDays?.[currency];
    return {
      kind: "switch",
      text: "Switch to the leading goal",
      goalId: better.goalId,
      goalVersion: better.goalVersion,
      delta: (Math.round(next * 100) - Math.round((currentProfit ?? 0) * 100)) / 100,
      waitDelta: currentWait != null && nextWait != null ? nextWait - currentWait : null,
      raised: better.raised ?? 0,
      lowered: better.lowered ?? 0,
      held: better.held ?? 0,
    };
  }
  const attention = attentionOrder
    .map((reason) => ({ reason, score: input.attentionValues?.[reason] ?? 0 }))
    .sort((a, b) => b.score - a.score)[0];
  if (attention && attention.score > 0)
    return { kind: "attention", text: "Review affected listings before choosing a goal", reason: attention.reason };
  if (!complete.length || complete.length < (input.expectedCandidateCount ?? input.candidates.length))
    return { kind: "compare-goals", text: "Compare goals" };
  return { kind: "no-change", text: "No change recommended: current goal leads" };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function cents(value: string | null): number | null {
  if (value === null) return null;
  try {
    return Number(moneyToCents(value));
  } catch {
    return Number(value) * 100;
  }
}

function defaultGoalLabel(definition: PricingGoalDefinition, parameters: Readonly<Record<string, number>>): string {
  if (definition.id === "fixed-percentile") return `Price at the ${parameters.percentile}th market percentile`;
  if (definition.id === "target-horizon") return `Sell steadily within ${parameters.horizonDays} days`;
  if (definition.id === "profit-per-day") return "Maximize profit per day";
  return `${definition.id} v${definition.version}`;
}
