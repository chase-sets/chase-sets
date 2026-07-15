// Support-safe guarantees for completion evidence. The report contract is
// designed to carry only counts and Catalog-owned identifiers, but the verifier
// still asserts before it emits so a future contract change or an operator-
// supplied note can never leak secrets, raw payloads, full provider URLs,
// account identifiers, or unredacted provider usage responses.

export type SupportSafetyViolation = Readonly<{
  path: string;
  rule: string;
}>;

type ForbiddenRule = Readonly<{
  rule: string;
  appliesToKey?: RegExp;
  matches: RegExp;
}>;

// Keys that must never appear because they name account/actor identity or raw
// provider material regardless of value.
const forbiddenKeyRules: readonly ForbiddenRule[] = [
  { rule: "account-or-actor-identity", matches: /^(forAccountId|accountId|performedByUserId|actorId|userId)$/i },
  { rule: "raw-provider-payload", matches: /^(sourcePayload|source_payload|normalized|rawResponse|responseBody)$/i },
  { rule: "provider-source-url", matches: /^(sourceUrl|source_url|requestUrl|href)$/i },
  {
    rule: "credential-material",
    matches: /^(authorization|apiKey|api_key|secret|password|accessToken|token|bearer)$/i,
  },
];

// Value shapes that must never appear anywhere, whatever the key.
const forbiddenValueRules: readonly ForbiddenRule[] = [
  { rule: "full-url", matches: /https?:\/\/\S+/i },
  { rule: "bearer-token", matches: /\bbearer\s+\S+/i },
  { rule: "stripe-style-secret", matches: /\b(sk|rk|pk)_(live|test)_[a-z0-9]+/i },
  { rule: "account-id-token", matches: /\bacct_[a-z0-9]{6,}/i },
];

// Scan any support-facing value for support-safety violations. Returns every
// violation with a dotted path; never includes the offending value itself.
export function findSupportSafetyViolations(value: unknown): readonly SupportSafetyViolation[] {
  const violations: SupportSafetyViolation[] = [];
  walk(value, "(root)", violations);
  return violations;
}

export class SupportSafetyError extends Error {
  readonly code = "completion_report_not_support_safe";
  readonly violations: readonly SupportSafetyViolation[];
  constructor(violations: readonly SupportSafetyViolation[]) {
    super(
      `Completion evidence is not support-safe: ${violations
        .map((violation) => `${violation.path} [${violation.rule}]`)
        .join(", ")}`,
    );
    this.name = "SupportSafetyError";
    this.violations = violations;
  }
}

// Throw unless the value is support-safe. Called by the verifier before it
// writes JSON or prints a summary.
export function assertSupportSafe(value: unknown): void {
  const violations = findSupportSafetyViolations(value);
  if (violations.length > 0) {
    throw new SupportSafetyError(violations);
  }
}

function walk(value: unknown, path: string, violations: SupportSafetyViolation[]): void {
  if (typeof value === "string") {
    for (const rule of forbiddenValueRules) {
      if (rule.matches.test(value)) {
        violations.push({ path, rule: rule.rule });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, violations));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path === "(root)" ? key : `${path}.${key}`;
      for (const rule of forbiddenKeyRules) {
        if (rule.matches.test(key)) {
          violations.push({ path: childPath, rule: rule.rule });
        }
      }
      walk(entry, childPath, violations);
    }
  }
}
