import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import { startInteractiveAuth } from "../runtime-support/services";
import { createAuthServicesFake } from "../auth-support/test-support";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import {
  expectHelperParity,
  expectProjectionFailure,
  expectSourceEvent,
} from "../../../customer-feedback/tests/outcome-fact-test-support";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;

async function signIn() {
  const { eventStore } = createInMemoryEventStore();
  const sessions = createSessionRuntime({
    eventStore,
    db: { query: async () => ({ rows: [] }) },
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
  });
  const services = createAuthServicesFake({
    eventStore,
    identity: { listActiveMembershipsForUser: async () => [{ accountId: "acc_1", status: "active" }] },
    sessions,
  });
  const result = await startInteractiveAuth(services, {
    userId: "usr_1",
    sessionId: "ses_1",
    accountId: "acc_1",
    authenticationMethod: "password",
    context,
  });
  const event = (await eventStore.readStream({ streamId: "auth.session-ses_1" }))[0]!;
  return { result, event, sessions };
}

describe("auth lifecycle events", () => {
  it("emits auth.session.started event with exact payload and envelope identity", async () => {
    const { result, event } = await signIn();
    expect(result).toMatchObject({ type: "session-started", sessionId: "ses_1" });
    expectSourceEvent(event, {
      eventType: "auth.session.started",
      payload: {
        sessionId: "ses_1",
        userId: "usr_1",
        accountId: "acc_1",
        availableAccountIds: ["acc_1"],
        authenticationMethod: "password",
        sessionGeneration: 0,
        expiresAt: result.type === "session-started" ? result.session.expires_at : "",
      },
      tenantId: context.tenantId,
      performedByUserId: context.audit.performedByUserId,
      forAccountId: context.audit.forAccountId,
    });
    expect(event.streamId).toBe("auth.session-ses_1");
    expect(event.recordedAt).toBe(result.type === "session-started" ? result.session.updated_at : null);
  });

  it("projects auth.session.started with helper-parity row", async () => {
    const { event } = await signIn();
    await expectHelperParity(event, {
      idempotencyKey: "auth:authentication:ses_1",
      outcomeCode: "authentication.completed",
      sourceContext: "auth",
      subjectAccountId: "acc_1",
      subjectKind: "account",
      subjectEntityType: "session",
      subjectEntityId: "ses_1",
      authenticationMethod: "password",
    });
  });

  it("continues sign-in when CSAT projection fails", async () => {
    const { result, event, sessions } = await signIn();
    await expectProjectionFailure(event);
    expect(result).toMatchObject({ type: "session-started", session: { account_id: "acc_1" } });
    await expect(sessions.getSessionState("ses_1")).resolves.toMatchObject({ status: "active" });
  });
});
