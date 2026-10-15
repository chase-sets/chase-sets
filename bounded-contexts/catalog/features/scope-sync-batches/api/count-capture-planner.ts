import {
  assertScopeSyncBatchPreviewCurrent,
  ScopeSyncBatchBlockedPreviewError,
  ScopeSyncBatchStalePreviewError,
} from "../domain/batch";
import type { ScopeSyncBatchPlanner } from "./planner";

type ConfirmationInput = Parameters<ScopeSyncBatchPlanner["resolve"]>[0] & { planFingerprint: string };
export type PreConfirmPlannerRead = Readonly<{
  comparedFingerprint: string;
  currentFingerprint: string;
  eligible: boolean;
  refusal: ScopeSyncBatchBlockedPreviewError["code"] | ScopeSyncBatchStalePreviewError["code"] | null;
  effectsCapability: false;
}>;

// The one confirmation check. Confirm and the pre-confirm planner read resolve
// the same plan and apply the same currency check. Only the planner crosses this
// boundary, so no repository, reservation, worker or enqueue capability does.
export function createScopeSyncBatchConfirmationCheck(planner: Pick<ScopeSyncBatchPlanner, "resolve">) {
  async function check(input: ConfirmationInput) {
    const current = await planner.resolve(input);
    try {
      assertScopeSyncBatchPreviewCurrent(input.planFingerprint, current.preview);
      return { current, refusal: null };
    } catch (error) {
      if (error instanceof ScopeSyncBatchBlockedPreviewError || error instanceof ScopeSyncBatchStalePreviewError)
        return { current, refusal: error };
      throw error;
    }
  }

  return {
    async resolveConfirmation(input: ConfirmationInput) {
      const { current, refusal } = await check(input);
      if (refusal) throw refusal;
      return current;
    },
    // pre-confirm-planner-read: the confirmation check's outcome, never a confirm.
    async preConfirmPlannerRead(input: ConfirmationInput): Promise<PreConfirmPlannerRead> {
      const { current, refusal } = await check(input);
      return {
        comparedFingerprint: input.planFingerprint,
        currentFingerprint: current.preview.planFingerprint,
        eligible: refusal === null,
        refusal: refusal?.code ?? null,
        effectsCapability: false,
      };
    },
  };
}
