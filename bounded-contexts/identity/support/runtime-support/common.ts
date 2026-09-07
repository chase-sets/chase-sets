import type { JsonValue } from "@chase-sets/primitives/json";
import type { SocialLoginProviderKey } from "@chase-sets/auth-context";

export type AccountType = "personal" | "business" | "enterprise";
export type AccountStatus = "active" | "suspended" | "closed";
export type UserStatus = "active" | "suspended";
export type MembershipStatus = "active" | "revoked";
export type InvitationStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";
export type SessionStatus = "active" | "revoked" | "expired";
export type ApiKeyStatus = "active" | "revoked";
export type AuthMethodKey = "password" | "magic-link" | "passkey" | "sms-code" | "social-login";
export type { SocialLoginProviderKey };
export type ContactMethodType = "email" | "phone";
export type ContactMethod = Readonly<{
  contactMethodId: string;
  type: ContactMethodType;
  value: string;
  verifiedAt: string | null;
}>;
export type ConsentSubjectType = "user" | "account";
export const ROLE_KEYS = ["platform-admin", "owner", "manager", "fulfillment", "viewer"] as const;
export const PLATFORM_ADMIN_ROLE_KEY = "platform-admin" satisfies RoleKey;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type GrantableRoleKey = Exclude<RoleKey, typeof PLATFORM_ADMIN_ROLE_KEY>;
export const GRANTABLE_ROLE_KEYS = ROLE_KEYS.filter(
  (roleKey): roleKey is GrantableRoleKey => roleKey !== PLATFORM_ADMIN_ROLE_KEY,
);
export type RoleAssignmentAuthority =
  | Readonly<{ type: "actor"; roleKey: RoleKey }>
  | Readonly<{ type: "system" }>
  | Readonly<{ type: "platform-bootstrap" }>;
export type PermissionKey =
  | "accounts.manage"
  | "accounts.view"
  | "catalog.manage"
  | "catalog.view"
  | "channels.manage"
  | "channels.view"
  | "commercial-terms.manage"
  | "commercial-terms.view"
  | "fulfillment.manage"
  | "fulfillment.view"
  | "return-intake.manage"
  | "return-intake.view"
  | "google-shopping.manage"
  | "google-shopping.view"
  | "insights-dashboards.view"
  | "memberships.manage"
  | "memberships.view"
  | "inventory.manage"
  | "inventory.view"
  | "listings.manage"
  | "listings.view"
  | "listing-evidence-policy.activate"
  | "listing-evidence-policy.draft"
  | "listing-evidence-policy.validate"
  | "listing-evidence-policy.view"
  | "offers.manage"
  | "offers.view"
  | "orders.manage"
  | "orders.view"
  | "payouts.manage"
  | "payouts.reconcile"
  | "payouts.request"
  | "payouts.setup"
  | "payouts.view"
  | "wallet-adjustments.operate"
  | "postage-policies.manage"
  | "postage-policies.view"
  | "projection-operations.operate"
  | "projection-operations.rebuild"
  | "projection-operations.view"
  // Customer feedback operator capabilities. Staff-only: platform-admin
  // is the sole role granted these. `view` reads the operator queue/detail/
  // metrics; `manage` performs triage/notes/review/archive/bulk/follow-up/
  // redaction; `export` is a separate grant so a viewer cannot download the
  // free-text comment corpus unless export is explicitly authorized. Ordinary
  // account roles (owner/manager/fulfillment/viewer) hold none of these --
  // submitting one's own experience feedback is an authenticated-subject
  // authority, not an operator capability.
  | "platform-feedback.export"
  | "platform-feedback.manage"
  | "platform-feedback.view"
  | "platform-feedback.export"
  | "platform-policy.manage"
  | "platform-policy.view"
  | "public-presence.manage"
  | "public-presence.view"
  | "recovered-inventory.evidence"
  | "recovered-inventory.manage"
  | "recovered-inventory.view"
  | "reputation.manage"
  | "reputation.view"
  | "support.manage"
  | "support.remedies.approve"
  | "support.remedies.approve-elevated"
  | "support.remedies.correct"
  | "support.remedies.override-return"
  | "support.remedies.propose"
  | "support.remedies.retry"
  | "support.remedies.waive"
  | "support.view"
  | "security.manage"
  // Platform Wallet Adjustment authority ratified by ADR 0020: purpose-specific,
  // never bundled into `payouts.*`, and granted to platform-admin only. Read,
  // create (request), approve (approve/reject), and reverse are independently
  // enforced permissions so each action of the lifecycle can be withheld on
  // its own.
  | "wallet-adjustments.approve"
  | "wallet-adjustments.create"
  | "wallet-adjustments.reverse"
  | "wallet-adjustments.view";
export type EmptyEventData = Readonly<Record<string, never>>;
export type IdentityValue = JsonValue;

export const EMPTY_EVENT_DATA: EmptyEventData = {};
const ROLE_KEY_SET = new Set<string>(ROLE_KEYS);
const GRANTABLE_ROLE_KEY_SET = new Set<string>(GRANTABLE_ROLE_KEYS);
const ROLE_ASSIGNMENT_RANK = {
  viewer: 1,
  fulfillment: 2,
  manager: 3,
  owner: 4,
  "platform-admin": 5,
} satisfies Record<RoleKey, number>;

export class IdentityDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IdentityDomainError";
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new IdentityDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new IdentityDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === "string" && ROLE_KEY_SET.has(value);
}

export function parseRoleKey(value: unknown): RoleKey | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return isRoleKey(trimmed) ? trimmed : null;
}

export function parseGrantableRoleKey(value: unknown): GrantableRoleKey | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return GRANTABLE_ROLE_KEY_SET.has(trimmed) ? (trimmed as GrantableRoleKey) : null;
}

export function formatValidRoleKeys(): string {
  return ROLE_KEYS.join(", ");
}

export function formatGrantableRoleKeys(): string {
  return GRANTABLE_ROLE_KEYS.join(", ");
}

export function canAssignRole(actorRoleKey: RoleKey, targetRoleKey: RoleKey): boolean {
  return (
    targetRoleKey !== PLATFORM_ADMIN_ROLE_KEY &&
    ROLE_ASSIGNMENT_RANK[targetRoleKey] <= ROLE_ASSIGNMENT_RANK[actorRoleKey]
  );
}

export function assertRoleAssignmentAllowed(roleKey: RoleKey, authority: RoleAssignmentAuthority): void {
  if (authority.type === "platform-bootstrap") {
    return;
  }

  assert(roleKey !== PLATFORM_ADMIN_ROLE_KEY, "Platform-admin can only be assigned by platform bootstrap.");

  if (authority.type === "actor") {
    assert(canAssignRole(authority.roleKey, roleKey), "Cannot assign a role above the actor's role.");
  }
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
