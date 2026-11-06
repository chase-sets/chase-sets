import { createHash } from "node:crypto";

export type SocialLoginLinkState = "active" | "revocation-requested" | "revoked";

export function socialLoginLinkKey(providerName: string, providerSubject: string): string {
  return createHash("sha256").update(`${providerName}:${providerSubject.trim()}`, "utf8").digest("hex");
}

export function isSocialLoginInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return false;
  const date = Date.parse(value);
  return (
    Number.isFinite(date) &&
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60 &&
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

export class SocialLoginUnlinkRefusal extends Error {
  constructor(
    readonly code:
      | "social-login-link-not-active"
      | "recent-authentication-required"
      | "authentication-method-not-different"
      | "last-authentication-method",
  ) {
    super(code);
  }
}
