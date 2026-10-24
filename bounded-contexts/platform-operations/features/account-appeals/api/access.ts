import type {
  AccountId,
  EnforcementActionId,
  ListingEnforcementActionId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { type AccountAppealCommand, type AccountAppealId, type AppealableEnforcementAction } from "../domain/domain";

export type AccountAppealPermission = "account-appeals.view" | "account-appeals.file" | "account-appeals.review";
const sellerCapabilityBrand = Symbol("account-appeal-seller-capability");
const operatorCapabilityBrand = Symbol("account-appeal-operator-capability");
const actionCapabilityBrand = Symbol("appealable-enforcement-action-capability");
const issuedSellerCapabilities = new WeakSet<object>();
const issuedOperatorCapabilities = new WeakSet<object>();
const issuedActionCapabilities = new WeakSet<object>();

type AccountAppealSellerCapabilityBase = Readonly<{
  tenantId: string;
  accountId: AccountId;
  userId: UserId;
}> & { readonly [sellerCapabilityBrand]: true };
export type AccountAppealViewCapability = AccountAppealSellerCapabilityBase &
  Readonly<{ permission: "account-appeals.view" }>;
export type AccountAppealFileCapability = AccountAppealSellerCapabilityBase &
  Readonly<{ permission: "account-appeals.file" }>;
export type AccountAppealSellerCapability = AccountAppealViewCapability | AccountAppealFileCapability;
export type AccountAppealOperatorCapability = Readonly<{
  tenantId: string;
  userId: UserId;
  roleKey: string;
  permission: "account-appeals.review";
}> & { readonly [operatorCapabilityBrand]: true };
export type AppealableEnforcementActionCapability = Readonly<AppealableEnforcementAction> & {
  readonly [actionCapabilityBrand]: true;
};

export type AccountAppealActor = Readonly<{
  tenantId: string | null;
  accountId?: AccountId | null;
  userId: UserId | null;
  permissions: readonly string[];
  roleKey?: string | null;
}>;
export type AccountAppealAccessRejection = Readonly<{ status: 401 | 403; reason: "unauthenticated" | "forbidden" }>;
export const ACCOUNT_APPEAL_UNAUTHENTICATED: AccountAppealAccessRejection = Object.freeze({
  status: 401,
  reason: "unauthenticated",
});
export const ACCOUNT_APPEAL_FORBIDDEN: AccountAppealAccessRejection = Object.freeze({
  status: 403,
  reason: "forbidden",
});

function branded<T extends object>(value: T, brand: symbol): T {
  Object.defineProperty(value, brand, { value: true, enumerable: false, writable: false, configurable: false });
  return Object.freeze(value);
}

function isIssued(value: unknown, issued: WeakSet<object>): value is object {
  return typeof value === "object" && value !== null && issued.has(value);
}

function assertIssuedSellerCapability(capability: AccountAppealSellerCapability): void {
  if (!isIssued(capability, issuedSellerCapabilities)) throw new Error("Account appeal seller capability is invalid.");
}

function assertIssuedOperatorCapability(capability: AccountAppealOperatorCapability): void {
  if (!isIssued(capability, issuedOperatorCapabilities))
    throw new Error("Account appeal operator capability is invalid.");
}

export function assertAppealableEnforcementActionCapability(capability: AppealableEnforcementActionCapability): void {
  if (!isIssued(capability, issuedActionCapabilities))
    throw new Error("Appealable enforcement action capability is invalid.");
}

export function withAccountAppealSellerAccess<Permission extends "account-appeals.view" | "account-appeals.file", T>(
  actor: AccountAppealActor,
  permission: Permission,
  run: (
    capability: Permission extends "account-appeals.file" ? AccountAppealFileCapability : AccountAppealViewCapability,
  ) => T,
): T | AccountAppealAccessRejection {
  if (actor.tenantId === null || actor.tenantId === "" || actor.accountId == null || actor.userId === null)
    return ACCOUNT_APPEAL_UNAUTHENTICATED;
  if (!actor.permissions.includes(permission)) return ACCOUNT_APPEAL_FORBIDDEN;
  const capability = branded(
    { tenantId: actor.tenantId, accountId: actor.accountId, userId: actor.userId, permission },
    sellerCapabilityBrand,
  ) as unknown as AccountAppealSellerCapability;
  issuedSellerCapabilities.add(capability);
  return run(
    capability as Permission extends "account-appeals.file" ? AccountAppealFileCapability : AccountAppealViewCapability,
  );
}

export function withAccountAppealOperatorAccess<T>(
  actor: AccountAppealActor,
  permission: "account-appeals.review",
  run: (capability: AccountAppealOperatorCapability) => T,
): T | AccountAppealAccessRejection {
  if (
    actor.tenantId === null ||
    actor.tenantId === "" ||
    actor.userId === null ||
    actor.roleKey == null ||
    actor.roleKey === ""
  )
    return ACCOUNT_APPEAL_UNAUTHENTICATED;
  if (!actor.permissions.includes(permission)) return ACCOUNT_APPEAL_FORBIDDEN;
  const capability = branded(
    { tenantId: actor.tenantId, userId: actor.userId, roleKey: actor.roleKey, permission },
    operatorCapabilityBrand,
  ) as AccountAppealOperatorCapability;
  issuedOperatorCapabilities.add(capability);
  return run(capability);
}

export type AppealableActionLookup = Readonly<{
  resolve: (
    id: EnforcementActionId | ListingEnforcementActionId,
    ownerAccountId: AccountId,
  ) => Promise<AppealableEnforcementAction | { status: "indeterminate" }>;
}>;
export type ResolutionResult =
  | Readonly<{ status: "resolved"; action: AppealableEnforcementActionCapability }>
  | Readonly<{ status: "indeterminate" }>;
export const APPEALABLE_ACTION_INDETERMINATE: Readonly<{ status: "indeterminate" }> = Object.freeze({
  status: "indeterminate",
});

export function createAppealableEnforcementActionResolver(lookup: AppealableActionLookup) {
  return async function resolveAppealableEnforcementAction(
    capability: AccountAppealSellerCapability,
    id: EnforcementActionId | ListingEnforcementActionId,
  ): Promise<ResolutionResult> {
    assertIssuedSellerCapability(capability);
    const candidate = await lookup.resolve(id, capability.accountId);
    if ("status" in candidate || candidate.appealableActionId !== id) return APPEALABLE_ACTION_INDETERMINATE;
    const action = branded({ ...candidate }, actionCapabilityBrand) as AppealableEnforcementActionCapability;
    issuedActionCapabilities.add(action);
    return {
      status: "resolved",
      action,
    };
  };
}

export function fileAccountAppeal(
  capability: AccountAppealFileCapability,
  action: AppealableEnforcementActionCapability,
  input: Readonly<{ statement: string; appealId?: AccountAppealId }>,
): Extract<AccountAppealCommand, { type: "FileAccountAppeal" }> {
  assertIssuedSellerCapability(capability);
  assertAppealableEnforcementActionCapability(action);
  if (capability.permission !== "account-appeals.file") throw new Error("Filing requires file permission.");
  if (action.ownerAccountId !== capability.accountId)
    throw new Error("Appealable action owner does not match the capability account.");
  return {
    type: "FileAccountAppeal",
    accountId: capability.accountId,
    action,
    statement: input.statement,
    filedByUserId: capability.userId,
    tenantId: capability.tenantId,
    ...(input.appealId ? { appealId: input.appealId } : {}),
  };
}

export function assertAccountAppealFileCapability(
  capability: AccountAppealSellerCapability,
): asserts capability is AccountAppealFileCapability {
  assertIssuedSellerCapability(capability);
  if (capability.permission !== "account-appeals.file") throw new Error("Account appeal file permission is required.");
}

export function assertAccountAppealOperatorCapability(capability: AccountAppealOperatorCapability): void {
  assertIssuedOperatorCapability(capability);
  if (capability.permission !== "account-appeals.review")
    throw new Error("Account appeal review permission is required.");
}
