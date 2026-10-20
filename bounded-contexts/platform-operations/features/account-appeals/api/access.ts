import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import type { AccountAppealCommand, AccountAppealId, AppealableEnforcementAction } from "../domain/domain";

export type AccountAppealPermission = "account-appeals.view" | "account-appeals.file" | "account-appeals.review";
declare const sellerCapabilityBrand: unique symbol;
declare const operatorCapabilityBrand: unique symbol;
declare const actionCapabilityBrand: unique symbol;
export type AccountAppealSellerCapability = Readonly<{
  tenantId: string;
  accountId: AccountId;
  userId: UserId;
  permission: "account-appeals.view" | "account-appeals.file";
}> & { readonly [sellerCapabilityBrand]: true };
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

export function withAccountAppealSellerAccess<T>(
  actor: AccountAppealActor,
  permission: "account-appeals.view" | "account-appeals.file",
  run: (capability: AccountAppealSellerCapability) => T,
): T | AccountAppealAccessRejection {
  if (!actor.tenantId || !actor.accountId || !actor.userId) return ACCOUNT_APPEAL_UNAUTHENTICATED;
  if (!actor.permissions.includes(permission)) return ACCOUNT_APPEAL_FORBIDDEN;
  return run(
    Object.freeze({
      tenantId: actor.tenantId,
      accountId: actor.accountId,
      userId: actor.userId,
      permission,
    }) as AccountAppealSellerCapability,
  );
}
export function withAccountAppealOperatorAccess<T>(
  actor: AccountAppealActor,
  permission: "account-appeals.review",
  run: (capability: AccountAppealOperatorCapability) => T,
): T | AccountAppealAccessRejection {
  if (!actor.tenantId || !actor.userId || !actor.roleKey) return ACCOUNT_APPEAL_UNAUTHENTICATED;
  if (!actor.permissions.includes(permission)) return ACCOUNT_APPEAL_FORBIDDEN;
  return run(
    Object.freeze({
      tenantId: actor.tenantId,
      userId: actor.userId,
      roleKey: actor.roleKey,
      permission,
    }) as AccountAppealOperatorCapability,
  );
}

export type AppealableActionLookup = Readonly<{
  resolve: (id: string) => Promise<(AppealableEnforcementAction & { conflicted?: boolean }) | null>;
}>;
export type ResolutionResult =
  | Readonly<{ status: "resolved"; action: AppealableEnforcementActionCapability }>
  | Readonly<{ status: "indeterminate" }>;
export const APPEALABLE_ACTION_INDETERMINATE: ResolutionResult = Object.freeze({ status: "indeterminate" });
export function createAppealableEnforcementActionResolver(lookup: AppealableActionLookup) {
  return async function resolveAppealableEnforcementAction(
    capability: AccountAppealSellerCapability,
    id: string,
  ): Promise<ResolutionResult> {
    try {
      const candidate = await lookup.resolve(id);
      if (
        !candidate ||
        candidate.conflicted ||
        candidate.ownerAccountId !== capability.accountId ||
        candidate.appealableActionId !== id ||
        !candidate.sourceStreamId ||
        !Number.isInteger(candidate.sourceStreamVersion) ||
        candidate.sourceStreamVersion < 1
      )
        return APPEALABLE_ACTION_INDETERMINATE;
      return { status: "resolved", action: Object.freeze({ ...candidate }) as AppealableEnforcementActionCapability };
    } catch {
      return APPEALABLE_ACTION_INDETERMINATE;
    }
  };
}
export function fileAccountAppeal(
  capability: AccountAppealSellerCapability,
  action: AppealableEnforcementActionCapability,
  input: Readonly<{ statement: string; appealId?: AccountAppealId }>,
): Extract<AccountAppealCommand, { type: "FileAccountAppeal" }> {
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
