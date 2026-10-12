// @vitest-environment node
import { beforeEach, describe } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { participantStoreMatrix } from "./participant-store-matrix.test-support";

describe("action-map/runtime and complete-history unit controls", () => {
  let fixture: ReturnType<typeof createInMemoryEventStore>;
  beforeEach(() => {
    fixture = createInMemoryEventStore();
  });
  participantStoreMatrix(() => fixture.eventStore);
});
