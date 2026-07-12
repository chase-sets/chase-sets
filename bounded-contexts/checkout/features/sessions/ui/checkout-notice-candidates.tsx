import { t } from "@chase-sets/localization";
import { Button, CheckoutStateNotice, LinkButton, type CheckoutNoticeCandidate } from "@chase-sets/design-system";
import { reservationUnavailableItemsLabel } from "./checkout-page-formatting";
import type { CheckoutReservationUnavailableLine } from "./checkout-page-types";

export type CheckoutNoticeCandidatesInput = Readonly<{
  hasReservationUnavailableCheckoutLines: boolean;
  reservationUnavailableCheckoutLines: readonly CheckoutReservationUnavailableLine[];
  isOfferIntent: boolean;
  reservationExpired: boolean;
  reReserveIntent: string;
  isSubmitting: boolean;
  unavailableCheckoutLines: readonly unknown[];
  unavailableCount: number;
  hasAcknowledgedVisibleFulfillmentPreview: boolean;
  materialChangeDescription: string | null;
  hasPendingReviewChanges: boolean;
  paymentQuoteRequired: boolean;
  reviewRefreshed: boolean;
  showSavedCheckoutRows: boolean;
  canUseAcceleratedSavedPayment: boolean;
  returningBuyerFastPath: boolean;
  savedAddressReady: boolean;
  defaultSavedAddressLabel: string | undefined;
  selectedSavedPaymentInstrumentLabel: string | undefined;
  effectivePaymentMethodCategory: string;
}>;

/** One notice at a time, by the §4 priority ladder. Each in-flow checkout
 * state is a candidate; CheckoutNoticeStack renders only the highest-priority
 * active one. */
export function buildCheckoutNoticeCandidates(input: CheckoutNoticeCandidatesInput): CheckoutNoticeCandidate[] {
  const paymentMethodCategoryLabel =
    input.selectedSavedPaymentInstrumentLabel ?? input.effectivePaymentMethodCategory.replace("-", " ");

  return [
    {
      priority: "needs-review",
      active: input.hasReservationUnavailableCheckoutLines,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.reservation.unavailable.title")}
          description={t(
            input.reservationUnavailableCheckoutLines.length === 1
              ? "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.one"
              : "checkout.features.sessions.ui.checkoutPage.reservation.unavailable.description.many",
            {
              count: input.reservationUnavailableCheckoutLines.length,
              items: reservationUnavailableItemsLabel(input.reservationUnavailableCheckoutLines),
            },
          )}
          action={
            <LinkButton href="/account/cart" tone="secondary" size="sm">
              {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
            </LinkButton>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: !input.isOfferIntent && input.reservationExpired,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.reservation.expired")}
          description={t("checkout.features.sessions.ui.checkoutPage.reservation.expired.description")}
          action={
            <Button
              type="submit"
              form="checkout-confirmation-form"
              name="intent"
              value={input.reReserveIntent}
              leadingIcon="refreshCcw"
              loading={input.isSubmitting}
              size="sm"
            >
              {t("checkout.features.sessions.ui.checkoutPage.reserve.again")}
            </Button>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active:
        !input.isOfferIntent &&
        !input.hasReservationUnavailableCheckoutLines &&
        !input.reservationExpired &&
        (input.unavailableCheckoutLines.length > 0 || input.unavailableCount > 0),
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review")}
          description={t("checkout.features.sessions.ui.checkoutPage.checkout.needs.cart.review.description", {
            count: input.unavailableCheckoutLines.length || input.unavailableCount,
          })}
          action={
            <LinkButton href="/account/cart" tone="secondary" size="sm">
              {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
            </LinkButton>
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: !input.isOfferIntent && input.hasAcknowledgedVisibleFulfillmentPreview,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed")}
          description={
            input.materialChangeDescription ??
            t("checkout.features.sessions.ui.checkoutPage.fulfillment.changed.description")
          }
        />
      ),
    },
    {
      priority: "needs-review",
      active: input.hasPendingReviewChanges,
      notice: (
        <CheckoutStateNotice
          tone="warning"
          title={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh")}
          description={t("checkout.features.sessions.ui.checkoutPage.totals.need.refresh.description")}
        />
      ),
    },
    {
      priority: "savings",
      active: input.paymentQuoteRequired,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required")}
          description={t("checkout.features.sessions.ui.checkoutPage.payment.quote.required.description")}
        />
      ),
    },
    {
      priority: "savings",
      active: input.reviewRefreshed,
      notice: (
        <CheckoutStateNotice
          tone="success"
          title={t("checkout.features.sessions.ui.checkoutPage.review.updated")}
          description={t("checkout.features.sessions.ui.checkoutPage.review.updated.description")}
        />
      ),
    },
    {
      priority: "info",
      active: !input.showSavedCheckoutRows && input.canUseAcceleratedSavedPayment,
      notice: (
        <CheckoutStateNotice
          tone="success"
          title={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.fast.checkout.ready.description", {
            addressLabel: input.defaultSavedAddressLabel,
            paymentMethodCategory: paymentMethodCategoryLabel,
          })}
        />
      ),
    },
    {
      priority: "info",
      active: !input.showSavedCheckoutRows && input.returningBuyerFastPath && !input.canUseAcceleratedSavedPayment,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.saved.payment.step.ready.description", {
            addressLabel: input.defaultSavedAddressLabel,
            paymentMethodCategory: paymentMethodCategoryLabel,
          })}
        />
      ),
    },
    {
      priority: "info",
      active: !input.showSavedCheckoutRows && input.savedAddressReady,
      notice: (
        <CheckoutStateNotice
          tone="info"
          title={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready")}
          description={t("checkout.features.sessions.ui.checkoutPage.saved.address.ready.description", {
            addressLabel: input.defaultSavedAddressLabel,
          })}
        />
      ),
    },
  ];
}
