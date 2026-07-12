import { t } from "@chase-sets/localization";

export function checkoutStartHeaderCopy(params: Readonly<{ isSignedIn: boolean; isOfferIntent: boolean }>) {
  if (params.isOfferIntent) {
    return params.isSignedIn
      ? {
          title: t("checkout.routes.checkoutStart.place.purchase.intent"),
          description: t("checkout.routes.checkoutStart.confirm.shipping.so.the.seller.can.review"),
        }
      : {
          title: t("checkout.routes.checkoutStart.register.to.place.purchase.intent"),
          description: t("checkout.routes.checkoutStart.register.or.sign.in.purchase.intent.copy"),
        };
  }

  return params.isSignedIn
    ? {
        title: t("checkout.routes.checkoutStart.continue.checkout"),
        description: t("checkout.routes.checkoutStart.continue.with.your.account.so.purchases.payments"),
      }
    : {
        title: t("checkout.routes.checkoutStart.sign.in.or.continue.as.guest"),
        description: t("checkout.routes.checkoutStart.sign.in.to.keep.orders.with.your.account"),
      };
}

export function checkoutStartBuyerProtectionItems(isOfferIntent: boolean) {
  return isOfferIntent
    ? [
        {
          title: t("checkout.routes.checkoutStart.transparent.next.step"),
          description: t("checkout.routes.checkoutStart.sellers.review.purchase.intent.before.payment"),
        },
        {
          title: t("checkout.routes.checkoutStart.recoverable.checkout"),
          description: t("checkout.routes.checkoutStart.account.keeps.purchase.intent.traceable"),
        },
        {
          title: t("checkout.routes.checkoutStart.protected.payment"),
          description: t("checkout.routes.checkoutStart.payment.collected.only.after.seller.accepts"),
        },
      ]
    : [
        {
          title: t("checkout.routes.checkoutStart.transparent.next.step"),
          description: t("checkout.routes.checkoutStart.shipping.fees.and.final.totals.are.shown"),
        },
        {
          title: t("checkout.routes.checkoutStart.recoverable.checkout"),
          description: t("checkout.routes.checkoutStart.guest.receipts.and.signed.in.order.history"),
        },
        {
          title: t("checkout.routes.checkoutStart.protected.payment"),
          description: t("checkout.routes.checkoutStart.payment.begins.only.after.the.checkout.session"),
        },
      ];
}
