import type { ScopeSyncBatchPlanner } from "./planner";
import type { createScopeSyncBatchPlannerReads } from "./count-capture-planner";
import type { CountCaptureStore } from "../read-model/count-capture-store";
import {
  normalizeScopeSyncBatchBudget,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchSelection,
  type ScopeSyncBatchPreview,
} from "../domain/batch";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import { countCapturePlannerReadSchema } from "../domain/count-lifecycle-receipt";
import { createCountCaptureSessionBoundary, type CountCaptureSession } from "./count-capture-session";

type Input = Readonly<{ selection: ScopeSyncBatchSelection; budget?: Partial<ScopeSyncBatchBudget> | null }>;
export type CountCapturePlannerRuntime = ReturnType<typeof createCountCapturePlannerRuntime>;

// Only planner reads cross this boundary. Confirmation, reservation, batch
// persistence, worker and enqueue capabilities are intentionally absent.
export function createCountCapturePlannerRuntime(deps: {
  environment: string;
  store: Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "retainPlannerRead" | "ledger">;
  preview: (input: Parameters<ScopeSyncBatchPlanner["resolve"]>[0]) => Promise<ScopeSyncBatchPreview>;
  preConfirmPlannerRead: ReturnType<typeof createScopeSyncBatchPlannerReads>["preConfirmPlannerRead"];
  now?: () => string;
}) {
  const boundary = createCountCaptureSessionBoundary(deps);
  return {
    preview(session: CountCaptureSession, input: Input) {
      const budget = normalizeScopeSyncBatchBudget(input.budget);
      return boundary.run(session, { phase: "preview", selection: input.selection, budget }, async (binding) => {
        const observed = await collectCountCapturePlannerRead(() =>
          deps.preview({ ...input, budget, context: session.context }),
        );
        await deps.store.retainPlannerRead(
          binding,
          countCapturePlannerReadSchema.parse({
            phase: binding.phase,
            requestId: binding.requestId,
            planFingerprint: observed.plan.preview.planFingerprint,
            comparedFingerprint: null,
            eligible: observed.value.confirmAllowed,
            refusal: null,
            effectsCapability: false,
            winners: observed.winners,
          }),
        );
        return observed.value;
      });
    },
    preConfirm(session: CountCaptureSession, input: Input & { planFingerprint: string }) {
      const budget = normalizeScopeSyncBatchBudget(input.budget);
      return boundary.run(
        session,
        { phase: "pre-confirm", selection: input.selection, budget, planFingerprint: input.planFingerprint },
        async (binding) => {
          const observed = await collectCountCapturePlannerRead(() =>
            deps.preConfirmPlannerRead({ ...input, budget, context: session.context }),
          );
          const { comparedFingerprint, currentFingerprint, eligible, refusal, effectsCapability } = observed.value;
          await deps.store.retainPlannerRead(
            binding,
            countCapturePlannerReadSchema.parse({
              phase: binding.phase,
              requestId: binding.requestId,
              planFingerprint: currentFingerprint,
              comparedFingerprint,
              eligible,
              refusal,
              effectsCapability,
              winners: observed.winners,
            }),
          );
          return { comparedFingerprint, currentFingerprint, eligible, refusal, effectsCapability };
        },
      );
    },
  };
}
