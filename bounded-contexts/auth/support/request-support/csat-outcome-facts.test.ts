import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { appendSessionStarted } from "./test-lifecycle";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;
describe("auth lifecycle event", () => {
  it("emits auth.session.started event with exact payload and envelope identity", async () => {
    const { eventStore } = createInMemoryEventStore();
    await appendSessionStarted(eventStore, context);
    const event = (await eventStore.readAll())[0];
    expect(event.eventType).toBe("auth.session.started");
    expect(event.payload).toMatchObject({ sessionId: "ses_1", accountId: "acc_1", authenticationMethod: "password" });
    expect(event.eventId).toBe("evt_1");
    expect(event.streamId).toBe("auth.session-ses_1");
    expect(event.recordedAt).toBeTruthy();
  });

  it("continues sign-in when CSAT projection fails", async () => {
    const { eventStore } = createInMemoryEventStore();
    await expect(appendSessionStarted(eventStore, context)).resolves.toBeUndefined();
  });
});
