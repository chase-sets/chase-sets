import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readConsentActivationAuthority } from "@chase-sets/platform-policy/consent-activation-authority";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../../../index";
import {
  consentBundleDeclarations,
  identityConsentPolicyPublications,
  resolveConsentBundleAgainstCorpus,
  type ConsentActivationAuthorityReader,
  type ConsentPolicyPublicationCorpus,
} from "../domain/consent-bundle";
import { identityConsentActiveVersionPolicies } from "../domain/terms-of-service-policy";
import { evaluateConsentBundleAcceptance, resolveConsentBundleAcceptance } from "./consent-bundle-acceptance";
import { findCurrentConsent, listSubjectExactCurrentConsents } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Identity Consent Bundle database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

const TERMS_ACTIVE_VERSION_POLICY_KEY = identityConsentActiveVersionPolicies["terms-of-service"].policyKey;
const PRIVACY_ACTIVE_VERSION_POLICY_KEY = identityConsentActiveVersionPolicies["privacy-policy"].policyKey;

const operatorContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_operator" as UserId,
    forAccountId: "acc_operator" as AccountId,
  },
  trace: {},
};

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
let eventStore: EventStore;
let policies: PolicyRuntime;
let authority: ConsentActivationAuthorityReader;

/**
 * Every consent policy_key in the read model is deliberately a column name
 * collision waiting to happen: the subject-exact bundle read joins the requested
 * key list in as a derived table that also carries `policy_key`. These tests
 * execute that statement against real PostgreSQL so an unqualified reference is
 * a hard failure rather than a silently-passing string assertion.
 */
async function insertCurrentState(
  params: Readonly<{
    subjectType: "user" | "account";
    subjectId: string;
    userId: string | null;
    accountId: string | null;
    policyKey: string;
    policyVersion: string;
    status: "recorded" | "withdrawn";
  }>,
): Promise<void> {
  await pools.identity.query(
    `INSERT INTO identity_consent_current_states (
       subject_type, subject_id, user_id, account_id, policy_key, consent_id, policy_version,
       status, recorded_at, withdrawn_at, last_event_global_position, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-06-01T00:00:00.000Z', $9, 1, '2026-06-01T00:00:00.000Z')`,
    [
      params.subjectType,
      params.subjectId,
      params.userId,
      params.accountId,
      params.policyKey,
      `cns_${params.subjectType}_${params.subjectId}_${params.policyKey}`,
      params.policyVersion,
      params.status,
      params.status === "withdrawn" ? "2026-06-05T00:00:00.000Z" : null,
    ],
  );
}

function activatableCorpus(
  versions: Readonly<{ termsOfService: `v${number}`; privacyPolicy: `v${number}` }>,
): ConsentPolicyPublicationCorpus {
  return {
    "terms-of-service": {
      ...identityConsentPolicyPublications["terms-of-service"],
      version: versions.termsOfService,
      publicationStatus: "published",
      consentActivatable: true,
    },
    "privacy-policy": {
      ...identityConsentPolicyPublications["privacy-policy"],
      version: versions.privacyPolicy,
      publicationStatus: "published",
      consentActivatable: true,
    },
    "seller-agreement": identityConsentPolicyPublications["seller-agreement"],
    "payments-terms": identityConsentPolicyPublications["payments-terms"],
  };
}

async function activateRegistrationMembers(): Promise<void> {
  for (const definition of [
    identityConsentActiveVersionPolicies["terms-of-service"],
    identityConsentActiveVersionPolicies["privacy-policy"],
  ]) {
    await policies.consentActivation.register(definition, operatorContext);
    await policies.consentActivation.activate(
      definition,
      { version: "v2", documentId: `pol_${definition.policyKey}`, actorUserId: "usr_operator" },
      operatorContext,
    );
  }
}

describeDb("Consent Bundle acceptance against real PostgreSQL", () => {
  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "identity_consent_bundle");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    eventStore = createPostgresEventStore({ pool: pools.identity });
    policies = createPolicyRuntime({ eventStore, db: pools.identity });
    authority = { read: (policyKey) => readConsentActivationAuthority(eventStore, policyKey) };
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("executes the subject-exact read against colliding column names", async () => {
    await insertCurrentState({
      subjectType: "user",
      subjectId: "usr_holder",
      userId: "usr_holder",
      accountId: "acc_shared",
      policyKey: "terms-of-service",
      policyVersion: "v2",
      status: "recorded",
    });

    const rows = await listSubjectExactCurrentConsents(pools.identity, {
      subjectType: "user",
      subjectId: "usr_holder",
      policyKeys: consentBundleDeclarations.registration.members,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_type: "user",
      subject_id: "usr_holder",
      policy_key: "terms-of-service",
      policy_version: "v2",
      member_ordinal: 1,
    });
    // WITH ORDINALITY yields bigint; the projection casts it so consumers get a
    // number rather than a stringified integer.
    expect(typeof rows[0].member_ordinal).toBe("number");
  });

  it("returns rows in declared member order regardless of insertion order", async () => {
    for (const policyKey of ["privacy-policy", "terms-of-service"]) {
      await insertCurrentState({
        subjectType: "user",
        subjectId: "usr_holder",
        userId: "usr_holder",
        accountId: "acc_shared",
        policyKey,
        policyVersion: "v2",
        status: "recorded",
      });
    }

    const rows = await listSubjectExactCurrentConsents(pools.identity, {
      subjectType: "user",
      subjectId: "usr_holder",
      policyKeys: consentBundleDeclarations.registration.members,
    });

    expect(rows.map((row) => row.policy_key)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(rows.map((row) => row.member_ordinal)).toEqual([1, 2]);
  });

  it("selects nothing for an empty requested key list", async () => {
    await insertCurrentState({
      subjectType: "user",
      subjectId: "usr_holder",
      userId: "usr_holder",
      accountId: "acc_shared",
      policyKey: "terms-of-service",
      policyVersion: "v2",
      status: "recorded",
    });

    await expect(
      listSubjectExactCurrentConsents(pools.identity, {
        subjectType: "user",
        subjectId: "usr_holder",
        policyKeys: [],
      }),
    ).resolves.toEqual([]);
  });

  describe("subject x consent-state matrix", () => {
    const holder = { userId: "usr_holder", accountId: "acc_shared" };

    it.each([
      {
        name: "another user in the same account holds both members",
        seed: [
          { policyKey: "terms-of-service", subjectId: "usr_other", policyVersion: "v2", status: "recorded" as const },
          { policyKey: "privacy-policy", subjectId: "usr_other", policyVersion: "v2", status: "recorded" as const },
        ],
        satisfied: false,
      },
      {
        name: "the account holds both members while the bundle is user-scoped",
        seed: [
          {
            policyKey: "terms-of-service",
            subjectId: "acc_shared",
            subjectType: "account" as const,
            policyVersion: "v2",
            status: "recorded" as const,
          },
          {
            policyKey: "privacy-policy",
            subjectId: "acc_shared",
            subjectType: "account" as const,
            policyVersion: "v2",
            status: "recorded" as const,
          },
        ],
        satisfied: false,
      },
      {
        name: "the subject holds nothing",
        seed: [],
        satisfied: false,
      },
      {
        name: "the subject holds one of two members",
        seed: [
          { policyKey: "terms-of-service", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
        ],
        satisfied: false,
      },
      {
        name: "the subject withdrew one member at the required version",
        seed: [
          { policyKey: "terms-of-service", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
          { policyKey: "privacy-policy", subjectId: "usr_holder", policyVersion: "v2", status: "withdrawn" as const },
        ],
        satisfied: false,
      },
      {
        name: "the subject holds a superseded version on one member",
        seed: [
          { policyKey: "terms-of-service", subjectId: "usr_holder", policyVersion: "v1", status: "recorded" as const },
          { policyKey: "privacy-policy", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
        ],
        satisfied: false,
      },
      {
        name: "the subject holds only a legacy terms-keyed fact",
        seed: [
          { policyKey: "terms", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
          { policyKey: "privacy-policy", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
        ],
        satisfied: false,
      },
      {
        name: "the subject holds both members at the exact required versions",
        seed: [
          { policyKey: "terms-of-service", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
          { policyKey: "privacy-policy", subjectId: "usr_holder", policyVersion: "v2", status: "recorded" as const },
        ],
        satisfied: true,
      },
    ])("reports satisfied=$satisfied when $name", async ({ seed, satisfied }) => {
      await activateRegistrationMembers();
      for (const entry of seed) {
        const subjectType = "subjectType" in entry ? entry.subjectType : ("user" as const);
        await insertCurrentState({
          subjectType,
          subjectId: entry.subjectId,
          userId: subjectType === "user" ? entry.subjectId : holder.userId,
          accountId: holder.accountId,
          policyKey: entry.policyKey,
          policyVersion: entry.policyVersion,
          status: entry.status,
        });
      }

      const resolution = await resolveConsentBundleAgainstCorpus(
        authority,
        "registration",
        activatableCorpus({ termsOfService: "v2", privacyPolicy: "v2" }),
      );
      if (!resolution.resolved) {
        throw new Error(`registration must resolve; got ${resolution.unresolvedReason}`);
      }
      expect(resolution.requirements.map((requirement) => requirement.policyKey)).toEqual([
        "terms-of-service",
        "privacy-policy",
      ]);

      const rows = await listSubjectExactCurrentConsents(pools.identity, {
        subjectType: resolution.subjectScope,
        subjectId: holder.userId,
        policyKeys: consentBundleDeclarations.registration.members,
      });

      expect(evaluateConsentBundleAcceptance(resolution, holder.userId, rows).satisfied).toBe(satisfied);
    });
  });

  it.each([
    {
      name: "another user in the same account",
      subjectType: "user" as const,
      subjectId: "usr_other",
    },
    {
      name: "the account rather than the user",
      subjectType: "account" as const,
      subjectId: "acc_shared",
    },
  ])(
    "shows the shipped or-based host read would accept $name while the subject-exact read does not",
    async ({ subjectType, subjectId }) => {
      await insertCurrentState({
        subjectType,
        subjectId,
        userId: subjectType === "user" ? subjectId : "usr_other",
        accountId: "acc_shared",
        policyKey: "terms-of-service",
        policyVersion: "v2",
        status: "recorded",
      });

      // The discriminating control: the shipped Terms host query, unchanged,
      // matches a fact that does not belong to the subject being asked about.
      const hostRow = await findCurrentConsent(pools.identity, {
        userId: "usr_holder",
        accountId: "acc_shared",
        policyKey: "terms-of-service",
      });
      expect(hostRow).not.toBeNull();
      expect(hostRow?.subject_id).toBe(subjectId);

      const subjectExact = await listSubjectExactCurrentConsents(pools.identity, {
        subjectType: "user",
        subjectId: "usr_holder",
        policyKeys: consentBundleDeclarations.registration.members,
      });
      expect(subjectExact).toEqual([]);
    },
  );

  it("resolves the shipped corpus to an empty ordered set without reading any authority stream", async () => {
    await insertCurrentState({
      subjectType: "user",
      subjectId: "usr_holder",
      userId: "usr_holder",
      accountId: "acc_shared",
      policyKey: "terms-of-service",
      policyVersion: "v1",
      status: "recorded",
    });

    const acceptance = await resolveConsentBundleAcceptance(pools.identity, authority, {
      bundleKey: "registration",
      subjectId: "usr_holder",
    });

    if (!acceptance.resolved) {
      throw new Error("the shipped corpus must resolve");
    }
    expect(acceptance.members.map((member) => member.required)).toEqual([false, false]);
    expect(acceptance.satisfied).toBe(true);

    for (const streamId of [TERMS_ACTIVE_VERSION_POLICY_KEY, PRIVACY_ACTIVE_VERSION_POLICY_KEY].map((policyKey) =>
      policies.consentActivation.streamIdFor(policyKey),
    )) {
      await expect(eventStore.readStream({ streamId })).resolves.toHaveLength(0);
    }
  });

  it("leaves the bundle unresolved when an activation contradicts its publication", async () => {
    await activateRegistrationMembers();

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      activatableCorpus({ termsOfService: "v2", privacyPolicy: "v9" }),
    );

    expect(resolution).toMatchObject({
      resolved: false,
      unresolvedPolicyKey: "privacy-policy",
      unresolvedReason: "publication-activation-version-mismatch",
    });
    // Both authorities were still read, so both guards are retained.
    expect(resolution.guards.map((binding) => binding.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
  });

  it("retains guards bound to the exact authority revision each member was read at", async () => {
    await activateRegistrationMembers();

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      activatableCorpus({ termsOfService: "v2", privacyPolicy: "v2" }),
    );

    if (!resolution.resolved) {
      throw new Error("registration must resolve");
    }
    for (const binding of resolution.guards) {
      const snapshot = await readConsentActivationAuthority(eventStore, binding.activeVersionPolicyKey);
      expect(binding.guard.expectedVersion).toBe(snapshot.authorityVersion);
      expect(binding.guard.streamId).toBe(snapshot.streamId);
    }
  });

  it("omits a member whose authority was deactivated while retaining its guard", async () => {
    await activateRegistrationMembers();
    await policies.consentActivation.deactivate(
      identityConsentActiveVersionPolicies["privacy-policy"],
      { actorUserId: "usr_operator" },
      operatorContext,
    );

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      activatableCorpus({ termsOfService: "v2", privacyPolicy: "v2" }),
    );

    if (!resolution.resolved) {
      throw new Error("registration must resolve");
    }
    expect(resolution.requirements.map((requirement) => requirement.policyKey)).toEqual(["terms-of-service"]);
    expect(resolution.outcomes).toEqual([
      expect.objectContaining({ kind: "required", policyKey: "terms-of-service" }),
      { kind: "omitted-inactive", policyKey: "privacy-policy", authorityStatus: "inactive" },
    ]);
    expect(resolution.guards.map((binding) => binding.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
  });

  it("leaves the bundle unresolved on a poisoned authority history instead of resolving a shorter set", async () => {
    await activateRegistrationMembers();
    await eventStore.appendToStream({
      streamId: policies.consentActivation.streamIdFor(PRIVACY_ACTIVE_VERSION_POLICY_KEY),
      expectedVersion: "any",
      context: operatorContext,
      events: [
        {
          eventType: "platform-policy.consent-activation-authority.activated",
          payload: {
            policyKey: PRIVACY_ACTIVE_VERSION_POLICY_KEY,
            activation: {
              version: "v3",
              documentId: "pol_privacy_v3",
              activatedAt: "2026-07-25",
              actorUserId: "usr_operator",
            },
          } as never,
        },
      ],
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      activatableCorpus({ termsOfService: "v2", privacyPolicy: "v2" }),
    );

    expect(resolution).toMatchObject({
      resolved: false,
      unresolvedPolicyKey: "privacy-policy",
      unresolvedReason: "authority-unreadable",
    });
  });

  it("keeps an account-scoped bundle reading the account subject exactly", async () => {
    await insertCurrentState({
      subjectType: "user",
      subjectId: "usr_holder",
      userId: "usr_holder",
      accountId: "acc_seller",
      policyKey: "seller-agreement",
      policyVersion: "v1",
      status: "recorded",
    });

    const rows = await listSubjectExactCurrentConsents(pools.identity, {
      subjectType: consentBundleDeclarations["seller-onboarding"].subjectScope,
      subjectId: "acc_seller",
      policyKeys: consentBundleDeclarations["seller-onboarding"].members,
    });

    // A user-scoped fact never stands in for the account-scoped bundle.
    expect(rows).toEqual([]);
  });
});
