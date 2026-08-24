import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type {
  InventoryAdjustmentReason,
  InventoryAdjustmentSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";
import {
  assert,
  assertNever,
  ensureInteger,
  ensurePositiveInteger,
  normalizeLabel,
} from "../../../support/runtime-support/common";

export type InventoryItemState = Readonly<{
  id: InventoryItemId | null;
  accountId: AccountId | null;
  catalogItemId: CatalogItemId | null;
  productId: ProductKey | null;
  selectedOptions: readonly InventorySelectedOptionEntry[];
  gradedCard: GradedCardDetails | null;
  storageLocationId: string | null;
  totalQuantity: number;
  acquisitionCostAmount: string | null;
}>;

export type GradedCardPopulation = Readonly<{
  populationAtGrade: number | null;
  populationHigher: number | null;
  source: string | null;
  asOf: string | null;
}>;

export type GradedCardDetails = Readonly<{
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: GradedCardPopulation | null;
  conditionDescriptors: string[];
}>;

export const initialInventoryItemState: InventoryItemState = {
  id: null,
  accountId: null,
  catalogItemId: null,
  productId: null,
  selectedOptions: [],
  gradedCard: null,
  storageLocationId: null,
  totalQuantity: 0,
  acquisitionCostAmount: null,
};

export type CreateInventoryItemCommand = Readonly<{
  type: "CreateInventoryItem";
  csatOutcomeFact?: JsonObject;
  itemId: InventoryItemId;
  accountId: AccountId;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  selectedOptions?: readonly InventorySelectedOptionEntry[];
  gradedCard?: GradedCardDetails | null;
  storageLocationId: string;
  totalQuantity: number;
  acquisitionCostAmount?: string | null;
}>;

export type AdjustInventoryItemQuantityCommand = Readonly<{
  type: "AdjustInventoryItemQuantity";
  csatOutcomeFact?: JsonObject;
  quantityDelta: number;
  heldQuantity: number;
  reason: string;
  reasonCode?: InventoryAdjustmentReason;
  note?: string | null;
  sourceRef?: InventoryAdjustmentSourceRef;
}>;

export type ClaimInventoryStockAuthorityCommand = Readonly<{
  type: "ClaimInventoryStockAuthority";
  authorityRef: string;
  operation: "hold-placement" | "stock-reduction";
  quantity: number;
}>;

export type InventoryItemCommand =
  | CreateInventoryItemCommand
  | AdjustInventoryItemQuantityCommand
  | ClaimInventoryStockAuthorityCommand;

export type InventoryItemCreatedEvent = DomainEvent<
  "inventory.item.created",
  Readonly<{
    itemId: InventoryItemId;
    accountId: AccountId;
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    selectedOptions: InventorySelectedOptionEntry[];
    gradedCard: GradedCardDetails | null;
    storageLocationId: string;
    totalQuantity: number;
    acquisitionCostAmount: string | null;
    csatOutcomeFact?: JsonObject;
  }>
>;

export type InventoryItemAdjustedEvent = DomainEvent<
  "inventory.item.adjusted",
  Readonly<{
    itemId: InventoryItemId;
    quantityDelta: number;
    reason: string;
    reasonCode?: InventoryAdjustmentReason;
    note?: string | null;
    sourceRef?: InventoryAdjustmentSourceRef;
    csatOutcomeFact?: JsonObject;
  }>
>;

export type InventoryItemStockAuthorityClaimedEvent = DomainEvent<
  "inventory.item.stock-authority-claimed",
  Readonly<{
    itemId: InventoryItemId;
    authorityRef: string;
    operation: "hold-placement" | "stock-reduction";
    quantity: number;
  }>
>;

export type InventoryItemEvent =
  | InventoryItemCreatedEvent
  | InventoryItemAdjustedEvent
  | InventoryItemStockAuthorityClaimedEvent;

export const decideInventoryItem: AggregateDecider<InventoryItemState, InventoryItemCommand, InventoryItemEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateInventoryItem":
      assert(state.id === null, "Inventory item has already been created.");
      ensurePositiveInteger(command.totalQuantity, "Inventory items require a positive total quantity.");
      return [
        {
          type: "inventory.item.created",
          data: {
            itemId: command.itemId,
            accountId: command.accountId,
            catalogItemId: normalizeLabel(command.catalogItemId) as CatalogItemId,
            productId: command.productId,
            selectedOptions: (command.selectedOptions ?? []).map((entry) => ({
              dimensionId: normalizeLabel(entry.dimensionId),
              optionId: normalizeLabel(entry.optionId),
            })),
            gradedCard: normalizeGradedCardDetails(command.gradedCard ?? null),
            storageLocationId: normalizeLabel(command.storageLocationId),
            totalQuantity: command.totalQuantity,
            acquisitionCostAmount: command.acquisitionCostAmount ?? null,
            ...(command.csatOutcomeFact ? { csatOutcomeFact: command.csatOutcomeFact } : {}),
          },
        },
      ];
    case "AdjustInventoryItemQuantity":
      requireCreatedInventoryItem(state);
      ensureInteger(command.quantityDelta, "Inventory adjustments must use a whole-number quantity delta.");
      ensureInteger(command.heldQuantity, "Inventory adjustments require a whole-number held quantity.");
      assert(command.heldQuantity >= 0, "Inventory held quantity cannot be negative.");
      assert(command.quantityDelta !== 0, "Quantity adjustments must change inventory.");
      assert(state.totalQuantity + command.quantityDelta >= 0, "Inventory quantity cannot fall below zero.");
      assert(
        state.totalQuantity + command.quantityDelta >= command.heldQuantity,
        `${command.heldQuantity} units are committed to open orders.`,
      );
      return [
        {
          type: "inventory.item.adjusted",
          data: {
            itemId: state.id!,
            quantityDelta: command.quantityDelta,
            reason: normalizeLabel(command.reason),
            ...(command.reasonCode !== undefined ? { reasonCode: command.reasonCode } : {}),
            ...(command.note !== undefined ? { note: normalizeOptionalText(command.note) } : {}),
            sourceRef: command.sourceRef ?? null,
            ...(command.csatOutcomeFact ? { csatOutcomeFact: command.csatOutcomeFact } : {}),
          },
        },
      ];
    case "ClaimInventoryStockAuthority":
      requireCreatedInventoryItem(state);
      ensurePositiveInteger(command.quantity, "Inventory stock authority requires a positive quantity.");
      return [
        {
          type: "inventory.item.stock-authority-claimed",
          data: {
            itemId: state.id!,
            authorityRef: normalizeLabel(command.authorityRef),
            operation: command.operation,
            quantity: command.quantity,
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveInventoryItem: AggregateEvolver<InventoryItemState, InventoryItemEvent> = (state, event) => {
  switch (event.type) {
    case "inventory.item.created":
      return {
        id: event.data.itemId,
        accountId: event.data.accountId,
        catalogItemId: event.data.catalogItemId,
        productId: event.data.productId,
        selectedOptions: event.data.selectedOptions,
        gradedCard: event.data.gradedCard,
        storageLocationId: event.data.storageLocationId,
        totalQuantity: event.data.totalQuantity,
        acquisitionCostAmount: event.data.acquisitionCostAmount,
      };
    case "inventory.item.adjusted":
      return {
        ...state,
        totalQuantity: state.totalQuantity + event.data.quantityDelta,
      };
    case "inventory.item.stock-authority-claimed":
      return state;
    default:
      return assertNever(event);
  }
};

function requireCreatedInventoryItem(state: InventoryItemState) {
  assert(state.id !== null, "Inventory item must be created first.");
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeGradedCardDetails(details: GradedCardDetails | null): GradedCardDetails | null {
  if (!details) {
    return null;
  }

  const gradingCompany = normalizeLabel(details.gradingCompany);
  const grade = normalizeLabel(details.grade);
  assert(gradingCompany.length > 0, "Graded cards require a grading company.");
  assert(grade.length > 0, "Graded cards require a grade.");

  const population = details.population
    ? {
        populationAtGrade: details.population.populationAtGrade,
        populationHigher: details.population.populationHigher,
        source: normalizeOptionalText(details.population.source),
        asOf: normalizeOptionalText(details.population.asOf),
      }
    : null;

  if (population) {
    for (const value of [population.populationAtGrade, population.populationHigher]) {
      assert(
        value === null || (Number.isInteger(value) && value >= 0),
        "Population metadata must use whole numbers greater than or equal to zero.",
      );
    }
  }

  return {
    gradingCompany,
    grade,
    certificationNumber: normalizeOptionalText(details.certificationNumber),
    population,
    conditionDescriptors: [
      ...new Set(
        details.conditionDescriptors
          .map((descriptor) => descriptor.trim())
          .filter((descriptor) => descriptor.length > 0),
      ),
    ],
  };
}
