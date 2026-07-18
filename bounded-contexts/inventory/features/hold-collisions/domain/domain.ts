import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { InventoryHoldOrderSourceRef } from "@chase-sets/event-core/public-event-payloads";
import { assert, ensurePositiveInteger, normalizeLabel } from "../../../support/runtime-support/common";

export const inventoryHoldCollisionModes = ["protect-orders", "honor-offline"] as const;

export type InventoryHoldCollisionMode = (typeof inventoryHoldCollisionModes)[number];

export type ActiveInventoryHoldForCollision = Readonly<{
  holdId: string;
  quantity: number;
  purpose: string;
  sourceRef: InventoryHoldOrderSourceRef | null;
  committedAt: string;
}>;

export type InventoryHoldCollisionOrder = Readonly<{
  holdId: string;
  orderId: string;
  reservationRequestId: string;
  quantity: number;
  disposition: "protected" | "released";
}>;

export type InventoryHoldCollisionPlan = Readonly<{
  mode: InventoryHoldCollisionMode;
  requestedQuantity: number;
  appliedQuantity: number;
  refusedQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  releasedHoldQuantity: number;
  affectedOrders: readonly InventoryHoldCollisionOrder[];
}>;

export function planInventoryHoldCollision(
  input: Readonly<{
    totalQuantity: number;
    requestedQuantity: number;
    mode: InventoryHoldCollisionMode;
    honorOfflineAuthorized: boolean;
    activeHolds: readonly ActiveInventoryHoldForCollision[];
  }>,
): InventoryHoldCollisionPlan | null {
  ensurePositiveInteger(input.requestedQuantity, "Inventory reductions require a positive whole-number quantity.");
  const heldQuantity = input.activeHolds.reduce((total, hold) => total + hold.quantity, 0);
  const availableQuantity = input.totalQuantity - heldQuantity;
  assert(availableQuantity >= 0, "Inventory commitments cannot exceed total quantity.");

  if (input.requestedQuantity <= availableQuantity) {
    return null;
  }

  const orderHolds = input.activeHolds.filter(
    (hold): hold is ActiveInventoryHoldForCollision & { sourceRef: InventoryHoldOrderSourceRef } =>
      hold.purpose === "order" && hold.sourceRef !== null,
  );

  if (input.mode === "protect-orders") {
    return {
      mode: input.mode,
      requestedQuantity: input.requestedQuantity,
      appliedQuantity: availableQuantity,
      refusedQuantity: input.requestedQuantity - availableQuantity,
      heldQuantity,
      availableQuantity,
      releasedHoldQuantity: 0,
      affectedOrders: orderHolds.map((hold) => collisionOrder(hold, "protected")),
    };
  }

  assert(input.honorOfflineAuthorized, "Honor offline requires manager or owner authorization.");
  const deficit = input.requestedQuantity - availableQuantity;
  const releasableOrderQuantity = orderHolds.reduce((total, hold) => total + hold.quantity, 0);
  assert(releasableOrderQuantity >= deficit, "Honor offline cannot displace manual or checkout inventory holds.");

  // Earlier commitments win. Release the newest whole reservations until the
  // requested reduction no longer breaches the remaining commitment floor.
  const newestFirst = [...orderHolds].sort(
    (left, right) => right.committedAt.localeCompare(left.committedAt) || right.holdId.localeCompare(left.holdId),
  );
  const released: (ActiveInventoryHoldForCollision & { sourceRef: InventoryHoldOrderSourceRef })[] = [];
  let releasedHoldQuantity = 0;
  for (const hold of newestFirst) {
    released.push(hold);
    releasedHoldQuantity += hold.quantity;
    if (releasedHoldQuantity >= deficit) {
      break;
    }
  }

  return {
    mode: input.mode,
    requestedQuantity: input.requestedQuantity,
    appliedQuantity: input.requestedQuantity,
    refusedQuantity: 0,
    heldQuantity,
    availableQuantity,
    releasedHoldQuantity,
    affectedOrders: released.map((hold) => collisionOrder(hold, "released")),
  };
}

export type InventoryHoldCollisionState = Readonly<{
  collisionId: string | null;
}>;

export const initialInventoryHoldCollisionState: InventoryHoldCollisionState = {
  collisionId: null,
};

export type RecordInventoryHoldCollisionCommand = Readonly<{
  type: "RecordInventoryHoldCollision";
  collisionId: string;
  accountId: string;
  itemId: string;
  storageLocationId: string;
  reason: string;
  recordedAt: string;
  totalQuantityBefore: number;
  plan: InventoryHoldCollisionPlan;
}>;

export type InventoryHoldCollisionRecordedEvent = DomainEvent<
  "inventory.hold-collision-recorded",
  Readonly<{
    collisionId: string;
    accountId: string;
    itemId: string;
    storageLocationId: string;
    reason: string;
    mode: InventoryHoldCollisionMode;
    requestedQuantity: number;
    appliedQuantity: number;
    refusedQuantity: number;
    heldQuantity: number;
    availableQuantity: number;
    releasedHoldQuantity: number;
    totalQuantityBefore: number;
    totalQuantityAfter: number;
    affectedOrders: readonly InventoryHoldCollisionOrder[];
    recordedAt: string;
  }>
>;

export const decideInventoryHoldCollision: AggregateDecider<
  InventoryHoldCollisionState,
  RecordInventoryHoldCollisionCommand,
  InventoryHoldCollisionRecordedEvent
> = (state, command) => {
  assert(state.collisionId === null, "Inventory hold collision has already been recorded.");
  assert(command.plan.refusedQuantity > 0 || command.plan.releasedHoldQuantity > 0, "A collision requires an effect.");
  return [
    {
      type: "inventory.hold-collision-recorded",
      data: {
        collisionId: normalizeLabel(command.collisionId),
        accountId: normalizeLabel(command.accountId),
        itemId: normalizeLabel(command.itemId),
        storageLocationId: normalizeLabel(command.storageLocationId),
        reason: normalizeLabel(command.reason),
        mode: command.plan.mode,
        requestedQuantity: command.plan.requestedQuantity,
        appliedQuantity: command.plan.appliedQuantity,
        refusedQuantity: command.plan.refusedQuantity,
        heldQuantity: command.plan.heldQuantity,
        availableQuantity: command.plan.availableQuantity,
        releasedHoldQuantity: command.plan.releasedHoldQuantity,
        totalQuantityBefore: command.totalQuantityBefore,
        totalQuantityAfter: command.totalQuantityBefore - command.plan.appliedQuantity,
        affectedOrders: command.plan.affectedOrders,
        recordedAt: normalizeLabel(command.recordedAt),
      },
    },
  ];
};

export const evolveInventoryHoldCollision: AggregateEvolver<
  InventoryHoldCollisionState,
  InventoryHoldCollisionRecordedEvent
> = (state, event) => {
  return { collisionId: event.data.collisionId };
};

function collisionOrder(
  hold: ActiveInventoryHoldForCollision & { sourceRef: InventoryHoldOrderSourceRef },
  disposition: InventoryHoldCollisionOrder["disposition"],
): InventoryHoldCollisionOrder {
  return {
    holdId: hold.holdId,
    orderId: hold.sourceRef.orderId,
    reservationRequestId: hold.sourceRef.reservationRequestId,
    quantity: hold.quantity,
    disposition,
  };
}
