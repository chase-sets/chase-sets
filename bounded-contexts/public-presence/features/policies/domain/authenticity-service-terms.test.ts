import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authenticityServiceTermsPolicyArtifact,
  requiredAuthenticityServiceTermsSubjectIds,
  type AuthenticityServiceTermsSubjectId,
} from "./authenticity-service-terms";
import { canonicalClaimRegistry } from "./canonical-claims";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { publicPolicyRegistry } from "./policy-registry";
import { termsOfServicePolicyArtifact } from "./terms-of-service";

const domainDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(domainDirectory, "../../../../..");

const requiredIds = requiredAuthenticityServiceTermsSubjectIds;
const sectionsById = new Map(authenticityServiceTermsPolicyArtifact.sections.map((section) => [section.id, section]));

function approvedArtifact(): PublicPolicyArtifact {
  return {
    ...authenticityServiceTermsPolicyArtifact,
    metadata: {
      ...authenticityServiceTermsPolicyArtifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      counselApprovalReference: "LEGAL-AUTHENTICITY-SERVICE-TERMS-TEST-2026-08-15",
      rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
    },
    sections: authenticityServiceTermsPolicyArtifact.sections.map((section) => ({
      ...section,
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

/** Reads real repo source text for a 'path:start-end[,start-end...]' evidence
 *  citation, so provenance assertions are checked against the actual working
 *  tree rather than trusted on the citation's word alone. */
function readCitedText(ref: string): string {
  const separatorIndex = ref.lastIndexOf(":");
  const path = ref.slice(0, separatorIndex);
  const rangesPart = ref.slice(separatorIndex + 1);
  const lines = readFileSync(resolve(repoRoot, path), "utf8").split(/\r?\n/);
  return rangesPart
    .split(",")
    .map((token) => {
      const [startRaw, endRaw] = token.split("-");
      const start = Number(startRaw);
      const end = endRaw ? Number(endRaw) : start;
      return lines.slice(start - 1, end).join("\n");
    })
    .join("\n");
}

describe("authenticity service terms artifact: taxonomy/completeness", () => {
  it("is structurally valid and registered under the canonical /authenticity-terms route", () => {
    expect(authenticityServiceTermsPolicyArtifact.metadata.policyKey).toBe("authenticity-service-terms");
    expect(authenticityServiceTermsPolicyArtifact.metadata.href).toBe("/authenticity-terms");
    expect(validatePublicPolicyArtifactStructure(authenticityServiceTermsPolicyArtifact)).toEqual([]);
    expect(validatePublicPolicyArtifactStructure(approvedArtifact())).toEqual([]);
  });

  it("contains exactly the nine named required subjects, each counsel-required with non-blank original draftText", () => {
    expect(requiredIds).toEqual([
      "service-nature",
      "opt-in-and-fee",
      "custody-and-care",
      "verification-outcomes",
      "counterfeit-handling",
      "funds-and-reviews",
      "condition-notes-and-disputes",
      "liability-limits",
      "service-termination",
    ]);
    expect(authenticityServiceTermsPolicyArtifact.sections).toHaveLength(9);
    expect(authenticityServiceTermsPolicyArtifact.sections.map((section) => section.id)).toEqual(requiredIds);

    for (const id of requiredIds) {
      const section = sectionsById.get(id);
      expect(section, `missing required subject '${id}'`).toBeDefined();
      expect(section!.draftText.trim().length).toBeGreaterThan(0);
      expect(section!.reviewStatus).toBe("counsel-required");
      expect(section!.reviewManifest.scopeNote.trim().length).toBeGreaterThan(0);
    }
  });

  it("is red for the superseded one-subject predecessor stub retaining only 'authenticity-service-terms-scope'", () => {
    const predecessor: PublicPolicyArtifact = {
      ...approvedArtifact(),
      sections: [
        {
          id: "authenticity-service-terms-scope",
          title: "Authenticity service terms scope",
          draftText: "Reserve the scope of the operative Chase Sets authenticity service terms.",
          reviewStatus: "counsel-approved",
          reviewManifest: {
            scopeNote: "scope",
            decisionRefs: [],
            productTruthRefs: [],
            openQuestions: [],
            assumptions: [],
          },
        },
      ],
    };

    const readiness = evaluatePublicPolicyPublicationReadiness(predecessor, requiredIds);
    expect(readiness.ready).toBe(false);
    for (const id of requiredIds) {
      expect(readiness.errors.some((error) => error.includes(`missing required subject '${id}'`))).toBe(true);
    }
  });

  it.each(requiredIds)(
    "is red when the '%s' required subject is dropped from an otherwise-approved candidate",
    (droppedId) => {
      const candidate = approvedArtifact();
      const mutated: PublicPolicyArtifact = {
        ...candidate,
        sections: candidate.sections.filter((section) => section.id !== droppedId),
      };

      const readiness = evaluatePublicPolicyPublicationReadiness(mutated, requiredIds);
      expect(readiness.ready).toBe(false);
      expect(readiness.errors.some((error) => error.includes(`missing required subject '${droppedId}'`))).toBe(true);
    },
  );

  it("remains counsel-required and non-operative despite carrying drafted original copy", () => {
    expect(authenticityServiceTermsPolicyArtifact.metadata.publicationStatus).toBe("counsel-review-required");
    expect(authenticityServiceTermsPolicyArtifact.metadata.effectiveAt).toBeNull();
    expect(authenticityServiceTermsPolicyArtifact.metadata.counselApprovalReference).toBeNull();
    expect(authenticityServiceTermsPolicyArtifact.metadata.rolloutJurisdictionsOrProductLimits).toEqual([]);
    expect(authenticityServiceTermsPolicyArtifact.metadata.launchRequired).toBe(false);

    for (const section of authenticityServiceTermsPolicyArtifact.sections) {
      expect(section.reviewStatus).toBe("counsel-required");
    }

    const readiness = evaluatePublicPolicyPublicationReadiness(authenticityServiceTermsPolicyArtifact, requiredIds);
    expect(readiness.ready).toBe(false);
    expect(isConsentActivatable(authenticityServiceTermsPolicyArtifact, requiredIds)).toBe(false);
  });

  it("is red for a launchRequired: true or publicationStatus: 'published' metadata mutant", () => {
    expect(authenticityServiceTermsPolicyArtifact.metadata.launchRequired).toBe(false);
    const launchRequiredMutant: PublicPolicyArtifact = {
      ...authenticityServiceTermsPolicyArtifact,
      metadata: { ...authenticityServiceTermsPolicyArtifact.metadata, launchRequired: true },
    };
    expect(launchRequiredMutant.metadata.launchRequired).not.toBe(
      authenticityServiceTermsPolicyArtifact.metadata.launchRequired,
    );

    const publishedMutant: PublicPolicyArtifact = {
      ...authenticityServiceTermsPolicyArtifact,
      metadata: { ...authenticityServiceTermsPolicyArtifact.metadata, publicationStatus: "published" },
    };
    const readiness = evaluatePublicPolicyPublicationReadiness(publishedMutant, requiredIds);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors.some((error) => error.includes("requires counsel-approved copy"))).toBe(true);
  });

  it("would pass readiness once every section is counsel-approved and the artifact is published", () => {
    const approved = approvedArtifact();
    const readiness = evaluatePublicPolicyPublicationReadiness(approved, requiredIds);
    expect(readiness.ready).toBe(true);
    expect(readiness.errors).toEqual([]);
    expect(isConsentActivatable(approved, requiredIds)).toBe(true);
  });
});

const shippedEvidenceChecks: readonly {
  subjectId: AuthenticityServiceTermsSubjectId;
  ref: string;
  keyword: string;
}[] = [
  {
    subjectId: "service-nature",
    ref: "bounded-contexts/authenticity/support/runtime-support/common.ts:18",
    keyword: "passed",
  },
  {
    subjectId: "opt-in-and-fee",
    ref: "bounded-contexts/commercial-terms/features/authenticity-fee/domain/policy.ts:124-131",
    keyword: "commercial-terms.authenticity-fee",
  },
  {
    subjectId: "opt-in-and-fee",
    ref: "bounded-contexts/checkout/features/sessions/domain/domain.ts:696-716",
    keyword: "SelectAuthenticityCheckOptIn",
  },
  {
    subjectId: "opt-in-and-fee",
    ref: "bounded-contexts/ordering/features/orders/domain/authenticity-check-fee.ts:92-118",
    keyword: "optInThresholdAmount",
  },
  {
    subjectId: "custody-and-care",
    ref: "bounded-contexts/authenticity/features/cases/domain/domain.ts:253-264",
    keyword: "authenticity.case.received",
  },
  {
    subjectId: "verification-outcomes",
    ref: "bounded-contexts/authenticity/support/runtime-support/common.ts:18",
    keyword: "inconclusive",
  },
  {
    subjectId: "counterfeit-handling",
    ref: "bounded-contexts/authenticity/features/cases/domain/domain.ts:317-322",
    keyword: "ReturnAuthenticityCase",
  },
  {
    subjectId: "funds-and-reviews",
    ref: "bounded-contexts/authenticity/README.md:19-21",
    keyword: "matures payout funds",
  },
  {
    subjectId: "condition-notes-and-disputes",
    ref: "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303,431-436",
    keyword: "evidencePhotoRefs",
  },
  {
    subjectId: "liability-limits",
    ref: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:552",
    keyword: "Authenticity Service Terms",
  },
  {
    subjectId: "service-termination",
    ref: "bounded-contexts/authenticity/README.md:39-42",
    keyword: "None wired yet",
  },
];

const futureDesignExpectations: readonly { subjectId: AuthenticityServiceTermsSubjectId; issueRef: string }[] = [
  { subjectId: "opt-in-and-fee", issueRef: "#4275" },
  { subjectId: "verification-outcomes", issueRef: "#4278" },
  { subjectId: "counterfeit-handling", issueRef: "#6428" },
  { subjectId: "funds-and-reviews", issueRef: "#4276" },
  { subjectId: "condition-notes-and-disputes", issueRef: "#4282" },
];

describe("authenticity service terms artifact: product-truth provenance matrix", () => {
  it.each(shippedEvidenceChecks)(
    "'$subjectId' shipped-fact evidence '$ref' cites real source that supports its claim",
    ({ subjectId, ref, keyword }) => {
      const section = sectionsById.get(subjectId)!;
      const allRefs = [
        ...section.reviewManifest.productTruthRefs,
        ...section.reviewManifest.assumptions.map((assumption) => assumption.evidenceRef),
      ];
      expect(allRefs, `${subjectId} must cite ${ref}`).toContain(ref);
      expect(readCitedText(ref).toLowerCase()).toContain(keyword.toLowerCase());
    },
  );

  it("rejects an unrelated-code citation mutant that does not support its claim", () => {
    const realRef = "bounded-contexts/authenticity/features/cases/domain/domain.ts:317-322";
    expect(readCitedText(realRef).toLowerCase()).toContain("returnauthenticitycase");

    // Mutant: an adjacent line range describing an unrelated type does not
    // support the counterfeit-handling return-path claim.
    const mutantRef = "bounded-contexts/authenticity/support/runtime-support/common.ts:33-36";
    expect(readCitedText(mutantRef).toLowerCase()).not.toContain("returnauthenticitycase");
  });

  it.each(futureDesignExpectations)(
    "'$subjectId' cites its owning future-design issue '$issueRef' in openQuestions, never in operative draftText",
    ({ subjectId, issueRef }) => {
      const section = sectionsById.get(subjectId)!;
      expect(section.reviewManifest.openQuestions.some((question) => question.includes(issueRef))).toBe(true);
      expect(section.draftText).not.toContain(issueRef);
    },
  );

  it("is red for a future-as-shipped mutant that strips the leg-two open question from funds-and-reviews", () => {
    const citesLegTwoIssue = (candidate: { reviewManifest: { openQuestions: readonly string[] } }): boolean =>
      candidate.reviewManifest.openQuestions.some((question) => question.includes("#4276"));

    const section = sectionsById.get("funds-and-reviews")!;
    expect(citesLegTwoIssue(section)).toBe(true);

    const mutant = {
      ...section,
      reviewManifest: { ...section.reviewManifest, openQuestions: [] as readonly string[] },
    };
    expect(citesLegTwoIssue(mutant)).toBe(false);
  });

  it("never claims an end-to-end authenticity service exists in operative draftText (N1)", () => {
    for (const section of authenticityServiceTermsPolicyArtifact.sections) {
      expect(section.draftText.toLowerCase()).not.toContain("end-to-end");
    }
  });

  it("states that checkout opt-in and the Authenticity Case are separately shipped and not yet wired together (N1)", () => {
    const section = sectionsById.get("opt-in-and-fee")!;
    const openQuestion = section.reviewManifest.openQuestions.find((question) =>
      question.includes("separately shipped surfaces"),
    );
    expect(openQuestion).toBeDefined();
    expect(openQuestion).toContain("no wired integration event");
    expect(readCitedText("bounded-contexts/authenticity/README.md:39-42")).toContain("None wired yet");
  });

  it("F1 regression: never denies the shipped buyer opt-in while opt-in-and-fee affirms one, and cites README.md:39-42 only for the unwired-integration claim", () => {
    const optInSection = sectionsById.get("opt-in-and-fee")!;
    const terminationSection = sectionsById.get("service-termination")!;
    const artifactDescription = authenticityServiceTermsPolicyArtifact.description;

    const affirmsShippedOptIn = /chase sets offers the authenticity check as a buyer opt-in/i.test(
      optInSection.draftText,
    );
    expect(affirmsShippedOptIn).toBe(true);

    const deniesShippedOptIn = /has not (yet )?shipped a buyer opt-in surface/i.test(terminationSection.draftText);
    const deniesOfferedInDesc = /is not currently offered as a live,? opt-in service/i.test(artifactDescription);

    expect(affirmsShippedOptIn && deniesShippedOptIn).toBe(false);
    expect(affirmsShippedOptIn && deniesOfferedInDesc).toBe(false);

    // README.md:39-42 documents that no order-placed-with-authenticity-plan
    // integration event is wired yet; it must never be cited as evidence
    // that the buyer opt-in surface itself has not shipped.
    const readmeCitationText = readCitedText("bounded-contexts/authenticity/README.md:39-42");
    expect(readmeCitationText.toLowerCase()).toContain("none wired yet");
    expect(readmeCitationText.toLowerCase()).not.toContain("opt-in surface");
  });
});

describe("authenticity service terms artifact: legal-claim consistency mutation table (against terms-of-service.ts)", () => {
  it("keeps the liability-limits carve-out consistent with the Terms of Service authenticity-check exception", () => {
    const tosSection = termsOfServicePolicyArtifact.sections.find(
      (section) => section.id === "disclaimers-and-liability-limits",
    )!;
    const ourSection = sectionsById.get("liability-limits")!;

    expect(tosSection.draftText).toContain("except through the optional authenticity-check service");
    expect(ourSection.draftText).toContain("sole exception");
  });

  it("is red for a sibling-drift mutant that settles a numeric liability cap opposite to the Terms of Service placeholder", () => {
    const ourSection = sectionsById.get("liability-limits")!;
    expect(/\$\d/.test(ourSection.draftText)).toBe(false);

    const driftedDraftText = ourSection.draftText.replace(
      "This document does not state a separate numeric liability cap for the Authenticity Check service",
      "This document sets the Authenticity Check liability cap at $500",
    );
    expect(/\$\d/.test(driftedDraftText)).toBe(true);

    const tosSection = termsOfServicePolicyArtifact.sections.find(
      (section) => section.id === "disclaimers-and-liability-limits",
    )!;
    expect(tosSection.draftText).toContain("[LIABILITY-CAP-FLOOR-AMOUNT]");
  });

  it("is red for a draft/manifest-contradiction mutant that settles insurance posture while the manifest marks it counsel-sensitive", () => {
    const section = sectionsById.get("custody-and-care")!;
    expect(section.reviewManifest.openQuestions.some((question) => question.toLowerCase().includes("insurance"))).toBe(
      true,
    );
    expect(section.draftText.toLowerCase()).not.toContain("chase sets insures");

    const contradicted = `${section.draftText} Chase Sets insures every item in its custody against loss or damage.`;
    expect(contradicted.toLowerCase()).toContain("chase sets insures");
  });

  it("is red for a draft/manifest-contradiction mutant that settles inconclusive-cost posture while the manifest marks it counsel-sensitive", () => {
    const section = sectionsById.get("verification-outcomes")!;
    expect(
      section.reviewManifest.openQuestions.some((question) => question.toLowerCase().includes("cost allocation")),
    ).toBe(true);
    expect(section.draftText.toLowerCase()).not.toContain("inconclusive verdicts cost");

    const contradicted = `${section.draftText} Inconclusive verdicts cost the same as failed verdicts.`;
    expect(contradicted.toLowerCase()).toContain("inconclusive verdicts cost");
  });
});

describe("authenticity service terms artifact: N2 corpus-wide canonical claim guard", () => {
  it("stays green for the full public policy corpus with this document included", () => {
    const violations = evaluateCanonicalClaimConsistency(publicPolicyRegistry, repoRoot);
    expect(violations).toEqual([]);
  });

  it("does not trip a Wallet forbidden-assertion phrase in the counsel-sensitive insurance packet question", () => {
    const forbiddenPhrases = Object.values(canonicalClaimRegistry).flatMap(
      (definition) => definition.forbiddenAssertionPhrases ?? [],
    );
    expect(forbiddenPhrases.length).toBeGreaterThan(0);

    const lowered = sectionsById.get("custody-and-care")!.draftText.toLowerCase();
    for (const phrase of forbiddenPhrases) {
      expect(lowered, `custody-and-care draftText must not contain forbidden phrase '${phrase}'`).not.toContain(
        phrase.toLowerCase(),
      );
    }
  });
});

describe("authenticity service terms artifact: counterfeit handling (decision #6428)", () => {
  it("preserves decision #6428's Option B resolution: refund, never return to seller, retain pending authorized disposition", () => {
    const section = sectionsById.get("counterfeit-handling")!;
    expect(section.draftText).toContain("refunds the buyer");
    expect(section.draftText).toContain("does not return the item to the seller");
    expect(section.draftText).toContain("Chase Sets Operations");
    expect(section.reviewManifest.decisionRefs).toContain(6428);
  });

  it("does not claim the counterfeit-specific return distinction is already shipped", () => {
    const section = sectionsById.get("counterfeit-handling")!;
    expect(section.draftText).toContain("does not claim that distinction is already built");
    const cited = readCitedText("bounded-contexts/authenticity/features/cases/domain/domain.ts:317-322");
    expect(cited).toContain('state.status === "failed" || state.status === "inconclusive"');
  });
});
