import { t } from "@chase-sets/localization";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { LinkButton, Page, PageHeader, PageSection, PaymentRecoveryPanel } from "@chase-sets/design-system";
function isGuestPaymentAccessExpiredError(error: unknown) {
  return (
    isRouteErrorResponse(error) &&
    (error.status === 401 || error.status === 403) &&
    error.statusText === "Guest checkout link expired"
  );
}
function isPaymentRecoveryError(error: unknown): error is { status: 404 | 503 } {
  return (
    isRouteErrorResponse(error) &&
    (error.status === 404 ||
      (error.status === 503 && error.statusText === t("auth.routes.marketplace.guestPaymentClaim.payment.preparing")))
  );
}

export function GuestPaymentClaimErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();

  if (isPaymentRecoveryError(error)) {
    const isPreparing = error.status === 503;
    const isGuestCheckoutPayment = location.pathname.startsWith("/checkout/claim/");
    const primaryHref = isPreparing
      ? `${location.pathname}${location.search}`
      : isGuestCheckoutPayment
        ? "/account/cart"
        : "/account/purchases";

    return (
      <Page>
        <PageHeader
          eyebrow={t("auth.routes.marketplace.guestPaymentClaim.secure.checkout")}
          title={
            isPreparing
              ? t("auth.routes.marketplace.guestPaymentClaim.payment.preparing")
              : t("auth.routes.marketplace.guestPaymentClaim.payment.not.found")
          }
          description={
            isPreparing
              ? t("auth.routes.marketplace.guestPaymentClaim.payment.preparing.description")
              : t("auth.routes.marketplace.guestPaymentClaim.payment.not.found.description")
          }
        />
        <PageSection title={t("auth.routes.marketplace.guestPaymentClaim.recover.checkout")}>
          <PaymentRecoveryPanel
            statusLabel={
              isPreparing
                ? t("auth.routes.marketplace.guestPaymentClaim.payment.preparing")
                : t("auth.routes.marketplace.guestPaymentClaim.link.unavailable")
            }
            title={
              isPreparing
                ? t("auth.routes.marketplace.guestPaymentClaim.payment.preparing")
                : t("auth.routes.marketplace.guestPaymentClaim.payment.not.found")
            }
            description={
              isPreparing
                ? t("auth.routes.marketplace.guestPaymentClaim.payment.preparing.description")
                : t("auth.routes.marketplace.guestPaymentClaim.payment.not.found.description")
            }
            chargeStatus={t("auth.routes.marketplace.guestPaymentClaim.payment.has.not.started")}
            nextStep={
              isPreparing
                ? t("auth.routes.marketplace.guestPaymentClaim.refresh.payment.in.a.moment")
                : t("auth.routes.marketplace.guestPaymentClaim.review.cart.or.purchases")
            }
            supportPath={t("auth.routes.marketplace.guestPaymentClaim.support.can.help.with.order.access")}
            primaryAction={
              <LinkButton href={primaryHref} leadingIcon={isPreparing ? "refreshCcw" : "cart"}>
                {isPreparing
                  ? t("auth.routes.marketplace.guestPaymentClaim.refresh.payment")
                  : isGuestCheckoutPayment
                    ? t("auth.routes.marketplace.guestPaymentClaim.return.to.cart")
                    : t("auth.routes.marketplace.guestPaymentClaim.back.to.purchases")}
              </LinkButton>
            }
            secondaryAction={
              <LinkButton href="/" tone="secondary" leadingIcon="search">
                {t("auth.routes.marketplace.guestPaymentClaim.continue.shopping")}
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
        eyebrow={t("auth.routes.marketplace.guestPaymentClaim.secure.checkout")}
        title={t("auth.routes.marketplace.guestPaymentClaim.payment.link.expired")}
        description={t("auth.routes.marketplace.guestPaymentClaim.this.checkout.payment.link.is.no.longer")}
      />
      <PageSection title={t("auth.routes.marketplace.guestPaymentClaim.recover.checkout")}>
        <PaymentRecoveryPanel
          statusLabel={t("auth.routes.marketplace.guestPaymentClaim.link.unavailable")}
          title={t("auth.routes.marketplace.guestPaymentClaim.payment.link.expired")}
          description={t("auth.routes.marketplace.guestPaymentClaim.return.to.your.cart.to.review")}
          chargeStatus={t("auth.routes.marketplace.guestPaymentClaim.no.payment.was.charged")}
          nextStep={t("auth.routes.marketplace.guestPaymentClaim.review.cart.or.start.checkout.again")}
          supportPath={t("auth.routes.marketplace.guestPaymentClaim.support.can.help.with.order.access")}
          primaryAction={
            <LinkButton href="/account/cart" leadingIcon="cart">
              {t("auth.routes.marketplace.guestPaymentClaim.return.to.cart")}
            </LinkButton>
          }
          secondaryAction={
            <LinkButton href="/" tone="secondary" leadingIcon="search">
              {t("auth.routes.marketplace.guestPaymentClaim.continue.shopping")}
            </LinkButton>
          }
        />
      </PageSection>
    </Page>
  );
}
