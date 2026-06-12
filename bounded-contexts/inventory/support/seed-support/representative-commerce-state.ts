import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRepresentativeCatalogUsageCandidate } from "@chase-sets/catalog-seed";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeSelectedOptionssForSchema,
  recordToSelectionEntries,
  type InventoryProductDimension,
  type InventoryProductOption,
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

export async function reconcileRepresentativeInventoryCatalogItems(
  services: InventoryServices,
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
): Promise<number> {
  for (const candidate of candidates) {
    await services.db.query(
      `INSERT INTO inventory_catalog_items (
         catalog_item_id,
         language_code,
         title,
         subtitle,
         blueprint_id,
         status,
         product_schema,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (catalog_item_id) DO UPDATE SET
         language_code = EXCLUDED.language_code,
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         blueprint_id = EXCLUDED.blueprint_id,
         status = EXCLUDED.status,
         product_schema = EXCLUDED.product_schema,
         updated_at = EXCLUDED.updated_at`,
      [
        candidate.catalogItemId,
        candidate.languageCode,
        candidate.title,
        candidate.subtitle,
        candidate.blueprintId,
        candidate.status,
        candidate.productSchema ? JSON.stringify(candidate.productSchema) : null,
        candidate.updatedAt,
      ],
    );
  }

  return candidates.length;
}

export function selectDefaultRepresentativeOptions(
  productSchema: InventoryProductSchema | null,
): readonly InventorySelectedOptionEntry[] {
  if (!productSchema || productSchema.dimensions.length === 0) {
    return [];
  }

  return recordToSelectionEntries(
    productSchema,
    normalizeSelectedOptionssForSchema(productSchema, selectRepresentativePreferredOptions(productSchema)),
  );
}

function selectRepresentativePreferredOptions(productSchema: InventoryProductSchema): Record<string, string> {
  const formDimension = productSchema.dimensions.find(
    (dimension) => isLikelyFormDimension(dimension) && dimension.allowedOptions.some(isRawOption),
  );

  if (!formDimension) {
    return {};
  }

  const rawOption = formDimension.allowedOptions.find(isRawOption);
  if (!rawOption) {
    return {};
  }

  return {
    [formDimension.dimensionId]: rawOption.optionId,
  };
}

function isLikelyFormDimension(dimension: InventoryProductDimension): boolean {
  const dimensionText = `${dimension.dimensionId} ${dimension.dimensionName}`;
  return matchesMeaning(dimensionText, "form") || dimension.allowedOptions.some(isGradedOption);
}

function isRawOption(option: InventoryProductOption): boolean {
  return matchesMeaning(`${option.optionId} ${option.code} ${option.label}`, "raw", "ungraded");
}

function isGradedOption(option: InventoryProductOption): boolean {
  return matchesMeaning(`${option.optionId} ${option.code} ${option.label}`, "graded");
}

function matchesMeaning(value: string, ...terms: readonly string[]): boolean {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return terms.some((term) => tokens.includes(term));
}

function normalizeRepresentativeQuantity(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 4;
  }

  return Math.max(1, Math.min(Math.trunc(value), 100));
}
