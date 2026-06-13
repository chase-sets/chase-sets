import { t } from "@chase-sets/localization";
import {
  CheckoutConfirmationPanel,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutSessionRow } from "../../../support/request-support/api-client";
import { buyCheckoutSupportReference, formatBuyCheckoutReferenceList } from "./buy-checkout-confirmation-formatting";

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
  const itemCount = session.lines.reduce((sum, line) => sum + line.quantity, 0);
  const orderReferenceValue = formatBuyCheckoutReferenceList(session.order_ids);
  const supportReferenceValue = buyCheckoutSupportReference(session);
  const paymentReferenceValue = session.payment_id ?? t("checkout.features.sessions.ui.checkoutPage.pending");
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
          actions={
            <LinkButton href={paymentPath}>
              {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
            </LinkButton>
          }
        />

        <PageSection title={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.handoff")}>
          <CheckoutConfirmationPanel
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
              <LinkButton href={paymentPath}>
                {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
              </LinkButton>
            }
          />
        </PageSection>

        <PageSection title={t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.summary")}>
          <Surface elevated>
            <dl className="grid gap-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{t("checkout.features.sessions.ui.checkoutPage.items")}</dt>
                <dd className="text-right font-semibold text-foreground">{itemCount}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">{t("checkout.features.sessions.ui.checkoutPage.order.reference")}</dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{orderReferenceValue}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">
                  {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.order.status")}
                </dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{orderStatusValue}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">
                  {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.reference")}
                </dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">
                  {paymentReferenceValue}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">
                  {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.status")}
                </dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{paymentStatusValue}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-secondary">
                  {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.total")}
                </dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">{paymentTotalValue}</dd>
              </div>
            </dl>
            <Text tone="secondary" size="sm">
              {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.summary.description")}
            </Text>
          </Surface>
        </PageSection>
      </Stack>
    </Page>
  );
}
