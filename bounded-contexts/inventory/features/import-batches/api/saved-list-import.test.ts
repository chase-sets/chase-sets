import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { describe, expect, it } from "vitest";
import {
  inventorySavedListImportSourceKind,
  prepareInventorySavedListImportBatch,
  type CreateInventorySavedListImportBatch,
  type InventorySavedListImportBatchCreator,
} from "./saved-list-import";

const context: EventStoreContext = {
  tenantId: "tnt_1" as never,
  audit: { performedByUserId: "usr_1" as never, forAccountId: "acc_1" as AccountId },
};

function command(): CreateInventorySavedListImportBatch {
  return {
    requestId: "sli_request_1",
    accountId: "acc_1" as AccountId,
    source: {
      sourceKind: inventorySavedListImportSourceKind,
      listId: "svl_1",
      listVersion: 7,
      lines: [
        {
          rowId: "saved-list:svl_1:v7:sll_2",
          lineId: "sll_2",
          product: {
            catalogItemId: "cat_2" as CatalogItemId,
            productId: "product_2" as ProductKey,
            selectedOptions: [
              { dimensionId: "finish", optionId: "foil" },
              { dimensionId: "condition", optionId: "near_mint" },
            ],
          },
          trackedQuantity: 3,
        },
      ],
    },
  };
}

describe("Inventory Saved List import contract", () => {
  it("builds stable API-source rows without cost basis or an invented location", () => {
    const first = prepareInventorySavedListImportBatch(command());
    const retry = prepareInventorySavedListImportBatch(command());

    expect(retry).toEqual(first);
    expect(first.parsedRows).toEqual([
      {
        rowNumber: 1,
        values: {
          sourceListId: "svl_1",
          sourceListVersion: "7",
          sourceLineId: "sll_2",
          sourceRowId: "saved-list:svl_1:v7:sll_2",
          catalogItemId: "cat_2",
          productId: "product_2",
          totalQuantity: "3",
          "option:condition": "near_mint",
          "option:finish": "foil",
        },
      },
    ]);
    expect(first.parsedRows[0]?.values).not.toHaveProperty("acquisitionCostAmount");
    expect(first.parsedRows[0]?.values).not.toHaveProperty("storageLocationId");
    expect(first.reviewHref).toBe(`/account/inventory/imports?jobId=${first.jobId}`);
  });

  it("changes the content fingerprint but not retry identities when a request ID is reused", () => {
    const first = prepareInventorySavedListImportBatch(command());
    const changed = prepareInventorySavedListImportBatch({
      ...command(),
      source: { ...command().source, listVersion: 8 },
    });

    expect(changed.batchId).toBe(first.batchId);
    expect(changed.jobId).toBe(first.jobId);
    expect(changed.inputId).toBe(first.inputId);
    expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it("rejects duplicate line evidence and quantities outside existing import semantics", () => {
    const input = command();
    expect(() =>
      prepareInventorySavedListImportBatch({
        ...input,
        source: { ...input.source, lines: [input.source.lines[0]!, input.source.lines[0]!] },
      }),
    ).toThrow("Duplicate Saved List source row ID");

    expect(() =>
      prepareInventorySavedListImportBatch({
        ...input,
        source: {
          ...input.source,
          lines: [{ ...input.source.lines[0]!, trackedQuantity: -1 }],
        },
      }),
    ).toThrow("invalid Tracked Quantity");
  });

  it("publishes a React-free creator signature for Collections composition", async () => {
    const creator: InventorySavedListImportBatchCreator = async (input, eventContext) => {
      expect(input).toEqual(command());
      expect(eventContext).toBe(context);
      const prepared = prepareInventorySavedListImportBatch(input);
      return { batchId: prepared.batchId, jobId: prepared.jobId, reviewHref: prepared.reviewHref };
    };

    await expect(creator(command(), context)).resolves.toMatchObject({
      reviewHref: expect.stringContaining("/imports?jobId="),
    });
  });
});
