import { describe, expect, it } from "vitest";
import type { AccountId, ConsentId, UserId } from "@chase-sets/primitives/typed-ids";
import { assertConsentRecordingBundleAdmission, ConsentBundleAdmissionError } from "./consent-bundle-admission";
import { identityConsentPublicationCorpus, type ConsentPublicationCorpus } from "./consent-bundle";
import { authorizeConsentForActor, type ConsentRecordingAuthorization } from "./consent-recording-authorization";
import { decideAuthorizedConsent, initialConsentState, type RecordConsentCommand } from "./domain";
import type { IdentityConsentPolicyKey } from "./terms-of-service-policy";

const AUTHORIZED_USER = "usr_authorized" as UserId;
const AUTHORIZED_ACCOUNT = "acc_authorized" as AccountId;

function corpusWithActivatable(...policyKeys: readonly IdentityConsentPolicyKey[]): ConsentPublicationCorpus {
  const records = { ...identityConsentPublicationCorpus } as Record<string, Record<string, unknown>>;
  for (const policyKey of policyKeys) {
    records[policyKey] = { ...records[policyKey], publicationStatus: "published", consentActivatable: true };
  }
  return records as unknown as ConsentPublicationCorpus;
}

function authorization(): ConsentRecordingAuthorization {
  return authorizeConsentForActor({
    tenantId: "tnt_identity" as never,
    audit: { performedByUserId: AUTHORIZED_USER, forAccountId: AUTHORIZED_ACCOUNT },
    trace: {},
  });
}

function recordCommand(overrides: Partial<RecordConsentCommand> = {}): RecordConsentCommand {
  return {
    type: "RecordConsent",
    consentId: "cns_admission" as ConsentId,
    subjectType: "user",
    userId: AUTHORIZED_USER,
    accountId: AUTHORIZED_ACCOUNT,
    policyKey: "terms-of-service",
    policyVersion: "v1",
    recordedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function expectRefusal(run: () => void, code: string) {
  expect(run).toThrow(ConsentBundleAdmissionError);
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ name: "ConsentBundleAdmissionError", code });
  }
}

describe("the publication half of the recording admission", () => {
  it("rejects a stub version against the shipped corpus with a named error", () => {
    expectRefusal(
      () => assertConsentRecordingBundleAdmission(recordCommand(), authorization()),
      "consent_policy_not_publication_activatable",
    );
  });

  it("rejects a version that is not the published version", () => {
    expectRefusal(
      () =>
        assertConsentRecordingBundleAdmission(
          recordCommand({ policyVersion: "v7" }),
          authorization(),
          corpusWithActivatable("terms-of-service"),
        ),
      "consent_policy_version_not_published",
    );
  });

  it.each([
    { name: "the legacy history-only key", policyKey: "terms", policyVersion: "v1" },
    { name: "a date-shaped legacy version", policyKey: "terms", policyVersion: "2026-03-03" },
    { name: "an unregistered key", policyKey: "made-up-policy", policyVersion: "v1" },
  ])("never admits a new recording for $name", ({ policyKey, policyVersion }) => {
    expectRefusal(
      () =>
        assertConsentRecordingBundleAdmission(
          recordCommand({ policyKey, policyVersion }),
          authorization(),
          corpusWithActivatable("terms-of-service", "privacy-policy", "seller-agreement", "payments-terms"),
        ),
      "consent_policy_not_bundle_member",
    );
  });

  it("admits a published member at its published version", () => {
    expect(() =>
      assertConsentRecordingBundleAdmission(
        recordCommand(),
        authorization(),
        corpusWithActivatable("terms-of-service"),
      ),
    ).not.toThrow();
  });
});

describe("the bundle-declared scope binds the authorized subject", () => {
  const activatable = corpusWithActivatable("terms-of-service", "seller-agreement");

  it("rejects a registration-bundle member recorded against an account subject", () => {
    expectRefusal(
      () =>
        assertConsentRecordingBundleAdmission(recordCommand({ subjectType: "account" }), authorization(), activatable),
      "consent_bundle_scope_mismatch",
    );
  });

  it("rejects a seller-bundle member recorded against a user subject", () => {
    expectRefusal(
      () =>
        assertConsentRecordingBundleAdmission(
          recordCommand({ policyKey: "seller-agreement", subjectType: "user" }),
          authorization(),
          activatable,
        ),
      "consent_bundle_scope_mismatch",
    );
  });

  it.each([
    {
      name: "a user-scoped member naming a foreign user",
      overrides: { userId: "usr_foreign" as UserId },
    },
    {
      name: "a user-scoped member carrying a foreign account context",
      overrides: { accountId: "acc_victim" as AccountId },
    },
  ])("rejects $name", ({ overrides }) => {
    expectRefusal(
      () => assertConsentRecordingBundleAdmission(recordCommand(overrides), authorization(), activatable),
      "consent_bundle_subject_not_authorized",
    );
  });

  it.each([
    {
      name: "an account-scoped member naming a foreign account",
      overrides: { accountId: "acc_victim" as AccountId },
    },
    {
      name: "an account-scoped member capturing a foreign acting user",
      overrides: { userId: "usr_foreign" as UserId },
    },
  ])("rejects $name", ({ overrides }) => {
    expectRefusal(
      () =>
        assertConsentRecordingBundleAdmission(
          recordCommand({ policyKey: "seller-agreement", subjectType: "account", ...overrides }),
          authorization(),
          activatable,
        ),
      "consent_bundle_subject_not_authorized",
    );
  });

  it("admits an account-scoped member for the authorized account with the authorized acting user", () => {
    expect(() =>
      assertConsentRecordingBundleAdmission(
        recordCommand({ policyKey: "seller-agreement", subjectType: "account" }),
        authorization(),
        activatable,
      ),
    ).not.toThrow();
  });
});

describe("the rule holds on the decider itself", () => {
  it("refuses through decideAuthorizedConsent, which registration composes directly", () => {
    // Registration does not go through the Consent API runtime; it composes the
    // authorized decider. A rule proven only at the runtime would leave this
    // sibling entrypoint unguarded.
    expect(() =>
      decideAuthorizedConsent(initialConsentState, {
        command: recordCommand(),
        authorization: authorization(),
      }),
    ).toThrow(ConsentBundleAdmissionError);
  });

  it("leaves withdrawal untouched by the bundle rules", () => {
    const recorded = {
      ...initialConsentState,
      id: "cns_admission" as ConsentId,
      subjectType: "user" as const,
      userId: AUTHORIZED_USER,
      accountId: AUTHORIZED_ACCOUNT,
      policyKey: "terms-of-service",
      policyVersion: "v1",
      status: "recorded" as const,
    };

    const events = decideAuthorizedConsent(recorded, {
      command: { type: "WithdrawConsent", withdrawnAt: "2026-07-29T00:00:00.000Z" },
      authorization: authorization(),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("identity.consent.withdrawn");
  });
});
