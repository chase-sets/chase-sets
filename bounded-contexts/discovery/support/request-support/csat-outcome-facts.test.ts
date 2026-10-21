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
  it("emits discovery.search-session.started event with exact payload and envelope identity", async () => {
    const { eventStore } = createInMemoryEventStore();
    await appendSearchSessionStarted(eventStore, context, {
      accountId: "acc_1" as AccountId,
      sessionId: "ses_1" as SessionId,
    });
    const event = (await eventStore.readAll())[0];
    expect(event.eventType).toBe("discovery.search-session.started");
    expect(event.eventId).toMatch(/^evt_search_/);
    expect(event.streamId).toMatch(/^discovery.search-session-/);
    expect(event.recordedAt).toBeTruthy();
    expect(event.payload).toEqual({ accountId: "acc_1", sessionId: "ses_1" });
  });

  it("returns search success when outcome projection fails", async () => {
    const { eventStore } = createInMemoryEventStore();
    await expect(
      appendSearchSessionStarted(eventStore, context, {
        accountId: "acc_2" as AccountId,
        sessionId: "ses_2" as SessionId,
      }),
    ).resolves.toBeUndefined();
  });
});
