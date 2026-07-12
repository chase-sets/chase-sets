import { formatMoney, t } from "@chase-sets/localization";
import {
  CheckoutConfirmationPanel,
  CheckoutMobileSummaryDisclosure,
  CheckoutSummaryPanel,
  LinkButton,
  OrderProtectionModule,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  productOptionsFromSummary,
  type CheckoutSummaryItem,
} from "@chase-sets/design-system";
import { formatMoneyOrPending, previewLineForSessionLine } from "./checkout-page-formatting";
import type { CheckoutAuthenticityCheckOffer } from "./checkout-shipping-section";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";

export function buildCheckoutOrderSummaryItems(input: {
  lines: CheckoutSessionRow["lines"];
  isOfferIntent: boolean;
  previewOrderLines: readonly CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number][];
}): CheckoutSummaryItem[] {
  return input.lines.map((line, index) => {
    const previewLine = previewLineForSessionLine(line, input.previewOrderLines);
    const lineAmount = input.isOfferIntent ? line.offerPriceAmount : (previewLine?.estimatedLineTotalAmount ?? null);
    return {
      id: line.cartLineId ?? line.listingId ?? `${line.productId}:${index}`,
      title: line.itemTitle,
      subtitle: line.itemSubtitle ?? undefined,
      facts: line.productSummary
        ? [<ProductOptions key="opts" options={productOptionsFromSummary(line.productSummary)} variant="compact" />]
        : undefined,
      quantity: line.quantity,
      price: lineAmount ? formatMoney(lineAmount, "USD") : undefined,
      priceState: lineAmount ? "exact" : "deferred",
      deferredPriceLabel: t("checkout.features.sessions.ui.checkoutPage.pending"),
    };
  });
}

export function buildCheckoutTotalsLines(input: {
  isOfferIntent: boolean;
  preview: CheckoutFulfillmentPreview | null;
  payment: {
    marketplace_checkout_fee: { marketplace_checkout_fee_amount: string };
    wallet_credit: { applied_amount: string };
  } | null;
  authenticityCheckShowsInTotals: boolean;
  authenticityCheckOffer: CheckoutAuthenticityCheckOffer | null;
  wallet: { available_balance_amount: string; currency_code: string } | null | undefined;
}) {
  const { isOfferIntent, preview, payment, authenticityCheckShowsInTotals, authenticityCheckOffer, wallet } = input;

  return [
    {
      label: t("checkout.features.sessions.ui.checkoutPage.subtotal"),
      value: formatMoneyOrPending(preview?.totals.itemSubtotalAmount),
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.shipping.2"),
      value: isOfferIntent
        ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
        : formatMoneyOrPending(preview?.totals.shippingAmount),
      muted: true,
    },
    {
      label: t("checkout.features.sessions.ui.checkoutPage.estimated.tax"),
      value: isOfferIntent
        ? t("checkout.features.sessions.ui.checkoutPage.not.applicable")
        : formatMoneyOrPending(preview?.totals.salesTaxAmount),
      muted: true,
    },
    ...(!isOfferIntent
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee"),
            value: payment
              ? formatMoney(payment.marketplace_checkout_fee.marketplace_checkout_fee_amount, "USD")
              : t("checkout.features.sessions.ui.checkoutPage.calculated.before.payment"),
            muted: !payment,
          },
          {
            label: t("checkout.features.sessions.ui.checkoutPage.wallet.credit"),
            value: payment
              ? formatMoney(`-${payment.wallet_credit.applied_amount}`, "USD")
              : formatMoney("0.00", "USD"),
          },
        ]
      : []),
    ...(authenticityCheckShowsInTotals && authenticityCheckOffer
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.authenticity.check.fee"),
            value: formatMoney(authenticityCheckOffer.fee_amount, "USD"),
          },
        ]
      : []),
    ...(wallet
      ? [
          {
            label: t("checkout.features.sessions.ui.checkoutPage.available.balance"),
            value: formatMoney(wallet.available_balance_amount, wallet.currency_code),
            muted: true,
          },
        ]
      : []),
  ];
}

export type CheckoutOrderSummarySectionProps = Readonly<{
  lineCount: number;
  orderSummaryItems: CheckoutSummaryItem[];
  totalsLines: ReturnType<typeof buildCheckoutTotalsLines>;
  totalsTotalLabel: string;
  totalsTotal: string;
  totalsCaption: string;
  totalsDeferred: boolean;
  isOfferIntent: boolean;
  authenticityCheckShowsInTotals: boolean;
}>;

/** The order-summary panel plus order-protection reassurance module, shared
 * between the desktop aside and the mobile disclosure. */
export function CheckoutOrderSummarySection({
  lineCount,
  orderSummaryItems,
  totalsLines,
  totalsTotalLabel,
  totalsTotal,
  totalsCaption,
  totalsDeferred,
  isOfferIntent,
  authenticityCheckShowsInTotals,
}: CheckoutOrderSummarySectionProps) {
  return (
    <Stack gap={4}>
      <CheckoutSummaryPanel
        title={t("checkout.features.sessions.ui.checkoutPage.order.summary")}
        status={t("checkout.features.sessions.ui.checkoutPage.item.count", { count: lineCount })}
        statusTone="neutral"
        items={orderSummaryItems}
        totals={totalsLines}
        totalLabel={totalsTotalLabel}
        total={totalsTotal}
        totalCaption={totalsCaption}
        deferred={totalsDeferred}
        reassurance={
          <SecurePaymentIndicator
            label={
              isOfferIntent
                ? t("checkout.features.sessions.ui.checkoutPage.no.payment.today")
                : t("checkout.features.sessions.ui.checkoutPage.secure.payment")
            }
          />
        }
      />
      <OrderProtectionModule
        items={[
          {
            title: t("checkout.features.sessions.ui.checkoutPage.buyer.protection"),
            description: t("checkout.features.sessions.ui.checkoutPage.eligible.orders.are.protected.through.payment"),
          },
          isOfferIntent
            ? {
                title: t("checkout.features.sessions.ui.checkoutPage.no.payment.today"),
                description: t(
                  "checkout.features.sessions.ui.checkoutPage.sellers.can.accept.purchase.intent.before.order",
                ),
              }
            : {
                title: t("checkout.features.sessions.ui.checkoutPage.secure.payment"),
                description: t("checkout.features.sessions.ui.checkoutPage.payment.starts.only.after.orders.are"),
              },
          {
            title: t("checkout.features.sessions.ui.checkoutPage.fulfillment.ready"),
            description: isOfferIntent
              ? t("checkout.features.sessions.ui.checkoutPage.shipping.preference.is.captured.for.purchase.intent")
              : t("checkout.features.sessions.ui.checkoutPage.fulfillment.resolved.before.checkout"),
          },
          ...(authenticityCheckShowsInTotals
            ? [
                {
                  title: t("checkout.features.sessions.ui.checkoutPage.authenticity.check.protection"),
                  description: t(
                    "checkout.features.sessions.ui.checkoutPage.authenticity.check.protection.description",
                  ),
                },
              ]
            : []),
        ]}
      />
    </Stack>
  );
}

export function CheckoutMobileSummarySection(props: CheckoutOrderSummarySectionProps) {
  return (
    <CheckoutMobileSummaryDisclosure
      label={t("checkout.features.sessions.ui.checkoutPage.order.summary")}
      collapsedSummary={t("checkout.features.sessions.ui.checkoutPage.item.count", { count: props.lineCount })}
      total={props.totalsTotal}
    >
      <CheckoutOrderSummarySection {...props} />
    </CheckoutMobileSummaryDisclosure>
  );
}

export type CheckoutConfirmationSectionProps = Readonly<{
  paymentId: string;
  orderReferenceValue: string;
  buySupportReferenceValue: string;
  totalsPayableTotal: string;
}>;

/** The Review step once payment has already been confirmed: a receipt-style
 * panel replacing the checkout form entirely. */
export function CheckoutConfirmationSection({
  paymentId,
  orderReferenceValue,
  buySupportReferenceValue,
  totalsPayableTotal,
}: CheckoutConfirmationSectionProps) {
  return (
    <CheckoutConfirmationPanel
      title={t("checkout.features.sessions.ui.checkoutPage.payment.ready.2")}
      description={t("checkout.features.sessions.ui.checkoutPage.purchases.have.been.created.and.payment")}
      referenceLabel={t("checkout.features.sessions.ui.checkoutPage.order.reference")}
      referenceValue={orderReferenceValue}
      supportReferenceLabel={t("checkout.features.sessions.ui.checkoutPage.support.reference")}
      supportReferenceValue={buySupportReferenceValue}
      totalLabel={t("checkout.features.sessions.ui.checkoutPage.payable.total")}
      total={totalsPayableTotal}
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
        <LinkButton href={`/account/payments/${paymentId}`}>
          {t("checkout.features.sessions.ui.checkoutPage.continue.to.payment")}
        </LinkButton>
      }
    />
  );
}
