import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { startInteractiveAuth } from "../runtime-support/services";
import { createAuthServicesFake } from "../auth-support/test-support";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;

describe("auth lifecycle events", () => {
  it("emits auth.session.started from the production sign-in/session entrypoint with exact payload and envelope identity", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createAuthServicesFake({
      eventStore,
      identity: { listActiveMembershipsForUser: async () => [{ accountId: "acc_1", status: "active" }] },
      sessions: {
        commandHandler: vi.fn(async (input: { command: Record<string, unknown>; streamId: string }) => {
          const storedEvents = await eventStore.appendToStream({
            streamId: input.streamId,
            expectedVersion: "no_stream",
            context,
            events: [{ eventType: "auth.session.started", payload: input.command as never }],
          });
          return {
            version: 1,
            state: {
              id: input.command.sessionId,
              userId: input.command.userId,
              accountId: input.command.accountId,
              availableAccountIds: input.command.availableAccountIds,
              authenticationMethod: input.command.authenticationMethod,
              status: "active",
              expiresAt: input.command.expiresAt,
            },
            storedEvents,
          };
        }),
      },
    });

    const result = await startInteractiveAuth(services, {
      userId: "usr_1",
      sessionId: "ses_1",
      accountId: "acc_1",
      authenticationMethod: "password",
      context,
    });

    expect(result).toMatchObject({ type: "session-started", sessionId: "ses_1" });
    const event = (await eventStore.readAll())[0];
    expect(event).toMatchObject({
      eventType: "auth.session.started",
      eventId: "evt_1",
      streamId: "auth.session-ses_1",
      tenantId: "tnt_test",
      performedByUserId: "usr_system",
      forAccountId: "acc_system",
      payload: {
        sessionId: "ses_1",
        userId: "usr_1",
        accountId: "acc_1",
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
      },
    });
    expect(event.recordedAt).toBeTruthy();
  });

  it("continues sign-in when the downstream CSAT projection fails", async () => {
    const services = createAuthServicesFake({
      identity: { listActiveMembershipsForUser: async () => [{ accountId: "acc_2", status: "active" }] },
      eventStore: {
        appendToStream: vi.fn(async () => {
          throw new Error("projection append failed");
        }),
      },
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
