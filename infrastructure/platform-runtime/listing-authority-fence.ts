import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  assertListingAuthorityParticipants,
  requireListingAuthorityPrincipal,
  listingAuthorityParticipantKey,
  type ListingAuthorityConsumerPort,
  type ListingAuthorityOperation,
  type ListingAuthorityOperationStatus,
  type ListingAuthorityOwner,
  type ListingAuthorityParticipantPort,
  type ListingAuthorityReservation,
  type ListingAuthorityTerminal,
  type ListingAuthorityStandingAuthorityPort,
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

export type ListingAuthorityOperationInput = Omit<
  ListingAuthorityOperation,
  "schemaVersion" | "operationId" | "commandFingerprint" | "prepareBefore" | "generation" | "principal"
>;

/** Called by Identity with the host-bound admitting owner, not a caller-selected port. */
export async function prepareListingStandingAuthority(
  operation: ListingAuthorityOperation,
  context: EventStoreContext,
  port: ListingAuthorityStandingAuthorityPort,
): Promise<ListingAuthorityReservation> {
  const principal = requireListingAuthorityPrincipal(context);
  assertSameAuthority(principal, operation.principal);
  if (
    principal.kind !== "standing-system" ||
    port.participant.owner !== principal.admittingOwner ||
    port.participant.owner === "identity" ||
    !operation.participants.some(
      (participant) => listingAuthorityParticipantKey(participant) === listingAuthorityParticipantKey(port.participant),
    )
  ) {
    throw new Error("Standing authority admitting owner is not bound to this operation.");
  }
  const grant = await port.prepare(operation, context);
  assertSameAuthority(grant.operation, operation);
  assertSameAuthority(grant.participant, port.participant);
  assertSameAuthority(await port.inspect(operation), grant);
  if (
    grant.status !== "reserved" ||
    !Number.isFinite(Date.parse(grant.validBefore)) ||
    Date.parse(grant.validBefore) > Date.parse(principal.validBefore)
  ) {
    throw new Error("Standing authority promise or validity is invalid.");
  }
  return grant;
}

export function createListingAuthorityFence(
  deps: Readonly<{
    eventStore: EventStore;
    owner: "marketplace" | "ordering";
    participants: readonly ListingAuthorityParticipantPort[];
    now?: () => Date;
  }>,
) {
  const now = deps.now ?? (() => new Date());
  const store = deps.eventStore;
  const stream = (operation: ListingAuthorityOperation) =>
    `${deps.owner}.listing-authority-operation-${operation.operationId}`;
  const ports = new Map(deps.participants.map((port) => [listingAuthorityParticipantKey(port.participant), port]));
  if (ports.size !== deps.participants.length) throw new Error("Duplicate authority participant mounting.");

  async function read(operation: ListingAuthorityOperation) {
    if (operation.committingOwner !== deps.owner) throw new Error("Wrong committing owner.");
    const history = await authorityHistory(store, stream(operation));
    if (history.events.length === 0)
      return { ...history, status: { status: "unknown" } as ListingAuthorityOperationStatus };
    const retained = authorityValue<ListingAuthorityOperation>(history.events[0]!.payload.operation);
    assertSameAuthority(retained, operation);
    const last = history.events.at(-1)!;
    if (
      history.events.length > 2 ||
      history.events[0]!.eventType !== `${deps.owner}.listing-authority-operation.opened` ||
      history.events.some(
        (event) => event.tenantId !== operation.tenantId || event.forAccountId !== operation.accountId,
      ) ||
      (history.events.length === 2 &&
        ![
          `${deps.owner}.listing-authority-operation.committed`,
          `${deps.owner}.listing-authority-operation.aborted`,
        ].includes(last.eventType))
    ) {
      throw new Error("Corrupt authority terminal history; retain reservations.");
    }
    const status: ListingAuthorityOperationStatus = last.eventType.endsWith(".opened")
      ? { status: "pending", operation: retained }
      : {
          status: last.eventType.endsWith(".committed") ? "committed" : "aborted",
          operation: retained,
          terminalEventId: last.eventId,
          result: authorityValue<JsonObject | null>(last.payload.result),
          reason: authorityValue<string | null>(last.payload.reason),
        };
    return { ...history, status };
  }

  async function open(input: ListingAuthorityOperationInput, context: EventStoreContext) {
    assertListingAuthorityParticipants(input.participants);
    const principal =
      context.listingAuthorityPrincipal || input.participants.some((p) => p.owner === "identity")
        ? requireListingAuthorityPrincipal(context)
        : null;
    if (
      principal &&
      (principal.kind !== input.actor.kind ||
        (principal.kind === "standing-system" &&
          (input.actor.kind !== "standing-system" ||
            principal.authorityId !== input.actor.authorityId ||
            principal.authorityRevision !== input.actor.authorityRevision)))
    ) {
      throw new Error("Listing actor does not match authenticated principal.");
    }
    const actorValid =
      input.actor.kind === "user" ||
      (input.actor.kind === "standing-system" && !!input.actor.authorityId && !!input.actor.authorityRevision);
    const targetValid =
      input.target.kind === "native-marketplace" ||
      (input.target.kind === "channel-connection" && !!input.target.connectionId.trim());
    if (
      !actorValid ||
      !targetValid ||
      input.committingOwner !== deps.owner ||
      input.tenantId !== context.tenantId ||
      input.accountId !== context.audit.forAccountId ||
      input.actor.userId !== context.audit.performedByUserId ||
      !input.requestId.trim() ||
      input.requestId.length > 200 ||
      !input.listingId ||
      !input.subject.inventoryItemId ||
      !input.subject.catalogItemId ||
      !input.subject.productId ||
      !Number.isSafeInteger(input.subject.quantity) ||
      input.subject.quantity < 1 ||
      [
        input.expectedTargetRevision,
        input.expectedVisibilityRevision,
        input.expectedPublicationRevision,
        input.subject.allocationRevision,
      ].some((revision) => revision !== null && (!Number.isSafeInteger(revision) || revision < 0)) ||
      !Number.isSafeInteger(input.expectedListingRevision) ||
      input.expectedListingRevision < 0
    )
      throw new Error("Invalid Listing authority operation identity.");
    const operation: ListingAuthorityOperation = {
      ...input,
      principal,
      schemaVersion: 1,
      operationId: authorityHash([input.tenantId, input.accountId, deps.owner, input.requestId]),
      commandFingerprint: authorityHash({ ...input, principal }),
      generation: 1,
      prepareBefore: new Date(now().getTime() + 60_000).toISOString(),
    };
    const history = await authorityHistory(store, stream(operation));
    if (history.events.length) {
      const prior = authorityValue<ListingAuthorityOperation>(history.events[0]!.payload.operation);
      if (prior.commandFingerprint !== operation.commandFingerprint)
        throw new Error("Listing request key was already used for a different command.");
      return prior;
    }
    if (principal && !(now().getTime() < Date.parse(principal.validBefore)))
      throw new Error("Listing authenticated principal expired.");
    try {
      await store.appendToStream({
        streamId: stream(operation),
        expectedVersion: 0,
        context,
        events: [
          { eventType: `${deps.owner}.listing-authority-operation.opened`, payload: authorityPayload({ operation }) },
        ],
      });
      return operation;
    } catch (error) {
      const recovered = await authorityHistory(store, stream(operation));
      if (!recovered.events.length) throw error;
      const prior = authorityValue<ListingAuthorityOperation>(recovered.events[0]!.payload.operation);
      if (prior.commandFingerprint !== operation.commandFingerprint)
        throw new Error("Listing request key was already used for a different command.");
      return prior;
    }
  }

  async function abort(operation: ListingAuthorityOperation, reason: string): Promise<ListingAuthorityTerminal> {
    const current = await read(operation);
    if (current.status.status === "unknown") throw new Error("Unknown authority operation; retain reservations.");
    if (current.status.status !== "pending") return current.status;
    try {
      await store.appendToStream({
        streamId: stream(operation),
        expectedVersion: current.version,
        context: authorityContext(operation),
        events: [{ eventType: `${deps.owner}.listing-authority-operation.aborted`, payload: { result: null, reason } }],
      });
    } catch (error) {
      const recovered = await read(operation);
      if (recovered.status.status === "pending" || recovered.status.status === "unknown") throw error;
      return recovered.status;
    }
    const terminal = (await read(operation)).status;
    if (terminal.status === "pending" || terminal.status === "unknown")
      throw new Error("Authority abort outcome unknown.");
    return terminal;
  }

  async function prepareCommit(
    operation: ListingAuthorityOperation,
    reservations: readonly ListingAuthorityReservation[],
    result: JsonObject,
  ): Promise<AppendToStreamInput> {
    const current = await read(operation);
    if (current.status.status !== "pending") throw new Error(`Authority operation is ${current.status.status}.`);
    if (!(now().getTime() < Date.parse(operation.prepareBefore))) {
      await abort(operation, "preparation-expired");
      throw new Error("Authority preparation expired.");
    }
    const required = operation.participants.map(listingAuthorityParticipantKey).sort();
    assertSameAuthority(
      reservations.map((grant) => listingAuthorityParticipantKey(grant.participant)).sort(),
      required,
    );
    const deadlines = [operation.prepareBefore, ...(operation.principal ? [operation.principal.validBefore] : [])];
    for (const grant of reservations) {
      assertSameAuthority(grant.operation, operation);
      const port = ports.get(listingAuthorityParticipantKey(grant.participant));
      if (!port) throw new Error("Required authority participant is not mounted.");
      const verified = await port.inspect(operation);
      assertSameAuthority(verified, grant);
      if (verified?.status !== "reserved") throw new Error("Authority promise is not reserved.");
      deadlines.push(verified.validBefore);
    }
    return {
      streamId: stream(operation),
      expectedVersion: current.version,
      context: authorityContext(operation),
      authorizationDeadline: new Date(Math.min(...deadlines.map(Date.parse))).toISOString(),
      events: [{ eventType: `${deps.owner}.listing-authority-operation.committed`, payload: { result, reason: null } }],
    };
  }

  async function settle(operation: ListingAuthorityOperation) {
    const status = (await read(operation)).status;
    if (status.status === "pending" || status.status === "unknown") throw new Error("Authority outcome unresolved.");
    for (const participant of operation.participants) {
      const port = ports.get(listingAuthorityParticipantKey(participant));
      if (!port) throw new Error("Authority settlement participant unavailable.");
      const reservation = await port.inspect(operation);
      if (!reservation && status.status === "committed")
        throw new Error("Committed authority reservation is missing; reconciliation required.");
      if (reservation) await port.settle(operation);
    }
    return status;
  }

  function forParticipant(authenticatedOwner: ListingAuthorityOwner): ListingAuthorityConsumerPort {
    return {
      inspect: async (operation) => {
        if (!operation.participants.some((participant) => participant.owner === authenticatedOwner))
          throw new Error("Unbound authority owner.");
        return (await read(operation)).status;
      },
      invalidate: (operation, reason) => {
        if (!operation.participants.some((participant) => participant.owner === authenticatedOwner))
          throw new Error("Unbound authority owner.");
        return abort(operation, `${authenticatedOwner}:${reason}`);
      },
    };
  }

  return {
    open,
    inspect: async (operation: ListingAuthorityOperation) => (await read(operation)).status,
    abort,
    prepareCommit,
    settle,
    forParticipant,
  };
}

export type ListingAuthorityFence = ReturnType<typeof createListingAuthorityFence>;
