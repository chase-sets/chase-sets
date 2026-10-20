import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { AccountAppealCommand, AccountAppealId, AppealableEnforcementAction } from "../domain/domain";

export type AccountAppealPermission = "account-appeals.view" | "account-appeals.file" | "account-appeals.review";
export type AccountAppealSellerCapability = Readonly<{ tenantId: string; accountId: AccountId; userId: UserId; permission: AccountAppealPermission }>;
export type AccountAppealOperatorCapability = Readonly<{ tenantId: string; userId: UserId; roleKey: string; permission: "account-appeals.review" }>;

declare const sellerCapabilityBrand: unique symbol;
declare const operatorCapabilityBrand: unique symbol;
type BrandedSellerCapability = AccountAppealSellerCapability & { readonly [sellerCapabilityBrand]: true };
type BrandedOperatorCapability = AccountAppealOperatorCapability & { readonly [operatorCapabilityBrand]: true };

export type AccountAppealActor = Readonly<{ tenantId: string | null; accountId?: AccountId | null; userId: UserId | null; permissions: readonly string[]; roleKey?: string | null }>;

export function withAccountAppealSellerAccess<T>(actor: AccountAppealActor, permission: AccountAppealPermission, run: (capability: AccountAppealSellerCapability) => T): T | null {
  if (!actor.tenantId || !actor.accountId || !actor.userId || !actor.permissions.includes(permission)) return null;
  return run(Object.freeze({ tenantId: actor.tenantId, accountId: actor.accountId, userId: actor.userId, permission }) as BrandedSellerCapability);
}

export function withAccountAppealOperatorAccess<T>(actor: AccountAppealActor, permission: "account-appeals.review", run: (capability: AccountAppealOperatorCapability) => T): T | null {
  if (!actor.tenantId || !actor.userId || !actor.roleKey || !actor.permissions.includes(permission)) return null;
  return run(Object.freeze({ tenantId: actor.tenantId, userId: actor.userId, roleKey: actor.roleKey, permission }) as BrandedOperatorCapability);
}

export type AppealableActionLookup = Readonly<{ resolve: (id: string) => Promise<AppealableEnforcementAction | null> }>;
export type ResolutionResult = Readonly<{ status: "resolved"; action: AppealableEnforcementAction }> | Readonly<{ status: "indeterminate" }>;
export const APPEALABLE_ACTION_INDETERMINATE: ResolutionResult = Object.freeze({ status: "indeterminate" });

/** Resolution is deliberately nondisclosing: absence, foreign ownership and corruption all look identical. */
export async function resolveAppealableEnforcementAction(capability: AccountAppealSellerCapability, id: string, lookup: AppealableActionLookup): Promise<ResolutionResult> {
  try {
    const candidate = await lookup.resolve(id);
    if (!candidate || candidate.ownerAccountId !== capability.accountId || !candidate.appealableActionId || candidate.appealableActionId !== id || !candidate.sourceStreamId || !Number.isInteger(candidate.sourceStreamVersion) || candidate.sourceStreamVersion < 1) return APPEALABLE_ACTION_INDETERMINATE;
    return { status: "resolved", action: candidate };
  } catch {
    return APPEALABLE_ACTION_INDETERMINATE;
  }
}

export function fileAccountAppeal(capability: AccountAppealSellerCapability, action: AppealableEnforcementAction, input: Readonly<{ statement: string; appealId?: AccountAppealId }>): Extract<AccountAppealCommand, { type: "FileAccountAppeal" }> {
  return { type: "FileAccountAppeal", accountId: capability.accountId, action, statement: input.statement, filedByUserId: capability.userId, tenantId: capability.tenantId, ...(input.appealId ? { appealId: input.appealId } : {}) };
}
