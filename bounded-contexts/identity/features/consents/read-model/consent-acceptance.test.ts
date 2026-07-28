import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ConsentActivationAuthoritySnapshot } from "@chase-sets/platform-policy/consent-activation-authority";
import type { PublicPolicyKey } from "@chase-sets/public-docs";
import {
  identityConsentPublicationCorpus,
  registrationConsentBundle,
  sellerOnboardingConsentBundle,
  type ConsentPublicationCorpus,
} from "../domain/consent-bundle";
import { resolveConsentBundleAcceptance, resolvePolicyAcceptanceStatus } from "./consent-acceptance";

const TERMS_ACTIVATION_KEY = "identity.terms-of-service-active-version";
const PRIVACY_ACTIVATION_KEY = "identity.privacy-policy-active-version";
const SELLER_ACTIVATION_KEY = "identity.seller-agreement-active-version";
const PAYMENTS_ACTIVATION_KEY = "identity.payments-terms-active-version";

function activatable(
  policyKey: PublicPolicyKey,
  version: string,
  base: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): ConsentPublicationCorpus {
  return {
    ...base,
    [policyKey]: {
      ...base[policyKey],
      version,
      publicationStatus: "published",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      counselApprovalReference: "counsel-2026-06-01",
      consentActivatable: true,
    },
  } as unknown as ConsentPublicationCorpus;
}

function activeSnapshot(policyKey: string, version: string): ConsentActivationAuthoritySnapshot {
  const streamId = `platform-policy.consent-activation-authority-${policyKey}`;
  return {
    policyKey,
    streamId,
    registered: true,
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol_1",
    activationCount: 1,
    lastTransitionAt: "2026-06-01T00:00:00.000Z",
    authorityVersion: 2,
    guard: { policyKey, streamId, expectedVersion: 2 },
  };
}

function inactiveSnapshot(policyKey: string): ConsentActivationAuthoritySnapshot {
  const streamId = `platform-policy.consent-activation-authority-${policyKey}`;
  return {
    policyKey,
    streamId,
    registered: true,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: null,
    authorityVersion: 1,
    guard: { policyKey, streamId, expectedVersion: 1 },
  };
}

function authorityReturning(snapshots: Readonly<Record<string, ConsentActivationAuthoritySnapshot>>) {
  return { read: vi.fn(async (policyKey: string) => snapshots[policyKey] ?? inactiveSnapshot(policyKey)) };
}

type ConsentFixture = Readonly<{
  policyKey: string;
  policyVersion: string;
  status: "recorded" | "withdrawn";
  /** Defaults to the user subject `usr_1`, the subject the registration bundle asks about. */
  subjectType?: "user" | "account";
  subjectId?: string;
}>;

/**
 * Stands in for the projection, keyed the way the projection is keyed:
 * `(subject_type, subject_id, policy_key)`. The per-bundle read is answered
 * only by a fixture whose subject matches exactly, so a resolver that widened
 * its subject would read as unsatisfied here rather than quietly passing.
 */
function fakeDb(consents: readonly ConsentFixture[]) {
  return {
    query: vi.fn(async (_sql: string, params?: readonly unknown[]) => {
      // The single-policy query passes the key as its first parameter; the
      // per-bundle query passes an array of them, then the exact subject.
      const first = params?.[0];
      const perBundle = Array.isArray(first);
      const requested = (perBundle ? first : [first]) as readonly string[];
      const rows = requested.flatMap((policyKey) => {
        const consent = consents.find((entry) => {
          if (entry.policyKey !== policyKey) {
            return false;
          }
          if (!perBundle) {
            return true;
          }
          return (entry.subjectType ?? "user") === params?.[1] && (entry.subjectId ?? "usr_1") === params?.[2];
        });
        return consent
          ? [
              {
                requested_policy_key: policyKey,
                subject_type: consent.subjectType ?? "user",
                subject_id: consent.subjectId ?? "usr_1",
                user_id: (consent.subjectType ?? "user") === "user" ? (consent.subjectId ?? "usr_1") : "usr_1",
                account_id: (consent.subjectType ?? "user") === "account" ? (consent.subjectId ?? "acc_1") : "acc_1",
                policy_key: consent.policyKey,
                consent_id: `cns_${consent.policyKey}`,
                policy_version: consent.policyVersion,
                status: consent.status,
                recorded_at: "2026-06-02T00:00:00.000Z",
                withdrawn_at: consent.status === "withdrawn" ? "2026-06-03T00:00:00.000Z" : null,
                updated_at: "2026-06-03T00:00:00.000Z",
              },
            ]
          : [];
      });
      return { rows, rowCount: rows.length };
    }),
  } as unknown as PgQueryable;
}

const bothActivatable = activatable("privacy-policy", "v1", activatable("terms-of-service", "v1"));
const bothActive = authorityReturning({
  [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1"),
  [PRIVACY_ACTIVATION_KEY]: activeSnapshot(PRIVACY_ACTIVATION_KEY, "v1"),
});

const sellerActivatable = activatable("payments-terms", "v1", activatable("seller-agreement", "v1"));
const sellerActive = authorityReturning({
  [SELLER_ACTIVATION_KEY]: activeSnapshot(SELLER_ACTIVATION_KEY, "v1"),
  [PAYMENTS_ACTIVATION_KEY]: activeSnapshot(PAYMENTS_ACTIVATION_KEY, "v1"),
});

const subject = { userId: "usr_1", accountId: "acc_1" };

describe("per-policy acceptance", () => {
  it("fails closed when no consent fact exists", async () => {
    const status = await resolvePolicyAcceptanceStatus(fakeDb([]), subject, {
      policyKey: "terms-of-service",
      requiredVersion: "v1",
    });

    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "v1",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("accepts only an exact version match in the recorded state", async () => {
    const db = fakeDb([{ policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" }]);

    await expect(
      resolvePolicyAcceptanceStatus(db, subject, { policyKey: "terms-of-service", requiredVersion: "v1" }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      resolvePolicyAcceptanceStatus(db, subject, { policyKey: "terms-of-service", requiredVersion: "v2" }),
    ).resolves.toMatchObject({ accepted: false, acceptedVersion: "v1" });
  });
});

describe("consent bundle acceptance", () => {
  it("reports the current corpus as satisfied over an empty requirement set", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([]),
      registrationConsentBundle,
      { publications: identityConsentPublicationCorpus, authority: authorityReturning({}) },
      subject,
    );

    expect(status.requirements).toEqual([]);
    expect(status.members).toEqual([]);
    expect(status.satisfied).toBe(true);
    expect(status.unresolved).toEqual([]);
  });

  it("reports an activated, exactly-accepted bundle as satisfied in declared order", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([
        { policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" },
        { policyKey: "privacy-policy", policyVersion: "v1", status: "recorded" },
      ]),
      registrationConsentBundle,
      { publications: bothActivatable, authority: bothActive },
      subject,
    );

    expect(status.members.map((member) => member.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(status.members.map((member) => member.href)).toEqual(["/terms", "/privacy"]);
    expect(status.satisfied).toBe(true);
  });

  it("does not ask a subject to hold a member the authority has not activated", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([{ policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" }]),
      registrationConsentBundle,
      {
        publications: bothActivatable,
        authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1") }),
      },
      subject,
    );

    expect(status.requirements.map((requirement) => requirement.policyKey)).toEqual(["terms-of-service"]);
    expect(status.satisfied).toBe(true);
  });

  it("never reads as satisfied while any member is unresolved", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([]),
      registrationConsentBundle,
      {
        publications: activatable("terms-of-service", "v1"),
        // Publication says v1 is the published version; the authority claims v2.
        authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v2") }),
      },
      subject,
    );

    expect(status.unresolved).toHaveLength(1);
    expect(status.satisfied).toBe(false);
  });

  it("never satisfies a bundle from a legacy-keyed fact, including a date-shaped version", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([
        { policyKey: "terms", policyVersion: "2026-06-15", status: "recorded" },
        { policyKey: "terms", policyVersion: "v1", status: "recorded" },
      ]),
      registrationConsentBundle,
      { publications: activatable("terms-of-service", "v1"), authority: bothActive },
      subject,
    );

    expect(status.requirements.map((requirement) => requirement.policyKey)).toEqual(["terms-of-service"]);
    expect(status.members[0]).toMatchObject({ accepted: false, acceptedVersion: null, consentStatus: null });
    expect(status.satisfied).toBe(false);
  });
});

describe("a bundle is satisfied only by its own subject's consent", () => {
  it("is not satisfied by another user's consent in the same account", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([
        { policyKey: "terms-of-service", policyVersion: "v1", status: "recorded", subjectId: "usr_other" },
        { policyKey: "privacy-policy", policyVersion: "v1", status: "recorded", subjectId: "usr_other" },
      ]),
      registrationConsentBundle,
      { publications: bothActivatable, authority: bothActive },
      // Same account as `usr_other`; a different person.
      { userId: "usr_1", accountId: "acc_shared" },
    );

    expect(status.members.every((member) => member.accepted)).toBe(false);
    expect(status.satisfied).toBe(false);
  });

  it("is not satisfied by an account-scoped consent when the bundle asks about a user", async () => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb([
        {
          policyKey: "terms-of-service",
          policyVersion: "v1",
          status: "recorded",
          subjectType: "account",
          subjectId: "acc_1",
        },
        {
          policyKey: "privacy-policy",
          policyVersion: "v1",
          status: "recorded",
          subjectType: "account",
          subjectId: "acc_1",
        },
      ]),
      registrationConsentBundle,
      { publications: bothActivatable, authority: bothActive },
      subject,
    );

    expect(status.satisfied).toBe(false);
  });

  it("satisfies an account bundle for the exact account and no other", async () => {
    const heldByAccount = [
      {
        policyKey: "seller-agreement",
        policyVersion: "v1",
        status: "recorded" as const,
        subjectType: "account" as const,
        subjectId: "acc_seller",
      },
      {
        policyKey: "payments-terms",
        policyVersion: "v1",
        status: "recorded" as const,
        subjectType: "account" as const,
        subjectId: "acc_seller",
      },
    ];
    const deps = { publications: sellerActivatable, authority: sellerActive };

    const exact = await resolveConsentBundleAcceptance(fakeDb(heldByAccount), sellerOnboardingConsentBundle, deps, {
      userId: "usr_1",
      accountId: "acc_seller",
    });
    const foreign = await resolveConsentBundleAcceptance(fakeDb(heldByAccount), sellerOnboardingConsentBundle, deps, {
      userId: "usr_1",
      accountId: "acc_foreign",
    });

    expect(exact.subjectType).toBe("account");
    expect(exact.requirements.map((requirement) => requirement.policyKey)).toEqual([
      "seller-agreement",
      "payments-terms",
    ]);
    expect(exact.satisfied).toBe(true);
    expect(foreign.satisfied).toBe(false);
  });

  it("reads as unsatisfied, without querying, when the identity the bundle is about is absent", async () => {
    const db = fakeDb([{ policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" }]);

    const status = await resolveConsentBundleAcceptance(
      db,
      // An account bundle asked with only a user identity.
      sellerOnboardingConsentBundle,
      { publications: sellerActivatable, authority: sellerActive },
      { userId: "usr_1" },
    );

    expect(status.satisfied).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("bundle satisfaction is aggregate state, never row presence", () => {
  const containers: readonly (readonly [string, readonly ConsentFixture[]])[] = [
    ["empty", []],
    ["partial", [{ policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" }]],
    [
      "withdrawn",
      [
        { policyKey: "terms-of-service", policyVersion: "v1", status: "withdrawn" },
        { policyKey: "privacy-policy", policyVersion: "v1", status: "withdrawn" },
      ],
    ],
    [
      "superseded-version",
      [
        { policyKey: "terms-of-service", policyVersion: "v1", status: "recorded" },
        { policyKey: "privacy-policy", policyVersion: "v0-superseded", status: "recorded" },
      ],
    ],
  ];

  it.each(containers)("reads a %s consent container as unsatisfied", async (_label, consents) => {
    const status = await resolveConsentBundleAcceptance(
      fakeDb(consents),
      registrationConsentBundle,
      { publications: bothActivatable, authority: bothActive },
      subject,
    );

    expect(status.requirements).toHaveLength(2);
    expect(status.satisfied).toBe(false);
  });
});
