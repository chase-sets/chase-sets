import {
  assertScopeSyncBatchPreviewCurrent,
  ScopeSyncBatchBlockedPreviewError,
  ScopeSyncBatchStalePreviewError,
} from "../domain/batch";
import type { ScopeSyncBatchPlanner } from "./planner";

type ConfirmationInput = Parameters<ScopeSyncBatchPlanner["resolve"]>[0] & { planFingerprint: string };

// No repository, reservation, worker or enqueue capability crosses this boundary.
export function createScopeSyncBatchPlannerReads(planner: Pick<ScopeSyncBatchPlanner, "resolve">) {
  async function check(input: ConfirmationInput) {
    const current = await planner.resolve(input);
    let refusal: ScopeSyncBatchBlockedPreviewError | ScopeSyncBatchStalePreviewError | null = null;
    try {
      assertScopeSyncBatchPreviewCurrent(input.planFingerprint, current.preview);
    } catch (error) {
      if (!(error instanceof ScopeSyncBatchBlockedPreviewError || error instanceof ScopeSyncBatchStalePreviewError))
        throw error;
      refusal = error;
    }
    return { current, refusal };
  }
  return {
    async resolveConfirmation(input: ConfirmationInput) {
      const result = await check(input);
      if (result.refusal) throw result.refusal;
      return result.current;
    },
    async preConfirmPlannerRead(input: ConfirmationInput) {
      const { current, refusal } = await check(input);
      return {
        current,
        comparedFingerprint: input.planFingerprint,
        currentFingerprint: current.preview.planFingerprint,
        eligible: refusal === null,
        refusal: refusal?.code ?? null,
        effectsCapability: false as const,
      };
    },
  };
}
