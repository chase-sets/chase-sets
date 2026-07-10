import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { OrderingOrderServices } from "./runtime";

export type OrderingOrderMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type OrderSide = "purchase" | "sale";

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

function readSide(args: Readonly<Record<string, unknown>>, fallback: OrderSide): OrderSide {
  const side = readMcpStringArgument(args, "side") ?? fallback;
  if (side !== "purchase" && side !== "sale") {
    throw new Error("side must be purchase or sale.");
  }

  return side;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function orderUriParts(uri: string): Readonly<{ accountId: string; orderId: string }> | null {
  const match = /^chase-sets:\/\/ordering\/([^/]+)\/orders\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    orderId: decodeURIComponent(match[2] ?? ""),
  };
}

async function readOrder(
  services: Pick<OrderingOrderServices, "getPurchase" | "getSale">,
  accountId: string,
  orderId: string,
  actor: Parameters<typeof ensureMcpActorAccount>[0],
) {
  const scopedActor = ensureMcpActorAccount(actor, accountId);
  requirePermission(scopedActor, "orders.view");
  const purchase = await services.getPurchase(orderId, scopedActor.accountId);
  if (purchase) {
    return { accountId: scopedActor.accountId, side: "purchase", order: purchase };
  }

  const sale = await services.getSale(orderId, scopedActor.accountId);
  if (sale) {
    return { accountId: scopedActor.accountId, side: "sale", order: sale };
  }

  throw new Error("Order not found.");
}

export function createOrderingOrderMcpHandlers(
  services: Pick<OrderingOrderServices, "listPurchases" | "getPurchase" | "listSales" | "getSale">,
): OrderingOrderMcpHandlers {
  const listOrders: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    requirePermission(scopedActor, "orders.view");
    const side = readSide(args, "purchase");
    const params = {
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
    };
    const result =
      side === "sale"
        ? await services.listSales({ sellerAccountId: scopedActor.accountId, ...params })
        : await services.listPurchases({ buyerAccountId: scopedActor.accountId, ...params });

    return {
      accountId: scopedActor.accountId,
      side,
      items: result.items,
      total: result.total,
      count: result.items.length,
    };
  };

  const getOrder: McpToolHandler = ({ actor, arguments: args }) =>
    readOrder(services, readRequiredString(args, "accountId"), readMcpTypedIdArgument(args, "orderId", "ord"), actor);

  const readOrderResource: McpResourceHandler = ({ actor, uri }) => {
    const parts = orderUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported ordering order resource URI.");
    }

    return readOrder(services, parts.accountId, parts.orderId, actor);
  };

  return {
    toolHandlers: {
      "ordering.list-orders": listOrders,
      "ordering.get-order": getOrder,
    },
    resourceHandlers: {
      "chase-sets://ordering/{accountId}/orders/{orderId}": readOrderResource,
    },
  };
}
