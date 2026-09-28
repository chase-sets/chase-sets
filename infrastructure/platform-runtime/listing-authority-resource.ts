import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AggregateSnapshotStore } from "@chase-sets/event-core/aggregate-snapshot-store";
import type { AppendToStreamInput, EventRecordToStore } from "@chase-sets/event-core/storage";
import type { ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";
import type { JsonObject } from "@chase-sets/primitives/json";
import { assertSameAuthority, authorityHash, authorityValue } from "./listing-authority-state";
import { prepareAuthorityAppend, prepareAuthorityAppends, readAuthorityJournal } from "./listing-authority-journal";

type InvalidationIntent = Readonly<{ mutationId: string; command: JsonObject }>;
type ResourceState = { pending: InvalidationIntent | null; grants: ListingAuthorityReservation[] };

/** Resource, integrity and registration histories share one atomic append. The
 * independent registration distinguishes joint resource/integrity loss from
 * initial admission. No witness or disposable snapshot reconstructs lost grants.
 */
export function createListingAuthorityResources(
  deps: Readonly<{
    store: EventStore;
    prefix: string;
    snapshots?: AggregateSnapshotStore;
  }>,
) {
  const { store, prefix } = deps;
  const empty = (): ResourceState => ({ pending: null, grants: [] });
  const stateHash = (state: ResourceState) =>
    authorityHash({
      pending: state.pending,
      grants: [...state.grants].sort((a, b) => a.reservationId.localeCompare(b.reservationId)),
    });
  function fold(state: ResourceState, event: Pick<EventRecordToStore, "eventType" | "payload">): ResourceState {
    const grants = new Map(state.grants.map((grant) => [grant.reservationId, grant]));
    let pending = state.pending;
    if (event.eventType === `${prefix}.reserved`) {
      const grant = authorityValue<ListingAuthorityReservation>(event.payload.reservation);
      if (grants.has(grant.reservationId)) throw new Error("Duplicate authority resource reservation.");
      grants.set(grant.reservationId, grant);
    } else if (event.eventType === `${prefix}.settled`) {
      if (!grants.delete(String(event.payload.reservationId)))
        throw new Error("Missing authority resource membership; retain source promise.");
    } else if (event.eventType === `${prefix}.invalidation-started`) {
      if (pending) throw new Error("Authority resource already closed.");
      pending = authorityValue<InvalidationIntent>(event.payload.invalidation);
    } else if (event.eventType === `${prefix}.invalidation-completed`) {
      if (!pending || pending.mutationId !== event.payload.mutationId)
        throw new Error("Contradictory authority resource invalidation.");
      pending = null;
    } else throw new Error("Corrupt authority resource history.");
    return { pending, grants: [...grants.values()] };
  }

  async function read(streamId: string) {
    const { events, version, histories } = await readAuthorityJournal(store, streamId);
    let state = empty();
    // Only the complete validated canonical sequence owns membership and closure.
    // Witness fold hashes may reject contradictions, never seed or skip a fold.
    for (const event of events) {
      state = fold(state, event);
    }
    if (events.length) assertSameAuthority(histories[1]!.at(-1)!.payload.stateHash, stateHash(state));
    if (version && events.length && deps.snapshots) {
      try {
        await deps.snapshots.save({ streamId, streamVersion: version, schemaVersion: 1, state });
      } catch {
        /* Disposable fold cache only. */
      }
    }
    return {
      streamId,
      version,
      pending: state.pending,
      grants: new Map(state.grants.map((grant) => [grant.reservationId, grant])),
    };
  }

  async function append(inputs: readonly AppendToStreamInput[]) {
    if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
    const appends: AppendToStreamInput[] = [];
    for (const input of inputs) {
      if (!input.streamId.startsWith(`${prefix}-resource-`)) {
        appends.push(input);
        continue;
      }
      const current = await read(input.streamId);
      if (input.expectedVersion !== current.version)
        throw createEventStoreError("concurrency_conflict", "Authority resource changed before atomic append.");
      let state: ResourceState = { pending: current.pending, grants: [...current.grants.values()] };
      appends.push(
        ...(await prepareAuthorityAppend(
          store,
          input,
          input.events.map((event) => {
            state = fold(state, event);
            return { stateHash: stateHash(state) };
          }),
        )),
      );
    }
    return store.appendToStreams(await prepareAuthorityAppends(store, appends));
  }
  return { read, append };
}
