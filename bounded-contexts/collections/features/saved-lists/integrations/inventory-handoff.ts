import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { SavedListServices } from "../api/runtime";
import type { SavedListId, SavedListLineId, SavedListOwnerLineSnapshot } from "../domain/contracts";

export type SavedListInventoryImportSourceSnapshot = Readonly<{
  sourceKind: "saved-list";
  listId: string;
  listVersion: number;
  lines: readonly Readonly<{
    rowId: string;
    lineId: string;
    product: Readonly<{
      catalogItemId: CatalogItemId;
      productId: ProductKey;
      selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
    }>;
    trackedQuantity: number;
  }>[];
}>;

export type SavedListInventoryImportBatchCreator = (
  command: Readonly<{
    requestId: string;
    accountId: AccountId;
    source: SavedListInventoryImportSourceSnapshot;
  }>,
  context: EventStoreContext,
) => Promise<Readonly<{ batchId: string; jobId: string; reviewHref: string }>>;

export type AddSavedListLinesToInventory = Readonly<{
  requestId: string;
  listId: SavedListId;
  ownerAccountId: AccountId;
  expectedVersion: number;
  lineIds: readonly SavedListLineId[];
}>;

export type SavedListInventoryHandoffServices = Readonly<{
  addLinesToInventory: (
    input: AddSavedListLinesToInventory,
    context: EventStoreContext,
  ) => ReturnType<SavedListInventoryImportBatchCreator>;
}>;

export class SavedListInventoryHandoffError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SavedListInventoryHandoffError";
  }
}

export class SavedListInventoryVersionConflictError extends SavedListInventoryHandoffError {
  public constructor(
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(`Saved List changed from expected version ${expectedVersion} to ${currentVersion}.`);
    this.name = "SavedListInventoryVersionConflictError";
  }
}

export function createSavedListInventoryHandoff(deps: {
  savedLists: Pick<SavedListServices, "getOwnerSnapshot">;
  inventoryImportBatchCreator: SavedListInventoryImportBatchCreator;
}): SavedListInventoryHandoffServices {
  return {
    addLinesToInventory: async (input, context) => {
      const savedList = await deps.savedLists.getOwnerSnapshot(
        { listId: input.listId, ownerAccountId: input.ownerAccountId },
        context,
      );
      if (!savedList) {
        throw new SavedListInventoryHandoffError("Saved List was not found.");
      }
      if (savedList.version !== input.expectedVersion) {
        throw new SavedListInventoryVersionConflictError(input.expectedVersion, savedList.version);
      }

      const selectedLineIds = new Set(input.lineIds);
      if (selectedLineIds.size === 0) {
        throw new SavedListInventoryHandoffError("Select at least one Saved List Line.");
      }
      if (selectedLineIds.size !== input.lineIds.length) {
        throw new SavedListInventoryHandoffError("Each Saved List Line may be selected only once.");
      }

      const selectedLines = savedList.lines.filter((line) => selectedLineIds.has(line.lineId));
      if (selectedLines.length !== selectedLineIds.size) {
        throw new SavedListInventoryHandoffError("A selected Saved List Line was not found.");
      }

      const source = immutableSourceSnapshot(savedList.identity.listId, savedList.version, selectedLines);
      return deps.inventoryImportBatchCreator(
        {
          requestId: input.requestId,
          accountId: savedList.identity.ownerAccountId,
          source,
        },
        context,
      );
    },
  };
}

function immutableSourceSnapshot(
  listId: SavedListId,
  listVersion: number,
  lines: readonly SavedListOwnerLineSnapshot[],
): SavedListInventoryImportSourceSnapshot {
  const snapshotLines = lines.map((line) =>
    Object.freeze({
      rowId: `saved-list:${listId}:v${listVersion}:${line.lineId}`,
      lineId: line.lineId,
      product: Object.freeze({
        catalogItemId: line.product.catalogItemId,
        productId: line.product.productId,
        selectedOptions: Object.freeze(
          line.product.selectedOptions.map((option) =>
            Object.freeze({ dimensionId: option.dimensionId, optionId: option.optionId }),
          ),
        ),
      }),
      trackedQuantity: line.trackedQuantity,
    }),
  );

  return Object.freeze({
    sourceKind: "saved-list",
    listId,
    listVersion,
    lines: Object.freeze(snapshotLines),
  });
}
