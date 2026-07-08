import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { CheckoutCartServices } from "./runtime";

export type CheckoutCartMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function cartUriParts(uri: string): Readonly<{ accountId: string }> | null {
  const match = /^chase-sets:\/\/checkout\/([^/]+)\/cart$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
  };
}

export function createCheckoutCartMcpHandlers(
  services: Pick<CheckoutCartServices, "listCartLines">,
): CheckoutCartMcpHandlers {
  const readCart = async (actor: Parameters<typeof ensureMcpActorAccount>[0], accountId: string | null) => {
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const items = await services.listCartLines(scopedActor.accountId);

    return {
      accountId: scopedActor.accountId,
      items,
      total: items.length,
    };
  };

  const getCart: McpToolHandler = ({ actor, arguments: args }) =>
    readCart(actor, readMcpStringArgument(args, "accountId"));

  const readCartResource: McpResourceHandler = ({ actor, uri }) => {
    const parts = cartUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported checkout cart resource URI.");
    }

    return readCart(actor, parts.accountId);
  };

  return {
    toolHandlers: {
      "checkout.get-cart": getCart,
    },
    resourceHandlers: {
      "chase-sets://checkout/{accountId}/cart": readCartResource,
    },
  };
}
