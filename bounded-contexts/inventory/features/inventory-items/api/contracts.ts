export type {
  InventoryHold,
  InventoryItemDetail,
  InventoryItemLedgerEntry,
  InventoryItemListItem,
} from "../ui/contracts";

import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { InventoryOfflineSaleChannel } from "@chase-sets/event-core/public-event-payloads";
import type { InventoryHoldCollisionMode, InventoryHoldCollisionPlan } from "../../hold-collisions/domain/domain";
import type { GradedCardDetails } from "../domain/domain";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";

export type InventoryCreateItemRequest = Readonly<
  Record<string, unknown> & {
    /** Seller evidence only. Inventory owns the source label and represents an
     * omitted value as an explicit unknown occurrence in the emitted event. */
    acquisitionOccurredAt?: string | null;
    /** Optional source-authored pair. Neither member is inferred. */
    acquisitionCostAmount?: string | null;
    acquisitionCostCurrencyCode?: string | null;
  }
>;

export type InventoryAdjustItemRequest = Readonly<
  Record<string, unknown> & {
    /** Allowed only when quantityDelta is positive. */
    acquisitionOccurredAt?: string | null;
  }
>;

export type InventoryListingStockSnapshot = Readonly<{
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  gradedCard: GradedCardDetails | null;
  storageLocationId: string;
  storageLocationName: string;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
  totalQuantity: number;
  availableQuantity: number;
  acquisitionCostAmount: string | null;
  acquisitionCostCurrencyCode: string | null;
}>;

export type InventoryEnsuredListingStock = Readonly<{
  inventoryItemId: string;
  storageLocationId: string;
  createdStorageLocation: boolean;
  createdInventoryItem: boolean;
  adjustedQuantityBy: number;
  snapshot: InventoryListingStockSnapshot;
}>;

export type InventoryOfflineSaleRequest = Readonly<{
  quantity: number;
  salePriceAmount?: string | null;
  channel: InventoryOfflineSaleChannel;
  note?: string | null;
  collisionMode?: InventoryHoldCollisionMode;
  confirmSellerCannotFulfill?: boolean;
  idempotencyKey: string;
}>;

export type InventoryOfflineSaleResult = Readonly<{
  itemId: string;
  version: number;
  requestedQuantity: number;
  appliedQuantity: number;
  refusedQuantity: number;
  collision: InventoryHoldCollisionPlan | null;
}>;
