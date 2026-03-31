import type { JsonValue } from "@chase-sets/primitives/json";

export type AccountType = "personal" | "business";
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
export type AuthMethodKey = "password" | "magic-link" | "passkey";
export type ContactMethodType = "email" | "phone";
export type ContactMethod = Readonly<{
  contactMethodId: string;
  type: ContactMethodType;
  value: string;
  verifiedAt: string | null;
}>;
export type ConsentSubjectType = "user" | "account";
export type RoleKey = "owner" | "manager" | "fulfillment" | "viewer";
export type PermissionKey =
  | "accounts.manage"
  | "accounts.view"
  | "catalog.manage"
  | "catalog.view"
  | "memberships.manage"
  | "memberships.view"
  | "inventory.manage"
  | "inventory.view"
  | "listings.manage"
  | "listings.view"
  | "orders.manage"
  | "orders.view"
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
