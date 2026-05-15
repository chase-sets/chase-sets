import type { JsonValue } from "@chase-sets/primitives/json";

export type AccountType = "personal" | "business" | "enterprise";
export type AccountStatus = "active" | "suspended" | "closed";
export type UserStatus = "active" | "suspended";
export type MembershipStatus = "active" | "revoked";
export type InvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired";
export type SessionStatus = "active" | "revoked" | "expired";
export type ApiKeyStatus = "active" | "revoked";
export type AuthMethodKey = "password" | "magic-link" | "passkey" | "sms-code" | "social-login";
export type SocialLoginProviderKey = "google" | "facebook";
export type ContactMethodType = "email" | "phone";
export type ContactMethod = Readonly<{
  contactMethodId: string;
  type: ContactMethodType;
  value: string;
  verifiedAt: string | null;
}>;
export type ConsentSubjectType = "user" | "account";
export type RoleKey =
  | "platform-admin"
  | "owner"
  | "manager"
  | "fulfillment"
  | "viewer";
export type PermissionKey =
  | "accounts.manage"
  | "accounts.view"
  | "catalog.manage"
  | "catalog.view"
  | "commercial-terms.manage"
  | "commercial-terms.view"
  | "fulfillment.manage"
  | "fulfillment.view"
  | "memberships.manage"
  | "memberships.view"
  | "inventory.manage"
  | "inventory.view"
  | "listings.manage"
  | "listings.view"
  | "offers.manage"
  | "offers.view"
  | "orders.manage"
  | "orders.view"
  | "payouts.manage"
  | "payouts.reconcile"
  | "payouts.request"
  | "payouts.setup"
  | "payouts.view"
  | "platform-feedback.manage"
  | "platform-feedback.view"
  | "public-presence.manage"
  | "public-presence.view"
  | "reputation.manage"
  | "reputation.view"
  | "support.manage"
  | "support.view"
  | "security.manage";
export type EmptyEventData = Readonly<Record<string, never>>;
export type IdentityValue = JsonValue;

export const EMPTY_EVENT_DATA: EmptyEventData = {};

export class IdentityDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdentityDomainError";
  }
}

export function assert(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) {
    throw new IdentityDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new IdentityDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withoutSeparators = trimmed.replace(/[()\-\s.]/g, "");
  const digits = withoutSeparators.replace(/\D/g, "");
  if (withoutSeparators.startsWith("+")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return digits ? `+${digits}` : trimmed;
}

export function normalizeLabel(value: string): string {
  return value.trim();
}

export function toSortedUniqueList<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function ensureIsoTimestamp(value: string): string {
  assert(!Number.isNaN(Date.parse(value)), "Expected an ISO UTC timestamp.");
  return value;
}
