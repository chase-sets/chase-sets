import { describe, expect, it } from "vitest";
import {
  evaluateSellerAgreementPublicationReadiness,
  requiredSellerAgreementSubjectIds,
  sellerAgreementPolicyArtifact,
} from "./seller-agreement";

describe("Seller Agreement policy artifact", () => {
  it("is a versioned, linkable, locale-specific artifact aligned to the canonical seller-agreement key", () => {
    expect(sellerAgreementPolicyArtifact.metadata).toMatchObject({
      policyKey: "seller-agreement",
      version: "v1",
      locale: "en",
      href: "/seller-agreement",
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
    });
  });

  it("models every subject required before publication, all counsel-required", () => {
    expect(sellerAgreementPolicyArtifact.sections.map((section) => section.id)).toEqual(
      requiredSellerAgreementSubjectIds,
    );
    expect(sellerAgreementPolicyArtifact.sections.every((section) => section.reviewStatus === "counsel-required")).toBe(
      true,
    );
  });

  it("gives every subject non-empty operative draft text and a complete review manifest", () => {
    for (const section of sellerAgreementPolicyArtifact.sections) {
      expect(section.draftText.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.scopeNote.trim().length).toBeGreaterThan(0);
      expect(section.reviewManifest.assumptions.length).toBeGreaterThan(0);
      for (const assumption of section.reviewManifest.assumptions) {
        expect(assumption.assertion.trim().length).toBeGreaterThan(0);
        expect(assumption.evidenceRef.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("carries decision references on every decision-sensitive subject", () => {
    const decisionSensitiveSubjectIds: readonly string[] = [
      "seller-eligibility-and-verification",
      "fees-and-deductions",
      "dispute-resolution",
      "governing-law",
    ];
    for (const subjectId of decisionSensitiveSubjectIds) {
      const section = sellerAgreementPolicyArtifact.sections.find((candidate) => candidate.id === subjectId);
      expect(section?.reviewManifest.decisionRefs.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps commercial policy figures out of prose everywhere except the fixed dispute-resolution mechanics", () => {
    for (const section of sellerAgreementPolicyArtifact.sections) {
      if (section.id === "dispute-resolution") {
        continue;
      }
      expect(section.draftText).not.toMatch(/\d/);
    }
  });

  it("never claims the platform verifies possession, detects circumvention, or offers an appeal workflow it does not have", () => {
    const listingObligations = sellerAgreementPolicyArtifact.sections.find(
      (section) => section.id === "listing-obligations",
    );
    const circumvention = sellerAgreementPolicyArtifact.sections.find(
      (section) => section.id === "off-platform-circumvention",
    );
    const enforcement = sellerAgreementPolicyArtifact.sections.find(
      (section) => section.id === "enforcement-and-termination",
    );

    expect(listingObligations?.draftText).toContain("represent");
    expect(circumvention?.reviewManifest.openQuestions.join(" ")).toContain("no automated");
    expect(enforcement?.draftText).toContain("does not yet offer a structured in-product appeal workflow");
  });

  it("fails the publication gate while counsel copy, approval, effective date, and rollout limits remain pending", () => {
    const readiness = evaluateSellerAgreementPublicationReadiness(sellerAgreementPolicyArtifact);

    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toEqual(
      expect.arrayContaining([
        "Seller Agreement publication status must be published.",
        "Seller Agreement publication requires an effective ISO timestamp.",
        "Seller Agreement publication requires a non-placeholder counsel approval reference.",
        "Seller Agreement publication requires at least one reviewed rollout jurisdiction or product limit.",
      ]),
    );
    expect(readiness.errors.filter((error) => error.includes("requires counsel-approved copy"))).toHaveLength(
      requiredSellerAgreementSubjectIds.length,
    );
  });

  it("accepts a fully reviewed publication without changing the required subject taxonomy", () => {
    const readiness = evaluateSellerAgreementPublicationReadiness({
      ...sellerAgreementPolicyArtifact,
      metadata: {
        ...sellerAgreementPolicyArtifact.metadata,
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        counselApprovalReference: "LEGAL-SELLER-AGREEMENT-2026-08-15",
        rolloutJurisdictionsOrProductLimits: ["United States launch scope approved in the referenced record."],
      },
      sections: sellerAgreementPolicyArtifact.sections.map((section) => ({
        ...section,
        reviewStatus: "counsel-approved" as const,
      })),
    });

    expect(readiness).toEqual({ ready: true, errors: [] });
  });
});
