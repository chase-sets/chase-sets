import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { InventoryItemServices } from "./runtime";

export type InventoryItemMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) {
    throw new Error("dryRun is not supported for inventory item MCP writes yet.");
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

function readQuantityDelta(args: Readonly<Record<string, unknown>>) {
  const value = Number(args.quantityDelta);
  if (!Number.isInteger(value) || value === 0) {
    throw new Error("quantityDelta must be a non-zero integer.");
  }

  return value;
}

function readAvailability(args: Readonly<Record<string, unknown>>) {
  const availability = readMcpStringArgument(args, "availability") ?? readMcpStringArgument(args, "status");
  if (!availability) {
    return null;
  }
  if (availability !== "available" && availability !== "held" && availability !== "out-of-stock") {
    throw new Error("availability must be available, held, or out-of-stock.");
  }

  return availability;
}

function itemUriParts(uri: string): Readonly<{ accountId: string; itemId: string }> | null {
  const match = /^chase-sets:\/\/inventory\/([^/]+)\/items\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    itemId: decodeURIComponent(match[2] ?? ""),
  };
}

function itemReceipt(
  accountId: string,
  result: Readonly<{ itemId: string; version: number }>,
  status: string,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    accountId,
    id: result.itemId,
    inventoryItemId: result.itemId,
    version: result.version,
    status,
    resourceUri: `chase-sets://inventory/${encodeURIComponent(accountId)}/items/${encodeURIComponent(result.itemId)}`,
    ...extra,
  };
}

export function createInventoryItemMcpHandlers(services: InventoryItemServices): InventoryItemMcpHandlers {
  const listItems: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.listItems({
      accountId: scopedActor.accountId,
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
      catalogItemId: readMcpStringArgument(args, "catalogItemId"),
      productId: readMcpStringArgument(args, "productId"),
      storageLocationId: readMcpStringArgument(args, "storageLocationId"),
      availability: readAvailability(args),
    });

    return {
      accountId: scopedActor.accountId,
      items: result.items,
      total: result.total,
      count: result.items.length,
    };
  };

  const adjustItem: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.adjustItem(
      {
        accountId: scopedActor.accountId,
        itemId: readRequiredString(args, "inventoryItemId"),
        quantityDelta: readQuantityDelta(args),
        reason: readRequiredString(args, "reason"),
        idempotencyKey: readMcpStringArgument(args, "idempotencyKey"),
      },
      createActorEventStoreContext(scopedActor),
    );

    return itemReceipt(scopedActor.accountId, result, "adjusted", {
      quantityDelta: readQuantityDelta(args),
    });
  };

  const readItemResource: McpResourceHandler = async ({ actor, uri }) => {
    const parts = itemUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported inventory item resource URI.");
    }

    const scopedActor = ensureMcpActorAccount(actor, parts.accountId);
    const item = await services.getItem(parts.itemId, scopedActor.accountId);
    if (!item) {
      throw new Error("Inventory item not found.");
    }

    return item;
  };

  return {
    toolHandlers: {
      "inventory.list-items": listItems,
      "inventory.adjust-item": adjustItem,
    },
    resourceHandlers: {
      "chase-sets://inventory/{accountId}/items/{inventoryItemId}": readItemResource,
    },
  };
}
