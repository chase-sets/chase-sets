import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalClaimRegistry, resolveUnresolvedPublicDisclosureText } from "./canonical-claims";
import { evaluateCanonicalClaimConsistency, projectCanonicalClaimReviewCorpus } from "./canonical-claim-guard";
import type { PublicPolicyRegistryEntry } from "./policy-registry";
import { publicPolicyRegistry } from "./policy-registry";
import { readCitedSourceSlice } from "../integrations/privacy-product-truth-inventory.mjs";

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
const agentAccessAndAccountSanctionClaimId = "agent-access-and-agent-caused-account-sanction-boundary";

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
  { claimId: agentAccessAndAccountSanctionClaimId, phrase: "may suspend or revoke at any time" },
  { claimId: agentAccessAndAccountSanctionClaimId, phrase: "at chase sets' sole discretion" },
  { claimId: agentAccessAndAccountSanctionClaimId, phrase: "without notice or liability" },
  { claimId: agentAccessAndAccountSanctionClaimId, phrase: "immediately terminate agent access" },
  { claimId: agentAccessAndAccountSanctionClaimId, phrase: "reserves the right to revoke" },
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

type SemanticVerdict = "green" | "red";

const registeredCorpusSectionIds = {
  "terms-of-service": [
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
  ],
  "privacy-policy": [
    "privacy-notice-scope",
    "data-categories-and-sources",
    "purposes-of-use",
    "recipients-and-disclosures",
    "stripe-managed-processing",
    "cookies-and-analytics",
    "gpc-and-sale-share",
    "privacy-rights-and-requests",
    "retention",
    "children",
    "state-supplements",
    "automated-decisionmaking-technology",
  ],
  "seller-agreement": [
    "seller-eligibility-and-verification",
    "listing-obligations",
    "fulfillment-obligations",
    "fees-and-deductions",
    "payouts-holds-and-reserves",
    "taxes",
    "buyer-data-use-restrictions",
    "off-platform-circumvention",
    "enforcement-and-termination",
    "dispute-resolution",
    "governing-law",
  ],
  "payments-terms": [
    "processor-pass-through-and-collection-agent-role",
    "charge-timing-and-statement-descriptor",
    "payout-timing-and-clearance",
    "holds-freezes-and-offsets",
    "chargebacks-and-disputes",
    "kyc-and-verification",
    "no-interest",
    "tax-form-delivery",
    "errors-and-unauthorized-transactions",
    "termination-and-residual-obligations",
  ],
  "agent-connector-terms": ["agent-connector-terms-scope"],
  "authenticity-service-terms": [
    "service-nature",
    "opt-in-and-fee",
    "custody-and-care",
    "verification-outcomes",
    "counterfeit-handling",
    "funds-and-reviews",
    "condition-notes-and-disputes",
    "liability-limits",
    "service-termination",
  ],
  "founders-offer-terms": ["founders-offer-terms-scope"],
} as const;

const mustStayGreenReasons: Readonly<Record<string, string>> = {
  "terms-of-service#suspension-closure-and-holds":
    "Actor-neutral Account status and hold rules neither assign responsibility for agent conduct nor name it as a trigger.",
  "terms-of-service#marketplace-role-and-limited-payments-agent":
    "The limited payments collection-agent role is Chase Sets' role, not an account holder's authorized software agent.",
  "terms-of-service#listings-offers-and-contract-formation":
    "Listing, offer, and seller duties are owed independently of whether an authorized software agent exists.",
  "terms-of-service#disclaimers-and-liability-limits":
    "The disclaimer is actor-neutral and does not allocate responsibility for an authorized software agent's conduct.",
  "seller-agreement#enforcement-and-termination":
    "Seller enforcement rules do not name agent conduct as a trigger or regulate an authorized software agent's access.",
  "seller-agreement#seller-eligibility-and-verification":
    "Seller eligibility and verification duties are independent of authorized software-agent activity.",
  "seller-agreement#payouts-holds-and-reserves":
    "Payout holds and reserves are actor-neutral and are not stated as consequences of agent conduct.",
  "seller-agreement#listing-obligations":
    "Listing obligations apply on their own terms, whether or not the account holder uses a software agent.",
  "seller-agreement#fulfillment-obligations":
    "Fulfillment obligations apply on their own terms, whether or not the account holder uses a software agent.",
  "seller-agreement#taxes":
    "Tax duties apply on their own terms and allocate no responsibility for an authorized software agent's act.",
  "payments-terms#processor-pass-through-and-collection-agent-role":
    "The payments collection-agent role is Chase Sets' role and is a different referent from an authorized software agent.",
  "payments-terms#termination-and-residual-obligations":
    "Termination and residual obligations are actor-neutral and do not attribute an Account sanction to agent conduct.",
};

/**
 * Reviewer-authored finite matrix data. This is not a semantic scorer: every
 * registered row is named explicitly, and the independent exact-head reviewer
 * remains the judgment authority that attacks these recorded verdicts.
 */
const registeredCorpusAdjudicationMatrix = Object.entries(registeredCorpusSectionIds).flatMap(
  ([policyKey, sectionIds]) =>
    sectionIds.map((sectionId) => {
      const row = `${policyKey}#${sectionId}`;
      return {
        row,
        principalResponsibility: "green" as SemanticVerdict,
        agentAccessOrAccountSanction: "green" as SemanticVerdict,
        reason:
          mustStayGreenReasons[row] ??
          "The complete draftText was read as a finite row and states neither governed authorized-software-agent proposition.",
      };
    }),
);

const semanticControlAdjudications = [
  {
    sectionId: "restored-agent-responsibility-and-sanction-sentence",
    draftText:
      "You remain responsible for actions your authorized agent takes on your Account, and Chase Sets may suspend an agent's access, or your Account, for activity that violates these Terms, the Agent Connector Terms, or an incorporated policy.",
    principalResponsibility: "red",
    agentAccessOrAccountSanction: "red",
  },
  {
    sectionId: "restored-all-account-activity-clause",
    draftText:
      "You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key, and for all activity conducted through your Account.",
    principalResponsibility: "red",
    agentAccessOrAccountSanction: "green",
  },
  ...anchorFreeSemanticProbes.map((probe, index) => ({
    ...probe,
    principalResponsibility: (index === 0 || index === 2 ? "red" : "green") as SemanticVerdict,
    agentAccessOrAccountSanction: (index === 1 || index === 3 ? "red" : "green") as SemanticVerdict,
  })),
] as const;

/** The three enrollments, and what dropping each half must report. */
const agentBoundaryEnrollments = [
  { sectionId: "eligibility-and-accounts", claimId: agentResponsibilityClaimId },
  { sectionId: "electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
  { sectionId: "electronic-agents-and-automated-access", claimId: agentAccessAndAccountSanctionClaimId },
] as const;

function termsSectionOf(sectionId: string) {
  const terms = publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service")!;
  return terms.artifact.sections.find((candidate) => candidate.id === sectionId)!;
}

type SourceSpan = Readonly<{ start: number; end: number }>;

const termsSourcePath = "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts";
const claimGuardSourcePath = "bounded-contexts/public-presence/features/policies/domain/canonical-claim-guard.ts";
const termsAcceptanceSourcePath = "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts";

function sourceLines(relativePath: string): readonly string[] {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replaceAll("\r\n", "\n").split("\n");
}

function sectionSourceSpan(relativePath: string, sectionId: string): SourceSpan {
  const lines = sourceLines(relativePath);
  const startIndex = lines.findIndex((line) => line === `      id: "${sectionId}",`);
  if (startIndex < 0) {
    throw new Error(`Could not independently locate section '${sectionId}' in ${relativePath}.`);
  }
  const nextIndex = lines.findIndex((line, index) => index > startIndex && line.startsWith('      id: "'));
  return { start: startIndex + 1, end: nextIndex < 0 ? lines.length : nextIndex };
}

function topLevelFunctionSourceSpan(relativePath: string, symbol: string): SourceSpan {
  const lines = sourceLines(relativePath);
  const startIndex = lines.findIndex((line) => new RegExp(`^(?:export )?(?:async )?function ${symbol}\\(`).test(line));
  if (startIndex < 0) {
    throw new Error(`Could not independently locate function '${symbol}' in ${relativePath}.`);
  }
  let parameterDepth = 0;
  let bodyDepth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    for (const character of lines[index]!) {
      if (!opened) {
        if (character === "(") parameterDepth += 1;
        if (character === ")") parameterDepth -= 1;
        if (character === "{" && parameterDepth === 0) {
          opened = true;
          bodyDepth = 1;
        }
      } else if (character === "{") {
        bodyDepth += 1;
      } else if (character === "}") {
        bodyDepth -= 1;
      }
    }
    if (opened && bodyDepth === 0) {
      return { start: startIndex + 1, end: index + 1 };
    }
  }
  throw new Error(`Could not derive the closing boundary for function '${symbol}' in ${relativePath}.`);
}

function withLeadingDocumentation(relativePath: string, span: SourceSpan): SourceSpan {
  const lines = sourceLines(relativePath);
  let cursor = span.start - 2;
  while (cursor >= 0 && lines[cursor]!.trim() === "") cursor -= 1;
  if (cursor < 0 || !lines[cursor]!.trim().endsWith("*/")) return span;
  while (cursor >= 0 && !lines[cursor]!.trim().startsWith("/**")) cursor -= 1;
  if (cursor < 0) throw new Error(`Unclosed leading documentation block before ${relativePath}:${span.start}.`);
  return { start: cursor + 1, end: span.end };
}

function termsAcceptanceSymbolSourceSpan(symbol: string): SourceSpan {
  const lines = sourceLines(termsAcceptanceSourcePath);
  if (symbol === "resolveTermsAcceptanceStatus") {
    return withLeadingDocumentation(
      termsAcceptanceSourcePath,
      topLevelFunctionSourceSpan(termsAcceptanceSourcePath, symbol),
    );
  }
  const declaration =
    symbol === "TermsAcceptanceStatus"
      ? "export type TermsAcceptanceStatus = ConsentPolicyAcceptanceStatus;"
      : symbol === "ConsentActivationAuthorityReader"
        ? "export type { ConsentActivationAuthorityReader };"
        : undefined;
  if (declaration === undefined) throw new Error(`Unknown Terms acceptance symbol '${symbol}'.`);
  const lineIndex = lines.findIndex((line) => line === declaration);
  if (lineIndex < 0) throw new Error(`Could not independently locate '${symbol}' in ${termsAcceptanceSourcePath}.`);
  return withLeadingDocumentation(termsAcceptanceSourcePath, { start: lineIndex + 1, end: lineIndex + 1 });
}

type CitationAuthorityRow = Readonly<{
  id: `C${number}`;
  ref: string;
  targetPath: string;
  identity: string;
  fragment: string;
  minimalEdges?: Readonly<{ first: string; last: string }>;
  neighbours: readonly [string, string];
  spanOf: (identity: string) => SourceSpan;
}>;

const citationAuthorityRows: readonly CitationAuthorityRow[] = [
  {
    id: "C1",
    ref: `${termsSourcePath}:370`,
    targetPath: termsSourcePath,
    identity: "eligibility-and-accounts",
    fragment: "at least 18 years old",
    neighbours: ["marketplace-role-and-limited-payments-agent", "listings-offers-and-contract-formation"],
    spanOf: (identity) => sectionSourceSpan(termsSourcePath, identity),
  },
  {
    id: "C2",
    ref: `${termsSourcePath}:370`,
    targetPath: termsSourcePath,
    identity: "eligibility-and-accounts",
    fragment: "at least 18 years old",
    neighbours: ["marketplace-role-and-limited-payments-agent", "listings-offers-and-contract-formation"],
    spanOf: (identity) => sectionSourceSpan(termsSourcePath, identity),
  },
  {
    id: "C3",
    ref: `${termsSourcePath}:576-602`,
    targetPath: termsSourcePath,
    identity: "user-vs-user-dispute-release",
    fragment: "Support Request process through which you and the other party may submit evidence",
    neighbours: ["disclaimers-and-liability-limits", "dispute-resolution-with-platform"],
    spanOf: (identity) => sectionSourceSpan(termsSourcePath, identity),
  },
  ...(["C4", "C5", "C6"] as const).map(
    (id): CitationAuthorityRow => ({
      id,
      ref: `${termsSourcePath}:552`,
      targetPath: termsSourcePath,
      identity: "disclaimers-and-liability-limits",
      fragment: "Authenticity Service Terms",
      neighbours: ["electronic-communications-and-esign", "user-vs-user-dispute-release"],
      spanOf: (identity) => sectionSourceSpan(termsSourcePath, identity),
    }),
  ),
  {
    id: "C7",
    ref: `${claimGuardSourcePath}:79-90`,
    targetPath: claimGuardSourcePath,
    identity: "readCitedText",
    fragment: "function readCitedText",
    neighbours: ["resolveEvidenceRef", "evaluateCanonicalClaimConsistency"],
    spanOf: (identity) => topLevelFunctionSourceSpan(claimGuardSourcePath, identity),
  },
  {
    id: "C8",
    ref: `${termsAcceptanceSourcePath}:12-13`,
    targetPath: termsAcceptanceSourcePath,
    identity: "resolveTermsAcceptanceStatus",
    fragment: "active Terms of Service version",
    minimalEdges: { first: "has accepted the currently", last: "active Terms of Service version" },
    neighbours: ["TermsAcceptanceStatus", "ConsentActivationAuthorityReader"],
    spanOf: termsAcceptanceSymbolSourceSpan,
  },
  {
    id: "C9",
    ref: `${termsAcceptanceSourcePath}:26-28`,
    targetPath: termsAcceptanceSourcePath,
    identity: "resolveTermsAcceptanceStatus",
    fragment: "exact active version string",
    minimalEdges: { first: "Acceptance requires an exact match", last: "never satisfies this check" },
    neighbours: ["TermsAcceptanceStatus", "ConsentActivationAuthorityReader"],
    spanOf: termsAcceptanceSymbolSourceSpan,
  },
  {
    id: "C10",
    ref: `${termsAcceptanceSourcePath}:19-30`,
    targetPath: termsAcceptanceSourcePath,
    identity: "resolveTermsAcceptanceStatus",
    fragment: "A thin fail-closed wrapper",
    minimalEdges: { first: "A thin fail-closed wrapper", last: "`accepted` is false" },
    neighbours: ["TermsAcceptanceStatus", "ConsentActivationAuthorityReader"],
    spanOf: termsAcceptanceSymbolSourceSpan,
  },
];

function validateCitationAuthority(row: CitationAuthorityRow, ref = row.ref): readonly string[] {
  const slice = readCitedSourceSlice(repoRoot, ref);
  if (slice.error !== undefined) {
    return [`${row.id} ${ref}: ${slice.error}`];
  }
  if (slice.start === undefined || slice.end === undefined || slice.text === undefined) {
    return [`${row.id} ${ref}: cited source slice was incomplete`];
  }
  const errors: string[] = [];
  const identity = row.spanOf(row.identity);
  if (slice.start < identity.start || slice.end > identity.end) {
    errors.push(
      `${row.id} ${ref}: range ${slice.start}-${slice.end} is outside independently derived identity ` +
        `${row.identity}:${identity.start}-${identity.end}`,
    );
  }
  if (!slice.text.includes(row.fragment)) {
    errors.push(`${row.id} ${ref}: cited text does not contain required fragment '${row.fragment}'`);
  }
  return errors;
}

function lineKeyedCitationParts(reference: string): readonly string[] {
  return reference
    .split(";")
    .map((part) => part.trim().replace(/\s+\([^)]*\)$/, ""))
    .flatMap((part) => {
      const match = /^(.*):([0-9][0-9,-]*)$/.exec(part);
      if (match === null) return [];
      return match[2]!.split(",").map((range) => `${match[1]}:${range}`);
    });
}

type TermsAcceptanceCitationOccurrence = Readonly<{
  sectionId: string;
  fieldPath: string;
  ref: string;
}>;

const expectedTermsAcceptanceCitationOccurrences: readonly TermsAcceptanceCitationOccurrence[] = [
  {
    sectionId: "effective-date-notice-and-acceptance",
    fieldPath: "reviewManifest.productTruthRefs[1]",
    ref: `${termsAcceptanceSourcePath}:12-13`,
  },
  {
    sectionId: "changes-notice-and-acceptance",
    fieldPath: "reviewManifest.productTruthRefs[2]",
    ref: `${termsAcceptanceSourcePath}:26-28`,
  },
  {
    sectionId: "changes-notice-and-acceptance",
    fieldPath: "reviewManifest.assumptions[0].evidenceRef",
    ref: `${termsAcceptanceSourcePath}:19-30`,
  },
];

function termsAcceptanceCitationOccurrences(
  registry: readonly PublicPolicyRegistryEntry[],
): readonly TermsAcceptanceCitationOccurrence[] {
  const terms = registry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service");
  if (terms === undefined) throw new Error("Terms of Service artifact is missing from the policy registry.");
  return terms.artifact.sections.flatMap((section) => [
    ...section.reviewManifest.productTruthRefs.flatMap((ref, index) =>
      ref.startsWith(`${termsAcceptanceSourcePath}:`)
        ? [{ sectionId: section.id, fieldPath: `reviewManifest.productTruthRefs[${index}]`, ref }]
        : [],
    ),
    ...section.reviewManifest.assumptions.flatMap(({ evidenceRef }, index) =>
      evidenceRef.startsWith(`${termsAcceptanceSourcePath}:`)
        ? [
            {
              sectionId: section.id,
              fieldPath: `reviewManifest.assumptions[${index}].evidenceRef`,
              ref: evidenceRef,
            },
          ]
        : [],
    ),
  ]);
}

function checkTermsAcceptanceOccurrencePin(registry: readonly PublicPolicyRegistryEntry[]): readonly string[] {
  const actual = termsAcceptanceCitationOccurrences(registry);
  return JSON.stringify(actual) === JSON.stringify(expectedTermsAcceptanceCitationOccurrences)
    ? []
    : [`expected ${JSON.stringify(expectedTermsAcceptanceCitationOccurrences)} actual ${JSON.stringify(actual)}`];
}

const citationFencePaths = {
  authenticityTerms: "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
  privacyPolicy: "bounded-contexts/public-presence/features/policies/domain/privacy-policy.ts",
  authenticityTest: "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.test.ts",
  staticSurfaces: "scripts/verify-static-surfaces.mjs",
} as const;

const reviewedCitationFenceDigests: Readonly<Record<string, string>> = {
  [citationFencePaths.authenticityTerms]: "5f32aff78f8bc4ce516460c3c016341c189712d40d5a36a06712df9596ac3f69",
  [citationFencePaths.privacyPolicy]: "4f9a1c91756db4caf4f0708d369bf042cb2524c61b59e3b3411faba725e4ccb0",
  [citationFencePaths.authenticityTest]: "20fce502a9f063be9d26d5c576d97c173de2658e1fd54f7896a1315f4a858b22",
  [citationFencePaths.staticSurfaces]: "397632e9b9fc15b536ac741512138d7f2b89a1f12669e3215b37d819cd6ac0cb",
};

const citationFenceOccurrences: Readonly<Record<string, readonly RegExp[]>> = {
  [citationFencePaths.privacyPolicy]: [
    /("bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+("\s*,)/g,
    /("bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+(; bounded-contexts\/auth\/features\/registration\/ui\/register-page\.tsx:60-66")/g,
  ],
  [citationFencePaths.authenticityTerms]: [
    /("bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+-\d+("\s*,)/g,
    /(productTruthRefs: \["bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+("\])/g,
    /(evidenceRef: "bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+(")/g,
  ],
  [citationFencePaths.authenticityTest]: [
    /(ref: "bounded-contexts\/public-presence\/features\/policies\/domain\/terms-of-service\.ts:)\d+(")/g,
  ],
  [citationFencePaths.staticSurfaces]: [
    /(evidence: \["bounded-contexts\/public-presence\/features\/policies\/domain\/canonical-claim-guard\.ts:)\d+-\d+("\])/g,
  ],
};

function normalizeCitationFenceSource(relativePath: string, source: string): string {
  let normalized = source.replaceAll("\r\n", "\n");
  for (const pattern of citationFenceOccurrences[relativePath] ?? []) {
    const matches = [...normalized.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(`${relativePath} authorized citation occurrence count was ${matches.length}, expected 1.`);
    }
    normalized = normalized.replace(pattern, "$1<CITATION-LINES>$2");
  }
  return normalized;
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function citationFenceSources(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.values(citationFencePaths).map((relativePath) => [
      relativePath,
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ]),
  );
}

function checkCitationFence(sources: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(reviewedCitationFenceDigests).flatMap(([relativePath, expected]) => {
    const source = sources[relativePath]!;
    let actual: string;
    try {
      actual = sha256(normalizeCitationFenceSource(relativePath, source));
    } catch {
      actual = sha256(source.replaceAll("\r\n", "\n"));
    }
    return actual === expected ? [] : [`${relativePath}: expected ${expected} actual ${actual}`];
  });
}

function mutateSourceOnce(
  sources: Readonly<Record<string, string>>,
  relativePath: string,
  before: string,
  after: string,
): Readonly<Record<string, string>> {
  const source = sources[relativePath]!;
  expect(source.split(before)).toHaveLength(2);
  return { ...sources, [relativePath]: source.replace(before, after) };
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
            disclosure.claimId === agentResponsibilityClaimId ||
            disclosure.claimId === agentAccessAndAccountSanctionClaimId,
        )
        .map((disclosure) => ({ row: `${row.policyKey}#${row.sectionId}`, claimId: disclosure.claimId })),
    );

    expect(enrolled).toEqual([
      { row: "terms-of-service#eligibility-and-accounts", claimId: agentResponsibilityClaimId },
      { row: "terms-of-service#electronic-agents-and-automated-access", claimId: agentResponsibilityClaimId },
      {
        row: "terms-of-service#electronic-agents-and-automated-access",
        claimId: agentAccessAndAccountSanctionClaimId,
      },
    ]);
    expect(new Set(enrolled.map((entry) => entry.row)).size).toBe(2);
  });
});

describe("finite authorized-agent semantic adjudication matrix", () => {
  it("records one P-A/P-B verdict and reason for every registered draftText row", () => {
    const projectedKeys = projectCanonicalClaimReviewCorpus(publicPolicyRegistry).map(
      (row) => `${row.policyKey}#${row.sectionId}`,
    );
    const matrixKeys = registeredCorpusAdjudicationMatrix.map((row) => row.row);

    expect(matrixKeys).toEqual(projectedKeys);
    expect(matrixKeys).toHaveLength(66);
    expect(new Set(matrixKeys).size).toBe(matrixKeys.length);
    for (const row of registeredCorpusAdjudicationMatrix) {
      expect(row.principalResponsibility, row.row).toBe("green");
      expect(row.agentAccessOrAccountSanction, row.row).toBe("green");
      expect(row.reason.trim().length, row.row).toBeGreaterThan(0);
    }
  });

  it("adjudicates all twelve must-stay-green rows explicitly with proposition-specific reasons", () => {
    expect(Object.keys(mustStayGreenReasons)).toEqual([
      "terms-of-service#suspension-closure-and-holds",
      "terms-of-service#marketplace-role-and-limited-payments-agent",
      "terms-of-service#listings-offers-and-contract-formation",
      "terms-of-service#disclaimers-and-liability-limits",
      "seller-agreement#enforcement-and-termination",
      "seller-agreement#seller-eligibility-and-verification",
      "seller-agreement#payouts-holds-and-reserves",
      "seller-agreement#listing-obligations",
      "seller-agreement#fulfillment-obligations",
      "seller-agreement#taxes",
      "payments-terms#processor-pass-through-and-collection-agent-role",
      "payments-terms#termination-and-residual-obligations",
    ]);
    for (const [rowKey, reason] of Object.entries(mustStayGreenReasons)) {
      const row = registeredCorpusAdjudicationMatrix.find((candidate) => candidate.row === rowKey);
      expect(row, rowKey).toMatchObject({
        principalResponsibility: "green",
        agentAccessOrAccountSanction: "green",
        reason,
      });
    }
  });

  it("records the two restoration mutants, P1/P2 paraphrases, and isolated synthetic controls with exact verdict pairs", () => {
    expect(
      semanticControlAdjudications.map(({ sectionId, principalResponsibility, agentAccessOrAccountSanction }) => ({
        sectionId,
        principalResponsibility,
        agentAccessOrAccountSanction,
      })),
    ).toEqual([
      {
        sectionId: "restored-agent-responsibility-and-sanction-sentence",
        principalResponsibility: "red",
        agentAccessOrAccountSanction: "red",
      },
      {
        sectionId: "restored-all-account-activity-clause",
        principalResponsibility: "red",
        agentAccessOrAccountSanction: "green",
      },
      {
        sectionId: "synthetic-pa-paraphrase",
        principalResponsibility: "red",
        agentAccessOrAccountSanction: "green",
      },
      {
        sectionId: "synthetic-pb-paraphrase",
        principalResponsibility: "green",
        agentAccessOrAccountSanction: "red",
      },
      {
        sectionId: "synthetic-pa-bounded-agent-order",
        principalResponsibility: "red",
        agentAccessOrAccountSanction: "green",
      },
      {
        sectionId: "synthetic-pb-agent-caused-account-lock",
        principalResponsibility: "green",
        agentAccessOrAccountSanction: "red",
      },
    ]);

    for (const control of semanticControlAdjudications) {
      for (const literal of declaredForbiddenLiterals) {
        expect(control.draftText.toLowerCase(), `${control.sectionId}/${literal.phrase}`).not.toContain(literal.phrase);
      }
      expect(
        evaluateCanonicalClaimConsistency(isolatedSyntheticCorpus(control.sectionId, control.draftText), repoRoot),
        `${control.sectionId} lexical report`,
      ).toEqual([]);
    }
  });

  it("executes both restoration mutants and both P1/P2 paraphrases inside otherwise-valid registered sections", () => {
    const agentSection = termsSectionOf("electronic-agents-and-automated-access");
    const eligibilitySection = termsSectionOf("eligibility-and-accounts");
    const conductSection = termsSectionOf("conduct-and-policy-incorporation");
    const injections = [
      {
        name: "restore the deleted agent sentence",
        sectionId: agentSection.id,
        marker: semanticControlAdjudications[0].draftText,
        draftText: `${agentSection.draftText} ${semanticControlAdjudications[0].draftText}`,
      },
      {
        name: "restore the all-activity clause",
        sectionId: eligibilitySection.id,
        marker: "and for all activity conducted through your Account",
        draftText: eligibilitySection.draftText.replace(
          "including any password, passkey, or API key.",
          "including any password, passkey, or API key, and for all activity conducted through your Account.",
        ),
      },
      ...semanticControlAdjudications.slice(2, 4).map((control) => ({
        name: control.sectionId,
        sectionId: conductSection.id,
        marker: control.draftText,
        draftText: `${conductSection.draftText} ${control.draftText}`,
      })),
    ] as const;

    for (const injection of injections) {
      const registry = withTermsOfServiceSectionOverride(injection.sectionId, { draftText: injection.draftText });
      const projected = projectCanonicalClaimReviewCorpus(registry).find(
        (row) => row.policyKey === "terms-of-service" && row.sectionId === injection.sectionId,
      );
      expect(projected?.draftText, injection.name).toContain(injection.marker);
      expect(evaluateCanonicalClaimConsistency(registry, repoRoot), `${injection.name} lexical report`).toEqual([]);
    }
  });
});

describe("authorized-agent boundary claims", () => {
  it("holds both identities unresolved with one status, one provenance, and no product truth", () => {
    for (const claimId of [agentResponsibilityClaimId, agentAccessAndAccountSanctionClaimId] as const) {
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
    expect(canonicalClaimRegistry[agentAccessAndAccountSanctionClaimId].forbiddenAssertionPhrases).toEqual(
      declaredForbiddenLiterals
        .filter((entry) => entry.claimId === agentAccessAndAccountSanctionClaimId)
        .map((e) => e.phrase),
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
    for (const claimId of [agentResponsibilityClaimId, agentAccessAndAccountSanctionClaimId] as const) {
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

describe("line-keyed policy citation authority", () => {
  it("resolves every line-keyed product-truth and assumption citation in every registered artifact", () => {
    const failures = publicPolicyRegistry.flatMap((entry) =>
      entry.artifact.sections.flatMap((section) =>
        [
          ...section.reviewManifest.productTruthRefs,
          ...section.reviewManifest.assumptions.map(({ evidenceRef }) => evidenceRef),
        ]
          .flatMap(lineKeyedCitationParts)
          .flatMap((ref) => {
            const slice = readCitedSourceSlice(repoRoot, ref);
            return slice.error === undefined
              ? []
              : [`${entry.artifact.metadata.policyKey}#${section.id} ${ref}: ${slice.error}`];
          }),
      ),
    );

    expect(failures).toEqual([]);
  });

  it("validates C1-C10 against independently derived identities, exact fragments, and minimal class-I edges", () => {
    expect(citationAuthorityRows).toHaveLength(10);
    for (const row of citationAuthorityRows) {
      expect(validateCitationAuthority(row), row.id).toEqual([]);
      if (row.minimalEdges !== undefined) {
        const identity = row.spanOf(row.identity);
        expect(identity, `${row.id} identity`).toEqual({ start: 11, end: 41 });
        const slice = readCitedSourceSlice(repoRoot, row.ref);
        if (slice.error !== undefined) {
          throw new Error(`${row.id}: ${slice.error}`);
        }
        if (slice.text === undefined) {
          throw new Error(`${row.id}: cited source slice was incomplete`);
        }
        const lines = slice.text.split("\n");
        expect(lines[0], `${row.id} first line`).toContain(row.minimalEdges.first);
        expect(lines.at(-1), `${row.id} last line`).toContain(row.minimalEdges.last);
        expect(
          sourceLines(row.targetPath).filter((line) => line.includes(row.fragment)),
          `${row.id} fragment`,
        ).toHaveLength(1);
      }
    }
  });

  it("negative control: all twenty neighbouring-identity citations fail naming the exact ref and condition", () => {
    const failures = citationAuthorityRows.flatMap((row) =>
      row.neighbours.map((neighbour) => {
        const span = row.spanOf(neighbour);
        const ref = `${row.targetPath}:${span.start}-${span.end}`;
        return { row, neighbour, ref, errors: validateCitationAuthority(row, ref) };
      }),
    );

    expect(failures).toHaveLength(20);
    for (const failure of failures) {
      expect(failure.errors.length, `${failure.row.id}/${failure.neighbour}`).toBeGreaterThan(0);
      expect(failure.errors.join("\n")).toContain(`${failure.row.id} ${failure.ref}`);
      expect(failure.errors.join("\n")).toMatch(
        /outside independently derived identity|does not contain required fragment/,
      );
    }
  });

  it("negative control: a bare Support Request token falsely accepts C3's following neighbour", () => {
    const row = citationAuthorityRows.find(({ id }) => id === "C3")!;
    const after = row.spanOf(row.neighbours[1]);
    const ref = `${row.targetPath}:${after.start}-${after.end}`;
    const slice = readCitedSourceSlice(repoRoot, ref);

    expect(slice.error).toBeUndefined();
    expect(slice.text).toContain("Support Request");
    expect(slice.text).not.toContain(row.fragment);
    expect(validateCitationAuthority(row, ref).join("\n")).toContain("does not contain required fragment");
  });

  it("negative control: restoring each C8-C10 citation to stale 15-48 fails the corpus resolver by exact ref", () => {
    for (const row of citationAuthorityRows.filter(({ id }) => ["C8", "C9", "C10"].includes(id))) {
      const staleRef = `${termsAcceptanceSourcePath}:15-48`;
      const errors = validateCitationAuthority(row, staleRef);
      expect(errors.length, row.id).toBeGreaterThan(0);
      expect(errors.join("\n"), row.id).toContain(`${row.id} ${staleRef}`);
    }
  });

  it("pins exactly C8-C10 by Terms section and field path without a history-derived digest", () => {
    expect(termsAcceptanceCitationOccurrences(publicPolicyRegistry)).toEqual(
      expectedTermsAcceptanceCitationOccurrences,
    );
    expect(checkTermsAcceptanceOccurrencePin(publicPolicyRegistry)).toEqual([]);
  });

  it("negative control: every class-I occurrence mutant fails the structural Terms-source pin", () => {
    const effective = termsSectionOf("effective-date-notice-and-acceptance");
    const changes = termsSectionOf("changes-notice-and-acceptance");
    const conduct = termsSectionOf("conduct-and-policy-incorporation");
    const mutants = [
      {
        name: "add a fourth occurrence",
        registry: withTermsOfServiceSectionOverride(conduct.id, {
          reviewManifest: {
            ...conduct.reviewManifest,
            productTruthRefs: [...conduct.reviewManifest.productTruthRefs, `${termsAcceptanceSourcePath}:12-13`],
          },
        }),
      },
      {
        name: "delete C8",
        registry: withTermsOfServiceSectionOverride(effective.id, {
          reviewManifest: {
            ...effective.reviewManifest,
            productTruthRefs: effective.reviewManifest.productTruthRefs.filter(
              (ref) => ref !== `${termsAcceptanceSourcePath}:12-13`,
            ),
          },
        }),
      },
      {
        name: "repoint C9 to a different target path",
        registry: withTermsOfServiceSectionOverride(changes.id, {
          reviewManifest: {
            ...changes.reviewManifest,
            productTruthRefs: changes.reviewManifest.productTruthRefs.map((ref) =>
              ref === `${termsAcceptanceSourcePath}:26-28`
                ? "bounded-contexts/identity/features/consents/api/terms-route.ts:31-90"
                : ref,
            ),
          },
        }),
      },
      {
        name: "move C8 to a resolving range outside its function identity",
        registry: withTermsOfServiceSectionOverride(effective.id, {
          reviewManifest: {
            ...effective.reviewManifest,
            productTruthRefs: effective.reviewManifest.productTruthRefs.map((ref) =>
              ref === `${termsAcceptanceSourcePath}:12-13` ? `${termsAcceptanceSourcePath}:6-7` : ref,
            ),
          },
        }),
      },
    ] as const;

    for (const mutant of mutants) {
      expect(checkTermsAcceptanceOccurrencePin(mutant.registry), mutant.name).toHaveLength(1);
    }
  });
});

describe("occurrence-scoped citation byte fence", () => {
  it("normalizes exactly C1-C7 and matches all four reviewed frozen-base digests", () => {
    expect(Object.values(citationFenceOccurrences).flat()).toHaveLength(7);
    expect(checkCitationFence(citationFenceSources())).toEqual([]);
  });

  it("accepts line-number-only shifts for exactly the seven authorized occurrences", () => {
    let shifted = citationFenceSources();
    const shifts = [
      [citationFencePaths.privacyPolicy, `${termsSourcePath}:370\"`, `${termsSourcePath}:9370\"`],
      [
        citationFencePaths.privacyPolicy,
        `${termsSourcePath}:370; bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66`,
        `${termsSourcePath}:9370; bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66`,
      ],
      [citationFencePaths.authenticityTerms, `${termsSourcePath}:576-602`, `${termsSourcePath}:9576-9602`],
      [
        citationFencePaths.authenticityTerms,
        `productTruthRefs: [\"${termsSourcePath}:552\"]`,
        `productTruthRefs: [\"${termsSourcePath}:9552\"]`,
      ],
      [
        citationFencePaths.authenticityTerms,
        `evidenceRef: \"${termsSourcePath}:552\"`,
        `evidenceRef: \"${termsSourcePath}:9552\"`,
      ],
      [citationFencePaths.authenticityTest, `ref: \"${termsSourcePath}:552\"`, `ref: \"${termsSourcePath}:9552\"`],
      [citationFencePaths.staticSurfaces, `${claimGuardSourcePath}:79-90`, `${claimGuardSourcePath}:9079-9090`],
    ] as const;
    for (const [relativePath, before, after] of shifts) {
      shifted = mutateSourceOnce(shifted, relativePath, before, after);
    }
    expect(checkCitationFence(shifted)).toEqual([]);
  });

  it("negative control: every non-line-number mutant fails with only file and expected/actual SHA-256", () => {
    const base = citationFenceSources();
    const mutants = [
      {
        name: "r7 F1 unrelated README reproduction",
        file: citationFencePaths.authenticityTerms,
        before: "bounded-contexts/authenticity/README.md:5-8",
        after: "bounded-contexts/authenticity/README.md:39-42",
      },
      {
        name: "privacy one-word prose edit",
        file: citationFencePaths.privacyPolicy,
        before: 'title: "Privacy policy"',
        after: 'title: "Privacy statement"',
      },
      {
        name: "authenticity one-word prose edit",
        file: citationFencePaths.authenticityTerms,
        before: 'title: "Buyer opt-in and fee"',
        after: 'title: "Buyer enrollment and fee"',
      },
      {
        name: "authenticity test one-word prose edit",
        file: citationFencePaths.authenticityTest,
        before: 'describe("authenticity service terms artifact: product-truth provenance matrix"',
        after: 'describe("authenticity service terms artifact: product-truth evidence matrix"',
      },
      {
        name: "static one-word prose edit",
        file: citationFencePaths.staticSurfaces,
        before: "This is the auditable link -> input-surface contract",
        after: "This is the inspectable link -> input-surface contract",
      },
      {
        name: "cited path changed with digits intact",
        file: citationFencePaths.authenticityTerms,
        before: `${termsSourcePath}:576-602`,
        after: "bounded-contexts/public-presence/features/policies/domain/seller-agreement.ts:576-602",
      },
      {
        name: "citation added",
        file: citationFencePaths.authenticityTerms,
        before: `productTruthRefs: [\"${termsSourcePath}:552\"]`,
        after: `productTruthRefs: [\"${termsSourcePath}:552\", ` + '\"bounded-contexts/authenticity/README.md:5-8\"]',
      },
      {
        name: "citation deleted",
        file: citationFencePaths.authenticityTerms,
        before: `productTruthRefs: [\"${termsSourcePath}:552\"]`,
        after: "productTruthRefs: []",
      },
      {
        name: "citation pair reordered",
        file: citationFencePaths.authenticityTerms,
        before:
          '"bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303,431-436",\n' +
          `          \"${termsSourcePath}:576-602\"`,
        after:
          `\"${termsSourcePath}:576-602\",\n` +
          '          "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303,431-436"',
      },
      {
        name: "reviewStatus edited",
        file: citationFencePaths.authenticityTerms,
        before: 'id: "service-nature",\n      title: "Nature of the Authenticity Check service",',
        after: 'id: "service-nature",\n      title: "Nature of the Authenticity Check service (reviewed)",',
      },
      {
        name: "scopeNote edited",
        file: citationFencePaths.authenticityTerms,
        before: "optional inspection/verification service distinct from a warranty",
        after: "elective inspection/verification service distinct from a warranty",
      },
      {
        name: "openQuestions edited",
        file: citationFencePaths.privacyPolicy,
        before: "Launch jurisdiction scope is undecided",
        after: "Launch region scope is undecided",
      },
      {
        name: "provenance key edited",
        file: citationFencePaths.privacyPolicy,
        before:
          'productTruthRefs: ["bounded-contexts/public-presence/features/policies/domain/policy-registry.ts:25-33"]',
        after:
          'productEvidenceRefs: ["bounded-contexts/public-presence/features/policies/domain/policy-registry.ts:25-33"]',
      },
      {
        name: "static classification edited",
        file: citationFencePaths.staticSurfaces,
        before: '"format:check": {\n    classification: MAY_NARROW,',
        after: '"format:check": {\n    classification: ALWAYS_RUN,',
      },
      {
        name: "static rule edited",
        file: citationFencePaths.staticSurfaces,
        before: "any changed path; format:check performs its own supported-file filtering",
        after: "any changed path; format:check performs its own eligible-file filtering",
      },
      {
        name: "static include edited",
        file: citationFencePaths.staticSurfaces,
        before: 'include: [{ kind: "any" }],',
        after: 'include: [{ kind: "prefix", value: "bounded-contexts" }],',
      },
      {
        name: "static comment edited",
        file: citationFencePaths.staticSurfaces,
        before: "ALWAYS_RUN links deliberately have no include rules",
        after: "ALWAYS_RUN links intentionally have no include rules",
      },
    ] as const;

    for (const mutant of mutants) {
      const errors = checkCitationFence(mutateSourceOnce(base, mutant.file, mutant.before, mutant.after));
      expect(errors, mutant.name).toHaveLength(1);
      expect(errors[0], mutant.name).toMatch(
        new RegExp(`^${mutant.file.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}: expected [^ ]+ actual [a-f0-9]{64}$`),
      );
    }
  });
});
