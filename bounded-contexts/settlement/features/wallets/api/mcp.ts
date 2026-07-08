import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { WalletServices } from "./runtime";

export type SettlementWalletMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

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

function walletUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/settlement\/([^/]+)\/wallet$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
  };
}

export function createSettlementWalletMcpHandlers(services: WalletServices): SettlementWalletMcpHandlers {
  const getWallet: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.view");
    const wallet = await services.getWallet(scopedActor.accountId);

    return {
      accountId: scopedActor.accountId,
      wallet,
    };
  };

  const listLedgerEntries: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, "payouts.view");
    const result = await services.listWalletEntries({
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

  const readWalletResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = walletUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported settlement wallet resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    requirePermission(scopedActor, "payouts.view");
    return services.getWallet(scopedActor.accountId);
  };

  return {
    toolHandlers: {
      "settlement.get-wallet": getWallet,
      "settlement.list-ledger-entries": listLedgerEntries,
    },
    resourceHandlers: {
      "chase-sets://settlement/{accountId}/wallet": readWalletResource,
    },
  };
}
