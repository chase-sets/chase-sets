import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { describe, expect, it, vi } from "vitest";
import type { SavedListId, SavedListLineId, SavedListOwnerSnapshot } from "../domain/contracts";
import {
  createSavedListInventoryHandoff,
  type SavedListInventoryImportBatchCreator,
  SavedListInventoryHandoffError,
  SavedListInventoryVersionConflictError,
} from "./inventory-handoff";

const ownerAccountId = "acc_owner" as AccountId;
const listId = "svl_test" as SavedListId;
const context: EventStoreContext = {
  tenantId: "tnt_1" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: ownerAccountId },
};

function ownerSnapshot(): SavedListOwnerSnapshot {
  return {
    contractVersion: 1,
    identity: { listId, ownerAccountId },
    title: "Binder",
    description: null,
    visibility: "private",
    lifecycle: "active",
    cover: null,
    membership: {
      orderedLineIds: ["sll_one" as SavedListLineId, "sll_two" as SavedListLineId],
      lineCount: 2,
      trackedUnitCount: 7,
    },
    lines: [
      {
        lineId: "sll_one" as SavedListLineId,
        product: {
          catalogItemId: "cat_one" as CatalogItemId,
          productId: "product_one" as ProductKey,
          selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
        },
        trackedQuantity: 5,
        privateNotes: "not Inventory data",
        privateTags: ["trade"],
        addedAt: "2026-07-13T00:00:00.000Z",
        changedAt: "2026-07-13T00:00:00.000Z",
        position: 0,
      },
      {
        lineId: "sll_two" as SavedListLineId,
        product: {
          catalogItemId: "cat_two" as CatalogItemId,
          productId: "product_two" as ProductKey,
          selectedOptions: [],
        },
        trackedQuantity: 2,
        privateNotes: null,
        privateTags: [],
        addedAt: "2026-07-13T00:00:00.000Z",
        changedAt: "2026-07-13T00:00:00.000Z",
        position: 1,
      },
    ],
    createdAt: "2026-07-13T00:00:00.000Z",
    changedAt: "2026-07-13T00:00:00.000Z",
    archivedAt: null,
    version: 4,
  };
}

describe("Saved List Inventory handoff", () => {
  it("authorizes through the owner snapshot and sends an immutable selected-line snapshot", async () => {
    const snapshot = ownerSnapshot();
    const getOwnerSnapshot = vi.fn(async () => snapshot);
    const inventoryImportBatchCreator = vi.fn<SavedListInventoryImportBatchCreator>(async () => ({
      batchId: "imb_1",
      jobId: "job_1",
      reviewHref: "/account/inventory/imports?jobId=job_1",
    }));
    const service = createSavedListInventoryHandoff({
      savedLists: { getOwnerSnapshot },
      inventoryImportBatchCreator,
    });

    await expect(
      service.addLinesToInventory(
        {
          requestId: "sli_request_1",
          listId,
          ownerAccountId,
          expectedVersion: 4,
          lineIds: ["sll_two" as SavedListLineId],
        },
        context,
      ),
    ).resolves.toEqual({
      batchId: "imb_1",
      jobId: "job_1",
      reviewHref: "/account/inventory/imports?jobId=job_1",
    });

    expect(getOwnerSnapshot).toHaveBeenCalledWith({ listId, ownerAccountId }, context);
    const command = inventoryImportBatchCreator.mock.calls[0]?.[0];
    expect(command).toEqual({
      requestId: "sli_request_1",
      accountId: ownerAccountId,
      source: {
        sourceKind: "saved-list",
        listId,
        listVersion: 4,
        lines: [
          {
            rowId: "saved-list:svl_test:v4:sll_two",
            lineId: "sll_two",
            product: { catalogItemId: "cat_two", productId: "product_two", selectedOptions: [] },
            trackedQuantity: 2,
          },
        ],
      },
    });
    expect(command?.source.lines[0]).not.toHaveProperty("privateNotes");
    expect(command?.source.lines[0]).not.toHaveProperty("acquisitionCostAmount");
    expect(Object.isFrozen(command?.source)).toBe(true);
    expect(Object.isFrozen(command?.source.lines)).toBe(true);
    expect(Object.isFrozen(command?.source.lines[0]?.product.selectedOptions)).toBe(true);
  });

  it("rejects stale versions and missing selected lines before calling Inventory", async () => {
    const inventoryImportBatchCreator = vi.fn<SavedListInventoryImportBatchCreator>();
    const service = createSavedListInventoryHandoff({
      savedLists: { getOwnerSnapshot: vi.fn(async () => ownerSnapshot()) },
      inventoryImportBatchCreator,
    });

    await expect(
      service.addLinesToInventory(
        { requestId: "request_1", listId, ownerAccountId, expectedVersion: 3, lineIds: ["sll_one" as SavedListLineId] },
        context,
      ),
    ).rejects.toBeInstanceOf(SavedListInventoryVersionConflictError);

    await expect(
      service.addLinesToInventory(
        {
          requestId: "request_2",
          listId,
          ownerAccountId,
          expectedVersion: 4,
          lineIds: ["sll_missing" as SavedListLineId],
        },
        context,
      ),
    ).rejects.toBeInstanceOf(SavedListInventoryHandoffError);
    expect(inventoryImportBatchCreator).not.toHaveBeenCalled();
  });
});
