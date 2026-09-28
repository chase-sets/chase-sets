import { createId } from "@chase-sets/primitives/typed-ids";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { AppendToStreamInput, EventRecordToStore } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { assertSameAuthority, authorityHash } from "./listing-authority-state";

/** Independent retained witnesses, not projections or a source from which to recreate authority.
 * Any one or two lost/rolled-back histories fail closed. All three travel in the same local transaction.
 */
export function authorityJournalStreams(streamId: string) {
  const match = /^(.*\.listing-authority)-(operation|reservation|resource|mutation|write)-(.+)$/.exec(streamId);
  if (!match) throw new Error("Not an authority journal stream.");
  const [, prefix, kind, identity] = match;
  return [
    streamId,
    `${prefix}-integrity-${kind === "resource" ? "" : `${kind}-`}${identity}`,
    `${prefix}-registration-${kind}-${identity}`,
  ] as const;
}

export function isAuthorityJournal(streamId: string) {
  return /\.listing-authority-(operation|reservation|resource|mutation|write)-/.test(streamId);
}

export const authorityEventHash = (event: Pick<EventRecordToStore, "eventType" | "payload">) =>
  authorityHash({ eventType: event.eventType, payload: event.payload });
const witnessType = (streamId: string) => `${streamId.split(".")[0]}.listing-authority.history-witness`;

export class ListingAuthorityHistoryError extends Error {
  readonly code = "listing_authority_history_unavailable";
  constructor(
    readonly streamId: string,
    readonly canonicalMissing: boolean,
  ) {
    super("Lost authority resource history or journal registration; retain source promise.");
  }
}

export async function readAuthorityJournal(store: EventStore, streamId: string) {
  const streams = authorityJournalStreams(streamId);
  const histories = await Promise.all(streams.map((id) => readCompleteStream(store, { streamId: id })));
  const [events, integrity, registration] = histories;
  if (events!.length !== integrity!.length || events!.length !== registration!.length)
    throw new ListingAuthorityHistoryError(streamId, events!.length === 0);
  for (let index = 0; index < events!.length; index++) {
    const event = events![index]!;
    const proof = integrity![index]!;
    const registered = registration![index]!;
    if (
      proof.eventType !== witnessType(streamId) ||
      registered.eventType !== proof.eventType ||
      proof.payload.eventId !== event.eventId ||
      proof.payload.eventHash !== authorityEventHash(event) ||
      proof.tenantId !== event.tenantId ||
      registered.tenantId !== event.tenantId ||
      proof.forAccountId !== event.forAccountId ||
      registered.forAccountId !== event.forAccountId ||
      proof.performedByUserId !== event.performedByUserId ||
      registered.performedByUserId !== event.performedByUserId
    )
      throw new Error("Contradictory authority history integrity; retain source promise.");
    assertSameAuthority(proof.payload, registered.payload);
  }
  return { events: events!, version: events!.at(-1)?.streamVersion ?? 0, histories };
}

/** The returned complete append set must be kept intact through the final store transaction. */
export async function prepareAuthorityAppend(
  store: EventStore,
  input: AppendToStreamInput,
  proofPayloads?: readonly JsonObject[],
): Promise<readonly AppendToStreamInput[]> {
  const current = await readAuthorityJournal(store, input.streamId);
  const expected = input.expectedVersion === "no_stream" ? 0 : input.expectedVersion;
  if (expected !== current.version)
    throw createEventStoreError("concurrency_conflict", "Authority journal changed before atomic append.");
  if (input.expectedFirstEventId && current.events[0]?.eventId !== input.expectedFirstEventId)
    throw createEventStoreError("concurrency_conflict", "Stream opening identity conflict.");
  const events = input.events.map((event) => ({ ...event, eventId: event.eventId ?? createId("evt") }));
  const proofs = events.map((event, index) => ({
    eventType: witnessType(input.streamId),
    payload: { ...proofPayloads?.[index], eventId: event.eventId, eventHash: authorityEventHash(event) },
  }));
  return authorityJournalStreams(input.streamId).map((streamId, index) => ({
    ...input,
    streamId,
    ...(current.version ? { expectedFirstEventId: current.histories[index]![0]!.eventId } : {}),
    events: index === 0 ? events : proofs.map((event) => ({ ...event, eventId: createId("evt") })),
  }));
}

export async function prepareAuthorityAppends(store: EventStore, inputs: readonly AppendToStreamInput[]) {
  const result: AppendToStreamInput[] = [];
  for (const input of inputs) {
    if (!isAuthorityJournal(input.streamId)) {
      result.push(input);
      continue;
    }
    const [, integrity, registration] = authorityJournalStreams(input.streamId);
    const supplied = inputs.filter((other) => other.streamId === integrity || other.streamId === registration);
    if (supplied.length) {
      if (supplied.length !== 2 || new Set(supplied.map((other) => other.streamId)).size !== 2)
        throw new Error("Incomplete authority journal append set.");
      for (const witness of supplied) {
        if (
          witness.expectedVersion !== input.expectedVersion ||
          witness.events.length !== input.events.length ||
          witness.authorizationDeadline !== input.authorizationDeadline ||
          (input.expectedFirstEventId && !witness.expectedFirstEventId)
        )
          throw new Error("Incomplete guarded authority journal append set.");
        input.events.forEach((event, index) => {
          if (
            !event.eventId ||
            witness.events[index]!.eventType !== witnessType(input.streamId) ||
            witness.events[index]!.payload.eventId !== event.eventId ||
            witness.events[index]!.payload.eventHash !== authorityEventHash(event)
          )
            throw new Error("Contradictory authority journal append witnesses.");
        });
      }
      result.push(input);
    } else result.push(...(await prepareAuthorityAppend(store, input)));
  }
  return result;
}

export async function appendAuthorityAppends(store: EventStore, inputs: readonly AppendToStreamInput[]) {
  if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
  return store.appendToStreams(await prepareAuthorityAppends(store, inputs));
}
