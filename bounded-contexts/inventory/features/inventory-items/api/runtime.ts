import { createId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, CatalogItemId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { InventoryAdjustmentSourceRef } from "@chase-sets/event-core/public-event-payloads";
import type { InventoryCatalogItemServices } from "../integrations/catalog/runtime";
import {
  createInventoryProductDescriptor,
  parseSelectedOptionsInput,
  summarizeSelectedOptions,
  type InventorySelectedOptionEntry,
} from "../integrations/catalog/versioning";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  loadAuthoritativeInventoryStockSnapshot,
  loadInventoryStockSnapshot,
  type InventoryItemRepository,
} from "../../../support/runtime-support/stock-snapshot";
import { getStorageLocation } from "../../storage-locations/read-model/queries";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type GradedCardDetails,
  type InventoryItemCommand,
  type InventoryItemEvent,
  type InventoryItemState,
} from "../domain/domain";
import { createInventoryItemAdjustedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import { buildInventoryItemProjectionHandlers } from "../read-model/projection";
import { buildInventoryItemLedgerProjectionHandlers } from "../read-model/ledger-projection";
import { getInventoryItem, getInventoryItemForListingStock, listInventoryItems } from "../read-model/queries";
import type { InventoryEnsuredListingStock } from "./contracts";

const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const LISTING_STOCK_LOCATION_DESCRIPTION = "Auto-managed stock backing standard marketplace listings.";

function createListingStockInventoryItemId(
  input: Readonly<{
    accountId: string;
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    gradedCard: GradedCardDetails | null;
    storageLocationId: string;
  }>,
) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);

  return `inv_listing_stock_${hash}` as InventoryItemId;
}

export type InventoryItemServices = Readonly<{
  commandHandler: CommandHandler<InventoryItemCommand, InventoryItemState, InventoryItemEvent>;
  createItem: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      gradedCard?: GradedCardDetails | null;
      storageLocationId: string;
      totalQuantity: number;
      acquisitionCostAmount?: string | null;
      itemIdOverride?: InventoryItemId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ itemId: InventoryItemId; version: number }>;
  adjustItem: (
    params: Readonly<{
      accountId: string;
      itemId: string;
      quantityDelta: number;
      reason: string;
      idempotencyKey?: string | null;
      sourceRef?: InventoryAdjustmentSourceRef;
    }>,
    context: EventStoreContext,
  ) => Promise<{ itemId: string; version: number }>;
  listItems: (params: Parameters<typeof listInventoryItems>[1]) => ReturnType<typeof listInventoryItems>;
  getItem: (itemId: string, accountId: string) => ReturnType<typeof getInventoryItem>;
  ensureListingStock: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      gradedCard?: GradedCardDetails | null;
      quantity: number;
      shipFromCode?: string | null;
      shipFromAddress?: AddressSnapshot | null;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryEnsuredListingStock>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryItemRuntime(
  deps: InventoryRuntimeDeps,
  catalogItems: InventoryCatalogItemServices,
  storageLocations: StorageLocationServices,
): InventoryItemServices {
  const codec = createPassthroughDomainEventCodec<InventoryItemEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  });

  async function findDefaultListingStockLocation(accountId: string) {
    const locations = await storageLocations.listStorageLocations({
      accountId,
      includeArchived: false,
    });

    return locations.find((location) => location.name === LISTING_STOCK_LOCATION_NAME) ?? null;
  }

  async function upsertStorageLocationReadModel(
    params: Readonly<{
      storageLocationId: string;
      accountId: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
    }>,
  ) {
    await deps.db.query(
      `INSERT INTO inventory_storage_locations (
         storage_location_id,
         account_id,
         name,
         description,
         ship_from_code,
         ship_from_address,
         is_archived,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, now())
       ON CONFLICT (storage_location_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         ship_from_code = EXCLUDED.ship_from_code,
         ship_from_address = EXCLUDED.ship_from_address,
         is_archived = false,
         updated_at = EXCLUDED.updated_at`,
      [
        params.storageLocationId,
        params.accountId,
        LISTING_STOCK_LOCATION_NAME,
        LISTING_STOCK_LOCATION_DESCRIPTION,
        params.shipFromCode,
        JSON.stringify(params.shipFromAddress),
      ],
    );
  }

  return {
    commandHandler,
    createItem: async (params, context) => {
      const location = await getStorageLocation(deps.db, params.storageLocationId, params.accountId);

      if (!location) {
        throw new InventoryDomainError("Storage location not found.");
      }

      if (location.is_archived) {
        throw new InventoryDomainError("Archived storage locations cannot receive new inventory items.");
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError("Inventory items may only reference active catalog items.");
      }

      const catalogVersion = createInventoryProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema: catalogItem.product_schema,
        selection: parseSelectedOptionsInput(params.selectedOptions),
      });
      const productSummary = summarizeSelectedOptions(catalogItem.product_schema, catalogVersion.selection);
      const isGradedCard = productSummary.includes("Form: Graded");

      if (isGradedCard && !params.gradedCard) {
        throw new InventoryDomainError("Graded inventory items require graded card details.");
      }

      if (!isGradedCard && params.gradedCard) {
        throw new InventoryDomainError("Graded card details are only allowed for graded inventory items.");
      }

      const itemId = params.itemIdOverride ?? (createId("inv") as InventoryItemId);
      const streamId = `inventory.item-${itemId}`;
      const existing = await repository.load(streamId);
      if (existing.state.id !== null) {
        return {
          itemId,
          version: existing.version,
        };
      }

      const result = await commandHandler({
        streamId,
        command: {
          type: "CreateInventoryItem",
          itemId,
          accountId: params.accountId,
          csatOutcomeFact: createInventoryItemAdjustedCsatOutcomeFact({
            accountId: params.accountId,
            itemId,
            idempotencyKey: `inventory:item.adjusted:${itemId}:created`,
          }),
          catalogItemId: params.catalogItemId as CatalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard: params.gradedCard ?? null,
          storageLocationId: params.storageLocationId,
          totalQuantity: params.totalQuantity,
          acquisitionCostAmount: params.acquisitionCostAmount ?? null,
        },
        context,
      });

      return {
        itemId,
        version: result.version,
      };
    },
    adjustItem: async (params, context) => {
      const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
      const commandFingerprint = inventoryAdjustmentCommandFingerprint({
        accountId: params.accountId,
        itemId: params.itemId,
        quantityDelta: params.quantityDelta,
        reason: params.reason,
        sourceRef: params.sourceRef ?? null,
      });
      if (idempotencyKey) {
        const existing = await claimInventoryAdjustmentIdempotency(deps.db, {
          idempotencyKey,
          accountId: params.accountId,
          itemId: params.itemId,
          commandFingerprint,
        });
        if (existing) {
          if (existing.command_fingerprint !== commandFingerprint) {
            throw new InventoryDomainError("Inventory adjustment idempotency key was reused for different input.");
          }
          if (existing.status === "completed" && existing.result_item_id && existing.result_version !== null) {
            return {
              itemId: existing.result_item_id,
              version: Number(existing.result_version),
            };
          }
          const recovered = await recoverInventoryAdjustmentIdempotency(deps, {
            existing,
            idempotencyKey,
            accountId: params.accountId,
            itemId: params.itemId,
            quantityDelta: params.quantityDelta,
            reason: params.reason,
            sourceRef: params.sourceRef ?? null,
          });
          if (recovered) {
            return recovered;
          }
          throw new InventoryDomainError("Inventory adjustment idempotency key is already being processed.");
        }
      }

      let resultVersion: number;
      try {
        const csatOutcomeFact = createInventoryItemAdjustedCsatOutcomeFact({
          accountId: params.accountId as AccountId,
          itemId: params.itemId as InventoryItemId,
          idempotencyKey: idempotencyKey ?? `inventory:item.adjusted:${params.itemId}:${commandFingerprint}`,
        });
        if (params.quantityDelta < 0) {
          resultVersion = await appendAuthoritativeNegativeAdjustment({
            deps,
            repository,
            codec,
            params,
            context,
            csatOutcomeFact,
          });
        } else {
          const stock = await loadInventoryStockSnapshot({
            db: deps.db,
            itemRepository: repository,
            itemId: params.itemId,
            accountId: params.accountId as AccountId,
            context,
          });
          const result = await commandHandler({
            streamId: `inventory.item-${params.itemId}`,
            command: {
              type: "AdjustInventoryItemQuantity",
              csatOutcomeFact,
              quantityDelta: params.quantityDelta,
              heldQuantity: stock.heldQuantity,
              reason: params.reason,
              sourceRef: params.sourceRef ?? null,
            },
            context,
          });
          resultVersion = result.version;
        }
      } catch (error) {
        if (idempotencyKey) {
          await releaseInventoryAdjustmentIdempotency(deps.db, idempotencyKey);
        }
        throw error;
      }

      if (idempotencyKey) {
        await completeInventoryAdjustmentIdempotency(deps.db, {
          idempotencyKey,
          resultItemId: params.itemId,
          resultVersion,
        });
      }

      return {
        itemId: params.itemId,
        version: resultVersion,
      };
    },
    listItems: (params) => listInventoryItems(deps.db, params),
    getItem: (itemId, accountId) => getInventoryItem(deps.db, itemId, accountId),
    ensureListingStock: async (params, context) => {
      if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
        throw new InventoryDomainError("Listing stock quantity must be a positive whole number.");
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError("Listing stock may only reference active catalog items.");
      }

      const catalogVersion = createInventoryProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema: catalogItem.product_schema,
        selection: parseSelectedOptionsInput(params.selectedOptions),
      });
      const productSummary = summarizeSelectedOptions(catalogItem.product_schema, catalogVersion.selection);
      const gradedCard = params.gradedCard ?? null;
      const isGradedCard = productSummary.includes("Form: Graded");

      if (isGradedCard && !gradedCard) {
        throw new InventoryDomainError("Graded listing stock requires graded card details.");
      }

      if (!isGradedCard && gradedCard) {
        throw new InventoryDomainError("Graded card details are only allowed for graded listing stock.");
      }

      let location = await findDefaultListingStockLocation(params.accountId);
      let createdStorageLocation = false;

      if (!location) {
        if (!params.shipFromAddress) {
          throw new InventoryDomainError("Ship-from address is required before creating listing stock.");
        }

        const created = await storageLocations.createStorageLocation(
          {
            accountId: params.accountId,
            name: LISTING_STOCK_LOCATION_NAME,
            description: LISTING_STOCK_LOCATION_DESCRIPTION,
            shipFromCode: params.shipFromCode?.trim() || "LISTING-STOCK",
            shipFromAddress: params.shipFromAddress,
          },
          context,
        );
        createdStorageLocation = true;
        await upsertStorageLocationReadModel({
          storageLocationId: created.storageLocationId,
          accountId: params.accountId,
          shipFromCode: params.shipFromCode?.trim() || "LISTING-STOCK",
          shipFromAddress: params.shipFromAddress,
        });
        location = await getStorageLocation(deps.db, created.storageLocationId, params.accountId);
      }

      if (!location) {
        throw new InventoryDomainError("Listing stock location could not be loaded.");
      }

      const existingItem = await getInventoryItemForListingStock(deps.db, {
        itemId: createListingStockInventoryItemId({
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
        }),
        accountId: params.accountId,
        catalogItemId: params.catalogItemId,
        productId: catalogVersion.productId,
        selectedOptions: catalogVersion.selection,
        gradedCard,
        storageLocationId: location.storage_location_id,
      });

      let inventoryItemId = existingItem?.item_id ?? null;
      let createdInventoryItem = false;
      let adjustedQuantityBy = 0;
      let totalQuantity = existingItem?.total_quantity ?? 0;
      let availableQuantity = existingItem?.available_quantity ?? 0;

      if (!inventoryItemId) {
        const itemId = createListingStockInventoryItemId({
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
        });
        await commandHandler({
          streamId: `inventory.item-${itemId}`,
          command: {
            type: "CreateInventoryItem",
            itemId,
            accountId: params.accountId,
            csatOutcomeFact: createInventoryItemAdjustedCsatOutcomeFact({
              accountId: params.accountId,
              itemId,
              idempotencyKey: `inventory:item.adjusted:${itemId}:listing-stock-created`,
            }),
            catalogItemId: params.catalogItemId as CatalogItemId,
            productId: catalogVersion.productId,
            selectedOptions: catalogVersion.selection,
            gradedCard,
            storageLocationId: location.storage_location_id,
            totalQuantity: params.quantity,
            acquisitionCostAmount: null,
          },
          context,
        });
        inventoryItemId = itemId;
        createdInventoryItem = true;
        totalQuantity = params.quantity;
        availableQuantity = params.quantity;
      } else if (availableQuantity < params.quantity) {
        adjustedQuantityBy = params.quantity - availableQuantity;
        await commandHandler({
          streamId: `inventory.item-${inventoryItemId}`,
          command: {
            type: "AdjustInventoryItemQuantity",
            csatOutcomeFact: createInventoryItemAdjustedCsatOutcomeFact({
              accountId: params.accountId,
              itemId: inventoryItemId,
              idempotencyKey: `inventory:item.adjusted:${inventoryItemId}:listing-stock:${params.quantity}`,
            }),
            quantityDelta: adjustedQuantityBy,
            heldQuantity: existingItem?.held_quantity ?? 0,
            reason: "Automatic listing stock",
          },
          context,
        });
        totalQuantity += adjustedQuantityBy;
        availableQuantity += adjustedQuantityBy;
      }

      if (!inventoryItemId) {
        throw new InventoryDomainError("Listing stock item could not be created.");
      }

      return {
        inventoryItemId,
        storageLocationId: location.storage_location_id,
        createdStorageLocation,
        createdInventoryItem,
        adjustedQuantityBy,
        snapshot: {
          inventoryItemId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
          storageLocationName: location.name,
          shipFromCode: location.ship_from_code,
          shipFromAddress: location.ship_from_address,
          totalQuantity,
          availableQuantity,
          acquisitionCostAmount: null,
        },
      };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-item-ledger-projection",
        handlers: buildInventoryItemLedgerProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "inventory-item-projection",
        handlers: buildInventoryItemProjectionHandlers(deps.db),
      }),
    ],
  };
}

async function appendAuthoritativeNegativeAdjustment(
  input: Readonly<{
    deps: InventoryRuntimeDeps;
    repository: InventoryItemRepository;
    codec: ReturnType<typeof createPassthroughDomainEventCodec<InventoryItemEvent>>;
    params: Readonly<{
      accountId: string;
      itemId: string;
      quantityDelta: number;
      reason: string;
      sourceRef?: InventoryAdjustmentSourceRef;
    }>;
    context: EventStoreContext;
    csatOutcomeFact: JsonObject;
  }>,
): Promise<number> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const aggregate = await input.repository.load(`inventory.item-${input.params.itemId}`);
    const stock = await loadAuthoritativeInventoryStockSnapshot({
      db: input.deps.db,
      itemRepository: input.repository,
      itemId: input.params.itemId,
      accountId: input.params.accountId as AccountId,
      context: input.context,
      itemAggregate: aggregate,
    });
    const events = decideInventoryItem(aggregate.state, {
      type: "AdjustInventoryItemQuantity",
      csatOutcomeFact: input.csatOutcomeFact,
      quantityDelta: input.params.quantityDelta,
      heldQuantity: stock.heldQuantity,
      reason: input.params.reason,
      sourceRef: input.params.sourceRef ?? null,
    });

    try {
      const storedEvents = await input.deps.eventStore.appendToStream({
        streamId: `inventory.item-${input.params.itemId}`,
        expectedVersion: aggregate.version,
        events: events.map((event) => input.codec.encode(event)),
        context: input.context,
      });
      recordCommittedEvents(storedEvents);
      return storedEvents.at(-1)?.streamVersion ?? aggregate.version;
    } catch (error) {
      if (attempt < 3 && isConcurrencyConflict(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new InventoryDomainError("Inventory stock changed while applying the adjustment.");
}

type InventoryAdjustmentIdempotencyRow = Readonly<{
  inserted: boolean;
  command_fingerprint: string;
  status: "in_progress" | "completed";
  result_item_id: string | null;
  result_version: string | number | null;
  created_at: string | Date;
}>;

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function inventoryAdjustmentCommandFingerprint(
  input: Readonly<{
    accountId: string;
    itemId: string;
    quantityDelta: number;
    reason: string;
    sourceRef?: InventoryAdjustmentSourceRef;
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accountId: input.accountId,
        itemId: input.itemId,
        quantityDelta: input.quantityDelta,
        reason: input.reason.trim(),
        sourceRef: input.sourceRef ?? null,
      }),
    )
    .digest("hex");
}

async function claimInventoryAdjustmentIdempotency(
  db: InventoryRuntimeDeps["db"],
  input: Readonly<{
    idempotencyKey: string;
    accountId: string;
    itemId: string;
    commandFingerprint: string;
  }>,
): Promise<InventoryAdjustmentIdempotencyRow | null> {
  const result = await db.query<InventoryAdjustmentIdempotencyRow>(
    `WITH inserted AS (
       INSERT INTO inventory_item_adjustment_idempotency (
         idempotency_key,
         account_id,
         item_id,
         command_fingerprint,
         status,
         created_at
       ) VALUES ($1, $2, $3, $4, 'in_progress', now())
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING true AS inserted, command_fingerprint, status, result_item_id, result_version, created_at
     )
     SELECT inserted, command_fingerprint, status, result_item_id, result_version, created_at
     FROM inserted
     UNION ALL
     SELECT false AS inserted, command_fingerprint, status, result_item_id, result_version, created_at
     FROM inventory_item_adjustment_idempotency
     WHERE idempotency_key = $1
       AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [input.idempotencyKey, input.accountId, input.itemId, input.commandFingerprint],
  );
  const row = result.rows[0] ?? null;
  return row?.inserted ? null : row;
}

async function recoverInventoryAdjustmentIdempotency(
  deps: InventoryRuntimeDeps,
  input: Readonly<{
    existing: InventoryAdjustmentIdempotencyRow;
    idempotencyKey: string;
    accountId: string;
    itemId: string;
    quantityDelta: number;
    reason: string;
    sourceRef?: InventoryAdjustmentSourceRef;
  }>,
): Promise<{ itemId: string; version: number } | null> {
  const createdAt = new Date(input.existing.created_at).getTime();
  const normalizedReason = input.reason.trim();
  // The recovered adjustment is the LATEST match, so this fold needs the whole
  // history: reversing a capped prefix would answer with an older adjustment,
  // or none, and replay the caller's command against real stock (#6277).
  const events = await readCompleteStream(deps.eventStore, { streamId: `inventory.item-${input.itemId}` });
  const committed = [...events].reverse().find((event) => {
    if (event.eventType !== "inventory.item.adjusted") {
      return false;
    }
    if (Number.isFinite(createdAt) && new Date(event.recordedAt).getTime() < createdAt) {
      return false;
    }

    const payload = event.payload as {
      itemId?: unknown;
      quantityDelta?: unknown;
      reason?: unknown;
      sourceRef?: unknown;
    };
    return (
      payload.itemId === input.itemId &&
      payload.quantityDelta === input.quantityDelta &&
      payload.reason === normalizedReason &&
      JSON.stringify(payload.sourceRef ?? null) === JSON.stringify(input.sourceRef ?? null) &&
      event.forAccountId === input.accountId
    );
  });
  if (!committed) {
    return null;
  }

  await completeInventoryAdjustmentIdempotency(deps.db, {
    idempotencyKey: input.idempotencyKey,
    resultItemId: input.itemId,
    resultVersion: Number(committed.streamVersion),
  });

  return {
    itemId: input.itemId,
    version: Number(committed.streamVersion),
  };
}

async function completeInventoryAdjustmentIdempotency(
  db: InventoryRuntimeDeps["db"],
  input: Readonly<{ idempotencyKey: string; resultItemId: string; resultVersion: number }>,
) {
  await db.query(
    `UPDATE inventory_item_adjustment_idempotency
     SET status = 'completed',
         result_item_id = $2,
         result_version = $3,
         completed_at = now()
     WHERE idempotency_key = $1`,
    [input.idempotencyKey, input.resultItemId, input.resultVersion],
  );
}

async function releaseInventoryAdjustmentIdempotency(db: InventoryRuntimeDeps["db"], idempotencyKey: string) {
  await db.query(
    `DELETE FROM inventory_item_adjustment_idempotency
     WHERE idempotency_key = $1
       AND status = 'in_progress'`,
    [idempotencyKey],
  );
}

function isConcurrencyConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
