import type { ReturnShipmentExceptionType } from "../domain/common";

/**
 * Reverse-shipment deadline/exception derivation.
 *
 * Deadlines are *derived*, never ambient: given a shipment's immutable stamped
 * deadlines, its custody timestamps, a policy threshold set, and an `asOf` instant,
 * this module computes the deadline/exception signals deterministically. The same
 * `asOf` always yields the same signals, so the derivation is replay-safe and can
 * back both an operator dashboard and the shared reminder/notification jobs
 * (Fulfillment publishes the derived signal; it does not schedule notifications or
 * mutate custody itself).
 */
export type ReturnShipmentDeadlinePolicy = Readonly<{
  /** Emit a ship-by reminder this many hours before the ship-by deadline. */
  shipByReminderLeadHours: number;
  /** Hours after the ship-by deadline that an unshipped label becomes void-eligible. */
  labelVoidGraceHours: number;
  /** No carrier movement scan for this long while in custody flags a stall. */
  stalledInTransitHours: number;
  /** Delivered-to-facility but not yet intaken for this long flags an intake gap. */
  deliveryWithoutIntakeHours: number;
  /** An overdue signal older than this many hours past its due instant is escalated. */
  operatorEscalationHours: number;
}>;

export const DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY: ReturnShipmentDeadlinePolicy = {
  shipByReminderLeadHours: 48,
  labelVoidGraceHours: 72,
  stalledInTransitHours: 120,
  deliveryWithoutIntakeHours: 48,
  operatorEscalationHours: 72,
};

export type ReturnShipmentDeadlineCode =
  | "ship-by-reminder"
  | "ship-by-overdue"
  | "label-void-eligible"
  | "stalled-in-transit"
  | "delivery-without-intake";

export type ReturnShipmentDeadlineSignal = Readonly<{
  code: ReturnShipmentDeadlineCode;
  /** The instant the signal became due — stable regardless of when it is evaluated. */
  dueAt: string;
  owner: string;
  nextAction: string;
  /** Customer-safe status text, or null when the signal is operator-internal only. */
  customerSafeStatus: string | null;
  escalationTarget: string;
  /** The exception the reconciliation path would raise, or null for a soft reminder. */
  exceptionType: ReturnShipmentExceptionType | null;
  /** True once the operator escalation deadline has also elapsed. */
  escalated: boolean;
}>;

export type ReturnShipmentDeadlineInput = Readonly<{
  status: string;
  shipByDeadlineAt: string;
  labelStatus: string;
  /** Latest carrier movement scan instant while in custody (accept/in-transit). */
  lastMovementAt: string | null;
  deliveredAt: string | null;
  receivedAt: string | null;
}>;

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(fromIso: string, toMs: number): number {
  return (toMs - Date.parse(fromIso)) / HOUR_MS;
}

/**
 * Derives the ordered deadline/exception signals for one reverse shipment as of
 * `asOf`. Terminal shipments (received, cancelled, expired) surface no live
 * deadlines. Each signal names its owner, next action, customer-safe status, and
 * escalation target so every exception path is observable and actionable.
 */
export function deriveReturnShipmentDeadlineSignals(
  input: ReturnShipmentDeadlineInput,
  asOf: string,
  policy: ReturnShipmentDeadlinePolicy = DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY,
): readonly ReturnShipmentDeadlineSignal[] {
  const now = Date.parse(asOf);
  const signals: ReturnShipmentDeadlineSignal[] = [];
  const awaitingShipment = input.status === "requested" || input.status === "ready-to-ship";
  const inCustody = input.status === "carrier-accepted" || input.status === "in-transit";

  const escalated = (dueAt: string): boolean => hoursBetween(dueAt, now) >= policy.operatorEscalationHours;

  if (awaitingShipment) {
    const shipBy = Date.parse(input.shipByDeadlineAt);
    const reminderAt = shipBy - policy.shipByReminderLeadHours * HOUR_MS;
    if (now >= shipBy) {
      signals.push({
        code: "ship-by-overdue",
        dueAt: input.shipByDeadlineAt,
        owner: "support-return-desk",
        nextAction: "Follow up with the buyer or expire the return authorization.",
        customerSafeStatus: "Your return has not shipped yet. Please send it before the deadline passes.",
        escalationTarget: "support-operations",
        exceptionType: "abandoned",
        escalated: escalated(input.shipByDeadlineAt),
      });
    } else if (now >= reminderAt) {
      signals.push({
        code: "ship-by-reminder",
        dueAt: new Date(reminderAt).toISOString(),
        owner: "buyer",
        nextAction: "Remind the buyer to drop off the return.",
        customerSafeStatus: "Please ship your return soon so we can process your resolution.",
        escalationTarget: "support-return-desk",
        exceptionType: null,
        escalated: false,
      });
    }

    if (input.labelStatus === "ready") {
      const voidEligibleAt = shipBy + policy.labelVoidGraceHours * HOUR_MS;
      if (now >= voidEligibleAt) {
        const dueAt = new Date(voidEligibleAt).toISOString();
        signals.push({
          code: "label-void-eligible",
          dueAt,
          owner: "fulfillment-postage",
          nextAction: "Void the unused return label and reclaim the postage.",
          customerSafeStatus: null,
          escalationTarget: "settlement-cost-desk",
          exceptionType: null,
          escalated: escalated(dueAt),
        });
      }
    }
  }

  if (inCustody && input.lastMovementAt) {
    if (hoursBetween(input.lastMovementAt, now) >= policy.stalledInTransitHours) {
      const dueAt = new Date(Date.parse(input.lastMovementAt) + policy.stalledInTransitHours * HOUR_MS).toISOString();
      signals.push({
        code: "stalled-in-transit",
        dueAt,
        owner: "fulfillment-carrier-ops",
        nextAction: "Open a carrier trace on the stalled return.",
        customerSafeStatus: "Your return is delayed in transit. We're checking with the carrier.",
        escalationTarget: "carrier-claims",
        exceptionType: "carrier-delay",
        escalated: escalated(dueAt),
      });
    }
  }

  if (input.deliveredAt && !input.receivedAt) {
    if (hoursBetween(input.deliveredAt, now) >= policy.deliveryWithoutIntakeHours) {
      const dueAt = new Date(Date.parse(input.deliveredAt) + policy.deliveryWithoutIntakeHours * HOUR_MS).toISOString();
      signals.push({
        code: "delivery-without-intake",
        dueAt,
        owner: "facility-operations",
        nextAction: "Locate and intake the delivered return package.",
        customerSafeStatus: "Your return arrived at our facility and is being processed.",
        escalationTarget: "facility-operations",
        exceptionType: "other",
        escalated: escalated(dueAt),
      });
    }
  }

  return signals;
}

/** The customer-safe projection of derived signals: only what a buyer may see. */
export function customerSafeReturnShipmentDeadlineSignals(
  signals: readonly ReturnShipmentDeadlineSignal[],
): readonly Readonly<{ code: ReturnShipmentDeadlineCode; status: string }>[] {
  return signals
    .filter(
      (signal): signal is ReturnShipmentDeadlineSignal & { customerSafeStatus: string } =>
        signal.customerSafeStatus !== null,
    )
    .map((signal) => ({ code: signal.code, status: signal.customerSafeStatus }));
}
