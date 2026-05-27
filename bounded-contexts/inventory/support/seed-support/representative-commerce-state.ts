import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeSelectedOptionssForSchema,
  recordToSelectionEntries,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../../features/inventory-items/integrations/catalog/versioning";
import type { InventoryServices } from "../runtime-support/services";

const representativeSeedContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_repr_support_ops_user" as never,
    forAccountId: "acc_repr_support_ops_account" as never,
  },
};

const representativeSellingAccounts: readonly RepresentativeSellingAccount[] = [
  {
    accountId: "acc_repr_card_vault_account" as AccountId,
    shipFromCode: "STL-VAULT-REP",
    shipFromAddress: {
      name: "Card Vault Fulfillment",
      company: "Card Vault",
      line1: "720 Olive St",
      line2: "Suite 900",
      city: "Saint Louis",
      state: "MO",
      postalCode: "63101",
      country: "US",
      phone: "3145550203",
      email: "staging-card-vault@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_sealed_stockroom_account" as AccountId,
    shipFromCode: "IND-SEALED-REP",
    shipFromAddress: {
      name: "Sealed Stockroom Fulfillment",
      company: "Sealed Stockroom",
      line1: "200 S Meridian St",
      line2: null,
      city: "Indianapolis",
      state: "IN",
      postalCode: "46225",
      country: "US",
      phone: "3175550204",
      email: "sealed-stockroom@chasesets.test",
    },
  },
];

export type InventoryRepresentativeCatalogCandidate = Readonly<{
  catalogItemId: string;
}>;

export type RepresentativeInventoryStockResult = Readonly<{
  catalogItemId: string;
  accountId: string;
  inventoryItemId: string;
  storageLocationId: string;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  totalQuantity: number;
  createdInventoryItem: boolean;
  adjustedQuantityBy: number;
}>;

type RepresentativeSellingAccount = Readonly<{
  accountId: AccountId;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
}>;

export async function ensureRepresentativeInventoryStock(
  services: InventoryServices,
  candidates: readonly InventoryRepresentativeCatalogCandidate[],
  options: Readonly<{ quantityPerItem?: number }> = {},
): Promise<readonly RepresentativeInventoryStockResult[]> {
  const quantityPerItem = normalizeRepresentativeQuantity(options.quantityPerItem);
  const results: RepresentativeInventoryStockResult[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const catalogItem = await services.catalogItems.getCatalogItem(candidate.catalogItemId);
    if (!catalogItem || catalogItem.status !== "active") {
      continue;
    }

    const seller = representativeSellingAccounts[
      index % representativeSellingAccounts.length
    ] as RepresentativeSellingAccount;
    const selectedOptions = selectDefaultRepresentativeOptions(catalogItem.product_schema);
    const result = await services.items.ensureListingStock(
      {
        accountId: seller.accountId,
        catalogItemId: candidate.catalogItemId,
        selectedOptions,
        quantity: quantityPerItem,
        shipFromCode: seller.shipFromCode,
        shipFromAddress: seller.shipFromAddress,
      },
      representativeSeedContext,
    );

    results.push({
      catalogItemId: candidate.catalogItemId,
      accountId: seller.accountId,
      inventoryItemId: result.inventoryItemId,
      storageLocationId: result.storageLocationId,
      selectedOptions: result.snapshot.selectedOptions,
      totalQuantity: result.snapshot.totalQuantity,
      createdInventoryItem: result.createdInventoryItem,
      adjustedQuantityBy: result.adjustedQuantityBy,
    });
  }

  return results;
}

export function selectDefaultRepresentativeOptions(
  productSchema: InventoryProductSchema | null,
): readonly InventorySelectedOptionEntry[] {
  if (!productSchema || productSchema.dimensions.length === 0) {
    return [];
  }

  return recordToSelectionEntries(productSchema, normalizeSelectedOptionssForSchema(productSchema, {}));
}

function normalizeRepresentativeQuantity(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 4;
  }

  return Math.max(1, Math.min(Math.trunc(value), 100));
}
