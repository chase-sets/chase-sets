import { randomUUID } from "node:crypto";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import { reservationIdentity, type ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  applyOwnerStreamInvalidationInTransaction,
  beginOwnerStreamInvalidationInTransaction,
  createPostgresOwnerStreamReservationStore,
  reserveOwnerStreamInTransaction,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgPoolClient,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { InventoryDomainError } from "../../../support/runtime-support/common";

export const STOCK_OWNER_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('owner_stream:' || $1::text, 0))";

export function stockOwnerStreams(itemId: string): readonly string[] {
  return [`inventory.channel-stock-allocation-${itemId}`, `inventory.item-${itemId}`];
}

export class InventoryStockChangePending extends InventoryDomainError {
  constructor(readonly ownerStreamIds: readonly string[]) {
    super("Inventory stock change pending; durable reservation invalidation must settle before application.");
  }
}

class StockClosureRequired extends Error {
  constructor(readonly ownerStreamIds: readonly string[]) {
    super("Inventory stock reservation closure required");
  }
}

class StockReadyForApplication extends Error {}

export async function enrollInventoryStockStreamsInTransaction(db: PgQueryable, ownerStreamIds: readonly string[]) {
  const streams = [...new Set(ownerStreamIds)].sort();
  for (const stream of streams) await db.query(STOCK_OWNER_LOCK_SQL, [stream]);
  const pending: string[] = [];
  for (const stream of streams) {
    const intent = await beginOwnerStreamInvalidationInTransaction(db, stream);
    const applied = await applyOwnerStreamInvalidationInTransaction(db, intent, async () => undefined);
    if (applied.status !== "APPLIED") pending.push(stream);
  }
  if (pending.length) throw new StockClosureRequired(pending);
}

/** All physical Item, allocation and Hold writes, including replay, cross this fence. */
export function createInventoryStockReservations(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
  consumerPool: PgTransactionalPool = pool,
) {
  const protocol = createPostgresOwnerStreamReservationStore({
    ownerPool: pool,
    consumerPool,
    applyInvalidation: async () => {
      // Only the business writer transaction may commit APPLIED.
      throw new StockReadyForApplication();
    },
    applyInboundEvidence: async () => {
      throw new InventoryDomainError("Inbound sales settle through the Inventory sale runtime.");
    },
  });

  async function identity(db: PgQueryable) {
    await db.query(
      "INSERT INTO event_configuration_store_identity (singleton, store_id, incarnation) VALUES (true, 'inventory', $1) ON CONFLICT DO NOTHING",
      [randomUUID()],
    );
    const result = await db.query<{ store_id: string; incarnation: string }>(
      "SELECT store_id, incarnation FROM event_configuration_store_identity WHERE singleton = true",
    );
    if (result.rows.length !== 1 || result.rows[0].store_id !== "inventory")
      throw new InventoryDomainError("Inventory source incarnation unavailable.");
    return result.rows[0].incarnation;
  }

  async function writerStreams(db: PgQueryable, inputs: readonly AppendToStreamInput[]) {
    const ids = new Set<string>();
    for (const input of inputs) {
      if (!input.events.length) continue;
      let itemId: string | undefined;
      if (input.streamId.startsWith("inventory.item-")) itemId = input.streamId.slice("inventory.item-".length);
      else if (input.streamId.startsWith("inventory.channel-stock-allocation-"))
        itemId = input.streamId.slice("inventory.channel-stock-allocation-".length);
      else if (
        input.streamId.startsWith("inventory.hold-") &&
        !input.streamId.startsWith("inventory.hold-collision-")
      ) {
        const placed = input.events.find((event) => event.eventType === "inventory.hold.placed")?.payload;
        const first =
          placed ?? (await store.readStreamInTransaction(db, { streamId: input.streamId, limit: 1 }))[0]?.payload;
        if (!first || typeof first.itemId !== "string")
          throw new InventoryDomainError("Inventory Hold stock identity unavailable.");
        itemId = first.itemId;
      }
      if (itemId) for (const stream of stockOwnerStreams(itemId)) ids.add(stream);
    }
    return [...ids].sort();
  }

  async function enroll(db: PgQueryable, inputs: readonly AppendToStreamInput[]) {
    const streams = await writerStreams(db, inputs);
    await enrollInventoryStockStreamsInTransaction(db, streams);
  }

  async function transaction<T>(work: (db: PgPoolClient) => Promise<T>): Promise<T> {
    async function attempt() {
      return withConfigurationEpochTransaction(pool, async (db) => {
        await db.query("SAVEPOINT inventory_stock_work");
        try {
          return { kind: "applied" as const, value: await work(db) };
        } catch (error) {
          if (!(error instanceof StockClosureRequired)) throw error;
          await db.query("ROLLBACK TO SAVEPOINT inventory_stock_work");
          for (const stream of error.ownerStreamIds) await beginOwnerStreamInvalidationInTransaction(db, stream);
          return { kind: "pending" as const, streams: error.ownerStreamIds };
        }
      });
    }
    const first = await attempt();
    if (first.kind === "applied") return first.value;
    // The writer transaction has committed its intent and released every lock.
    for (const stream of first.streams) {
      if (!(await releaseOriginalReservations(stream))) throw new InventoryStockChangePending(first.streams);
    }
    const next = await attempt();
    if (next.kind !== "applied") throw new InventoryStockChangePending(next.streams);
    return next.value;
  }

  async function appendInTransaction(db: PgQueryable, inputs: readonly AppendToStreamInput[]) {
    await enroll(db, inputs);
    const results = await store.appendToStreamsInTransaction(db, inputs);
    await markInboundApplied(db, inputs);
    return results;
  }

  async function appendSingleInTransaction(db: PgQueryable, input: AppendToStreamInput) {
    await enroll(db, [input]);
    const events = await store.appendToStreamInTransaction(db, input);
    await markInboundApplied(db, [input]);
    return events;
  }

  async function markInboundApplied(db: PgQueryable, inputs: readonly AppendToStreamInput[]) {
    for (const input of inputs) {
      if (input.events.some((event) => event.eventType === "inventory.external-channel-sale.recorded"))
        await db.query("UPDATE event_owner_stream_inbound_evidence SET status = 'APPLIED' WHERE evidence_id = $1", [
          input.streamId,
        ]);
    }
  }

  const persistence: EventStore = {
    readStream: (input) => store.readStream(input),
    readAll: (input) => store.readAll(input),
    appendToStreams: (inputs) => transaction((db) => appendInTransaction(db, inputs)),
    appendToStream: async (input) => {
      if (input.requestTerminal || input.configurationGrants?.length)
        throw createEventStoreError(
          "concurrency_conflict",
          "Request terminals and configuration grants require appendToStreams.",
        );
      if (!input.events.length) return [];
      return transaction((db) => appendSingleInTransaction(db, input));
    },
  };

  async function recordInboundSale(
    evidenceId: string,
    resourceKey: string,
    command: Readonly<Record<string, unknown>>,
    context: EventStoreContext,
  ) {
    const prior = await pool.query<{
      payload: { command: Readonly<Record<string, unknown>>; context: EventStoreContext };
    }>("SELECT payload FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1", [evidenceId]);
    const payload = prior.rows[0]?.payload ?? {
      command,
      context: { tenantId: context.tenantId, audit: context.audit },
    };
    if (reservationIdentity(payload.command) !== reservationIdentity(command))
      throw new InventoryDomainError("Inbound sale identity was reused.");
    return protocol.recordInboundEvidence({ evidenceId, resourceKey, payload });
  }

  async function status(ownerStreamId: string) {
    const result = await pool.query<{ generation: string; status: "PENDING" | "ABORT-REQUESTED" | "APPLIED" }>(
      "SELECT generation::text, status FROM event_owner_stream_invalidations WHERE owner_stream_id = $1",
      [ownerStreamId],
    );
    return result.rows[0] ?? null;
  }

  async function invalidateStock(itemId: string) {
    const streams = stockOwnerStreams(itemId);
    await withConfigurationEpochTransaction(pool, async (db) => {
      for (const stream of streams) await beginOwnerStreamInvalidationInTransaction(db, stream);
    });
    for (const stream of streams) await releaseOriginalReservations(stream);
    return Promise.all(streams.map(status));
  }

  async function releaseOriginalReservations(stream: string) {
    try {
      return (await protocol.driveInvalidation(stream)).status === "APPLIED";
    } catch (error) {
      if (error instanceof StockReadyForApplication) return true;
      throw error;
    }
  }

  return {
    identity,
    protocol,
    persistence,
    transaction,
    enroll,
    appendInTransaction,
    appendSingleInTransaction,
    recordInboundSale,
    status,
    invalidateStock,
    reserveInTransaction: reserveOwnerStreamInTransaction,
  };
}

export type InventoryStockReservations = ReturnType<typeof createInventoryStockReservations>;
export type InventoryStockReservationInput = Omit<
  ReserveOwnerStreamInput,
  "ownerStreamId" | "seal" | "resourceKey" | "reservationId"
> &
  Readonly<{ reservationId: string }>;
