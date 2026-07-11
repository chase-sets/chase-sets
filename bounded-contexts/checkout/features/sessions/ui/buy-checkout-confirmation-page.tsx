import { t } from "@chase-sets/localization";
import {
  ActionStack,
  CheckoutConfirmationPanel,
  LinkButton,
  OrderProtectionModule,
  Page,
  PageHeader,
  PageSection,
  SecurePaymentIndicator,
  Stack,
} from "@chase-sets/design-system";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";
import {
  buyCheckoutPaymentReference,
  buyCheckoutSupportReference,
  formatBuyCheckoutReferenceList,
} from "./buy-checkout-confirmation-formatting";

export type BuyCheckoutPaymentSummary = Readonly<{
  amount: string;
  status: string;
  currencyCode: string;
}>;

function formatPaymentAmount(paymentSummary: BuyCheckoutPaymentSummary | null) {
  if (!paymentSummary) {
    return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.total.pending");
  }

  const numericAmount = Number(paymentSummary.amount);
  const currencyCode = paymentSummary.currencyCode.toUpperCase();
  if (Number.isFinite(numericAmount)) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(numericAmount);
  }

  return `${paymentSummary.amount} ${currencyCode}`;
}

function paymentStatusLabel(status: string) {
  switch (status) {
    case "pending-confirmation":
      return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.ready");
    case "captured":
      return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.paid");
    case "failed":
      return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.failed");
    case "cancelled":
      return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.cancelled");
    default:
      return t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.pending");
  }
}

export function BuyCheckoutConfirmationPage({
  session,
  paymentPath,
  paymentSummary,
}: {
  session: CheckoutSessionRow;
  paymentPath: string;
  paymentSummary: BuyCheckoutPaymentSummary | null;
}) {
  const orderReferenceValue = formatBuyCheckoutReferenceList(session.order_ids);
  const supportReferenceValue = buyCheckoutSupportReference(session);
  const paymentReferenceValue = buyCheckoutPaymentReference(session);
  const paymentTotalValue = formatPaymentAmount(paymentSummary);
  const paymentStatusValue = paymentSummary
    ? paymentStatusLabel(paymentSummary.status)
    : t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status.preparing");
  const orderStatusValue =
    session.order_ids.length > 0
      ? t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status.created")
      : t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status.pending");

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          eyebrow={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.eyebrow")}
          title={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.title")}
          description={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.description")}
        />

        <PageSection title={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.summary")}>
          <Stack gap={5}>
            <CheckoutConfirmationPanel
              tone="success"
              title={t("checkout.features.sessions.ui.checkoutPage.payment.ready.2")}
              description={t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment")}
              referenceLabel={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.reference")}
              referenceValue={paymentReferenceValue}
              supportReferenceLabel={t("checkout.features.sessions.ui.checkoutPage.support.reference")}
              supportReferenceValue={supportReferenceValue}
              totalLabel={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.total")}
              total={paymentTotalValue}
              nextSteps={[
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.payment.handoff.title"),
                  description: t("checkout.features.sessions.ui.checkoutPage.payment.handoff.description"),
                  icon: "lock",
                },
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.title"),
                  description: t("checkout.features.sessions.ui.checkoutPage.account.fulfillment.pending.description"),
                  icon: "truck",
                },
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.support.reference.ready.title"),
                  description: t("checkout.features.sessions.ui.checkoutPage.support.reference.ready.description"),
                  icon: "shield",
                },
              ]}
              actions={
                <ActionStack
                  primary={
                    <LinkButton href={paymentPath} tone="primary" block>
                      {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
                    </LinkButton>
                  }
                />
              }
            />

            <CheckoutConfirmationPanel
              tone="neutral"
              title={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status")}
              referenceLabel={t("checkout.features.sessions.ui.checkoutPage.order.reference")}
              referenceValue={orderReferenceValue}
              supportReferenceLabel={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status")}
              supportReferenceValue={orderStatusValue}
              totalLabel={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status")}
              total={paymentStatusValue}
            />

            <OrderProtectionModule
              items={[
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
                  description: t(
                    "checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment",
                  ),
                  icon: "shield",
                },
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.payment.ready"),
                  description: t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment"),
                  icon: "creditCard",
                },
              ]}
            />

            <SecurePaymentIndicator
              label={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.handoff")}
            />
          </Stack>
        </PageSection>
      </Stack>
    </Page>
  );
}
