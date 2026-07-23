import { describe, expect, it } from "vitest";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  isPublicPolicyEffectiveAt,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { requiredTermsOfServiceSubjectIds, termsOfServicePolicyArtifact } from "./terms-of-service";

function approvedTermsArtifact(): PublicPolicyArtifact {
  return {
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
  };
}

describe("public policy artifact closed schema", () => {
  it("accepts only real UTC instants in the canonical effective-at format", () => {
    expect(isPublicPolicyEffectiveAt("2026-09-01T00:00:00Z")).toBe(true);
    expect(isPublicPolicyEffectiveAt("2026-09-01T00:00:00.000Z")).toBe(true);

    for (const value of [
      "not-a-date",
      "2026-09-01",
      "2026-09-01T00:00:00",
      "2026-09-01T00:00:00+00:00",
      "2026-02-31T00:00:00.000Z",
    ]) {
      expect(isPublicPolicyEffectiveAt(value)).toBe(false);
    }
  });

  it("accepts the checked-in artifacts and the fully approved shape", () => {
    expect(validatePublicPolicyArtifactStructure(termsOfServicePolicyArtifact)).toEqual([]);
    expect(validatePublicPolicyArtifactStructure(approvedTermsArtifact())).toEqual([]);
  });

  it("rejects unknown fields at the artifact and metadata levels", () => {
    const withTopLevelUnknown = {
      ...termsOfServicePolicyArtifact,
      internalDraftNotes: "smuggled",
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withTopLevelUnknown)).toContain(
      "Terms of Service artifact has unexpected field 'internalDraftNotes'.",
    );

    const withMetadataUnknown = {
      ...termsOfServicePolicyArtifact,
      metadata: { ...termsOfServicePolicyArtifact.metadata, reviewedBy: "someone" },
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withMetadataUnknown)).toContain(
      "Terms of Service artifact has unexpected field 'metadata.reviewedBy'.",
    );
  });

  it("rejects nested unknown fields inside sections, review manifests, and assumptions", () => {
    const [firstSection, ...rest] = termsOfServicePolicyArtifact.sections;

    const withSectionUnknown = {
      ...termsOfServicePolicyArtifact,
      sections: [{ ...firstSection, placeholderScope: "legacy field" }, ...rest],
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withSectionUnknown)).toContain(
      "Terms of Service artifact has unexpected field 'sections['wallet-nature-custody-interest'].placeholderScope'.",
    );

    const withManifestUnknown = {
      ...termsOfServicePolicyArtifact,
      sections: [
        { ...firstSection, reviewManifest: { ...firstSection.reviewManifest, internalNote: "smuggled" } },
        ...rest,
      ],
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withManifestUnknown)).toContain(
      "Terms of Service artifact has unexpected field 'sections['wallet-nature-custody-interest'].reviewManifest.internalNote'.",
    );

    const withAssumptionUnknown = {
      ...termsOfServicePolicyArtifact,
      sections: [
        {
          ...firstSection,
          reviewManifest: {
            ...firstSection.reviewManifest,
            assumptions: [{ assertion: "A claim.", evidenceRef: "a/file.ts", confidence: "high" }],
          },
        },
        ...rest,
      ],
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withAssumptionUnknown)).toContain(
      "Terms of Service artifact has unexpected field 'sections['wallet-nature-custody-interest'].reviewManifest.assumptions[].confidence'.",
    );
  });

  it("rejects malformed metadata and manifest values", () => {
    const withBadVersion = {
      ...termsOfServicePolicyArtifact,
      metadata: { ...termsOfServicePolicyArtifact.metadata, version: "v0" },
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withBadVersion).join("\n")).toContain("version must match");

    const withBadTimestamp = {
      ...termsOfServicePolicyArtifact,
      metadata: { ...termsOfServicePolicyArtifact.metadata, effectiveAt: "2026-13-99T99:99:99Z" },
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withBadTimestamp)).toContain(
      "Terms of Service artifact effectiveAt must be null or an ISO timestamp.",
    );

    const withWrongHref = {
      ...termsOfServicePolicyArtifact,
      metadata: { ...termsOfServicePolicyArtifact.metadata, href: "/privacy" },
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withWrongHref)).toContain(
      "Terms of Service artifact href must be the canonical '/terms' route.",
    );

    const withUnknownKey = {
      ...termsOfServicePolicyArtifact,
      metadata: { ...termsOfServicePolicyArtifact.metadata, policyKey: "shipping-terms" },
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withUnknownKey)).toContain(
      "Public policy artifact policy key must be one of the registered public policy keys.",
    );

    const [firstSection, ...rest] = termsOfServicePolicyArtifact.sections;
    const withBadDecisionRefs = {
      ...termsOfServicePolicyArtifact,
      sections: [
        { ...firstSection, reviewManifest: { ...firstSection.reviewManifest, decisionRefs: ["#5677"] } },
        ...rest,
      ],
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withBadDecisionRefs)).toContain(
      "Terms of Service section 'wallet-nature-custody-interest' review manifest decision refs must be positive issue numbers.",
    );

    const withBadReviewStatus = {
      ...termsOfServicePolicyArtifact,
      sections: [{ ...firstSection, reviewStatus: "approved" }, ...rest],
    } as unknown as PublicPolicyArtifact;
    expect(validatePublicPolicyArtifactStructure(withBadReviewStatus)).toContain(
      "Terms of Service section 'wallet-nature-custody-interest' review status must be one of counsel-required, counsel-approved.",
    );
  });

  it("fails the readiness gate for structurally invalid artifacts before evaluating publication state", () => {
    const withManifestUnknown = {
      ...termsOfServicePolicyArtifact,
      sections: termsOfServicePolicyArtifact.sections.map((section) => ({
        ...section,
        reviewManifest: { ...section.reviewManifest, internalNote: "smuggled" },
      })),
    } as unknown as PublicPolicyArtifact;

    const readiness = evaluatePublicPolicyPublicationReadiness(withManifestUnknown, requiredTermsOfServiceSubjectIds);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors.every((error) => error.includes("unexpected field"))).toBe(true);
  });
});

describe("publication-to-activation invariant", () => {
  it("keeps counsel-pending artifacts non-activatable and flips only for a published, readiness-valid artifact", () => {
    expect(isConsentActivatable(termsOfServicePolicyArtifact, requiredTermsOfServiceSubjectIds)).toBe(false);
    expect(isConsentActivatable(approvedTermsArtifact(), requiredTermsOfServiceSubjectIds)).toBe(true);

    const approvedButUnpublished: PublicPolicyArtifact = {
      ...approvedTermsArtifact(),
      metadata: { ...approvedTermsArtifact().metadata, publicationStatus: "counsel-review-required" },
    };
    expect(isConsentActivatable(approvedButUnpublished, requiredTermsOfServiceSubjectIds)).toBe(false);
  });

  it.each(["", "   \n\t"])("rejects required operative copy containing only %j", (draftText) => {
    const [firstSection, ...rest] = approvedTermsArtifact().sections;
    const artifact: PublicPolicyArtifact = {
      ...approvedTermsArtifact(),
      sections: [{ ...firstSection, draftText }, ...rest],
    };

    const readiness = evaluatePublicPolicyPublicationReadiness(artifact, requiredTermsOfServiceSubjectIds);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toContain(
      `Terms of Service subject '${firstSection.id}' requires non-empty operative copy.`,
    );
    expect(isConsentActivatable(artifact, requiredTermsOfServiceSubjectIds)).toBe(false);
  });

  it("rejects an unreviewed extra section on an otherwise publication-ready artifact", () => {
    const artifact: PublicPolicyArtifact = {
      ...approvedTermsArtifact(),
      sections: [
        ...approvedTermsArtifact().sections,
        {
          id: "extra-public-section",
          title: "Extra public section",
          draftText: "Operative test copy for the extra section.",
          reviewStatus: "counsel-required",
          reviewManifest: {
            scopeNote: "Test-only extra section review scope.",
            decisionRefs: [],
            productTruthRefs: [],
            openQuestions: [],
            assumptions: [],
          },
        },
      ],
    };

    const readiness = evaluatePublicPolicyPublicationReadiness(artifact, requiredTermsOfServiceSubjectIds);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors).toContain(
      "Terms of Service additional subject 'extra-public-section' requires counsel-approved copy.",
    );
    expect(isConsentActivatable(artifact, requiredTermsOfServiceSubjectIds)).toBe(false);
  });
});
