import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { readMarketplaceRecoveryHistory } from "./history";

function reader(count: number, mutate: (events: StoredEvent[], from: number) => StoredEvent[] = (events) => events) {
  const readStream = vi.fn(async ({ fromVersion = 1, limit = 500 }) =>
    mutate(
      Array.from(
        { length: Math.max(0, Math.min(limit, count - fromVersion + 1)) },
        (_, i) =>
          ({
            streamId: "history",
            streamVersion: fromVersion + i,
            payload: { valid: true },
          }) as unknown as StoredEvent,
      ),
      fromVersion,
    ),
  );
  return { readStream } satisfies Pick<EventStore, "readStream">;
}
const fold = (count: number, event: StoredEvent) => {
  if (event.payload.valid !== true) throw new Error("poisoned fact");
  return count + 1;
};

describe("Marketplace recovery history", () => {
  it.each([501, 10_000])("folds every page of %i inclusive events", async (count) => {
    const store = reader(count);
    expect(await readMarketplaceRecoveryHistory(store, "history", 0, fold)).toEqual({ complete: true, state: count });
    expect(store.readStream).toHaveBeenCalledTimes(Math.floor(count / 500) + 1);
  });
  it("rejects event 10,001 rather than treating presence as completeness", async () => {
    expect(await readMarketplaceRecoveryHistory(reader(10_001), "history", 0, fold)).toEqual({
      complete: false,
      reason: "history-incomplete",
    });
  });
  it.each(["gap", "malformed", "loop", "poison", "wrong-stream"])("fails closed for %s", async (kind) => {
    const store = reader(1000, (events, from) =>
      events.map((event, index) => ({
        ...event,
        ...(kind === "gap" && index === 4 ? { streamVersion: event.streamVersion + 1 } : {}),
        ...(kind === "malformed" ? { streamVersion: NaN } : {}),
        ...(kind === "loop" && from > 1 ? { streamVersion: index + 1 } : {}),
        ...(kind === "poison" && index === 4 ? { payload: { valid: false } } : {}),
        ...(kind === "wrong-stream" ? { streamId: "other" } : {}),
      })),
    );
    expect(await readMarketplaceRecoveryHistory(store, "history", 0, fold)).toEqual({
      complete: false,
      reason: "history-incomplete",
    });
  });
});
