import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountServices } from "./runtime";

export type AccountMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function accountUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/identity\/([^/]+)\/account$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
  };
}

export function createAccountMcpHandlers(services: AccountServices): AccountMcpHandlers {
  const getAccount: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readMcpStringArgument(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const account = await services.getAccountForRead(scopedActor.accountId);
    if (!account) {
      throw new Error("Account not found.");
    }

    return account;
  };

  const readAccountResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = accountUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported identity account resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const account = await services.getAccountForRead(scopedActor.accountId);
    if (!account) {
      throw new Error("Account not found.");
    }

    return account;
  };

  return {
    toolHandlers: {
      "identity.get-account": getAccount,
    },
    resourceHandlers: {
      "chase-sets://identity/{accountId}/account": readAccountResource,
    },
  };
}
