import { describe, expect, it } from "vitest";
import {
  evaluateTermsOfServicePublicationReadiness,
  requiredTermsOfServiceSubjectIds,
  termsOfServicePolicyArtifact,
  type TermsOfServiceSubjectId,
} from "./terms-of-service";

describe("Terms of Service policy artifact", () => {
  it("is a versioned, linkable, locale-specific artifact aligned to the canonical consent key", () => {
    expect(termsOfServicePolicyArtifact.metadata).toMatchObject({
      policyKey: "terms-of-service",
      version: "v1",
      locale: "en",
      href: "/terms",
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
    });
  });

  it("models the complete wallet plus marketplace policy taxonomy required before publication", () => {
    expect(requiredTermsOfServiceSubjectIds).toEqual([
      "wallet-nature-custody-interest",
      "cash-equivalent-and-marketplace-credit",
      "adjustment-authority",
      "provisional-credits-and-reversals",
      "setoff",
      "negative-balances-and-restrictions",
      "history-notice-and-disputes",
      "suspension-closure-and-holds",
      "effective-date-notice-and-acceptance",
      "evidence-and-fair-use",
      "marketplace-role-and-limited-payments-agent",
      "eligibility-and-accounts",
      "listings-offers-and-contract-formation",
      "conduct-and-policy-incorporation",
      "user-content-license",
      "electronic-agents-and-automated-access",
      "electronic-communications-and-esign",
      "disclaimers-and-liability-limits",
      "user-vs-user-dispute-release",
      "dispute-resolution-with-platform",
      "governing-law-and-forum",
      "changes-notice-and-acceptance",
    ]);
    expect(termsOfServicePolicyArtifact.sections.map((section) => section.id)).toEqual(
      requiredTermsOfServiceSubjectIds,
    );
    expect(termsOfServicePolicyArtifact.sections.every((section) => section.reviewStatus === "counsel-required")).toBe(
      true,
    );
  });

  it("has non-empty counsel-ready draft copy and a complete review manifest for every subject", () => {
    const sensitiveDecisionRefsBySubject: Partial<Record<TermsOfServiceSubjectId, number>> = {
      "dispute-resolution-with-platform": 5681,
      "governing-law-and-forum": 5677,
    };

    for (const section of termsOfServicePolicyArtifact.sections) {
      expect(section.draftText.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.scopeNote.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.assumptions.length).toBeGreaterThan(0);
      for (const assumption of section.reviewManifest.assumptions) {
        expect(assumption.assertion.trim().length).toBeGreaterThan(0);
        expect(assumption.evidenceRef.trim().length).toBeGreaterThan(0);
      }

      const requiredDecisionRef = sensitiveDecisionRefsBySubject[section.id];
      if (requiredDecisionRef !== undefined) {
        expect(section.reviewManifest.decisionRefs).toContain(requiredDecisionRef);
      }
    }
  });

  it("keeps fees, windows, and caps as policy references instead of prose numbers, other than the ratified arbitration mechanics", () => {
    const exemptFromNoProseNumberRule: readonly TermsOfServiceSubjectId[] = ["dispute-resolution-with-platform"];

    for (const section of termsOfServicePolicyArtifact.sections) {
      if (exemptFromNoProseNumberRule.includes(section.id)) {
        continue;
      }
      expect(section.draftText).not.toMatch(/\$\d/);
      expect(section.draftText).not.toMatch(/\d+(\.\d+)?\s?%/);
    }
  });

  it("fails the publication gate while counsel copy, approval, effective date, and rollout limits remain pending", () => {
    const readiness = evaluateTermsOfServicePublicationReadiness(termsOfServicePolicyArtifact);

    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toEqual(
      expect.arrayContaining([
        "Terms of Service publication status must be published.",
        "Terms of Service publication requires an effective ISO timestamp.",
        "Terms of Service publication requires a non-placeholder counsel approval reference.",
        "Terms of Service publication requires at least one reviewed rollout jurisdiction or product limit.",
      ]),
    );
    expect(readiness.errors.filter((error) => error.includes("requires counsel-approved copy"))).toHaveLength(
      requiredTermsOfServiceSubjectIds.length,
    );
    expect(readiness.errors.filter((error) => error.includes("requires non-empty operative copy"))).toHaveLength(0);
  });

  it("accepts a fully reviewed publication without changing the required subject taxonomy", () => {
    const readiness = evaluateTermsOfServicePublicationReadiness({
      ...termsOfServicePolicyArtifact,
      metadata: {
        ...termsOfServicePolicyArtifact.metadata,
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        counselApprovalReference: "LEGAL-WALLET-TERMS-2026-08-15",
        rolloutJurisdictionsOrProductLimits: ["United States launch scope approved in the referenced record."],
      },
      sections: termsOfServicePolicyArtifact.sections.map((section) => ({
        ...section,
        draftText: `Reviewed operative test copy for ${section.id}.`,
        reviewStatus: "counsel-approved" as const,
      })),
    });

    expect(readiness).toEqual({ ready: true, errors: [] });
  });
});
