import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ConsentActivationAuthorityError } from "@chase-sets/platform-policy/consent-activation-authority";
import { publicPolicyHrefsByKey, type PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import {
  activeSnapshot,
  deactivatedSnapshot,
  recordingAuthorityReader,
  registeredNeverActivatedSnapshot,
} from "../../../tests/consent-activation-authority-fixtures";
import {
  identityConsentPolicyPublications,
  type ConsentActivationAuthorityReader,
  type ConsentBundleRequirement,
  type ConsentBundleResolution,
} from "../domain/consent-bundle";
import { identityConsentActiveVersionPolicies, type IdentityConsentPolicyKey } from "../domain/terms-of-service-policy";
import {
  evaluateConsentBundleAcceptance,
  evaluateConsentPolicyAcceptance,
  resolveConsentBundleAcceptance,
  resolveConsentPolicyAcceptanceStatus,
  resolveConsentPolicyAcceptanceStatusAgainstPublication,
} from "./consent-bundle-acceptance";
import type { SubjectExactConsentRow } from "./queries";

function activeVersionKeyFor(policyKey: IdentityConsentPolicyKey): string {
  return identityConsentActiveVersionPolicies[policyKey].policyKey;
}

function requirement(policyKey: IdentityConsentPolicyKey, version: string): ConsentBundleRequirement {
  return { policyKey, version, href: publicPolicyHrefsByKey[policyKey] };
}

function resolvedRegistration(requirements: readonly ConsentBundleRequirement[]): ConsentBundleResolution {
  return {
    bundleKey: "registration",
    subjectScope: "user",
    resolved: true,
    requirements,
    guards: [],
    outcomes: requirements.map((entry) => ({ kind: "required", policyKey: entry.policyKey, requirement: entry })),
  };
}

function row(
  overrides: Partial<SubjectExactConsentRow> & Pick<SubjectExactConsentRow, "policy_key">,
): SubjectExactConsentRow {
  const defaults: SubjectExactConsentRow = {
    subject_type: "user",
    subject_id: "usr_1",
    user_id: "usr_1",
    account_id: "acc_1",
    policy_key: overrides.policy_key,
    consent_id: `cns_${overrides.policy_key}`,
    policy_version: "v1",
    status: "recorded",
    recorded_at: "2026-06-01T00:00:00.000Z",
    withdrawn_at: null,
    updated_at: "2026-06-01T00:00:00.000Z",
    member_ordinal: 1,
  };
  return { ...defaults, ...overrides };
}

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return {
    query: vi.fn(async () => ({ rows: [...rows], rowCount: rows.length })),
  } as unknown as PgQueryable;
}

describe("consent bundle acceptance is aggregate state, not presence", () => {
  const terms = requirement("terms-of-service", "v2");
  const privacy = requirement("privacy-policy", "v3");

  it.each([
    {
      name: "no consent rows at all",
      rows: [] as readonly SubjectExactConsentRow[],
      satisfied: false,
    },
    {
      name: "an empty container for the right subject",
      rows: [row({ policy_key: "terms-of-service", policy_version: "", status: "recorded" })],
      satisfied: false,
    },
    {
      name: "only one of two required members",
      rows: [row({ policy_key: "terms-of-service", policy_version: "v2" })],
      satisfied: false,
    },
    {
      name: "a withdrawn current state at the required version",
      rows: [
        row({ policy_key: "terms-of-service", policy_version: "v2" }),
        row({
          policy_key: "privacy-policy",
          policy_version: "v3",
          status: "withdrawn",
          withdrawn_at: "2026-06-05T00:00:00.000Z",
        }),
      ],
      satisfied: false,
    },
    {
      name: "a superseded version on one member",
      rows: [
        row({ policy_key: "terms-of-service", policy_version: "v1" }),
        row({ policy_key: "privacy-policy", policy_version: "v3" }),
      ],
      satisfied: false,
    },
    {
      name: "a legacy terms-keyed fact standing in for the canonical key",
      rows: [
        row({ policy_key: "terms", policy_version: "v2" }),
        row({ policy_key: "privacy-policy", policy_version: "v3" }),
      ],
      satisfied: false,
    },
    {
      name: "recorded current states at both exact required versions",
      rows: [
        row({ policy_key: "terms-of-service", policy_version: "v2" }),
        row({ policy_key: "privacy-policy", policy_version: "v3" }),
      ],
      satisfied: true,
    },
  ])("treats $name as satisfied=$satisfied", ({ rows, satisfied }) => {
    const acceptance = evaluateConsentBundleAcceptance(resolvedRegistration([terms, privacy]), "usr_1", rows);

    expect(acceptance.satisfied).toBe(satisfied);
  });

  it("reports every declared member in declared order, required or not", () => {
    const acceptance = evaluateConsentBundleAcceptance(resolvedRegistration([privacy]), "usr_1", [
      row({ policy_key: "privacy-policy", policy_version: "v3" }),
    ]);

    if (!acceptance.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(acceptance.members.map((member) => member.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(acceptance.members[0]).toEqual({
      policyKey: "terms-of-service",
      required: false,
      requiredVersion: "",
      satisfied: false,
      acceptedVersion: null,
      acceptedAt: null,
      recordedStatus: null,
    });
    expect(acceptance.members[1]).toEqual({
      policyKey: "privacy-policy",
      required: true,
      requiredVersion: "v3",
      satisfied: true,
      acceptedVersion: "v3",
      acceptedAt: "2026-06-01T00:00:00.000Z",
      recordedStatus: "recorded",
    });
    expect(acceptance.satisfied).toBe(true);
  });

  it("keeps history readable for a member that is not currently required", () => {
    const acceptance = evaluateConsentBundleAcceptance(resolvedRegistration([]), "usr_1", [
      row({ policy_key: "terms-of-service", policy_version: "v1" }),
    ]);

    if (!acceptance.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(acceptance.members[0]).toMatchObject({
      required: false,
      requiredVersion: "",
      satisfied: false,
      acceptedVersion: "v1",
      recordedStatus: "recorded",
    });
    // Nothing is required, so nothing is unmet.
    expect(acceptance.satisfied).toBe(true);
  });

  it("never satisfies an unresolved bundle, whatever the subject has recorded", () => {
    const acceptance = evaluateConsentBundleAcceptance(
      {
        bundleKey: "registration",
        subjectScope: "user",
        resolved: false,
        unresolvedPolicyKey: "privacy-policy",
        unresolvedReason: "publication-activation-version-mismatch",
        guards: [],
      },
      "usr_1",
      [
        row({ policy_key: "terms-of-service", policy_version: "v2" }),
        row({ policy_key: "privacy-policy", policy_version: "v3" }),
      ],
    );

    expect(acceptance).toEqual({
      bundleKey: "registration",
      subjectScope: "user",
      subjectId: "usr_1",
      resolved: false,
      satisfied: false,
      unresolvedPolicyKey: "privacy-policy",
      unresolvedReason: "publication-activation-version-mismatch",
    });
  });
});

describe("consent bundle acceptance reads the declared subject scope exactly", () => {
  it.each([
    { bundleKey: "registration" as const, subjectType: "user", members: ["terms-of-service", "privacy-policy"] },
    {
      bundleKey: "seller-onboarding" as const,
      subjectType: "account",
      members: ["seller-agreement", "payments-terms"],
    },
  ])(
    "queries $bundleKey with subject type $subjectType and its declared members",
    async ({ bundleKey, subjectType, members }) => {
      const db = fakeDb([]);
      const authority = recordingAuthorityReader({});

      await resolveConsentBundleAcceptance(db, authority, { bundleKey, subjectId: "sub_1" });

      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql, values] = vi.mocked(db.query).mock.calls[0] as [string, readonly unknown[]];
      expect(sql).toContain("FROM identity_consent_current_states AS c");
      expect(sql).toContain("c.subject_type = $1");
      expect(sql).toContain("c.subject_id = $2");
      expect(sql).not.toMatch(/\bOR\b/);
      expect(values).toEqual([subjectType, "sub_1", members]);
    },
  );

  it("still issues the subject-exact read when the corpus derives no requirement", async () => {
    const db = fakeDb([]);
    const authority = recordingAuthorityReader({});

    const acceptance = await resolveConsentBundleAcceptance(db, authority, {
      bundleKey: "registration",
      subjectId: "usr_1",
    });

    // No length-gated arm skips resolution or the read.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(acceptance.resolved).toBe(true);
    expect(acceptance.satisfied).toBe(true);
  });
});

describe("per-policy acceptance fails closed from one validated authority read", () => {
  const policyKey: IdentityConsentPolicyKey = "terms-of-service";
  const termsKey = activeVersionKeyFor(policyKey);

  function activatableTermsPublication(version: string): PublicPolicyPublicationRecord {
    return {
      ...identityConsentPolicyPublications["terms-of-service"],
      version,
      publicationStatus: "published",
      consentActivatable: true,
    } as PublicPolicyPublicationRecord;
  }

  function currentTermsRow(policyVersion: string, status: "recorded" | "withdrawn" = "recorded") {
    return {
      consent_id: "cns_1",
      subject_type: "user",
      subject_id: "usr_1",
      user_id: "usr_1",
      account_id: "acc_1",
      policy_key: "terms-of-service",
      policy_version: policyVersion,
      status,
      recorded_at: "2026-03-01T00:00:00.000Z",
      withdrawn_at: status === "withdrawn" ? "2026-04-01T00:00:00.000Z" : null,
      updated_at: "2026-04-01T00:00:00.000Z",
    };
  }

  it("is accepted only when the recorded version equals the active version exactly", async () => {
    const authority = recordingAuthorityReader({ [termsKey]: () => activeSnapshot(termsKey, "v2") });
    const params = {
      policyKey,
      publication: activatableTermsPublication("v2"),
      subject: { userId: "usr_1" },
    };

    const stale = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v1")]),
      authority,
      params,
    );
    expect(stale).toMatchObject({ requiredVersion: "v2", accepted: false, acceptedVersion: "v1" });

    const current = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v2")]),
      authority,
      params,
    );
    expect(current).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "v2",
      accepted: true,
      acceptedVersion: "v2",
      acceptedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("fails closed when the current-version consent was withdrawn", async () => {
    const authority = recordingAuthorityReader({ [termsKey]: () => activeSnapshot(termsKey, "v2") });

    const status = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v2", "withdrawn")]),
      authority,
      { policyKey, publication: activatableTermsPublication("v2"), subject: { userId: "usr_1" } },
    );

    expect(status).toMatchObject({ requiredVersion: "v2", accepted: false, acceptedVersion: "v2" });
  });

  it.each([
    {
      name: "an inactive authority",
      reader: () => recordingAuthorityReader({ [termsKey]: () => deactivatedSnapshot(termsKey) }),
    },
    {
      name: "a registered but never-activated authority",
      reader: () => recordingAuthorityReader({ [termsKey]: () => registeredNeverActivatedSnapshot(termsKey) }),
    },
    {
      name: "an authority active at a version the publication does not carry",
      reader: () => recordingAuthorityReader({ [termsKey]: () => activeSnapshot(termsKey, "v99") }),
    },
  ])("preserves an empty required version and unaccepted status for $name", async ({ reader }) => {
    const authority = reader();

    const status = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v2")]),
      authority,
      {
        policyKey: "terms-of-service",
        publication: activatableTermsPublication("v2"),
        subject: { userId: "usr_1" },
      },
    );

    // The authority WAS read -- this is not the publication-ineligible
    // short-circuit -- and it still fails closed.
    expect(authority.reads).toEqual([termsKey]);
    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: "v2",
      acceptedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("accepts an activatable publication whose authority is active at the published version", async () => {
    const authority = recordingAuthorityReader({ [termsKey]: () => activeSnapshot(termsKey, "v2") });

    const status = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v2")]),
      authority,
      {
        policyKey: "terms-of-service",
        publication: activatableTermsPublication("v2"),
        subject: { userId: "usr_1" },
      },
    );

    expect(authority.reads).toEqual([termsKey]);
    expect(status).toMatchObject({ requiredVersion: "v2", accepted: true });
  });

  it("performs no authority read for a publication-ineligible policy", async () => {
    const authority = recordingAuthorityReader({});

    const status = await resolveConsentPolicyAcceptanceStatus(fakeDb([]), authority, {
      policyKey: "terms-of-service",
      subject: { userId: "usr_1", accountId: "acc_1" },
    });

    expect(authority.reads).toEqual([]);
    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("fails closed rather than throwing when the authority cannot be validated", async () => {
    const unreadable: ConsentActivationAuthorityReader = {
      read: async () => {
        throw new ConsentActivationAuthorityError("invalid_snapshot_shape", "poisoned authority history");
      },
    };

    const status = await resolveConsentPolicyAcceptanceStatusAgainstPublication(
      fakeDb([currentTermsRow("v2")]),
      unreadable,
      {
        policyKey: "terms-of-service",
        publication: activatableTermsPublication("v2"),
        subject: { userId: "usr_1" },
      },
    );

    expect(status).toMatchObject({ requiredVersion: "", accepted: false, acceptedVersion: "v2" });
  });

  it.each([
    { kind: "publication-ineligible" as const, outcome: { kind: "publication-ineligible" as const, policyKey } },
    {
      kind: "omitted-inactive" as const,
      outcome: { kind: "omitted-inactive" as const, policyKey, authorityStatus: "inactive" as const },
    },
    {
      kind: "unresolved" as const,
      outcome: { kind: "unresolved" as const, policyKey, reason: "authority-unreadable" as const },
    },
  ])("never reports acceptance for a $kind outcome, whatever is recorded", ({ outcome }) => {
    const status = evaluateConsentPolicyAcceptance(policyKey, outcome, {
      subject_type: "user",
      subject_id: "usr_1",
      user_id: "usr_1",
      account_id: "acc_1",
      policy_key: policyKey,
      consent_id: "cns_1",
      policy_version: "v2",
      status: "recorded",
      recorded_at: "2026-03-01T00:00:00.000Z",
      withdrawn_at: null,
      updated_at: "2026-03-01T00:00:00.000Z",
    });

    expect(status).toEqual({
      policyKey,
      requiredVersion: "",
      accepted: false,
      acceptedVersion: "v2",
      acceptedAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("uses the shipped user-or-account host query rather than a subject-exact read", async () => {
    const db = fakeDb([]);
    const authority = recordingAuthorityReader({});

    await resolveConsentPolicyAcceptanceStatus(db, authority, {
      policyKey: "terms-of-service",
      subject: { userId: "usr_1", accountId: "acc_1" },
    });

    const [sql, values] = vi.mocked(db.query).mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("FROM identity_consent_current_states");
    expect(sql).toContain("(user_id = $2 OR account_id = $3)");
    expect(values).toEqual(["terms-of-service", "usr_1", "acc_1"]);
  });
});
