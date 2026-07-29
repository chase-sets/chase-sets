import { describe, expect, it, vi } from "vitest";
import type { ConsentActivationAuthoritySnapshot } from "@chase-sets/platform-policy/consent-activation-authority";
import {
  assessConsentMemberPublication,
  assessConsentRecordingPublication,
  consentBundleForRecording,
  consentBundleMemberActivationPolicyKey,
  consentBundles,
  consentBundlesDeclaring,
  ConsentBundleUnresolvedError,
  getConsentBundle,
  identityConsentPublicationCorpus,
  requireResolvedConsentBundle,
  resolveConsentBundle,
  resolveRegistrationConsentRequirements,
  type ConsentBundleKey,
  type ConsentPublicationCorpus,
} from "./consent-bundle";
import { IDENTITY_CONSENT_POLICY_KEYS, type IdentityConsentPolicyKey } from "./terms-of-service-policy";

/**
 * The corpus these tests assess against is built by transforming the REAL
 * compiled corpus, so a record shape that drifts from the shipped one fails here
 * rather than passing against a hand-written fixture.
 */
function corpusWithActivatable(...policyKeys: readonly IdentityConsentPolicyKey[]): ConsentPublicationCorpus {
  const records = { ...identityConsentPublicationCorpus } as Record<string, Record<string, unknown>>;
  for (const policyKey of policyKeys) {
    records[policyKey] = { ...records[policyKey], publicationStatus: "published", consentActivatable: true };
  }
  return records as unknown as ConsentPublicationCorpus;
}

function snapshot(
  activationPolicyKey: string,
  overrides: Partial<ConsentActivationAuthoritySnapshot> = {},
): ConsentActivationAuthoritySnapshot {
  return {
    policyKey: activationPolicyKey,
    streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
    registered: true,
    status: "never-activated",
    isActive: false,
    activeVersion: null,
    activeDocumentId: null,
    activationCount: 0,
    lastTransitionAt: null,
    authorityVersion: 1,
    guard: {
      policyKey: activationPolicyKey,
      streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
      expectedVersion: 1,
    },
    ...overrides,
  };
}

function activeSnapshot(activationPolicyKey: string, version: string): ConsentActivationAuthoritySnapshot {
  return snapshot(activationPolicyKey, {
    status: "active",
    isActive: true,
    activeVersion: version,
    activeDocumentId: "pol-test",
    activationCount: 1,
    authorityVersion: 2,
    guard: {
      policyKey: activationPolicyKey,
      streamId: `platform-policy.consent-activation-authority-${activationPolicyKey}`,
      expectedVersion: 2,
    },
  });
}

/** Every authority reports never-activated unless a key is listed as active. */
function authorityReader(active: Readonly<Record<string, string>> = {}) {
  return vi.fn(async (activationPolicyKey: string) =>
    active[activationPolicyKey]
      ? activeSnapshot(activationPolicyKey, active[activationPolicyKey])
      : snapshot(activationPolicyKey),
  );
}

function activationKey(policyKey: IdentityConsentPolicyKey): string {
  return consentBundleMemberActivationPolicyKey(policyKey);
}

describe("Consent Bundle declaration", () => {
  it("declares two bundles with the settled scopes and ordered members", () => {
    expect(getConsentBundle("registration")).toMatchObject({
      subjectType: "user",
      recordedBy: "subject",
      members: [{ policyKey: "terms-of-service" }, { policyKey: "privacy-policy" }],
    });
    expect(getConsentBundle("seller-onboarding")).toMatchObject({
      subjectType: "account",
      recordedBy: "authorized-account-member",
      members: [{ policyKey: "seller-agreement" }, { policyKey: "payments-terms" }],
    });
  });

  it("keeps the Terms of Service activation policy key unchanged", () => {
    expect(activationKey("terms-of-service")).toBe("identity.terms-of-service-active-version");
  });

  it("declares every bundle member as an Identity consent policy key", () => {
    for (const bundleKey of Object.keys(consentBundles) as readonly ConsentBundleKey[]) {
      for (const member of consentBundles[bundleKey].members) {
        expect(IDENTITY_CONSENT_POLICY_KEYS).toContain(member.policyKey);
      }
    }
  });

  it("declares no bundle for the history-only legacy terms key", () => {
    expect(consentBundlesDeclaring("terms")).toEqual([]);
    expect(consentBundleForRecording("terms", "user")).toBeNull();
  });
});

describe("the publication half of the invariant", () => {
  it("reads every shipped artifact as not consent-activatable at this head", () => {
    for (const policyKey of IDENTITY_CONSENT_POLICY_KEYS) {
      expect(assessConsentMemberPublication(policyKey)).toEqual({ state: "not-consent-activatable" });
    }
  });

  it("resolves an activatable artifact to its canonical version and href", () => {
    expect(assessConsentMemberPublication("terms-of-service", corpusWithActivatable("terms-of-service"))).toEqual({
      state: "activatable",
      version: "v1",
      href: "/terms",
    });
  });

  it.each([
    { name: "an absent record", record: undefined },
    { name: "a non-boolean activatability", record: { consentActivatable: "yes" } },
    { name: "a non-canonical version", record: { consentActivatable: true, version: "2026-03-03" } },
    { name: "a non-canonical href", record: { consentActivatable: true, href: "/somewhere-else" } },
    { name: "a mismatched policy key", record: { consentActivatable: true, policyKey: "privacy-policy" } },
    { name: "an unknown publication status", record: { consentActivatable: true, publicationStatus: "draft" } },
  ])("fails closed on $name rather than inventing a fallback", ({ record }) => {
    const corpus = { ...identityConsentPublicationCorpus } as Record<string, Record<string, unknown>>;
    if (record === undefined) {
      delete corpus["terms-of-service"];
    } else {
      corpus["terms-of-service"] = { ...corpus["terms-of-service"], ...record };
    }

    const assessment = assessConsentMemberPublication(
      "terms-of-service",
      corpus as unknown as ConsentPublicationCorpus,
    );
    expect(assessment.state).toBe("unresolved");
  });
});

describe("resolving a Consent Bundle", () => {
  it("resolves an empty ordered requirement set for the current corpus", async () => {
    const read = authorityReader();

    for (const bundleKey of ["registration", "seller-onboarding"] as const) {
      const resolution = await resolveConsentBundle(bundleKey, read);
      expect(resolution.requirements).toEqual([]);
      expect(resolution.guards).toEqual([]);
      expect(resolution.unresolved).toEqual([]);
      expect(resolution.members.map((member) => member.disposition)).toEqual([
        "omitted-not-consent-activatable",
        "omitted-not-consent-activatable",
      ]);
    }
    // A member that is not consent-activatable is skipped before its authority
    // is read: an unpublished document has nothing to activate.
    expect(read).not.toHaveBeenCalled();
  });

  it("an empty requirement set does not disable the invariant", async () => {
    // The resolution still ran, still reports each member's disposition, and
    // still fails closed on an unreadable member -- with zero requirements.
    const emptyResolution = await resolveConsentBundle("registration", authorityReader());
    expect(emptyResolution.requirements).toHaveLength(0);
    expect(emptyResolution.members).toHaveLength(2);

    const brokenCorpus = { ...identityConsentPublicationCorpus } as Record<string, unknown>;
    delete brokenCorpus["privacy-policy"];
    await expect(
      requireResolvedConsentBundle(
        "registration",
        authorityReader(),
        brokenCorpus as unknown as ConsentPublicationCorpus,
      ),
    ).rejects.toBeInstanceOf(ConsentBundleUnresolvedError);

    // And an empty requirement set is never a licence to record: the recording
    // admission refuses every member of the shipped corpus.
    for (const policyKey of IDENTITY_CONSENT_POLICY_KEYS) {
      expect(assessConsentRecordingPublication(policyKey, "v1").admitted).toBe(false);
    }
  });

  it("omits a non-activatable member from the requirement set", async () => {
    // Publication says no. The member is declared and stays declared; nothing
    // about declaring it made it required.
    const resolution = await resolveConsentBundle(
      "registration",
      authorityReader({ [activationKey("terms-of-service")]: "v1" }),
    );
    expect(resolution.requirements).toEqual([]);
    expect(resolution.members[0]?.disposition).toBe("omitted-not-consent-activatable");
  });

  it("includes it once publication and activation both confirm", async () => {
    const resolution = await resolveConsentBundle(
      "registration",
      authorityReader({ [activationKey("terms-of-service")]: "v1" }),
      corpusWithActivatable("terms-of-service"),
    );

    expect(resolution.requirements).toEqual([{ policyKey: "terms-of-service", version: "v1", href: "/terms" }]);
    expect(resolution.guards).toEqual([
      expect.objectContaining({ policyKey: activationKey("terms-of-service"), expectedVersion: 2 }),
    ]);
  });

  it("resolves a two-member bundle with one activated member to exactly one requirement", async () => {
    const resolution = await resolveConsentBundle(
      "registration",
      authorityReader({ [activationKey("terms-of-service")]: "v1" }),
      corpusWithActivatable("terms-of-service", "privacy-policy"),
    );

    expect(resolution.requirements).toHaveLength(1);
    expect(resolution.requirements[0]?.policyKey).toBe("terms-of-service");
    expect(resolution.members[1]).toMatchObject({
      policyKey: "privacy-policy",
      disposition: "omitted-not-activated",
    });
  });

  it("emits requirements in declared member order, not authority-read order", async () => {
    const resolution = await resolveConsentBundle(
      "seller-onboarding",
      authorityReader({
        [activationKey("payments-terms")]: "v1",
        [activationKey("seller-agreement")]: "v1",
      }),
      corpusWithActivatable("seller-agreement", "payments-terms"),
    );

    expect(resolution.requirements.map((requirement) => requirement.policyKey)).toEqual([
      "seller-agreement",
      "payments-terms",
    ]);
  });

  it("fails closed when publication and activation name different versions", async () => {
    await expect(
      requireResolvedConsentBundle(
        "registration",
        authorityReader({ [activationKey("terms-of-service")]: "v2" }),
        corpusWithActivatable("terms-of-service"),
      ),
    ).rejects.toMatchObject({ name: "ConsentBundleUnresolvedError" });
  });

  it.each([
    { name: "a snapshot naming another key", overrides: { policyKey: "identity.other-active-version" } },
    { name: "a snapshot with no active version", overrides: { isActive: true, activeVersion: null } },
    {
      name: "a guard with no exact revision",
      overrides: {
        guard: {
          policyKey: "identity.terms-of-service-active-version",
          streamId: "s",
          expectedVersion: "any" as never,
        },
      },
    },
  ])("fails closed on $name", async ({ overrides }) => {
    const read = vi.fn(async (key: string) => snapshot(key, overrides as never));
    await expect(
      requireResolvedConsentBundle("registration", read, corpusWithActivatable("terms-of-service")),
    ).rejects.toBeInstanceOf(ConsentBundleUnresolvedError);
  });

  it("merges every unreadable member into one exact unresolved set", async () => {
    const read = vi.fn(async () => {
      throw new Error("authority unavailable");
    });
    const resolution = await resolveConsentBundle(
      "registration",
      read,
      corpusWithActivatable("terms-of-service", "privacy-policy"),
    );

    expect(resolution.unresolved.map((member) => member.policyKey)).toEqual(["terms-of-service", "privacy-policy"]);
    expect(resolution.requirements).toEqual([]);
  });
});

describe("the registration requirement set", () => {
  it("is empty against the shipped corpus and still resolves", async () => {
    await expect(resolveRegistrationConsentRequirements(authorityReader())).resolves.toEqual([]);
  });

  it("grows to the ordered activated bundle", async () => {
    await expect(
      resolveRegistrationConsentRequirements(
        authorityReader({
          [activationKey("terms-of-service")]: "v1",
          [activationKey("privacy-policy")]: "v1",
        }),
        corpusWithActivatable("terms-of-service", "privacy-policy"),
      ),
    ).resolves.toEqual([
      { policyKey: "terms-of-service", version: "v1", href: "/terms" },
      { policyKey: "privacy-policy", version: "v1", href: "/privacy" },
    ]);
  });
});
