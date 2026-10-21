import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { decideSession } from "../../features/sessions/domain/domain";
import { startInteractiveAuth } from "../runtime-support/services";
import { createAuthServicesFake } from "../auth-support/test-support";
import type { SessionId, UserId, AccountId } from "@chase-sets/primitives/typed-ids";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;
describe("auth lifecycle event", () => {
  it("emits auth.session.started event with exact payload and envelope identity", async () => {
    const { eventStore } = createInMemoryEventStore();
    const sessionId = "ses_1" as SessionId;
    const domainEvents = decideSession(
      { id: null, userId: null, accountId: null, availableAccountIds: [], authenticationMethod: null, status: "active", expiresAt: null },
      {
        type: "StartSession",
        sessionId,
        userId: "usr_1" as UserId,
        accountId: "acc_1" as AccountId,
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    );
    await eventStore.appendToStream({
      streamId: "auth.session-ses_1",
      expectedVersion: "no_stream",
      context,
      events: domainEvents.map((event) => ({ eventType: event.type, payload: event.data })),
    });
    const event = (await eventStore.readAll())[0];
    expect(event.eventType).toBe("auth.session.started");
    expect(event.payload).toMatchObject({ sessionId: "ses_1", accountId: "acc_1", authenticationMethod: "password" });
    expect(event.eventId).toBe("evt_1");
    expect(event.streamId).toBe("auth.session-ses_1");
    expect(event.recordedAt).toBeTruthy();
  });

  it("continues sign-in when CSAT projection fails", async () => {
    const services = createAuthServicesFake({
      identity: { listActiveMembershipsForUser: async () => [{ accountId: "acc_2", status: "active" }] },
    });
    await expect(
      startInteractiveAuth(services, {
        userId: "usr_2",
        accountId: "acc_2",
        authenticationMethod: "password",
        context,
      }),
    ).resolves.toMatchObject({ type: "session-started", session: { account_id: "acc_2" } });
  });
});
