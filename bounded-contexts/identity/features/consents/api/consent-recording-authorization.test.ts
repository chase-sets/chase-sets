import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { activeSnapshot, recordingAuthorityReader } from "../../../tests/consent-activation-authority-fixtures";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
import * as bundle from "../domain/consent-bundle";
import {
  authorizeConsentForActor,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { createConsentRuntime, type ConsentServices, type RecordTermsConsentInput } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_authorized" as UserId, forAccountId: "acc_authorized" as AccountId },
};
const authorityKey = "identity.terms-of-service-active-version";

function createHarness() {
  const memory = createInMemoryEventStore();
  const readStream = vi.fn(memory.eventStore.readStream);
  const appendToStream = vi.fn(memory.eventStore.appendToStream);
  const appendToStreams = vi.fn(memory.eventStore.appendToStreams!);
  const runtime = createConsentRuntime({
    eventStore: { ...memory.eventStore, readStream, appendToStream, appendToStreams },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  });
  const activationAuthority = recordingAuthorityReader({ [authorityKey]: () => activeSnapshot(authorityKey, "v1") });
  const input: RecordTermsConsentInput = {
    streamId: "identity.consent-cns_exact",
    consentId: "cns_exact" as ConsentId,
    subjectType: "user",
    userId: context.audit.performedByUserId,
    accountId: context.audit.forAccountId,
    recordedAt: "2026-07-28T00:00:00.000Z",
    context,
    authorization: authorizeConsentForActor(context),
    activationAuthority,
  };
  return { memory, readStream, appendToStream, appendToStreams, runtime, activationAuthority, input };
}

function expectNoIo(harness: ReturnType<typeof createHarness>) {
  expect(harness.activationAuthority.reads).toEqual([]);
  expect(harness.readStream).not.toHaveBeenCalled();
  expect(harness.appendToStream).not.toHaveBeenCalled();
  expect(harness.appendToStreams).not.toHaveBeenCalled();
  expect(harness.memory.readAllEvents()).toEqual([]);
}

describe("internally resolved Terms recording", () => {
  it("authorizes before resolving even a publication-eligible active member", async () => {
    const h = createHarness();
    const resolver = vi.spyOn(bundle, "resolveConsentPolicyMemberWithProvenance").mockImplementation((reader, key) =>
      bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(reader, key, {
        ...bundle.identityConsentPolicyPublications["terms-of-service"],
        consentActivatable: true,
        version: "v1",
      }),
    );
    try {
      await expect(h.runtime.recordTermsConsent({ ...h.input, userId: "usr_foreign" as UserId })).rejects.toMatchObject(
        { code: "consent_user_not_authorized" },
      );
      expect(resolver).not.toHaveBeenCalled();
      expectNoIo(h);
    } finally {
      resolver.mockRestore();
    }
  });

  it.each([
    ["empty user", { userId: "" }],
    ["whitespace user", { userId: " " }],
    ["undefined user", { userId: undefined }],
    ["wrong user prefix", { userId: "acc_wrong" }],
    ["empty account", { accountId: "" }],
    ["whitespace account", { accountId: " " }],
    ["undefined account", { accountId: undefined }],
    ["wrong account prefix", { accountId: "usr_wrong" }],
    ["nested unknown key", { override: true }],
  ])("rejects closed-schema authorization with %s before I/O", async (_name, change) => {
    const h = createHarness();
    const authorization = {
      ...h.input.authorization,
      subject: { ...h.input.authorization.subject, ...(change as object) },
    };
    await expect(
      h.runtime.recordTermsConsent({ ...h.input, authorization } as RecordTermsConsentInput),
    ).rejects.toMatchObject({ code: "consent_authorization_malformed" });
    expectNoIo(h);
  });

  it.each([{ kind: "override" }, { authorityOverride: true }, { subject: undefined }])(
    "rejects malformed authorization envelope before I/O",
    async (change) => {
      const h = createHarness();
      await expect(
        h.runtime.recordTermsConsent({
          ...h.input,
          authorization: { ...h.input.authorization, ...change },
        } as RecordTermsConsentInput),
      ).rejects.toMatchObject({ code: "consent_authorization_malformed" });
      expectNoIo(h);
    },
  );

  it.each([
    { name: "foreign user", change: { userId: "usr_foreign" }, code: "consent_user_not_authorized" },
    { name: "invalid subject", change: { subjectType: "account" }, code: "consent_subject_invalid" },
    { name: "empty user", change: { userId: "" }, code: "consent_subject_invalid" },
    { name: "shared principal", change: { userId: "usr_guest_checkout" }, code: "consent_shared_principal_forbidden" },
    { name: "missing authorization", change: { authorization: undefined }, code: "consent_authorization_malformed" },
    {
      name: "unminted authorization",
      change: { authorization: { kind: "authorized-actor", subject: context.audit } },
      code: "consent_authorization_malformed",
    },
    {
      name: "context mismatch",
      change: { context: { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign" } } },
      code: "consent_authorization_context_mismatch",
    },
  ])("rejects $name before authority or store I/O", async ({ change, code }) => {
    const h = createHarness();
    await expect(
      h.runtime.recordTermsConsent({ ...h.input, ...change } as RecordTermsConsentInput),
    ).rejects.toMatchObject({ code });
    expectNoIo(h);
  });

  it("rejects a same-shape unminted authorization before I/O", async () => {
    const h = createHarness();
    await expect(
      h.runtime.recordTermsConsent({ ...h.input, authorization: { ...h.input.authorization } }),
    ).rejects.toMatchObject({ code: "consent_authorization_untrusted" });
    expectNoIo(h);
  });

  it("rejects a foreign stream and consent identity pairing before I/O", async () => {
    const h = createHarness();
    await expect(
      h.runtime.recordTermsConsent({ ...h.input, streamId: "identity.consent-cns_foreign" }),
    ).rejects.toThrow(/stream/i);
    expectNoIo(h);
  });

  it("publication-ineligible Terms perform zero authority reads, store reads and appends", async () => {
    const h = createHarness();
    await expect(h.runtime.recordTermsConsent(h.input)).rejects.toThrow(/active/i);
    expectNoIo(h);
  });

  it("canonical active Terms append the resolved version and decoder guard, never the authorization placeholder", async () => {
    const h = createHarness();
    const member = await bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(
      h.activationAuthority,
      "terms-of-service",
      {
        ...bundle.identityConsentPolicyPublications["terms-of-service"],
        consentActivatable: true,
        version: "v1",
      },
    );
    const resolver = vi.spyOn(bundle, "resolveConsentPolicyMemberWithProvenance").mockResolvedValue(member);
    // The actual guard is at revision two, so the valid control includes that stream.
    await h.memory.eventStore.appendToStream({
      streamId: activeSnapshot(authorityKey, "v1").streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "test.authority", payload: {} },
        { eventType: "test.authority", payload: {} },
      ],
    });
    try {
      const result = await h.runtime.recordTermsConsent(h.input);
      expect(result.state).toMatchObject({
        id: "cns_exact",
        policyKey: "terms-of-service",
        policyVersion: "v1",
        status: "recorded",
      });
      expect(result.version).toBe(1);
      expect(result.newEvents).toHaveLength(1);
      expect(result.storedEvents).toHaveLength(1);
      expect(h.appendToStream).not.toHaveBeenCalled();
      expect(h.appendToStreams).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({
          streamId: h.input.streamId,
          events: [expect.objectContaining({ payload: expect.objectContaining({ policyVersion: "v1" }) })],
        }),
        expect.objectContaining({
          streamId: activeSnapshot(authorityKey, "v1").streamId,
          expectedVersion: 2,
          events: [],
        }),
      ]);
      expect(JSON.stringify(h.appendToStreams.mock.calls)).not.toContain("authorization-only");
    } finally {
      resolver.mockRestore();
    }
  });

  it("authority movement after resolution rolls back Consent and a retry resolves a fresh guard", async () => {
    const h = createHarness();
    const streamId = activeSnapshot(authorityKey, "v1").streamId;
    await h.memory.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "platform-policy.consent-activation-authority.registered",
          payload: {
            policyKey: authorityKey,
            registration: {
              contextName: "identity",
              schemaSummary: "consent version",
              registeredAt: h.input.recordedAt,
            },
          },
        },
        {
          eventType: "platform-policy.consent-activation-authority.activated",
          payload: {
            policyKey: authorityKey,
            activation: {
              version: "v1",
              documentId: "pol_fixture",
              activatedAt: h.input.recordedAt,
              actorUserId: "usr_authorized",
            },
          },
        },
      ],
    });
    const authority = {
      read: vi.fn(async (key: string) => readConsentActivationAuthority(h.memory.eventStore, key)),
    } satisfies bundle.ConsentActivationAuthorityReader;
    const resolver = vi.spyOn(bundle, "resolveConsentPolicyMemberWithProvenance").mockImplementation((reader, key) =>
      bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(reader, key, {
        ...bundle.identityConsentPolicyPublications["terms-of-service"],
        consentActivatable: true,
        version: "v1",
      }),
    );
    h.appendToStreams.mockImplementationOnce(async (inputs) => {
      await h.memory.eventStore.appendToStream({
        streamId,
        expectedVersion: 2,
        context,
        events: [
          {
            eventType: "platform-policy.consent-activation-authority.replaced",
            payload: {
              policyKey: authorityKey,
              previousVersion: "v1",
              activation: {
                version: "v1",
                documentId: "pol_fixture_replaced",
                activatedAt: h.input.recordedAt,
                actorUserId: "usr_authorized",
              },
            },
          },
        ],
      });
      return h.memory.eventStore.appendToStreams!(inputs);
    });
    try {
      const input = { ...h.input, activationAuthority: authority };
      await expect(h.runtime.recordTermsConsent(input)).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(h.memory.streams.get(input.streamId) ?? []).toEqual([]);
      const result = await h.runtime.recordTermsConsent(input);
      expect(result.state.status).toBe("recorded");
      expect(
        h.appendToStreams.mock.calls.map(
          ([inputs]) => inputs.find((input) => input.streamId === streamId)?.expectedVersion,
        ),
      ).toEqual([2, 3]);
      expect(authority.read).toHaveBeenCalledTimes(2);
      expect(h.memory.streams.get(input.streamId)).toHaveLength(1);
    } finally {
      resolver.mockRestore();
    }
  });

  it.each(["forged", "unrelated", "unresolved"] as const)(
    "rejects %s member provenance without store I/O",
    async (kind) => {
      const h = createHarness();
      const policyKey = kind === "unrelated" ? "privacy-policy" : "terms-of-service";
      const key = `identity.${policyKey}-active-version`;
      const authority = recordingAuthorityReader({
        [key]: () => activeSnapshot(key, kind === "unresolved" ? "v2" : "v1"),
      });
      const member = await bundle.resolveConsentPolicyMemberWithProvenanceAgainstPublication(authority, policyKey, {
        ...bundle.identityConsentPolicyPublications[policyKey],
        consentActivatable: true,
        version: "v1",
      });
      const resolver = vi
        .spyOn(bundle, "resolveConsentPolicyMemberWithProvenance")
        .mockResolvedValue(kind === "forged" ? { ...member } : member);
      try {
        await expect(h.runtime.recordTermsConsent(h.input)).rejects.toMatchObject({ name: "IdentityDomainError" });
        expect(h.readStream).not.toHaveBeenCalled();
        expect(h.appendToStreams).not.toHaveBeenCalled();
        expect(h.memory.readAllEvents()).toEqual([]);
      } finally {
        resolver.mockRestore();
      }
    },
  );
});

describe("closed generic Consent admission", () => {
  it.each([
    { policyKey: "seller-agreement", policyVersion: "v999" },
    { policyKey: "privacy-policy", policyVersion: "future-v999", guards: [] },
  ])("rejects the #6815 $policyKey probe before store I/O", async (probe) => {
    const h = createHarness();
    const input = {
      streamId: h.input.streamId,
      command: {
        type: "RecordConsent",
        consentId: h.input.consentId,
        subjectType: "user",
        userId: h.input.userId,
        accountId: h.input.accountId,
        recordedAt: h.input.recordedAt,
        ...probe,
      },
      context,
      authorization: h.input.authorization,
    };
    await expect(h.runtime.commandHandler(input as never)).rejects.toThrow(/withdraw/i);
    expectNoIo(h);
  });

  it("preserves authorized withdrawal and rejects a foreign withdrawal", async () => {
    const h = createHarness();
    await h.memory.eventStore.appendToStream({
      streamId: h.input.streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "identity.consent.recorded",
          payload: {
            consentId: h.input.consentId,
            subjectType: "user",
            userId: h.input.userId,
            accountId: h.input.accountId,
            policyKey: "terms-of-service",
            policyVersion: "v1",
            recordedAt: h.input.recordedAt,
          },
        },
      ],
    });
    const withdraw = {
      streamId: h.input.streamId,
      command: { type: "WithdrawConsent" as const, withdrawnAt: "2026-07-28T01:00:00.000Z" },
      context,
      authorization: h.input.authorization,
    };
    const foreignContext = { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign" as UserId } };
    await expect(
      h.runtime.commandHandler({
        ...withdraw,
        context: foreignContext,
        authorization: authorizeConsentForActor(foreignContext),
      }),
    ).rejects.toMatchObject({ code: "consent_user_not_authorized" });
    expect(h.memory.streams.get(h.input.streamId)).toHaveLength(1);
    const result = await h.runtime.commandHandler(withdraw);
    expect(result.state.status).toBe("withdrawn");
    expect(h.memory.streams.get(h.input.streamId)).toHaveLength(2);
  });
});

// Checked by the test TypeScript project, never executed by Vitest.
function compileNegativeAdmission(
  services: ConsentServices,
  input: RecordTermsConsentInput,
  authorization: ConsentRecordingAuthorization,
) {
  const genericInput = {
    streamId: input.streamId,
    context,
    authorization,
    command: {
      type: "RecordConsent" as const,
      consentId: input.consentId,
      subjectType: "user" as const,
      policyKey: "seller-agreement",
      policyVersion: "v999",
      recordedAt: input.recordedAt,
    },
  };
  // @ts-expect-error generic RecordConsent is not a withdrawal command
  void services.commandHandler(genericInput);
  // @ts-expect-error callers cannot supply raw policy versions or guards
  void services.recordTermsConsent({ ...input, policyKey: "privacy-policy", policyVersion: "future-v999", guards: [] });
  // @ts-expect-error Terms recording is user-scoped
  void services.recordTermsConsent({ ...input, subjectType: "account" });
}
void compileNegativeAdmission;
