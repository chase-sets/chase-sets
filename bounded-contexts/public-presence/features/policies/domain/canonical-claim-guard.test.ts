import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalClaimRegistry, resolveUnresolvedPublicDisclosureText } from "./canonical-claims";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import type { PublicPolicyRegistryEntry } from "./policy-registry";
import { publicPolicyRegistry } from "./policy-registry";

const domainDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(domainDirectory, "../../../../..");

function withTermsOfServiceSectionOverride(
  sectionId: string,
  overrides: Readonly<Record<string, unknown>>,
): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "terms-of-service"
      ? ({
          ...entry,
          artifact: {
            ...entry.artifact,
            sections: entry.artifact.sections.map((section) =>
              section.id === sectionId ? { ...section, ...overrides } : section,
            ),
          },
        } as unknown as PublicPolicyRegistryEntry)
      : entry,
  );
}

function withPaymentsTermsCanonicalClaims(
  sectionId: string,
  canonicalClaims: readonly Readonly<{ claimId: string; productTruthRefs: readonly string[] }>[],
): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "payments-terms"
      ? ({
          ...entry,
          artifact: {
            ...entry.artifact,
            sections: entry.artifact.sections.map((section) =>
              section.id === sectionId
                ? { ...section, reviewManifest: { ...section.reviewManifest, canonicalClaims } }
                : section,
            ),
          },
        } as unknown as PublicPolicyRegistryEntry)
      : entry,
  );
}

describe("canonical claim consistency guard", () => {
  it("finds zero violations across the real registered corpus", () => {
    expect(evaluateCanonicalClaimConsistency(publicPolicyRegistry, repoRoot)).toEqual([]);
  });

  it("passes the settled payment-charge-timing-and-capture claim on its real corrected evidence", () => {
    const paymentsTerms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "payments-terms");
    const section = paymentsTerms?.artifact.sections.find(
      (candidate) => candidate.id === "charge-timing-and-statement-descriptor",
    );
    expect(section?.reviewManifest.canonicalClaims?.length).toBeGreaterThan(0);

    const violations = evaluateCanonicalClaimConsistency(
      [{ artifact: { ...paymentsTerms!.artifact, sections: [section!] }, requiredSubjectIds: [] }],
      repoRoot,
    );
    expect(violations).toEqual([]);
  });

  it("passes the settled payment-chargeback-recovery-mechanism claim on its real evidence", () => {
    const paymentsTerms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "payments-terms");
    const section = paymentsTerms?.artifact.sections.find((candidate) => candidate.id === "chargebacks-and-disputes");

    const violations = evaluateCanonicalClaimConsistency(
      [{ artifact: { ...paymentsTerms!.artifact, sections: [section!] }, requiredSubjectIds: [] }],
      repoRoot,
    );
    expect(violations).toEqual([]);
  });

  it("passes the consistently unresolved Wallet no-interest and deposit/FDIC posture on the real Terms of Service section", () => {
    const terms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service");
    const section = terms?.artifact.sections.find((candidate) => candidate.id === "wallet-nature-custody-interest");
    expect(section?.reviewManifest.canonicalClaims).toEqual([
      { claimId: "wallet-no-interest", productTruthRefs: [] },
      { claimId: "wallet-deposit-and-fdic-posture", productTruthRefs: [] },
    ]);
    // The unresolved claims are addressed only through structural
    // claimDisclosures segments, never through free-form draftText prose.
    expect(section?.claimDisclosures).toEqual([
      { claimId: "wallet-deposit-and-fdic-posture" },
      { claimId: "wallet-no-interest" },
    ]);
    expect(section?.draftText.toLowerCase()).not.toContain("interest");
    expect(section?.draftText.toLowerCase()).not.toContain("fdic");
    expect(section?.draftText.toLowerCase()).not.toContain("deposit insurer");
    expect(resolveUnresolvedPublicDisclosureText("wallet-no-interest")).toContain("not yet resolved");
    expect(resolveUnresolvedPublicDisclosureText("wallet-deposit-and-fdic-posture")).toContain("not yet resolved");

    const violations = evaluateCanonicalClaimConsistency(
      [{ artifact: { ...terms!.artifact, sections: [section!] }, requiredSubjectIds: [] }],
      repoRoot,
    );
    expect(violations).toEqual([]);
  });

  it("negative control: fails closed on PR #6052's exact mis-citation (unrelated refund-proration lines cited for charge timing)", () => {
    const registry = withPaymentsTermsCanonicalClaims("charge-timing-and-statement-descriptor", [
      {
        claimId: "payment-charge-timing-and-capture",
        productTruthRefs: ["bounded-contexts/payments/features/payments/api/runtime.ts:491-509"],
      },
    ]);

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) =>
          violation.policyKey === "payments-terms" &&
          violation.claimId === "payment-charge-timing-and-capture" &&
          violation.reason.includes("does not contain any of this claim's required keywords"),
      ),
    ).toBe(true);
  });

  it("negative control: fails closed when a claim the registry holds unresolved is cited with settled-style evidence (cross-artifact drift shape)", () => {
    // A real, resolvable citation (correct for a DIFFERENT claim elsewhere in
    // the corpus) attached to the registry-unresolved wallet-no-interest
    // claim: even valid, resolvable evidence must not settle an unresolved
    // shared claim from a sibling artifact.
    const registry = withPaymentsTermsCanonicalClaims("no-interest", [
      { claimId: "wallet-no-interest", productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:5-7"] },
    ]);

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) =>
          violation.policyKey === "payments-terms" &&
          violation.claimId === "wallet-no-interest" &&
          violation.reason.includes("registered unresolved but this section cites settled-style"),
      ),
    ).toBe(true);
  });

  it("fails closed on an unregistered canonical claim id", () => {
    const registry = withPaymentsTermsCanonicalClaims("no-interest", [
      { claimId: "not-a-real-claim", productTruthRefs: [] },
    ]);

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) => violation.claimId === "not-a-real-claim" && violation.reason.includes("not registered"),
      ),
    ).toBe(true);
  });

  it("fails closed when a settled claim carries no product-truth evidence at all", () => {
    const registry = withPaymentsTermsCanonicalClaims("no-interest", [
      { claimId: "payment-charge-timing-and-capture", productTruthRefs: [] },
    ]);

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) =>
          violation.claimId === "payment-charge-timing-and-capture" &&
          violation.reason.includes("cites no product-truth evidence"),
      ),
    ).toBe(true);
  });

  it("negative control: fails closed on the exact historical shape — unresolved claim + valid openQuestion + flat settled-style draftText assertion with no structural disclosure (legal-artifact-draft-text-contradicts-own-open-question)", () => {
    const registry = withTermsOfServiceSectionOverride("wallet-nature-custody-interest", {
      draftText:
        "The Chase Sets Wallet is a marketplace ledger account. Wallet balances are not insured by the FDIC " +
        "or any other deposit insurer, are not a general obligation of any bank, and do not earn interest.",
      claimDisclosures: undefined,
    });

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) =>
          violation.sectionId === "wallet-nature-custody-interest" &&
          violation.claimId === "wallet-deposit-and-fdic-posture" &&
          violation.reason.includes("forbidden settled-style assertion"),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (violation) =>
          violation.sectionId === "wallet-nature-custody-interest" &&
          violation.claimId === "wallet-no-interest" &&
          violation.reason.includes("forbidden settled-style assertion"),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (violation) =>
          violation.sectionId === "wallet-nature-custody-interest" &&
          violation.reason.includes("no structural claimDisclosures segment"),
      ),
    ).toBe(true);
  });

  it("negative control: fails closed when an unresolved claim carries no open question, even with a structural disclosure segment present", () => {
    const terms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service")!;
    const section = terms.artifact.sections.find((candidate) => candidate.id === "wallet-nature-custody-interest")!;

    const registry = withTermsOfServiceSectionOverride("wallet-nature-custody-interest", {
      reviewManifest: { ...section.reviewManifest, openQuestions: [] },
    });

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    expect(
      violations.some(
        (violation) =>
          violation.sectionId === "wallet-nature-custody-interest" &&
          violation.reason.includes("no open question reflecting that"),
      ),
    ).toBe(true);
  });

  it("negative control: a synthetic section under an arbitrary policy and section id is not exempt (structural-guard-scoped-by-path-vocabulary)", () => {
    const registry = publicPolicyRegistry.map((entry) =>
      entry.artifact.metadata.policyKey === "payments-terms"
        ? ({
            ...entry,
            artifact: {
              ...entry.artifact,
              sections: [
                ...entry.artifact.sections,
                {
                  id: "totally-unrelated-synthetic-subject",
                  title: "Synthetic",
                  draftText: "Wallet balances do not earn interest and are not insured by the FDIC.",
                  reviewStatus: "counsel-required",
                  reviewManifest: {
                    scopeNote: "Synthetic test-only section.",
                    decisionRefs: [],
                    productTruthRefs: [],
                    openQuestions: ["synthetic open question"],
                    assumptions: [],
                  },
                },
              ],
            },
          } as unknown as PublicPolicyRegistryEntry)
        : entry,
    );

    const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
    const syntheticViolations = violations.filter(
      (violation) =>
        violation.sectionId === "totally-unrelated-synthetic-subject" &&
        violation.reason.includes("forbidden settled-style assertion"),
    );
    expect(syntheticViolations.length).toBeGreaterThanOrEqual(2);
    expect(syntheticViolations.some((violation) => violation.claimId === "wallet-no-interest")).toBe(true);
    expect(syntheticViolations.some((violation) => violation.claimId === "wallet-deposit-and-fdic-posture")).toBe(true);
  });
  it("rejects a sibling artifact that cites adjacent evidence instead of the canonical provenance identity", () => {
    const canonicalRefs = canonicalClaimRegistry["payment-charge-timing-and-capture"].productTruthRefs;
    expect(canonicalRefs.length).toBeGreaterThan(0);

    // The whole live corpus is consistent before the mutation.
    expect(evaluateCanonicalClaimConsistency(publicPolicyRegistry, repoRoot)).toEqual([]);

    // Privacy keeps the same settled claim but swaps one canonical citation for
    // an adjacent range that still resolves and still contains a required
    // keyword, so only the provenance-identity rule can catch it.
    const adjacentRef = "infrastructure/stripe-payments/index.ts:1464-1494";
    expect(canonicalRefs).not.toContain(adjacentRef);
    const drifted = publicPolicyRegistry.map((entry) =>
      entry.artifact.metadata.policyKey === "privacy-policy"
        ? ({
            ...entry,
            artifact: {
              ...entry.artifact,
              sections: entry.artifact.sections.map((section) =>
                section.id === "stripe-managed-processing"
                  ? {
                      ...section,
                      reviewManifest: {
                        ...section.reviewManifest,
                        canonicalClaims: [
                          { claimId: "payment-charge-timing-and-capture", productTruthRefs: [adjacentRef] },
                        ],
                      },
                    }
                  : section,
              ),
            },
          } as PublicPolicyRegistryEntry)
        : entry,
    );

    const violations = evaluateCanonicalClaimConsistency(drifted, repoRoot);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      policyKey: "privacy-policy",
      sectionId: "stripe-managed-processing",
      claimId: "payment-charge-timing-and-capture",
    });
    expect(violations[0].reason).toContain("exact product-truth provenance identity");
  });
});
