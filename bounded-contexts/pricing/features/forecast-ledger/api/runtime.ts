import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { PricingGoalDefinition } from "../../repricing-policies/domain/goals/registry";
import { goalAdoptions, type AdoptionGradePair, type GoalAdoption } from "../domain/adoption-gate";
import { forecastGradedEventType, type ForecastGradedEvent } from "../domain/fact";
import { gradeLedgerScope, gradingRulesVersion, type ForecastGradeScope } from "../domain/grade-ledger";
import { forecastLedgerPolicy, type ForecastLedgerPolicyValue } from "../domain/policy";
import { buildForecastLedgerProjectionHandlers } from "../read-model/projection";
import {
  getForecastGradingInput,
  getForecastGradingInputVersion,
  listForecastGrades,
  listForecastGradeScopes,
  listForecastLedgerScopeEntries,
  loadRealizedOutcomes,
  replaceForecastGrades,
  touchForecastGradingInput,
  type StoredForecastGrade,
} from "../read-model/queries";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Like the app, a scope's inputs are rechecked at most hourly, though the closer runs every few minutes. */
const RECHECK_MS = 60 * 60 * 1000;
const systemContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_pricing_system" as never, forAccountId: "acc_pricing_system" as never },
};

export type ForecastGradingResult = Readonly<{ closedOn: string; scopesGraded: number; scopesUnchanged: number }>;

export function createForecastLedgerRuntime(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: EventStore;
    policies: Pick<PolicyRuntime, "resolvePolicy">;
    goalDefinitions: () => readonly PricingGoalDefinition[];
  }>,
) {
  const resolvePolicy = async (at: string): Promise<ForecastLedgerPolicyValue> =>
    (await deps.policies.resolvePolicy(forecastLedgerPolicy, { at })).value;

  /**
   * Grades every goal version and role over the cohorts that closed at the
   * start of today's UTC day. A scope graded under the same grading rules
   * keeps its grade for the day while it was checked within the hour, or while
   * its ledger entries, realized sales, and stock are unchanged; otherwise each
   * Forecast Grade is recorded as a ForecastGraded fact before the cache moves,
   * so a crash between the two re-emits nothing new.
   */
  const runForecastGrading = async (input: Readonly<{ now?: string }> = {}): Promise<ForecastGradingResult> => {
    const now = Date.parse(input.now ?? new Date().toISOString());
    const nowIso = new Date(now).toISOString();
    const policy = await resolvePolicy(nowIso);
    const rulesVersion = gradingRulesVersion(policy);
    const closedAtMs = Math.floor(now / DAY_MS) * DAY_MS;
    const closedAt = new Date(closedAtMs).toISOString();
    const closedOn = closedAt.slice(0, 10);
    const since = new Date(closedAtMs - 2 * Math.max(...policy.horizonsDays) * DAY_MS).toISOString();
    let scopesGraded = 0;
    let scopesUnchanged = 0;
    for (const scope of await listForecastGradeScopes(deps.pool, { since, closedAt })) {
      const window = { ...scope, since, closedAt };
      const cached = await getForecastGradingInput(deps.pool, { ...scope, closedOn });
      const sameRules = cached?.rulesVersion === rulesVersion;
      if (sameRules && now - Date.parse(cached.checkedAt) < RECHECK_MS) {
        scopesUnchanged += 1;
        continue;
      }
      const inputVersion = await getForecastGradingInputVersion(deps.pool, window);
      if (sameRules && cached.inputVersion === inputVersion) {
        await touchForecastGradingInput(deps.pool, { ...scope, closedOn, checkedAt: nowIso });
        scopesUnchanged += 1;
        continue;
      }
      const [entries, outcomes] = await Promise.all([
        listForecastLedgerScopeEntries(deps.pool, window),
        loadRealizedOutcomes(deps.pool, window),
      ]);
      const grades = gradeLedgerScope(entries, outcomes, {
        horizonsDays: policy.horizonsDays,
        graceDays: policy.graceDays,
        closedAt: closedAtMs,
      });
      const gradedAt = nowIso;
      for (const graded of grades) {
        await appendForecastGraded(deps.eventStore, {
          schemaVersion: 1,
          ...scope,
          ...graded,
          closedOn,
          rulesVersion,
          inputVersion,
          gradedAt,
        });
      }
      await withPgTransaction(deps.pool, async (tx: PgQueryable) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(["pricing:forecast-grading", scope.goalId, scope.goalVersion, scope.role, closedOn]),
        ]);
        const current = await getForecastGradingInput(tx, { ...scope, closedOn });
        if (current?.rulesVersion === rulesVersion && current.inputVersion === inputVersion) return;
        await replaceForecastGrades(tx, { ...scope, closedOn, rulesVersion, inputVersion, gradedAt }, grades);
      });
      scopesGraded += 1;
    }
    return { closedOn, scopesGraded, scopesUnchanged };
  };

  /**
   * The Adoption Gate over the registered goals, from each version's latest
   * closed grades under the grading rules in force; until a rule change is
   * regraded, a version refuses for a missing grade.
   */
  const listGoalAdoptions = async (input: Readonly<{ now?: string }> = {}): Promise<readonly GoalAdoption[]> => {
    const policy = await resolvePolicy(input.now ?? new Date().toISOString());
    const rulesVersion = gradingRulesVersion(policy);
    const definitions = deps.goalDefinitions();
    const pairs = new Map<string, AdoptionGradePair | null>();
    for (const goal of definitions) {
      if (goal.version === 1 || goal.lifecycle === "retired") continue;
      for (const incumbent of definitions) {
        if (incumbent.id !== goal.id || incumbent.version >= goal.version || incumbent.lifecycle === "shadow") continue;
        const grades = (role: ForecastGradeScope["role"], goalVersion: number) =>
          listForecastGrades(deps.pool, {
            goalId: goal.id,
            goalVersion,
            role,
            forecastKind: policy.adoptedForecastKind,
            horizonDays: policy.adoptionHorizonDays,
            rulesVersion,
          });
        const [shadow, incumbentGrades] = await Promise.all([
          grades("shadow", goal.version),
          grades("incumbent", incumbent.version),
        ]);
        pairs.set(`${goal.id}@${goal.version}<${incumbent.version}`, latestGradePair(shadow, incumbentGrades));
      }
    }
    return goalAdoptions(
      definitions,
      (goalId, goalVersion, incumbentVersion) => pairs.get(`${goalId}@${goalVersion}<${incumbentVersion}`) ?? null,
    );
  };

  return {
    runForecastGrading,
    listGoalAdoptions,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "pricing-forecast-ledger-projection",
        handlers: buildForecastLedgerProjectionHandlers(deps.pool),
      }),
    ],
  };
}

export type ForecastLedgerServices = ReturnType<typeof createForecastLedgerRuntime>;

/**
 * The newest closed day with a shadow grade, beside the incumbent's grade of
 * that day under the same model; a day graded under several models compares
 * the model with the most shadow members.
 */
export function latestGradePair(
  shadow: readonly StoredForecastGrade[],
  incumbent: readonly StoredForecastGrade[],
): AdoptionGradePair | null {
  const newest = shadow[0];
  if (!newest) return null;
  const candidates = shadow
    .filter((grade) => grade.closedOn === newest.closedOn)
    .map((grade) => ({
      ...grade,
      incumbent:
        incumbent.find((other) => other.closedOn === grade.closedOn && other.model === grade.model)?.grade ?? null,
    }))
    .sort(
      (left, right) =>
        Number(right.incumbent !== null) - Number(left.incumbent !== null) ||
        right.grade.count - left.grade.count ||
        left.model.localeCompare(right.model),
    );
  const chosen = candidates[0]!;
  return {
    closedOn: chosen.closedOn,
    forecastKind: chosen.forecastKind,
    model: chosen.model,
    horizonDays: chosen.horizonDays,
    shadow: chosen.grade,
    incumbent: chosen.incumbent,
  };
}

async function appendForecastGraded(eventStore: EventStore, data: ForecastGradedEvent["data"]): Promise<void> {
  const identity = [
    data.goalId,
    data.goalVersion,
    data.role,
    data.forecastKind,
    data.model,
    data.horizonDays,
    data.closedOn,
    data.rulesVersion,
    data.inputVersion,
  ];
  try {
    await eventStore.appendToStream({
      streamId: `pricing.forecast-grade-${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
      expectedVersion: "no_stream",
      context: systemContext,
      events: [{ eventType: forecastGradedEventType, payload: data, occurredAt: data.gradedAt as never }],
    });
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "concurrency_conflict")
      throw error;
  }
}
