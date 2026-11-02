import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";

export const MAX_MARKETPLACE_RECOVERY_HISTORY_EVENTS = 10_000;

export async function readMarketplaceRecoveryHistory<T>(
  reader: Pick<EventStore, "readStream">,
  streamId: string,
  initial: T,
  fold: (state: T, event: StoredEvent) => T,
): Promise<{ complete: true; state: T } | { complete: false; reason: "history-incomplete" }> {
  try {
    const events = await readCompleteStream(reader, { streamId, maxEvents: MAX_MARKETPLACE_RECOVERY_HISTORY_EVENTS });
    return {
      complete: true,
      state: events.reduce((state, event) => {
        if (event.streamId !== streamId) throw new Error("Recovery history changed stream identity.");
        return fold(state, event);
      }, initial),
    };
  } catch {
    return { complete: false, reason: "history-incomplete" };
  }
}
