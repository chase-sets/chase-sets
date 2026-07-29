import { describe, expect, it, vi } from "vitest";
import { createGuestCheckoutActor } from "../../../../auth/support/runtime-support/runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  authorizeConsentForActor,
  authorizeConsentForProvisioning,
  authorizeConsentForSelfRegistration,
  type ConsentRecordingAuthorization,
} from "../domain/consent-recording-authorization";
import { activateConsentPolicyForTest } from "../domain/consent-bundle-test-support";
import { createConsentRuntime } from "./runtime";

// Terms of Service is not consent-activatable in the shipped corpus, so no
// Consent of any kind is recordable against it -- which is correct, and is
// asserted by the Consent Bundle suites. This file's subject is the WRITE-PATH
// AUTHORIZATION boundary, so it compiles against a corpus where the document is
// published and activates the authority in its harness. Every assertion below
// is otherwise unchanged: the authorization rules it proves are the same rules,
// now proven with the publication and activation halves satisfied rather than
// with them absent.
// Both a user-scoped and an account-scoped bundle member, because the
// account-scoped authorization cases below have to be proven at a policy whose
// bundle actually declares account scope: Terms of Service is a member of the
// user-scoped registration bundle, so an account-scoped Terms of Service
// recording is refused for scope now, before the authorization rule is reached.
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service", "seller-agreement"]);
});

const authorizedContext = actorContext("usr_authorized", "acc_authorized");

function actorContext(userId: string, accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
    trace: {},
  };
}

function bootstrapContext(): EventStoreContext {
  return actorContext("usr_identity_system", "acc_identity_system");
}

function createHarness() {
  const memory = createInMemoryEventStore();
  const readStream = vi.fn(memory.eventStore.readStream);
  const runtime = createConsentRuntime({
    eventStore: { ...memory.eventStore, readStream },
    checkpointStore: {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    },
    db: {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    },
  });
  return { memory, readStream, runtime };
}

/** Consent events only -- an activated harness also carries the authority's own events. */
function consentEvents(memory: ReturnType<typeof createHarness>["memory"]) {
  return memory.readAllEvents().filter((event) => event.eventType.startsWith("identity.consent."));
}

/** Activates the authority through real authority events, then clears the read spy. */
async function createActivatedHarness() {
  const harness = createHarness();
  await activateConsentPolicyForTest(harness.memory.eventStore, "terms-of-service", "v1", bootstrapContext());
  await activateConsentPolicyForTest(harness.memory.eventStore, "seller-agreement", "v1", bootstrapContext());
  harness.readStream.mockClear();
  return harness;
}

function recordInput(
  consentId: string,
  context: EventStoreContext,
  authorization: ConsentRecordingAuthorization,
  subject: Readonly<{
    subjectType?: "account" | "user";
    userId?: string;
    accountId?: string;
    policyKey?: string;
  }> = {},
) {
  return {
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent" as const,
      consentId: consentId as ConsentId,
      subjectType: subject.subjectType ?? "user",
      userId: (subject.userId ?? context.audit.performedByUserId) as UserId,
      accountId: (subject.accountId ?? context.audit.forAccountId) as AccountId,
      policyKey: subject.policyKey ?? "terms-of-service",
      policyVersion: "v1",
      recordedAt: "2026-07-28T00:00:00.000Z",
    },
    context,
    authorization,
  };
}

async function expectRejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "ConsentRecordingAuthorizationError",
    code,
  });
}

describe("Consent Recording Authorization at the production runtime", () => {
  it("rejects a consent recorded for a user other than the authorized actor, and writes nothing", async () => {
    const { memory, readStream, runtime } = createHarness();

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_foreign_user", authorizedContext, authorizeConsentForActor(authorizedContext), {
          userId: "usr_foreign",
          accountId: "acc_victim",
        }),
      ),
      "consent_user_not_authorized",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("rejects an account-scoped consent for an account other than the authorized account, and writes nothing", async () => {
    const { memory, readStream, runtime } = createHarness();

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_foreign_account", authorizedContext, authorizeConsentForActor(authorizedContext), {
          subjectType: "account",
          userId: "usr_authorized",
          accountId: "acc_foreign",
        }),
      ),
      "consent_account_not_authorized",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("rejects an account-scoped consent whose acting member is not the authorized actor, and writes nothing", async () => {
    const { memory, readStream, runtime } = createHarness();

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_foreign_actor", authorizedContext, authorizeConsentForActor(authorizedContext), {
          subjectType: "account",
          userId: "usr_foreign",
          accountId: "acc_authorized",
        }),
      ),
      "consent_acting_user_not_authorized",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it.each([
    { subjectType: "user" as const, consentId: "cns_exact_user", policyKey: "terms-of-service" },
    { subjectType: "account" as const, consentId: "cns_exact_account", policyKey: "seller-agreement" },
  ])("records the exact authorized $subjectType identity", async ({ subjectType, consentId, policyKey }) => {
    const { memory, runtime } = await createActivatedHarness();

    const result = await runtime.commandHandler(
      recordInput(consentId, authorizedContext, authorizeConsentForActor(authorizedContext), {
        subjectType,
        policyKey,
      }),
    );

    expect(result.state).toMatchObject({
      subjectType,
      userId: "usr_authorized",
      accountId: "acc_authorized",
      status: "recorded",
    });
    expect(consentEvents(memory)).toHaveLength(1);
  });

  it("refuses a shared platform principal as a consent subject", async () => {
    const guestActor = createGuestCheckoutActor(
      {
        identity: { bootstrapTenantId: "tnt_identity" },
      } as Parameters<typeof createGuestCheckoutActor>[0],
      { token_id: "gst_authorization_probe", account_id: "acc_guest" },
    );
    const sharedContexts = [createActorEventStoreContext(guestActor), bootstrapContext()];

    for (const [index, context] of sharedContexts.entries()) {
      const { memory, readStream, runtime } = createHarness();
      await expectRejected(
        runtime.commandHandler(recordInput(`cns_shared_${index}`, context, authorizeConsentForActor(context))),
        "consent_shared_principal_forbidden",
      );
      expect(readStream).not.toHaveBeenCalled();
      expect(memory.readAllEvents()).toHaveLength(0);
    }
  });

  it("rejects a foreign withdrawal through the direct handler and leaves the stream unchanged", async () => {
    const { memory, runtime } = await createActivatedHarness();
    const provisionedUserId = "usr_provisioned" as UserId;
    const provisionedAccountId = "acc_provisioned" as AccountId;
    const consentId = "cns_foreign_withdrawal";
    const bootstrap = bootstrapContext();

    await runtime.commandHandler(
      recordInput(consentId, bootstrap, authorizeConsentForProvisioning(provisionedUserId, provisionedAccountId), {
        userId: provisionedUserId,
        accountId: provisionedAccountId,
      }),
    );
    const before = [...(memory.streams.get(`identity.consent-${consentId}`) ?? [])];

    await expectRejected(
      runtime.commandHandler({
        streamId: `identity.consent-${consentId}`,
        command: {
          type: "WithdrawConsent",
          withdrawnAt: "2026-07-28T01:00:00.000Z",
        },
        context: authorizedContext,
        authorization: authorizeConsentForActor(authorizedContext),
      }),
      "consent_user_not_authorized",
    );

    expect(memory.streams.get(`identity.consent-${consentId}`)).toEqual(before);
  });

  it("refuses a registration consent aimed at an identifier this registration did not create", async () => {
    const { memory, readStream, runtime } = createHarness();
    const authorization = authorizeConsentForSelfRegistration(
      "usr_created_here" as UserId,
      "acc_created_here" as AccountId,
    );

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_registration_mismatch", bootstrapContext(), authorization, {
          userId: "usr_preexisting",
          accountId: "acc_created_here",
        }),
      ),
      "consent_registration_subject_mismatch",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("records a registration Consent for the exact identifiers minted by that registration", async () => {
    const { memory, runtime } = await createActivatedHarness();
    const userId = "usr_created_here" as UserId;
    const accountId = "acc_created_here" as AccountId;

    const result = await runtime.commandHandler(
      recordInput(
        "cns_registration_exact",
        bootstrapContext(),
        authorizeConsentForSelfRegistration(userId, accountId),
        { userId, accountId },
      ),
    );

    expect(result.state).toMatchObject({
      subjectType: "user",
      userId,
      accountId,
      status: "recorded",
    });
    expect(consentEvents(memory)).toHaveLength(1);
  });

  it("refuses provisioning aimed outside the explicitly selected identifiers", async () => {
    const { memory, readStream, runtime } = createHarness();
    const authorization = authorizeConsentForProvisioning("usr_provisioned" as UserId, "acc_provisioned" as AccountId);

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_provisioning_mismatch", bootstrapContext(), authorization, {
          userId: "usr_foreign",
          accountId: "acc_provisioned",
        }),
      ),
      "consent_provisioning_subject_mismatch",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("binds actor authorization to the exact authoritative request context", async () => {
    const { memory, readStream, runtime } = createHarness();
    const foreignContext = actorContext("usr_foreign", "acc_foreign");

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_context_mismatch", authorizedContext, authorizeConsentForActor(foreignContext)),
      ),
      "consent_authorization_context_mismatch",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it.each([
    authorizeConsentForSelfRegistration("usr_registered" as UserId, "acc_registered" as AccountId),
    authorizeConsentForProvisioning("usr_provisioned" as UserId, "acc_provisioned" as AccountId),
  ])("requires the bootstrap principal for every non-actor authorization", async (authorization) => {
    const { memory, readStream, runtime } = createHarness();

    await expectRejected(
      runtime.commandHandler(
        recordInput("cns_bootstrap_required", authorizedContext, authorization, {
          userId: authorization.subject.userId,
          accountId: authorization.subject.accountId,
        }),
      ),
      "consent_bootstrap_authorization_required",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it("cannot widen the admitted subject through the public entry point", async () => {
    const { memory, readStream, runtime } = createHarness();
    const foreignOverride = authorizeConsentForSelfRegistration("usr_foreign" as UserId, "acc_foreign" as AccountId);
    const forgedAuthorization = {
      kind: "self-registration",
      subject: {
        userId: "usr_foreign",
        accountId: "acc_foreign",
      },
    };
    const input = {
      ...recordInput("cns_no_options", authorizedContext, authorizeConsentForActor(authorizedContext), {
        userId: "usr_foreign",
        accountId: "acc_foreign",
      }),
      authorizationOverride: foreignOverride,
    };

    await expectRejected(runtime.commandHandler(input), "consent_user_not_authorized");
    await expectRejected(
      runtime.commandHandler({
        ...recordInput("cns_forged_authorization", bootstrapContext(), forgedAuthorization as never, {
          userId: "usr_foreign",
          accountId: "acc_foreign",
        }),
      }),
      "consent_authorization_untrusted",
    );
    await expectRejected(
      runtime.commandHandler({
        ...recordInput("cns_missing_authorization", authorizedContext, authorizeConsentForActor(authorizedContext)),
        authorization: undefined,
      } as never),
      "consent_authorization_malformed",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });

  it.each([
    {
      name: "empty user id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), userId: "" },
      }),
    },
    {
      name: "whitespace user id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), userId: " " },
      }),
    },
    {
      name: "undefined user id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), userId: undefined },
      }),
    },
    {
      name: "wrong user prefix",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), userId: "acc_wrong" },
      }),
    },
    {
      name: "empty account id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), accountId: "" },
      }),
    },
    {
      name: "whitespace account id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), accountId: " " },
      }),
    },
    {
      name: "undefined account id",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), accountId: undefined },
      }),
    },
    {
      name: "wrong account prefix",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), accountId: "usr_wrong" },
      }),
    },
    {
      name: "unknown authorization kind",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        kind: "override",
      }),
    },
    {
      name: "missing subject",
      mutate: (authorization: Record<string, unknown>) => ({ kind: authorization.kind }),
    },
    {
      name: "nested unknown key",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        subject: { ...(authorization.subject as object), authorityOverride: "usr_foreign" },
      }),
    },
    {
      name: "top-level unknown key",
      mutate: (authorization: Record<string, unknown>) => ({
        ...authorization,
        authorityOverride: { userId: "usr_foreign", accountId: "acc_foreign" },
      }),
    },
  ])("rejects a closed-schema authorization with $name", async ({ mutate }) => {
    const { memory, readStream, runtime } = createHarness();
    const valid = authorizeConsentForActor(authorizedContext) as unknown as Record<string, unknown>;
    const authorization = mutate(valid);

    await expectRejected(
      runtime.commandHandler({
        ...recordInput("cns_malformed", authorizedContext, valid as unknown as ConsentRecordingAuthorization),
        authorization,
      } as never),
      "consent_authorization_malformed",
    );

    expect(readStream).not.toHaveBeenCalled();
    expect(memory.readAllEvents()).toHaveLength(0);
  });
});
