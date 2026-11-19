import { createEventStoreError } from "@chase-sets/event-core/event-store";
import type { ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { withConfigurationEpochTransaction } from "./configuration-epoch";
import {
  applyOwnerStreamInvalidationInTransaction,
  beginOwnerStreamInvalidationInTransaction,
  lockOwnerStreamInvalidationsInTransaction,
  reserveOwnerStreamInTransaction,
  settleOriginalTerminals,
} from "./owner-stream-reservation";
import type { PgPoolClient, PgQueryable, PgTransactionalPool } from "./types";

// A membership is one concrete predicate, not an account cohort or a projection row.
export function ownerPredicateKey(kind: string, ...parts: readonly string[]): string {
  return `predicate:${JSON.stringify([kind, ...parts])}`;
}

export type OwnerPredicateAppendEnrollment = Readonly<{
  keys: (inputs: readonly AppendToStreamInput[]) => readonly string[];
  consumerPool?: PgTransactionalPool;
}>;

/** Capture under the same lock as the canonical owner value, before registering the member. */
export async function readOwnerPredicateSealInTransaction(client: PgQueryable, key: string) {
  await lockOwnerStreamInvalidationsInTransaction(client, [key]);
  const result = await client.query<{ incarnation: string; generation: string }>(
    `SELECT identity.incarnation, COALESCE(invalidations.generation, 0)::text AS generation
     FROM event_configuration_store_identity identity
     LEFT JOIN event_owner_stream_invalidations invalidations ON invalidations.owner_stream_id = $1
     WHERE identity.singleton = true`,
    [key],
  );
  const row = result.rows[0];
  return row && { storeIncarnation: row.incarnation, version: Number(row.generation) };
}

/** Registers an exact synthetic or future decision member; does not grant acceptance authority. */
export function reserveOwnerPredicateInTransaction(client: PgQueryable, input: ReserveOwnerStreamInput) {
  if (!input.ownerStreamId.startsWith("predicate:") || input.ownerStreamId !== input.resourceKey)
    throw createEventStoreError("concurrency_conflict", "Invalid owner predicate membership.");
  return reserveOwnerStreamInTransaction(client, input, undefined, readOwnerPredicateSealInTransaction);
}

class OwnerPredicateSettlementRequired extends Error {
  constructor(readonly keys: readonly string[]) {
    super("Owner predicate settlement required before write.");
  }
}

/** Call before the physical write, using its transaction. APPLIED rolls back if the write does. */
export async function enrollOwnerPredicateWriteInTransaction(client: PgQueryable, keys: readonly string[]) {
  if (!keys.length) return;
  const ordered = [...new Set(keys)].sort();
  await lockOwnerStreamInvalidationsInTransaction(client, ordered);
  for (const key of ordered) {
    const intent = await beginOwnerStreamInvalidationInTransaction(client, key);
    const applied = await applyOwnerStreamInvalidationInTransaction(client, intent, async () => undefined);
    if (applied.status !== "APPLIED") throw new OwnerPredicateSettlementRequired(ordered);
  }
}

/** Work must be replayable and all its effects must be local to the supplied transaction. */
export async function withOwnerPredicateWrite<T>(
  ownerPool: PgTransactionalPool,
  consumerPool: PgTransactionalPool | undefined,
  work: (client: PgPoolClient) => Promise<T>,
  options: Readonly<{ afterCommit?: (client: PgPoolClient, result: T) => Promise<void> }> = {},
): Promise<T> {
  const durableOwner = ownerPool.independentConnectionPool ?? ownerPool;
  const durableConsumer = consumerPool?.independentConnectionPool ?? consumerPool;
  for (const drive of [true, false]) {
    try {
      return await withConfigurationEpochTransaction(ownerPool, work, options);
    } catch (error) {
      if (!(error instanceof OwnerPredicateSettlementRequired)) throw error;
      // Partial business work and its locks have rolled back. Projection callers
      // can roll back their enclosing transaction without losing this close.
      await withConfigurationEpochTransaction(durableOwner, async (client) => {
        await lockOwnerStreamInvalidationsInTransaction(client, error.keys);
        for (const key of error.keys) await beginOwnerStreamInvalidationInTransaction(client, key);
      });
      if (drive) for (const key of error.keys) await settleOriginalTerminals(durableOwner, durableConsumer, key);
    }
  }
  throw createEventStoreError("concurrency_conflict", "Owner predicate write pending original terminal settlement.");
}
