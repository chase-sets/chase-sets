import { describe, expect, it } from "vitest";
import { canonicalClaimRegistry, resolveUnresolvedPublicDisclosureText } from "./canonical-claims";
import {
  evaluateTermsOfServicePublicationReadiness,
  requiredTermsOfServiceSubjectIds,
  termsOfServicePolicyArtifact,
  type TermsOfServiceSubjectId,
} from "./terms-of-service";

const agentResponsibilityClaimId = "authorized-agent-principal-responsibility-and-liability-boundary";
const agentSuspensionClaimId = "agent-access-suspension-and-revocation-boundary";

function termsSection(sectionId: TermsOfServiceSubjectId) {
  const section = termsOfServicePolicyArtifact.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) {
    throw new Error(`Terms of Service artifact is missing section '${sectionId}'.`);
  }
  return section;
}

/**
 * Before/after sentence table for the two sections that carried the
 * authorized-agent responsibility boundary in public draft text.
 *
 * `before` records the exact prose each sentence had prior to this change and
 * is documentation for review; `after` is asserted. A sentence whose `after`
 * equals its `before` must be byte-identical — the change is allowed to touch
 * exactly one sentence per section and nothing else.
 */
const agentBoundarySentenceTable = [
  {
    sectionId: "electronic-agents-and-automated-access",
    label: "MCP interface, developer portal, and bounded permission grant",
    before:
      "Chase Sets publishes a Model Context Protocol interface and a developer portal (chasesets.com/developers) that let you authorize a software agent to act on your Account within a bounded set of permissions you grant.",
    after:
      "Chase Sets publishes a Model Context Protocol interface and a developer portal (chasesets.com/developers) that let you authorize a software agent to act on your Account within a bounded set of permissions you grant.",
  },
  {
    sectionId: "electronic-agents-and-automated-access",
    label: "Agent Connector Terms incorporation and conflict rule",
    before:
      "Automated or agent access to Chase Sets is governed by the Agent Connector Terms (chasesets.com/agent-terms) in addition to these Terms; where the two conflict on automated-access-specific subjects, the Agent Connector Terms control.",
    after:
      "Automated or agent access to Chase Sets is governed by the Agent Connector Terms (chasesets.com/agent-terms) in addition to these Terms; where the two conflict on automated-access-specific subjects, the Agent Connector Terms control.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Minimum age and contracting capacity",
    before: "You must be at least 18 years old and able to form a binding contract to create a Chase Sets Account.",
    after: "You must be at least 18 years old and able to form a binding contract to create a Chase Sets Account.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Bounded holder duties: registration accuracy, contact currency, credential safeguarding",
    before:
      "You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key, and for all activity conducted through your Account.",
    after:
      "You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Registration screening",
    before:
      "Chase Sets may screen registration and decline, delay, or condition an Account, including through an invitation or waitlist process.",
    after:
      "Chase Sets may screen registration and decline, delay, or condition an Account, including through an invitation or waitlist process.",
  },
  {
    sectionId: "eligibility-and-accounts",
    label: "Compromise notification",
    before:
      "Notify Chase Sets promptly through a Support Request if you believe your Account or credentials have been compromised.",
    after:
      "Notify Chase Sets promptly through a Support Request if you believe your Account or credentials have been compromised.",
  },
] as const satisfies readonly Readonly<{
  sectionId: TermsOfServiceSubjectId;
  label: string;
  before: string;
  after: string;
}>[];

/** The whole sentence deleted from the agent subject. */
const deletedAgentBoundarySentence =
  "You remain responsible for actions your authorized agent takes on your Account, and Chase Sets may suspend " +
  "an agent's access, or your Account, for activity that violates these Terms, the Agent Connector Terms, or " +
  "an incorporated policy.";

/** The clause removed from the account subject's responsibility sentence. */
const deletedAccountActivityClause = "and for all activity conducted through your Account";

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

describe("authorized-agent responsibility and access boundary", () => {
  it("reconstructs both edited sections exactly from the before/after sentence table", () => {
    for (const sectionId of ["electronic-agents-and-automated-access", "eligibility-and-accounts"] as const) {
      const rows = agentBoundarySentenceTable.filter((row) => row.sectionId === sectionId);
      expect(rows.length).toBeGreaterThan(0);

      // Exact equality, not containment: the section is the table and nothing
      // else, so an added sentence fails here even if every listed sentence
      // still survives verbatim.
      expect(termsSection(sectionId).draftText).toBe(rows.map((row) => row.after).join(" "));
    }
  });

  it("keeps every sentence outside the two edited ones byte-identical to its prior prose", () => {
    const changed = agentBoundarySentenceTable.filter((row) => row.before !== row.after);

    expect(changed.map((row) => `${row.sectionId}: ${row.label}`)).toEqual([
      "eligibility-and-accounts: Bounded holder duties: registration accuracy, contact currency, credential safeguarding",
    ]);
    for (const row of agentBoundarySentenceTable) {
      if (row.before === row.after) {
        expect(termsSection(row.sectionId).draftText).toContain(row.before);
      }
    }
  });

  it("removed the agent-responsibility sentence and the all-activity clause from public draft text", () => {
    const agentSection = termsSection("electronic-agents-and-automated-access");
    const eligibilitySection = termsSection("eligibility-and-accounts");

    expect(agentSection.draftText).not.toContain(deletedAgentBoundarySentence);
    expect(agentSection.draftText.toLowerCase()).not.toContain("you remain responsible");
    expect(agentSection.draftText.toLowerCase()).not.toContain("suspend an agent's access");
    expect(eligibilitySection.draftText).not.toContain(deletedAccountActivityClause);
    expect(eligibilitySection.draftText.toLowerCase()).not.toContain("all activity conducted through your account");
  });

  it("retains the registration-accuracy, contact-currency, and credential-safeguarding duties in the bounded clause", () => {
    const draftText = termsSection("eligibility-and-accounts").draftText;

    expect(draftText).toContain("the accuracy of the information you provide when you register");
    expect(draftText).toContain("keeping your contact information current");
    expect(draftText).toContain("safeguarding your credentials, including any password, passkey, or API key");
  });

  it("states no responsibility posture for authorized-agent activity in either direction", () => {
    const lowered = termsSection("eligibility-and-accounts").draftText.toLowerCase();

    // The extent is declined, not decided: the section must not assign
    // responsibility for agent activity, and must not disclaim it either.
    for (const phrase of [
      "agent",
      "automated",
      "not responsible",
      "no responsibility",
      "responsible for all",
      "all activity",
    ]) {
      expect(lowered).not.toContain(phrase);
    }
  });

  it("enrolls exactly three claim disclosures across exactly two sections, each mirrored in its manifest", () => {
    const enrolled = termsOfServicePolicyArtifact.sections.flatMap((section) =>
      (section.claimDisclosures ?? [])
        .filter(
          (disclosure) =>
            disclosure.claimId === agentResponsibilityClaimId || disclosure.claimId === agentSuspensionClaimId,
        )
        .map((disclosure) => ({ sectionId: section.id, claimId: disclosure.claimId })),
    );

    expect(enrolled).toEqual([
      { sectionId: "eligibility-and-accounts", claimId: agentResponsibilityClaimId },
      { sectionId: "electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
      { sectionId: "electronic-agents-and-automated-access", claimId: agentSuspensionClaimId },
    ]);

    for (const { sectionId, claimId } of enrolled) {
      const section = termsSection(sectionId as TermsOfServiceSubjectId);
      const claimRef = (section.reviewManifest.canonicalClaims ?? []).find(
        (candidate) => candidate.claimId === claimId,
      );

      expect(claimRef, `${sectionId} must mirror ${claimId} in its review manifest`).toBeDefined();
      expect(claimRef?.productTruthRefs).toEqual([]);
      expect(section.reviewManifest.openQuestions.length).toBeGreaterThan(0);
      expect(section.reviewStatus).toBe("counsel-required");
    }
  });

  it("carries an explicit counsel question for each enrolled proposition", () => {
    const eligibilityQuestions = termsSection("eligibility-and-accounts").reviewManifest.openQuestions.join(" ");
    const agentQuestions = termsSection("electronic-agents-and-automated-access").reviewManifest.openQuestions.join(
      " ",
    );

    expect(eligibilityQuestions).toContain("Counsel question:");
    expect(eligibilityQuestions.toLowerCase()).toContain("authorized software agent's activity");
    expect(agentQuestions.match(/Counsel question:/g)).toHaveLength(2);
    expect(agentQuestions.toLowerCase()).toContain("responsibility or liability");
    expect(agentQuestions.toLowerCase()).toContain("suspended or revoked");
  });

  it("registers both identities as unresolved with one status and provenance and no product truth", () => {
    for (const claimId of [agentResponsibilityClaimId, agentSuspensionClaimId] as const) {
      const definition = canonicalClaimRegistry[claimId];

      expect(definition.status).toBe("unresolved");
      expect(definition.productTruthRefs).toEqual([]);
      expect(definition.requiredEvidenceKeywords).toEqual([]);
      expect(definition.forbiddenAssertionPhrases).toHaveLength(5);
    }

    expect(resolveUnresolvedPublicDisclosureText(agentResponsibilityClaimId)).toBe(
      "The extent to which an account holder is responsible or liable for actions taken by an authorized agent " +
        "remains unresolved pending qualified counsel review.",
    );
    expect(resolveUnresolvedPublicDisclosureText(agentSuspensionClaimId)).toBe(
      "The grounds, process, and consequences for suspending or revoking agent access remain unresolved pending " +
        "qualified counsel review.",
    );
  });

  it("keeps the artifact non-effective, non-activatable, and counsel-review-required", () => {
    expect(termsOfServicePolicyArtifact.metadata).toMatchObject({
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
    });
    expect(evaluateTermsOfServicePublicationReadiness(termsOfServicePolicyArtifact).ready).toBe(false);
  });
});
