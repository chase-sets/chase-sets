import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  authorizeConsentForActor,
  authorizeConsentForSelfRegistration,
} from "../domain/consent-recording-authorization";
import {
  activateConsentPolicyForTest,
  deactivateConsentPolicyForTest,
  replaceConsentPolicyVersionForTest,
} from "../domain/consent-bundle-test-support";
import { resolveRegistrationConsentRequirements } from "../domain/consent-bundle";
import { createConsentRuntime } from "./runtime";

// Every assertion below drives the REAL `createConsentRuntime` over a real event
// store with no corpus substitution inside the production path: the compiled
// module is replaced, exactly as a build carrying a published artifact would be,
// and the unmodified entry point is then driven.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service", "privacy-policy", "seller-agreement"]);
});

const AUTHORIZED_USER = "usr_authorized" as UserId;
const AUTHORIZED_ACCOUNT = "acc_authorized" as AccountId;
const TERMS_AUTHORITY_STREAM = "platform-policy.consent-activation-authority-identity.terms-of-service-active-version";

function actorContext(userId = AUTHORIZED_USER, accountId = AUTHORIZED_ACCOUNT): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: { performedByUserId: userId, forAccountId: accountId },
    trace: {},
  };
}

function createHarness() {
  const memory = createInMemoryEventStore();
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const runtime = createConsentRuntime({
    eventStore: memory.eventStore,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    db,
  });
  return { memory, runtime, db };
}

function consentEvents(memory: ReturnType<typeof createInMemoryEventStore>) {
  return memory.readAllEvents().filter((event) => event.eventType.startsWith("identity.consent."));
}

function recordInput(
  consentId: string,
  overrides: Readonly<{
    subjectType?: "account" | "user";
    userId?: string;
    accountId?: string;
    policyKey?: string;
    policyVersion?: string;
  }> = {},
) {
  const context = actorContext();
  return {
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent" as const,
      consentId: consentId as ConsentId,
      subjectType: overrides.subjectType ?? ("user" as const),
      userId: (overrides.userId ?? AUTHORIZED_USER) as UserId,
      accountId: (overrides.accountId ?? AUTHORIZED_ACCOUNT) as AccountId,
      policyKey: overrides.policyKey ?? "terms-of-service",
      policyVersion: overrides.policyVersion ?? "v1",
      recordedAt: "2026-07-28T00:00:00.000Z",
    },
    context,
    authorization: authorizeConsentForActor(context),
  };
}

describe("Consent recording admission at the production runtime", () => {
  it("rejects a stub-version accept with a named error, writes nothing, and leaves the authority unchanged", async () => {
    // The corpus is activatable at v1; v9 is a version nobody published.
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    const authorityBefore = [...(memory.streams.get(TERMS_AUTHORITY_STREAM) ?? [])];

    await expect(runtime.commandHandler(recordInput("cns_stub", { policyVersion: "v9" }))).rejects.toMatchObject({
      name: "ConsentBundleAdmissionError",
      code: "consent_policy_version_not_published",
    });

    expect(consentEvents(memory)).toHaveLength(0);
    expect(memory.streams.get(TERMS_AUTHORITY_STREAM)).toEqual(authorityBefore);
  });

  it("rejects a published-but-unactivated version, writes nothing, and leaves the authority stream length unchanged", async () => {
    // The `fc3fddbeb` shape inverted: the corpus half satisfied, the authority
    // half not. Also covers a registered-but-never-activated authority.
    const { memory, runtime } = createHarness();
    const before = memory.readAllEvents().length;

    await expect(runtime.commandHandler(recordInput("cns_unactivated"))).rejects.toMatchObject({
      name: "ConsentActivationAdmissionError",
      code: "consent_policy_not_activated",
    });

    expect(consentEvents(memory)).toHaveLength(0);
    expect(memory.readAllEvents()).toHaveLength(before);
  });

  it("rejects a recording whose version is not the activated version", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    await replaceConsentPolicyVersionForTest(memory.eventStore, "terms-of-service", "v1", "v2", actorContext());

    await expect(runtime.commandHandler(recordInput("cns_superseded"))).rejects.toMatchObject({
      name: "ConsentActivationAdmissionError",
      code: "consent_policy_activation_version_mismatch",
    });
    expect(consentEvents(memory)).toHaveLength(0);
  });

  it("rejects a recording after the authority is deactivated", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    await deactivateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());

    await expect(runtime.commandHandler(recordInput("cns_deactivated"))).rejects.toMatchObject({
      code: "consent_policy_not_activated",
    });
    expect(consentEvents(memory)).toHaveLength(0);
  });

  it("admits and records a published, activated member at its exact version", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());

    const result = await runtime.commandHandler(recordInput("cns_admitted"));

    expect(result.state).toMatchObject({ status: "recorded", policyKey: "terms-of-service", policyVersion: "v1" });
    expect(consentEvents(memory)).toHaveLength(1);
  });

  it("rejects an append when activation changes after the bundle is resolved", async () => {
    // The activation guard is a zero-event participant in the same transaction
    // as the Consent event. Moving the authority between the read and the commit
    // invalidates the guard's expected version and rolls the whole append back.
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());

    const realAppendToStreams = memory.eventStore.appendToStreams!;
    let moved = false;
    const racingEventStore = {
      ...memory.eventStore,
      appendToStreams: async (inputs: Parameters<typeof realAppendToStreams>[0]) => {
        if (!moved) {
          moved = true;
          // Strictly between the admission's authority read and the commit.
          await replaceConsentPolicyVersionForTest(memory.eventStore, "terms-of-service", "v1", "v2", actorContext());
        }
        return realAppendToStreams(inputs);
      },
    };
    const racingRuntime = createConsentRuntime({
      eventStore: racingEventStore,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
      db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
    });

    await expect(racingRuntime.commandHandler(recordInput("cns_raced"))).rejects.toMatchObject({
      code: "concurrency_conflict",
    });

    expect(consentEvents(memory)).toHaveLength(0);
    await expect(memory.eventStore.readStream({ streamId: "identity.consent-cns_raced" })).resolves.toHaveLength(0);
  });
});

describe("the bundle admission does not bypass the consumed write-path authorization", () => {
  it("rejects the foreign-actor probe through this issue's bundle path, and writes nothing", async () => {
    // Command subject {usr_foreign, acc_victim} under audit
    // {usr_authorized, acc_authorized}, re-run with publication and activation
    // both satisfied so the request reaches the bundle admission rather than
    // stopping at an inert corpus.
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    const authorityBefore = [...(memory.streams.get(TERMS_AUTHORITY_STREAM) ?? [])];

    await expect(
      runtime.commandHandler(recordInput("cns_foreign", { userId: "usr_foreign", accountId: "acc_victim" })),
    ).rejects.toMatchObject({
      name: "ConsentRecordingAuthorizationError",
      code: "consent_user_not_authorized",
    });

    expect(consentEvents(memory)).toHaveLength(0);
    expect(memory.streams.get(TERMS_AUTHORITY_STREAM)).toEqual(authorityBefore);
  });

  it("rejects a registration-bundle member recorded against an account subject, and writes nothing", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());

    await expect(
      runtime.commandHandler(recordInput("cns_scope_account", { subjectType: "account" })),
    ).rejects.toMatchObject({ name: "ConsentBundleAdmissionError", code: "consent_bundle_scope_mismatch" });
    expect(consentEvents(memory)).toHaveLength(0);
  });

  it("rejects a seller-bundle member recorded against a user subject, and writes nothing", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "seller-agreement", "v1", actorContext());

    await expect(
      runtime.commandHandler(recordInput("cns_scope_user", { policyKey: "seller-agreement", subjectType: "user" })),
    ).rejects.toMatchObject({ name: "ConsentBundleAdmissionError", code: "consent_bundle_scope_mismatch" });
    expect(consentEvents(memory)).toHaveLength(0);
  });

  it("rejects a self-registration authorization aimed at a foreign subject through the bundle path", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    const bootstrap = actorContext("usr_identity_system" as UserId, "acc_identity_system" as AccountId);

    await expect(
      runtime.commandHandler({
        ...recordInput("cns_registration_foreign", { userId: "usr_foreign" }),
        context: bootstrap,
        authorization: authorizeConsentForSelfRegistration(AUTHORIZED_USER, AUTHORIZED_ACCOUNT),
      }),
    ).rejects.toMatchObject({ code: "consent_registration_subject_mismatch" });
    expect(consentEvents(memory)).toHaveLength(0);
  });

  it("never records a legacy-keyed Consent through the production write path", async () => {
    const { memory, runtime } = createHarness();
    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());

    for (const policyVersion of ["v1", "2026-03-03"]) {
      await expect(
        runtime.commandHandler(recordInput(`cns_legacy_${policyVersion}`, { policyKey: "terms", policyVersion })),
      ).rejects.toMatchObject({ code: "consent_policy_not_bundle_member" });
    }
    expect(consentEvents(memory)).toHaveLength(0);
  });
});

describe("bundle state and version come from one authoritative read", () => {
  it("resolves bundle state and version from one authoritative read", async () => {
    // A REAL policy runtime is composed, so `resolvePolicy` is genuinely
    // available on this path -- and is still never called, because the bundle
    // resolution reads only the activation authority's own event stream.
    const memory = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const policies = createPolicyRuntime({ eventStore: memory.eventStore, db: db as never });
    const resolvePolicy = vi.fn(policies.resolvePolicy);
    const readAuthority = vi.fn(policies.consentActivation.read);

    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    await activateConsentPolicyForTest(memory.eventStore, "privacy-policy", "v1", actorContext());

    const requirements = await resolveRegistrationConsentRequirements(readAuthority);
    const observed = {
      snapshot: {
        policyKey: "terms-of-service",
        version: requirements[0]?.version,
      },
      policyStreamGuards: [
        {
          policyKey: "identity.terms-of-service-active-version",
          version: (await readAuthority("identity.terms-of-service-active-version")).guard.expectedVersion,
        },
      ],
      resolvePolicyCalls: resolvePolicy.mock.calls.length,
    };

    // The snapshot's version and the guard's revision describe the same moment,
    // and no cached policy value took part in producing either.
    expect(observed.snapshot.version).toBe("v1");
    expect(observed.policyStreamGuards[0]?.version).toBe(2);
    expect(observed.resolvePolicyCalls).toBe(0);
    expect(resolvePolicy).not.toHaveBeenCalled();
    expect(requirements).toEqual([
      { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      { policyKey: "privacy-policy", version: "v1", href: "/privacy" },
    ]);
  });

  it("never reads a cached policy value on the recording path", async () => {
    const memory = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const policies = createPolicyRuntime({ eventStore: memory.eventStore, db: db as never });
    const resolvePolicy = vi.fn(policies.resolvePolicy);
    const runtime = createConsentRuntime({
      eventStore: memory.eventStore,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
      db,
    });

    await activateConsentPolicyForTest(memory.eventStore, "terms-of-service", "v1", actorContext());
    await runtime.commandHandler(recordInput("cns_one_read"));

    expect(resolvePolicy).not.toHaveBeenCalled();
  });
});
