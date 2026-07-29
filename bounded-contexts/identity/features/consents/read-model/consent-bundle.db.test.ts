import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { module as identityModule } from "../../../index";
import { authorizeConsentForActor } from "../domain/consent-recording-authorization";
import { activateConsentPolicyForTest } from "../domain/consent-bundle-test-support";
import { createConsentRuntime, type ConsentServices } from "../api/runtime";
import { resolveConsentBundleAcceptance } from "./consent-acceptance";
import { findCurrentConsent, findSubjectConsentsForPolicies } from "./queries";

vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, [
    "terms-of-service",
    "privacy-policy",
    "seller-agreement",
    "payments-terms",
  ]);
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Identity Consent Bundle database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

const SHARED_ACCOUNT = "acc_shared" as AccountId;
const TARGET_USER = "usr_target" as UserId;
const OTHER_USER = "usr_other" as UserId;

let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
let eventStore: EventStore;
let runtime: ConsentServices;

function actorContext(userId: string, accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_identity" as never,
    audit: { performedByUserId: userId as UserId, forAccountId: accountId as AccountId },
    trace: {},
  };
}

async function projectStoredEvents(
  storedEvents: Awaited<ReturnType<ConsentServices["commandHandler"]>>["storedEvents"],
) {
  for (const storedEvent of storedEvents) {
    const event = toTransportEvent(storedEvent);
    for (const projector of runtime.projectors) {
      await projector.handlers[storedEvent.eventType]?.(event);
    }
  }
}

/** Records through the production runtime and projects, so every row under test is one the product wrote. */
async function record(
  consentId: string,
  params: Readonly<{
    subjectType: "account" | "user";
    userId: string;
    accountId: string;
    policyKey: string;
    policyVersion?: string;
  }>,
) {
  const context = actorContext(params.userId, params.accountId);
  const result = await runtime.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent",
      consentId: consentId as ConsentId,
      subjectType: params.subjectType,
      userId: params.userId as UserId,
      accountId: params.accountId as AccountId,
      policyKey: params.policyKey,
      policyVersion: params.policyVersion ?? "v1",
      recordedAt: "2026-07-28T00:00:00.000Z",
    },
    context,
    authorization: authorizeConsentForActor(context),
  });
  await projectStoredEvents(result.storedEvents);
  return result;
}

async function withdraw(consentId: string, userId: string, accountId: string) {
  const context = actorContext(userId, accountId);
  const result = await runtime.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: { type: "WithdrawConsent", withdrawnAt: "2026-07-29T00:00:00.000Z" },
    context,
    authorization: authorizeConsentForActor(context),
  });
  await projectStoredEvents(result.storedEvents);
}

const readAuthority = (policyKey: string) =>
  import("@chase-sets/platform-policy/consent-activation-authority").then((module) =>
    module.readConsentActivationAuthority(eventStore, policyKey),
  );

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
    runtime = createConsentRuntime({
      eventStore,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
      db: pools.identity,
    });
    const bootstrap = actorContext("usr_policy_operator", "acc_policy_operator");
    for (const policyKey of ["terms-of-service", "privacy-policy", "seller-agreement", "payments-terms"] as const) {
      await activateConsentPolicyForTest(eventStore, policyKey, "v1", bootstrap);
    }
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("does not let another user in the same account satisfy a user bundle", async () => {
    // Only the OTHER user's Consents exist, in the SAME account.
    await record("cns_other_terms", {
      subjectType: "user",
      userId: OTHER_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "terms-of-service",
    });
    await record("cns_other_privacy", {
      subjectType: "user",
      userId: OTHER_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "privacy-policy",
    });

    const acceptance = await resolveConsentBundleAcceptance(pools.identity, readAuthority, {
      bundleKey: "registration",
      subjectId: TARGET_USER,
    });

    expect(acceptance.requirements.map((entry) => entry.requirement.policyKey)).toEqual([
      "terms-of-service",
      "privacy-policy",
    ]);
    expect(acceptance.satisfied).toBe(false);
    expect(acceptance.requirements.every((entry) => entry.status === null)).toBe(true);
  });

  it("does not let a user-scoped consent satisfy an account bundle for that user's account", async () => {
    // A user-scoped Seller Agreement Consent cannot exist through the product
    // (the bundle declares account scope), so the account bundle can only be
    // satisfied by an account-subject row. Prove the account bundle stays
    // unsatisfied while only user-subject rows exist for the same identifiers.
    await record("cns_user_terms", {
      subjectType: "user",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "terms-of-service",
    });

    const acceptance = await resolveConsentBundleAcceptance(pools.identity, readAuthority, {
      bundleKey: "seller-onboarding",
      subjectId: SHARED_ACCOUNT,
    });

    expect(acceptance.subjectType).toBe("account");
    expect(acceptance.satisfied).toBe(false);
    expect(acceptance.requirements.every((entry) => entry.status === null)).toBe(true);
  });

  it("satisfies an account bundle for the exact account subject and no other", async () => {
    await record("cns_seller", {
      subjectType: "account",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "seller-agreement",
    });
    await record("cns_payments", {
      subjectType: "account",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "payments-terms",
    });

    await expect(
      resolveConsentBundleAcceptance(pools.identity, readAuthority, {
        bundleKey: "seller-onboarding",
        subjectId: SHARED_ACCOUNT,
      }),
    ).resolves.toMatchObject({ satisfied: true });

    await expect(
      resolveConsentBundleAcceptance(pools.identity, readAuthority, {
        bundleKey: "seller-onboarding",
        subjectId: "acc_elsewhere",
      }),
    ).resolves.toMatchObject({ satisfied: false });
  });

  it("satisfies a user bundle for the exact user subject only", async () => {
    for (const [consentId, policyKey] of [
      ["cns_target_terms", "terms-of-service"],
      ["cns_target_privacy", "privacy-policy"],
    ] as const) {
      await record(consentId, {
        subjectType: "user",
        userId: TARGET_USER,
        accountId: SHARED_ACCOUNT,
        policyKey,
      });
    }

    await expect(
      resolveConsentBundleAcceptance(pools.identity, readAuthority, {
        bundleKey: "registration",
        subjectId: TARGET_USER,
      }),
    ).resolves.toMatchObject({ satisfied: true });

    await expect(
      resolveConsentBundleAcceptance(pools.identity, readAuthority, {
        bundleKey: "registration",
        subjectId: OTHER_USER,
      }),
    ).resolves.toMatchObject({ satisfied: false });
  });

  it.each([
    { state: "empty", plant: async () => undefined },
    {
      state: "partial",
      plant: async () => {
        await record("cns_partial", {
          subjectType: "user",
          userId: TARGET_USER,
          accountId: SHARED_ACCOUNT,
          policyKey: "terms-of-service",
        });
      },
    },
    {
      state: "withdrawn",
      plant: async () => {
        await record("cns_withdrawn_terms", {
          subjectType: "user",
          userId: TARGET_USER,
          accountId: SHARED_ACCOUNT,
          policyKey: "terms-of-service",
        });
        await record("cns_withdrawn_privacy", {
          subjectType: "user",
          userId: TARGET_USER,
          accountId: SHARED_ACCOUNT,
          policyKey: "privacy-policy",
        });
        await withdraw("cns_withdrawn_terms", TARGET_USER, SHARED_ACCOUNT);
      },
    },
    {
      state: "superseded-version",
      plant: async () => {
        // A legacy-keyed, date-shaped fact planted directly into the projection:
        // it is history that no current product path can write, and it must
        // never satisfy anything.
        await pools.identity.query(
          `INSERT INTO identity_consent_current_states
             (subject_type, subject_id, user_id, account_id, policy_key, consent_id,
              policy_version, status, recorded_at, last_event_global_position, updated_at)
           VALUES ('user', $1, $1, $2, 'terms', 'cns_legacy', '2026-03-03', 'recorded', now(), 1, now())`,
          [TARGET_USER, SHARED_ACCOUNT],
        );
      },
    },
  ])("reads a $state consent container as unsatisfied", async ({ plant }) => {
    await plant();

    await expect(
      resolveConsentBundleAcceptance(pools.identity, readAuthority, {
        bundleKey: "registration",
        subjectId: TARGET_USER,
      }),
    ).resolves.toMatchObject({ satisfied: false });
  });

  it("returns the per-bundle read in the requested key order with every column qualified", async () => {
    await record("cns_order_privacy", {
      subjectType: "user",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "privacy-policy",
    });
    await record("cns_order_terms", {
      subjectType: "user",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "terms-of-service",
    });

    const rows = await findSubjectConsentsForPolicies(pools.identity, {
      subjectType: "user",
      subjectId: TARGET_USER,
      policyKeys: ["terms-of-service", "privacy-policy"],
    });

    expect(rows.map((row) => row.policy_key)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(rows.map((row) => Number(row.ordinal))).toEqual([1, 2]);
  });

  it("keeps the shipped host-port disjunction on findCurrentConsent", async () => {
    // The pre-bundle Terms of Service host port is called by Settlement with an
    // account and no user. Narrowing this read would close a money gate, so the
    // account-only lookup must still find a user-subject Consent's account
    // context exactly as it did before.
    await record("cns_host_port", {
      subjectType: "user",
      userId: TARGET_USER,
      accountId: SHARED_ACCOUNT,
      policyKey: "terms-of-service",
    });

    await expect(
      findCurrentConsent(pools.identity, { accountId: SHARED_ACCOUNT, policyKey: "terms-of-service" }),
    ).resolves.toMatchObject({ consent_id: "cns_host_port", status: "recorded" });
    await expect(
      findCurrentConsent(pools.identity, { userId: TARGET_USER, policyKey: "terms-of-service" }),
    ).resolves.toMatchObject({ consent_id: "cns_host_port" });
  });
});
