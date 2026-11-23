import type { AuthorizationSnapshot, ValidatedPaymentSource } from "./contracts";
import { authorizationEvent } from "./contracts";

export type AuthorizationState = Readonly<{
  snapshot: AuthorizationSnapshot;
  absent: boolean;
  heldOrderIds: ReadonlySet<string>;
}>;

export const initialAuthorization: AuthorizationState = {
  snapshot: { state: "none", generation: 0, source: null, consentVersion: null, latestHeldOrderId: null },
  absent: true,
  heldOrderIds: new Set(),
};

export type AuthorizationCommand =
  | { type: "authorize"; source: ValidatedPaymentSource; consentVersion: string }
  | { type: "resume"; source: ValidatedPaymentSource }
  | { type: "revoke" }
  | { type: "markPaymentMethodUnavailable"; generation: number; instrumentId: string }
  | { type: "holdForFailedPayment"; generation: number; orderId: string }
  | { type: "markRequired" };

type LifecycleEventType = Exclude<
  (typeof authorizationEvent)[keyof typeof authorizationEvent],
  typeof authorizationEvent.previewed | typeof authorizationEvent.changed
>;
export type AuthorizationChange = Readonly<{ type: LifecycleEventType; snapshot: AuthorizationSnapshot }>;

export class OfferPaymentAuthorizationError extends Error {
  constructor(
    public readonly code:
      | "invalid_transition"
      | "invalid_payment_source"
      | "offer_payment_consent_not_approved"
      | "stale_preview"
      | "operation_conflict",
  ) {
    super(code);
  }
}

export function decideAuthorization(
  current: AuthorizationState,
  command: AuthorizationCommand,
): AuthorizationChange | null {
  const { snapshot } = current;
  const { state, generation, source } = snapshot;
  const change = (type: LifecycleEventType, patch: Partial<AuthorizationSnapshot>): AuthorizationChange => ({
    type,
    snapshot: { ...snapshot, ...patch },
  });
  const reject = (): never => {
    throw new OfferPaymentAuthorizationError("invalid_transition");
  };
  switch (command.type) {
    case "markRequired":
      return current.absent ? change(authorizationEvent.required, {}) : null;
    case "authorize":
      if (state === "held" || state === "payment-method-unavailable") reject();
      if (
        state === "active" &&
        source?.instrumentId === command.source.instrumentId &&
        source.useBalance === command.source.useBalance
      )
        reject();
      return change(authorizationEvent.authorized, {
        state: "active",
        source: command.source,
        consentVersion: command.consentVersion,
        generation: generation + 1,
      });
    case "markPaymentMethodUnavailable":
      return state === "active" && generation === command.generation && source?.instrumentId === command.instrumentId
        ? change(authorizationEvent.unavailable, { state: "payment-method-unavailable" })
        : null;
    case "holdForFailedPayment":
      return (state === "active" || state === "payment-method-unavailable") &&
        generation === command.generation &&
        !current.heldOrderIds.has(command.orderId)
        ? change(authorizationEvent.held, { state: "held", latestHeldOrderId: command.orderId })
        : null;
    case "resume":
      if (state !== "held" && state !== "payment-method-unavailable") reject();
      return change(authorizationEvent.resumed, {
        state: "active",
        source: command.source,
        generation: generation + 1,
      });
    case "revoke":
      if (state === "none" || state === "revoked") reject();
      return change(authorizationEvent.revoked, { state: "revoked" });
  }
}

export function evolveAuthorization(current: AuthorizationState, event: AuthorizationChange): AuthorizationState {
  return {
    snapshot: event.snapshot,
    absent: false,
    heldOrderIds:
      event.type === authorizationEvent.held
        ? new Set([...current.heldOrderIds, event.snapshot.latestHeldOrderId!])
        : current.heldOrderIds,
  };
}
