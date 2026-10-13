import { describe, expect, it } from "vitest";
import {
  createInternalSystemTestActor,
  createTestEventStoreContext,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createInMemoryEventStore } from "../../../../identity/tests/in-memory-event-store";
import { beginAttempt, checkpoint, readAttempt } from "../api/attempt-store";
import { parseJourneyInput } from "../api/journey";
import { ATTEMPT_STAGES, bindingDigest, foldAttempt, parseAttemptBinding, type AttemptBinding } from "./attempt";

const context = createTestEventStoreContext(createInternalSystemTestActor());
export const binding: AttemptBinding = {
  version: 1,
  intent: "invitation-acceptance",
  attemptId: "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea",
  invitationId: "ivt_invited",
  accountId: "acc_invited",
  roleKey: "viewer",
  userId: "usr_recipient",
  membershipId: "mbr_reserved",
  credentialId: "crd_reserved",
  sessionId: "ses_reserved",
  emailFingerprint: "a".repeat(64),
  credentialKind: "password",
  ceremony: { id: null, externalCredentialId: null },
};

describe("invitation-acceptance-attempt-binding", () => {
  it("closes the complete binding recursively and hashes only its canonical fields", () => {
    expect(parseAttemptBinding(binding)).toEqual(binding);
    expect(bindingDigest(binding)).toBe(bindingDigest({ ...binding }));
    expect(bindingDigest({ ...binding, userId: "usr_other" })).not.toBe(bindingDigest(binding));
    for (const value of [
      { ...binding, token: "synthetic-secret" },
      { ...binding, ceremony: { id: null, password: "synthetic-secret" } },
      { ...binding, version: 2 },
      { ...binding, roleKey: "platform-admin" },
    ])
      expect(() => parseAttemptBinding(value)).toThrow();
  });
  it("refuses missing, mismatched, nested and unbounded HTTP fields", () => {
    const valid = {
      attemptId: binding.attemptId,
      invitationId: binding.invitationId,
      token: "synthetic-token",
      password: "synthetic-password",
    };
    expect(parseJourneyInput(valid, binding.attemptId)).toEqual(valid);
    for (const value of [
      { ...valid, token: { value: "secret" } },
      { ...valid, callbackUrl: "https://external.test" },
      { ...valid, password: { hash: "secret" } },
      { ...valid, token: "s".repeat(4097) },
    ])
      expect(() => parseJourneyInput(value, binding.attemptId)).toThrow();
    expect(() => parseJourneyInput(valid, "fe477381-15cc-4ca8-9a40-a004a01ee107")).toThrow();
  });
});

describe("invitation-acceptance-terminal-history", () => {
  it("invitation-acceptance-compatibility-floor refuses complete over-limit and over-byte histories", async () => {
    const store = createInMemoryEventStore();
    await beginAttempt(store, binding, context);
    const event = store.streams.get(`auth.invitation-acceptance-${binding.attemptId}`)![0];
    expect(() =>
      foldAttempt([{ ...event, payload: { ...event.payload, extra: "x".repeat(32769) } }], context.tenantId),
    ).toThrow(expect.objectContaining({ code: "invitation_attempt_ambiguous" }));
    const tooLong = Array.from({ length: 17 }, (_, index) => ({ ...event, streamVersion: index + 1 }));
    expect(() => foldAttempt(tooLong, context.tenantId)).toThrow(
      expect.objectContaining({ code: "invitation_attempt_ambiguous" }),
    );
  });
  it("retains every ordered checkpoint through restart and refuses duplicate/skipped/type-only facts", async () => {
    const store = createInMemoryEventStore();
    let state = await beginAttempt(store, binding, context);
    for (const stage of ATTEMPT_STAGES) {
      state = await checkpoint(store, state, stage, context);
      expect(await readAttempt(store, binding.attemptId, context)).toEqual(state);
    }
    expect(state.stage).toBe("completed");
    await expect(checkpoint(store, state, "registered", context)).rejects.toThrow();
    const events = store.streams.get(`auth.invitation-acceptance-${binding.attemptId}`)!;
    events[2] = { ...events[2], payload: { ...events[2].payload, stage: "completed" } };
    await expect(readAttempt(store, binding.attemptId, context)).rejects.toThrow();
  });
  it("refuses a correct-looking checkpoint with the wrong binding digest", async () => {
    const store = createInMemoryEventStore();
    await beginAttempt(store, binding, context);
    await store.appendToStream({
      streamId: `auth.invitation-acceptance-${binding.attemptId}`,
      expectedVersion: 1,
      context,
      events: [
        {
          eventType: "auth.invitation-acceptance.checkpoint",
          payload: { bindingDigest: "b".repeat(64), stage: ATTEMPT_STAGES[0], at: new Date().toISOString() },
        },
      ],
    });
    await expect(readAttempt(store, binding.attemptId, context)).rejects.toThrow();
  });
});
