import { t } from "@chase-sets/localization";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";

export function formatBuyCheckoutReferenceList(values: readonly string[]) {
  return values.length ? values.join(", ") : t("checkout.features.sessions.ui.checkoutPage.pending");
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
