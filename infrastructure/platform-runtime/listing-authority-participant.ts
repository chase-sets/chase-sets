import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AggregateSnapshotStore } from "@chase-sets/event-core/aggregate-snapshot-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  LISTING_AUTHORITY_RESOURCE_LIMIT,
  listingAuthorityParticipantKey,
  type ListingAuthorityConsumerPort,
  type ListingAuthorityOperation,
  type ListingAuthorityParticipant,
  type ListingAuthorityParticipantPort,
  type ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  assertSameAuthority,
  authorityContext,
  authorityHash,
  authorityHistory,
  authorityPayload,
  authorityValue,
} from "./listing-authority-state";

export type ListingAuthoritySourceValidation = Readonly<{
  value: JsonObject;
  sourceRevisions: ListingAuthorityReservation["sourceRevisions"];
  validBefore: string;
  /** Source-local guards and, for real commitments, existing Inventory hold appends. Never sent to the consumer. */
  localAppends?: readonly AppendToStreamInput[];
}>;

/** Technical persistence only. Owners supply authoritative predicates and route every conflicting writer here. */
export type ListingAuthorityParticipantConfig = Readonly<{
  eventStore: EventStore;
  snapshots?: AggregateSnapshotStore;
  participant: ListingAuthorityParticipant;
  consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
  resources(operation: ListingAuthorityOperation): readonly string[];
  validate(operation: ListingAuthorityOperation, context: EventStoreContext): Promise<ListingAuthoritySourceValidation>;
  /** Inventory can atomically release an actual hold on abort; a committed purchase hold remains owned by its workflow. */
  settlementAppends?(
    operation: ListingAuthorityOperation,
    status: "consumed" | "released",
    context: EventStoreContext,
  ): Promise<readonly AppendToStreamInput[]>;
}>;

export function createListingAuthorityParticipant(deps: ListingAuthorityParticipantConfig) {
  const store = deps.eventStore;
  const key = listingAuthorityParticipantKey(deps.participant);
  const prefix = `${deps.participant.owner}.listing-authority`;
  const reservationStream = (operation: ListingAuthorityOperation) =>
    `${prefix}-reservation-${authorityHash([key, operation.operationId, operation.generation])}`;
  const resourceStream = (tenantId: string, resource: string) =>
    `${prefix}-resource-${authorityHash([tenantId, resource])}`;

  function resources(values: readonly string[]) {
    const result = [...new Set(values)].sort();
    if (
      !result.length ||
      result.length > LISTING_AUTHORITY_RESOURCE_LIMIT ||
      result.some((value) => !value || value.length > 500)
    ) {
      throw new Error("Invalid bounded authority resource set.");
    }
    return result;
  }

  async function resource(tenantId: string, id: string) {
    const streamId = resourceStream(tenantId, id);
    let pending: Readonly<{ mutationId: string; command: JsonObject }> | null = null;
    const grants = new Map<string, ListingAuthorityReservation>();
    let version = 0;
    try {
      const snapshot = await deps.snapshots?.loadLatest(streamId);
      const state = snapshot?.state as { pending?: typeof pending; grants?: ListingAuthorityReservation[] } | undefined;
      if (
        snapshot?.schemaVersion === 1 &&
        snapshot.streamId === streamId &&
        Number.isSafeInteger(snapshot.streamVersion) &&
        snapshot.streamVersion > 0 &&
        state?.pending !== undefined &&
        Array.isArray(state.grants)
      ) {
        pending = state.pending;
        for (const grant of state.grants) grants.set(grant.reservationId, grant);
        version = snapshot.streamVersion;
      }
    } catch {
      // Snapshots are a disposable owner-local fold cache, never release evidence.
    }
    const events = await readCompleteStream(store, { streamId, fromVersion: version + 1 });
    for (const event of events) {
      if (event.eventType === `${prefix}.reserved`) {
        const grant = authorityValue<ListingAuthorityReservation>(event.payload.reservation);
        grants.set(grant.reservationId, grant);
      } else if (event.eventType === `${prefix}.settled`) {
        grants.delete(String(event.payload.reservationId));
      } else if (event.eventType === `${prefix}.invalidation-started`) {
        pending = authorityValue<typeof pending>(event.payload.invalidation);
      } else if (event.eventType === `${prefix}.invalidation-completed`) {
        pending = null;
      } else throw new Error("Corrupt authority resource history.");
    }
    version = events.at(-1)?.streamVersion ?? version;
    if (version && events.length && deps.snapshots) {
      try {
        await deps.snapshots.save({
          streamId,
          streamVersion: version,
          schemaVersion: 1,
          state: { pending, grants: [...grants.values()] },
        });
      } catch {
        // A failed cache write cannot change source or consumer authority.
      }
    }
    return { version, streamId, pending, grants };
  }

  async function inspect(operation: ListingAuthorityOperation): Promise<ListingAuthorityReservation | null> {
    const history = await authorityHistory(store, reservationStream(operation));
    if (!history.events.length) return null;
    const grant = authorityValue<ListingAuthorityReservation>(history.events[0]!.payload.reservation);
    assertSameAuthority(grant.operation, operation);
    const last = history.events.at(-1)!;
    if (
      history.events.length > 2 ||
      history.events[0]!.eventType !== `${prefix}.reserved` ||
      listingAuthorityParticipantKey(grant.participant) !== key ||
      grant.status !== "reserved" ||
      history.events.some(
        (event) => event.tenantId !== operation.tenantId || event.forAccountId !== operation.accountId,
      ) ||
      (history.events.length === 2 &&
        (last.eventType !== `${prefix}.settled` ||
          (last.payload.status !== "consumed" && last.payload.status !== "released") ||
          typeof last.payload.terminalEventId !== "string"))
    ) {
      throw new Error("Corrupt source reservation history; retain source promise.");
    }
    return {
      ...grant,
      status: history.events.length === 1 ? "reserved" : authorityValue<"consumed" | "released">(last.payload.status),
    };
  }

  async function prepare(
    operation: ListingAuthorityOperation,
    context: EventStoreContext,
    attempt = 0,
  ): Promise<ListingAuthorityReservation> {
    if (
      context.tenantId !== operation.tenantId ||
      context.audit.forAccountId !== operation.accountId ||
      context.audit.performedByUserId !== operation.actor.userId ||
      !operation.participants.some((participant) => listingAuthorityParticipantKey(participant) === key)
    ) {
      throw new Error("Authority participant binding mismatch.");
    }
    const prior = await inspect(operation);
    if (prior) return prior;
    const consumer = await deps.consumer(operation).inspect(operation);
    if (consumer.status !== "pending") throw new Error("Authority consumer is not pending.");
    assertSameAuthority(consumer.operation, operation);
    const ids = resources(deps.resources(operation));
    const scopes = await Promise.all(ids.map((id) => resource(operation.tenantId, id)));
    if (scopes.some((scope) => scope.pending || scope.grants.size >= 128))
      throw new Error("Authority resource is pending invalidation or full.");
    const checked = await deps.validate(operation, context);
    if (!Number.isFinite(Date.parse(checked.validBefore))) throw new Error("Invalid source validity boundary.");
    if (
      !checked.sourceRevisions.length ||
      new Set(checked.sourceRevisions.map((revision) => revision.resourceId)).size !== checked.sourceRevisions.length ||
      checked.sourceRevisions.some((revision) => !revision.resourceId || !revision.revision) ||
      checked.localAppends?.some(
        (guard) =>
          !guard.streamId.startsWith(`${deps.participant.owner}.`) || guard.context.tenantId !== operation.tenantId,
      )
    ) {
      throw new Error("Invalid source-owned authority revision vector or local appends.");
    }
    const grant: ListingAuthorityReservation = {
      reservationId: authorityHash([key, operation.operationId, operation.generation]),
      participant: deps.participant,
      operation,
      resources: ids,
      sourceRevisions: checked.sourceRevisions,
      value: checked.value,
      validBefore: checked.validBefore,
      status: "reserved",
    };
    if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
    const event = { eventType: `${prefix}.reserved`, payload: authorityPayload({ reservation: grant }) };
    try {
      await store.appendToStreams([
        ...(checked.localAppends ?? []),
        ...scopes.map((scope) => ({
          streamId: scope.streamId,
          expectedVersion: scope.version,
          events: [event],
          context,
        })),
        { streamId: reservationStream(operation), expectedVersion: 0, events: [event], context },
      ]);
      return grant;
    } catch (error) {
      const recovered = await inspect(operation);
      if (recovered) return recovered;
      if ((error as { code?: string })?.code === "concurrency_conflict" && attempt < 127)
        return prepare(operation, context, attempt + 1);
      throw error;
    }
  }

  async function settle(operation: ListingAuthorityOperation): Promise<ListingAuthorityReservation> {
    const grant = await inspect(operation);
    if (!grant) throw new Error("Unknown source reservation.");
    if (grant.status !== "reserved") return grant;
    const terminal = await deps.consumer(operation).inspect(operation);
    if (terminal.status === "pending" || terminal.status === "unknown")
      throw new Error("Consumer outcome unresolved; retain source promise.");
    assertSameAuthority(terminal.operation, operation);
    if (!terminal.terminalEventId) throw new Error("Authoritative terminal receipt is incomplete.");
    const status = terminal.status === "committed" ? "consumed" : "released";
    const scopes = await Promise.all(grant.resources.map((id) => resource(operation.tenantId, id)));
    const context = authorityContext(operation);
    const sourceAppends = (await deps.settlementAppends?.(operation, status, context)) ?? [];
    if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
    try {
      await store.appendToStreams([
        ...sourceAppends,
        ...scopes.map((scope) => ({
          streamId: scope.streamId,
          expectedVersion: scope.version,
          context,
          events: [{ eventType: `${prefix}.settled`, payload: { reservationId: grant.reservationId } }],
        })),
        {
          streamId: reservationStream(operation),
          expectedVersion: 1,
          context,
          events: [{ eventType: `${prefix}.settled`, payload: { status, terminalEventId: terminal.terminalEventId } }],
        },
      ]);
    } catch (error) {
      const recovered = await inspect(operation);
      if (!recovered || recovered.status === "reserved") throw error;
      return recovered;
    }
    return { ...grant, status };
  }

  async function mutate(
    input: Readonly<{
      resources: readonly string[];
      mutationId: string;
      command: JsonObject;
      context: EventStoreContext;
      prepare(): Promise<readonly AppendToStreamInput[]>;
    }>,
  ): Promise<void> {
    if (!input.mutationId || input.mutationId.length > 200) throw new Error("Authority mutation identity required.");
    if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
    const ids = resources(input.resources);
    const intent = { mutationId: input.mutationId, command: input.command };
    const mutationStream = `${prefix}-mutation-${authorityHash([input.context.tenantId, input.mutationId])}`;
    const mutation = await authorityHistory(store, mutationStream);
    if (mutation.events.length) {
      if (
        mutation.events.length > 2 ||
        mutation.events[0]!.eventType !== `${prefix}.invalidation-started` ||
        (mutation.events.length === 2 && mutation.events[1]!.eventType !== `${prefix}.invalidation-completed`)
      ) {
        throw new Error("Corrupt authority invalidation history.");
      }
      assertSameAuthority(mutation.events[0]!.payload.intent, authorityPayload({ ...intent, resources: ids }));
      if (mutation.events.length === 2) return;
    } else {
      const initial = await Promise.all(ids.map((id) => resource(input.context.tenantId, id)));
      if (initial.some((scope) => scope.pending))
        throw new Error("Conflicting authority invalidation remains pending.");
      await store.appendToStreams([
        ...initial.map((scope) => ({
          streamId: scope.streamId,
          expectedVersion: scope.version,
          context: input.context,
          events: [
            { eventType: `${prefix}.invalidation-started`, payload: authorityPayload({ invalidation: intent }) },
          ],
        })),
        {
          streamId: mutationStream,
          expectedVersion: 0,
          context: input.context,
          events: [
            {
              eventType: `${prefix}.invalidation-started`,
              payload: authorityPayload({ intent: { ...intent, resources: ids } }),
            },
          ],
        },
      ]);
    }
    const closed = await Promise.all(ids.map((id) => resource(input.context.tenantId, id)));
    const outstanding = new Map(closed.flatMap((scope) => [...scope.grants]));
    for (const grant of outstanding.values()) {
      // This RPC competes with commit. Inspect-then-write is deliberately not used.
      const terminal = await deps.consumer(grant.operation).invalidate(grant.operation, input.mutationId);
      assertSameAuthority(terminal.operation, grant.operation);
      if ((terminal.status !== "committed" && terminal.status !== "aborted") || !terminal.terminalEventId) {
        throw new Error("Authority invalidation has no durable terminal receipt.");
      }
      // A resource may include another purpose owned by this same context. Its owner
      // settles that reservation; mutation needs only the authoritative terminal.
    }
    const appends = await input.prepare();
    const guarded = await Promise.all(ids.map((id) => resource(input.context.tenantId, id)));
    for (const scope of guarded) assertSameAuthority(scope.pending, intent);
    await store.appendToStreams([
      ...appends,
      ...guarded.map((scope) => ({
        streamId: scope.streamId,
        expectedVersion: scope.version,
        context: input.context,
        events: [{ eventType: `${prefix}.invalidation-completed`, payload: { mutationId: input.mutationId } }],
      })),
      {
        streamId: mutationStream,
        expectedVersion: 1,
        context: input.context,
        events: [{ eventType: `${prefix}.invalidation-completed`, payload: {} }],
      },
    ]);
  }

  async function inspectInvalidation(tenantId: string, mutationId: string) {
    const history = await authorityHistory(store, `${prefix}-mutation-${authorityHash([tenantId, mutationId])}`);
    if (!history.events.length) return null;
    return {
      status: history.events.length === 2 ? ("completed" as const) : ("pending" as const),
      intent: authorityValue<Readonly<{ mutationId: string; command: JsonObject; resources: readonly string[] }>>(
        history.events[0]!.payload.intent,
      ),
    };
  }
  const port: ListingAuthorityParticipantPort = { participant: deps.participant, prepare, inspect, settle };
  return { ...port, mutate, inspectInvalidation };
}

export type ListingAuthoritySource = ReturnType<typeof createListingAuthorityParticipant>;
