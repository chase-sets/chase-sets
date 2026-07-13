/**
 * Last-line-of-defense redaction for the admin shell's root ErrorBoundary technical detail.
 *
 * Loaders and actions across every admin section can throw an arbitrary `Error`. Its `message`
 * is the only diagnostic surfaced to the signed-in admin operator, but nothing upstream
 * guarantees it is free of secrets, session material, or raw domain ids. This mirrors the
 * redaction categories the admin-workflows QA evidence linter enforces on QA artifacts
 * (scripts/admin-workflows-qa-evidence.mjs) so the same categories of private data never render
 * in the deployed admin UI either, even when a thrown error message accidentally carries one.
 */

type RedactionRule = Readonly<{
  category: string;
  pattern: RegExp;
  replacement: string;
}>;

export const ADMIN_ERROR_DETAIL_REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  {
    category: "email",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replacement: "[redacted-email]",
  },
  {
    category: "cookie_or_session",
    pattern: /\b(?:cookie|set-cookie)\s*[:=]\s*\S+/gi,
    replacement: "[redacted-cookie]",
  },
  {
    category: "cookie_or_session",
    pattern: /\bchase_sets_[A-Za-z0-9_-]+\s*=\s*[^;\s]+/gi,
    replacement: "[redacted-cookie]",
  },
  {
    category: "cookie_or_session",
    pattern: /\b(?:session|csrf|xsrf)[-_]?(?:token|cookie|id)?\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}/gi,
    replacement: "[redacted-session]",
  },
  {
    category: "authorization_token",
    pattern: /\bauthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/-]{8,}/gi,
    replacement: "[redacted-token]",
  },
  {
    category: "authorization_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
    replacement: "[redacted-token]",
  },
  {
    category: "authorization_token",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[redacted-token]",
  },
  {
    category: "raw_recovery_token",
    pattern: /\b(?:afterWrite|postWriteToken|readAfterWrite|read_after_write)=\S+/gi,
    replacement: "[redacted-token]",
  },
  {
    category: "raw_recovery_token",
    pattern: /\bChase-Sets-Read-After-Write\s*[:=]\s*\S+/gi,
    replacement: "[redacted-token]",
  },
  {
    category: "raw_domain_id",
    pattern:
      /\b(?:account|acct|user|usr|membership|member|mbr|invitation|invite|api_key|apikey|session|sess|checkout|chk|payment|pay|payout|order|ord|sale|shipment|ship|label|inventory|inv|listing|lst|offer|ofr|cart|crt|event|evt|job|bulk|provider|profile)_[0-9A-Za-z][0-9A-Za-z_:-]{3,}\b/g,
    replacement: "[redacted-id]",
  },
  {
    category: "full_url",
    pattern: /\bhttps?:\/\/[^\s<>)"']+/gi,
    replacement: "[redacted-url]",
  },
]);

/**
 * Applies every redaction rule to `detail` and returns support-safe text. Idempotent: redacting
 * already-redacted text is a no-op.
 */
export function redactAdminErrorDetail(detail: string): string {
  return ADMIN_ERROR_DETAIL_REDACTION_RULES.reduce(
    (text, rule) => text.replace(rule.pattern, rule.replacement),
    detail,
  );
}
