import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AggregateSnapshotStore } from "@chase-sets/event-core/aggregate-snapshot-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  LISTING_AUTHORITY_RESOURCE_LIMIT,
  assertListingAuthorityParticipants,
  listingAuthorityParticipantKey,
  requireListingAuthorityPrincipal,
  type ListingAuthorityConsumerPort,
  type ListingAuthorityOperation,
  type ListingAuthorityParticipant,
  type ListingAuthorityParticipantPort,
  type ListingAuthorityReservation,
} from "@chase-sets/event-core/listing-authority";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createListingAuthorityResources } from "./listing-authority-resource";
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
  /** Dynamic dependency selection must still match the resources acquired before validation. */
  resources?: readonly string[];
  /** Source-local guards and, for real commitments, existing Inventory hold appends. Never sent to the consumer. */
  localAppends?: readonly AppendToStreamInput[];
}>;

/** Technical persistence only. Owners supply authoritative predicates and route every conflicting writer here. */
export type ListingAuthorityParticipantConfig = Readonly<{
  eventStore: EventStore;
  snapshots?: AggregateSnapshotStore;
  participant: ListingAuthorityParticipant;
  /** Global Catalog/policy predicates are shared across tenants, unlike account-owned stock. */
  resourceScope?: "tenant" | "owner";
  consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
  resources(operation: ListingAuthorityOperation): readonly string[] | Promise<readonly string[]>;
  validate(operation: ListingAuthorityOperation, context: EventStoreContext): Promise<ListingAuthoritySourceValidation>;
  /** Inventory can atomically release an actual hold on abort; a committed purchase hold remains owned by its workflow. */
  settlementAppends?(
    operation: ListingAuthorityOperation,
    status: "consumed" | "released",
    context: EventStoreContext,
  ): Promise<readonly AppendToStreamInput[]>;
}>;

export function createListingAuthorityParticipant(deps: ListingAuthorityParticipantConfig) {
  assertListingAuthorityParticipants([deps.participant]);
  if (deps.participant.owner === "auth" && deps.resourceScope !== "owner")
    throw new Error("Auth session authority requires owner-scoped resource serialization.");
  const store = deps.eventStore;
  const key = listingAuthorityParticipantKey(deps.participant);
  const prefix = `${deps.participant.owner}.listing-authority`;
  const resourceStore = createListingAuthorityResources({ store, prefix, snapshots: deps.snapshots });
  const reservationStream = (operation: ListingAuthorityOperation) =>
    `${prefix}-reservation-${authorityHash([key, operation.operationId, operation.generation])}`;
  const resourceStream = (tenantId: string, resource: string) =>
    `${prefix}-resource-${authorityHash([deps.resourceScope === "owner" ? null : tenantId, resource])}`;

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
    return resourceStore.read(resourceStream(tenantId, id));
  }

  async function inspect(operation: ListingAuthorityOperation): Promise<ListingAuthorityReservation | null> {
    authorityContext(operation);
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
    if (history.events.length === 1) {
      assertSameAuthority(grant.resources, resources(grant.resources));
      const scopes = await Promise.all(grant.resources.map((id) => resource(operation.tenantId, id)));
      for (const scope of scopes) {
        const member = scope.grants.get(grant.reservationId);
        if (!member) throw new Error("Missing authority resource membership; retain source promise.");
        assertSameAuthority(member, grant);
      }
      // A concurrent terminal settlement may remove membership. Never turn that
      // race into permission: callers retry/reconcile the retained operation.
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
    if (deps.participant.owner === "identity" || deps.participant.owner === "auth") {
      assertSameAuthority(requireListingAuthorityPrincipal(context), operation.principal);
    } else if (context.listingAuthorityPrincipal) {
      assertSameAuthority(requireListingAuthorityPrincipal(context), operation.principal);
    }
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
    const ids = resources(await deps.resources(operation));
    let scopes = await Promise.all(ids.map((id) => resource(operation.tenantId, id)));
    const preparationId = `prepare-${authorityHash([key, operation.operationId, operation.generation])}`;
    const preparationIntent = { mutationId: preparationId, command: authorityPayload({ operation }) };
    const preparationStream = `${prefix}-mutation-${authorityHash([operation.tenantId, preparationId])}`;
    const resumedPreparation = scopes.some((scope) => scope.pending?.mutationId === preparationId);
    const consumer = await deps.consumer(operation).inspect(operation);
    if (consumer.status !== "pending") {
      if (resumedPreparation && consumer.status === "aborted") await completeRejectedPreparation();
      throw new Error("Authority consumer is not pending.");
    }
    assertSameAuthority(consumer.operation, operation);
    if (
      scopes.some((scope) => (scope.pending && scope.pending.mutationId !== preparationId) || scope.grants.size >= 128)
    )
      throw new Error("Authority resource is pending invalidation or full.");
    let checked: ListingAuthoritySourceValidation;
    checked = await deps.validate(operation, context);
    if (resumedPreparation || checked.localAppends?.some((input) => input.events.length)) {
      if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
      if (!resumedPreparation) {
        await resourceStore.append([
          ...scopes.map((scope) => ({
            streamId: scope.streamId,
            expectedVersion: scope.version,
            context,
            events: [
              {
                eventType: `${prefix}.invalidation-started`,
                payload: authorityPayload({ invalidation: preparationIntent }),
              },
            ],
          })),
          {
            streamId: preparationStream,
            expectedVersion: 0,
            context,
            events: [
              {
                eventType: `${prefix}.invalidation-started`,
                payload: authorityPayload({ intent: { ...preparationIntent, resources: ids } }),
              },
            ],
          },
        ]);
      }
      scopes = await Promise.all(ids.map((id) => resource(operation.tenantId, id)));
      for (const scope of scopes) assertSameAuthority(scope.pending, preparationIntent);
      const outstanding = new Map(scopes.flatMap((scope) => [...scope.grants]));
      for (const grant of outstanding.values()) {
        const terminal = await deps.consumer(grant.operation).invalidate(grant.operation, preparationId);
        assertSameAuthority(terminal.operation, grant.operation);
        if ((terminal.status !== "committed" && terminal.status !== "aborted") || !terminal.terminalEventId) {
          throw new Error("Authority preparation has no durable terminal receipt.");
        }
        if (listingAuthorityParticipantKey(grant.participant) === key) await settle(grant.operation);
      }
      // Actual purchase holds change the availability predicate. They must revoke
      // earlier grants before joining the new reservation's atomic source append.
      checked = await deps.validate(operation, context);
      scopes = await Promise.all(ids.map((id) => resource(operation.tenantId, id)));
    }

    async function completeRejectedPreparation() {
      if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
      for (const scope of scopes) assertSameAuthority(scope.pending, preparationIntent);
      await resourceStore.append([
        ...scopes.map((scope) => ({
          streamId: scope.streamId,
          expectedVersion: scope.version,
          context,
          events: [{ eventType: `${prefix}.invalidation-completed`, payload: { mutationId: preparationId } }],
        })),
        {
          streamId: preparationStream,
          expectedVersion: 1,
          context,
          events: [{ eventType: `${prefix}.invalidation-completed`, payload: {} }],
        },
      ]);
    }
    if (!Number.isFinite(Date.parse(checked.validBefore))) throw new Error("Invalid source validity boundary.");
    if (checked.resources) assertSameAuthority(ids, resources(checked.resources));
    if (
      !checked.sourceRevisions.length ||
      new Set(checked.sourceRevisions.map((revision) => revision.resourceId)).size !== checked.sourceRevisions.length ||
      checked.sourceRevisions.some((revision) => !revision.resourceId || !revision.revision) ||
      checked.localAppends?.some((guard) => guard.context.tenantId !== operation.tenantId)
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
    const closesPreparation = scopes.some((scope) => scope.pending?.mutationId === preparationId);
    try {
      await resourceStore.append([
        ...(checked.localAppends ?? []),
        ...scopes.map((scope) => ({
          streamId: scope.streamId,
          expectedVersion: scope.version,
          events: closesPreparation
            ? [event, { eventType: `${prefix}.invalidation-completed`, payload: { mutationId: preparationId } }]
            : [event],
          context,
        })),
        { streamId: reservationStream(operation), expectedVersion: 0, events: [event], context },
        ...(closesPreparation
          ? [
              {
                streamId: preparationStream,
                expectedVersion: 1,
                context,
                events: [{ eventType: `${prefix}.invalidation-completed`, payload: {} }],
              },
            ]
          : []),
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
      await resourceStore.append([
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
      /** Only same-store consuming operations whose terminal append joins this source mutation. */
      localCommits?: readonly ListingAuthorityOperation[];
      prepare(): Promise<readonly AppendToStreamInput[]>;
    }>,
  ): Promise<void> {
    if (!input.mutationId || input.mutationId.length > 200) throw new Error("Authority mutation identity required.");
    if (!store.appendToStreams) throw new Error("Atomic authority persistence unavailable.");
    const ids = resources(input.resources);
    const intent = {
      mutationId: input.mutationId,
      command: input.command,
      ...(input.localCommits?.length ? { localCommits: input.localCommits } : {}),
    };
    for (const operation of input.localCommits ?? []) {
      if (operation.committingOwner !== deps.participant.owner || operation.tenantId !== input.context.tenantId) {
        throw new Error("Only a source-local consumer terminal can share an invalidating transaction.");
      }
      const opened = await authorityHistory(
        store,
        `${operation.committingOwner}.listing-authority-operation-${operation.operationId}`,
      );
      assertSameAuthority(opened.events[0]?.payload.operation, operation);
    }
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
      await resourceStore.append([
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
    const localGrants: ListingAuthorityReservation[] = [];
    for (const grant of outstanding.values()) {
      if (input.localCommits?.some((operation) => operation.operationId === grant.operation.operationId)) {
        assertSameAuthority(
          input.localCommits.find((operation) => operation.operationId === grant.operation.operationId),
          grant.operation,
        );
        localGrants.push(grant);
        continue;
      }
      // This RPC competes with commit. Inspect-then-write is deliberately not used.
      const terminal = await deps.consumer(grant.operation).invalidate(grant.operation, input.mutationId);
      assertSameAuthority(terminal.operation, grant.operation);
      if ((terminal.status !== "committed" && terminal.status !== "aborted") || !terminal.terminalEventId) {
        throw new Error("Authority invalidation has no durable terminal receipt.");
      }
      if (listingAuthorityParticipantKey(grant.participant) === key) await settle(grant.operation);
      // A resource may include another purpose owned by this same context. Its owner
      // settles that reservation; mutation needs only the authoritative terminal.
    }
    const appends = await input.prepare();
    for (const grant of localGrants) {
      const operation = grant.operation;
      const terminal = appends.find(
        (append) =>
          append.streamId === `${operation.committingOwner}.listing-authority-operation-${operation.operationId}`,
      );
      if (terminal) {
        if (
          terminal.expectedVersion !== 1 ||
          !operation.openingEventId ||
          terminal.expectedFirstEventId !== operation.openingEventId ||
          !terminal.authorizationDeadline ||
          terminal.events.length !== 1 ||
          terminal.events[0]!.eventType !== `${operation.committingOwner}.listing-authority-operation.committed`
        ) {
          throw new Error("A source-local commitment requires its guarded terminal append.");
        }
      } else {
        const receipt = await deps.consumer(operation).invalidate(operation, input.mutationId);
        assertSameAuthority(receipt.operation, operation);
        if ((receipt.status !== "committed" && receipt.status !== "aborted") || !receipt.terminalEventId) {
          throw new Error("Authority invalidation has no durable terminal receipt.");
        }
        if (listingAuthorityParticipantKey(grant.participant) === key) await settle(operation);
      }
    }
    const guarded = await Promise.all(ids.map((id) => resource(input.context.tenantId, id)));
    for (const scope of guarded) assertSameAuthority(scope.pending, intent);
    await resourceStore.append([
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
