import { beforeEach, describe } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { sellListAttemptCases } from "./sell-list-attempt.test-support";

describe.each([false, true])("Sell List attempt stream invariants (persisted key order: %s)", (persisted) => {
  let memory: ReturnType<typeof createInMemoryEventStore>;
  beforeEach(() => {
    memory = createInMemoryEventStore();
    if (persisted) {
      const read = memory.eventStore.readStream;
      memory = {
        ...memory,
        eventStore: {
          ...memory.eventStore,
          readStream: async (query) =>
            (await read(query)).map((event) => ({
              ...event,
              payload: JSON.parse(
                JSON.stringify(event.payload, (_key, value: unknown) =>
                  value && typeof value === "object" && !Array.isArray(value)
                    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => right.localeCompare(left)))
                    : value,
                ),
              ),
            })),
        },
      };
    }
  });
  sellListAttemptCases(() => memory.eventStore);
});
