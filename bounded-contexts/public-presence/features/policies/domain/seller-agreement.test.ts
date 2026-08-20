import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateSellerAgreementPublicationReadiness,
  requiredSellerAgreementSubjectIds,
  sellerAgreementPolicyArtifact,
} from "./seller-agreement";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

function resolveIdentityCitation(reference: string) {
  const match = reference.match(/^(bounded-contexts\/identity\/features\/accounts\/domain\/domain\.ts):([0-9,-]+)/);
  if (!match) {
    throw new Error(`Invalid Identity account citation: ${reference}`);
  }
  const lines = readFileSync(path.join(repositoryRoot, match[1]!), "utf8").split(/\r?\n/);
  return match[2]!
    .split(",")
    .flatMap((range) => {
      const [startText, endText = startText] = range.split("-");
      return lines.slice(Number(startText) - 1, Number(endText));
    })
    .join("\n");
}

function sellerAgreementIdentityCitations() {
  const eligibility = sellerAgreementPolicyArtifact.sections.find(
    ({ id }) => id === "seller-eligibility-and-verification",
  )!;
  const enforcement = sellerAgreementPolicyArtifact.sections.find(({ id }) => id === "enforcement-and-termination")!;
  return [
    {
      name: "eligibility product truth",
      reference: eligibility.reviewManifest.productTruthRefs.find((reference) =>
        reference.includes("domain/domain.ts"),
      )!,
      symbols: ["SuspendAccountCommand", "Only active accounts can be suspended"],
    },
    {
      name: "eligibility assumption",
      reference: eligibility.reviewManifest.assumptions.find(({ evidenceRef }) =>
        evidenceRef.includes("domain/domain.ts"),
      )!.evidenceRef,
      symbols: ["SuspendAccount", "ReactivateAccount"],
    },
    {
      name: "enforcement product truth",
      reference: enforcement.reviewManifest.productTruthRefs.find((reference) =>
        reference.includes("domain/domain.ts"),
      )!,
      symbols: ["AccountSuspendedEvent", "AccountReactivatedEvent", "AccountClosedEvent", "lastEnforcementAction"],
    },
    {
      name: "enforcement assumption",
      reference: enforcement.reviewManifest.assumptions.find(({ evidenceRef }) =>
        evidenceRef.includes("domain/domain.ts"),
      )!.evidenceRef,
      symbols: ["AccountSuspendedEvent", "AccountEnforcementData", "enforcement"],
    },
  ];
}

describe("Seller Agreement policy artifact", () => {
  it.each(sellerAgreementIdentityCitations())("resolves the $name citation to its claimed Identity symbols", (row) => {
    const source = resolveIdentityCitation(row.reference);
    for (const symbol of row.symbols) {
      expect(source).toContain(symbol);
    }
  });

  it("rejects an adjacent unrelated source range for every Identity citation", () => {
    for (const row of sellerAgreementIdentityCitations()) {
      const unrelated = resolveIdentityCitation(row.reference.replace(/:[0-9,-]+/, ":27"));
      expect(row.symbols.some((symbol) => unrelated.includes(symbol))).toBe(false);
    }
  });

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
