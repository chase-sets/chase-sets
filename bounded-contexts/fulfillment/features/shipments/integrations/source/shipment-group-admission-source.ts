import {
  isTransientProjectionError,
  type ProjectorHandlerContext,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  admissionIdentityFromFact,
  orderGroupFactRegistry,
  type AdmissionIdentity,
  type OrderGroupEventPayloads,
} from "@chase-sets/order-groups";
import { isDeepStrictEqual } from "node:util";
import {
  decideShipmentAdmission,
  evolveFulfillmentShipment,
  sameAdmissionIdentity,
  type FulfillmentShipmentState,
  type ShipmentAdmissionCommand,
} from "../../domain/domain";
import { ShipmentHistoryPoisonedError } from "../../domain/mutation-attempt";

type SourceType = keyof OrderGroupEventPayloads & `ordering.${string}`;
type SourceFact = {
  [K in SourceType]: { type: K; data: OrderGroupEventPayloads[K]; event: TransportEvent };
}[SourceType];
const sourceTypes: readonly SourceType[] = [
  "ordering.order-group.admission-requested",
  "ordering.order-group.formed",
  "ordering.order-group.admission-aborted",
  "ordering.order-group.member-removed",
  "ordering.order-group.dissolved",
];

function decode(event: TransportEvent): SourceFact {
  const type = sourceTypes.find((candidate) => candidate === event.type);
  if (!type) throw new Error(`Unexpected source fact '${event.type}'.`);
  const fact = orderGroupFactRegistry[type].codec.decode({ eventType: event.type, payload: event.data });
  if (
    event.streamId !== `ordering.order-${fact.data.anchorOrderId}` ||
    event.streamVersion !== fact.data.anchorOrderVersion
  )
    throw new Error("Source anchor/version binding conflicts.");
  return { ...fact, event } as SourceFact;
}

export function buildShipmentGroupAdmissionSourceHandlers(
  deps: Readonly<{
    loadShipment: (
      shipmentId: string,
      context: EventStoreContext,
    ) => Promise<{ state: FulfillmentShipmentState; version: number }>;
    execute: (
      command: ShipmentAdmissionCommand,
      context: EventStoreContext,
      invocation?: ProjectorHandlerContext,
      causationId?: string | null,
    ) => Promise<ReturnType<typeof decideShipmentAdmission>["result"]>;
    cancelAnchor: (
      identity: AdmissionIdentity,
      context: EventStoreContext,
      invocation?: ProjectorHandlerContext,
    ) => Promise<void>;
  }>,
): ProjectorHandlerMap {
  const handle = async (event: TransportEvent, invocation?: ProjectorHandlerContext) => {
    const poison = (error: unknown): never => {
      throw new ShipmentHistoryPoisonedError(
        `Shipment admission source '${event.id}' on '${event.streamId}', anchor '${String(event.data.anchorShipmentId)}': ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    let current: SourceFact;
    try {
      current = decode(event);
    } catch (error) {
      return poison(error);
    }
    const context: EventStoreContext = { tenantId: event.tenantId, audit: event.audit, trace: event.trace };
    invocation?.throwIfLeaseLost?.();
    const loaded = await deps.loadShipment(current.data.anchorShipmentId, context);
    if (
      loaded.state.shipmentId !== current.data.anchorShipmentId ||
      loaded.state.orderId !== current.data.anchorOrderId
    ) {
      return poison("Missing or foreign anchor Shipment; no admission write is permitted.");
    }
    if (current.type === "ordering.order-group.admission-requested") {
      await deps.execute(
        { kind: "reserve", input: admissionIdentityFromFact(current.data) },
        context,
        invocation,
        event.id,
      );
      return;
    }
    if (!invocation?.readSourceStreamHistory) return poison("Source history capability is missing.");
    let history: readonly TransportEvent[];
    try {
      history = await invocation.readSourceStreamHistory();
    } catch (error) {
      invocation.throwIfLeaseLost?.();
      if (isTransientProjectionError(error)) throw error;
      return poison(error);
    }
    let identity: AdmissionIdentity;
    let commands: ShipmentAdmissionCommand[];
    let cancelAnchor = false;
    try {
      const facts = history.map(decode);
      if (!facts.length || !isDeepStrictEqual(facts.at(-1)!.event, event))
        throw new Error("Source prefix does not end at the trigger.");
      for (let index = 0; index < facts.length; index += 1) {
        const fact = facts[index]!;
        if (
          fact.event.streamId !== event.streamId ||
          fact.event.tenantId !== event.tenantId ||
          fact.data.anchorShipmentId !== current.data.anchorShipmentId ||
          fact.event.streamVersion > event.streamVersion ||
          (index > 0 && fact.event.streamVersion <= facts[index - 1]!.event.streamVersion)
        ) {
          throw new Error("Source history crosses its immutable anchor, tenant or causal horizon.");
        }
      }
      const related = facts.filter(
        (fact) => fact.data.requestId === current.data.requestId || fact.data.groupId === current.data.groupId,
      );
      const requests = related.filter((fact) => fact.type === "ordering.order-group.admission-requested");
      if (requests.length !== 1) throw new Error("Source lineage requires exactly one preceding request.");
      const requested = requests[0]!;
      identity = admissionIdentityFromFact(requested.data);
      if (requested.event.streamVersion >= event.streamVersion) throw new Error("Request must precede its outcome.");
      for (const fact of related) {
        if (fact !== requested && fact.event.streamVersion <= requested.event.streamVersion) {
          throw new Error("Every admission outcome must follow its request.");
        }
        if (fact.type === "ordering.order-group.member-removed" || fact.type === "ordering.order-group.dissolved") {
          if (
            fact.data.requestId !== identity.requestId ||
            fact.data.groupId !== identity.groupId ||
            fact.data.memberOrderIds[0] !== identity.anchorOrderId ||
            fact.data.memberOrderIds[1] !== identity.proposedMemberOrderId
          ) {
            throw new Error("Removal contradicts the original exact-two identity.");
          }
        } else if (!sameAdmissionIdentity(fact.data, identity))
          throw new Error("Source facts disagree on full admission identity.");
      }
      const forms = related.filter((fact) => fact.type === "ordering.order-group.formed");
      const aborts = related.filter((fact) => fact.type === "ordering.order-group.admission-aborted");
      const dissolutions = related.filter((fact) => fact.type === "ordering.order-group.dissolved");
      if (dissolutions.length > 1) throw new Error("Repeated dissolution in source lineage.");
      if (forms.length > 1 || aborts.length > 1 || (forms.length && aborts.length))
        throw new Error("Ambiguous or post-Form Abort lineage.");
      commands = [{ kind: "reserve", input: identity }];
      if (current.type === "ordering.order-group.admission-aborted") {
        commands.push({ kind: "abort", input: { ...identity, reason: current.data.reason } });
      } else {
        const formed = forms[0];
        if (!formed || formed.event.streamVersion <= requested.event.streamVersion)
          throw new Error("Missing preceding formed lineage.");
        commands.push({ kind: "commit", input: { ...identity, anchorOrderVersion: formed.data.anchorOrderVersion } });
        if (
          current.type === "ordering.order-group.member-removed" ||
          current.type === "ordering.order-group.dissolved"
        ) {
          if (formed.event.streamVersion >= current.event.streamVersion) throw new Error("Removal must follow Form.");
          const removals = related.filter((fact) => fact.type === "ordering.order-group.member-removed");
          if (
            removals.length !== 1 ||
            removals[0]!.event.streamVersion <= formed.event.streamVersion ||
            removals[0]!.data.removedOrderId !== current.data.removedOrderId ||
            removals[0]!.data.reason !== current.data.reason
          )
            throw new Error("Missing or conflicting member removal.");
          if (current.type === "ordering.order-group.dissolved") {
            if (removals[0]!.event.streamVersion >= event.streamVersion)
              throw new Error("Dissolution must follow removal.");
            commands.push({
              kind: "dissolve",
              input: { ...identity, anchorOrderVersion: formed.data.anchorOrderVersion },
            });
            cancelAnchor = current.data.removedOrderId === identity.anchorOrderId;
          }
        }
      }
      // Validate the entire reconstruction before the first durable side effect.
      let { state, version } = loaded;
      for (const command of commands) {
        const decision = decideShipmentAdmission(state, command, version + 1, new Date().toISOString());
        if (
          decision.result.status !== "accepted" &&
          decision.result.status !== "replayed" &&
          decision.result.status !== "released"
        ) {
          if (current.type !== "ordering.order-group.admission-aborted")
            throw new Error(`Cannot reconcile formed admission: ${decision.result.status}.`);
          if (command.kind === "abort" && decision.result.status !== "not-reserved")
            throw new Error(`Cannot reconcile Abort: ${decision.result.status}.`);
        }
        if (decision.event) {
          state = evolveFulfillmentShipment(state, decision.event);
          version += 1;
        }
      }
    } catch (error) {
      return poison(error);
    }
    // Removal diagnoses the linkage but has no release or reconstruction authority.
    if (current.type === "ordering.order-group.member-removed") return;
    for (const command of commands) {
      const result = await deps.execute(command, context, invocation, event.id);
      if (
        result.status !== "accepted" &&
        result.status !== "replayed" &&
        result.status !== "released" &&
        current.type !== "ordering.order-group.admission-aborted"
      )
        return poison(`Concurrent admission cannot reconcile: ${result.status}.`);
    }
    if (cancelAnchor) await deps.cancelAnchor(identity, context, invocation);
    invocation?.throwIfLeaseLost?.();
  };
  return Object.fromEntries(sourceTypes.map((type) => [type, handle]));
}
