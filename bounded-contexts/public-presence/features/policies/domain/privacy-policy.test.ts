import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectPrivacyProductTruthInventory,
  readCitedSourceSlice,
} from "../integrations/privacy-product-truth-inventory.mjs";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { type PublicPolicyRegistryEntry } from "./policy-registry";
import {
  evaluatePrivacyProductTruthBindings,
  evaluatePrivacyReservedCharacterizations,
  privacyExternalClientPackageClassifications,
  privacyFactFamilies,
  privacyNoticeBoundaries,
  privacyProductTruthBindings,
  type PrivacyProductTruthBinding,
} from "./privacy-policy-product-truth";
import { privacyPolicyArtifact, requiredPrivacyPolicySubjectIds } from "./privacy-policy";

const domainDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(domainDirectory, "../../../../..");
const LONG_DERIVATION_MS = 120_000;

const inventory = collectPrivacyProductTruthInventory({
  repoRoot,
  externalPackageClassifications: privacyExternalClientPackageClassifications,
});

function evaluate(
  artifact: PublicPolicyArtifact = privacyPolicyArtifact,
  bindings: readonly PrivacyProductTruthBinding[] = privacyProductTruthBindings,
): readonly string[] {
  return evaluatePrivacyProductTruthBindings({ inventory, artifact, bindings });
}

function sectionText(artifact: PublicPolicyArtifact, sectionId: string): string {
  return artifact.sections.find((section) => section.id === sectionId)?.draftText ?? "";
}

function withSection(
  sectionId: string,
  mutate: (draftText: string) => string,
  artifact: PublicPolicyArtifact = privacyPolicyArtifact,
): PublicPolicyArtifact {
  const before = sectionText(artifact, sectionId);
  const after = mutate(before);
  expect(after, `mutation of '${sectionId}' changed nothing`).not.toBe(before);
  return {
    ...artifact,
    sections: artifact.sections.map((section) =>
      section.id === sectionId ? { ...section, draftText: after } : section,
    ),
  };
}

/** A control is only valid when the candidate is green, the mutant is red, and
 *  the mutant is red for its own named reason and nothing else. */
function expectSoleViolation(violations: readonly string[], matcher: RegExp | string) {
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(matcher);
}

describe("Privacy Policy candidate", () => {
  it("is the complete twelve-subject counsel candidate with a valid closed-schema structure", () => {
    expect(privacyPolicyArtifact.sections.map((section) => section.id)).toEqual([...requiredPrivacyPolicySubjectIds]);
    expect(requiredPrivacyPolicySubjectIds).toHaveLength(12);
    expect(validatePublicPolicyArtifactStructure(privacyPolicyArtifact)).toEqual([]);
    for (const section of privacyPolicyArtifact.sections) {
      expect(section.reviewStatus, section.id).toBe("counsel-required");
      expect(section.draftText.trim().length, section.id).toBeGreaterThan(0);
      expect(section.reviewManifest.scopeNote.trim().length, section.id).toBeGreaterThan(0);
    }
  });

  it("stays fail-closed: counsel-review-required, no effective date, no approval reference, no rollout scope", () => {
    expect(privacyPolicyArtifact.metadata).toMatchObject({
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
      rolloutJurisdictionsOrProductLimits: [],
    });
    const readiness = evaluatePublicPolicyPublicationReadiness(privacyPolicyArtifact, requiredPrivacyPolicySubjectIds);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toEqual(
      expect.arrayContaining([
        "Privacy Policy publication status must be published.",
        "Privacy Policy publication requires an effective ISO timestamp.",
        "Privacy Policy publication requires a non-placeholder counsel approval reference.",
        "Privacy Policy publication requires at least one reviewed rollout jurisdiction or product limit.",
      ]),
    );
    expect(isConsentActivatable(privacyPolicyArtifact, requiredPrivacyPolicySubjectIds)).toBe(false);
  });

  it("is non-ready for blank, whitespace-only, and missing required operative copy", () => {
    for (const draftText of ["", "   \n\t "]) {
      const blank = withSection("retention", () => draftText);
      expect(evaluatePublicPolicyPublicationReadiness(blank, requiredPrivacyPolicySubjectIds).ready).toBe(false);
      expect(isConsentActivatable(blank, requiredPrivacyPolicySubjectIds)).toBe(false);
    }
    const missingSubject: PublicPolicyArtifact = {
      ...privacyPolicyArtifact,
      sections: privacyPolicyArtifact.sections.filter((section) => section.id !== "retention"),
    };
    expect(evaluatePublicPolicyPublicationReadiness(missingSubject, requiredPrivacyPolicySubjectIds).errors).toEqual(
      expect.arrayContaining(["Privacy Policy publication is missing required subject 'retention'."]),
    );
  });

  it("cites only product-truth references that resolve to real source lines", () => {
    for (const section of privacyPolicyArtifact.sections) {
      for (const reference of section.reviewManifest.productTruthRefs) {
        if (!/:\d+(-\d+)?$/.test(reference)) continue;
        const slice = readCitedSourceSlice(repoRoot, reference);
        expect(slice.error, `${section.id} -> ${reference}`).toBeUndefined();
      }
    }
  });

  it("keeps every canonical claim consistent with the shared registry provenance identity", () => {
    const registry: readonly PublicPolicyRegistryEntry[] = [
      { artifact: privacyPolicyArtifact, requiredSubjectIds: requiredPrivacyPolicySubjectIds },
    ];
    expect(evaluateCanonicalClaimConsistency(registry, repoRoot)).toEqual([]);
  });

  it("carries one classification binding per derived fact, with closed families and boundaries", () => {
    expect(evaluate()).toEqual([]);
    expect(privacyProductTruthBindings).toHaveLength(inventory.facts.length);
    for (const binding of privacyProductTruthBindings) {
      expect(privacyNoticeBoundaries, binding.factId).toContain(binding.classification.noticeBoundary);
      expect(privacyFactFamilies, binding.factId).toContain(binding.classification.factFamily);
      expect(binding.factualSummary.trim().length, binding.factId).toBeGreaterThan(0);
    }
    expect(new Set(privacyProductTruthBindings.map((binding) => binding.factId)).size).toBe(
      privacyProductTruthBindings.length,
    );
  });

  it("reserves the 'service provider' characterization for the N6 counsel question", () => {
    expect(evaluatePrivacyReservedCharacterizations(privacyPolicyArtifact)).toEqual([]);
    const reintroduced = withSection("recipients-and-disclosures", (text) =>
      text.replace("the companies that perform specific functions for the marketplace", "its service providers"),
    );
    expect(evaluatePrivacyReservedCharacterizations(reintroduced)).toEqual([
      "Privacy section 'recipients-and-disclosures' uses the reserved characterization 'service provider' in operative copy; the N6 counsel question owns whether any provider is a 'service provider', 'contractor', 'processor', or an independent business.",
    ]);
    const droppedQuestion: PublicPolicyArtifact = {
      ...privacyPolicyArtifact,
      sections: privacyPolicyArtifact.sections.map((section) =>
        section.id === "recipients-and-disclosures"
          ? {
              ...section,
              reviewManifest: {
                ...section.reviewManifest,
                openQuestions: section.reviewManifest.openQuestions.filter(
                  (question) => !question.toLowerCase().includes("service provider"),
                ),
              },
            }
          : section,
      ),
    };
    expect(evaluatePrivacyReservedCharacterizations(droppedQuestion)).toEqual([
      "Privacy section 'recipients-and-disclosures' no longer carries the counsel question that reserves 'service provider'.",
    ]);
  });

  it("makes no closed-count claim about cookies or browser storage", () => {
    const cookies = sectionText(privacyPolicyArtifact, "cookies-and-analytics");
    expect(cookies).toContain("rather than asserting a fixed total");
    expect(cookies).not.toMatch(
      /\b(?:ten|eleven|twelve|five|six|\d+)\s+(?:first-party\s+)?cookies\b|\bthese are the only\b|\bthe complete list of cookies\b/i,
    );
  });

  it("reserves every counsel-owned conclusion behind an explicit placeholder", () => {
    expect(sectionText(privacyPolicyArtifact, "gpc-and-sale-share")).toContain("[SALE-SHARE-AND-GPC-STATEMENT:");
    expect(sectionText(privacyPolicyArtifact, "privacy-rights-and-requests")).toContain(
      "[RIGHTS-VERIFICATION-AND-RESPONSE:",
    );
    expect(sectionText(privacyPolicyArtifact, "privacy-rights-and-requests")).toContain("[NOTICE-EMAIL]");
    expect(sectionText(privacyPolicyArtifact, "children")).toContain("[CHILDREN-STATEMENT:");
    expect(sectionText(privacyPolicyArtifact, "state-supplements")).toContain("[STATE-SUPPLEMENTS:");
    const admt = sectionText(privacyPolicyArtifact, "automated-decisionmaking-technology");
    expect(admt).toContain("[ADMT-APPLICABILITY:");
    expect(admt).toContain("became effective on January 1, 2026");
    expect(admt).toContain("begins on January 1, 2027 for businesses whose use");
    expect(admt).toContain("does not currently use card-scanning or image-recognition technology");
    expect(admt).not.toMatch(/ADMT (?:rules|regulations|requirements) apply to Chase Sets/i);
  });

  it("claims no concrete provider-controlled storage behaviour anywhere in operative copy", () => {
    for (const section of privacyPolicyArtifact.sections) {
      expect(section.draftText, section.id).not.toMatch(/\b(?:__stripe_mid|__stripe_sid|machine identifier cookie)\b/i);
    }
    const cookies = sectionText(privacyPolicyArtifact, "cookies-and-analytics");
    expect(cookies).toContain("may use provider-controlled client-side storage");
    expect(cookies).toContain("described by that provider rather than by Chase Sets");
  });

  it("describes the marketplace CacheStorage family factually without a legal conclusion", () => {
    const cookies = sectionText(privacyPolicyArtifact, "cookies-and-analytics");
    expect(cookies).toContain("chase-sets-marketplace-pwa-v1");
    expect(cookies).toContain("skips requests carrying credentials");
    expect(cookies).not.toMatch(/\b(?:strictly necessary|not personal information|exempt from consent)\b/i);
  });
});

describe(
  "Privacy Policy one-variable controls",
  () => {
    it("control 1: removing exactly chase_sets_anonymous_cart reds only that cookie binding", () => {
      const mutant = withSection("cookies-and-analytics", (text) =>
        text.replace("a signed-out cart (chase_sets_anonymous_cart), ", "a signed-out cart, "),
      );
      expectSoleViolation(
        evaluate(mutant),
        /Privacy section 'cookies-and-analytics' does not disclose 'chase_sets_anonymous_cart' required by binding 'cookie-anonymous-cart'\./,
      );
    });

    it("control 2: removing exactly discovery.search.loader-cache.v1 reds only that Web Storage binding", () => {
      const mutant = withSection("cookies-and-analytics", (text) =>
        text.replace(
          "and discovery.search.loader-cache.v1 holds a bounded, time-limited set of search responses keyed by the search URL that produced them.",
          "and a further bounded cache holds recent search responses.",
        ),
      );
      expectSoleViolation(
        evaluate(mutant),
        /does not disclose 'discovery\.search\.loader-cache\.v1' required by binding 'web-storage-search-loader-cache'\./,
      );
    });

    it("control 3: removing exactly Facebook from recipients reds only the Facebook recipient disclosure", () => {
      const mutant = withSection("recipients-and-disclosures", (text) =>
        text.replace("when you choose Google or Facebook social login", "when you choose Google social login"),
      );
      expectSoleViolation(
        evaluate(mutant),
        /Privacy section 'recipients-and-disclosures' does not disclose 'facebook' required by binding 'social-provider-facebook'\./,
      );
    });

    it("control 6: removing only the provider-injected disclosure keeps every cookie and Web Storage binding green", () => {
      const cookies = sectionText(privacyPolicyArtifact, "cookies-and-analytics");
      const providerParagraphStart = cookies.indexOf("Some pages load a payment provider's own browser script.");
      const providerParagraphEnd = cookies.indexOf("In production builds the marketplace also registers");
      expect(providerParagraphStart).toBeGreaterThan(-1);
      expect(providerParagraphEnd).toBeGreaterThan(providerParagraphStart);
      const mutant = withSection(
        "cookies-and-analytics",
        (text) => text.slice(0, providerParagraphStart) + text.slice(providerParagraphEnd),
      );

      // Six required route tokens across the four provider surfaces.
      const violations = evaluate(mutant);
      expect(violations).toHaveLength(6);
      for (const violation of violations) {
        expect(violation).toMatch(/required by binding 'provider-loader-/);
      }
      expect(new Set(violations.map((violation) => /binding '([^']+)'/.exec(violation)?.[1])).size).toBe(4);
      // Frozen families: no cookie, Web Storage, CacheStorage, or social-provider
      // binding turns red through this mutant.
      for (const family of ["cookie-", "web-storage-", "cache-storage-", "social-provider-"]) {
        expect(violations.filter((violation) => violation.includes(`binding '${family}`))).toEqual([]);
      }
    });

    it("control 8: removing only the marketplace CacheStorage classification reds only the CacheStorage fact", () => {
      const mutantBindings = privacyProductTruthBindings.filter(
        (binding) => binding.factId !== "cache-storage-marketplace-pwa",
      );
      expectSoleViolation(
        evaluate(privacyPolicyArtifact, mutantBindings),
        /missing binding: the inventory derives cache-storage subject 'chase-sets-marketplace-pwa-v1' with no classification binding\./,
      );
    });

    it("operator-boundary control: an operator-only subject in operative copy fails for its own reason", () => {
      const mutant = withSection(
        "cookies-and-analytics",
        (text) =>
          `${text} Operators also keep review selections in catalog.primaryWorkbench.observationSelection. keys.`,
      );
      expectSoleViolation(
        evaluate(mutant),
        /operator-only subject 'catalog\.primaryWorkbench\.observationSelection\.\*' appears in the operative copy of section 'cookies-and-analytics'/,
      );
    });

    it("operator-visibility control: dropping the N9 counsel question hides an operator-only subject", () => {
      const mutant: PublicPolicyArtifact = {
        ...privacyPolicyArtifact,
        sections: privacyPolicyArtifact.sections.map((section) =>
          section.id === "cookies-and-analytics"
            ? {
                ...section,
                reviewManifest: {
                  ...section.reviewManifest,
                  openQuestions: section.reviewManifest.openQuestions.filter(
                    (question) => !question.includes("catalog.primaryWorkbench.observationSelection."),
                  ),
                },
              }
            : section,
        ),
      };
      const violations = evaluate(mutant);
      expect(violations).toHaveLength(2);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "operator-only subject 'catalog.primaryWorkbench.observationSelection.*' is not counsel-visible",
          ),
          expect.stringContaining("operator-only subject 'chase-sets-admin-pwa-v1' is not counsel-visible"),
        ]),
      );
    });

    it("hostedDomain control: omitting Google's hosted-domain mapping fails for its own reason", () => {
      const mutant = withSection("data-categories-and-sources", (text) =>
        text.replace(
          " For Google, that mapped profile also includes the hosted domain (the Google Workspace domain claim) when the signing-in account has one.",
          "",
        ),
      );
      expectSoleViolation(
        evaluate(mutant),
        /Privacy section 'data-categories-and-sources' does not disclose 'hostedDomain' required by binding 'social-provider-google'\./,
      );
    });

    it("adjacent-ref control: swapping one evidence ref for a resolving adjacent range fails as stale evidence", () => {
      const adjacent = "bounded-contexts/checkout/support/request-support/guest-checkout.ts:45-48";
      expect(readCitedSourceSlice(repoRoot, adjacent).error).toBeUndefined();
      const mutantBindings = privacyProductTruthBindings.map((binding) =>
        binding.factId === "cookie-anonymous-cart"
          ? {
              ...binding,
              evidenceRefs: binding.evidenceRefs.map((ref) =>
                ref === "bounded-contexts/checkout/support/request-support/guest-checkout.ts:64-67" ? adjacent : ref,
              ),
            }
          : binding,
      );
      expectSoleViolation(
        evaluate(privacyPolicyArtifact, mutantBindings),
        /stale evidence on binding 'cookie-anonymous-cart'/,
      );
    });

    it("entailment control: a disclosure token the evidence does not entail is rejected", () => {
      const mutantBindings = privacyProductTruthBindings.map((binding) =>
        binding.factId === "provider-loader-stripe-js-setup-card"
          ? {
              ...binding,
              disclosures: [{ sectionId: "cookies-and-analytics", requiredTokens: ["__stripe_mid"] }],
            }
          : binding,
      );
      expectSoleViolation(
        evaluate(privacyPolicyArtifact, mutantBindings),
        /binding 'provider-loader-stripe-js-setup-card' requires disclosure token '__stripe_mid', which its derived evidence does not entail\./,
      );
    });

    it("classification controls: duplicate, multiply classified, orphan, and unknown-family bindings all fail", () => {
      const duplicate = evaluate(privacyPolicyArtifact, [
        ...privacyProductTruthBindings,
        privacyProductTruthBindings[0],
      ]);
      expect(duplicate).toEqual([`duplicate binding factId '${privacyProductTruthBindings[0].factId}'.`]);

      const orphan = evaluate(privacyPolicyArtifact, [
        ...privacyProductTruthBindings,
        {
          factId: "cookie-not-shipped",
          classification: { noticeBoundary: "consumer-notice", factFamily: "first-party-cookie" },
          inventorySubject: "chase_sets_never_shipped",
          evidenceRefs: ["bounded-contexts/auth/support/request-support/cookies.ts:1"],
          factualSummary: "A cookie the inventory does not derive.",
          disclosures: [{ sectionId: "cookies-and-analytics", requiredTokens: ["chase_sets_never_shipped"] }],
        },
      ]);
      expectSoleViolation(orphan, /orphan binding 'cookie-not-shipped'/);

      const unknownFamily = evaluate(privacyPolicyArtifact, [
        ...privacyProductTruthBindings,
        {
          ...privacyProductTruthBindings[0],
          factId: "unknown-family-binding",
          classification: {
            noticeBoundary: "consumer-notice",
            factFamily: "third-party-pixel" as never,
          },
        },
      ]);
      expectSoleViolation(unknownFamily, /declares unknown fact family 'third-party-pixel'\./);

      const unknownBoundary = evaluate(privacyPolicyArtifact, [
        ...privacyProductTruthBindings,
        {
          ...privacyProductTruthBindings[0],
          factId: "unknown-boundary-binding",
          classification: { noticeBoundary: "internal-only" as never, factFamily: "first-party-cookie" },
        },
      ]);
      expectSoleViolation(unknownBoundary, /declares unknown notice boundary 'internal-only'\./);

      const multiplyClassified = evaluate(privacyPolicyArtifact, [
        ...privacyProductTruthBindings.filter((binding) => binding.factId !== "cache-storage-admin-pwa"),
        {
          ...privacyProductTruthBindings.find((binding) => binding.factId === "cache-storage-admin-pwa")!,
          classification: { noticeBoundary: "consumer-notice", factFamily: "cache-storage" },
          disclosures: [{ sectionId: "cookies-and-analytics", requiredTokens: ["chase-sets-admin-pwa-v1"] }],
        },
        {
          ...privacyProductTruthBindings.find((binding) => binding.factId === "cache-storage-admin-pwa")!,
          factId: "cache-storage-admin-pwa-operator",
          classification: { noticeBoundary: "operator-only", factFamily: "cache-storage" },
        },
      ]);
      expect(multiplyClassified).toEqual(expect.arrayContaining([expect.stringContaining("is multiply classified")]));
    });

    it("an unresolved inventory makes every binding evaluation fail closed", () => {
      const violations = evaluatePrivacyProductTruthBindings({
        inventory: {
          ...inventory,
          indeterminate: [{ factFamily: "cache-storage", reason: "synthetic unresolved derivation" }],
        },
        artifact: privacyPolicyArtifact,
      });
      expect(violations).toEqual([
        "unresolved product-truth derivation [cache-storage]: synthetic unresolved derivation",
      ]);
    });

    it("keeps the candidate publishable only after counsel approval is separately recorded", () => {
      const approved: PublicPolicyArtifact = {
        ...privacyPolicyArtifact,
        metadata: {
          ...privacyPolicyArtifact.metadata,
          publicationStatus: "published",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          counselApprovalReference: "LEGAL-PRIVACY-TEST-2026-08-15",
          rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
        },
        sections: privacyPolicyArtifact.sections.map((section) => ({
          ...section,
          reviewStatus: "counsel-approved" as const,
        })),
      };
      expect(evaluatePublicPolicyPublicationReadiness(approved, requiredPrivacyPolicySubjectIds)).toEqual({
        ready: true,
        errors: [],
      });
      // The candidate that ships in this change is still the fail-closed one.
      expect(privacyPolicyArtifact.metadata.publicationStatus).toBe("counsel-review-required");
      expect(isConsentActivatable(privacyPolicyArtifact, requiredPrivacyPolicySubjectIds)).toBe(false);
    });
  },
  LONG_DERIVATION_MS,
);
