import type { InventoryDraftListingMessage } from "@chase-sets/inventory-draft-listing";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketplaceListingServices } from "../api/runtime";

export const draftContext = {
  tenantId: "tnt_c4",
  audit: { performedByUserId: "usr_c4", forAccountId: "acc_c4" },
} as EventStoreContext;

export function draftMessage(): InventoryDraftListingMessage {
  return {
    schemaVersion: "inventory-draft-listing/v1",
    messageId: "imr_c4_1",
    authority: { tenantId: "tnt_c4", accountId: "acc_c4", performedByUserId: "usr_c4" },
    snapshot: {
      importBatchId: "imb_c4",
      importRowId: "imr_c4_1",
      committedAt: "2026-10-19T12:00:00.000Z",
      inventoryItemId: "inv_c4",
      catalogItemId: "cat_c4",
      productId: "cat_c4::",
      selectedOptions: [
        { dimensionId: "a", optionId: "oa" },
        { dimensionId: "z", optionId: "oz" },
      ],
      storageLocationId: "loc_c4",
      storageLocationName: "Warehouse",
      shipFromCode: "US-IL",
      shipFromAddress: {
        name: "Seller",
        line1: "1 Main St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      totalQuantity: 2,
      acquisitionCostAmount: null,
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 2,
    },
  };
}

/** The snapshot-draft fields the Inventory draft consumer forwards; a Marketplace rename breaks this Pick. */
export type InventorySnapshotDraftInput = Pick<
  Parameters<MarketplaceListingServices["createBatchDraftListingFromInventorySnapshot"]>[0],
  | "accountId"
  | "importBatchId"
  | "importRowId"
  | "inventoryItemId"
  | "listingIdOverride"
  | "catalogItemId"
  | "productId"
  | "selectedOptions"
  | "storageLocationId"
  | "storageLocationName"
  | "shipFromCode"
  | "shipFromAddress"
  | "totalQuantity"
  | "acquisitionCostAmount"
  | "acquisitionCostCurrencyCode"
  | "priceAmount"
  | "priceCurrencyCode"
  | "quantityCap"
>;

export function directPortInput(): InventorySnapshotDraftInput {
  const { committedAt: _committedAt, ...snapshot } = draftMessage().snapshot;
  return {
    ...snapshot,
    selectedOptions: [...snapshot.selectedOptions].reverse(),
    accountId: draftMessage().authority.accountId,
    listingIdOverride: "lst_c4_1" as never,
  } satisfies InventorySnapshotDraftInput;
}
