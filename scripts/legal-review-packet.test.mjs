import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateCanonicalClaimConsistency } from "../bounded-contexts/public-presence/features/policies/domain/canonical-claim-guard.ts";
import {
  complianceLegalReviewArticleSlugs,
  incorporatedHelpArticleSlugs,
} from "../bounded-contexts/public-presence/features/help/domain/compliance-legal-review-corpus.ts";
import { publicPolicyHrefsByKey, publicPolicyKeys } from "../contracts/public-docs/policy-corpus.ts";
import { consentBundleDeclarations } from "../bounded-contexts/identity/features/consents/domain/consent-bundle.ts";
import {
  COUNSEL_REVIEW_PACKET_RECEIPT_VERSION,
  COUNSEL_REVIEW_PACKET_VERSION,
  buildCounselReviewPacketReceipt,
  buildLegalReviewCorpus,
  evaluateGeneratedOutputFreshness,
  loadLegalReviewAuthorities,
  normalizeMarkdownSource,
  renderCounselReviewPacket,
  renderCounselReviewPacketReceipt,
  validateCounselReviewPacketReceipt,
} from "./legal-review-corpus.mjs";
import { buildLegalReviewPacketEmission, main, parseLegalReviewPacketArgs } from "./legal-review-packet.mjs";
import { repoRoot } from "./lib/repo.mjs";

// Every negative control below freezes the real authorities and mutates
// exactly one variable, then runs the SAME production derivation
// (`buildLegalReviewCorpus`) the CLI runs. Nothing here reaches for a
// lookalike loader, and nothing writes to a checked-in file.

const TERMS_INCORPORATION_SECTION_ID = "conduct-and-policy-incorporation";
const DMCA_SOURCE_FILE = "intellectual-property-and-dmca.en.md";

let authorities;
let baseline;

beforeAll(async () => {
  authorities = await loadLegalReviewAuthorities();
  baseline = expectCorpus(authorities);
}, 120_000);

function expectCorpus(candidate) {
  const result = buildLegalReviewCorpus(candidate);
  if (!result.ok) {
    throw new Error(`expected a valid corpus, got: ${result.errors.join(" | ")}`);
  }
  return result.corpus;
}

function withPolicyRegistry(mapEntry) {
  return { ...authorities, policyRegistry: authorities.policyRegistry.map(mapEntry) };
}

function mapPolicy(policyKey, mapArtifact) {
  return withPolicyRegistry((entry) =>
    entry.artifact.metadata.policyKey === policyKey ? { ...entry, artifact: mapArtifact(entry.artifact) } : entry,
  );
}

function mapSection(policyKey, sectionId, mapSectionValue) {
  return mapPolicy(policyKey, (artifact) => ({
    ...artifact,
    sections: artifact.sections.map((section) => (section.id === sectionId ? mapSectionValue(section) : section)),
  }));
}

function withArticleSource(fileName, mapSource) {
  return {
    ...authorities,
    helpArticleSources: authorities.helpArticleSources.map((source) =>
      source.fileName === fileName ? { ...source, source: mapSource(source.source) } : source,
    ),
  };
}

function digestsByPolicy(corpus) {
  return Object.fromEntries(corpus.policies.map((policy) => [policy.policyKey, policy.reviewedContentSha256]));
}

function digestsByArticle(corpus) {
  return Object.fromEntries(corpus.complianceArticles.map((article) => [article.slug, article.sourceSha256]));
}

function packetBytes(corpus) {
  return Buffer.from(renderCounselReviewPacket(corpus), "utf8");
}

async function runCli(argv, dependencies = {}) {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(argv, {
    write: (value) => stdout.push(value),
    writeError: (value) => stderr.push(value),
    ...dependencies,
  });
  return { exitCode, stdout: stdout.join(""), stderr };
}

describe("#5695 legal review corpus: closed membership and source authority", () => {
  it("derives exactly the registered policy, compliance, incorporated, and consent members in authority order", () => {
    expect(baseline.policies.map((policy) => policy.policyKey)).toEqual([...publicPolicyKeys]);
    for (const policy of baseline.policies) {
      expect(policy.href).toBe(publicPolicyHrefsByKey[policy.policyKey]);
      expect(new Set(baseline.policies.map((candidate) => candidate.policyKey)).size).toBe(baseline.policies.length);
    }
    expect(baseline.launchRequiredPolicyKeys).toEqual([
      "terms-of-service",
      "privacy-policy",
      "seller-agreement",
      "payments-terms",
      "agent-connector-terms",
      "founders-offer-terms",
    ]);
    expect(baseline.complianceArticles.map((article) => article.slug)).toEqual([...complianceLegalReviewArticleSlugs]);
    expect(baseline.incorporatedHelpArticles.map((reference) => reference.slug)).toEqual([
      ...incorporatedHelpArticleSlugs,
    ]);
    expect(baseline.consentBundles).toEqual([
      { bundleKey: "registration", subjectScope: "user", members: ["terms-of-service", "privacy-policy"] },
      { bundleKey: "seller-onboarding", subjectScope: "account", members: ["seller-agreement", "payments-terms"] },
    ]);
    for (const bundle of baseline.consentBundles) {
      for (const member of bundle.members) {
        expect(baseline.policies.filter((policy) => policy.policyKey === member)).toHaveLength(1);
      }
    }
  });

  it("fails closed when a compliance member's raw realization is removed, duplicated, or conflicting", () => {
    const removed = buildLegalReviewCorpus({
      ...authorities,
      helpArticleSources: authorities.helpArticleSources.filter((source) => source.fileName !== "sales-tax.en.md"),
    });
    expect(removed.ok).toBe(false);
    expect(removed.errors).toContain(
      "Compliance legal-review member 'sales-tax' must own exactly one canonical source named 'sales-tax.en.md'.",
    );

    const duplicated = buildLegalReviewCorpus({
      ...authorities,
      helpArticleSources: [
        ...authorities.helpArticleSources,
        authorities.helpArticleSources.find((source) => source.fileName === "sales-tax.en.md"),
      ],
    });
    expect(duplicated.ok).toBe(false);
    expect(duplicated.errors).toContain(
      "Compliance legal-review member 'sales-tax' must own exactly one canonical source named 'sales-tax.en.md'.",
    );

    const conflicting = buildLegalReviewCorpus({
      ...authorities,
      helpArticleSources: [
        ...authorities.helpArticleSources,
        { fileName: "sales-tax.fr.md", source: "---\nslug: sales-tax\n---\nsynthetic conflicting realization\n" },
      ],
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.errors).toContain(
      "Compliance legal-review member 'sales-tax' must own exactly one canonical source named 'sales-tax.en.md'.",
    );
  });

  it("fails closed on an unknown manifest slug, an unknown registry key, an href conflict, and consent-bundle drift", () => {
    const unknownSlug = buildLegalReviewCorpus({
      ...authorities,
      complianceArticleSlugs: [...complianceLegalReviewArticleSlugs, "synthetic-unregistered-compliance-article"],
    });
    expect(unknownSlug.ok).toBe(false);
    expect(unknownSlug.errors).toContain(
      "Compliance legal-review member 'synthetic-unregistered-compliance-article' resolves 0 times in the compiled Help Article catalog; exactly one is required.",
    );

    const unknownKey = buildLegalReviewCorpus({
      ...authorities,
      policyRegistry: [
        ...authorities.policyRegistry,
        {
          artifact: {
            ...authorities.policyRegistry[0].artifact,
            metadata: {
              ...authorities.policyRegistry[0].artifact.metadata,
              policyKey: "synthetic-unregistered-policy",
            },
          },
          requiredSubjectIds: [],
        },
      ],
    });
    expect(unknownKey.ok).toBe(false);
    expect(unknownKey.errors).toContain("Public policy registry entry 7 declares an unknown policy key.");

    const hrefConflict = buildLegalReviewCorpus(
      mapPolicy("founders-offer-terms", (artifact) => ({
        ...artifact,
        metadata: { ...artifact.metadata, href: "/terms" },
      })),
    );
    expect(hrefConflict.ok).toBe(false);
    expect(hrefConflict.errors).toContain(
      "Public policy 'founders-offer-terms' must carry the canonical '/founders' route.",
    );

    const registrationDrift = buildLegalReviewCorpus({
      ...authorities,
      consentBundleDeclarations: {
        ...consentBundleDeclarations,
        registration: {
          bundleKey: "registration",
          subjectScope: "user",
          members: ["terms-of-service", "synthetic-unregistered-policy"],
        },
      },
    });
    expect(registrationDrift.ok).toBe(false);
    expect(registrationDrift.errors).toContain(
      "Consent bundle 'registration' member 'synthetic-unregistered-policy' does not resolve to a registered policy member.",
    );

    const sellerDrift = buildLegalReviewCorpus({
      ...authorities,
      consentBundleDeclarations: {
        ...consentBundleDeclarations,
        "seller-onboarding": {
          bundleKey: "seller-onboarding",
          subjectScope: "account",
          members: ["seller-agreement", "synthetic-unregistered-policy"],
        },
      },
    });
    expect(sellerDrift.ok).toBe(false);
    expect(sellerDrift.errors).toContain(
      "Consent bundle 'seller-onboarding' member 'synthetic-unregistered-policy' does not resolve to a registered policy member.",
    );
  });

  it("closes the Terms incorporation cross-reference over every sibling route and incorporated identity", () => {
    const incorporation = authorities.policyRegistry
      .find((entry) => entry.artifact.metadata.policyKey === "terms-of-service")
      .artifact.sections.find((section) => section.id === TERMS_INCORPORATION_SECTION_ID);
    for (const entry of authorities.policyRegistry) {
      if (entry.artifact.metadata.policyKey === "terms-of-service") continue;
      expect(incorporation.draftText).toContain(entry.artifact.metadata.href);
    }

    const droppedSibling = buildLegalReviewCorpus(
      mapSection("terms-of-service", TERMS_INCORPORATION_SECTION_ID, (section) => ({
        ...section,
        draftText: section.draftText.replaceAll("chasesets.com/payments-terms", "the payments document"),
      })),
    );
    expect(droppedSibling.ok).toBe(false);
    expect(droppedSibling.errors).toContain(
      "Terms of Service subject 'conduct-and-policy-incorporation' does not incorporate registered policy 'payments-terms' by its canonical route.",
    );

    const droppedIncorporation = buildLegalReviewCorpus(
      mapSection("terms-of-service", TERMS_INCORPORATION_SECTION_ID, (section) => ({
        ...section,
        draftText: section.draftText.replaceAll("order-protection", "buyer safeguards"),
      })),
    );
    expect(droppedIncorporation.ok).toBe(false);
    expect(droppedIncorporation.errors).toContain(
      "Terms of Service subject 'conduct-and-policy-incorporation' does not name incorporated Help Article 'order-protection'.",
    );
  });

  it("rejects an incorporated reference that is also a reproduced compliance member", () => {
    const overlap = buildLegalReviewCorpus({
      ...authorities,
      incorporatedHelpArticleSlugs: [...incorporatedHelpArticleSlugs, "sales-tax"],
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.errors).toContain(
      "Help Article 'sales-tax' cannot be both a reproduced compliance member and a summary-only incorporated reference.",
    );
  });
});

describe("#5695 counsel review packet: deterministic bytes and lifecycle-stable identity", () => {
  it("emits one deterministic UTF-8/LF packet whose receipt names exactly those retained bytes", async () => {
    const packet = renderCounselReviewPacket(baseline);
    expect(renderCounselReviewPacket(baseline)).toBe(packet);
    expect(renderCounselReviewPacket(expectCorpus(authorities))).toBe(packet);

    const bytes = Buffer.from(packet, "utf8");
    expect(bytes.subarray(0, 3).toString("hex")).not.toBe("efbbbf");
    expect(packet.includes("\r")).toBe(false);
    expect(packet.endsWith("\n")).toBe(true);
    expect(packet.endsWith("\n\n")).toBe(false);

    const receipt = buildCounselReviewPacketReceipt(baseline, bytes);
    expect(receipt.schemaVersion).toBe(COUNSEL_REVIEW_PACKET_RECEIPT_VERSION);
    expect(receipt.packet.schemaVersion).toBe(COUNSEL_REVIEW_PACKET_VERSION);
    expect(receipt.packet.utf8Bytes).toBe(bytes.byteLength);
    expect(receipt.corpus.sha256).toBe(baseline.identity.sha256);
    expect(Object.keys(receipt)).toEqual(["schemaVersion", "packet", "corpus"]);
    expect(Object.keys(receipt.packet)).toEqual(["schemaVersion", "sha256", "utf8Bytes"]);
    expect(Object.keys(receipt.corpus)).toEqual([
      "sha256",
      "policies",
      "complianceArticles",
      "incorporatedHelpArticleSlugs",
      "consentBundles",
    ]);
    expect(validateCounselReviewPacketReceipt(receipt).ok).toBe(true);
    expect(renderCounselReviewPacketReceipt(receipt).endsWith("\n")).toBe(true);

    const cli = await runCli([]);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toBe(packet);
    const receiptCli = await runCli(["--receipt"]);
    expect(receiptCli.exitCode).toBe(0);
    expect(JSON.parse(receiptCli.stdout)).toEqual(receipt);
  });

  it("renders every packet member, the non-authority header, and explicit `none` for empty arrays", () => {
    const packet = renderCounselReviewPacket(baseline);
    expect(packet).toContain("It is not legal advice, not a counsel");
    expect(packet).toContain(baseline.identity.sha256);
    for (const policy of baseline.policies) {
      expect(packet).toContain(policy.reviewedContentSha256);
      expect(packet).toContain(`- Publication status: ${policy.publicationStatus}`);
      for (const section of policy.sections) {
        expect(packet).toContain(`(\`${section.id}\`)`);
        expect(packet).toContain(`- Review status: ${section.reviewStatus}`);
        expect(packet).toContain(section.reviewManifest.scopeNote);
        for (const disclosure of section.claimDisclosures) {
          expect(packet).toContain(disclosure.resolvedText);
        }
      }
    }
    for (const article of baseline.complianceArticles) {
      expect(packet).toContain(article.sourceSha256);
      expect(packet).toContain(article.markdown);
    }
    for (const reference of baseline.incorporatedHelpArticles) {
      expect(packet).toContain(reference.href);
    }
    // Authenticity is packet-only and must be reported as such, never as a
    // launch-required document.
    expect(packet).toContain("no — packet only");
    expect(packet).toContain("- Effective at: none");
    expect(packet).toContain("- Counsel approval reference: none");
    expect(packet).toContain("- Rollout jurisdictions or product limits: none");
    expect(packet).toContain("  none");
  });

  it("moves exactly the mutated member's identity for every one-variable content mutation", () => {
    const basePolicyDigests = digestsByPolicy(baseline);
    const baseArticleDigests = digestsByArticle(baseline);
    const basePacket = packetBytes(baseline);

    const mutations = [
      {
        name: "content-only policy draft text",
        corpus: expectCorpus(
          mapSection("seller-agreement", "listing-obligations", (section) => ({
            ...section,
            draftText: `${section.draftText} Synthetic reviewed-content control sentence.`,
          })),
        ),
        movedPolicies: ["seller-agreement"],
        movedArticles: [],
      },
      {
        name: "review-manifest-only change",
        corpus: expectCorpus(
          mapSection("payments-terms", "no-interest", (section) => ({
            ...section,
            reviewManifest: {
              ...section.reviewManifest,
              openQuestions: [...section.reviewManifest.openQuestions, "Synthetic reviewed-manifest control question."],
            },
          })),
        ),
        movedPolicies: ["payments-terms"],
        movedArticles: [],
      },
      {
        name: "stable metadata version bump",
        corpus: expectCorpus(
          mapPolicy("founders-offer-terms", (artifact) => ({
            ...artifact,
            metadata: { ...artifact.metadata, version: "v2" },
          })),
        ),
        movedPolicies: ["founders-offer-terms"],
        movedArticles: [],
      },
      {
        name: "compliance body-only change",
        corpus: expectCorpus(
          withArticleSource("sales-tax.en.md", (source) => `${source}\nSynthetic compliance body control line.\n`),
        ),
        movedPolicies: [],
        movedArticles: ["sales-tax"],
      },
      {
        name: "article frontmatter-only change",
        corpus: expectCorpus(
          withArticleSource("prohibited-and-restricted-items.en.md", (source) =>
            source.replace('reviewedAt: "2026-08-02"', 'reviewedAt: "2026-08-03"'),
          ),
        ),
        movedPolicies: [],
        movedArticles: ["prohibited-and-restricted-items"],
      },
    ];

    for (const mutation of mutations) {
      const policyDigests = digestsByPolicy(mutation.corpus);
      const articleDigests = digestsByArticle(mutation.corpus);
      for (const [policyKey, digest] of Object.entries(policyDigests)) {
        const shouldMove = mutation.movedPolicies.includes(policyKey);
        expect(digest === basePolicyDigests[policyKey], `${mutation.name}: ${policyKey}`).toBe(!shouldMove);
      }
      for (const [slug, digest] of Object.entries(articleDigests)) {
        const shouldMove = mutation.movedArticles.includes(slug);
        expect(digest === baseArticleDigests[slug], `${mutation.name}: ${slug}`).toBe(!shouldMove);
      }
      expect(mutation.corpus.identity.sha256, mutation.name).not.toBe(baseline.identity.sha256);
      expect(packetBytes(mutation.corpus).equals(basePacket), mutation.name).toBe(false);
    }
  });

  it("moves consent-order and incorporated-reference identity without touching any member digest", () => {
    const reorderedConsent = expectCorpus({
      ...authorities,
      consentBundleDeclarations: {
        ...consentBundleDeclarations,
        registration: {
          bundleKey: "registration",
          subjectScope: "user",
          members: ["privacy-policy", "terms-of-service"],
        },
      },
    });
    expect(digestsByPolicy(reorderedConsent)).toEqual(digestsByPolicy(baseline));
    expect(reorderedConsent.identity.sha256).not.toBe(baseline.identity.sha256);
    expect(packetBytes(reorderedConsent).equals(packetBytes(baseline))).toBe(false);

    const reorderedIncorporation = expectCorpus({
      ...authorities,
      incorporatedHelpArticleSlugs: ["order-protection", "condition-and-photo-standards", "refunds-and-returns"],
    });
    expect(digestsByArticle(reorderedIncorporation)).toEqual(digestsByArticle(baseline));
    expect(reorderedIncorporation.identity.sha256).not.toBe(baseline.identity.sha256);
  });

  it("moves every referencing policy digest — and only those — for a central canonical-disclosure text change", () => {
    const claimId = "wallet-no-interest";
    const referencing = new Set(
      baseline.policies
        .filter((policy) =>
          policy.sections.some((section) =>
            section.claimDisclosures.some((disclosure) => disclosure.claimId === claimId),
          ),
        )
        .map((policy) => policy.policyKey),
    );
    expect(referencing.size).toBeGreaterThan(0);
    expect(referencing.size).toBeLessThan(baseline.policies.length);

    const mutated = expectCorpus({
      ...authorities,
      resolveDisclosureText: (candidate) =>
        candidate === claimId
          ? "Synthetic central disclosure control text for the unresolved wallet interest claim."
          : authorities.resolveDisclosureText(candidate),
    });

    const basePolicyDigests = digestsByPolicy(baseline);
    for (const [policyKey, digest] of Object.entries(digestsByPolicy(mutated))) {
      expect(digest === basePolicyDigests[policyKey], policyKey).toBe(!referencing.has(policyKey));
    }
    expect(mutated.identity.sha256).not.toBe(baseline.identity.sha256);
    expect(packetBytes(mutated).equals(packetBytes(baseline))).toBe(false);
    expect(digestsByArticle(mutated)).toEqual(digestsByArticle(baseline));
  });

  it("keeps every reviewed-content and corpus identity fixed across a publication-only lifecycle transition", () => {
    const published = expectCorpus(
      withPolicyRegistry((entry) => ({
        ...entry,
        artifact: {
          ...entry.artifact,
          metadata: {
            ...entry.artifact.metadata,
            publicationStatus: "published",
            effectiveAt: "2026-09-01T00:00:00.000Z",
            counselApprovalReference: "SYNTHETIC-COUNSEL-DISPOSITION-CONTROL-0001",
            rolloutJurisdictionsOrProductLimits: ["synthetic-reviewed-rollout-scope"],
          },
          sections: entry.artifact.sections.map((section) => ({ ...section, reviewStatus: "counsel-approved" })),
        },
      })),
    );

    expect(digestsByPolicy(published)).toEqual(digestsByPolicy(baseline));
    expect(digestsByArticle(published)).toEqual(digestsByArticle(baseline));
    expect(published.identity.sha256).toBe(baseline.identity.sha256);
    // The retained packet bytes still name what counsel actually read, so a
    // publication-only transition is visible in the packet even though the
    // reviewed-content identity is stable.
    expect(packetBytes(published).equals(packetBytes(baseline))).toBe(false);
    expect(published.policies.every((policy) => policy.publicationReadinessErrors.length === 0)).toBe(true);
    expect(baseline.policies.every((policy) => policy.publicationReadinessErrors.length > 0)).toBe(true);
  });

  it("normalizes compliance Markdown line endings without moving a source digest", () => {
    const crlf = expectCorpus(
      withArticleSource("sales-tax.en.md", (source) => `${source.replace(/\n/g, "\r\n")}\r\n\r\n`),
    );
    expect(digestsByArticle(crlf)).toEqual(digestsByArticle(baseline));
    expect(crlf.identity.sha256).toBe(baseline.identity.sha256);
    expect(normalizeMarkdownSource("a\r\nb\r\n\r\n")).toBe("a\nb\n");
  });
});

describe("#5695 counsel review packet: fail closed at the owning entrypoint", () => {
  it("emits no packet bytes for a blank draft, a missing subject, or an unknown manifest field", async () => {
    const blank = buildLegalReviewCorpus(
      mapSection("privacy-policy", "retention", (section) => ({ ...section, draftText: "   \n  " })),
    );
    expect(blank.ok).toBe(false);
    expect(blank.errors).toContain(
      "Public policy 'privacy-policy' subject 'retention' has no operative draft text to review.",
    );

    const missingSubject = buildLegalReviewCorpus(
      mapPolicy("seller-agreement", (artifact) => ({
        ...artifact,
        sections: artifact.sections.filter((section) => section.id !== "taxes"),
      })),
    );
    expect(missingSubject.ok).toBe(false);
    expect(missingSubject.errors).toContain("Public policy 'seller-agreement' is missing required subject 'taxes'.");

    const unknownField = buildLegalReviewCorpus(
      mapSection("payments-terms", "kyc-and-verification", (section) => ({
        ...section,
        reviewManifest: { ...section.reviewManifest, syntheticUnknownManifestField: "control" },
      })),
    );
    expect(unknownField.ok).toBe(false);
    expect(unknownField.errors.join(" ")).toContain("syntheticUnknownManifestField");

    // A structurally malformed artifact must read as a bounded diagnostic, not
    // as an exception thrown while projecting a field the schema never had.
    const malformed = buildLegalReviewCorpus(
      mapPolicy("privacy-policy", (artifact) => ({ ...artifact, sections: "not-an-array" })),
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.errors).toContain("Privacy Policy artifact requires at least one section.");

    for (const failing of [blank, missingSubject, unknownField]) {
      const cli = await runCli([], { loadLegalReviewCorpus: async () => failing });
      expect(cli.exitCode).toBe(1);
      expect(cli.stdout).toBe("");
      expect(cli.stderr.length).toBeGreaterThan(1);
    }
  });

  it("fails closed on a contradictory canonical claim state found by the real corpus guard", () => {
    const mutatedRegistry = mapSection("terms-of-service", "wallet-nature-custody-interest", (section) => ({
      ...section,
      draftText: `${section.draftText} Wallet balances do not earn interest.`,
    }));
    const violations = evaluateCanonicalClaimConsistency(mutatedRegistry.policyRegistry, repoRoot);
    expect(violations.length).toBeGreaterThan(0);

    const result = buildLegalReviewCorpus({ ...mutatedRegistry, canonicalClaimViolations: violations });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("wallet-no-interest");
    expect(result.errors.join(" ")).toContain("forbidden settled-style assertion");
  });

  it("keeps the checked-in generated output current and refuses to emit a packet when it is stale", async () => {
    expect(await evaluateGeneratedOutputFreshness()).toEqual([]);

    const stale = buildLegalReviewCorpus({
      ...authorities,
      generatedOutputErrors: [
        "Generated public policy record 'contracts/public-docs/generated/index.ts' is stale for the current policy source.",
      ],
    });
    expect(stale.ok).toBe(false);
    expect(stale.errors).toContain(
      "Generated public policy record 'contracts/public-docs/generated/index.ts' is stale for the current policy source.",
    );

    const cli = await runCli([], { loadLegalReviewCorpus: async () => stale });
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe("");
  });

  it("rejects an unreadable member and an unresolvable claim disclosure without partial bytes", async () => {
    const unreadable = buildLegalReviewCorpus({
      ...authorities,
      helpArticleSources: authorities.helpArticleSources.filter((source) => source.fileName !== DMCA_SOURCE_FILE),
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.errors.join(" ")).toContain("intellectual-property-and-dmca");

    const unresolvable = buildLegalReviewCorpus({
      ...authorities,
      resolveDisclosureText: () => {
        throw new Error("SUPER-SECRET-INTERNAL-PATH-SHOULD-NEVER-SURFACE");
      },
    });
    expect(unresolvable.ok).toBe(false);
    expect(unresolvable.errors.join(" ")).toContain("has no resolvable canonical disclosure text (Error)");
    expect(unresolvable.errors.join(" ")).not.toContain("SUPER-SECRET-INTERNAL-PATH-SHOULD-NEVER-SURFACE");

    const cli = await runCli([], { loadLegalReviewCorpus: async () => unreadable });
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe("");
  });

  it("rejects option-shape errors before invocation, writing nothing to stdout", async () => {
    expect(parseLegalReviewPacketArgs(["--receipt"])).toEqual({ receipt: true, errors: [] });
    expect(parseLegalReviewPacketArgs(["--receipt", "--receipt"]).errors).toHaveLength(1);

    const unknownOption = await runCli(["--out", "secure/packet.md"]);
    expect(unknownOption.exitCode).toBe(2);
    expect(unknownOption.stdout).toBe("");
    expect(unknownOption.stderr.join(" ")).toContain("does not accept the option '--out'");
  });

  it("never reads process environment or echoes a secret sentinel into packet bytes", async () => {
    const sentinel = "CHASE-SETS-PACKET-SECRET-SENTINEL-DO-NOT-EMIT";
    process.env.CHASE_SETS_PACKET_SECRET_SENTINEL = sentinel;
    process.env.AWS_SECRET_ACCESS_KEY = sentinel;
    try {
      const emission = await buildLegalReviewPacketEmission({ receipt: false });
      const receiptEmission = await buildLegalReviewPacketEmission({ receipt: true });
      expect(emission.ok && receiptEmission.ok).toBe(true);
      expect(emission.output).not.toContain(sentinel);
      expect(receiptEmission.output).not.toContain(sentinel);
    } finally {
      delete process.env.CHASE_SETS_PACKET_SECRET_SENTINEL;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }

    for (const relativePath of ["scripts/legal-review-corpus.mjs", "scripts/legal-review-packet.mjs"]) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      expect(source, relativePath).not.toContain("process.env");
      expect(source, relativePath).not.toContain("writeFile");
      expect(source, relativePath).not.toContain("fetch(");
      // A POSIX absolute path already starts with a separator, so pasting one
      // after a three-slash file scheme yields a four-slash URL that only
      // looks correct on Windows. Authority modules resolve via pathToFileURL.
      expect(source, relativePath).not.toContain(`file:///$\{`);
    }
  });

  it("builds every authority module URL with pathToFileURL so POSIX hosts resolve identically", async () => {
    // The authorities in `beforeAll` already loaded through those URLs on this
    // host; this pins the construction so a concatenated URL cannot come back
    // and pass on Windows while failing on Linux.
    expect(readFileSync(path.join(repoRoot, "scripts/legal-review-corpus.mjs"), "utf8")).toContain(
      "pathToFileURL(path.resolve(repoRootPath, relativePath)).href",
    );
    expect((await loadLegalReviewAuthorities()).policyRegistry.length).toBeGreaterThan(0);
  });
});

describe("#5695 counsel review packet receipt: recursively closed schema", () => {
  it("rejects unknown keys, missing keys, malformed digests, and a predecessor receipt shape", () => {
    const receipt = buildCounselReviewPacketReceipt(baseline, packetBytes(baseline));
    expect(validateCounselReviewPacketReceipt(receipt)).toEqual({ ok: true, receipt, errors: [] });

    const unknownKey = validateCounselReviewPacketReceipt({ ...receipt, generatedAt: "2026-09-05T00:00:00.000Z" });
    expect(unknownKey.ok).toBe(false);
    expect(unknownKey.errors).toContain("Counsel review packet receipt has an unexpected field 'generatedAt'.");

    const { corpus: _corpus, ...missingCorpus } = receipt;
    expect(validateCounselReviewPacketReceipt(missingCorpus).ok).toBe(false);

    const badDigest = validateCounselReviewPacketReceipt({
      ...receipt,
      packet: { ...receipt.packet, sha256: receipt.packet.sha256.toUpperCase() },
    });
    expect(badDigest.ok).toBe(false);
    expect(badDigest.errors).toContain(
      "Counsel review packet receipt packet.sha256 must be a lowercase sha256 digest.",
    );

    const predecessor = validateCounselReviewPacketReceipt({
      schemaVersion: "counsel-review-packet-receipt/v0",
      packet: { schemaVersion: "counsel-review-packet/v0", sha256: receipt.packet.sha256, utf8Bytes: 1 },
      corpus: {
        sha256: receipt.corpus.sha256,
        policies: [],
        complianceArticles: [],
        incorporatedHelpArticleSlugs: [],
        consentBundles: [],
      },
    });
    expect(predecessor.ok).toBe(false);
    expect(predecessor.errors.join(" ")).toContain("schemaVersion must be counsel-review-packet-receipt/v1");

    const shallowPolicy = validateCounselReviewPacketReceipt({
      ...receipt,
      corpus: {
        ...receipt.corpus,
        policies: [
          { ...receipt.corpus.policies[0], reviewedContentSha256: "not-a-digest" },
          ...receipt.corpus.policies.slice(1),
        ],
      },
    });
    expect(shallowPolicy.ok).toBe(false);
    expect(shallowPolicy.errors).toContain(
      "Counsel review packet receipt corpus.policies[0].reviewedContentSha256 must be a lowercase sha256 digest.",
    );
  });
});
