import { describe, expect, it, vi } from "vitest";
import type { ConsentActivationAuthoritySnapshot } from "@chase-sets/platform-policy/consent-activation-authority";
import type { PublicPolicyKey, PublicPolicyPublicationRecord } from "@chase-sets/public-docs";
import {
  assertAffirmedRequirementsCoverBundle,
  assertConsentVersionIsActivated,
  assertConsentVersionIsPublished,
  ConsentBundleSupersededError,
  ConsentBundleUnresolvedError,
  ConsentVersionNotActivatedError,
  ConsentVersionNotPublishedError,
  consentBundleMemberActivationPolicyKey,
  consentBundles,
  consentBundlesDeclaring,
  identityConsentPublicationCorpus,
  isConsentBundleMemberPolicyKey,
  registrationConsentBundle,
  resolveConsentBundle,
  sellerOnboardingConsentBundle,
  type ConsentPublicationCorpus,
} from "./consent-bundle";

const TERMS_ACTIVATION_KEY = "identity.terms-of-service-active-version";
const PRIVACY_ACTIVATION_KEY = "identity.privacy-policy-active-version";

function publicationOverride(
  policyKey: PublicPolicyKey,
  overrides: Readonly<Record<string, unknown>>,
): ConsentPublicationCorpus {
  return {
    ...identityConsentPublicationCorpus,
    [policyKey]: {
      ...identityConsentPublicationCorpus[policyKey],
      ...overrides,
    },
  } as unknown as ConsentPublicationCorpus;
}

/** A publication record that genuinely satisfies every consent-activatable consistency rule. */
function activatablePublication(
  policyKey: PublicPolicyKey,
  version = "v1",
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

function snapshot(
  policyKey: string,
  overrides: Partial<ConsentActivationAuthoritySnapshot> = {},
): ConsentActivationAuthoritySnapshot {
  const streamId = `platform-policy.consent-activation-authority-${policyKey}`;
  const merged = {
    policyKey,
    streamId,
    registered: true,
    status: "never-activated" as const,
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: null,
    authorityVersion: 1,
    ...overrides,
  };

  // The guard is minted from the same fold as the state beside it, so the
  // fixture derives it rather than letting the two drift apart.
  return {
    ...merged,
    guard: { policyKey, streamId, expectedVersion: merged.authorityVersion },
  };
}

function activeSnapshot(policyKey: string, version: string, authorityVersion = 2): ConsentActivationAuthoritySnapshot {
  return snapshot(policyKey, {
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol_1",
    activationCount: 1,
    lastTransitionAt: "2026-06-01T00:00:00.000Z",
    authorityVersion,
  });
}

function authorityReturning(snapshots: Readonly<Record<string, ConsentActivationAuthoritySnapshot>>) {
  return {
    read: vi.fn(async (policyKey: string) => snapshots[policyKey] ?? snapshot(policyKey)),
  };
}

describe("consent bundle declarations", () => {
  it("declares two ordered per-surface bundles at the decided scopes", () => {
    expect(registrationConsentBundle).toEqual({
      bundleKey: "registration",
      subjectType: "user",
      recordedBy: "subject",
      members: [{ policyKey: "terms-of-service" }, { policyKey: "privacy-policy" }],
    });
    expect(sellerOnboardingConsentBundle).toEqual({
      bundleKey: "seller-onboarding",
      subjectType: "account",
      recordedBy: "authorized-account-member",
      members: [{ policyKey: "seller-agreement" }, { policyKey: "payments-terms" }],
    });
    expect(Object.keys(consentBundles)).toEqual(["registration", "seller-onboarding"]);
  });

  it("maps each member onto the identity policy key its activation authority is derived from", () => {
    expect(consentBundleMemberActivationPolicyKey("terms-of-service")).toBe(TERMS_ACTIVATION_KEY);
    expect(consentBundleMemberActivationPolicyKey("privacy-policy")).toBe(PRIVACY_ACTIVATION_KEY);
    expect(consentBundlesDeclaring("payments-terms")).toEqual(["seller-onboarding"]);
    expect(consentBundlesDeclaring("terms")).toEqual([]);
  });

  it("treats the history-only legacy terms key as no bundle's member", () => {
    expect(isConsentBundleMemberPolicyKey("terms-of-service")).toBe(true);
    expect(isConsentBundleMemberPolicyKey("terms")).toBe(false);
  });
});

describe("resolving a consent bundle against the shipped corpus", () => {
  it("resolves an empty ordered requirement set for the current corpus", async () => {
    const authority = authorityReturning({});

    for (const bundle of [registrationConsentBundle, sellerOnboardingConsentBundle]) {
      const resolution = await resolveConsentBundle(bundle, {
        publications: identityConsentPublicationCorpus,
        authority,
      });

      expect(resolution.requirements).toEqual([]);
      expect(resolution.unresolved).toEqual([]);
      expect(resolution.members.map((member) => member.disposition)).toEqual([
        "omitted-not-consent-activatable",
        "omitted-not-consent-activatable",
      ]);
    }

    // Nothing in the shipped corpus can become required inside a running
    // process, so nothing reaches the authority -- and nothing pretends to.
    expect(authority.read).not.toHaveBeenCalled();
  });

  it("an empty requirement set does not disable the invariant", async () => {
    const authority = authorityReturning({});
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: identityConsentPublicationCorpus,
      authority,
    });

    // Emptiness is a value: every declared member still carries a disposition,
    // the resolution is still a complete answer, and no member was skipped.
    expect(resolution.requirements).toHaveLength(0);
    expect(resolution.members).toHaveLength(registrationConsentBundle.members.length);
    expect(resolution.members.every((member) => member.unresolvedReason === null)).toBe(true);
    expect(resolution.members.map((member) => member.policyKey)).toEqual(
      registrationConsentBundle.members.map((member) => member.policyKey),
    );
    expect(() => assertAffirmedRequirementsCoverBundle(resolution, [])).not.toThrow();
  });
});

describe("declaring a member does not require it", () => {
  it("omits a non-activatable member from the requirement set", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1"),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: identityConsentPublicationCorpus,
      authority,
    });

    expect(resolution.requirements).toEqual([]);
    expect(resolution.members[0]).toMatchObject({
      policyKey: "terms-of-service",
      disposition: "omitted-not-consent-activatable",
      requirement: null,
    });
  });

  it("includes it once publication and activation both confirm", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1"),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority,
    });

    expect(resolution.requirements).toEqual([{ policyKey: "terms-of-service", version: "v1", href: "/terms" }]);
    expect(resolution.members[1]).toMatchObject({ disposition: "omitted-not-consent-activatable" });
  });

  it("keeps a two-member bundle with one activated member at exactly one requirement", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1"),
      [PRIVACY_ACTIVATION_KEY]: activeSnapshot(PRIVACY_ACTIVATION_KEY, "v1"),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority,
    });

    expect(resolution.requirements).toHaveLength(1);
    expect(resolution.requirements[0].policyKey).toBe("terms-of-service");
  });

  it("emits requirements in the bundle's declared order, not resolution order", async () => {
    const publications = activatablePublication("privacy-policy", "v1", activatablePublication("terms-of-service"));
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1"),
      [PRIVACY_ACTIVATION_KEY]: activeSnapshot(PRIVACY_ACTIVATION_KEY, "v1"),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, { publications, authority });

    expect(resolution.requirements.map((requirement) => requirement.policyKey)).toEqual([
      "terms-of-service",
      "privacy-policy",
    ]);
  });

  it("omits a consent-activatable member whose authority has never activated it", async () => {
    const authority = authorityReturning({});

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority,
    });

    expect(resolution.requirements).toEqual([]);
    expect(resolution.members[0]).toMatchObject({ disposition: "omitted-not-activated" });
    // The member could have become required, so its activation is pinned even
    // though it contributed nothing to the requirement set.
    expect(resolution.guards).toHaveLength(1);
  });

  it("omits a member whose authority deactivated it, distinctly from one never activated", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: snapshot(TERMS_ACTIVATION_KEY, { status: "inactive", authorityVersion: 3 }),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority,
    });

    expect(resolution.members[0]).toMatchObject({ disposition: "omitted-not-activated" });
    expect(resolution.guards[0].expectedVersion).toBe(3);
  });
});

describe("one authoritative read", () => {
  it("resolves bundle state and version from one authoritative read", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1", 2),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority,
    });

    // Exactly one read for the one member that could be required, and the
    // version, the state and the guard token all come out of it. There is no
    // second read a cached value could be paired against.
    expect(authority.read).toHaveBeenCalledTimes(1);
    expect(authority.read).toHaveBeenCalledWith(TERMS_ACTIVATION_KEY);
    expect({
      snapshot: { policyKey: "terms-of-service", version: resolution.requirements[0].version },
      policyStreamGuards: resolution.guards.map((guard) => ({
        policyKey: guard.policyKey,
        version: guard.expectedVersion,
      })),
    }).toEqual({
      snapshot: { policyKey: "terms-of-service", version: "v1" },
      policyStreamGuards: [{ policyKey: TERMS_ACTIVATION_KEY, version: 2 }],
    });
  });

  it("is unresolved when the authority's active version disagrees with the published one", async () => {
    const authority = authorityReturning({
      [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v2"),
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service", "v1"),
      authority,
    });

    expect(resolution.requirements).toEqual([]);
    expect(resolution.unresolved).toEqual([
      { policyKey: "terms-of-service", reason: "the authority reports 'v2' active while 'v1' is published" },
    ]);
    expect(() => assertAffirmedRequirementsCoverBundle(resolution, [])).toThrow(ConsentBundleUnresolvedError);
  });
});

describe("publication records are validated, not trusted", () => {
  const malformedShapes: readonly (readonly [string, ConsentPublicationCorpus])[] = [
    [
      "a nested unknown member",
      publicationOverride("terms-of-service", { consentActivatable: true, jurisdictionNote: "extra" }),
    ],
    [
      "a date-only effective instant",
      publicationOverride("terms-of-service", {
        publicationStatus: "published",
        effectiveAt: "2026-06-01",
        counselApprovalReference: "counsel-1",
        consentActivatable: true,
      }),
    ],
    [
      "an effective instant with no zone designator",
      publicationOverride("terms-of-service", {
        publicationStatus: "published",
        effectiveAt: "2026-06-01T00:00:00",
        counselApprovalReference: "counsel-1",
        consentActivatable: true,
      }),
    ],
    [
      "an out-of-range effective instant",
      publicationOverride("terms-of-service", {
        publicationStatus: "published",
        effectiveAt: "1999-06-01T00:00:00.000Z",
        counselApprovalReference: "counsel-1",
        consentActivatable: true,
      }),
    ],
    [
      "a consent-activatable record that is not published",
      publicationOverride("terms-of-service", {
        effectiveAt: "2026-06-01T00:00:00.000Z",
        counselApprovalReference: "counsel-1",
        consentActivatable: true,
      }),
    ],
    [
      "a consent-activatable record with no counsel approval",
      publicationOverride("terms-of-service", {
        publicationStatus: "published",
        effectiveAt: "2026-06-01T00:00:00.000Z",
        counselApprovalReference: "   ",
        consentActivatable: true,
      }),
    ],
    ["a non-canonical version token", publicationOverride("terms-of-service", { version: "2026-06-01" })],
    ["an href that is not the policy's canonical route", publicationOverride("terms-of-service", { href: "/tos" })],
    [
      "a content fingerprint that is not a sha256 digest",
      publicationOverride("terms-of-service", { contentFingerprint: "sha256:not-a-digest" }),
    ],
    ["a non-boolean consent-activatable flag", publicationOverride("terms-of-service", { consentActivatable: "yes" })],
  ];

  it.each(malformedShapes)("leaves the member unresolved for %s", async (_label, publications) => {
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications,
      authority: authorityReturning({}),
    });

    expect(resolution.members[0].disposition).toBe("unresolved");
    expect(resolution.requirements).toEqual([]);
    expect(resolution.unresolved).toHaveLength(1);
  });

  it("merges every unreadable member into one exact unresolved set rather than inventing a fallback", async () => {
    const publications = {
      ...identityConsentPublicationCorpus,
      "terms-of-service": { ...identityConsentPublicationCorpus["terms-of-service"], version: "draft" },
      "privacy-policy": { ...identityConsentPublicationCorpus["privacy-policy"], href: "/nope" },
    } as unknown as ConsentPublicationCorpus;

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications,
      authority: authorityReturning({}),
    });

    expect(resolution.unresolved.map((member) => member.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(() => assertAffirmedRequirementsCoverBundle(resolution, [])).toThrow(/terms-of-service .*; privacy-policy /);
  });

  it("consumes consentActivatable rather than re-deriving readiness from the artifact", async () => {
    // Everything else about this record says "ready": published, effective,
    // counsel-approved. The compiled flag is what decides, and it says no.
    const publications = publicationOverride("terms-of-service", {
      publicationStatus: "published",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      counselApprovalReference: "counsel-1",
      consentActivatable: false,
    });

    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications,
      authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1") }),
    });

    expect(resolution.members[0].disposition).toBe("omitted-not-consent-activatable");
    expect(resolution.requirements).toEqual([]);
  });
});

describe("binding an affirmed requirement list to the current bundle", () => {
  it("accepts a list that carries every currently required member", async () => {
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1") }),
    });

    expect(() =>
      assertAffirmedRequirementsCoverBundle(resolution, [
        { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      ]),
    ).not.toThrow();
  });

  it("rejects a list minted before a member was activated", async () => {
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service"),
      authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v1") }),
    });

    expect(() => assertAffirmedRequirementsCoverBundle(resolution, [])).toThrow(ConsentBundleSupersededError);
  });

  it("rejects a list carrying the right member at the wrong version", async () => {
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: activatablePublication("terms-of-service", "v2"),
      authority: authorityReturning({ [TERMS_ACTIVATION_KEY]: activeSnapshot(TERMS_ACTIVATION_KEY, "v2") }),
    });

    expect(() =>
      assertAffirmedRequirementsCoverBundle(resolution, [
        { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      ]),
    ).toThrow(ConsentBundleSupersededError);
  });

  it("tolerates an affirmed member the bundle no longer requires", async () => {
    const resolution = await resolveConsentBundle(registrationConsentBundle, {
      publications: identityConsentPublicationCorpus,
      authority: authorityReturning({}),
    });

    expect(() =>
      assertAffirmedRequirementsCoverBundle(resolution, [
        { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      ]),
    ).not.toThrow();
  });
});

describe("recording admission", () => {
  it("rejects a stub version for a bundle member", () => {
    expect(() => assertConsentVersionIsPublished("terms-of-service", "v99", identityConsentPublicationCorpus)).toThrow(
      ConsentVersionNotPublishedError,
    );
  });

  it("accepts the exact published version for a bundle member", () => {
    expect(() =>
      assertConsentVersionIsPublished("terms-of-service", "v1", identityConsentPublicationCorpus),
    ).not.toThrow();
  });

  it("leaves a policy key no bundle declares alone, including a date-shaped legacy version", () => {
    expect(() =>
      assertConsentVersionIsPublished("terms", "2026-06-15", identityConsentPublicationCorpus),
    ).not.toThrow();
  });

  it("rejects a member whose publication record cannot be read", () => {
    expect(() =>
      assertConsentVersionIsPublished(
        "terms-of-service",
        "v1",
        publicationOverride("terms-of-service", { href: "/x" }),
      ),
    ).toThrow(ConsentVersionNotPublishedError);
  });

  it("rejects recording against a key its authority never activated", () => {
    expect(() => assertConsentVersionIsActivated("terms-of-service", "v1", snapshot(TERMS_ACTIVATION_KEY))).toThrow(
      ConsentVersionNotActivatedError,
    );
  });

  it("rejects recording a version other than the one the authority reports active", () => {
    expect(() =>
      assertConsentVersionIsActivated("terms-of-service", "v1", activeSnapshot(TERMS_ACTIVATION_KEY, "v2")),
    ).toThrow(ConsentVersionNotActivatedError);
  });

  it("admits the exact active version", () => {
    expect(() =>
      assertConsentVersionIsActivated("terms-of-service", "v1", activeSnapshot(TERMS_ACTIVATION_KEY, "v1")),
    ).not.toThrow();
  });
});
