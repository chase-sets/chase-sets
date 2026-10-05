import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { admissionIdentityFromFact, parseAdmissionIdentity, type AdmissionIdentity } from "@chase-sets/order-groups";
import { createId, type ShipmentId } from "@chase-sets/primitives/typed-ids";
import { FulfillmentDomainError, ShipmentAdmissionBusyError } from "../domain/common";
import {
  combinedPostagePlan,
  physicalDestinationsEqual,
  shipmentGroupPostageKey,
  shipmentLabelGeneration,
} from "../domain/combined-plan";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  sameAdmissionIdentity,
  type FulfillmentShipmentCommand,
  type FulfillmentShipmentEvent,
  type FulfillmentShipmentState,
  type ShipmentPhysicalGroup,
} from "../domain/domain";
import { assertCompleteHistoryTenant, ShipmentHistoryPoisonedError } from "../domain/mutation-attempt";

type LoadedShipment = LoadedAggregate<FulfillmentShipmentState, FulfillmentShipmentEvent>;
export type LoadedShipmentGroup = Readonly<{
  anchor: LoadedShipment;
  member: LoadedShipment;
  identity: AdmissionIdentity;
  group: ShipmentPhysicalGroup;
  guards: readonly AppendToStreamInput[];
}>;

export function createShipmentGroupExecution(
  deps: Readonly<{
    eventStore: EventStore;
    loadShipment: (streamId: string) => Promise<LoadedShipment>;
  }>,
) {
  const stream = (shipmentId: string) => `fulfillment.shipment-${shipmentId}`;
  const locatorStream = (orderId: string, context: EventStoreContext) =>
    `fulfillment.shipment-order-locator-${context.tenantId}-${orderId}`;

  async function locator(orderId: string, context: EventStoreContext) {
    const streamId = locatorStream(orderId, context);
    const events = await readCompleteStream(deps.eventStore, { streamId });
    assertCompleteHistoryTenant(events, String(context.tenantId), { allowEmpty: true });
    let shipmentId: string | null = null;
    let identity: AdmissionIdentity | null = null;
    for (const [index, event] of events.entries()) {
      if (event.streamId !== streamId || event.streamVersion !== index + 1 || event.payload.orderId !== orderId)
        throw new ShipmentHistoryPoisonedError("Shipment locator history conflicts with its Order.");
      if (event.eventType === "fulfillment.shipment.order-located") {
        if (typeof event.payload.shipmentId !== "string" || (shipmentId && shipmentId !== event.payload.shipmentId))
          throw new ShipmentHistoryPoisonedError("Order has conflicting Shipment locators.");
        shipmentId = event.payload.shipmentId;
      } else if (event.eventType === "fulfillment.shipment.member-located") {
        identity = parseAdmissionIdentity(event.payload.identity);
        if (identity.proposedMemberOrderId !== orderId)
          throw new ShipmentHistoryPoisonedError("Member locator has a foreign admission identity.");
      } else throw new ShipmentHistoryPoisonedError("Unexpected Shipment locator event.");
    }
    return { streamId, version: events.length, shipmentId, identity };
  }

  async function load(shipmentId: string, context: EventStoreContext) {
    const loaded = await deps.loadShipment(stream(shipmentId));
    assertCompleteHistoryTenant(loaded.storedEvents, String(context.tenantId));
    if (loaded.state.shipmentId !== shipmentId) throw new ShipmentHistoryPoisonedError("Shipment identity conflict.");
    return loaded;
  }

  async function locateMember(identity: AdmissionIdentity, context: EventStoreContext): Promise<AppendToStreamInput> {
    const existing = await locator(identity.proposedMemberOrderId, context);
    if (existing.identity && !sameAdmissionIdentity(existing.identity, identity)) {
      const prior = await load(existing.identity.anchorShipmentId, context);
      if (
        prior.state.admission?.type !== "fulfillment.shipment-group.admission-released" ||
        !sameAdmissionIdentity(prior.state.admission.data, existing.identity)
      )
        throw new FulfillmentDomainError("Follow-on Order already belongs to another admission.");
    }
    return {
      streamId: existing.streamId,
      expectedVersion: existing.version,
      context,
      events:
        existing.identity && sameAdmissionIdentity(existing.identity, identity)
          ? []
          : [
              {
                eventType: "fulfillment.shipment.member-located",
                payload: { orderId: identity.proposedMemberOrderId, identity: admissionIdentityFromFact(identity) },
              },
            ],
    };
  }

  async function locateCreatedShipment(
    command: Extract<FulfillmentShipmentCommand, { type: "CreateShipment" }>,
    context: EventStoreContext,
  ): Promise<AppendToStreamInput[]> {
    const existing = await locator(command.orderId, context);
    if (!existing.identity && !command.combinedPlanAccepted) return [];
    if (existing.shipmentId && existing.shipmentId !== command.shipmentId)
      throw new FulfillmentDomainError("Order already has a Shipment.");
    const guards: AppendToStreamInput[] = [];
    if (existing.identity || command.combinedPlanAccepted) {
      if (
        !existing.identity ||
        !command.combinedPlanAccepted ||
        !sameAdmissionIdentity(existing.identity, command.combinedPlanAccepted)
      )
        throw new FulfillmentDomainError("Follow-on Shipment requires its admitted combined plan.");
      const anchor = await load(existing.identity.anchorShipmentId, context);
      if (
        (anchor.state.admission?.type !== "fulfillment.shipment-group.admission-committed" &&
          anchor.state.admission?.type !== "fulfillment.shipment-group.admission-released") ||
        !sameAdmissionIdentity(anchor.state.admission.data, existing.identity) ||
        anchor.state.buyerAccountId !== command.buyerAccountId ||
        anchor.state.sellerAccountId !== command.sellerAccountId
      )
        throw new ShipmentAdmissionBusyError();
      guards.push({
        streamId: stream(existing.identity.anchorShipmentId),
        expectedVersion: anchor.version,
        context,
        events: [],
      });
    }
    return [
      ...guards,
      {
        streamId: existing.streamId,
        expectedVersion: existing.version,
        context,
        events: existing.shipmentId
          ? []
          : [
              {
                eventType: "fulfillment.shipment.order-located",
                payload: { orderId: command.orderId, shipmentId: command.shipmentId },
              },
            ],
      },
    ];
  }

  async function groupFor(
    loaded: LoadedShipment,
    context: EventStoreContext,
    cleanup = false,
  ): Promise<LoadedShipmentGroup | null> {
    const state = loaded.state;
    if (!state.orderId) return null;
    const located = await locator(state.orderId, context);
    const identity =
      state.admission?.type === "fulfillment.shipment-group.admission-committed"
        ? admissionIdentityFromFact(state.admission.data)
        : (located.identity ?? state.combinedPlanAccepted ?? state.physicalGroup?.identity);
    if (!identity) return null;
    const anchor =
      state.shipmentId === identity.anchorShipmentId ? loaded : await load(identity.anchorShipmentId, context);
    const admission = anchor.state.admission;
    const released =
      admission?.type === "fulfillment.shipment-group.admission-released" &&
      sameAdmissionIdentity(admission.data, identity);
    if (released && !cleanup) {
      if (state.packingStartedAt && state.physicalGroup?.disposition !== "separate")
        throw new FulfillmentDomainError("Dissolved packed group requires Support reconciliation.");
      return null;
    }
    if (
      (!released && admission?.type !== "fulfillment.shipment-group.admission-committed") ||
      !admission ||
      !sameAdmissionIdentity(admission.data, identity)
    )
      throw new ShipmentAdmissionBusyError();
    const memberLocator = await locator(identity.proposedMemberOrderId, context);
    if (
      !memberLocator.shipmentId ||
      !memberLocator.identity ||
      !sameAdmissionIdentity(memberLocator.identity, identity)
    )
      throw new ShipmentAdmissionBusyError();
    const member =
      memberLocator.shipmentId === state.shipmentId ? loaded : await load(memberLocator.shipmentId, context);
    if (
      anchor.state.orderId !== identity.anchorOrderId ||
      member.state.orderId !== identity.proposedMemberOrderId ||
      anchor.state.sellerAccountId !== member.state.sellerAccountId ||
      anchor.state.buyerAccountId !== member.state.buyerAccountId ||
      !anchor.state.status ||
      !member.state.status ||
      (!cleanup && (anchor.state.status === "cancelled" || member.state.status === "cancelled"))
    )
      throw new FulfillmentDomainError("Shipment Group requires its two active-ready members.");
    const previous = anchor.state.physicalGroup;
    if (previous && !sameAdmissionIdentity(previous.identity, identity) && anchor.state.packingStartedAt)
      throw new ShipmentHistoryPoisonedError("Packing history belongs to another admission.");
    const group: ShipmentPhysicalGroup =
      previous && sameAdmissionIdentity(previous.identity, identity)
        ? previous
        : {
            shipmentGroupId: createId("shg"),
            identity: admissionIdentityFromFact(identity),
            memberShipmentId: memberLocator.shipmentId,
            committedVersion: admission.data.shipmentVersion,
            disposition: "combined",
            dispositionVersion: anchor.version + 1,
          };
    return {
      anchor,
      member,
      identity,
      group,
      guards: [{ streamId: memberLocator.streamId, expectedVersion: memberLocator.version, context, events: [] }],
    };
  }

  async function prepare(loaded: LoadedShipment, command: FulfillmentShipmentCommand, context: EventStoreContext) {
    // Callers cannot supply the authorization produced by the two-stream guard.
    command = { ...command, groupExecution: undefined };
    if (command.type === "CreateShipment") {
      const events = [...decideFulfillmentShipment(loaded.state, command)];
      const additionalAppends = await locateCreatedShipment(command, context);
      if (command.combinedPlanAccepted) {
        const identity = admissionIdentityFromFact(command.combinedPlanAccepted);
        const anchor = await load(identity.anchorShipmentId, context);
        if (
          anchor.state.admission?.type === "fulfillment.shipment-group.admission-released" &&
          sameAdmissionIdentity(anchor.state.admission.data, identity)
        )
          return { events, additionalAppends };
        if (
          anchor.state.admission?.type !== "fulfillment.shipment-group.admission-committed" ||
          !sameAdmissionIdentity(anchor.state.admission.data, identity)
        )
          throw new ShipmentAdmissionBusyError();
        const group: ShipmentPhysicalGroup = {
          shipmentGroupId: createId("shg"),
          identity,
          memberShipmentId: command.shipmentId,
          committedVersion: anchor.state.admission.data.shipmentVersion,
          disposition: "combined",
          dispositionVersion: anchor.version + 1,
        };
        events.push({
          type: "fulfillment.shipment.physical-group-recorded",
          data: { shipmentId: command.shipmentId, group },
        });
        const guardIndex = additionalAppends.findIndex((entry) => entry.streamId === stream(identity.anchorShipmentId));
        additionalAppends[guardIndex] = {
          streamId: stream(identity.anchorShipmentId),
          expectedVersion: anchor.version,
          context,
          events: [
            {
              eventType: "fulfillment.shipment.physical-group-recorded",
              payload: { shipmentId: identity.anchorShipmentId, group },
            },
          ],
        };
      }
      return { events, additionalAppends };
    }
    if (command.type === "CancelShipment")
      return { events: decideFulfillmentShipment(loaded.state, command), additionalAppends: [] };
    const cleanup =
      command.type === "VoidShipmentLabel" ||
      command.type === "RecordShipmentLabelRefundStatus" ||
      (command.type === "RecordShipmentGroupPostageIntent" && command.operationKind === "void-label");
    const group = await groupFor(loaded, context, cleanup);
    if (!group) return { events: decideFulfillmentShipment(loaded.state, command), additionalAppends: [] };
    const { anchor, member, identity } = group;
    const isAnchor = loaded.state.shipmentId === identity.anchorShipmentId;
    if (
      command.type === "RecordShipmentGroupPostageIntent" &&
      command.operationKey !==
        shipmentGroupPostageKey({
          tenantId: String(context.tenantId),
          group: group.group,
          subjectId: String(loaded.state.shipmentId),
          operationKind: command.operationKind ?? "purchase-usps-label",
          labelGeneration: shipmentLabelGeneration(loaded.storedEvents),
        })
    )
      throw new FulfillmentDomainError("Postage invocation belongs to a stale group disposition or label generation.");
    if (group.group.disposition === "separate") {
      return {
        events: decideFulfillmentShipment(loaded.state, { ...command, groupExecution: identity }),
        additionalAppends: [
          ...group.guards,
          {
            streamId: stream(isAnchor ? String(member.state.shipmentId) : identity.anchorShipmentId),
            expectedVersion: isAnchor ? member.version : anchor.version,
            context,
            events: [],
          },
        ],
      };
    }
    const lineCommand = [
      "ConfirmShipmentPackingLine",
      "UnconfirmShipmentPackingLine",
      "SetShipmentPackingLineQuantity",
    ].includes(command.type);
    if (!isAnchor && !lineCommand)
      throw new FulfillmentDomainError("Combined execution belongs to the anchor Shipment.");
    if (command.type === "AttachShipmentLabel" && !command.postageProviderLabelId)
      throw new FulfillmentDomainError("Combined dispatch does not allow manual labels.");
    const gates = [
      "StartShipmentPacking",
      "PrepareShipmentPackage",
      "AttachShipmentLabel",
      "DispatchShipment",
      "RecordShipmentGroupPostageIntent",
    ];
    if (gates.includes(command.type) && !cleanup) {
      if (command.type === "PrepareShipmentPackage" && command.packageCount !== 1)
        throw new FulfillmentDomainError("Combined dispatch requires exactly one package.");
      combinedPostagePlan(anchor.state, member.state, identity);
      if (
        !physicalDestinationsEqual(anchor.state.shippingDestinationSnapshot, member.state.shippingDestinationSnapshot)
      ) {
        console.warn(
          JSON.stringify({
            event: "fulfillment.shipment-group.held",
            reason: "destination-mismatch",
            shipmentId: identity.anchorShipmentId,
            groupId: group.group.shipmentGroupId,
          }),
        );
        throw new FulfillmentDomainError("Shipment Group is held for destination-mismatch.");
      }
      if (anchor.state.conflicts.length || member.state.conflicts.length)
        throw new FulfillmentDomainError("Shipment Group conflict requires Support.");
    }
    const binding = (shipmentId: ShipmentId, value: ShipmentPhysicalGroup): FulfillmentShipmentEvent => ({
      type: "fulfillment.shipment.physical-group-recorded",
      data: { shipmentId, group: value },
    });
    let nextGroup = group.group;
    if (command.type === "ElectSeparateShipmentDispatch") {
      // A missing or unbound plan cannot be escaped by changing physical disposition.
      if (!member.state.combinedPlanAccepted || !sameAdmissionIdentity(member.state.combinedPlanAccepted, identity))
        throw new FulfillmentDomainError("Separate dispatch cannot escape an unbound combined plan.");
      for (const current of [anchor, member]) {
        if (
          current.state.dispatchedAt ||
          (current.state.packingStartedAt && !["void-requested", "voided"].includes(current.state.labelStatus)) ||
          current.state.groupPostageIntent ||
          current.state.conflicts.length ||
          current.state.status === "label-attached"
        )
          throw new FulfillmentDomainError(
            "Reconcile shared packing and postage through Support before separate dispatch.",
          );
      }
      nextGroup = { ...nextGroup, disposition: "separate", dispositionVersion: anchor.version + 2 };
    }
    const anchorEvents: FulfillmentShipmentEvent[] = [];
    const memberEvents: FulfillmentShipmentEvent[] = [];
    for (const [current, events] of [
      [anchor, anchorEvents],
      [member, memberEvents],
    ] as const) {
      if (command.type === "ElectSeparateShipmentDispatch") {
        events.push(...decideFulfillmentShipment(current.state, { ...command, groupExecution: identity }));
      }
      if (!current.state.physicalGroup || current.state.physicalGroup.disposition !== nextGroup.disposition)
        events.push(binding(current.state.shipmentId!, nextGroup));
    }
    if (command.type !== "ElectSeparateShipmentDispatch") {
      const shared = [
        "StartShipmentPacking",
        "PrepareShipmentPackage",
        "AttachShipmentLabel",
        "VoidShipmentLabel",
        "RecordShipmentLabelRefundStatus",
        "DispatchShipment",
        "RecordShipmentDelivery",
        "ReturnShipment",
      ].includes(command.type);
      for (const [current, events] of [
        [anchor, anchorEvents],
        [member, memberEvents],
      ] as const) {
        if (!shared && current.state.shipmentId !== loaded.state.shipmentId) continue;
        const stateWithBinding = events.reduce(evolveFulfillmentShipment, current.state);
        const effects = decideFulfillmentShipment(stateWithBinding, { ...command, groupExecution: identity });
        events.push(
          ...effects.map(
            (event): FulfillmentShipmentEvent =>
              current === member && event.type === "fulfillment.shipment.label-attached"
                ? {
                    type: "fulfillment.shipment.group-tracking-attached",
                    data: { ...event.data, postageAmountCents: null, postageCurrency: null },
                  }
                : current === member && event.type === "fulfillment.shipment.label-refund-status-recorded"
                  ? { type: "fulfillment.shipment.group-refund-status-recorded", data: event.data }
                  : event,
          ),
        );
      }
    }
    return {
      events: isAnchor ? anchorEvents : memberEvents,
      additionalAppends: [
        ...group.guards,
        {
          streamId: stream(isAnchor ? String(member.state.shipmentId) : identity.anchorShipmentId),
          expectedVersion: isAnchor ? member.version : anchor.version,
          context,
          events: (isAnchor ? memberEvents : anchorEvents).map((event) => ({
            eventType: event.type,
            payload: event.data,
          })),
        },
      ],
    };
  }
  return { locateMember, groupFor, prepare };
}
