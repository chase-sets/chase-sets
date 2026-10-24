import type { GoalAdoption } from "../../forecast-ledger/domain/adoption-gate";
import type { RepricingDryRun, RepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import type {
  RepricingFloor,
  RepricingGuardrail,
  RepricingRule,
  RepricingRuleDirective,
} from "../../repricing-policies/domain/domain";
import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";

export type GoalChoice = Readonly<{
  goalId: string;
  goalVersion: number;
  lifecycle: "selectable";
  parameterSchema: PricingGoalDefinition["parameterSchema"];
  parameters: Readonly<Record<string, number>>;
  requiredCurveFeatures: PricingGoalDefinition["requiredCurveFeatures"];
  requiresEconomics: boolean;
}>;

export type EconomicsSet = Readonly<{ digest: string; size: number }>;
export const attentionOrder = ["economics", "value-at-risk", "floor-binding", "stale-curve"] as const;
export type AttentionReason = (typeof attentionOrder)[number];
export type AttentionValues = Readonly<
  Record<string, Readonly<Record<AttentionReason, Readonly<{ value: number; count: number }>>>>
>;

export type CandidateMetrics = Readonly<{
  goalId: string;
  goalVersion: number;
  dryRunId: string;
  status: RepricingDryRun["status"];
  requestedAt: string;
  completedAt: string | null;
  bodyHash: string;
  targetPolicyId: string;
  targetRevision: number;
  listingCount: number | null;
  raised: number | null;
  lowered: number | null;
  held: number | null;
  heldReasons: Readonly<Record<string, number>>;
  value: Readonly<Record<string, string>> | null;
  medianWaitDays: Readonly<Record<string, number | null>> | null;
  p90WaitDays: Readonly<Record<string, number | null>> | null;
  boundStatusCount: Readonly<Record<string, number>> | null;
  coverage: Readonly<Record<string, number>> | null;
  profitPerDay: Readonly<Record<string, number | null>> | null;
  capitalTurn: Readonly<Record<string, number | null>> | null;
  economicsSet: EconomicsSet | null;
  flags: Readonly<Record<string, number>>;
  /** The exact values shown in the apply confirmation. */
  parameters?: Readonly<Record<string, number>>;
  currencyCode?: string | null;
  floor?: RepricingFloor;
  guardrails?: readonly RepricingGuardrail[];
}>;

export type Recommendation = Readonly<{
  kind: "compute-verdict" | "halted" | "switch" | "attention" | "no-change" | "compare-goals" | "refresh";
  goalId?: string;
  goalVersion?: number;
  currency?: string;
  delta?: number;
  waitDelta?: number | null;
  raised?: number;
  lowered?: number;
  held?: number;
  reason?: AttentionReason;
  count?: number;
  affectedListedValue?: number;
}>;

export function selectableGoalChoices(
  definitions: readonly PricingGoalDefinition[],
  adoptions: readonly GoalAdoption[],
): readonly GoalChoice[] {
  const adoptionByKey = new Map(adoptions.map((entry) => [`${entry.goalId}@${entry.goalVersion}`, entry]));
  return definitions
    .filter(
      (definition) =>
        definition.lifecycle === "selectable" &&
        adoptionByKey.get(`${definition.id}@${definition.version}`)?.selectable === true,
    )
    .map((definition) => ({
      goalId: definition.id,
      goalVersion: definition.version,
      lifecycle: "selectable",
      parameterSchema: definition.parameterSchema,
      parameters: Object.fromEntries(
        Object.entries(definition.parameterSchema).map(([key, bounds]) => [key, bounds.default]),
      ),
      requiredCurveFeatures: definition.requiredCurveFeatures,
      requiresEconomics: definition.requiresEconomics,
    }));
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
    rules: [{ ...target.rules[0]!, directive: replaceGoalDirective(target.rules[0]!.directive, choice) }],
  };
}

type RecommendationHealth = Readonly<{
  currencies: Readonly<
    Record<
      string,
      {
        profitPerDay: Readonly<{ value: number | null }>;
        expectedWait?: Readonly<{ medianDays: number | null }>;
      }
    >
  >;
}>;

export function recommendGoalChange(
  input: Readonly<{
    currentHealth: RecommendationHealth | null;
    currentEconomicsSet: EconomicsSet | null;
    candidates: readonly CandidateMetrics[];
    haltEngaged: boolean;
    expectedCandidateCount?: number;
    attentionValues?: AttentionValues;
  }>,
): Recommendation {
  if (!input.currentHealth) return { kind: "compute-verdict" };
  if (input.haltEngaged) return { kind: "halted" };
  const currentCurrencies = Object.keys(input.currentHealth.currencies);
  const complete = input.candidates.filter((candidate) => candidate.status === "completed" && candidate.value !== null);
  if (complete.some((candidate) => !sameEconomicsSet(candidate.economicsSet, input.currentEconomicsSet)))
    return { kind: "refresh" };
  const currency = currentCurrencies.length === 1 ? currentCurrencies[0] : undefined;
  const currentProfit = currency ? input.currentHealth.currencies[currency]?.profitPerDay.value : null;
  const better =
    currency && currentProfit != null && Number.isFinite(currentProfit)
      ? complete
          .filter((candidate) => {
            const next = candidate.profitPerDay?.[currency];
            return (
              Object.keys(candidate.value ?? {}).length === 1 &&
              candidate.value?.[currency] !== undefined &&
              next != null &&
              Number.isFinite(next) &&
              roundedProfit(next, currency) > roundedProfit(currentProfit, currency)
            );
          })
          .sort(
            (a, b) =>
              roundedProfit(b.profitPerDay![currency]!, currency) -
                roundedProfit(a.profitPerDay![currency]!, currency) ||
              (b.capitalTurn?.[currency] ?? -Infinity) - (a.capitalTurn?.[currency] ?? -Infinity) ||
              (a.medianWaitDays?.[currency] ?? Infinity) - (b.medianWaitDays?.[currency] ?? Infinity) ||
              a.goalId.localeCompare(b.goalId) ||
              a.goalVersion - b.goalVersion,
          )[0]
      : undefined;
  if (better && currency) {
    const currentWait = input.currentHealth.currencies[currency]?.expectedWait?.medianDays;
    const nextWait = better.medianWaitDays?.[currency];
    return {
      kind: "switch",
      goalId: better.goalId,
      goalVersion: better.goalVersion,
      currency,
      delta: roundedProfit(better.profitPerDay![currency]!, currency) - roundedProfit(currentProfit!, currency),
      waitDelta: currentWait != null && nextWait != null ? nextWait - currentWait : null,
      raised: better.raised ?? 0,
      lowered: better.lowered ?? 0,
      held: better.held ?? 0,
    };
  }
  // Amounts in different currencies are never added or ranked against one another.
  const attention = currency
    ? attentionOrder
        .map((reason) => ({
          reason,
          ...input.attentionValues?.[currency]?.[reason],
        }))
        .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]
    : undefined;
  if (attention && (attention.value ?? 0) > 0)
    return {
      kind: "attention",
      currency,
      reason: attention.reason,
      count: attention.count,
      affectedListedValue: attention.value,
    };
  if (!complete.length || complete.length < (input.expectedCandidateCount ?? input.candidates.length))
    return { kind: "compare-goals" };
  return { kind: "no-change" };
}

function sameEconomicsSet(left: EconomicsSet | null, right: EconomicsSet | null): boolean {
  return left !== null && right !== null && left.size === right.size && left.digest === right.digest;
}

function roundedProfit(value: number, currency: string): number {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  const scale = 10 ** (digits ?? 2);
  return Math.round(value * scale) / scale;
}
