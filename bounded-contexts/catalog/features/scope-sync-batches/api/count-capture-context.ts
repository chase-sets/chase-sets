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

// One planner read of the capture scope selects at most six winners; more is
// not the bounded read this observation describes.
const maxWinners = 6;
const observations = new AsyncLocalStorage<Observation>();

// The planner reports its own result; outside an observed read this does nothing.
export function observeCountCapturePlan(result: PlannerResult): void {
  observations.getStore()?.plans.push(structuredClone(result));
}

// Observes the one planner read `work` performs and binds every selected Scrydex
// unit's count source to exactly one winner that read selected. Missing,
// duplicate, extra, nested or excess evidence stops the read; nothing is
// re-planned or re-read to infer what the read consumed.
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
    observeCountSourceWinners((winner) => {
      if (observation.winners.length >= maxWinners) observation.stopped = true;
      else observation.winners.push(structuredClone(winner));
    }, work),
  );
  const plans = [...observation.plans];
  const winners = [...observation.winners];
  if (observation.stopped || plans.length !== 1 || !winnersMatchPlan(plans[0]!, winners))
    throw new CountCaptureStopped();
  return { value, plan: plans[0]!, winners };
}

function winnersMatchPlan(plan: PlannerResult, winners: readonly CountSourceWinner[]): boolean {
  try {
    const units = plan.plans.flatMap((scope) =>
      scope.participationPreview.units.filter((unit) => unit.selected && unit.providerKey === "scrydex"),
    );
    const keys = winners.map((winner) => countQueryKey(winner.query));
    if (new Set(keys).size !== keys.length) return false;
    const consumed = new Set<CountSourceWinner>();
    for (const unit of units) {
      const source = unit.estimate.countSource;
      if (!source) continue;
      const winner = winners[keys.indexOf(countQueryKey(source.query))];
      if (!winner || countFingerprint(winner.source) !== countFingerprint(source)) return false;
      consumed.add(winner);
    }
    // Any other winner must be a selected unit's read that found no current
    // source; a source the plan did not consume is not this read's evidence,
    // even when its totals match a consumed one.
    return winners.every(
      (winner) =>
        consumed.has(winner) ||
        (winner.source === null &&
          units.some(
            (unit) =>
              !unit.estimate.countSource &&
              unit.unitKey === winner.query.unitKey &&
              unit.profileKey === winner.query.profileKey &&
              unit.profileVersion === winner.query.profileVersion,
          )),
    );
  } catch {
    return false;
  }
}
