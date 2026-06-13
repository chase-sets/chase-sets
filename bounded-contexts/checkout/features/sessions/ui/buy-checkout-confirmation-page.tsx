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

export function BuyCheckoutConfirmationPage({
  session,
  paymentPath,
}: {
  session: CheckoutSessionRow;
  paymentPath: string;
}) {
  const itemCount = session.lines.reduce((sum, line) => sum + line.quantity, 0);
  const orderReferenceValue = formatBuyCheckoutReferenceList(session.order_ids);
  const supportReferenceValue = buyCheckoutSupportReference(session);
  const paymentReferenceValue = session.payment_id ?? t("checkout.features.sessions.ui.checkoutPage.pending");

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
                  {t("checkout.features.sessions.ui.buyCheckoutConfirmationPage.payment.reference")}
                </dt>
                <dd className="min-w-0 break-words text-right font-semibold text-foreground">
                  {paymentReferenceValue}
                </dd>
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
