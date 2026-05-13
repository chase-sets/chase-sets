import type { Projector } from "@chase-sets/event-core/projector";

const MAX_DRAIN_PASSES = 25;

export async function drainOwnedProjector(projector: Projector): Promise<void> {
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    const result = await projector.runOnce();
    if (result.processed === 0) {
      return;
    }
  }

  throw new Error(
    `Checkout projector ${projector.projectorName ?? "unknown"} did not catch up after ${MAX_DRAIN_PASSES} passes.`,
  );
}
