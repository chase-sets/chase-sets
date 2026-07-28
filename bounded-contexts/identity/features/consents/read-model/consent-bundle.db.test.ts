import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// See `tests/consent-bundle-activated-corpus.test.ts` for why the compiled
// publication corpus is substituted: every shipped artifact is
// non-consent-activatable, so the activatable half of the rule is unreachable
// without replacing that one build-time input. Everything else here -- the
// event store, the authority, the projection tables, the SQL -- is real.
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
      "privacy-policy": {
        ...original.publicPolicyPublicationRecords["privacy-policy"],
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
      // `payments-terms` is deliberately left as the shipped, non-consent-activatable
      // record, so this file carries both halves of the publication rule against
      // real PostgreSQL: an activatable member that can be recorded and required,
      // and a non-activatable one that can be neither.
    },
  };
});

const { createPostgresEventStore } = await import("@chase-sets/event-core-postgres/event-store");
const { eventCorePostgresSchemaSql } = await import("@chase-sets/event-core-postgres/schema");
const {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} = await import("@chase-sets/bounded-context-runtime/test-support");
const { createPolicyRuntime } = await import("@chase-sets/platform-policy/runtime");
const { platformPolicySchemaSql } = await import("@chase-sets/platform-policy/schema");
const { createConsentRuntime } = await import("../api/runtime");
const {
  CONSENT_SUBJECT_SCOPE_CODE,
  CONSENT_VERSION_NOT_ACTIVATED_CODE,
  CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE,
  identityConsentPublicationCorpus,
  registrationConsentBundle,
  resolveConsentBundle,
  sellerOnboardingConsentBundle,
} = await import("../domain/consent-bundle");
const {
  identityPaymentsTermsPolicy,
  identityPrivacyPolicyPolicy,
  identitySellerAgreementPolicy,
  identityTermsOfServicePolicy,
} = await import("../domain/terms-of-service-policy");
const { identityConsentSchemaSql } = await import("./schema");
const { findCurrentConsentsForPolicyKeys } = await import("./queries");
const { resolveConsentBundleAcceptance } = await import("./consent-acceptance");

type IdentityRuntimeDeps = import("../../../support/runtime-support").IdentityRuntimeDeps;
type PgTransactionalPool = import("@chase-sets/event-core-postgres").PgTransactionalPool;

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
};

const SUBJECT = { userId: "usr_bundle", accountId: "acc_bundle" };

/** Streams a registration would commit across. Every one is asserted empty after a rejected append. */
const REGISTRATION_STREAM_IDS = [
  "identity.account-acc_bundle",
  "identity.user-usr_bundle",
  "identity.membership-mbr_bundle",
  "identity.consent-cns_bundle",
] as const;

describeDb("consent bundle against real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>> | undefined;
  let pool: PgTransactionalPool;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let policies: ReturnType<typeof createPolicyRuntime>;
  let consents: ReturnType<typeof createConsentRuntime>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl as string,
      ["identity"] as const,
      "identity_consent_bundle",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl as string, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(platformPolicySchemaSql);
    await pool.query(identityConsentSchemaSql);
    eventStore = createPostgresEventStore({ pool });
    policies = createPolicyRuntime({ eventStore, db: pool });
    consents = createConsentRuntime({
      eventStore,
      db: pool,
      checkpointStore: {},
    } as unknown as IdentityRuntimeDeps);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function activate(definition: typeof identityTermsOfServicePolicy, version: string) {
    await policies.consentActivation.register(definition, context);
    return policies.consentActivation.activate(
      definition,
      { version, documentId: `pol_${definition.policyKey.replace(/[^a-z0-9]/g, "_")}`, actorUserId: "usr_operator" },
      context,
    );
  }

  async function streamLengths(streamIds: readonly string[]) {
    const lengths: Record<string, number> = {};
    for (const streamId of streamIds) {
      lengths[streamId] = (await eventStore.readStream({ streamId })).length;
    }
    return lengths;
  }

  /**
   * Writes a current-state row the way the projection writes one: keyed on
   * `(subject_type, subject_id, policy_key)`, with `user_id`/`account_id` as
   * the recorded companion context. Defaults to the registration bundle's
   * subject; the scope controls below override it.
   */
  async function plantConsent(
    entry: Readonly<{
      policyKey: string;
      version: string;
      status: "recorded" | "withdrawn";
      subjectType?: "user" | "account";
      subjectId?: string;
      userId?: string;
      accountId?: string;
      consentId?: string;
    }>,
  ) {
    const subjectType = entry.subjectType ?? "user";
    const subjectId = entry.subjectId ?? (subjectType === "user" ? SUBJECT.userId : SUBJECT.accountId);
    await pool.query(
      `INSERT INTO identity_consent_current_states (
         subject_type, subject_id, user_id, account_id, policy_key, consent_id,
         policy_version, status, recorded_at, withdrawn_at, last_event_global_position, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), NULL, 1, now())`,
      [
        subjectType,
        subjectId,
        entry.userId ?? (subjectType === "user" ? subjectId : SUBJECT.userId),
        entry.accountId ?? (subjectType === "account" ? subjectId : SUBJECT.accountId),
        entry.policyKey,
        entry.consentId ?? `cns_${subjectType}_${subjectId}_${entry.policyKey}`,
        entry.version,
        entry.status,
      ],
    );
  }

  it("resolves bundle state and version from one authoritative read", async () => {
    const activated = await activate(identityTermsOfServicePolicy, "v1");
    const readSpy = vi.spyOn(policies, "resolvePolicy");

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: identityConsentPublicationCorpus,
      authority: policies.consentActivation,
    });

    // The cached policy projection is never consulted, and the version beside
    // the guard came out of the same replay that produced the guard.
    expect(readSpy).not.toHaveBeenCalled();
    expect({
      snapshot: { policyKey: "terms-of-service", version: resolution.requirements[0].version },
      policyStreamGuards: resolution.guards
        .filter((guard) => guard.policyKey === identityTermsOfServicePolicy.policyKey)
        .map((guard) => ({ policyKey: guard.policyKey, version: guard.expectedVersion })),
    }).toEqual({
      snapshot: { policyKey: "terms-of-service", version: "v1" },
      policyStreamGuards: [{ policyKey: identityTermsOfServicePolicy.policyKey, version: activated.authorityVersion }],
    });
  });

  it("rejects an append when activation changes after the bundle is resolved", async () => {
    await activate(identityTermsOfServicePolicy, "v1");

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: identityConsentPublicationCorpus,
      authority: policies.consentActivation,
    });
    const guard = resolution.guards.find((entry) => entry.policyKey === identityTermsOfServicePolicy.policyKey)!;
    const authorityLengthBefore = (await eventStore.readStream({ streamId: guard.streamId })).length;

    // Activation moves after the bundle was resolved and before the append.
    await policies.consentActivation.deactivate(identityTermsOfServicePolicy, { actorUserId: "usr_operator" }, context);

    await expect(
      eventStore.appendToStreams!([
        policies.consentActivation.guardAppendInput(guard, context),
        ...REGISTRATION_STREAM_IDS.map((streamId) => ({
          streamId,
          expectedVersion: "no_stream" as const,
          context,
          events: [{ eventType: `${streamId.split("-")[0]}.recorded`, payload: { streamId } }],
        })),
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    expect(await streamLengths(REGISTRATION_STREAM_IDS)).toEqual(
      Object.fromEntries(REGISTRATION_STREAM_IDS.map((streamId) => [streamId, 0])),
    );
    // The guard contributed nothing to the authority stream either -- only the
    // deactivation this test performed itself is there.
    expect((await eventStore.readStream({ streamId: guard.streamId })).length).toBe(authorityLengthBefore + 1);
  });

  it("rejects recording a version the authority no longer reports active, and writes nothing", async () => {
    await activate(identityTermsOfServicePolicy, "v1");
    await policies.consentActivation.deactivate(identityTermsOfServicePolicy, { actorUserId: "usr_operator" }, context);

    await expect(
      consents.commandHandler({
        streamId: "identity.consent-cns_bundle",
        command: {
          type: "RecordConsent",
          consentId: "cns_bundle" as never,
          subjectType: "user",
          userId: SUBJECT.userId as never,
          accountId: SUBJECT.accountId as never,
          policyKey: "terms-of-service",
          policyVersion: "v1",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ code: CONSENT_VERSION_NOT_ACTIVATED_CODE });

    expect((await eventStore.readStream({ streamId: "identity.consent-cns_bundle" })).length).toBe(0);
  });

  it("qualifies every shared column when reading many policy keys for one subject", async () => {
    await plantConsent({ policyKey: "terms-of-service", version: "v1", status: "recorded" });
    await plantConsent({ policyKey: "privacy-policy", version: "v1", status: "withdrawn" });
    await pool.query(
      `INSERT INTO identity_consent_current_states (
         subject_type, subject_id, user_id, account_id, policy_key, consent_id,
         policy_version, status, recorded_at, withdrawn_at, last_event_global_position, updated_at
       ) VALUES ('user', 'usr_decoy', 'usr_decoy', 'acc_decoy', 'terms-of-service', 'cns_decoy', 'v9', 'recorded', now(), NULL, 1, now())`,
    );

    const rows = await findCurrentConsentsForPolicyKeys(pool, {
      subjectType: "user",
      subjectId: SUBJECT.userId,
      policyKeys: ["terms-of-service", "privacy-policy", "seller-agreement"],
    });

    expect(rows.map((row) => [row.requested_policy_key, row.policy_key, row.policy_version, row.status])).toEqual([
      ["terms-of-service", "terms-of-service", "v1", "recorded"],
      ["privacy-policy", "privacy-policy", "v1", "withdrawn"],
    ]);
  });

  it("reads nothing for a subject whose only consent belongs to another principal in the same account", async () => {
    await plantConsent({
      policyKey: "terms-of-service",
      version: "v1",
      status: "recorded",
      subjectId: "usr_other",
      accountId: SUBJECT.accountId,
    });

    const rows = await findCurrentConsentsForPolicyKeys(pool, {
      subjectType: "user",
      subjectId: SUBJECT.userId,
      policyKeys: ["terms-of-service"],
    });

    expect(rows).toEqual([]);
  });

  it("rejects recording a member whose artifact is not consent-activatable, however the authority is set, and writes nothing", async () => {
    // `payments-terms` is a declared seller-onboarding member whose shipped
    // publication record says it may not be consented to. Activating its
    // authority does not change that -- and must not cause anything to be
    // appended anywhere.
    const activated = await activate(identityPaymentsTermsPolicy, "v1");
    const authorityStreamId = activated.streamId;
    const authorityLengthBefore = (await eventStore.readStream({ streamId: authorityStreamId })).length;

    await expect(
      consents.commandHandler({
        streamId: "identity.consent-cns_false_corpus",
        command: {
          type: "RecordConsent",
          consentId: "cns_false_corpus" as never,
          subjectType: "account",
          userId: SUBJECT.userId as never,
          accountId: SUBJECT.accountId as never,
          policyKey: "payments-terms",
          policyVersion: "v1",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
        context,
      }),
    ).rejects.toMatchObject({ code: CONSENT_VERSION_NOT_CONSENT_ACTIVATABLE_CODE });

    expect((await eventStore.readStream({ streamId: "identity.consent-cns_false_corpus" })).length).toBe(0);
    expect((await eventStore.readStream({ streamId: authorityStreamId })).length).toBe(authorityLengthBefore);
    expect(
      (await pool.query("SELECT 1 FROM identity_consent_current_states WHERE policy_key = $1", ["payments-terms"]))
        .rows,
    ).toEqual([]);
  });

  describe("consent is bound to the subject its bundle declares", () => {
    it("rejects recording a registration-bundle member against an account subject, and writes nothing", async () => {
      await activate(identityTermsOfServicePolicy, "v1");

      await expect(
        consents.commandHandler({
          streamId: "identity.consent-cns_scope_account",
          command: {
            type: "RecordConsent",
            consentId: "cns_scope_account" as never,
            subjectType: "account",
            userId: SUBJECT.userId as never,
            accountId: "acc_victim" as never,
            policyKey: "terms-of-service",
            policyVersion: "v1",
            recordedAt: "2026-07-01T00:00:00.000Z",
          },
          context,
        }),
      ).rejects.toMatchObject({ code: CONSENT_SUBJECT_SCOPE_CODE });

      expect((await eventStore.readStream({ streamId: "identity.consent-cns_scope_account" })).length).toBe(0);
    });

    it("rejects recording a seller-bundle member against a user subject, and writes nothing", async () => {
      await activate(identitySellerAgreementPolicy, "v1");

      await expect(
        consents.commandHandler({
          streamId: "identity.consent-cns_scope_user",
          command: {
            type: "RecordConsent",
            consentId: "cns_scope_user" as never,
            subjectType: "user",
            userId: SUBJECT.userId as never,
            accountId: SUBJECT.accountId as never,
            policyKey: "seller-agreement",
            policyVersion: "v1",
            recordedAt: "2026-07-01T00:00:00.000Z",
          },
          context,
        }),
      ).rejects.toMatchObject({ code: CONSENT_SUBJECT_SCOPE_CODE });

      expect((await eventStore.readStream({ streamId: "identity.consent-cns_scope_user" })).length).toBe(0);
    });

    it("does not let another user in the same account satisfy a user bundle", async () => {
      await activate(identityTermsOfServicePolicy, "v1");
      await activate(identityPrivacyPolicyPolicy, "v1");
      // Everything the bundle requires, held by a different person who happens
      // to share `SUBJECT.accountId`.
      await plantConsent({
        policyKey: "terms-of-service",
        version: "v1",
        status: "recorded",
        subjectId: "usr_other",
        accountId: SUBJECT.accountId,
      });
      await plantConsent({
        policyKey: "privacy-policy",
        version: "v1",
        status: "recorded",
        subjectId: "usr_other",
        accountId: SUBJECT.accountId,
      });

      const status = await resolveConsentBundleAcceptance(
        pool,
        registrationConsentBundle,
        { publications: identityConsentPublicationCorpus, authority: policies.consentActivation },
        SUBJECT,
      );

      expect(status.requirements).toHaveLength(2);
      expect(status.members.map((member) => member.acceptedVersion)).toEqual([null, null]);
      expect(status.satisfied).toBe(false);
    });

    it("satisfies an account bundle for the exact account subject and no other", async () => {
      await activate(identitySellerAgreementPolicy, "v1");
      await plantConsent({
        policyKey: "seller-agreement",
        version: "v1",
        status: "recorded",
        subjectType: "account",
        subjectId: "acc_seller",
        userId: "usr_seller_owner",
      });
      const deps = {
        publications: identityConsentPublicationCorpus,
        authority: policies.consentActivation,
      };

      const exact = await resolveConsentBundleAcceptance(pool, sellerOnboardingConsentBundle, deps, {
        userId: "usr_seller_owner",
        accountId: "acc_seller",
      });
      const foreign = await resolveConsentBundleAcceptance(pool, sellerOnboardingConsentBundle, deps, {
        userId: "usr_seller_owner",
        accountId: "acc_foreign",
      });

      // `payments-terms` stays out of the requirement set: declared, published,
      // and not consent-activatable.
      expect(exact.requirements.map((requirement) => requirement.policyKey)).toEqual(["seller-agreement"]);
      expect(exact.satisfied).toBe(true);
      expect(foreign.satisfied).toBe(false);
    });

    it("does not let a user-scoped consent satisfy an account bundle for that user's account", async () => {
      await activate(identitySellerAgreementPolicy, "v1");
      await plantConsent({
        policyKey: "seller-agreement",
        version: "v1",
        status: "recorded",
        subjectType: "user",
        subjectId: "usr_seller_owner",
        accountId: "acc_seller",
      });

      const status = await resolveConsentBundleAcceptance(
        pool,
        sellerOnboardingConsentBundle,
        { publications: identityConsentPublicationCorpus, authority: policies.consentActivation },
        { userId: "usr_seller_owner", accountId: "acc_seller" },
      );

      expect(status.satisfied).toBe(false);
    });
  });

  describe("bundle satisfaction is aggregate state, never row presence", () => {
    const containers = [
      ["empty", []],
      ["partial", [{ policyKey: "terms-of-service", version: "v1", status: "recorded" as const }]],
      [
        "withdrawn",
        [
          { policyKey: "terms-of-service", version: "v1", status: "withdrawn" as const },
          { policyKey: "privacy-policy", version: "v1", status: "withdrawn" as const },
        ],
      ],
      [
        "superseded-version",
        [
          { policyKey: "terms-of-service", version: "v1", status: "recorded" as const },
          { policyKey: "privacy-policy", version: "v0", status: "recorded" as const },
        ],
      ],
    ] as const;

    it.each(containers)("reads a %s consent container as unsatisfied", async (_label, planted) => {
      await activate(identityTermsOfServicePolicy, "v1");
      await activate(identityPrivacyPolicyPolicy, "v1");
      for (const entry of planted) {
        await plantConsent(entry);
      }

      const status = await resolveConsentBundleAcceptance(
        pool,
        registrationConsentBundle,
        { publications: identityConsentPublicationCorpus, authority: policies.consentActivation },
        SUBJECT,
      );

      expect(status.requirements).toHaveLength(2);
      expect(status.satisfied).toBe(false);
    });

    it("reads an exactly-accepted container as satisfied", async () => {
      await activate(identityTermsOfServicePolicy, "v1");
      await activate(identityPrivacyPolicyPolicy, "v1");
      await plantConsent({ policyKey: "terms-of-service", version: "v1", status: "recorded" });
      await plantConsent({ policyKey: "privacy-policy", version: "v1", status: "recorded" });

      const status = await resolveConsentBundleAcceptance(
        pool,
        registrationConsentBundle,
        { publications: identityConsentPublicationCorpus, authority: policies.consentActivation },
        SUBJECT,
      );

      expect(status.satisfied).toBe(true);
    });

    it("never satisfies from a legacy-keyed fact, including a date-shaped version", async () => {
      await activate(identityTermsOfServicePolicy, "v1");
      await activate(identityPrivacyPolicyPolicy, "v1");
      await plantConsent({ policyKey: "terms", version: "2026-06-15", status: "recorded" });

      const status = await resolveConsentBundleAcceptance(
        pool,
        registrationConsentBundle,
        { publications: identityConsentPublicationCorpus, authority: policies.consentActivation },
        SUBJECT,
      );

      expect(status.satisfied).toBe(false);
      expect(status.members.every((member) => member.acceptedVersion === null)).toBe(true);
    });
  });
});
