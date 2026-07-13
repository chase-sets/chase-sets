// Flags business-policy-shaped literals reintroduced outside the shared
// platform-policy machinery (milestone m110's runtime-configurable-values
// program). Business values were once embedded directly in SQL strings
// (`INTERVAL '2 days'`, `amount >= 250`, duplicated across query functions)
// and compiled TS constants scattered across contexts. The fix landed shared
// machinery (`infrastructure/platform-policy/define-policy.ts`) and migrated
// every money/deadline/rate-limit/gate finding onto it; this guard is the
// ratchet that keeps the next slice from reintroducing the same pattern. See
// docs/architecture/platform-policy-conventions.md for the tier decision
// rules and scripts/check-structure/business-literal-allowlist.mjs for
// reviewed exceptions.
//
// Deliberately cheap and low-false-positive: name-pattern and SQL-literal
// regex checks only, no semantic analysis. Three checks, each narrowly
// scoped to avoid the two known false-positive clusters found while building
// this guard:
//
//   1. INTERVAL literals with day-scale-or-larger units (day/week/month/
//      year, plus hour) inside bounded-context string literals. Minute and
//      second units are excluded by design: those are the established
//      operational stale/retry-poll window vocabulary (a documented
//      "deliberately not config" decision), not business policy, and
//      flagging them would drown the guard in the codebase's dozens of
//      15-minute reconciliation-claim windows.
//   2. Money-comparison literals (`amount_cents >= 25000`-shaped) inside
//      bounded-context string literals, gated on a curated set of
//      money-shaped snake_case identifier suffixes so ordinary TS numeric
//      comparisons (`totalCents <= 0`, `price > 0`) never match -- those are
//      camelCase runtime guards, not SQL column literals.
//   3. Newly exported `*_THRESHOLD`/`*_LIMIT`/`*_FEE`/`*_HOURS`-style
//      constants in feature `domain/`/`api/` files, excluding the policy's
//      own owning file (anything that calls `definePolicy(`) since a
//      policy's schema bounds are the single source, not a duplicate.
//
// Data-retention sweep windows (`support/runtime-support/retention-policy.ts`
// and `platform-runtime/retention-sweep.ts`) are a separate, already-guarded
// convention (scripts/check-structure/retention-sweep-coverage.mjs) and are
// excluded by filename here rather than re-litigated by this guard.

import { businessLiteralAllowlist } from "./business-literal-allowlist.mjs";

export const businessLiteralIntervalUnits = [
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "hour",
  "hours",
];

const intervalLiteralPattern = new RegExp(
  `\\bINTERVAL\\s+'(\\d+)\\s+(${businessLiteralIntervalUnits.join("|")})'`,
  "gi",
);

const moneyComparisonPattern = /\b([a-z][a-z0-9_]*)\s*(>=|<=|>|<)\s*(\d{2,})\b/g;
const moneyIdentifierSuffixPattern = /(?:_cents|_amount|_price|_fee|_bps)$/i;
const moneyIdentifierBareNamePattern = /^(?:amount|price|total|fee)$/i;

const businessConstantSuffixes = ["_THRESHOLD", "_LIMIT", "_FEE", "_HOURS"];
const businessConstantNamePattern = new RegExp(
  `\\bexport\\s+const\\s+([A-Z][A-Z0-9_]*(?:${businessConstantSuffixes.join("|")}))\\b`,
  "g",
);

const stringLiteralPattern = /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"/g;

const businessLiteralSqlGuardRoot = "bounded-contexts/";
const retiredOperationalFileBasenames = new Set(["retention-policy.ts", "retention-sweep.ts"]);
const businessConstantGuardPathPattern = /^bounded-contexts\/[^/]+\/features\/[^/]+\/(?:domain|api)\//;

function isTestFile(relativeFile) {
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativeFile) || relativeFile.includes("/tests/");
}

export function isBusinessLiteralGuardedFile(relativeFile, extension) {
  if (extension !== ".ts") {
    return false;
  }
  if (!relativeFile.startsWith(businessLiteralSqlGuardRoot)) {
    return false;
  }
  if (isTestFile(relativeFile)) {
    return false;
  }

  return true;
}

function isBusinessLiteralSqlGuardedFile(relativeFile) {
  const basename = relativeFile.split("/").pop();
  return !retiredOperationalFileBasenames.has(basename);
}

function isBusinessConstantNameGuardedFile(relativeFile) {
  return businessConstantGuardPathPattern.test(relativeFile);
}

function isMoneyComparisonIdentifier(name) {
  return moneyIdentifierSuffixPattern.test(name) || moneyIdentifierBareNamePattern.test(name);
}

function extractStringLiteralSegments(content) {
  return [...content.matchAll(stringLiteralPattern)].map((match) => match[0]);
}

function isAllowlisted({ relativeFile, snippet, allowlist }) {
  return allowlist.some((entry) => {
    if (entry.file !== relativeFile) {
      return false;
    }
    return !entry.pattern || snippet.includes(entry.pattern);
  });
}

// `allowlist` defaults to the real, reviewed `businessLiteralAllowlist` for
// every production caller; tests may inject a synthetic list to exercise the
// suppression mechanism itself without coupling to which files currently
// happen to hold a reviewed exception (that set ratchets toward zero).
export function findIntervalLiteralViolations({ relativeFile, content, allowlist = businessLiteralAllowlist }) {
  if (!isBusinessLiteralSqlGuardedFile(relativeFile)) {
    return [];
  }

  const violations = [];
  for (const segment of extractStringLiteralSegments(content)) {
    intervalLiteralPattern.lastIndex = 0;
    for (const match of segment.matchAll(intervalLiteralPattern)) {
      const snippet = match[0];
      if (isAllowlisted({ relativeFile, snippet, allowlist })) {
        continue;
      }
      violations.push({
        kind: "interval-literal",
        snippet,
        message: `hardcoded SQL interval literal ${snippet} duplicates a business-policy-shaped window outside platform-policy; single-source it through infrastructure/platform-policy/define-policy.ts (see docs/architecture/platform-policy-conventions.md) or add a reviewed entry to scripts/check-structure/business-literal-allowlist.mjs.`,
      });
    }
  }

  return violations;
}

export function findMoneyComparisonViolations({ relativeFile, content, allowlist = businessLiteralAllowlist }) {
  if (!isBusinessLiteralSqlGuardedFile(relativeFile)) {
    return [];
  }

  const violations = [];
  for (const segment of extractStringLiteralSegments(content)) {
    moneyComparisonPattern.lastIndex = 0;
    for (const match of segment.matchAll(moneyComparisonPattern)) {
      const [snippet, identifier] = match;
      if (!isMoneyComparisonIdentifier(identifier)) {
        continue;
      }
      if (isAllowlisted({ relativeFile, snippet, allowlist })) {
        continue;
      }
      violations.push({
        kind: "money-comparison-literal",
        snippet,
        message: `hardcoded money-comparison literal '${snippet}' duplicates a business-policy-shaped threshold outside platform-policy; single-source it through infrastructure/platform-policy/define-policy.ts (see docs/architecture/platform-policy-conventions.md) or add a reviewed entry to scripts/check-structure/business-literal-allowlist.mjs.`,
      });
    }
  }

  return violations;
}

export function findBusinessConstantNameViolations({ relativeFile, content, allowlist = businessLiteralAllowlist }) {
  if (!isBusinessConstantNameGuardedFile(relativeFile)) {
    return [];
  }

  // The policy's own owning file declares its schema's bounds/defaults as
  // the single source of truth (definePolicy's `defaultValue`, plus any
  // revise-time bounds validation) -- that is not a duplicate.
  if (/\bdefinePolicy\s*\(/.test(content)) {
    return [];
  }

  const violations = [];
  businessConstantNamePattern.lastIndex = 0;
  for (const match of content.matchAll(businessConstantNamePattern)) {
    const [snippet, name] = match;
    if (isAllowlisted({ relativeFile, snippet: name, allowlist })) {
      continue;
    }
    violations.push({
      kind: "business-constant-name",
      snippet: name,
      message: `exported constant ${name} is business-policy-shaped (*_THRESHOLD/*_LIMIT/*_FEE/*_HOURS); define it through infrastructure/platform-policy/define-policy.ts (see docs/architecture/platform-policy-conventions.md) or add a reviewed entry to scripts/check-structure/business-literal-allowlist.mjs if it is not a business value (protocol constant, page size, security lifetime).`,
    });
  }

  return violations;
}

export function findBusinessLiteralGuardViolations({ relativeFile, content, allowlist = businessLiteralAllowlist }) {
  return [
    ...findIntervalLiteralViolations({ relativeFile, content, allowlist }),
    ...findMoneyComparisonViolations({ relativeFile, content, allowlist }),
    ...findBusinessConstantNameViolations({ relativeFile, content, allowlist }),
  ];
}
