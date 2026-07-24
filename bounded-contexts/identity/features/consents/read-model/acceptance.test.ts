import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { publicPolicyPublicationRecords, type PublicPolicyKey } from "@chase-sets/public-docs";
import type { ConsentPublicationRegistry } from "../domain/consent-activation";
import { resolveConsentBundleAcceptanceStatus } from "./acceptance";

function activatedRegistrationPublications(): ConsentPublicationRegistry {
  return Object.fromEntries(
    Object.entries(publicPolicyPublicationRecords).map(([policyKey, publication]) => [
      policyKey,
      ["terms-of-service", "privacy-policy"].includes(policyKey)
        ? { ...publication, publicationStatus: "published", consentActivatable: true }
        : publication,
    ]),
  ) as ConsentPublicationRegistry;
}

function fakePolicies() {
  return {
    resolvePolicy: vi.fn(async (definition: { policyKey: string }) => ({
      policyKey: definition.policyKey,
      value: { version: "v1" },
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-07-24T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-24T00:00:00.000Z",
    })),
  };
}

function fakeDb(rowsByPolicy: Partial<Record<PublicPolicyKey, Record<string, unknown>>>) {
  return {
    query: vi.fn(async (_sql: string, params: readonly unknown[]) => {
      const row = rowsByPolicy[String(params[0]) as PublicPolicyKey];
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }),
  } as unknown as PgQueryable;
}

function consentRow(policyKey: PublicPolicyKey, version = "v1") {
  return {
    consent_id: `cns_${policyKey}`,
    subject_type: "user",
    subject_id: "usr_1",
    user_id: "usr_1",
    account_id: "acc_1",
    policy_key: policyKey,
    policy_version: version,
    status: "recorded",
    recorded_at: "2026-07-24T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-07-24T00:00:00.000Z",
  };
}

function accountConsentRow(policyKey: PublicPolicyKey) {
  return {
    ...consentRow(policyKey),
    subject_type: "account",
    subject_id: "acc_1",
  };
}

describe("consent bundle acceptance", () => {
  it("is inert and performs no consent reads when no bundle member is activated", async () => {
    const db = fakeDb({});
    const status = await resolveConsentBundleAcceptanceStatus(
      db,
      fakePolicies() as never,
      "registration",
      { userId: "usr_1" },
      publicPolicyPublicationRecords,
    );

    expect(status).toEqual({
      bundleKey: "registration",
      subjectType: "user",
      accepted: true,
      policies: [],
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails closed for missing or outdated acceptance and accepts only both exact current versions", async () => {
    const publications = activatedRegistrationPublications();
    const missing = await resolveConsentBundleAcceptanceStatus(
      fakeDb({ "terms-of-service": consentRow("terms-of-service") }),
      fakePolicies() as never,
      "registration",
      { userId: "usr_1" },
      publications,
    );
    expect(missing.accepted).toBe(false);
    expect(missing.policies.map((status) => [status.policyKey, status.accepted])).toEqual([
      ["terms-of-service", true],
      ["privacy-policy", false],
    ]);

    const outdated = await resolveConsentBundleAcceptanceStatus(
      fakeDb({
        "terms-of-service": consentRow("terms-of-service", "v0"),
        "privacy-policy": consentRow("privacy-policy"),
      }),
      fakePolicies() as never,
      "registration",
      { userId: "usr_1" },
      publications,
    );
    expect(outdated.accepted).toBe(false);

    const current = await resolveConsentBundleAcceptanceStatus(
      fakeDb({
        "terms-of-service": consentRow("terms-of-service"),
        "privacy-policy": consentRow("privacy-policy"),
      }),
      fakePolicies() as never,
      "registration",
      { userId: "usr_1" },
      publications,
    );
    expect(current.accepted).toBe(true);
  });

  it("never treats legacy terms history as current Terms acceptance", async () => {
    const legacyTerms = { ...consentRow("terms-of-service"), policy_key: "terms" };
    const status = await resolveConsentBundleAcceptanceStatus(
      fakeDb({
        "terms-of-service": legacyTerms,
        "privacy-policy": consentRow("privacy-policy"),
      }),
      fakePolicies() as never,
      "registration",
      { userId: "usr_1" },
      activatedRegistrationPublications(),
    );

    expect(status.accepted).toBe(false);
    expect(status.policies[0]).toMatchObject({
      policyKey: "terms-of-service",
      accepted: false,
      acceptedVersion: "v1",
    });
  });

  it("resolves the seller-onboarding bundle against account-scoped Consent facts", async () => {
    const publications = activatedRegistrationPublications();
    const sellerPublications = Object.fromEntries(
      Object.entries(publications).map(([policyKey, publication]) => [
        policyKey,
        ["seller-agreement", "payments-terms"].includes(policyKey)
          ? { ...publication, publicationStatus: "published", consentActivatable: true }
          : publication,
      ]),
    ) as ConsentPublicationRegistry;

    const status = await resolveConsentBundleAcceptanceStatus(
      fakeDb({
        "seller-agreement": accountConsentRow("seller-agreement"),
        "payments-terms": accountConsentRow("payments-terms"),
      }),
      fakePolicies() as never,
      "seller-onboarding",
      { accountId: "acc_1" },
      sellerPublications,
    );

    expect(status).toMatchObject({
      bundleKey: "seller-onboarding",
      subjectType: "account",
      accepted: true,
      policies: [
        { policyKey: "seller-agreement", accepted: true },
        { policyKey: "payments-terms", accepted: true },
      ],
    });
  });
});
