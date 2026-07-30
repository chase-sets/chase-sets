import { describe, expect, it, vi } from "vitest";
import {
  ConsentActivationAuthorityError,
  decodeConsentActivationAuthoritySnapshot,
  type ValidatedConsentActivationAuthoritySnapshot,
} from "@chase-sets/platform-policy/consent-activation-authority";
import { publicPolicyHrefsByKey, type PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import {
  activeSnapshot,
  deactivatedSnapshot,
  neverActivatedUnregisteredSnapshot,
  recordingAuthorityReader,
  registeredNeverActivatedSnapshot,
} from "../../../tests/consent-activation-authority-fixtures";
import {
  CONSENT_BUNDLE_KEYS,
  consentBundleDeclarationFor,
  consentBundleDeclarations,
  deriveActivatedConsentMemberOutcome,
  identityConsentPolicyPublications,
  isConsentActivatablePublication,
  resolveConsentBundle,
  resolveConsentBundleAgainstCorpus,
  resolveConsentPolicyMember,
  type ConsentActivationAuthorityReader,
  type ConsentBundleKey,
  type ConsentPolicyPublicationCorpus,
} from "./consent-bundle";
import {
  IDENTITY_CONSENT_POLICY_KEYS,
  identityConsentActiveVersionPolicies,
  type IdentityConsentPolicyKey,
} from "./terms-of-service-policy";

function publication(
  policyKey: IdentityConsentPolicyKey,
  overrides: Partial<PublicPolicyPublicationRecord> = {},
): PublicPolicyPublicationRecord {
  return {
    ...identityConsentPolicyPublications[policyKey],
    ...overrides,
  } as PublicPolicyPublicationRecord;
}

function corpus(
  overrides: Partial<Record<IdentityConsentPolicyKey, PublicPolicyPublicationRecord>>,
): ConsentPolicyPublicationCorpus {
  return {
    "terms-of-service": overrides["terms-of-service"] ?? publication("terms-of-service"),
    "privacy-policy": overrides["privacy-policy"] ?? publication("privacy-policy"),
    "seller-agreement": overrides["seller-agreement"] ?? publication("seller-agreement"),
    "payments-terms": overrides["payments-terms"] ?? publication("payments-terms"),
  };
}

function activatable(policyKey: IdentityConsentPolicyKey, version: `v${number}`): PublicPolicyPublicationRecord {
  return publication(policyKey, { consentActivatable: true, publicationStatus: "published", version });
}

function activeVersionKeyFor(policyKey: IdentityConsentPolicyKey): string {
  return identityConsentActiveVersionPolicies[policyKey].policyKey;
}

describe("consent bundle declarations", () => {
  it("declares exactly the two bundles, closed", () => {
    expect(CONSENT_BUNDLE_KEYS).toEqual(["registration", "seller-onboarding"]);
    expect(Object.keys(consentBundleDeclarations).sort()).toEqual(["registration", "seller-onboarding"]);
  });

  it.each([
    {
      bundleKey: "registration" as const,
      subjectScope: "user" as const,
      members: ["terms-of-service", "privacy-policy"],
    },
    {
      bundleKey: "seller-onboarding" as const,
      subjectScope: "account" as const,
      members: ["seller-agreement", "payments-terms"],
    },
  ])("declares $bundleKey with its exact scope and ordered members", ({ bundleKey, subjectScope, members }) => {
    const declaration = consentBundleDeclarationFor(bundleKey);

    expect(declaration.bundleKey).toBe(bundleKey);
    expect(declaration.subjectScope).toBe(subjectScope);
    // Ordered equality, not set equality: member order is contract.
    expect(declaration.members).toEqual(members);
  });

  it("rejects an unknown bundle key rather than resolving a default bundle", () => {
    expect(() => consentBundleDeclarationFor("seller_onboarding")).toThrow(/not a recognized Consent Bundle/);
    expect(() => consentBundleDeclarationFor("")).toThrow(/not a recognized Consent Bundle/);
  });

  it("declares only recognized consent policy keys as members", () => {
    for (const bundleKey of CONSENT_BUNDLE_KEYS) {
      for (const member of consentBundleDeclarations[bundleKey].members) {
        expect(IDENTITY_CONSENT_POLICY_KEYS).toContain(member);
      }
    }
  });
});

describe("consent bundle member derivation", () => {
  const publishedVersion = "v4" as const;

  it.each([
    {
      name: "never-activated and unregistered",
      snapshot: () => neverActivatedUnregisteredSnapshot(activeVersionKeyFor("terms-of-service")),
      authorityStatus: "never-activated",
    },
    {
      name: "registered but never activated",
      snapshot: () => registeredNeverActivatedSnapshot(activeVersionKeyFor("terms-of-service")),
      authorityStatus: "never-activated",
    },
    {
      name: "activated then deactivated",
      snapshot: () => deactivatedSnapshot(activeVersionKeyFor("terms-of-service")),
      authorityStatus: "inactive",
    },
  ])("omits a publication-ready member whose authority is $name", ({ snapshot, authorityStatus }) => {
    const outcome = deriveActivatedConsentMemberOutcome(
      "terms-of-service",
      activatable("terms-of-service", publishedVersion),
      snapshot(),
    );

    expect(outcome).toEqual({ kind: "omitted-inactive", policyKey: "terms-of-service", authorityStatus });
  });

  it("derives a requirement when the authority is active at exactly the published version", () => {
    const outcome = deriveActivatedConsentMemberOutcome(
      "terms-of-service",
      activatable("terms-of-service", publishedVersion),
      activeSnapshot(activeVersionKeyFor("terms-of-service"), publishedVersion),
    );

    expect(outcome).toEqual({
      kind: "required",
      policyKey: "terms-of-service",
      requirement: {
        policyKey: "terms-of-service",
        version: publishedVersion,
        href: publicPolicyHrefsByKey["terms-of-service"],
      },
    });
  });

  it.each([
    { activeVersion: "v3", publishedVersion: "v4" as const, name: "authority behind publication" },
    { activeVersion: "v5", publishedVersion: "v4" as const, name: "authority ahead of publication" },
  ])("leaves a $name member unresolved rather than requiring either version", ({ activeVersion, publishedVersion }) => {
    const outcome = deriveActivatedConsentMemberOutcome(
      "terms-of-service",
      activatable("terms-of-service", publishedVersion),
      activeSnapshot(activeVersionKeyFor("terms-of-service"), activeVersion),
    );

    expect(outcome).toEqual({
      kind: "unresolved",
      policyKey: "terms-of-service",
      reason: "publication-activation-version-mismatch",
    });
  });

  it("consumes the compiled activatable flag instead of re-deriving it from publication status", () => {
    // A published artifact whose operative copy is blank or unreviewed compiles
    // to consentActivatable false. Identity must honour that flag and never
    // infer eligibility from publicationStatus alone.
    const blankOperativeCopy = publication("terms-of-service", {
      publicationStatus: "published",
      consentActivatable: false,
    });

    expect(isConsentActivatablePublication(blankOperativeCopy)).toBe(false);
    expect(isConsentActivatablePublication(activatable("terms-of-service", publishedVersion))).toBe(true);
  });
});

describe("consent bundle resolution", () => {
  it("performs no authority read for a publication-ineligible member", async () => {
    const authority = recordingAuthorityReader({});

    const resolution = await resolveConsentBundleAgainstCorpus(authority, "registration", corpus({}));

    expect(authority.reads).toEqual([]);
    expect(resolution).toEqual({
      bundleKey: "registration",
      subjectScope: "user",
      resolved: true,
      requirements: [],
      guards: [],
      outcomes: [
        { kind: "publication-ineligible", policyKey: "terms-of-service" },
        { kind: "publication-ineligible", policyKey: "privacy-policy" },
      ],
    });
  });

  it("retains a guard for a publication-ready member observed inactive", async () => {
    const termsKey = activeVersionKeyFor("terms-of-service");
    const authority = recordingAuthorityReader({
      [termsKey]: () => registeredNeverActivatedSnapshot(termsKey),
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      corpus({ "terms-of-service": activatable("terms-of-service", "v1") }),
    );

    expect(authority.reads).toEqual([termsKey]);
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(resolution.requirements).toEqual([]);
    expect(resolution.guards).toHaveLength(1);
    expect(resolution.guards[0]).toMatchObject({
      policyKey: "terms-of-service",
      activeVersionPolicyKey: termsKey,
    });
    expect(resolution.guards[0].guard.expectedVersion).toBe(1);
  });

  it("preserves declared order in a partially activated bundle", async () => {
    const privacyKey = activeVersionKeyFor("privacy-policy");
    const termsKey = activeVersionKeyFor("terms-of-service");
    const authority = recordingAuthorityReader({
      [termsKey]: () => registeredNeverActivatedSnapshot(termsKey),
      [privacyKey]: () => activeSnapshot(privacyKey, "v2"),
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      corpus({
        "terms-of-service": activatable("terms-of-service", "v1"),
        "privacy-policy": activatable("privacy-policy", "v2"),
      }),
    );

    // Both authorities were read, in declared order.
    expect(authority.reads).toEqual([termsKey, privacyKey]);
    if (!resolution.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(resolution.requirements).toEqual([
      { policyKey: "privacy-policy", version: "v2", href: publicPolicyHrefsByKey["privacy-policy"] },
    ]);
    expect(resolution.guards.map((binding) => binding.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
  });

  it("derives a one-member requirement set with exact key, version, and href", async () => {
    const termsKey = activeVersionKeyFor("terms-of-service");
    const privacyKey = activeVersionKeyFor("privacy-policy");
    const authority = recordingAuthorityReader({
      [termsKey]: () => activeSnapshot(termsKey, "v7"),
      [privacyKey]: () => deactivatedSnapshot(privacyKey),
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      corpus({
        "terms-of-service": activatable("terms-of-service", "v7"),
        "privacy-policy": activatable("privacy-policy", "v1"),
      }),
    );

    if (!resolution.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(resolution.requirements).toEqual([{ policyKey: "terms-of-service", version: "v7", href: "/terms" }]);
  });

  it("derives both members in declared order when both are active", async () => {
    const sellerKey = activeVersionKeyFor("seller-agreement");
    const paymentsKey = activeVersionKeyFor("payments-terms");
    const authority = recordingAuthorityReader({
      [sellerKey]: () => activeSnapshot(sellerKey, "v2"),
      [paymentsKey]: () => activeSnapshot(paymentsKey, "v3"),
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "seller-onboarding",
      corpus({
        "seller-agreement": activatable("seller-agreement", "v2"),
        "payments-terms": activatable("payments-terms", "v3"),
      }),
    );

    if (!resolution.resolved) {
      throw new Error("resolution must be resolved");
    }
    expect(resolution.subjectScope).toBe("account");
    expect(resolution.requirements).toEqual([
      { policyKey: "seller-agreement", version: "v2", href: "/seller-agreement" },
      { policyKey: "payments-terms", version: "v3", href: "/payments-terms" },
    ]);
  });

  it("leaves the whole bundle unresolved when one member's activation contradicts its publication", async () => {
    const termsKey = activeVersionKeyFor("terms-of-service");
    const privacyKey = activeVersionKeyFor("privacy-policy");
    const authority = recordingAuthorityReader({
      [termsKey]: () => activeSnapshot(termsKey, "v1"),
      [privacyKey]: () => activeSnapshot(privacyKey, "v9"),
    });

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      corpus({
        "terms-of-service": activatable("terms-of-service", "v1"),
        "privacy-policy": activatable("privacy-policy", "v2"),
      }),
    );

    expect(resolution).toEqual({
      bundleKey: "registration",
      subjectScope: "user",
      resolved: false,
      unresolvedPolicyKey: "privacy-policy",
      unresolvedReason: "publication-activation-version-mismatch",
      guards: expect.any(Array),
    });
    // The terms guard read before the failure is still retained.
    expect(resolution.guards.map((binding) => binding.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
  });

  it("leaves the bundle unresolved when the authority cannot be read", async () => {
    const termsKey = activeVersionKeyFor("terms-of-service");
    const authority: ConsentActivationAuthorityReader = {
      read: async () => {
        throw new ConsentActivationAuthorityError("invalid_snapshot_shape", "poisoned authority history");
      },
    };

    const resolution = await resolveConsentBundleAgainstCorpus(
      authority,
      "registration",
      corpus({ "terms-of-service": activatable("terms-of-service", "v1") }),
    );

    expect(resolution).toEqual({
      bundleKey: "registration",
      subjectScope: "user",
      resolved: false,
      unresolvedPolicyKey: "terms-of-service",
      unresolvedReason: "authority-unreadable",
      guards: [],
    });
    expect(termsKey).toContain("terms-of-service");
  });

  it("propagates a non-authority failure instead of reporting it as an activation answer", async () => {
    const authority: ConsentActivationAuthorityReader = {
      read: async () => {
        throw new TypeError("connection destroyed");
      },
    };

    await expect(
      resolveConsentBundleAgainstCorpus(
        authority,
        "registration",
        corpus({ "terms-of-service": activatable("terms-of-service", "v1") }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("rejects a publication record whose key does not match the member being resolved", async () => {
    const authority = recordingAuthorityReader({});

    await expect(
      resolveConsentBundleAgainstCorpus(authority, "registration", {
        ...corpus({}),
        "terms-of-service": publication("privacy-policy"),
      }),
    ).rejects.toThrow(/cannot satisfy a read for 'terms-of-service'/);
  });
});

describe("consent bundle resolution against the real compiled corpus", () => {
  it.each(CONSENT_BUNDLE_KEYS)(
    "resolves %s to an empty ordered requirement set with zero authority reads",
    async (bundleKey: ConsentBundleKey) => {
      const authority = recordingAuthorityReader({});

      const resolution = await resolveConsentBundle(authority, bundleKey);

      if (!resolution.resolved) {
        throw new Error("the shipped corpus must resolve");
      }
      // Resolution ran and produced a value: emptiness is a value, not a
      // disabled mode.
      expect(resolution.resolved).toBe(true);
      expect(resolution.requirements).toEqual([]);
      expect(resolution.guards).toEqual([]);
      expect(resolution.outcomes).toHaveLength(consentBundleDeclarationFor(bundleKey).members.length);
      expect(resolution.outcomes.every((outcome) => outcome.kind === "publication-ineligible")).toBe(true);
      expect(authority.reads).toEqual([]);
    },
  );

  it("keeps every shipped consent policy publication ineligible, so no member is required today", () => {
    for (const policyKey of IDENTITY_CONSENT_POLICY_KEYS) {
      expect(isConsentActivatablePublication(identityConsentPolicyPublications[policyKey])).toBe(false);
    }
  });

  it.each(IDENTITY_CONSENT_POLICY_KEYS)(
    "omits the newly declared member %s from the real per-policy entry point without an authority read",
    async (policyKey: IdentityConsentPolicyKey) => {
      const authority = recordingAuthorityReader({});

      const outcome = await resolveConsentPolicyMember(authority, policyKey);

      expect(outcome).toEqual({ kind: "publication-ineligible", policyKey });
      expect(authority.reads).toEqual([]);
    },
  );

  it("rejects an unrecognized policy key at the real per-policy entry point", async () => {
    const authority = recordingAuthorityReader({});

    await expect(resolveConsentPolicyMember(authority, "terms" as IdentityConsentPolicyKey)).rejects.toThrow(
      /not a recognized Identity consent policy/,
    );
    expect(authority.reads).toEqual([]);
  });
});

describe("activation snapshots cannot bypass the owning context's decoder", () => {
  it("rejects the hand-assembled snapshot shapes a bypass would inject", () => {
    const policyKey = activeVersionKeyFor("terms-of-service");
    const streamId = `platform-policy.consent-activation-authority-${policyKey}`;
    const base = {
      policyKey,
      streamId,
      registered: true,
      status: "active" as const,
      isActive: true,
      activeVersion: "v1",
      activeDocumentId: "pol_active",
      activationCount: 1,
      lastTransitionAt: "2026-07-01T00:00:00.000Z",
      authorityVersion: 2,
      guard: { policyKey, streamId, expectedVersion: 2 },
    };

    // An active claim with no activation behind it.
    expect(() =>
      decodeConsentActivationAuthoritySnapshot(policyKey, { ...base, activationCount: 0, authorityVersion: 1 }),
    ).toThrow(ConsentActivationAuthorityError);
    // A guard bound to a revision other than the one the state came from.
    expect(() =>
      decodeConsentActivationAuthoritySnapshot(policyKey, {
        ...base,
        guard: { policyKey, streamId, expectedVersion: 1 },
      }),
    ).toThrow(ConsentActivationAuthorityError);
    // A snapshot for a different key answering this key's read.
    expect(() => decodeConsentActivationAuthoritySnapshot("identity.privacy-policy-active-version", base)).toThrow(
      ConsentActivationAuthorityError,
    );
  });

  it("cannot be handed an unvalidated snapshot through the reader type", async () => {
    const unvalidated = {
      policyKey: activeVersionKeyFor("terms-of-service"),
      streamId: "platform-policy.consent-activation-authority-identity.terms-of-service-active-version",
      registered: true,
      status: "active",
      isActive: true,
      activeVersion: "v1",
      activeDocumentId: "pol_active",
      activationCount: 1,
      lastTransitionAt: "2026-07-01T00:00:00.000Z",
      authorityVersion: 2,
      guard: {},
    };

    const bypass: ConsentActivationAuthorityReader = {
      // @ts-expect-error the reader must return a decoder-minted snapshot, so a structurally similar object cannot compile.
      read: async () => unvalidated,
    };

    expect(typeof bypass.read).toBe("function");
  });

  it("keeps the derivation input typed as the validated snapshot", () => {
    const snapshot: ValidatedConsentActivationAuthoritySnapshot = activeSnapshot(
      activeVersionKeyFor("terms-of-service"),
      "v1",
    );
    const derive = vi.fn(deriveActivatedConsentMemberOutcome);

    derive("terms-of-service", activatable("terms-of-service", "v1"), snapshot);

    expect(derive).toHaveReturnedWith(expect.objectContaining({ kind: "required" }));
  });
});
