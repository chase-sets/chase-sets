export type {
  InventoryHold,
  InventoryItemDetail,
  InventoryItemListItem,
} from "../ui/contracts";

import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { GradedCardDetails } from "../domain/domain";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";

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
}>;

export type InventoryEnsuredListingStock = Readonly<{
  inventoryItemId: string;
  storageLocationId: string;
  createdStorageLocation: boolean;
  createdInventoryItem: boolean;
  adjustedQuantityBy: number;
  snapshot: InventoryListingStockSnapshot;
}>;
