import { readMcpStringArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { AuthenticityCaseServices } from "./runtime";

export type AuthenticityCaseMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function caseUriParts(uri: string): Readonly<{ caseId: string }> | null {
  const match = /^chase-sets:\/\/authenticity\/cases\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }
  return { caseId: decodeURIComponent(match[1] ?? "") };
}

/**
 * MCP module registration stub. Read-only for this scaffold slice;
 * verdict-recording and workbench actions arrive with the inspection
 * workbench milestone slice.
 */
export function createAuthenticityCaseMcpHandlers(services: AuthenticityCaseServices): AuthenticityCaseMcpHandlers {
  const getCaseStatus: McpToolHandler = async ({ arguments: args }) => {
    const orderId = readMcpStringArgument(args, "orderId");
    if (!orderId) {
      throw new Error("orderId is required.");
    }

    const item = await services.getCaseByOrderId(orderId);
    if (!item) {
      throw new Error("Authenticity case not found for the given order.");
    }

    return item;
  };

  const readCaseResource: McpResourceHandler = async ({ uri }) => {
    const parts = caseUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported authenticity case resource URI.");
    }

    const item = await services.getCase(parts.caseId);
    if (!item) {
      throw new Error("Authenticity case not found.");
    }

    return item;
  };

  return {
    toolHandlers: {
      "authenticity.get-case-status": getCaseStatus,
    },
    resourceHandlers: {
      "chase-sets://authenticity/cases/{caseId}": readCaseResource,
    },
  };
}
