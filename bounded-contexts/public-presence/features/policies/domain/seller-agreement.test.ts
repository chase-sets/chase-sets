import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { termsOfServicePolicyArtifact } from "./terms-of-service";
import {
  evaluateSellerAgreementPublicationReadiness,
  requiredSellerAgreementSubjectIds,
  sellerAgreementPolicyArtifact,
} from "./seller-agreement";
import { unratifiedArbitrationDraftingDifferences } from "./arbitration-drafting-differences";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");

function arbitrationSections() {
  return {
    terms: termsOfServicePolicyArtifact.sections.find(({ id }) => id === "dispute-resolution-with-platform")!,
    seller: sellerAgreementPolicyArtifact.sections.find(({ id }) => id === "dispute-resolution")!,
  };
}

type ArbitrationSection = {
  draftText: string;
  reviewManifest: {
    scopeNote: string;
    openQuestions: readonly string[];
  };
};

function arbitrationThresholdErrors(
  termsQuestions: readonly string[],
  sellerQuestions: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  const text = [termsQuestions.join(" "), sellerQuestions.join(" ")];
  if (text.some((questions) => !questions.includes("claim threshold") || questions.includes("fee floor"))) {
    errors.push("both manifests must use claim-threshold wording");
  }
  return errors;
}

function differenceList(section: ArbitrationSection): readonly string[] {
  return section.reviewManifest.openQuestions.filter((question) => question.startsWith("Counsel difference —"));
}

function quotedDraft(entry: string, document: "Terms of Service" | "Seller Agreement"): string {
  const marker = `${document}:`;
  const markerStart = entry.indexOf(marker);
  if (markerStart < 0) {
    return "";
  }

  const quotedPart = entry.slice(markerStart + marker.length).trimStart();
  const opening = quotedPart[0];
  const closing = opening === "“" ? "”" : opening === '"' ? '"' : undefined;
  if (!closing) {
    return "";
  }

  let closingIndex = -1;
  for (let index = 1; index < quotedPart.length; index += 1) {
    if (quotedPart[index] !== closing) {
      continue;
    }
    const remainder = quotedPart.slice(index + 1);
    if (
      (document === "Terms of Service" && /^\s*\.?\s+Seller Agreement:\s*[“"]/.test(remainder)) ||
      (document === "Seller Agreement" &&
        (remainder.trim() === "" || remainder.startsWith(" The Seller Agreement has no separate")))
    ) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex <= 0) {
    return "";
  }
  return quotedPart.slice(1, closingIndex);
}

function arbitrationDifferenceErrors(terms: ArbitrationSection, seller: ArbitrationSection): readonly string[] {
  const errors: string[] = [];
  const termsDifferences = differenceList(terms);
  const sellerDifferences = differenceList(seller);
  if (termsDifferences.length !== unratifiedArbitrationDraftingDifferences.length) {
    errors.push("Terms manifest must carry the complete difference list");
  }
  if (JSON.stringify(termsDifferences) !== JSON.stringify(sellerDifferences)) {
    errors.push("both manifests must carry one identical difference list");
  }
  for (const entry of termsDifferences) {
    const termsQuote = quotedDraft(entry, "Terms of Service");
    const sellerQuote = quotedDraft(entry, "Seller Agreement");
    if (
      !termsQuote ||
      !sellerQuote ||
      !terms.draftText.includes(termsQuote) ||
      !seller.draftText.includes(sellerQuote)
    ) {
      errors.push("every difference must quote both current drafts");
    }
  }
  if (
    [terms.reviewManifest.scopeNote, seller.reviewManifest.scopeNote].some((note) => /verbatim|uniformly/i.test(note))
  ) {
    errors.push("scope notes must not claim verbatim or uniformly text");
  }
  return errors;
}

function ratifiedArbitrationValueErrors(termsDraft: string, sellerDraft: string): readonly string[] {
  const errors: string[] = [];
  const required = [
    ["AAA Consumer Arbitration Rules", "Consumer Arbitration Rules"],
    ["$10,000", "$10,000"],
    ["30-day opt-out", "within 30 days"],
    ["45-day notice", "45 days"],
    ["small-claims carve-out", "small-claims court"],
    ["25-demand batching", "25 or more"],
    ["class waiver", "class, collective, or representative action"],
    ["jury waiver", "jury trial"],
  ] as const;
  for (const [label, fragment] of required) {
    if (!termsDraft.includes(fragment) || !sellerDraft.includes(fragment))
      errors.push(`both drafts must retain ${label}`);
  }
  return errors;
}

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
  it("matches Terms entity, state, courts and mailing address, retaining only the notice-email placeholder", () => {
    const seller = sellerAgreementPolicyArtifact.sections.find(({ id }) => id === "governing-law")!;
    const terms = termsOfServicePolicyArtifact.sections.find(({ id }) => id === "governing-law-and-forum")!;
    for (const pattern of [
      /Chase Sets Limited, registered in Wichita, Kansas/,
      /laws of the State of Kansas/,
      /state and federal courts located in Kansas/,
      /Chase Sets Limited, PO Box 164, Maize, KS 67101-0164, US, or to \[NOTICE-EMAIL\]/,
    ]) {
      expect(seller.draftText.match(pattern)?.[0]).toBe(terms.draftText.match(pattern)?.[0]);
      expect(seller.draftText).toMatch(pattern);
    }
    expect(seller.draftText.match(/\[[A-Z-]+\]/g)).toEqual(terms.draftText.match(/\[[A-Z-]+\]/g));
    expect(seller.reviewManifest.decisionRefs).toContain(5677);
    expect(seller.reviewManifest.openQuestions.join(" ")).toContain("[NOTICE-EMAIL]");
  });
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

  it("uses claim-threshold wording rather than fee-floor wording in both arbitration manifests", () => {
    const sections = arbitrationSections();
    expect(
      arbitrationThresholdErrors(
        sections.terms.reviewManifest.openQuestions,
        sections.seller.reviewManifest.openQuestions,
      ),
    ).toEqual([]);

    const mutated = sections.seller.reviewManifest.openQuestions.map((question) =>
      question.replace("claim threshold", "fee floor"),
    );
    expect(arbitrationThresholdErrors(sections.terms.reviewManifest.openQuestions, mutated)).toContain(
      "both manifests must use claim-threshold wording",
    );
  });

  it("keeps the Terms and Seller Agreement unratified-differences manifest identical and source-linked", () => {
    const sections = arbitrationSections();
    expect(arbitrationDifferenceErrors(sections.terms, sections.seller)).toEqual([]);

    const mutatedSeller = {
      ...sections.seller,
      draftText: sections.seller.draftText.replace("substantially similar", "different"),
    };
    expect(arbitrationDifferenceErrors(sections.terms, mutatedSeller)).toContain(
      "every difference must quote both current drafts",
    );

    const firstDifference = differenceList(sections.seller)[0]!;
    const unquotedSellerDifference = firstDifference.replace('Seller Agreement: "', "Seller Agreement: ").slice(0, -1);
    const unquotedDifferenceManifest = (section: ArbitrationSection) => ({
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        openQuestions: section.reviewManifest.openQuestions.map((question) =>
          question === firstDifference ? unquotedSellerDifference : question,
        ),
      },
    });
    expect(
      arbitrationDifferenceErrors(
        unquotedDifferenceManifest(sections.terms),
        unquotedDifferenceManifest(sections.seller),
      ),
    ).toContain("every difference must quote both current drafts");

    const forbiddenScope = {
      ...sections.seller,
      reviewManifest: { ...sections.seller.reviewManifest, scopeNote: "State the mechanics uniformly for counsel." },
    };
    expect(arbitrationDifferenceErrors(sections.terms, forbiddenScope)).toContain(
      "scope notes must not claim verbatim or uniformly text",
    );
  });

  it("preserves every #5681 ratified value in both dispute subjects", () => {
    const sections = arbitrationSections();
    expect(ratifiedArbitrationValueErrors(sections.terms.draftText, sections.seller.draftText)).toEqual([]);

    const mutatedTerms = sections.terms.draftText.replace("45 days", "forty-five days");
    expect(ratifiedArbitrationValueErrors(mutatedTerms, sections.seller.draftText)).toContain(
      "both drafts must retain 45-day notice",
    );
  });

  it("keeps commercial policy figures out of prose apart from fixed dispute mechanics and the ruled postal address", () => {
    for (const section of sellerAgreementPolicyArtifact.sections) {
      if (section.id === "dispute-resolution") {
        continue;
      }
      const prose =
        section.id === "governing-law"
          ? section.draftText.replace("PO Box 164, Maize, KS 67101-0164", "the ruled postal address")
          : section.draftText;
      expect(prose).not.toMatch(/\d/);
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

  it("seller-agreement-payout-fee-reference", () => {
    const feesAndDeductions = sellerAgreementPolicyArtifact.sections.find(
      (section) => section.id === "fees-and-deductions",
    );
    expect(feesAndDeductions).toBeDefined();

    // Names the Payout Fee policy document and the sales-fees article by
    // reference, with no numeral anywhere in this subject's prose.
    expect(feesAndDeductions?.draftText).toMatch(/payout fee policy document/i);
    expect(feesAndDeductions?.draftText).toMatch(/Marketplace sales, payout, and checkout fees help article/);
    expect(feesAndDeductions?.draftText).toMatch(/deducted from the amount you request/i);
    expect(feesAndDeductions?.draftText).toMatch(/shows it to you before you confirm the payout request/i);
    expect(feesAndDeductions?.draftText).not.toMatch(/\d/);
    expect(feesAndDeductions?.reviewStatus).toBe("counsel-required");

    expect(feesAndDeductions?.reviewManifest.decisionRefs).toEqual(expect.arrayContaining([7818, 7819]));
    expect(feesAndDeductions?.reviewManifest.productTruthRefs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "bounded-contexts/settlement/features/payouts/domain/payout-policy.ts (settlement.payout-fee",
        ),
        expect.stringMatching(
          /^bounded-contexts\/settlement\/features\/payouts\/api\/payout-request-lifecycle\.ts:.*posting/,
        ),
        expect.stringContaining("bounded-contexts/settlement/features/payouts/ui/payout-request-panel.tsx"),
      ]),
    );
    expect(feesAndDeductions?.reviewManifest.productTruthRefs.some((ref) => ref.includes("sales-fees.en.md"))).toBe(
      true,
    );
    expect(
      feesAndDeductions?.reviewManifest.openQuestions.some(
        (question) => /deducted from the requested amount/i.test(question) && /sufficient disclosure/i.test(question),
      ),
    ).toBe(true);
  });
});
