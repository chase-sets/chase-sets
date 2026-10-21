import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { appendSearchSessionStarted } from "./lifecycle-events";
import type { AccountId, SessionId } from "@chase-sets/primitives/typed-ids";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;
describe("discovery lifecycle events", () => {
  it("emits search session started", async () => {
    const { eventStore } = createInMemoryEventStore();
    await appendSearchSessionStarted(eventStore, context, {
      accountId: "acc_1" as AccountId,
      sessionId: "ses_1" as SessionId,
    });
    expect((await eventStore.readAll())[0].eventType).toBe("discovery.search-session.started");
  });
});
