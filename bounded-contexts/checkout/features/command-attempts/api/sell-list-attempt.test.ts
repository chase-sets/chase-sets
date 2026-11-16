import { beforeEach, describe } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { sellListAttemptCases } from "./sell-list-attempt.test-support";

describe("Sell List attempt stream invariants", () => {
  let memory: ReturnType<typeof createInMemoryEventStore>;
  beforeEach(() => {
    memory = createInMemoryEventStore();
  });
  sellListAttemptCases(() => memory.eventStore);
});
