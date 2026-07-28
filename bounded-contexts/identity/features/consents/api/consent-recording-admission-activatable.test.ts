import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

/**
 * The activation half of the recording admission, which is only reachable once
 * the publication half passes. Every shipped artifact is
 * `consentActivatable: false`, so exactly one build-time input is substituted
 * here -- the compiled publication record. The closed member registry, the
 * decider, the runtime admission, the authority stream and the route below are
 * all the production ones, and the shipped-corpus rejections they produce
 * instead live in the sibling `consent-recording-admission.test.ts`.
 */
vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const original = await importOriginal<typeof import("@chase-sets/public-docs")>();
  return {
    ...original,
    publicPolicyPublicationRecords: {
      ...original.publicPolicyPublicationRecords,
      "terms-of-service": {
        ...original.publicPolicyPublicationRecords["terms-of-service"],
        publicationStatus: "published",
        effectiveAt: "2026-06-01T00:00:00.000Z",
        counselApprovalReference: "counsel-2026-06-01",
        consentActivatable: true,
      },
      "seller-agreement": {
        ...original.publicPolicyPublicationRecords["seller-agreement"],
        publicationStatus: "published",
        effectiveAt: "2026-06-01T00:00:00.000Z",
        counselApprovalReference: "counsel-2026-06-01",
        consentActivatable: true,
      },
    },
  };
});

const { createInMemoryEventStore } = await import("@chase-sets/event-core/test-support");
const { createPolicyRuntime } = await import("@chase-sets/platform-policy/runtime");
const { CONSENT_SUBJECT_SCOPE_CODE, CONSENT_VERSION_NOT_ACTIVATED_CODE } = await import("../domain/consent-bundle");
const { identitySellerAgreementPolicy, identityTermsOfServicePolicy } =
  await import("../domain/terms-of-service-policy");
const { createConsentRuntime } = await import("./runtime");
const { termsOfServiceConsentRoutes } = await import("./terms-route");

type EventStoreContext = import("@chase-sets/event-core/storage").EventStoreContext;
type PgQueryable = import("@chase-sets/event-core-postgres").PgQueryable;
type IdentityApiEnv = import("../../../api").IdentityApiEnv;
type IdentityRuntimeDeps = import("../../../support/runtime-support").IdentityRuntimeDeps;
type ResolvedActor = import("@chase-sets/platform-runtime/auth").ResolvedActor;

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
};

const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
  trace: {},
};

function createHarness() {
  const { eventStore, streams } = createInMemoryEventStore();
  const db = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as PgQueryable;
  const policies = createPolicyRuntime({ eventStore, db });
  const consents = createConsentRuntime({ eventStore, db, checkpointStore: {} } as unknown as IdentityRuntimeDeps);

  return { eventStore, streams, db, policies, consents };
}

function consentStreams(streams: Map<string, unknown[]>) {
  return [...streams.keys()].filter((streamId) => streamId.startsWith("identity.consent-"));
}

async function activate(
  harness: ReturnType<typeof createHarness>,
  definition: typeof identityTermsOfServicePolicy,
  version: string,
) {
  await harness.policies.consentActivation.register(definition, context);
  await harness.policies.consentActivation.activate(
    definition,
    { version, documentId: `pol_${definition.policyKey}`, actorUserId: "usr_operator" },
    context,
  );
}

function recordTermsConsent(harness: ReturnType<typeof createHarness>, consentId: string, policyVersion: string) {
  return harness.consents.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent",
      consentId: consentId as never,
      subjectType: "user",
      userId: actor.userId as never,
      accountId: actor.accountId as never,
      policyKey: "terms-of-service",
      policyVersion,
      recordedAt: "2026-07-01T00:00:00.000Z",
    },
    context,
  });
}

describe("consent recording admission over a consent-activatable artifact", () => {
  it("rejects the published version while its authority has never activated it, and writes nothing", async () => {
    const harness = createHarness();

    await expect(recordTermsConsent(harness, "cns_placeholder", "v1")).rejects.toMatchObject({
      code: CONSENT_VERSION_NOT_ACTIVATED_CODE,
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("admits the exact active version once the authority activates it", async () => {
    const harness = createHarness();
    await activate(harness, identityTermsOfServicePolicy, "v1");

    const result = await recordTermsConsent(harness, "cns_ok", "v1");

    expect(result.state.status).toBe("recorded");
    expect(consentStreams(harness.streams)).toEqual(["identity.consent-cns_ok"]);
  });

  it("rejects recording after the authority deactivates the version, and writes nothing", async () => {
    const harness = createHarness();
    await activate(harness, identityTermsOfServicePolicy, "v1");
    await harness.policies.consentActivation.deactivate(
      identityTermsOfServicePolicy,
      { actorUserId: "usr_operator" },
      context,
    );

    await expect(recordTermsConsent(harness, "cns_after", "v1")).rejects.toMatchObject({
      code: CONSENT_VERSION_NOT_ACTIVATED_CODE,
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("still refuses an account-scoped subject for a user-scoped bundle member, activation notwithstanding", async () => {
    const harness = createHarness();
    await activate(harness, identityTermsOfServicePolicy, "v1");

    await expect(
      harness.consents.commandHandler({
        streamId: "identity.consent-cns_scope",
        command: {
          type: "RecordConsent",
          consentId: "cns_scope" as never,
          subjectType: "account",
          userId: actor.userId as never,
          accountId: "acc_victim" as never,
          policyKey: "terms-of-service",
          policyVersion: "v1",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ code: CONSENT_SUBJECT_SCOPE_CODE });

    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("records an account-scoped bundle member for the exact account, capturing the acting member", async () => {
    const harness = createHarness();
    await activate(harness, identitySellerAgreementPolicy, "v1");

    const result = await harness.consents.commandHandler({
      streamId: "identity.consent-cns_seller",
      command: {
        type: "RecordConsent",
        consentId: "cns_seller" as never,
        subjectType: "account",
        userId: actor.userId as never,
        accountId: actor.accountId as never,
        policyKey: "seller-agreement",
        policyVersion: "v1",
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
      context,
    });

    expect(result.state).toMatchObject({
      status: "recorded",
      subjectType: "account",
      accountId: actor.accountId,
      userId: actor.userId,
    });
  });

  it("refuses a user-scoped subject for an account-scoped bundle member, activation notwithstanding", async () => {
    const harness = createHarness();
    await activate(harness, identitySellerAgreementPolicy, "v1");

    await expect(
      harness.consents.commandHandler({
        streamId: "identity.consent-cns_seller_user",
        command: {
          type: "RecordConsent",
          consentId: "cns_seller_user" as never,
          subjectType: "user",
          userId: actor.userId as never,
          accountId: actor.accountId as never,
          policyKey: "seller-agreement",
          policyVersion: "v1",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ code: CONSENT_SUBJECT_SCOPE_CODE });

    expect(consentStreams(harness.streams)).toEqual([]);
  });
});

describe("the authenticated acceptance route over a consent-activatable artifact", () => {
  function buildApp(harness: ReturnType<typeof createHarness>) {
    const app = new Hono<IdentityApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    app.route(
      "/consents/terms-of-service",
      termsOfServiceConsentRoutes({ db: harness.db, policies: harness.policies, consents: harness.consents }),
    );
    return app;
  }

  it("cannot record acceptance of a version the authority has not activated", async () => {
    const harness = createHarness();

    const response = await buildApp(harness).request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: CONSENT_VERSION_NOT_ACTIVATED_CODE },
    });
    expect(consentStreams(harness.streams)).toEqual([]);
  });

  it("records acceptance once the active version is activated", async () => {
    const harness = createHarness();
    await activate(harness, identityTermsOfServicePolicy, "v1");

    const response = await buildApp(harness).request("/consents/terms-of-service/accept", { method: "POST" });

    expect(response.status).toBe(201);
    expect(consentStreams(harness.streams)).toHaveLength(1);
  });
});
