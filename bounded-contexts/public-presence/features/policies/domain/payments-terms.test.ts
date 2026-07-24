import { describe, expect, it } from "vitest";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { paymentsTermsPolicyArtifact, requiredPaymentsTermsSubjectIds } from "./payments-terms";

function approvedPaymentsTermsArtifact(): PublicPolicyArtifact {
  return {
    ...paymentsTermsPolicyArtifact,
    metadata: {
      ...paymentsTermsPolicyArtifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      counselApprovalReference: "LEGAL-PAYMENTS-TERMS-TEST-2026-08-15",
      rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
    },
    sections: paymentsTermsPolicyArtifact.sections.map((section) => ({
      ...section,
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

// Every one of these is a claim #5688 must not make in operative copy: the
// selected Stripe service agreement type, exact agreement-selection fields,
// agreement-specific mechanics, the resolved Accounts v1/v2 posture, or a
// dashboard/loss/fee/requirements-allocation claim tied to that agreement.
const forbiddenAgreementSpecificPatterns: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "'full' service agreement type", pattern: /\bfull\b/i },
  { label: "'recipient' service agreement type", pattern: /\brecipient\b/i },
  { label: "tos_acceptance field", pattern: /tos_acceptance/i },
  { label: "service_agreement field", pattern: /service_agreement/i },
  { label: "resolved Accounts v1/v2 posture", pattern: /accounts\s*v[12]/i },
  { label: "dashboard=none controller posture", pattern: /dashboard\s*[:=]?\s*none/i },
  { label: "losses-collector allocation", pattern: /loss(?:es)?[\s_-]*collector/i },
  { label: "fees-collector allocation", pattern: /fees?[\s_-]*collector/i },
  { label: "requirements-collector allocation", pattern: /requirements?[\s_-]*collector/i },
  { label: "transfers-only capability claim", pattern: /transfers[\s-]*only/i },
];

const numericSlaPattern = /\d+\s*(?:hour|day|business\s*day|minute)/i;

function collectRenderedSurfaces(artifact: PublicPolicyArtifact) {
  return [
    { path: "title", value: artifact.title },
    { path: "description", value: artifact.description },
    ...artifact.sections.flatMap((section) => [
      { path: `sections['${section.id}'].title`, value: section.title },
      { path: `sections['${section.id}'].draftText`, value: section.draftText },
    ]),
  ];
}

describe("payments terms artifact", () => {
  it("is structurally valid and registered under the canonical /payments-terms route", () => {
    expect(paymentsTermsPolicyArtifact.metadata.policyKey).toBe("payments-terms");
    expect(paymentsTermsPolicyArtifact.metadata.href).toBe("/payments-terms");
    expect(validatePublicPolicyArtifactStructure(paymentsTermsPolicyArtifact)).toEqual([]);
    expect(validatePublicPolicyArtifactStructure(approvedPaymentsTermsArtifact())).toEqual([]);
  });

  it("drafts non-empty generic copy for every required Scope subject", () => {
    const sectionsById = new Map(paymentsTermsPolicyArtifact.sections.map((section) => [section.id, section]));
    expect(sectionsById.size).toBe(requiredPaymentsTermsSubjectIds.length);

    for (const subjectId of requiredPaymentsTermsSubjectIds) {
      const section = sectionsById.get(subjectId);
      expect(section, `missing required subject '${subjectId}'`).toBeDefined();
      expect(section?.draftText.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("contains no forbidden agreement-specific claims in title, description, section titles, or draft text", () => {
    const surfaces = collectRenderedSurfaces(paymentsTermsPolicyArtifact);

    for (const surface of surfaces) {
      for (const forbidden of forbiddenAgreementSpecificPatterns) {
        expect(
          forbidden.pattern.test(surface.value),
          `${surface.path} must not assert ${forbidden.label}: "${surface.value}"`,
        ).toBe(false);
      }
    }
  });

  it("does not invent numeric timing, clearance, dispute, or verification SLAs", () => {
    const surfaces = collectRenderedSurfaces(paymentsTermsPolicyArtifact);

    for (const surface of surfaces) {
      expect(numericSlaPattern.test(surface.value), `${surface.path} must not invent a numeric SLA: "${surface.value}"`).toBe(
        false,
      );
    }
  });

  it("does not let generic wording encode the #5924 agreement decision by referencing issue numbers in operative copy", () => {
    for (const section of paymentsTermsPolicyArtifact.sections) {
      expect(section.draftText).not.toMatch(/#\d+/);
    }
    expect(paymentsTermsPolicyArtifact.title).not.toMatch(/#\d+/);
    expect(paymentsTermsPolicyArtifact.description).not.toMatch(/#\d+/);
  });

  it("carries a conspicuous, non-placeholder open question and assumption linking #5924 and #5923", () => {
    const sectionsWithGateNote = paymentsTermsPolicyArtifact.sections.filter((section) =>
      section.reviewManifest.openQuestions.some((question) => question.includes("#5924") && question.includes("#5923")),
    );

    // Conspicuous means present on more than one section that the agreement
    // type materially affects (the collection-agent framing and payout
    // timing), not buried in a single easy-to-miss spot.
    expect(sectionsWithGateNote.length).toBeGreaterThanOrEqual(2);

    for (const section of sectionsWithGateNote) {
      const openQuestion = section.reviewManifest.openQuestions.find(
        (question) => question.includes("#5924") && question.includes("#5923"),
      );
      expect(openQuestion).toBeDefined();
      expect(openQuestion).toContain("manifest-only");
      expect(openQuestion).not.toMatch(/\bTODO\b|\bTBD\b/i);

      const assumption = section.reviewManifest.assumptions.find((candidate) =>
        candidate.assertion.includes("#5924/#5923"),
      );
      expect(assumption).toBeDefined();
      expect(assumption?.evidenceRef.length).toBeGreaterThan(0);

      // The gate note is manifest-only drafting metadata: it must never
      // appear inside the section's own operative public copy.
      expect(section.draftText).not.toContain("#5924");
      expect(section.draftText).not.toContain("#5923");
    }
  });

  it("remains counsel-required and non-operative despite carrying drafted generic copy", () => {
    expect(paymentsTermsPolicyArtifact.metadata.publicationStatus).toBe("counsel-review-required");
    expect(paymentsTermsPolicyArtifact.metadata.effectiveAt).toBeNull();
    expect(paymentsTermsPolicyArtifact.metadata.counselApprovalReference).toBeNull();

    for (const section of paymentsTermsPolicyArtifact.sections) {
      expect(section.reviewStatus).toBe("counsel-required");
    }

    const readiness = evaluatePublicPolicyPublicationReadiness(
      paymentsTermsPolicyArtifact,
      requiredPaymentsTermsSubjectIds,
    );
    expect(readiness.ready).toBe(false);
    expect(isConsentActivatable(paymentsTermsPolicyArtifact, requiredPaymentsTermsSubjectIds)).toBe(false);
  });

  it("would pass readiness once every section is counsel-approved and the artifact is published", () => {
    const approved = approvedPaymentsTermsArtifact();
    const readiness = evaluatePublicPolicyPublicationReadiness(approved, requiredPaymentsTermsSubjectIds);
    expect(readiness.ready).toBe(true);
    expect(readiness.errors).toEqual([]);
    expect(isConsentActivatable(approved, requiredPaymentsTermsSubjectIds)).toBe(true);
  });
});
