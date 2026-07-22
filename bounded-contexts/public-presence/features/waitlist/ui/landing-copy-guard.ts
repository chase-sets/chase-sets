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
