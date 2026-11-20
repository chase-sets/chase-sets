import { permissionAwaitsEmailVerification, type ResolvedActor } from "@chase-sets/auth-context";

export type CheckoutPaymentStartRefusalCode = "email_verification_required" | "authorization_forbidden";

/**
 * Why this buyer cannot start a payment, or null when they can. Payments starts a payment only for an
 * actor with `orders.manage` or `guest-checkout.manage` (`paymentStartAccess`), so Checkout refuses a
 * confirmation that still needs one before it writes anything the buyer could not pay for. Auth
 * withholding `orders.manage` until the email is verified is a refusal the buyer can lift; any
 * other missing permission is not.
 */
export function checkoutPaymentStartRefusalCode(
  actor: Pick<ResolvedActor, "roleKey" | "permissions" | "agentGrant">,
): CheckoutPaymentStartRefusalCode | null {
  if (actor.permissions.includes("orders.manage") || actor.permissions.includes("guest-checkout.manage")) {
    return null;
  }

  return permissionAwaitsEmailVerification(actor, "orders.manage")
    ? "email_verification_required"
    : "authorization_forbidden";
}

/**
 * Whether a confirmation of this Session would still start a payment: a live Session that is not a
 * purchase intent and has no payment or submitted offer yet. Only such a confirmation is refused.
 */
export function checkoutConfirmationNeedsPaymentStart(session: {
  source_type: string;
  payment_id: string | null;
  submitted_offer_id?: string | null;
  cancelled_at?: string | null;
}): boolean {
  return (
    session.source_type !== "offer-intent" &&
    !session.payment_id &&
    !session.submitted_offer_id &&
    !session.cancelled_at
  );
}
