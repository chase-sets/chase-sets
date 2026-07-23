import { describe, expect, it } from "vitest";
import {
  evaluateTermsOfServicePublicationReadiness,
  requiredTermsOfServiceSubjectIds,
  termsOfServicePolicyArtifact,
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

  it("models every wallet and balance policy subject required before publication", () => {
    expect(termsOfServicePolicyArtifact.sections.map((section) => section.id)).toEqual(
      requiredTermsOfServiceSubjectIds,
    );
    expect(termsOfServicePolicyArtifact.sections.every((section) => section.reviewStatus === "counsel-required")).toBe(
      true,
    );
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
    expect(readiness.errors.filter((error) => error.includes("requires non-empty operative copy"))).toHaveLength(
      requiredTermsOfServiceSubjectIds.length,
    );
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
