import { t } from "@chase-sets/localization";
import {
  ActionRow,
  Button,
  CheckoutStickyActionBar,
  LinkButton,
  MarketplaceEmptyState,
  SecurePaymentIndicator,
  Show,
} from "@chase-sets/design-system";

export type CheckoutCommitButtonProps = Readonly<{
  hasPayment: boolean;
  paymentId: string | null;
  isOfferIntent: boolean;
  reservationExpired: boolean;
  reReserveIntent: string;
  canConfirm: boolean;
  commitIntent: string;
  commitIcon: "refreshCcw" | "lock";
  isSubmitting: boolean;
  submittingCtaLabel: string;
  primaryCtaLabel: string;
  form?: string;
}>;

/** The single checkout commit affordance, resolved by state: continue to an
 * already-started payment, re-reserve an expired hold, go back to cart when
 * nothing is confirmable, or submit the checkout-confirmation form. */
export function checkoutCommitButton({
  hasPayment,
  paymentId,
  isOfferIntent,
  reservationExpired,
  reReserveIntent,
  canConfirm,
  commitIntent,
  commitIcon,
  isSubmitting,
  submittingCtaLabel,
  primaryCtaLabel,
  form,
}: CheckoutCommitButtonProps) {
  if (hasPayment && paymentId) {
    return (
      <LinkButton href={`/account/payments/${paymentId}`} block>
        {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
      </LinkButton>
    );
  }

  if (!isOfferIntent && reservationExpired) {
    return (
      <Button
        type="submit"
        form={form}
        name="intent"
        value={reReserveIntent}
        leadingIcon="refreshCcw"
        loading={isSubmitting}
        disabled={isSubmitting}
        block
      >
        {isSubmitting
          ? t("checkout.features.sessions.ui.checkoutPage.processing.payment")
          : t("checkout.features.sessions.ui.checkoutPage.reserve.again")}
      </Button>
    );
  }

  if (!canConfirm && !isOfferIntent) {
    return (
      <LinkButton href="/account/cart" leadingIcon="cart" block>
        {t("checkout.features.sessions.ui.checkoutPage.review.buy.cart")}
      </LinkButton>
    );
  }

  return (
    <Button
      type="submit"
      form={form}
      name="intent"
      value={commitIntent}
      leadingIcon={commitIcon}
      loading={isSubmitting}
      disabled={isSubmitting || (!canConfirm && !isOfferIntent)}
      block
    >
      {isSubmitting ? submittingCtaLabel : primaryCtaLabel}
    </Button>
  );
}

export function CheckoutBackToCartAction({ tone }: { tone?: "secondary" }) {
  return (
    <LinkButton href="/account/cart" tone={tone}>
      {t("checkout.features.sessions.ui.checkoutPage.back.to.cart")}
    </LinkButton>
  );
}

export type CheckoutInFormCommitRowProps = CheckoutCommitButtonProps;

/** The md+ in-form primary action row. The mobile counterpart lives in
 * CheckoutStickyActionBar (md:hidden), so this hides below md to keep exactly
 * one visible "Pay now" per viewport. Both submit checkout-confirmation-form. */
export function CheckoutInFormCommitRow(props: CheckoutInFormCommitRowProps) {
  return (
    <Show from="md">
      <ActionRow
        align="between"
        primary={checkoutCommitButton(props)}
        secondary={<CheckoutBackToCartAction tone="secondary" />}
      />
    </Show>
  );
}

export type CheckoutStickyActionProps = Readonly<{
  totalsTotalLabel: string;
  hasPayment: boolean;
  totalsTotal: string;
  isOfferIntent: boolean;
  commitButtonProps: CheckoutCommitButtonProps;
}>;

export function CheckoutStickyAction({
  totalsTotalLabel,
  hasPayment,
  totalsTotal,
  isOfferIntent,
  commitButtonProps,
}: CheckoutStickyActionProps) {
  return (
    <CheckoutStickyActionBar
      totalLabel={totalsTotalLabel}
      total={hasPayment ? t("checkout.features.sessions.ui.checkoutPage.payment.ready") : totalsTotal}
      context={
        isOfferIntent
          ? t("checkout.features.sessions.ui.checkoutPage.shipping.saved.for.seller.acceptance")
          : t("checkout.features.sessions.ui.checkoutPage.secure.checkout.context")
      }
      reassurance={
        <SecurePaymentIndicator
          label={
            isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
              : t("checkout.features.sessions.ui.checkoutPage.secure.payment")
          }
        />
      }
      primaryAction={checkoutCommitButton({ ...commitButtonProps, form: "checkout-confirmation-form" })}
      secondaryAction={<CheckoutBackToCartAction />}
    />
  );
}

export function CheckoutEmptyCartState() {
  return (
    <MarketplaceEmptyState
      title={t("checkout.features.sessions.ui.checkoutPage.your.cart.is.empty")}
      description={t("checkout.features.sessions.ui.checkoutPage.add.a.product.before.starting.checkout")}
      recoveryActions={
        <LinkButton href="/search">{t("checkout.features.sessions.ui.checkoutPage.browse.marketplace")}</LinkButton>
      }
    />
  );
}
