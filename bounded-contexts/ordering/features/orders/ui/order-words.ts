import { t } from "@chase-sets/localization";

/** An order's status in words. A status Ordering adds later shows as its code until it has words. */
export function orderStatusWords(status: string): string {
  switch (status) {
    case "pending-reservation":
      return t("ordering.features.orders.ui.orderDetailPage.order.status.pending.reservation");
    case "pending-payment":
      return t("ordering.features.orders.ui.orderDetailPage.order.status.pending.payment");
    case "ready-for-fulfillment":
      return t("ordering.features.orders.ui.orderDetailPage.order.status.ready.for.fulfillment");
    case "cancelled":
      return t("ordering.features.orders.ui.orderDetailPage.order.status.cancelled");
    default:
      return status;
  }
}

/** An order's shipping option in words, or its code when it has none. */
export function shippingOptionWords(option: string): string {
  switch (option) {
    case "standard":
      return t("ordering.features.orders.ui.orderDetailPage.shipping.option.standard");
    case "expedited":
      return t("ordering.features.orders.ui.orderDetailPage.shipping.option.expedited");
    case "priority":
      return t("ordering.features.orders.ui.orderDetailPage.shipping.option.priority");
    default:
      return option;
  }
}

/** An inventory hold's status in words, or its code when it has none. */
export function inventoryHoldStatusWords(status: string): string {
  switch (status) {
    case "active":
      return t("ordering.features.orders.ui.orderDetailPage.hold.status.active");
    case "released":
      return t("ordering.features.orders.ui.orderDetailPage.hold.status.released");
    case "consumed":
      return t("ordering.features.orders.ui.orderDetailPage.hold.status.consumed");
    case "expired":
      return t("ordering.features.orders.ui.orderDetailPage.hold.status.expired");
    default:
      return status;
  }
}
