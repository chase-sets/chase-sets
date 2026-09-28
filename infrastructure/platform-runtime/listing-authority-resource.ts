import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AggregateSnapshotStore } from "@chase-sets/event-core/aggregate-snapshot-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
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
  const integrityStream = (streamId: string) => streamId.replace(`${prefix}-resource-`, `${prefix}-integrity-`);
  const empty = (): ResourceState => ({ pending: null, grants: [] });
  const eventHash = (event: Pick<EventRecordToStore, "eventType" | "payload">) =>
    authorityHash({ eventType: event.eventType, payload: event.payload });
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
    await readAuthorityJournal(store, streamId);
    let state = empty();
    let version = 0;
    // A disposable snapshot is usable only when both retained histories prove
    // its exact version, event and folded state. A stale/corrupt cache falls back.
    try {
      const snapshot = await deps.snapshots?.loadLatest(streamId);
      if (
        snapshot?.schemaVersion === 1 &&
        snapshot.streamId === streamId &&
        Number.isSafeInteger(snapshot.streamVersion) &&
        snapshot.streamVersion > 0
      ) {
        const candidate = snapshot.state as ResourceState;
        const [anchor, proof] = await Promise.all([
          store.readStream({ streamId, fromVersion: snapshot.streamVersion, limit: 1 }),
          store.readStream({ streamId: integrityStream(streamId), fromVersion: snapshot.streamVersion, limit: 1 }),
        ]);
        if (
          anchor[0]?.streamVersion === snapshot.streamVersion &&
          proof[0]?.streamVersion === snapshot.streamVersion &&
          proof[0].eventType === `${prefix}.history-witness` &&
          proof[0].payload.eventHash === eventHash(anchor[0]) &&
          proof[0].payload.stateHash === stateHash(candidate)
        ) {
          state = candidate;
          version = snapshot.streamVersion;
        }
      }
    } catch {
      // Cache errors never erase or establish authority.
    }
    const [events, proofs] = await Promise.all([
      readCompleteStream(store, { streamId, fromVersion: version + 1 }),
      readCompleteStream(store, { streamId: integrityStream(streamId), fromVersion: version + 1 }),
    ]);
    if (events.length !== proofs.length)
      throw new Error("Lost authority resource history or integrity record; retain source promise.");
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!;
      const proof = proofs[index]!;
      if (proof.eventType !== `${prefix}.history-witness` || proof.payload.eventHash !== eventHash(event)) {
        throw new Error("Contradictory authority resource integrity; retain source promise.");
      }
      state = fold(state, event);
      version = event.streamVersion;
    }
    // Every tail event matches its retained digest; only the resulting fold (or the
    // exact snapshot anchor) is consumed. Rehashing every historical grant set
    // would add quadratic payload serialization to each reconciliation read.
    if (proofs.length) assertSameAuthority(proofs.at(-1)!.payload.stateHash, stateHash(state));
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
