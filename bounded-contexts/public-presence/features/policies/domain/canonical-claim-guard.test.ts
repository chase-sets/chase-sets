import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import type { PublicPolicyRegistryEntry } from "./policy-registry";
import { publicPolicyRegistry } from "./policy-registry";

const domainDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(domainDirectory, "../../../../..");

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
});
