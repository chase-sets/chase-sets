import { AsyncLocalStorage } from "node:async_hooks";
import { countFingerprint, countQueryKey } from "../domain/count-acquisition";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import {
  observeCountSourceWinners,
  type CountSourceWinner,
} from "../../source-observations/api/providers/count-capture-winners";
import type { ScopeSyncBatchPlanner } from "./planner";

type PlannerResult = Awaited<ReturnType<ScopeSyncBatchPlanner["resolve"]>>;
type Observation = { readonly plans: PlannerResult[]; readonly winners: CountSourceWinner[]; stopped: boolean };
export type CountCapturePlannerObservation<T> = Readonly<{
  value: T;
  plan: PlannerResult;
  winners: readonly CountSourceWinner[];
}>;

const observations = new AsyncLocalStorage<Observation>();

// The planner reports its own result; outside an observed read this does nothing.
export function observeCountCapturePlan(result: PlannerResult): void {
  observations.getStore()?.plans.push(structuredClone(result));
}

// Observes the one planner read `work` performs and binds every selected Scrydex
// unit's count source to exactly one winner that read selected. Missing,
// duplicate, extra or nested evidence stops the read; nothing is re-planned or
// re-read to infer what the read consumed.
export async function collectCountCapturePlannerRead<T>(
  work: () => Promise<T>,
): Promise<CountCapturePlannerObservation<T>> {
  const outer = observations.getStore();
  if (outer) {
    outer.stopped = true;
    throw new CountCaptureStopped();
  }
  const observation: Observation = { plans: [], winners: [], stopped: false };
  const value = await observations.run(observation, () =>
    observeCountSourceWinners((winner) => observation.winners.push(structuredClone(winner)), work),
  );
  const plans = [...observation.plans];
  const winners = [...observation.winners];
  if (observation.stopped || plans.length !== 1 || !winnersMatchPlan(plans[0]!, winners))
    throw new CountCaptureStopped();
  return { value, plan: plans[0]!, winners };
}

// Each winner belongs to exactly one selected Scrydex unit and no unit has two.
// A unit's winner is the source its estimate consumed, matched by query key and
// source fingerprint, or null when it consumed none; every consumed source has
// its winner. A source the plan did not consume is not this read's evidence,
// even when its totals match a consumed one.
function winnersMatchPlan(plan: PlannerResult, winners: readonly CountSourceWinner[]): boolean {
  try {
    const units = plan.plans.flatMap((scope) =>
      scope.participationPreview.units.filter((unit) => unit.selected && unit.providerKey === "scrydex"),
    );
    const claimed = new Set<(typeof units)[number]>();
    for (const winner of winners) {
      const owners = units.filter(
        (unit) =>
          unit.unitKey === winner.query.unitKey &&
          unit.profileKey === winner.query.profileKey &&
          unit.profileVersion === winner.query.profileVersion,
      );
      const unit = owners[0];
      if (owners.length !== 1 || !unit || claimed.has(unit)) return false;
      claimed.add(unit);
      const source = unit.estimate.countSource ?? null;
      if (
        source
          ? countQueryKey(winner.query) !== countQueryKey(source.query) ||
            countFingerprint(winner.source) !== countFingerprint(source)
          : winner.source !== null
      )
        return false;
    }
    return units.every((unit) => !unit.estimate.countSource || claimed.has(unit));
  } catch {
    return false;
  }
}
