import { t } from "@chase-sets/localization";
import { deriveDisplayReferenceOrRaw } from "@chase-sets/primitives/display-reference";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";

export function orderDisplayReference(orderId: string) {
  return deriveDisplayReferenceOrRaw(orderId as OrderId);
}

export function formatBuyCheckoutReferenceList(values: readonly string[]) {
  return values.length
    ? values.map(orderDisplayReference).join(", ")
    : t("checkout.features.sessions.ui.checkoutPage.pending");
}

/**
 * Payments never mint their own display reference: when a checkout session maps
 * to exactly one order it borrows that order's reference, falling back to the raw
 * payment id (matching the payments-context transactional email convention).
 */
export function buyCheckoutPaymentReference(session: CheckoutSessionRow) {
  if (session.order_ids.length === 1) {
    return orderDisplayReference(session.order_ids[0]!);
  }

  return session.payment_id ?? t("checkout.features.sessions.ui.checkoutPage.pending");
}

export function buyCheckoutSupportReference(session: CheckoutSessionRow) {
  const splitGroupSupportReference = session.split_group_handoff?.supportReference.trim();
  if (splitGroupSupportReference) {
    return splitGroupSupportReference;
  }

  const readinessGroupSupportReference = session.cart_readiness_snapshot?.fulfillmentGroups
    .find((group) => group.supportReference.trim().length > 0)
    ?.supportReference.trim();

  return readinessGroupSupportReference || t("checkout.features.sessions.ui.checkoutPage.pending");
}
