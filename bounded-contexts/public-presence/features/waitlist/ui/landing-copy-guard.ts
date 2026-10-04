/**
 * Durable enforcement: internal vocabulary re-accumulates in landing copy
 * after plain-language passes unless something keeps checking. This scans
 * the real locale entries for the landing namespaces by key prefix
 * (shape-based), not a filename or fixture stand-in.
 */

// Exactly the "Landing-visible namespaces" this pass charters. info.*,
// help.*, admin.*, api.*, developers.*, routes.*, and appRoot.* are
// consumer-facing too but are owned by other passes; scanning them here
// would fail the guard on content this pass is not authorized to change.
export const LANDING_COPY_NAMESPACE_PREFIXES = [
  "publicPresence.home.",
  "publicPresence.promoBar.",
  "publicPresence.nav.",
  "publicPresence.footer.",
  "publicPresence.waitlist.",
  "publicPresence.faq.",
  "publicPresence.compare.",
  "publicPresence.preview.",
  "publicPresence.welcome.",
] as const;

export type BannedTerm = Readonly<{ term: string; pattern: RegExp }>;

// Seed denylist, plus terms found leaking into landing copy during the
// sweep. Extend this list when a genuine internal term is found; do not add
// hedge words or style preferences here — this guard is vocabulary-only.
export const BANNED_LANDING_TERMS: readonly BannedTerm[] = [
  { term: "allowance", pattern: /\ballowances?\b/i },
  { term: "overflow", pattern: /\boverflow\b/i },
  { term: "projection(s)", pattern: /\bprojections?\b/i },
  { term: "read model", pattern: /\bread model\b/i },
  { term: "capability", pattern: /\bcapabilit(?:y|ies)\b/i },
  { term: "aggregate", pattern: /\baggregate\b/i },
  { term: "bounded context", pattern: /\bbounded context\b/i },
  { term: "workbench", pattern: /\bworkbench\b/i },
  { term: "account workspace", pattern: /\baccount workspace\b/i },
  { term: "marketplace intent", pattern: /\bmarketplace intent\b/i },
  // Found during the sweep.
  { term: "solo operator", pattern: /\bsolo operator\b/i },
  { term: "catalog-backed", pattern: /\bcatalog-backed\b/i },
];

export type LandingCopyViolation = Readonly<{ key: string; term: string; value: string }>;

export function landingCopyEntries(
  translations: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(translations).filter(([key]) =>
    LANDING_COPY_NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}

export function findLandingCopyViolations(
  translations: Readonly<Record<string, string>>,
  bannedTerms: readonly BannedTerm[] = BANNED_LANDING_TERMS,
): LandingCopyViolation[] {
  const violations: LandingCopyViolation[] = [];
  for (const [key, value] of landingCopyEntries(translations)) {
    for (const { term, pattern } of bannedTerms) {
      if (pattern.test(value)) {
        violations.push({ key, term, value });
      }
    }
  }
  return violations;
}

// Seller-fee claim accuracy (#8606). The published sales-fee schedule and the
// Founders offer terms are authoritative: 0% applies only to listings created
// inside a founders account's 60-day window, and every order still funds the
// Order Protection contribution, so no seller keeps 100% of a sale. Landing
// copy drifted to "0% beta seller fees" / "Keep 100% of the sale" once; this
// keeps the contradiction from returning. Vocabulary stays in the list above.
export type SellerFeeClaimRule = Readonly<{ rule: string; violates: (value: string) => boolean }>;

// A bare "0%" (not 10%, 100%, 0.5%, or $0.00) is a zero-fee claim.
const zeroFeeClaimPattern = /(?<![\d.])0%/;
// Every zero-fee claim must name the founder 60-day window in the same entry.
const founderWindowPattern = /\b60[- ]days?\b/i;
// Retention claims the Order Protection contribution makes false.
const fullRetentionPattern = /\b100%|\bkeep (?:all|every (?:cent|dollar|penny)|the (?:whole|full|entire) sale)\b/i;

export const SELLER_FEE_CLAIM_RULES: readonly SellerFeeClaimRule[] = [
  {
    rule: "0% claim must name the founder 60-day window",
    violates: (value) => zeroFeeClaimPattern.test(value) && !founderWindowPattern.test(value),
  },
  {
    rule: "no 100% / keep-the-whole-sale retention claim",
    violates: (value) => fullRetentionPattern.test(value),
  },
];

export type SellerFeeClaimViolation = Readonly<{ key: string; rule: string; value: string }>;

export function findSellerFeeClaimViolations(
  translations: Readonly<Record<string, string>>,
  rules: readonly SellerFeeClaimRule[] = SELLER_FEE_CLAIM_RULES,
): SellerFeeClaimViolation[] {
  const violations: SellerFeeClaimViolation[] = [];
  for (const [key, value] of landingCopyEntries(translations)) {
    for (const { rule, violates } of rules) {
      if (violates(value)) {
        violations.push({ key, rule, value });
      }
    }
  }
  return violations;
}
