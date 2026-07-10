import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PayoutServices } from "./runtime";

export type SettlementPayoutMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for settlement payout MCP writes yet.");
  }
}

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function readOptionalPositiveInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return value;
}

function readOptionalNonNegativeInteger(args: Readonly<Record<string, unknown>>, key: string, fallback: number) {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }

  return value;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function payoutUriParts(uri: string): Readonly<{ accountId: string; payoutId: string }> | null {
  const match = /^chase-sets:\/\/settlement\/([^/]+)\/payouts\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    payoutId: decodeURIComponent(match[2] ?? ""),
  };
}

function payoutResourceUri(accountId: string, payoutId: string) {
  return `chase-sets://settlement/${encodeURIComponent(accountId)}/payouts/${encodeURIComponent(payoutId)}`;
}

function payoutReceipt(
  accountId: string,
  result: Awaited<ReturnType<PayoutServices["requestPayout"]>>,
  status: string,
) {
  return {
    accountId,
    id: result.payoutId,
    payoutId: result.payoutId,
    version: result.version,
    status,
    resourceUri: payoutResourceUri(accountId, result.payoutId),
    payout: result.payout,
  };
}

export function createSettlementPayoutMcpHandlers(services: PayoutServices): SettlementPayoutMcpHandlers {
  const listPayouts: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.view");
    const result = await services.listPayouts({
      accountId: scopedActor.accountId,
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    });

    return {
      accountId: scopedActor.accountId,
      items: result.items,
      total: result.total,
      count: result.items.length,
    };
  };

  const getPayout: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.view");
    const payout = await services.getPayout(readMcpTypedIdArgument(args, "payoutId", "pyo"), scopedActor.accountId);
    if (!payout) {
      throw new Error("Payout not found.");
    }

    return {
      accountId: scopedActor.accountId,
      payout,
    };
  };

  const requestPayout: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.request");
    const result = await services.requestPayout(
      {
        accountId: scopedActor.accountId as AccountId,
        amount: readRequiredString(args, "amount"),
        note: readMcpStringArgument(args, "reason"),
        actorUserId: scopedActor.userId,
        sensitiveActionToken: readMcpStringArgument(args, "sensitiveActionToken"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return payoutReceipt(scopedActor.accountId, result, result.payout.status);
  };

  const readPayoutResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = payoutUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported settlement payout resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    requirePermission(scopedActor, "payouts.view");
    const payout = await services.getPayout(parts.payoutId, scopedActor.accountId);
    if (!payout) {
      throw new Error("Payout not found.");
    }

    return payout;
  };

  return {
    toolHandlers: {
      "settlement.list-payouts": listPayouts,
      "settlement.get-payout": getPayout,
      "settlement.request-payout": requestPayout,
    },
    resourceHandlers: {
      "chase-sets://settlement/{accountId}/payouts/{payoutId}": readPayoutResource,
    },
  };
}
