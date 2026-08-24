import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentConnectorTermsPolicyArtifact,
  requiredAgentConnectorTermsSubjectIds,
  type AgentConnectorTermsSubjectId,
} from "./agent-connector-terms";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
  type PublicPolicySection,
} from "./policy-artifact";
import { publicPolicyRegistry, type PublicPolicyRegistryEntry } from "./policy-registry";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const responsibilityClaimId = "authorized-agent-principal-responsibility-and-liability-boundary";
const sanctionClaimId = "agent-access-and-agent-caused-account-sanction-boundary";

const expectedSubjects = [
  "scope-and-definitions",
  "account-attribution-and-principal-liability",
  "authentication-and-authorized-surfaces",
  "permitted-purposes-and-rate-limits",
  "market-data-use",
  "agent-transactions",
  "suspension-and-revocation",
  "disclaimers-and-liability",
  "changes-and-versioning",
] as const;

const declaredForbiddenLiterals = [
  "you are fully responsible for",
  "you are solely responsible for",
  "is liable for all",
  "assumes all liability",
  "accepts full liability",
  "may suspend or revoke at any time",
  "at chase sets' sole discretion",
  "without notice or liability",
  "immediately terminate agent access",
  "reserves the right to revoke",
] as const;

const subjectContract: Readonly<
  Record<
    AgentConnectorTermsSubjectId,
    Readonly<{ propositionFragments: readonly string[]; questionFragments: readonly string[] }>
  >
> = {
  "scope-and-definitions": {
    propositionFragments: ["`/mcp`", "`/.well-known/ucp`", "`/ucp/mcp`", "not an executable connector"],
    questionFragments: ["parties", "covered automation", "document precedence"],
  },
  "account-attribution-and-principal-liability": {
    propositionFragments: ["authorized credential", "attributable to", "OAuth scopes", "Account-scoped actor"],
    questionFragments: ["Account holder", "responsible or liable", "qualified counsel"],
  },
  "authentication-and-authorized-surfaces": {
    propositionFragments: ["well-known metadata", "Authorization Code with PKCE", "refuses tool calls"],
    questionFragments: ["credential-protection duties", "unauthorized access", "broader surface"],
  },
  "permitted-purposes-and-rate-limits": {
    propositionFragments: ["Rate-Limit Policy", "refuse writes", "Numeric limits remain live"],
    questionFragments: ["permitted", "scraping", "rate-limit bypass", "universal prevention"],
  },
  "market-data-use": {
    propositionFragments: ["advertised as available", "read-only marketplace discovery", "do not establish terms"],
    questionFragments: ["redistribution", "model training", "competitive use", "technical prevention"],
  },
  "agent-transactions": {
    propositionFragments: ["exact confirmation", "write idempotency", "trusted UI handoff", "mandate"],
    questionFragments: ["legal effect", "mistakes", "end-to-end"],
  },
  "suspension-and-revocation": {
    propositionFragments: [
      "lists and revokes Linked Platform Authorizations",
      "revoke platform consent",
      "do not establish a contractual ground",
    ],
    questionFragments: ["grounds", "process and notice", "Account separately", "qualified counsel"],
  },
  "disclaimers-and-liability": {
    propositionFragments: ["bounded Chase Sets services", "qualified counsel review", "no numeric cap"],
    questionFragments: ["warranties", "disclaimers", "liability cap", "enforceable"],
  },
  "changes-and-versioning": {
    propositionFragments: ["version `v1`", "`counsel-review-required`", "non-activatable"],
    questionFragments: ["notice", "transition", "re-acceptance", "product wiring"],
  },
};

const assertionToSourceMatrix = [
  {
    id: "native-mcp",
    subjectId: "scope-and-definitions",
    ref: "docs/architecture/ucp-agent-commerce.md:5-21,59-63",
    fragments: ["`/mcp`", "first-party automation", "controls the agent host"],
  },
  {
    id: "external-ucp",
    subjectId: "scope-and-definitions",
    ref: "docs/architecture/ucp-agent-commerce.md:5-21,59-63",
    fragments: ["`/.well-known/ucp`", "`/ucp/mcp`", "External agent commerce"],
  },
  {
    id: "developer-portal-discovery",
    subjectId: "scope-and-definitions",
    ref: "bounded-contexts/public-presence/GLOSSARY.md:27-38",
    fragments: ["Developer Portal", "`/developers` route family", "agent-readable manifest"],
  },
  {
    id: "account-permission-boundary",
    subjectId: "account-attribution-and-principal-liability",
    ref: "infrastructure/platform-runtime/mcp-contracts.ts:156-190,239-261",
    fragments: ["authenticated actor", "Missing required permission", "account-scoped actor"],
  },
  {
    id: "credential-account-attribution",
    subjectId: "account-attribution-and-principal-liability",
    ref: "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:22-24,50-60,75-77",
    fragments: ["access token", "acting account", "permission boundary"],
  },
  {
    id: "documented-authentication",
    subjectId: "authentication-and-authorized-surfaces",
    ref: "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:24-60",
    fragments: ["Authorization Code with PKCE", "well-known metadata", "granted scopes"],
  },
  {
    id: "rate-limit-policy",
    subjectId: "permitted-purposes-and-rate-limits",
    ref: "bounded-contexts/platform-operations/features/rate-limit-policy/domain/rate-limit-policy.ts:5-22,143-171",
    fragments: ["REQUEST VOLUME ceilings", "platform-operations.rate-limits", "surface"],
  },
  {
    id: "agent-rate-limit-refusal",
    subjectId: "permitted-purposes-and-rate-limits",
    ref: "infrastructure/platform-runtime/agent-guardrails.ts:180-204",
    fragments: ["agent-grant.write", "allowed: false", "sending writes too quickly"],
  },
  {
    id: "available-market-data",
    subjectId: "market-data-use",
    ref: "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md:58-73",
    fragments: ["Public tools", "read-only marketplace discovery", "catalog:read"],
  },
  {
    id: "transaction-handoff",
    subjectId: "agent-transactions",
    ref: "docs/architecture/ucp-agent-commerce.md:17-21,48-75,83-89",
    fragments: ["confirmation", "idempotency", "trusted UI", "mandate"],
  },
  {
    id: "transaction-spend-guardrails",
    subjectId: "agent-transactions",
    ref: "infrastructure/platform-runtime/agent-guardrails.ts:207-318",
    fragments: ["humanPresentRequired", "per-order limit", "daily-cap", "monthly-cap"],
  },
  {
    id: "consent-revocation",
    subjectId: "suspension-and-revocation",
    ref: "docs/architecture/ucp-agent-commerce.md:11-15,83-87",
    fragments: ["listing and revoking Linked Platform Authorizations", "revoke platform consent"],
  },
  {
    id: "runtime-refusal-checks",
    subjectId: "suspension-and-revocation",
    ref: "infrastructure/platform-runtime/mcp-contracts.ts:156-236",
    fragments: ["allowed: false", "Missing required permission", "Confirmation is required"],
  },
  {
    id: "artifact-v1-posture",
    subjectId: "changes-and-versioning",
    ref: "bounded-contexts/public-presence/features/policies/domain/agent-connector-terms.ts:30-40",
    fragments: ['version: "v1"', 'publicationStatus: "counsel-review-required"', "effectiveAt: null"],
  },
  {
    id: "counsel-gated-version",
    subjectId: "changes-and-versioning",
    ref: "bounded-contexts/public-presence/features/policies/domain/policy-artifact.ts:369-429",
    fragments: ["publication status must be published", "counsel approval reference", "isConsentActivatable"],
  },
] as const satisfies readonly {
  id: string;
  subjectId: AgentConnectorTermsSubjectId;
  ref: string;
  fragments: readonly string[];
}[];

function readCitedText(ref: string): string {
  const separator = ref.lastIndexOf(":");
  const path = ref.slice(0, separator);
  const lines = readFileSync(resolve(repoRoot, path), "utf8").split(/\r?\n/);
  return ref
    .slice(separator + 1)
    .split(",")
    .map((part) => {
      const [startRaw, endRaw] = part.split("-");
      const start = Number(startRaw);
      const end = endRaw ? Number(endRaw) : start;
      return lines.slice(start - 1, end).join("\n");
    })
    .join("\n");
}

function sectionOf(
  artifact: PublicPolicyArtifact = agentConnectorTermsPolicyArtifact,
  subjectId: string,
): PublicPolicySection {
  const section = artifact.sections.find((candidate) => candidate.id === subjectId);
  if (!section) throw new Error(`missing Agent Connector Terms subject '${subjectId}'`);
  return section;
}

function withSection(
  subjectId: AgentConnectorTermsSubjectId,
  change: (section: PublicPolicySection) => PublicPolicySection,
): PublicPolicyArtifact {
  return {
    ...agentConnectorTermsPolicyArtifact,
    sections: agentConnectorTermsPolicyArtifact.sections.map((section) =>
      section.id === subjectId ? change(section) : section,
    ),
  };
}

function withAgentArtifact(artifact: PublicPolicyArtifact): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "agent-connector-terms"
      ? ({ ...entry, artifact } as PublicPolicyRegistryEntry)
      : entry,
  );
}

function approvedArtifact(): PublicPolicyArtifact {
  return {
    ...agentConnectorTermsPolicyArtifact,
    metadata: {
      ...agentConnectorTermsPolicyArtifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      counselApprovalReference: "SYNTHETIC-COUNSEL-APPROVAL-REFERENCE",
      rolloutJurisdictionsOrProductLimits: ["Synthetic reviewed scope."],
    },
    sections: agentConnectorTermsPolicyArtifact.sections.map((section) => ({
      ...section,
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

function sourceEntailmentErrors(artifact: PublicPolicyArtifact): readonly string[] {
  return assertionToSourceMatrix.flatMap((row) => {
    const section = artifact.sections.find((candidate) => candidate.id === row.subjectId);
    if (!section) return [`${row.subjectId}/${row.id}: missing subject`];
    const refs = [
      ...section.reviewManifest.productTruthRefs,
      ...section.reviewManifest.assumptions.map(({ evidenceRef }) => evidenceRef),
    ];
    if (!refs.includes(row.ref)) return [`${row.subjectId}/${row.id}: missing exact supporting citation '${row.ref}'`];
    const citedText = readCitedText(row.ref);
    return row.fragments
      .filter((fragment) => !citedText.includes(fragment))
      .map((fragment) => `${row.subjectId}/${row.id}: cited text does not entail '${fragment}'`);
  });
}

function candidateContractErrors(artifact: PublicPolicyArtifact): readonly string[] {
  const errors = [...validatePublicPolicyArtifactStructure(artifact), ...sourceEntailmentErrors(artifact)];
  const ids = artifact.sections.map((section) => section.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedSubjects)) errors.push("ordered nine-subject partition drifted");
  if (ids.includes("agent-connector-terms-scope")) errors.push("superseded stub predecessor remains");

  if (
    artifact.metadata.version !== "v1" ||
    artifact.metadata.publicationStatus !== "counsel-review-required" ||
    artifact.metadata.effectiveAt !== null ||
    artifact.metadata.counselApprovalReference !== null ||
    artifact.metadata.rolloutJurisdictionsOrProductLimits.length !== 0 ||
    artifact.metadata.launchRequired !== true
  ) {
    errors.push("counsel-pending v1 publication posture drifted");
  }

  const seenTitles = new Set<string>();
  for (const subjectId of expectedSubjects) {
    const section = artifact.sections.find((candidate) => candidate.id === subjectId);
    if (!section) {
      errors.push(`${subjectId}: missing subject`);
      continue;
    }
    if (!section.draftText.trim()) errors.push(`${subjectId}: blank draftText`);
    if (section.reviewStatus !== "counsel-required") errors.push(`${subjectId}: review status drifted`);
    if (!section.title.trim() || section.title === section.id || !/^[A-Z]/.test(section.title)) {
      errors.push(`${subjectId}: title must be non-empty sentence case and distinct from id`);
    }
    const titleKey = section.title.trim().toLowerCase();
    if (seenTitles.has(titleKey)) errors.push(`${subjectId}: duplicate title`);
    seenTitles.add(titleKey);

    for (const literal of declaredForbiddenLiterals) {
      if (section.title.toLowerCase().includes(literal) || section.draftText.toLowerCase().includes(literal)) {
        errors.push(`${subjectId}: forbidden literal '${literal}'`);
      }
    }
    for (const fragment of subjectContract[subjectId].propositionFragments) {
      if (!section.draftText.toLowerCase().includes(fragment.toLowerCase())) {
        errors.push(`${subjectId}: missing proposition '${fragment}'`);
      }
    }
    const questions = section.reviewManifest.openQuestions.join(" ");
    for (const fragment of subjectContract[subjectId].questionFragments) {
      if (!questions.toLowerCase().includes(fragment.toLowerCase())) {
        errors.push(`${subjectId}: missing counsel question '${fragment}'`);
      }
    }
    if (!("canonicalClaims" in section.reviewManifest)) errors.push(`${subjectId}: canonicalClaims must be explicit`);
    if (!("claimDisclosures" in section)) errors.push(`${subjectId}: claimDisclosures must be explicit`);
  }

  const expectedClaims = new Map<string, string>([
    ["account-attribution-and-principal-liability", responsibilityClaimId],
    ["suspension-and-revocation", sanctionClaimId],
  ]);
  for (const section of artifact.sections) {
    const expectedClaim = expectedClaims.get(section.id);
    const manifestClaims = (section.reviewManifest.canonicalClaims ?? []).map(({ claimId }) => claimId);
    const disclosures = (section.claimDisclosures ?? []).map(({ claimId }) => claimId);
    const expected = expectedClaim ? [expectedClaim] : [];
    if (JSON.stringify(manifestClaims) !== JSON.stringify(expected))
      errors.push(`${section.id}: canonical claim enrollment drifted`);
    if (JSON.stringify(disclosures) !== JSON.stringify(expected))
      errors.push(`${section.id}: claim disclosure enrollment drifted`);
    for (const claim of section.reviewManifest.canonicalClaims ?? []) {
      if (claim.productTruthRefs.length !== 0) errors.push(`${section.id}: unresolved claim locally overridden`);
    }
  }

  const completeDraft = artifact.sections.map(({ draftText }) => draftText).join("\n");
  for (const pattern of [
    /account holder (?:bears|accepts|has) (?:the )?(?:responsibility|liability|consequences)/i,
    /Chase Sets (?:may|can) (?:suspend|disable|revoke).*?(?:agent|Account)/i,
    /planned tools? (?:are|is) (?:available|callable|shipped)/i,
    /Chase Sets controls the external (?:UCP )?agent host/i,
    /Developer Portal is an executable connector/i,
  ]) {
    if (pattern.test(completeDraft)) errors.push(`governed or future proposition asserted: ${pattern}`);
  }

  return errors;
}

describe("agent connector terms: complete candidate", () => {
  it("contains exactly the nine candidate-independent subjects with complete counsel manifests", () => {
    expect(requiredAgentConnectorTermsSubjectIds).toEqual(expectedSubjects);
    expect(agentConnectorTermsPolicyArtifact.sections.map(({ id }) => id)).toEqual(expectedSubjects);
    expect(candidateContractErrors(agentConnectorTermsPolicyArtifact)).toEqual([]);
  });

  it.each(expectedSubjects)("keeps '%s' non-blank, counsel-required, and closed-schema valid", (subjectId) => {
    const section = sectionOf(agentConnectorTermsPolicyArtifact, subjectId);
    expect(section.draftText.trim().length, subjectId).toBeGreaterThan(0);
    expect(section.reviewStatus).toBe("counsel-required");
    expect(Object.keys(section.reviewManifest)).toEqual([
      "scopeNote",
      "decisionRefs",
      "productTruthRefs",
      "openQuestions",
      "assumptions",
      "canonicalClaims",
    ]);
    expect(
      candidateContractErrors(agentConnectorTermsPolicyArtifact).filter((error) => error.includes(subjectId)),
    ).toEqual([]);
  });

  it("stays v1, counsel-pending, launch-required, and non-activatable", () => {
    expect(agentConnectorTermsPolicyArtifact.metadata).toEqual({
      policyKey: "agent-connector-terms",
      version: "v1",
      locale: "en",
      href: "/agent-terms",
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
      rolloutJurisdictionsOrProductLimits: [],
      launchRequired: true,
    });
    expect(isConsentActivatable(agentConnectorTermsPolicyArtifact, expectedSubjects)).toBe(false);
    expect(evaluatePublicPolicyPublicationReadiness(agentConnectorTermsPolicyArtifact, expectedSubjects).ready).toBe(
      false,
    );
    expect(evaluatePublicPolicyPublicationReadiness(approvedArtifact(), expectedSubjects)).toEqual({
      ready: true,
      errors: [],
    });
  });

  it.each(expectedSubjects)("negative control: dropping '%s' fails naming that subject", (subjectId) => {
    const mutant: PublicPolicyArtifact = {
      ...agentConnectorTermsPolicyArtifact,
      sections: agentConnectorTermsPolicyArtifact.sections.filter((section) => section.id !== subjectId),
    };
    expect(candidateContractErrors(mutant).join("\n")).toContain(subjectId);
  });

  it.each(expectedSubjects)("negative control: blanking '%s' draft text fails naming that subject", (subjectId) => {
    const mutant = withSection(subjectId, (section) => ({ ...section, draftText: "   " }));
    expect(candidateContractErrors(mutant).join("\n")).toContain(`${subjectId}: blank draftText`);
  });

  it.each(expectedSubjects)(
    "negative control: removing '%s' proposition coverage fails naming that subject",
    (subjectId) => {
      const fragment = subjectContract[subjectId].propositionFragments[0];
      const mutant = withSection(subjectId, (section) => ({
        ...section,
        draftText: section.draftText.replace(fragment, "[removed proposition]"),
      }));
      expect(candidateContractErrors(mutant).join("\n")).toContain(`${subjectId}: missing proposition '${fragment}'`);
    },
  );

  it.each(expectedSubjects)(
    "negative control: removing '%s' counsel questions fails naming that subject",
    (subjectId) => {
      const mutant = withSection(subjectId, (section) => ({
        ...section,
        reviewManifest: { ...section.reviewManifest, openQuestions: [] },
      }));
      expect(candidateContractErrors(mutant).join("\n")).toContain(`${subjectId}: missing counsel question`);
    },
  );

  it("rejects duplicate-id, duplicate-title, unknown-field, publication-flip, stub, and forbidden-title mutants", () => {
    const duplicateId: PublicPolicyArtifact = {
      ...agentConnectorTermsPolicyArtifact,
      sections: agentConnectorTermsPolicyArtifact.sections.map((section, index) =>
        index === 1 ? { ...section, id: expectedSubjects[0] } : section,
      ),
    };
    expect(candidateContractErrors(duplicateId).join("\n")).toContain("duplicated");

    const duplicateTitle = withSection(expectedSubjects[1], (section) => ({
      ...section,
      title: sectionOf(agentConnectorTermsPolicyArtifact, expectedSubjects[0]).title,
    }));
    expect(candidateContractErrors(duplicateTitle).join("\n")).toContain(`${expectedSubjects[1]}: duplicate title`);

    const unknownField = withSection(
      expectedSubjects[0],
      (section) => ({ ...section, unknownLegalPosture: true }) as unknown as PublicPolicySection,
    );
    expect(candidateContractErrors(unknownField).join("\n")).toContain("unknownLegalPosture");

    const publicationFlip: PublicPolicyArtifact = {
      ...agentConnectorTermsPolicyArtifact,
      metadata: { ...agentConnectorTermsPolicyArtifact.metadata, publicationStatus: "published" },
    };
    expect(candidateContractErrors(publicationFlip).join("\n")).toContain("publication posture drifted");

    const stub: PublicPolicyArtifact = {
      ...agentConnectorTermsPolicyArtifact,
      sections: [{ ...agentConnectorTermsPolicyArtifact.sections[0], id: "agent-connector-terms-scope" }],
    };
    expect(candidateContractErrors(stub).join("\n")).toContain("superseded stub predecessor remains");

    const forbiddenTitle = withSection(expectedSubjects[0], (section) => ({
      ...section,
      title: "You are fully responsible for connector access",
    }));
    expect(candidateContractErrors(forbiddenTitle).join("\n")).toContain(
      `${expectedSubjects[0]}: forbidden literal 'you are fully responsible for'`,
    );
  });
});

describe("agent connector terms: product truth and counsel boundary", () => {
  it.each(assertionToSourceMatrix)("reads exact supporting source text for $id", ({ subjectId, ref, fragments }) => {
    const section = sectionOf(agentConnectorTermsPolicyArtifact, subjectId);
    const registeredRefs = [
      ...section.reviewManifest.productTruthRefs,
      ...section.reviewManifest.assumptions.map(({ evidenceRef }) => evidenceRef),
    ];
    expect(registeredRefs, subjectId).toContain(ref);
    const citedText = readCitedText(ref);
    for (const fragment of fragments) expect(citedText, `${subjectId}/${ref}`).toContain(fragment);
  });

  it("keeps native MCP, external UCP, and Developer Portal discovery as three separately entailed assertions", () => {
    expect(assertionToSourceMatrix.slice(0, 3).map(({ id }) => id)).toEqual([
      "native-mcp",
      "external-ucp",
      "developer-portal-discovery",
    ]);
  });

  it("negative control: an adjacent but non-entailing citation fails the native MCP assertion", () => {
    const adjacent = "docs/architecture/ucp-agent-commerce.md:23-33";
    const adjacentText = readCitedText(adjacent);
    expect(adjacentText).not.toContain("controls the agent host");
    const mutant = withSection("scope-and-definitions", (section) => ({
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        productTruthRefs: section.reviewManifest.productTruthRefs.map((ref) =>
          ref === assertionToSourceMatrix[0].ref ? adjacent : ref,
        ),
      },
    }));
    expect(sectionOf(mutant, "scope-and-definitions").reviewManifest.productTruthRefs).not.toContain(
      assertionToSourceMatrix[0].ref,
    );
    expect(sourceEntailmentErrors(mutant).join("\n")).toContain("native-mcp: missing exact supporting citation");
  });

  it.each([
    {
      name: "future-as-shipped",
      subjectId: "scope-and-definitions" as const,
      sentence: "planned tools are callable today",
    },
    {
      name: "native-authority-applied-to-external-ucp",
      subjectId: "scope-and-definitions" as const,
      sentence: "Chase Sets controls the external UCP agent host",
    },
    {
      name: "portal-as-executable",
      subjectId: "scope-and-definitions" as const,
      sentence: "The Developer Portal is an executable connector",
    },
    {
      name: "draft-contradicts-own-open-question",
      subjectId: "account-attribution-and-principal-liability" as const,
      sentence: "The Account holder bears responsibility for every action and consequence of an authorized agent.",
    },
  ])("negative control: $name fails independently", ({ subjectId, sentence }) => {
    const mutant = withSection(subjectId, (section) => ({
      ...section,
      draftText: `${section.draftText} ${sentence}`,
    }));
    expect(candidateContractErrors(mutant).some((error) => error.includes("governed or future proposition"))).toBe(
      true,
    );
  });
});

describe("agent connector terms: #6817 canonical claim consumption", () => {
  it("enrolls the two exact claims once in matching manifest and disclosure shapes", () => {
    expect(
      agentConnectorTermsPolicyArtifact.sections.flatMap((section) =>
        (section.reviewManifest.canonicalClaims ?? []).map((claim) => ({
          sectionId: section.id,
          claimId: claim.claimId,
          productTruthRefs: claim.productTruthRefs,
          disclosures: section.claimDisclosures,
        })),
      ),
    ).toEqual([
      {
        sectionId: "account-attribution-and-principal-liability",
        claimId: responsibilityClaimId,
        productTruthRefs: [],
        disclosures: [{ claimId: responsibilityClaimId }],
      },
      {
        sectionId: "suspension-and-revocation",
        claimId: sanctionClaimId,
        productTruthRefs: [],
        disclosures: [{ claimId: sanctionClaimId }],
      },
    ]);
    expect(evaluateCanonicalClaimConsistency(publicPolicyRegistry, repoRoot)).toEqual([]);
  });

  it("negative control: moving an enrollment fails both exact subjects", () => {
    const account = sectionOf(agentConnectorTermsPolicyArtifact, "account-attribution-and-principal-liability");
    const scope = sectionOf(agentConnectorTermsPolicyArtifact, "scope-and-definitions");
    const mutant: PublicPolicyArtifact = {
      ...agentConnectorTermsPolicyArtifact,
      sections: agentConnectorTermsPolicyArtifact.sections.map((section) => {
        if (section.id === account.id) {
          return {
            ...section,
            reviewManifest: { ...section.reviewManifest, canonicalClaims: [] },
            claimDisclosures: [],
          };
        }
        if (section.id === scope.id) {
          return {
            ...section,
            reviewManifest: { ...section.reviewManifest, canonicalClaims: account.reviewManifest.canonicalClaims },
            claimDisclosures: account.claimDisclosures,
          };
        }
        return section;
      }),
    };
    const errors = candidateContractErrors(mutant).join("\n");
    expect(errors).toContain("account-attribution-and-principal-liability: canonical claim enrollment drifted");
    expect(errors).toContain("scope-and-definitions: canonical claim enrollment drifted");
  });

  it("negative control: dropping one disclosure fails the landed whole-corpus consistency guard", () => {
    const mutant = withSection("account-attribution-and-principal-liability", (section) => ({
      ...section,
      claimDisclosures: [],
    }));
    const violations = evaluateCanonicalClaimConsistency(withAgentArtifact(mutant), repoRoot);
    expect(violations).toContainEqual(
      expect.objectContaining({
        policyKey: "agent-connector-terms",
        sectionId: "account-attribution-and-principal-liability",
        claimId: responsibilityClaimId,
      }),
    );
  });

  it("negative control: a local unresolved-status override is rejected by the closed schema", () => {
    const mutant = withSection("account-attribution-and-principal-liability", (section) => ({
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        canonicalClaims: [{ claimId: responsibilityClaimId, productTruthRefs: [], status: "settled" } as never],
      },
    }));
    expect(validatePublicPolicyArtifactStructure(mutant).join("\n")).toContain("status");
  });

  it("negative control: every declared forbidden literal is red in an Agent title even though the corpus guard scans draftText", () => {
    for (const literal of declaredForbiddenLiterals) {
      const mutant = withSection("scope-and-definitions", (section) => ({
        ...section,
        title: `Probe: ${literal}`,
      }));
      expect(candidateContractErrors(mutant).join("\n"), literal).toContain(`forbidden literal '${literal}'`);
    }
  });
});
