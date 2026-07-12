import { formatBpsPercent, t } from "@chase-sets/localization";
import { useState } from "react";
import {
  ReferenceInfoDialog,
  ReferenceInfoTrigger,
  Stack,
  Text,
  type ReferenceInfoSection,
} from "@chase-sets/design-system";
import {
  formatAllowanceDelta,
  formatMoney,
  formatMoneyDelta,
  formatResolvedAt,
  isPublicStandardTerms,
  moneyDelta,
  multiplyMoney,
  termsSourceLabel,
} from "./sell-list-formatting";
import type { SellListOfferReview, SellListOfferTermsComparison, SellListTermsPreview } from "./sell-list-page-types";

function comparisonSummaryLine(
  comparison: SellListOfferTermsComparison | null | undefined,
  finalTerms: SellListTermsPreview | null | undefined,
  quantity: number,
) {
  if (!comparison) {
    return null;
  }

  if (comparison.status === "same") {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.same.line");
  }
  if (comparison.status === "standard-preview-unavailable") {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.standard.unavailable.line");
  }
  if (comparison.status === "final-unavailable") {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.final.unavailable.line");
  }

  const standardPreview = comparison.standardPreview;
  const netDelta =
    finalTerms && standardPreview
      ? moneyDelta(finalTerms.seller_net_unit_amount, standardPreview.seller_net_unit_amount, quantity)
      : 0;

  if (netDelta < 0) {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.worse.line");
  }
  if (netDelta > 0) {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.better.line");
  }

  return t("checkout.features.sellList.ui.sellListPage.terms.comparison.changed.line");
}

export function comparisonInlineDetail(comparison: SellListOfferTermsComparison | null | undefined) {
  if (!comparison) {
    return null;
  }

  if (comparison.status === "changed") {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.changed.inline");
  }
  if (comparison.status === "final-unavailable") {
    return t("checkout.features.sellList.ui.sellListPage.terms.comparison.final.unavailable.inline");
  }

  return null;
}

function comparisonSection(review: SellListOfferReview, quantity: number): ReferenceInfoSection | null {
  const comparison = review.comparison;
  if (!comparison) {
    return null;
  }

  const standardPreview = comparison.standardPreview;
  const finalTerms = review.terms;
  const items: NonNullable<ReferenceInfoSection["items"]> = [];

  items.push({
    key: t("checkout.features.sellList.ui.sellListPage.standard.estimate"),
    value: standardPreview
      ? formatMoney(multiplyMoney(standardPreview.seller_net_unit_amount, quantity))
      : t("checkout.features.sellList.ui.sellListPage.unavailable"),
  });
  items.push({
    key: t("checkout.features.sellList.ui.sellListPage.final.registered.payout"),
    value: finalTerms
      ? formatMoney(multiplyMoney(finalTerms.seller_net_unit_amount, quantity))
      : t("checkout.features.sellList.ui.sellListPage.refresh.needed"),
  });

  if (standardPreview && finalTerms) {
    items.push({
      key: t("checkout.features.sellList.ui.sellListPage.payout.change"),
      value: formatMoneyDelta(
        moneyDelta(finalTerms.seller_net_unit_amount, standardPreview.seller_net_unit_amount, quantity),
      ),
    });
    items.push({
      key: t("checkout.features.sellList.ui.sellListPage.sales.fee.change"),
      value: formatMoneyDelta(
        moneyDelta(
          finalTerms.marketplace_sales_fee_unit_amount,
          standardPreview.marketplace_sales_fee_unit_amount,
          quantity,
        ),
      ),
    });
    items.push({
      key: t("checkout.features.sellList.ui.sellListPage.shipping.allowance.change"),
      value: formatAllowanceDelta(
        finalTerms.shipping_allowance_percentage_bps - standardPreview.shipping_allowance_percentage_bps,
      ),
    });
    if (comparison.changedFields.includes("terms-source")) {
      items.push({
        key: t("checkout.features.sellList.ui.sellListPage.final.terms.source"),
        value: termsSourceLabel(finalTerms),
      });
    }
  }

  return {
    title: t("checkout.features.sellList.ui.sellListPage.standard.estimate.comparison"),
    items,
  };
}

export function SellListTermsReferenceInfo({ review, quantity }: { review: SellListOfferReview; quantity: number }) {
  const [open, setOpen] = useState(false);
  const terms = review.terms ?? review.comparison?.standardPreview ?? null;
  if (!terms) {
    return null;
  }

  const source = termsSourceLabel(terms);
  const feeTotal = multiplyMoney(terms.marketplace_sales_fee_unit_amount, quantity);
  const basisTotal = multiplyMoney(terms.basis_amount, quantity);
  const allowanceBps = terms.shipping_allowance_percentage_bps ?? null;
  const allowanceAmount =
    allowanceBps !== null && Number.isFinite(basisTotal) ? (basisTotal * allowanceBps) / 10000 : null;
  const sections: ReferenceInfoSection[] = [
    {
      title: t("checkout.features.sellList.ui.sellListPage.estimated.payout.facts"),
      items: [
        {
          key: t("checkout.features.sellList.ui.sellListPage.sales.fee"),
          value: formatMoney(feeTotal),
        },
        ...(allowanceBps !== null
          ? [
              {
                key: t("checkout.features.sellList.ui.sellListPage.shipping.allowance"),
                value: `${formatMoney(allowanceAmount)} (${formatBpsPercent(allowanceBps)})`,
              },
            ]
          : []),
        {
          key: t("checkout.features.sellList.ui.sellListPage.terms.source"),
          value: source,
        },
        {
          key: t("checkout.features.sellList.ui.sellListPage.quote.time"),
          value: formatResolvedAt(terms),
        },
      ],
    },
  ];
  const termsComparisonSection = comparisonSection(review, quantity);
  if (termsComparisonSection) {
    sections.push(termsComparisonSection);
  }
  const comparisonLine = comparisonSummaryLine(review.comparison, review.terms, quantity);
  const lines = [
    ...(isPublicStandardTerms(terms)
      ? [
          t("checkout.features.sellList.ui.sellListPage.public.standard.terms.line1"),
          t("checkout.features.sellList.ui.sellListPage.public.standard.terms.line2"),
        ]
      : [t("checkout.features.sellList.ui.sellListPage.registered.terms.line1")]),
    ...(comparisonLine ? [comparisonLine] : []),
  ];

  return (
    <>
      <ReferenceInfoTrigger
        tone="neutral"
        aria-label={t("checkout.features.sellList.ui.sellListPage.estimated.payout.aria")}
        onClick={() => setOpen(true)}
      >
        {t("checkout.features.sellList.ui.sellListPage.estimated.payout")}
      </ReferenceInfoTrigger>
      <ReferenceInfoDialog
        open={open}
        onOpenChange={setOpen}
        title={t("checkout.features.sellList.ui.sellListPage.estimated.payout")}
        summary={t("checkout.features.sellList.ui.sellListPage.estimated.payout.summary", { source })}
        sections={sections}
      >
        <Stack gap={2}>
          {lines.map((line, index) => (
            <Text key={index} size="sm" tone="secondary">
              {line}
            </Text>
          ))}
        </Stack>
      </ReferenceInfoDialog>
    </>
  );
}
