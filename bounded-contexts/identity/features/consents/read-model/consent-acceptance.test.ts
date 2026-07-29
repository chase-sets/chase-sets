import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ConsentActivationAuthoritySnapshot } from "@chase-sets/platform-policy/consent-activation-authority";
import { resolveConsentBundleAcceptance } from "./consent-acceptance";

vi.mock("@chase-sets/public-docs", async (importOriginal) => {
  const { publicDocsWithConsentActivatable } = await import("../domain/consent-publication-test-support");
  return publicDocsWithConsentActivatable(importOriginal, ["terms-of-service", "privacy-policy"]);
});

type CurrentStateRow = Readonly<{
  policy_key: string;
  consent_id: string;
  policy_version: string;
  status: "recorded" | "withdrawn";
  recorded_at: string;
  withdrawn_at: string | null;
  ordinal: number;
}>;

/**
 * A queryable that answers with exactly the rows the subject-exact projection
 * read would return for the requested `(subject_type, subject_id)`. Rows planted
 * for any other subject are deliberately never returned, mirroring the primary
 * key -- the real disjunction-free behaviour is proven against PostgreSQL in
 * `consent-bundle.db.test.ts`.
 */
function subjectExactDb(planted: readonly (CurrentStateRow & { subjectType: string; subjectId: string })[]) {
  const query = vi.fn(async (_sql: string, values?: readonly unknown[]) => {
    const [subjectType, subjectId, policyKeys] = (values ?? []) as [string, string, readonly string[]];
    const rows = policyKeys
      .map((policyKey, index) => {
        const row = planted.find(
          (candidate) =>
            candidate.subjectType === subjectType &&
            candidate.subjectId === subjectId &&
            candidate.policy_key === policyKey,
        );
        return row ? { ...row, ordinal: index + 1 } : null;
      })
      .filter((row): row is CurrentStateRow & { subjectType: string; subjectId: string } => row !== null);
    return { rows, rowCount: rows.length };
  });
  return { query } as unknown as PgQueryable & { query: typeof query };
}

function activeAuthority(activationPolicyKey: string, version: string): ConsentActivationAuthoritySnapshot {
  return {
    policyKey: activationPolicyKey,
    streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
    registered: true,
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol-test",
    activationCount: 1,
    lastTransitionAt: "2026-01-02T00:00:00.000Z",
    authorityVersion: 2,
    guard: {
      policyKey: activationPolicyKey,
      streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
      expectedVersion: 2,
    },
  };
}

const readActive = vi.fn(async (activationPolicyKey: string) => activeAuthority(activationPolicyKey, "v1"));

function plantedRow(
  overrides: Partial<CurrentStateRow> & { subjectType: string; subjectId: string; policy_key: string },
) {
  return {
    consent_id: "cns_planted",
    policy_version: "v1",
    status: "recorded" as const,
    recorded_at: "2026-07-01T00:00:00.000Z",
    withdrawn_at: null,
    ordinal: 1,
    ...overrides,
  };
}

describe("Consent Bundle acceptance", () => {
  it("resolves the ordered requirement set for the exact subject", async () => {
    const db = subjectExactDb([
      plantedRow({ subjectType: "user", subjectId: "usr_target", policy_key: "terms-of-service" }),
      plantedRow({ subjectType: "user", subjectId: "usr_target", policy_key: "privacy-policy" }),
    ]);

    const acceptance = await resolveConsentBundleAcceptance(db, readActive, {
      bundleKey: "registration",
      subjectId: "usr_target",
    });

    expect(acceptance.requirements.map((entry) => entry.requirement.policyKey)).toEqual([
      "terms-of-service",
      "privacy-policy",
    ]);
    expect(acceptance.satisfied).toBe(true);
  });

  it.each([
    { name: "empty", planted: [] },
    {
      name: "partial",
      planted: [plantedRow({ subjectType: "user", subjectId: "usr_target", policy_key: "terms-of-service" })],
    },
    {
      name: "withdrawn",
      planted: [
        plantedRow({
          subjectType: "user",
          subjectId: "usr_target",
          policy_key: "terms-of-service",
          status: "withdrawn",
          withdrawn_at: "2026-07-02T00:00:00.000Z",
        }),
        plantedRow({ subjectType: "user", subjectId: "usr_target", policy_key: "privacy-policy" }),
      ],
    },
    {
      name: "superseded-version",
      planted: [
        plantedRow({
          subjectType: "user",
          subjectId: "usr_target",
          policy_key: "terms-of-service",
          policy_version: "v0-old",
        }),
        plantedRow({ subjectType: "user", subjectId: "usr_target", policy_key: "privacy-policy" }),
      ],
    },
    {
      name: "legacy-terms-only",
      planted: [
        plantedRow({
          subjectType: "user",
          subjectId: "usr_target",
          policy_key: "terms",
          policy_version: "2026-03-03",
        }),
      ],
    },
  ])("reads a $name consent container as unsatisfied", async ({ planted }) => {
    const acceptance = await resolveConsentBundleAcceptance(subjectExactDb(planted), readActive, {
      bundleKey: "registration",
      subjectId: "usr_target",
    });

    expect(acceptance.satisfied).toBe(false);
  });

  it("does not let another user's consent satisfy the target user's bundle", async () => {
    const acceptance = await resolveConsentBundleAcceptance(
      subjectExactDb([
        plantedRow({ subjectType: "user", subjectId: "usr_other", policy_key: "terms-of-service" }),
        plantedRow({ subjectType: "user", subjectId: "usr_other", policy_key: "privacy-policy" }),
      ]),
      readActive,
      { bundleKey: "registration", subjectId: "usr_target" },
    );

    expect(acceptance.satisfied).toBe(false);
    expect(acceptance.requirements.every((entry) => entry.status === null)).toBe(true);
  });

  it("does not let a user-scoped consent satisfy an account bundle", async () => {
    const acceptance = await resolveConsentBundleAcceptance(
      subjectExactDb([plantedRow({ subjectType: "user", subjectId: "acc_shared", policy_key: "seller-agreement" })]),
      readActive,
      { bundleKey: "seller-onboarding", subjectId: "acc_shared" },
    );

    // The seller bundle resolves to no requirements at this corpus, so it is
    // vacuously satisfied -- and crucially the user-scoped row was never read
    // for it. The real cross-scope control runs against PostgreSQL.
    expect(acceptance.subjectType).toBe("account");
    expect(acceptance.requirements).toEqual([]);
  });

  it("queries only for the resolved requirement keys, in bundle order", async () => {
    const db = subjectExactDb([]);
    await resolveConsentBundleAcceptance(db, readActive, { bundleKey: "registration", subjectId: "usr_target" });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]?.[1]).toEqual(["user", "usr_target", ["terms-of-service", "privacy-policy"]]);
  });

  it("issues no query at all when the requirement set is empty", async () => {
    const db = subjectExactDb([]);
    const acceptance = await resolveConsentBundleAcceptance(db, readActive, {
      bundleKey: "seller-onboarding",
      subjectId: "acc_target",
    });

    expect(db.query).not.toHaveBeenCalled();
    expect(acceptance.requirements).toEqual([]);
    // Empty is a value: the resolution still ran and still reports every member.
    expect(acceptance.resolution.members).toHaveLength(2);
  });
});
