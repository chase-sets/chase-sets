import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import { accountEnforcementReasonCodes, accountEnforcementReversalReasonCodes } from "@chase-sets/event-core";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import { accountBadgeKeys } from "../domain/domain";
import type { AccountServices } from "./runtime";
import { readAccountEnforcementReference, submitAccountEnforcement } from "./account-enforcement";

export type AccountMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function accountUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/identity\/([^/]+)\/account$/.exec(uri);
  if (!match) return null;
  return { accountId: decodeURIComponent(match[1] ?? "") };
}

function requireOperator(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes(permission)) throw new Error(`Missing required permission: ${permission}.`);
  if (actor.roleKey !== PLATFORM_ADMIN_ROLE_KEY) throw new Error("Platform-admin authority is required.");
  return actor;
}

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value.trim() || undefined;
}

function optionalInteger(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${key} must be a non-negative integer.`);
  return value as number;
}

function enumString<T extends string>(args: Readonly<Record<string, unknown>>, key: string, values: readonly T[]): T {
  const value = requiredString(args, key);
  if (!values.includes(value as T)) throw new Error(`${key} must be one of: ${values.join(", ")}.`);
  return value as T;
}

function mutationResult(id: string, result: { version: number; state: Readonly<{ status: string }> }) {
  return { id, version: result.version, status: result.state.status };
}

function enforcementRequest(args: Readonly<Record<string, unknown>>, reasons: readonly string[]) {
  return {
    reason: enumString(args, "reason", reasons),
    reference: readAccountEnforcementReference(args.reference),
  };
}

export function createAccountMcpHandlers(services: AccountServices): AccountMcpHandlers {
  const getAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const account = await services.getAccountForRead(scopedActor.accountId);
    if (!account) throw new Error("Account not found.");
    return account;
  };

  const listAccounts: McpToolHandler = async ({ actor, arguments: args }) => {
    requireOperator(actor, "accounts.view");
    const result = await services.listAccounts({
      search: optionalString(args, "search"),
      status: optionalString(args, "status"),
      limit: optionalInteger(args, "limit"),
      offset: optionalInteger(args, "offset"),
    });
    return { items: result.items, total: result.total, count: result.items.length };
  };

  const updateAccountProfile: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "UpdateAccountProfile",
        name: requiredString(args, "name"),
        displayName: requiredString(args, "displayName"),
      },
      context: createActorEventStoreContext(scopedActor),
    });
    return mutationResult(accountId, result);
  };

  const suspendAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const result = await submitAccountEnforcement(
      services,
      accountId,
      "suspend",
      enforcementRequest(args, accountEnforcementReasonCodes),
      createActorEventStoreContext(scopedActor),
    );
    return mutationResult(accountId, result);
  };

  const reactivateAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const result = await submitAccountEnforcement(
      services,
      accountId,
      "reactivate",
      enforcementRequest(args, accountEnforcementReversalReasonCodes),
      createActorEventStoreContext(scopedActor),
    );
    return mutationResult(accountId, result);
  };

  const closeAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const result = await submitAccountEnforcement(
      services,
      accountId,
      "close",
      enforcementRequest(args, accountEnforcementReasonCodes),
      createActorEventStoreContext(scopedActor),
    );
    return mutationResult(accountId, result);
  };

  const assignAccountBadge: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const badgeKey = enumString(args, "badgeKey", accountBadgeKeys);
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "AssignAccountBadge", badgeKey },
      context: createActorEventStoreContext(scopedActor),
    });
    return { ...mutationResult(accountId, result), badges: result.state.badges };
  };

  const removeAccountBadge: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = requireOperator(actor, "accounts.manage");
    const accountId = readMcpTypedIdArgument(args, "accountId", "acc");
    const badgeKey = enumString(args, "badgeKey", accountBadgeKeys);
    const result = await services.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: { type: "RemoveAccountBadge", badgeKey },
      context: createActorEventStoreContext(scopedActor),
    });
    return { ...mutationResult(accountId, result), badges: result.state.badges };
  };

  const readAccountResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = accountUriParts(uri);
    if (!parts) throw new Error("Unsupported identity account resource URI.");
    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const account = await services.getAccountForRead(scopedActor.accountId);
    if (!account) throw new Error("Account not found.");
    return account;
  };

  return {
    toolHandlers: {
      "identity.assign-account-badge": assignAccountBadge,
      "identity.close-account": closeAccount,
      "identity.get-account": getAccount,
      "identity.list-accounts": listAccounts,
      "identity.reactivate-account": reactivateAccount,
      "identity.remove-account-badge": removeAccountBadge,
      "identity.suspend-account": suspendAccount,
      "identity.update-account-profile": updateAccountProfile,
    },
    resourceHandlers: { "chase-sets://identity/{accountId}/account": readAccountResource },
  };
}
