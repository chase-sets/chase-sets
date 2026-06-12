import { t } from "@chase-sets/localization";
import { useLocation, useRouteError } from "react-router";
import { LinkButton, Page, PageHeader, PageSection, PaymentRecoveryPanel } from "@chase-sets/design-system";
import { isGuestPaymentAccessExpiredError, isPaymentRecoveryError } from "./account-payment-display";

export function AccountPaymentErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();

  if (isPaymentRecoveryError(error)) {
    const isPreparing = error.status === 503;
    const isGuestCheckoutPayment = location.pathname.startsWith("/checkout/payments/");
    const primaryHref = isPreparing
      ? `${location.pathname}${location.search}`
      : isGuestCheckoutPayment
        ? "/account/cart"
        : "/account/purchases";

    return (
      <Page>
        <PageHeader
          eyebrow={t("payments.routes.marketplace.accountPayment.secure.checkout")}
          title={
            isPreparing
              ? t("payments.routes.marketplace.accountPayment.payment.preparing")
              : t("payments.routes.marketplace.accountPayment.payment.not.found")
          }
          description={
            isPreparing
              ? t("payments.routes.marketplace.accountPayment.payment.preparing.description")
              : t("payments.routes.marketplace.accountPayment.payment.not.found.description")
          }
        />
        <PageSection title={t("payments.routes.marketplace.accountPayment.recover.checkout")}>
          <PaymentRecoveryPanel
            statusLabel={
              isPreparing
                ? t("payments.routes.marketplace.accountPayment.payment.preparing")
                : t("payments.routes.marketplace.accountPayment.link.unavailable")
            }
            title={
              isPreparing
                ? t("payments.routes.marketplace.accountPayment.payment.preparing")
                : t("payments.routes.marketplace.accountPayment.payment.not.found")
            }
            description={
              isPreparing
                ? t("payments.routes.marketplace.accountPayment.payment.preparing.description")
                : t("payments.routes.marketplace.accountPayment.payment.not.found.description")
            }
            chargeStatus={t("payments.routes.marketplace.accountPayment.payment.has.not.started")}
            nextStep={
              isPreparing
                ? t("payments.routes.marketplace.accountPayment.refresh.payment.in.a.moment")
                : t("payments.routes.marketplace.accountPayment.review.cart.or.purchases")
            }
            supportPath={t("payments.routes.marketplace.accountPayment.support.can.help.with.order.access")}
            primaryAction={
              <LinkButton href={primaryHref} leadingIcon={isPreparing ? "refreshCcw" : "cart"}>
                {isPreparing
                  ? t("payments.routes.marketplace.accountPayment.refresh.payment")
                  : isGuestCheckoutPayment
                    ? t("payments.routes.marketplace.accountPayment.return.to.cart")
                    : t("payments.routes.marketplace.accountPayment.back.to.purchases")}
              </LinkButton>
            }
            secondaryAction={
              <LinkButton href="/" tone="secondary" leadingIcon="search">
                {t("payments.routes.marketplace.accountPayment.continue.shopping")}
              </LinkButton>
            }
          />
        </PageSection>
      </Page>
    );
  }

  if (!isGuestPaymentAccessExpiredError(error)) {
    throw error;
  }

  return (
    <Page>
      <PageHeader
        eyebrow={t("payments.routes.marketplace.accountPayment.secure.checkout")}
        title={t("payments.routes.marketplace.accountPayment.payment.link.expired")}
        description={t("payments.routes.marketplace.accountPayment.this.checkout.payment.link.is.no.longer")}
      />
      <PageSection title={t("payments.routes.marketplace.accountPayment.recover.checkout")}>
        <PaymentRecoveryPanel
          statusLabel={t("payments.routes.marketplace.accountPayment.link.unavailable")}
          title={t("payments.routes.marketplace.accountPayment.payment.link.expired")}
          description={t("payments.routes.marketplace.accountPayment.return.to.your.cart.to.review")}
          chargeStatus={t("payments.routes.marketplace.accountPayment.no.payment.was.charged")}
          nextStep={t("payments.routes.marketplace.accountPayment.review.cart.or.start.checkout.again")}
          supportPath={t("payments.routes.marketplace.accountPayment.support.can.help.with.order.access")}
          primaryAction={
            <LinkButton href="/account/cart" leadingIcon="cart">
              {t("payments.routes.marketplace.accountPayment.return.to.cart")}
            </LinkButton>
          }
          secondaryAction={
            <LinkButton href="/" tone="secondary" leadingIcon="search">
              {t("payments.routes.marketplace.accountPayment.continue.shopping")}
            </LinkButton>
          }
        />
      </PageSection>
    </Page>
  );
}
