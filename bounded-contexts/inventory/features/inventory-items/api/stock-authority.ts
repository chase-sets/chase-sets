import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { reservationIdentity } from "@chase-sets/event-core/owner-stream-reservation";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";
import {
  createPostgresProjectionStore,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { createInventoryChannelStockAllocationRuntime } from "../../channel-allocations/api/runtime";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../domain/domain";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { loadAuthoritativeInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
import {
  STOCK_OWNER_LOCK_SQL,
  stockOwnerStreams,
  type InventoryStockReservations,
  type InventoryStockReservationInput,
} from "./stock-reservations";

export type InventoryStockTarget = Readonly<{
  listingId: string;
  accountId: string;
  inventoryItemId: string;
  channelConnectionId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly InventorySelectedOptionEntry[];
}>;

export function createInventoryStockAuthority(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
  reservations: InventoryStockReservations,
) {
  async function captureInTransaction(db: PgQueryable, target: InventoryStockTarget, context: EventStoreContext) {
    if (
      !target.listingId ||
      !target.inventoryItemId ||
      !target.channelConnectionId ||
      context.audit.forAccountId !== target.accountId
    )
      throw new InventoryDomainError("Inventory stock target is not authorized.");
    const streams = stockOwnerStreams(target.inventoryItemId);
    for (const stream of streams) await db.query(STOCK_OWNER_LOCK_SQL, [stream]);
    const incarnation = await reservations.identity(db);
    const eventStore = {
      ...reservations.persistence,
      readStream: (input: Parameters<PostgresEventStore["readStream"]>[0]) => store.readStreamInTransaction(db, input),
    };
    const deps = { db, eventStore, checkpointStore: createPostgresProjectionStore({ db }) };
    const { repository } = createAggregateCommandHandler({
      eventStore,
      codec: createPassthroughDomainEventCodec<InventoryItemEvent>(),
      initialState: () => initialInventoryItemState,
      evolve: evolveInventoryItem,
      decide: decideInventoryItem,
    });
    const item = await repository.load(`inventory.item-${target.inventoryItemId}`);
    const stock = await loadAuthoritativeInventoryStockSnapshot({
      ...deps,
      itemRepository: repository,
      itemAggregate: item,
      itemId: target.inventoryItemId,
      accountId: target.accountId as AccountId,
      context,
    });
    const allocation = await createInventoryChannelStockAllocationRuntime(deps).readAuthoritative({
      accountId: target.accountId,
      inventoryItemId: target.inventoryItemId,
    });
    if (
      "code" in allocation ||
      allocation.revision <= 0 ||
      allocation.accountId !== target.accountId ||
      allocation.inventoryItemId !== target.inventoryItemId ||
      (allocation.mode !== "shared-pool" &&
        !allocation.partitions.some(
          (partition) => partition.channelConnectionId === target.channelConnectionId && partition.units > 0,
        )) ||
      stock.availableQuantity <= 0 ||
      item.state.catalogItemId !== target.catalogItemId ||
      item.state.productId !== target.productId ||
      reservationIdentity(item.state.selectedOptions) !== reservationIdentity(target.selectedOptions)
    )
      throw new InventoryDomainError("Inventory canonical stock or allocation does not authorize this target.");
    return { target, stock, allocation, itemVersion: item.version, incarnation };
  }
  return {
    capture: (target: InventoryStockTarget, context: EventStoreContext) =>
      withConfigurationEpochTransaction(pool, (db) => captureInTransaction(db, target, context)),
    async prepare(
      capture: Awaited<ReturnType<typeof captureInTransaction>>,
      input: InventoryStockReservationInput,
      context: EventStoreContext,
    ) {
      return withConfigurationEpochTransaction(pool, async (db) => {
        const current = await captureInTransaction(db, capture.target, context);
        if (
          reservationIdentity(current) !== reservationIdentity(capture) ||
          reservationIdentity(input.target) !== reservationIdentity(capture.target)
        )
          throw new InventoryDomainError("Inventory stock capture is no longer current or target binding changed.");
        const streams = stockOwnerStreams(capture.target.inventoryItemId);
        const prepared = [];
        for (let index = 0; index < streams.length; index++) {
          prepared.push(
            await reservations.reserveInTransaction(db, {
              ...input,
              reservationId: `${input.reservationId}:${index === 0 ? "allocation" : "item"}`,
              ownerStreamId: streams[index],
              resourceKey: `stock/${capture.target.accountId}/${capture.target.inventoryItemId}`,
              seal: {
                version: index === 0 ? capture.allocation.revision : capture.itemVersion,
                storeIncarnation: capture.incarnation,
              },
            }),
          );
        }
        return prepared;
      });
    },
  };
}

export type InventoryStockAuthority = ReturnType<typeof createInventoryStockAuthority>;
