import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { InventoryMutationFamily } from "../runtime-support/mutation-intent";
import { assert } from "../runtime-support/common";

export function inventorySeedMutationIntent(
  command: unknown,
  targetId: string,
  accountId: string,
  location?: Readonly<{ name: string; description?: string | null; shipFromCode: string; shipFromAddress: unknown }>,
): Readonly<{ family: InventoryMutationFamily; params: Readonly<Record<string, unknown> & { accountId: string }> }> {
  assert(typeof command === "object" && command !== null, "Inventory seed command is invalid.");
  const input = command as Record<string, unknown>;
  switch (input.type) {
    case "CreateStorageLocation":
    case "UpdateStorageLocation":
    case "ArchiveStorageLocation":
      return {
        family:
          input.type === "CreateStorageLocation"
            ? "location-create"
            : input.type === "UpdateStorageLocation"
              ? "location-update"
              : "location-archive",
        params: {
          name: input.type === "ArchiveStorageLocation" ? location?.name : input.name,
          description: input.type === "ArchiveStorageLocation" ? location?.description : input.description,
          shipFromCode: input.type === "ArchiveStorageLocation" ? location?.shipFromCode : input.shipFromCode,
          shipFromAddress: input.type === "ArchiveStorageLocation" ? location?.shipFromAddress : input.shipFromAddress,
          accountId,
          storageLocationId: targetId,
          isArchived: input.type === "ArchiveStorageLocation",
        },
      };
    case "CreateInventoryItem":
      return {
        family: "item-create",
        params: {
          accountId,
          catalogItemId: input.catalogItemId,
          selectedOptions: input.selectedOptions ?? [],
          gradedCard: input.gradedCard,
          storageLocationId: input.storageLocationId,
          totalQuantity: input.totalQuantity,
          acquisitionCostAmount: input.acquisitionCostAmount,
          acquisitionCostCurrencyCode: input.acquisitionCostCurrencyCode,
          acquisitionOccurrence: input.acquisitionOccurrence,
          itemIdOverride: targetId,
        },
      };
    case "AdjustInventoryItemQuantity":
      return {
        family: "item-adjust",
        params: {
          accountId,
          itemId: targetId,
          quantityDelta: input.quantityDelta,
          reason: input.reason,
          reasonCode: input.reasonCode,
          sourceRef: input.sourceRef,
          ...(input.note === undefined ? {} : { note: input.note }),
          acquisitionOccurrence: input.acquisitionOccurrence,
        },
      };
    case "PlaceInventoryHold":
      return {
        family: "hold-create",
        params: {
          accountId,
          holdId: targetId,
          itemId: input.itemId,
          quantity: input.quantity,
          reason: input.reason,
          notes: input.notes,
          purpose: input.purpose,
          sourceRef: input.sourceRef,
          expiresAt: input.expiresAt,
        },
      };
    case "ReleaseInventoryHold":
      return { family: "hold-release", params: { accountId, holdId: targetId, releaseReason: input.releaseReason } };
    default:
      throw new Error("Inventory seed mutation has no recovery partition.");
  }
}

export type InventorySeedCommandHandler<Command> = (input: {
  streamId: string;
  command: Command;
  context: EventStoreContext;
}) => Promise<Readonly<{ version: number }>>;
