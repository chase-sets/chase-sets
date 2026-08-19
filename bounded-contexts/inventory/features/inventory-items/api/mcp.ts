import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  readOptionalMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
import type { InventoryItemServices } from "./runtime";
import type { InventoryHoldCollisionServices } from "../../hold-collisions/api/runtime";
import {
  isInventoryAdjustmentReason,
  type InventoryAdjustmentReason,
} from "@chase-sets/event-core/public-event-payloads";

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

/**
 * Resolves a storage location natural-key input (`nameKey`) to its canonical
 * `loc_` id when the caller did not supply the id directly (`idKey`). Storage
 * location names are not database-unique, so an ambiguous name returns a
 * structured list of candidates instead of guessing -- the agent must either
 * pick a more specific name or fall back to the id from a prior `list` call.
 */
async function resolveStorageLocationId(
  storageLocations: Pick<StorageLocationServices, "listStorageLocations">,
  accountId: string,
  args: Readonly<Record<string, unknown>>,
  options: Readonly<{ idKey: string; nameKey: string; includeArchived: boolean }>,
): Promise<string | null> {
  const id = readOptionalMcpTypedIdArgument(args, options.idKey, "loc");
  if (id) {
    return id;
  }

  const name = readMcpStringArgument(args, options.nameKey);
  if (!name) {
    return null;
  }

  const locations = await storageLocations.listStorageLocations({
    accountId,
    includeArchived: options.includeArchived,
  });
  const normalizedName = name.trim().toLocaleLowerCase("en-US");
  const matches = locations.filter((location) => location.name.trim().toLocaleLowerCase("en-US") === normalizedName);

  if (matches.length === 0) {
    throw new Error(`No storage location named "${name}" was found for this account.`);
  }
  if (matches.length > 1) {
    const candidates = matches.map((location) => `${location.storage_location_id} (${location.name})`).join(", ");
    throw new Error(
      `Multiple storage locations are named "${name}": ${candidates}. Provide ${options.idKey} to disambiguate.`,
    );
  }

  return matches[0].storage_location_id;
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

export function createInventoryItemMcpHandlers(
  services: InventoryItemServices,
  storageLocations: Pick<StorageLocationServices, "listStorageLocations">,
  holdCollisions: InventoryHoldCollisionServices,
): InventoryItemMcpHandlers {
  const listItems: McpToolHandler = async ({ actor, arguments: args }) => {
    const accountId = readRequiredString(args, "accountId");
    const scopedActor = ensureMcpActorAccount(actor, accountId);
    const result = await services.listItems({
      accountId: scopedActor.accountId,
      limit: readOptionalPositiveInteger(args, "limit", 50),
      offset: readOptionalNonNegativeInteger(args, "offset", 0),
      catalogItemId: readOptionalMcpTypedIdArgument(args, "catalogItemId", "cat"),
      productId: readMcpStringArgument(args, "productId"),
      storageLocationId: await resolveStorageLocationId(storageLocations, scopedActor.accountId, args, {
        idKey: "storageLocationId",
        nameKey: "storageLocationName",
        // Archived locations still legitimately contain items (a location is
        // archived, not deleted), so a name filter here should not silently
        // exclude a match the way a "default for new stock" resolution would.
        includeArchived: true,
      }),
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
    const quantityDelta = readQuantityDelta(args);
    const itemId = readMcpTypedIdArgument(args, "inventoryItemId", "inv");
    const mode = readMcpStringArgument(args, "collisionMode") ?? "protect-orders";
    const suppliedReasonCode = readMcpStringArgument(args, "reasonCode");
    if (suppliedReasonCode !== null && !isInventoryAdjustmentReason(suppliedReasonCode)) {
      throw new Error("reasonCode must be a supported inventory adjustment reason.");
    }
    let reasonCode = (suppliedReasonCode ?? undefined) as InventoryAdjustmentReason | undefined;
    const note = Object.hasOwn(args, "note") ? readMcpStringArgument(args, "note") : undefined;
    if (mode !== "protect-orders" && mode !== "honor-offline") {
      throw new Error("collisionMode must be protect-orders or honor-offline.");
    }
    if (mode === "honor-offline" && quantityDelta >= 0) {
      throw new Error("Honor offline is only valid for stock reductions.");
    }
    if (mode === "honor-offline" && !["manager", "owner", "platform-admin"].includes(scopedActor.roleKey)) {
      throw new Error("Honor offline requires a manager or owner.");
    }
    if (mode === "honor-offline" && args.confirmSellerCannotFulfill !== true) {
      throw new Error("Honor offline requires explicit seller-cannot-fulfill confirmation.");
    }
    if (mode === "honor-offline" && reasonCode !== undefined && reasonCode !== "sold-offline") {
      throw new Error("Honor offline requires reasonCode sold-offline.");
    }
    if (mode === "honor-offline") {
      reasonCode = "sold-offline";
    }
    const result =
      quantityDelta < 0
        ? await holdCollisions.reduceItem(
            {
              accountId: scopedActor.accountId,
              itemId,
              requestedQuantity: -quantityDelta,
              reason: readRequiredString(args, "reason"),
              ...(reasonCode !== undefined ? { reasonCode } : {}),
              ...(note !== undefined ? { note } : {}),
              mode,
              actorRole: scopedActor.roleKey,
            },
            createActorEventStoreContext(scopedActor),
          )
        : await services.adjustItem(
            {
              accountId: scopedActor.accountId,
              itemId,
              quantityDelta,
              reason: readRequiredString(args, "reason"),
              ...(reasonCode !== undefined ? { reasonCode } : {}),
              ...(note !== undefined ? { note } : {}),
              idempotencyKey: readMcpStringArgument(args, "idempotencyKey"),
            },
            createActorEventStoreContext(scopedActor),
          );

    const collision = result && "collision" in result ? result.collision : null;
    return itemReceipt(scopedActor.accountId, result, collision ? "hold-collision-recorded" : "adjusted", {
      quantityDelta,
      ...(collision ? { collision } : {}),
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
