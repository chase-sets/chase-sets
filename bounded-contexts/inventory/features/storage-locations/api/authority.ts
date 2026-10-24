import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  decideStorageLocation,
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationEvent,
} from "../domain/domain";

export function createStorageLocationAuthority(pool: PgTransactionalPool) {
  const { repository } = createAggregateCommandHandler({
    eventStore: createPostgresEventStore({ pool }),
    codec: createPassthroughDomainEventCodec<StorageLocationEvent>(),
    initialState: () => initialStorageLocationState,
    evolve: evolveStorageLocation,
    decide: decideStorageLocation,
  });

  return {
    async resolveStorageLocationAuthority(input: Readonly<{ accountId: string; storageLocationId: string }>) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "accountId" && key !== "storageLocationId") ||
        typeof input.accountId !== "string" ||
        input.accountId.length === 0 ||
        typeof input.storageLocationId !== "string" ||
        input.storageLocationId.length === 0
      ) {
        throw new Error("Invalid storage location authority input.");
      }
      const loaded = await repository.load(`inventory.storage-location-${input.storageLocationId}`);
      if (loaded.state.id !== input.storageLocationId || loaded.state.accountId !== input.accountId) return null;
      return {
        accountId: loaded.state.accountId,
        storageLocationId: loaded.state.id,
        revision: loaded.version,
        status: loaded.state.isArchived ? ("retired" as const) : ("active" as const),
      };
    },
  };
}
