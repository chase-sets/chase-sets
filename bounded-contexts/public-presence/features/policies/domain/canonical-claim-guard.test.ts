import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalClaimRegistry, resolveUnresolvedPublicDisclosureText } from "./canonical-claims";
import { evaluateCanonicalClaimConsistency, projectCanonicalClaimReviewCorpus } from "./canonical-claim-guard";
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

const agentResponsibilityClaimId = "authorized-agent-principal-responsibility-and-liability-boundary";
const agentSuspensionClaimId = "agent-access-suspension-and-revocation-boundary";

/**
 * Appends test-only sections to one registered artifact. The sections exist
 * for the duration of one assertion and are never registered, compiled, or
 * rendered.
 */
function withSyntheticSections(
  policyKey: string,
  sections: readonly Readonly<{ id: string; draftText: string }>[],
): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === policyKey
      ? ({
          ...entry,
          artifact: {
            ...entry.artifact,
            sections: [
              ...entry.artifact.sections,
              ...sections.map((section) => ({
                id: section.id,
                title: "Synthetic control",
                draftText: section.draftText,
                reviewStatus: "counsel-required",
                reviewManifest: {
                  scopeNote: "Synthetic test-only section.",
                  decisionRefs: [],
                  productTruthRefs: [],
                  openQuestions: ["synthetic open question"],
                  assumptions: [],
                },
              })),
            ],
          },
        } as unknown as PublicPolicyRegistryEntry)
      : entry,
  );
}

/**
 * A one-section corpus under an unmistakably synthetic policy key, so a probe
 * is scored strictly on its own text with nothing else in scope. Never
 * registered, compiled, rendered, or offered as public draft text.
 */
function isolatedSyntheticCorpus(sectionId: string, draftText: string): readonly PublicPolicyRegistryEntry[] {
  return [
    {
      artifact: {
        metadata: { policyKey: "synthetic-semantic-probe-corpus" },
        title: "Synthetic semantic probe corpus",
        description: "Test-only synthetic corpus. Never registered, compiled, rendered, or published.",
        sections: [
          {
            id: sectionId,
            title: "Synthetic semantic probe",
            draftText,
            reviewStatus: "counsel-required",
            reviewManifest: {
              scopeNote: "Synthetic test-only probe.",
              decisionRefs: [],
              productTruthRefs: [],
              openQuestions: ["synthetic open question"],
              assumptions: [],
            },
          },
        ],
      },
      requiredSubjectIds: [],
    },
  ] as unknown as readonly PublicPolicyRegistryEntry[];
}

/** The ten declared literals, in their declared per-claim order. */
const declaredForbiddenLiterals = [
  { claimId: agentResponsibilityClaimId, phrase: "you are fully responsible for" },
  { claimId: agentResponsibilityClaimId, phrase: "you are solely responsible for" },
  { claimId: agentResponsibilityClaimId, phrase: "is liable for all" },
  { claimId: agentResponsibilityClaimId, phrase: "assumes all liability" },
  { claimId: agentResponsibilityClaimId, phrase: "accepts full liability" },
  { claimId: agentSuspensionClaimId, phrase: "may suspend or revoke at any time" },
  { claimId: agentSuspensionClaimId, phrase: "at chase sets' sole discretion" },
  { claimId: agentSuspensionClaimId, phrase: "without notice or liability" },
  { claimId: agentSuspensionClaimId, phrase: "immediately terminate agent access" },
  { claimId: agentSuspensionClaimId, phrase: "reserves the right to revoke" },
] as const;

/**
 * Reviewer-authored, anchor-free paraphrases of the two governed propositions.
 * None contains any declared literal. They exist to demonstrate the opposite
 * of coverage: the lexical layer stays silent on all of them, which is why the
 * semantic adjudication is a human judgment recorded in the review matrix and
 * the lexical layer is only defense in depth.
 */
const anchorFreeSemanticProbes = [
  {
    sectionId: "synthetic-pa-paraphrase",
    draftText: "The person who owns the account bears the consequences of everything a delegated program does.",
  },
  {
    sectionId: "synthetic-pb-paraphrase",
    draftText: "Chase Sets may disable a delegated program's credentials whenever its conduct violates these rules.",
  },
  {
    sectionId: "synthetic-pa-bounded-agent-order",
    draftText: "When a delegated program places an order through the profile, its owner must pay for that order.",
  },
  {
    sectionId: "synthetic-pb-agent-caused-account-lock",
    draftText: "If an automated delegate breaks an incorporated rule, Chase Sets can lock the profile it uses.",
  },
] as const;

/** The three enrollments, and what dropping each half must report. */
const agentBoundaryEnrollments = [
  { sectionId: "eligibility-and-accounts", claimId: agentResponsibilityClaimId },
  { sectionId: "electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
  { sectionId: "electronic-agents-and-automated-access", claimId: agentSuspensionClaimId },
] as const;

function termsSectionOf(sectionId: string) {
  const terms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service")!;
  return terms.artifact.sections.find((candidate) => candidate.id === sectionId)!;
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

describe("review-corpus projection", () => {
  it("projects every registered section exactly once, with draft text and resolved disclosures as distinct columns", () => {
    const rows = projectCanonicalClaimReviewCorpus(publicPolicyRegistry);

    const expectedKeys = publicPolicyRegistry.flatMap((entry) =>
      entry.artifact.sections.map((section) => `${entry.artifact.metadata.policyKey}#${section.id}`),
    );
    const actualKeys = rows.map((row) => `${row.policyKey}#${row.sectionId}`);

    expect(actualKeys).toEqual(expectedKeys);
    expect(new Set(actualKeys).size).toBe(actualKeys.length);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const section = publicPolicyRegistry
        .find((entry) => entry.artifact.metadata.policyKey === row.policyKey)!
        .artifact.sections.find((candidate) => candidate.id === row.sectionId)!;

      // Column one is the operative prose exactly as registered.
      expect(row.draftText).toBe(section.draftText);

      for (const disclosure of row.claimDisclosures) {
        // Column two is resolved from the registry, never from the section...
        expect(disclosure.disclosureText).toBe(resolveUnresolvedPublicDisclosureText(disclosure.claimId));
        expect(disclosure.disclosureText.length).toBeGreaterThan(0);
        // ...and the two columns never bleed into one another, so a reviewer
        // can read draft text alone and see a declined proposition as absent
        // rather than as asserted.
        expect(row.draftText).not.toContain(disclosure.disclosureText);
      }
    }
  });

  it("surfaces exactly the three agent-boundary enrollments across exactly two sections", () => {
    const rows = projectCanonicalClaimReviewCorpus(publicPolicyRegistry);
    const enrolled = rows.flatMap((row) =>
      row.claimDisclosures
        .filter(
          (disclosure) =>
            disclosure.claimId === agentResponsibilityClaimId || disclosure.claimId === agentSuspensionClaimId,
        )
        .map((disclosure) => ({ row: `${row.policyKey}#${row.sectionId}`, claimId: disclosure.claimId })),
    );

    expect(enrolled).toEqual([
      { row: "terms-of-service#eligibility-and-accounts", claimId: agentResponsibilityClaimId },
      { row: "terms-of-service#electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
      { row: "terms-of-service#electronic-agents-and-automated-access", claimId: agentSuspensionClaimId },
    ]);
    expect(new Set(enrolled.map((entry) => entry.row)).size).toBe(2);
  });
});

describe("authorized-agent boundary claims", () => {
  it("holds both identities unresolved with one status, one provenance, and no product truth", () => {
    for (const claimId of [agentResponsibilityClaimId, agentSuspensionClaimId] as const) {
      const definition = canonicalClaimRegistry[claimId];

      expect(definition.status).toBe("unresolved");
      expect(definition.productTruthRefs).toEqual([]);
      expect(definition.requiredEvidenceKeywords).toEqual([]);
      expect(definition.unresolvedPublicDisclosure).toBeTruthy();
    }
  });

  it("declares the ten literals exactly as ordered", () => {
    expect(canonicalClaimRegistry[agentResponsibilityClaimId].forbiddenAssertionPhrases).toEqual(
      declaredForbiddenLiterals.filter((entry) => entry.claimId === agentResponsibilityClaimId).map((e) => e.phrase),
    );
    expect(canonicalClaimRegistry[agentSuspensionClaimId].forbiddenAssertionPhrases).toEqual(
      declaredForbiddenLiterals.filter((entry) => entry.claimId === agentSuspensionClaimId).map((e) => e.phrase),
    );
    expect(declaredForbiddenLiterals).toHaveLength(10);
  });

  it("table: each declared literal fails with its own claimId and no other", () => {
    for (const { claimId, phrase } of declaredForbiddenLiterals) {
      const registry = withSyntheticSections("payments-terms", [
        {
          id: "synthetic-declared-literal-probe",
          draftText: `Synthetic probe sentence: ${phrase} the stated subject.`,
        },
      ]);

      const hits = evaluateCanonicalClaimConsistency(registry, repoRoot).filter(
        (violation) => violation.sectionId === "synthetic-declared-literal-probe",
      );

      expect(
        hits.map((violation) => violation.claimId),
        `literal '${phrase}'`,
      ).toEqual([claimId]);
      expect(hits[0].reason).toContain(phrase);
      expect(hits[0].reason).toContain("forbidden settled-style assertion");
    }
  });

  it("reports zero declared-literal matches over every registered section at the candidate head", () => {
    expect(evaluateCanonicalClaimConsistency(publicPolicyRegistry, repoRoot)).toEqual([]);

    const matches = projectCanonicalClaimReviewCorpus(publicPolicyRegistry).flatMap((row) =>
      declaredForbiddenLiterals
        .filter((literal) => row.draftText.toLowerCase().includes(literal.phrase))
        .map((literal) => `${row.policyKey}#${row.sectionId}: ${literal.phrase}`),
    );

    expect(matches).toEqual([]);
  });

  it("leaves both must-stay-green controls green: the Account suspension subject and the limited collection-agent role", () => {
    const controls = [
      { policyKey: "terms-of-service", sectionId: "suspension-closure-and-holds" },
      { policyKey: "terms-of-service", sectionId: "marketplace-role-and-limited-payments-agent" },
      { policyKey: "payments-terms", sectionId: "processor-pass-through-and-collection-agent-role" },
    ] as const;

    for (const control of controls) {
      const entry = publicPolicyRegistry.find(
        (candidate) => candidate.artifact.metadata.policyKey === control.policyKey,
      )!;
      const section = entry.artifact.sections.find((candidate) => candidate.id === control.sectionId);

      expect(section, `${control.policyKey}#${control.sectionId} must exist`).toBeDefined();
      expect(
        evaluateCanonicalClaimConsistency(
          [{ artifact: { ...entry.artifact, sections: [section!] }, requiredSubjectIds: [] }],
          repoRoot,
        ),
      ).toEqual([]);
    }
  });

  it("negative control: every anchor-free paraphrase stays lexically silent, so the literals are not the semantic oracle", () => {
    for (const probe of anchorFreeSemanticProbes) {
      // Scored in isolation, on its own synthetic section id.
      const isolated = evaluateCanonicalClaimConsistency(
        isolatedSyntheticCorpus(probe.sectionId, probe.draftText),
        repoRoot,
      );
      expect(isolated, `${probe.sectionId} isolated lexical report`).toEqual([]);

      for (const literal of declaredForbiddenLiterals) {
        expect(probe.draftText.toLowerCase()).not.toContain(literal.phrase);
      }
    }
  });

  it("negative control: the two paraphrases stay lexically silent inside an otherwise-valid registered section", () => {
    for (const probe of anchorFreeSemanticProbes.slice(0, 2)) {
      const section = termsSectionOf("conduct-and-policy-incorporation");
      const registry = withTermsOfServiceSectionOverride("conduct-and-policy-incorporation", {
        draftText: `${section.draftText} ${probe.draftText}`,
      });

      // The override must actually have landed, or the empty violation list
      // below would prove nothing at all.
      const mutated = projectCanonicalClaimReviewCorpus(registry).find(
        (row) => row.policyKey === "terms-of-service" && row.sectionId === "conduct-and-policy-incorporation",
      );
      expect(mutated?.draftText, `${probe.sectionId} must be injected`).toContain(probe.draftText);

      expect(evaluateCanonicalClaimConsistency(registry, repoRoot), `${probe.sectionId} injected`).toEqual([]);
    }
  });

  it("negative control: dropping a claimDisclosures segment fails naming the exact claimId and section", () => {
    for (const enrollment of agentBoundaryEnrollments) {
      const section = termsSectionOf(enrollment.sectionId);
      const registry = withTermsOfServiceSectionOverride(enrollment.sectionId, {
        claimDisclosures: (section.claimDisclosures ?? []).filter(
          (disclosure) => disclosure.claimId !== enrollment.claimId,
        ),
      });

      const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
      expect(
        violations.some(
          (violation) =>
            violation.policyKey === "terms-of-service" &&
            violation.sectionId === enrollment.sectionId &&
            violation.claimId === enrollment.claimId &&
            violation.reason.includes("no structural claimDisclosures segment"),
        ),
        `${enrollment.sectionId}/${enrollment.claimId}`,
      ).toBe(true);
    }
  });

  it("negative control: dropping the mirroring manifest entry fails naming the exact claimId and section", () => {
    for (const enrollment of agentBoundaryEnrollments) {
      const section = termsSectionOf(enrollment.sectionId);
      const registry = withTermsOfServiceSectionOverride(enrollment.sectionId, {
        reviewManifest: {
          ...section.reviewManifest,
          canonicalClaims: (section.reviewManifest.canonicalClaims ?? []).filter(
            (claimRef) => claimRef.claimId !== enrollment.claimId,
          ),
        },
      });

      const violations = evaluateCanonicalClaimConsistency(registry, repoRoot);
      expect(
        violations.some(
          (violation) =>
            violation.policyKey === "terms-of-service" &&
            violation.sectionId === enrollment.sectionId &&
            violation.claimId === enrollment.claimId &&
            violation.reason.includes("not tracked in this section's reviewManifest"),
        ),
        `${enrollment.sectionId}/${enrollment.claimId}`,
      ).toBe(true);
    }
  });

  it("negative control: marking either new claim settled fails naming the exact claimId and section", async () => {
    for (const claimId of [agentResponsibilityClaimId, agentSuspensionClaimId] as const) {
      vi.resetModules();
      vi.doMock("./canonical-claims", async () => {
        const actual = await vi.importActual<typeof import("./canonical-claims")>("./canonical-claims");
        return {
          ...actual,
          canonicalClaimRegistry: {
            ...actual.canonicalClaimRegistry,
            [claimId]: { ...actual.canonicalClaimRegistry[claimId], status: "settled" },
          },
        };
      });

      const { evaluateCanonicalClaimConsistency: evaluateWithSettledClaim } = await import("./canonical-claim-guard");
      const violations = evaluateWithSettledClaim(publicPolicyRegistry, repoRoot);
      const enrolledSections = agentBoundaryEnrollments
        .filter((enrollment) => enrollment.claimId === claimId)
        .map((enrollment) => enrollment.sectionId);

      for (const sectionId of enrolledSections) {
        expect(
          violations.some(
            (violation) =>
              violation.sectionId === sectionId &&
              violation.claimId === claimId &&
              violation.reason.includes("cites no product-truth evidence"),
          ),
          `${sectionId}/${claimId} settled-without-evidence`,
        ).toBe(true);
        expect(
          violations.some(
            (violation) =>
              violation.sectionId === sectionId &&
              violation.claimId === claimId &&
              violation.reason.includes("the canonical registry marks settled"),
          ),
          `${sectionId}/${claimId} disclosure-on-settled-claim`,
        ).toBe(true);
      }

      vi.doUnmock("./canonical-claims");
      vi.resetModules();
    }
  });
});
