import {
  HiddenInput,
  Form,
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  CurrencyInput,
  Divider,
  Grid,
  Inline,
  Inset,
  KeyValueList,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  ReferenceInfoDialog,
  type ReferenceInfoSection,
  ReferenceInfoTrigger,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { useState } from "react";
import type { CheckoutSellListConfirmationRow, CheckoutSellListLineRow } from "../read-model/queries";
import { sellListConfirmationSupportReference } from "../read-model/support-reference";
import { SELLER_CHECKOUT_REGISTER_HREF, SELLER_CHECKOUT_SIGN_IN_HREF } from "./registration-return";

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: SellListTermsPreview | null;
  comparison: SellListOfferTermsComparison | null;
  message: string | null;
}>;

type SellListOfferTermsComparisonField = "seller-net" | "marketplace-fee" | "shipping-allowance" | "terms-source";

type SellListOfferTermsComparison = Readonly<{
  status: "same" | "changed" | "standard-preview-unavailable" | "final-unavailable";
  standardPreview: SellListTermsPreview | null;
  changedFields: readonly SellListOfferTermsComparisonField[];
}>;

type SellListTermsPreview = Readonly<{
  account_type?: string;
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  fee_quote_fingerprint?: string;
  resolved_at?: string;
  source_kind?: "public-standard-seller-terms";
  source_label?: string;
  source_updated_at?: string;
  schedule_label?: string;
  schedule_id?: string | null;
  agreement_id?: string | null;
}>;

type SellListProductOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  offers: readonly Readonly<{
    offer: Readonly<{
      offer_id: string;
      buyer_display_name: string | null;
      buyer_account_id: string;
      price_amount: string;
      quantity_requested: number;
      offer_to_listing_price_bps: number;
      buyer_average_rating?: string | null;
      buyer_review_count?: number;
      seller_available_quantity?: number;
      can_fulfill?: boolean;
      created_at?: string;
    }>;
    terms: Readonly<{
      marketplace_sales_fee_unit_amount: string;
      seller_net_unit_amount: string;
      fee_quote_fingerprint: string;
    }>;
  }>[];
  message: string | null;
}>;

type PayoutReadiness = Readonly<{
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
}>;

type SellListInventoryItem = Readonly<{
  item_id: string;
  product_id: string;
  item_title: string | null;
  product_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}>;

type LineReadiness = Readonly<{
  ready: boolean;
  label: string;
  detail: string;
  tone: "success" | "warning";
}>;

type SellListRecoveryState = Readonly<
  | {
      kind: "pending-fresh-write";
      message: string;
      refreshHref: string;
      isAutoRevalidating?: boolean;
    }
  | {
      kind: "missing-after-fresh-write";
      message: string;
      refreshHref: string;
    }
>;

function moneyNumber(value: string | null | undefined) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function positiveMoney(value: string | null | undefined) {
  const amount = moneyNumber(value);
  return amount > 0 ? amount : null;
}

function formatMoney(value: string | number | null) {
  if (value === null) {
    return "-";
  }

  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) {
    return String(value);
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

const confirmationStatusLabelKeys = {
  "accepted-offer": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.offer",
  "accepted-smart-match": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.accepted.smart.match",
  completed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.completed",
  failed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.failed",
  "handoff-recorded": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.handoff.recorded",
  "kept-in-sell-list": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.kept.in.sell.list",
  mixed: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.mixed",
  "not-attempted": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.not.attempted",
  partial: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.partial",
  "pending-downstream": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.pending.downstream",
  "published-listing": "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.published.listing",
  skipped: "checkout.features.sellList.ui.sellListPage.latest.confirmation.status.skipped",
} as const;

function formatStatus(value: string | null | undefined) {
  const status = value?.trim() || "not-attempted";
  const labelKey = confirmationStatusLabelKeys[status as keyof typeof confirmationStatusLabelKeys];
  if (labelKey) {
    return t(labelKey);
  }

  return status
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sideEffectTone(status: string): "accent" | "success" | "warning" | "danger" {
  switch (status) {
    case "handoff-recorded":
      return "success";
    case "pending-downstream":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "accent";
  }
}

function hasPendingDownstreamSideEffects(
  sideEffects: CheckoutSellListConfirmationRow["handoff_summary"]["sideEffects"],
) {
  return Object.values(sideEffects ?? {}).some((status) => status === "pending-downstream");
}

function lineOutcomeDisplayStatus(
  outcome: NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number],
  sideEffects: CheckoutSellListConfirmationRow["handoff_summary"]["sideEffects"],
) {
  return outcome.status === "completed" && hasPendingDownstreamSideEffects(sideEffects)
    ? "handoff-recorded"
    : outcome.status;
}

function confirmationReferenceSummary(
  outcome: NonNullable<CheckoutSellListConfirmationRow["handoff_summary"]["lineOutcomes"]>[number],
) {
  return outcome.references
    ? t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.downstream")
    : t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference.pending");
}

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function multiplyMoney(value: string | null | undefined, quantity: number) {
  return moneyNumber(value) * quantity;
}

function moneyDelta(finalValue: string | null | undefined, standardValue: string | null | undefined, quantity: number) {
  return multiplyMoney(finalValue, quantity) - multiplyMoney(standardValue, quantity);
}

function formatMoneyDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return t("checkout.features.sellList.ui.sellListPage.no.change");
  }

  return `${value > 0 ? "+" : "-"}${formatMoney(Math.abs(value))}`;
}

function formatAllowanceDelta(value: number) {
  if (!Number.isFinite(value) || value === 0) {
    return t("checkout.features.sellList.ui.sellListPage.no.change");
  }

  return `${value > 0 ? "+" : "-"}${formatAllowancePercentage(Math.abs(value))}`;
}

function isPublicStandardTerms(terms: SellListTermsPreview | null | undefined) {
  return terms?.source_kind === "public-standard-seller-terms";
}

function termsSourceLabel(terms: SellListTermsPreview) {
  if (terms.source_label) {
    return terms.source_label;
  }

  if (terms.agreement_id) {
    return t("checkout.features.sellList.ui.sellListPage.seller.specific.terms");
  }

  return t("checkout.features.sellList.ui.sellListPage.standard.terms");
}

function formatResolvedAt(terms: SellListTermsPreview) {
  return terms.resolved_at
    ? new Date(terms.resolved_at).toLocaleString()
    : t("checkout.features.sellList.ui.sellListPage.just.now");
}

function productOptionsFromSelectedOptions(selections: readonly { dimensionId: string; optionId: string }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.dimensionId,
    optionLabel: selection.optionId,
  }));
}

function listingSetupHref(line: CheckoutSellListLineRow, priceAmount: string | null | undefined) {
  const searchParams = new URLSearchParams({
    catalogItemId: line.catalog_catalog_item_id,
  });
  if (positiveMoney(priceAmount) !== null && priceAmount) {
    searchParams.set("recommendedPrice", priceAmount);
  }
  if (line.selected_options.length > 0) {
    searchParams.set("selectedOptions", JSON.stringify(line.selected_options));
  }

  return `/account/listings/new?${searchParams.toString()}`;
}

function inventorySetupHref(line: CheckoutSellListLineRow) {
  const searchParams = new URLSearchParams({
    catalogItemId: line.catalog_catalog_item_id,
    returnTo: "/account/sell-list",
  });
  if (line.selected_options.length > 0) {
    searchParams.set("selectedOptions", JSON.stringify(line.selected_options));
  }

  return `/account/inventory?${searchParams.toString()}`;
}

function inventoryListingSetupHref(inventoryItemId: string, priceAmount: string | null | undefined) {
  const searchParams = new URLSearchParams({ inventoryItemId });
  if (positiveMoney(priceAmount) !== null && priceAmount) {
    searchParams.set("recommendedPrice", priceAmount);
  }

  return `/account/listings/new?${searchParams.toString()}`;
}

function sellListLineSetupHref(line: CheckoutSellListLineRow, inventoryItem?: SellListInventoryItem | null) {
  if (line.line_type === "product" && inventoryItem) {
    return inventoryListingSetupHref(inventoryItem.item_id, line.minimum_listing_price_amount);
  }

  return listingSetupHref(
    line,
    line.line_type === "selected-offer" ? line.offer_price_amount : line.minimum_listing_price_amount,
  );
}

function sellListLineRecoveryHref(line: CheckoutSellListLineRow, inventoryItem?: SellListInventoryItem | null) {
  if (line.line_type === "product" && !inventoryItem) {
    return inventorySetupHref(line);
  }

  return sellListLineSetupHref(line, inventoryItem);
}

function buyerLabel(offer: { buyer_display_name: string | null; buyer_account_id: string | null }) {
  const displayName = offer.buyer_display_name?.trim();
  return displayName || t("checkout.features.sellList.ui.sellListPage.buyer");
}

function selectedOfferReadiness(review: SellListOfferReview | undefined): LineReadiness {
  if (review?.status === "ready" && review.terms) {
    return {
      ready: true,
      label: t("checkout.features.sellList.ui.sellListPage.ready"),
      detail: isPublicStandardTerms(review.terms)
        ? t("checkout.features.sellList.ui.sellListPage.public.standard.offer.preview.ready.detail")
        : t("checkout.features.sellList.ui.sellListPage.selected.offer.ready.detail"),
      tone: "success",
    };
  }

  return {
    ready: false,
    label: t("checkout.features.sellList.ui.sellListPage.needs.refresh"),
    detail: review?.message ?? t("checkout.features.sellList.ui.sellListPage.offer.terms.need.refresh"),
    tone: "warning",
  };
}

function productLineCanSubmitCheckout(options: {
  review: SellListProductOfferReview | undefined;
  defaultInventoryItem: SellListInventoryItem | null;
}): boolean {
  const readyOfferCount = options.review?.offers.length ?? 0;
  return readyOfferCount > 0 || Boolean(options.defaultInventoryItem);
}

function productLineReadiness(options: {
  review: SellListProductOfferReview | undefined;
  line: CheckoutSellListLineRow;
  defaultInventoryItem: SellListInventoryItem | null;
}): LineReadiness {
  const readyOfferCount = options.review?.offers.length ?? 0;
  const fallbackReady =
    options.line.fallback_mode === "create-listing" &&
    Boolean(options.defaultInventoryItem) &&
    positiveMoney(options.line.minimum_listing_price_amount) !== null;

  if (readyOfferCount > 0 || fallbackReady || (readyOfferCount === 0 && options.defaultInventoryItem)) {
    return {
      ready: true,
      label: t("checkout.features.sellList.ui.sellListPage.ready"),
      detail:
        readyOfferCount > 0
          ? t("checkout.features.sellList.ui.sellListPage.smart.match.ready.detail", { count: readyOfferCount })
          : fallbackReady
            ? t("checkout.features.sellList.ui.sellListPage.fallback.listing.ready.detail")
            : t("checkout.features.sellList.ui.sellListPage.fallback.listing.form.ready.detail"),
      tone: "success",
    };
  }

  return {
    ready: false,
    label: t("checkout.features.sellList.ui.sellListPage.needs.action"),
    detail:
      options.review?.message ?? t("checkout.features.sellList.ui.sellListPage.choose.sale.action.before.checkout"),
    tone: "warning",
  };
}

function readinessBadge(readiness: LineReadiness) {
  return <Badge tone={readiness.tone}>{readiness.label}</Badge>;
}

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

function comparisonInlineDetail(comparison: SellListOfferTermsComparison | null | undefined) {
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

function SellListTermsReferenceInfo({ review, quantity }: { review: SellListOfferReview; quantity: number }) {
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
                value: `${formatMoney(allowanceAmount)} (${formatAllowancePercentage(allowanceBps)})`,
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

function SelectedOfferRow({
  line,
  review,
}: {
  line: CheckoutSellListLineRow;
  review: SellListOfferReview | undefined;
}) {
  const readiness = selectedOfferReadiness(review);
  const comparisonDetail = comparisonInlineDetail(review?.comparison);
  const setupHref = sellListLineSetupHref(line);

  return (
    <Surface element="article" tone="default" padding={4}>
      <Grid templateColumns="minmax(0,1fr) auto" stackUntil="md" gap={4}>
        <Stack gap={3}>
          <Stack gap={2}>
            <Inline gap={2}>
              <Badge tone="success">{t("checkout.features.sellList.ui.sellListPage.selected.offer")}</Badge>
              {readinessBadge(readiness)}
            </Inline>
            <Stack gap={1}>
              <Text weight="semibold" wrap="anywhere">
                {line.item_title}
              </Text>
              {line.item_subtitle ? (
                <Text size="sm" tone="secondary" wrap="anywhere">
                  {line.item_subtitle}
                </Text>
              ) : null}
              <ProductOptions
                options={productOptionsFromSelectedOptions(line.selected_options)}
                emptyLabel={line.product_summary ?? t("checkout.features.sellList.ui.sellListPage.standard")}
              />
            </Stack>
            <Text size="sm" tone="secondary">
              {readiness.detail}
            </Text>
            {comparisonDetail ? (
              <Text size="sm" tone="secondary">
                {comparisonDetail}
              </Text>
            ) : null}
            {review?.terms || review?.comparison?.standardPreview ? (
              <SellListTermsReferenceInfo review={review} quantity={line.quantity} />
            ) : null}
            {!readiness.ready ? (
              <Inline gap={2}>
                <LinkButton href={setupHref} tone="secondary" size="sm">
                  {t("checkout.features.sellList.ui.sellListPage.create.matching.listing")}
                </LinkButton>
              </Inline>
            ) : null}
          </Stack>
          <KeyValueList
            density="compact"
            variant="plain"
            items={[
              {
                key: t("checkout.features.sellList.ui.sellListPage.buyer"),
                value: buyerLabel(line),
              },
              {
                key: t("checkout.features.sellList.ui.sellListPage.quantity"),
                value: line.quantity,
              },
              {
                key: t("checkout.features.sellList.ui.sellListPage.offer"),
                value: formatMoney(line.offer_price_amount),
              },
              {
                key: t("checkout.features.sellList.ui.sellListPage.seller.net"),
                value: review?.terms ? formatMoney(review.terms.seller_net_unit_amount) : "-",
              },
            ]}
          />
        </Stack>
        <Form spacing="none" method="post">
          <HiddenInput type="hidden" name="intent" value="remove-sell-list-line" />
          <HiddenInput type="hidden" name="lineId" value={line.line_id} />
          {review?.terms?.fee_quote_fingerprint ? (
            <HiddenInput
              type="hidden"
              form="sell-list-checkout-form"
              name={`offerFeeQuoteFingerprint:${line.line_id}`}
              value={review.terms.fee_quote_fingerprint}
            />
          ) : null}
          <Button type="submit" tone="secondary" size="md" leadingIcon="trash">
            {t("checkout.features.sellList.ui.sellListPage.remove")}
          </Button>
        </Form>
      </Grid>
    </Surface>
  );
}

function ProductLineRow({
  line,
  review,
  inventoryOptions,
}: {
  line: CheckoutSellListLineRow;
  review: SellListProductOfferReview | undefined;
  inventoryOptions: readonly SellListInventoryItem[];
}) {
  const defaultInventoryItem = inventoryOptions[0] ?? null;
  const readiness = productLineReadiness({ line, review, defaultInventoryItem });
  const matchingOfferQuantity = review?.offers.reduce((sum, item) => sum + item.offer.quantity_requested, 0) ?? 0;
  const matchingOffersCoverLine = matchingOfferQuantity >= line.quantity;
  const defaultPrice = line.minimum_listing_price_amount ?? "";
  const setupHref = sellListLineSetupHref(line, defaultInventoryItem);
  const inventoryHref = inventorySetupHref(line);

  return (
    <Surface element="article" tone="default" padding={4}>
      <Stack gap={4}>
        <Grid templateColumns="minmax(0,1fr) auto" stackUntil="md" gap={4}>
          <Stack gap={3}>
            <Stack gap={2}>
              <Inline gap={2}>
                <Badge tone="info">{t("checkout.features.sellList.ui.sellListPage.product.line")}</Badge>
                {readinessBadge(readiness)}
              </Inline>
              <Stack gap={1}>
                <Text weight="semibold" wrap="anywhere">
                  {line.item_title}
                </Text>
                {line.item_subtitle ? (
                  <Text size="sm" tone="secondary" wrap="anywhere">
                    {line.item_subtitle}
                  </Text>
                ) : null}
                <ProductOptions
                  options={productOptionsFromSelectedOptions(line.selected_options)}
                  emptyLabel={line.product_summary ?? t("checkout.features.sellList.ui.sellListPage.standard")}
                />
              </Stack>
              <Text size="sm" tone="secondary" wrap="anywhere">
                {readiness.detail}
              </Text>
            </Stack>
            <KeyValueList
              density="compact"
              variant="plain"
              items={[
                {
                  key: t("checkout.features.sellList.ui.sellListPage.quantity"),
                  value: line.quantity,
                },
                {
                  key: t("checkout.features.sellList.ui.sellListPage.matching.offers"),
                  value:
                    matchingOfferQuantity > 0
                      ? t("checkout.features.sellList.ui.sellListPage.matching.offer.quantity", {
                          quantity: matchingOfferQuantity,
                        })
                      : t("checkout.features.sellList.ui.sellListPage.no.ready.matching.offers"),
                },
                {
                  key: t("checkout.features.sellList.ui.sellListPage.minimum.listing.price"),
                  value: formatMoney(line.minimum_listing_price_amount),
                },
                {
                  key: t("checkout.features.sellList.ui.sellListPage.inventory"),
                  value: defaultInventoryItem
                    ? t("checkout.features.sellList.ui.sellListPage.inventory.option.label", {
                        location: defaultInventoryItem.storage_location_name,
                        shipFrom: defaultInventoryItem.ship_from_code,
                        quantity: defaultInventoryItem.available_quantity,
                      })
                    : t("checkout.features.sellList.ui.sellListPage.inventory.required"),
                },
              ]}
            />
          </Stack>
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="remove-sell-list-line" />
            <HiddenInput type="hidden" name="lineId" value={line.line_id} />
            <Button type="submit" tone="secondary" size="md" leadingIcon="trash">
              {t("checkout.features.sellList.ui.sellListPage.remove")}
            </Button>
          </Form>
        </Grid>

        <Divider />
        <Stack gap={3}>
          <Text weight="semibold">{t("checkout.features.sellList.ui.sellListPage.pre.checkout.action")}</Text>
          {review?.offers.length ? (
            <Stack gap={2}>
              {review.offers.map(({ offer, terms }) => (
                <Stack key={offer.offer_id} gap={1}>
                  <Inline gap={2}>
                    <Badge tone="success">
                      {t("checkout.features.sellList.ui.sellListPage.use.smart.match.offer", {
                        buyer: buyerLabel(offer),
                      })}
                    </Badge>
                    <Text size="sm" tone="secondary">
                      {t("checkout.features.sellList.ui.sellListPage.use.smart.match.offer.description", {
                        quantity: offer.quantity_requested,
                        sellerNet: formatMoney(terms.seller_net_unit_amount),
                      })}
                    </Text>
                  </Inline>
                  <HiddenInput
                    form="sell-list-checkout-form"
                    type="hidden"
                    name={`productOfferId:${line.line_id}`}
                    value={offer.offer_id}
                  />
                  <HiddenInput
                    form="sell-list-checkout-form"
                    type="hidden"
                    name={`productOfferFeeQuoteFingerprint:${line.line_id}:${offer.offer_id}`}
                    value={terms.fee_quote_fingerprint}
                  />
                </Stack>
              ))}
            </Stack>
          ) : (
            <Stack gap={2}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.no.smart.match.offers.available")}
              </Text>
              {!readiness.ready ? (
                <Inline gap={2}>
                  <LinkButton href={setupHref} tone="secondary" size="sm">
                    {t("checkout.features.sellList.ui.sellListPage.create.listing")}
                  </LinkButton>
                  <LinkButton href={inventoryHref} tone="ghost" size="sm">
                    {t("checkout.features.sellList.ui.sellListPage.add.inventory")}
                  </LinkButton>
                </Inline>
              ) : null}
            </Stack>
          )}
          <Grid columns={{ base: 1, md: 3 }} gap={3}>
            <NativeSelect
              form="sell-list-checkout-form"
              label={t("checkout.features.sellList.ui.sellListPage.remaining.quantity.action")}
              name={`fallbackMode:${line.line_id}`}
              defaultValue={matchingOffersCoverLine ? "none" : defaultInventoryItem ? "create-listing" : "none"}
              items={[
                {
                  value: "none",
                  label:
                    matchingOfferQuantity > 0
                      ? t("checkout.features.sellList.ui.sellListPage.keep.remaining.in.sell.list")
                      : t("checkout.features.sellList.ui.sellListPage.keep.in.sell.list"),
                },
                {
                  value: "create-listing",
                  label: t("checkout.features.sellList.ui.sellListPage.create.listing.for.remaining"),
                  disabled: !defaultInventoryItem,
                },
              ]}
            />
            <NativeSelect
              form="sell-list-checkout-form"
              label={t("checkout.features.sellList.ui.sellListPage.ship.from.inventory")}
              name={`inventoryItemId:${line.line_id}`}
              defaultValue={defaultInventoryItem?.item_id ?? ""}
              placeholder={t("checkout.features.sellList.ui.sellListPage.choose.inventory")}
              items={inventoryOptions.map((item) => ({
                value: item.item_id,
                label: t("checkout.features.sellList.ui.sellListPage.inventory.option.label", {
                  location: item.storage_location_name,
                  shipFrom: item.ship_from_code,
                  quantity: item.available_quantity,
                }),
              }))}
            />
            <CurrencyInput
              form="sell-list-checkout-form"
              label={t("checkout.features.sellList.ui.sellListPage.listing.price")}
              name={`priceAmount:${line.line_id}`}
              defaultValue={defaultPrice}
              min="0.01"
              step="0.01"
              required={Boolean(defaultInventoryItem)}
            />
            <HiddenInput
              form="sell-list-checkout-form"
              type="hidden"
              name={`quantityCap:${line.line_id}`}
              value={Math.min(line.quantity, defaultInventoryItem?.available_quantity ?? line.quantity)}
            />
          </Grid>
        </Stack>
      </Stack>
    </Surface>
  );
}

function LatestSellListConfirmationPanel({ confirmation }: { confirmation: CheckoutSellListConfirmationRow | null }) {
  if (!confirmation) {
    return null;
  }

  const summary = confirmation.handoff_summary;
  const lineOutcomes = Array.isArray(summary.lineOutcomes) ? summary.lineOutcomes : [];
  const sideEffects = summary.sideEffects ?? {};
  const supportReference = sellListConfirmationSupportReference(confirmation.confirmation_id);
  const sideEffectRows = [
    { key: "sale", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.sale") },
    {
      key: "accountHistory",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.account.history"),
    },
    { key: "label", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.label") },
    { key: "payout", label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.payout") },
    {
      key: "settlement",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.settlement"),
    },
    {
      key: "notification",
      label: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.side.effect.notification"),
    },
  ] as const;

  return (
    <PageSection title={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.title")}>
      <Surface elevated>
        <Stack gap={4}>
          <MarketplaceNotice
            tone="info"
            title={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.title")}
            description={t("checkout.features.sellList.ui.sellListPage.latest.confirmation.notice.description")}
          />
          <Grid columns={{ base: 1, md: 4 }} gap={3}>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.reference")}
              </Text>
              <Text weight="semibold" wrap="anywhere">
                {supportReference}
              </Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.recorded")}
              </Text>
              <Text>{new Date(confirmation.confirmed_at).toLocaleString()}</Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.accepted.offers")}
              </Text>
              <Text weight="semibold">{summary.acceptedOfferCount ?? 0}</Text>
            </Stack>
            <Stack gap={1}>
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.listings.published")}
              </Text>
              <Text weight="semibold">{summary.publishedListingCount ?? 0}</Text>
            </Stack>
          </Grid>

          <Grid columns={{ base: 1, md: 3 }} gap={2}>
            {sideEffectRows.map((entry) => {
              const status = sideEffects[entry.key] ?? "not-attempted";
              return (
                <Inset key={entry.key} padding={3}>
                  <Inline gap={2}>
                    <Text weight="semibold">{entry.label}</Text>
                    <Badge tone={sideEffectTone(status)}>{formatStatus(status)}</Badge>
                  </Inline>
                </Inset>
              );
            })}
          </Grid>

          {lineOutcomes.length > 0 ? (
            <Stack gap={3}>
              <Text weight="semibold">
                {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.line.outcomes")}
              </Text>
              {lineOutcomes.map((outcome) => {
                const displayStatus = lineOutcomeDisplayStatus(outcome, sideEffects);
                return (
                  <Inset key={outcome.lineId} padding={3}>
                    <Grid columns={{ base: 1, md: 3 }} gap={3}>
                      <Stack gap={1}>
                        <Inline gap={2}>
                          <Badge tone={sideEffectTone(displayStatus)}>{formatStatus(displayStatus)}</Badge>
                          <Text weight="semibold" wrap="anywhere">
                            {outcome.itemTitle}
                          </Text>
                        </Inline>
                        <Text size="sm" tone="secondary">
                          {outcome.detail}
                        </Text>
                      </Stack>
                      <KeyValueList
                        density="compact"
                        variant="plain"
                        items={[
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.action"),
                            value: formatStatus(outcome.action),
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.quantity"),
                            value: outcome.quantity,
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.latest.confirmation.remaining"),
                            value: outcome.remainingQuantity,
                          },
                        ]}
                      />
                      <Stack gap={1}>
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.support.references")}
                        </Text>
                        <Text wrap="anywhere">{confirmationReferenceSummary(outcome)}</Text>
                      </Stack>
                    </Grid>
                  </Inset>
                );
              })}
            </Stack>
          ) : null}

          <Inline gap={2}>
            <LinkButton href="/account/sell-list">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.seller.activity")}
            </LinkButton>
            <LinkButton href="/account/sales" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.committed.sales")}
            </LinkButton>
            <LinkButton href="/account/sales/shipments" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.view.sale.shipments")}
            </LinkButton>
            <LinkButton href="/account/support" tone="secondary">
              {t("checkout.features.sellList.ui.sellListPage.latest.confirmation.open.support")}
            </LinkButton>
          </Inline>
        </Stack>
      </Surface>
    </PageSection>
  );
}

export function CheckoutSellListPage({
  sellListLines,
  isSignedIn = true,
  offerReviews = [],
  productOfferReviews = [],
  inventoryItems = [],
  payoutReadiness = null,
  latestConfirmation = null,
  registrationReturn = null,
  mergedLineCount = 0,
  mergeError = null,
  sellerCheckoutRegisterHref = SELLER_CHECKOUT_REGISTER_HREF,
  sellerCheckoutSignInHref = SELLER_CHECKOUT_SIGN_IN_HREF,
  errorMessage = null,
  recoveryMessage = null,
  recoveryState = null,
}: {
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn?: boolean;
  offerReviews?: readonly SellListOfferReview[];
  productOfferReviews?: readonly SellListProductOfferReview[];
  inventoryItems?: readonly SellListInventoryItem[];
  payoutReadiness?: PayoutReadiness | null;
  latestConfirmation?: CheckoutSellListConfirmationRow | null;
  registrationReturn?: "seller-checkout" | null;
  mergedLineCount?: number;
  mergeError?: string | null;
  sellerCheckoutRegisterHref?: string;
  sellerCheckoutSignInHref?: string;
  errorMessage?: string | null;
  recoveryMessage?: string | null;
  recoveryState?: SellListRecoveryState | null;
}) {
  const selectedOfferLines = sellListLines.filter((line) => line.line_type === "selected-offer");
  const productLines = sellListLines.filter((line) => line.line_type === "product");
  const offerReviewsByLineId = new Map((offerReviews ?? []).map((review) => [review.lineId, review]));
  const productOfferReviewsByLineId = new Map((productOfferReviews ?? []).map((review) => [review.lineId, review]));
  const inventoryByProductId = new Map<string, SellListInventoryItem[]>();
  for (const item of inventoryItems ?? []) {
    inventoryByProductId.set(item.product_id, [...(inventoryByProductId.get(item.product_id) ?? []), item]);
  }

  const totalQuantity = sellListLines.reduce((sum, line) => sum + line.quantity, 0);
  const selectedOfferGross = selectedOfferLines.reduce(
    (sum, line) => sum + moneyNumber(line.offer_price_amount) * line.quantity,
    0,
  );
  const selectedOfferSellerNet = selectedOfferLines.reduce((sum, line) => {
    const review = offerReviewsByLineId.get(line.line_id);
    return sum + moneyNumber(review?.terms?.seller_net_unit_amount ?? line.offer_price_amount) * line.quantity;
  }, 0);
  const smartMatchSellerNet = productLines.reduce((sum, line) => {
    const review = productOfferReviewsByLineId.get(line.line_id);
    return (
      sum +
      (review?.offers ?? []).reduce(
        (offerSum, { offer, terms }) => offerSum + moneyNumber(terms.seller_net_unit_amount) * offer.quantity_requested,
        0,
      )
    );
  }, 0);
  const futureListingGross = productLines.reduce((sum, line) => {
    const review = productOfferReviewsByLineId.get(line.line_id);
    const matchedQuantity = (review?.offers ?? []).reduce(
      (quantity, item) => quantity + item.offer.quantity_requested,
      0,
    );
    const fallbackQuantity = line.fallback_mode === "create-listing" ? Math.max(0, line.quantity - matchedQuantity) : 0;
    return sum + moneyNumber(line.minimum_listing_price_amount) * fallbackQuantity;
  }, 0);
  const estimatedSalesFees =
    selectedOfferLines.reduce((sum, line) => {
      const review = offerReviewsByLineId.get(line.line_id);
      return sum + moneyNumber(review?.terms?.marketplace_sales_fee_unit_amount) * line.quantity;
    }, 0) +
    productLines.reduce((sum, line) => {
      const review = productOfferReviewsByLineId.get(line.line_id);
      return (
        sum +
        (review?.offers ?? []).reduce(
          (offerSum, { offer, terms }) =>
            offerSum + moneyNumber(terms.marketplace_sales_fee_unit_amount) * offer.quantity_requested,
          0,
        )
      );
    }, 0);
  const expectedSellerPayout = selectedOfferSellerNet + smartMatchSellerNet;
  const lineReadiness = sellListLines.map((line) =>
    line.line_type === "selected-offer"
      ? selectedOfferReadiness(offerReviewsByLineId.get(line.line_id))
      : productLineReadiness({
          line,
          review: productOfferReviewsByLineId.get(line.line_id),
          defaultInventoryItem: inventoryByProductId.get(line.product_id)?.[0] ?? null,
        }),
  );
  const lineCanSubmitCheckout = sellListLines.map((line) =>
    line.line_type === "selected-offer"
      ? selectedOfferReadiness(offerReviewsByLineId.get(line.line_id)).ready
      : productLineCanSubmitCheckout({
          review: productOfferReviewsByLineId.get(line.line_id),
          defaultInventoryItem: inventoryByProductId.get(line.product_id)?.[0] ?? null,
        }),
  );
  const blockedLineCount = lineReadiness.filter((readiness) => !readiness.ready).length;
  const blockedSubmissionLineCount = lineCanSubmitCheckout.filter((canSubmit) => !canSubmit).length;
  const readyLineCount = sellListLines.length - blockedLineCount;
  const payoutIsReady = isSignedIn ? payoutReadiness?.status === "ready" : true;
  const canContinue = payoutIsReady && blockedSubmissionLineCount === 0 && sellListLines.length > 0;
  const firstBlockedLine =
    sellListLines.find((line, index) => !lineCanSubmitCheckout[index]) ??
    sellListLines.find((line, index) => !lineReadiness[index]?.ready) ??
    null;
  const firstBlockedLineHref = firstBlockedLine
    ? sellListLineRecoveryHref(firstBlockedLine, inventoryByProductId.get(firstBlockedLine.product_id)?.[0] ?? null)
    : null;
  const recoveryHref = !payoutIsReady
    ? "/account/payouts/setup?returnTo=%2Faccount%2Fsell-list"
    : (firstBlockedLineHref ?? "/search");
  const recoveryLabel = !payoutIsReady
    ? t("checkout.features.sellList.ui.sellListPage.set.up.payouts")
    : blockedLineCount > 0
      ? t("checkout.features.sellList.ui.sellListPage.resolve.items")
      : t("checkout.features.sellList.ui.sellListPage.keep.selling");
  const primarySellerCheckoutLabel = isSignedIn
    ? t("checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout")
    : t("checkout.features.sellList.ui.sellListPage.create.account.to.continue");
  const readinessSummary =
    blockedLineCount > 0
      ? t("checkout.features.sellList.ui.sellListPage.readiness.needs.action", { count: blockedLineCount })
      : t("checkout.features.sellList.ui.sellListPage.readiness.ready", { count: readyLineCount });

  const summary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          { label: t("checkout.features.sellList.ui.sellListPage.items"), value: totalQuantity },
          { label: t("checkout.features.sellList.ui.sellListPage.sell.list.lines"), value: sellListLines.length },
          {
            label: t("checkout.features.sellList.ui.sellListPage.selected.offer.gross"),
            value: formatMoney(selectedOfferGross),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.expected.seller.payout"),
            value: formatMoney(expectedSellerPayout),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.future.listing.gross"),
            value: formatMoney(futureListingGross),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.estimated.sales.fees"),
            value: formatMoney(estimatedSalesFees),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.payout.readiness"),
            value: !isSignedIn
              ? t("checkout.features.sellList.ui.sellListPage.sign.in.required")
              : payoutReadiness?.status === "ready"
                ? t("checkout.features.sellList.ui.sellListPage.ready")
                : t("checkout.features.sellList.ui.sellListPage.setup.required"),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.line.readiness"),
            value: readinessSummary,
          },
        ]}
        total={formatMoney(expectedSellerPayout)}
        totalLabel={t("checkout.features.sellList.ui.sellListPage.expected.seller.payout")}
        reassurance={
          <SecurePaymentIndicator label={t("checkout.features.sellList.ui.sellListPage.no.commitment.until.review")} />
        }
      />
    </Stack>
  );

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          eyebrow={t("checkout.features.sellList.ui.sellListPage.checkout")}
          title={t("checkout.features.sellList.ui.sellListPage.sell.list")}
          description={t("checkout.features.sellList.ui.sellListPage.simple.review.description")}
        />

        {!isSignedIn ? (
          <Banner
            title={t("checkout.features.sellList.ui.sellListPage.account.gate.title")}
            description={t("checkout.features.sellList.ui.sellListPage.account.gate.description")}
            tone="info"
            actions={
              <Inline gap={2}>
                <LinkButton href={sellerCheckoutRegisterHref}>
                  {t("checkout.features.sellList.ui.sellListPage.create.account")}
                </LinkButton>
                <LinkButton href={sellerCheckoutSignInHref} tone="secondary">
                  {t("checkout.features.sellList.ui.sellListPage.sign.in")}
                </LinkButton>
              </Inline>
            }
          />
        ) : null}

        {isSignedIn && registrationReturn === "seller-checkout" ? (
          mergeError ? (
            <MarketplaceNotice
              tone="warning"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.merge.issue.title")}
              description={mergeError}
            />
          ) : mergedLineCount > 0 ? (
            <MarketplaceNotice
              tone="success"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.merged.title")}
              description={t("checkout.features.sellList.ui.sellListPage.registration.return.merged.description", {
                count: mergedLineCount,
              })}
            />
          ) : (
            <MarketplaceNotice
              tone="info"
              title={t("checkout.features.sellList.ui.sellListPage.registration.return.review.title")}
              description={t("checkout.features.sellList.ui.sellListPage.registration.return.review.description")}
            />
          )
        ) : null}

        {errorMessage ? (
          <MarketplaceNotice
            tone="warning"
            title={t("checkout.features.sellList.ui.sellListPage.checkout.issue")}
            description={errorMessage}
          />
        ) : null}

        {isSignedIn ? <LatestSellListConfirmationPanel confirmation={latestConfirmation} /> : null}

        {sellListLines.length === 0 && recoveryState?.kind === "pending-fresh-write" ? (
          <Surface tone="subtle" elevated>
            <Stack gap={3}>
              <Badge tone="neutral">
                {recoveryState.isAutoRevalidating
                  ? t("checkout.features.sellList.ui.sellListPage.sell.list.update.pending")
                  : t("checkout.features.sellList.ui.sellListPage.sell.list.update.refreshing")}
              </Badge>
              <Stack gap={1}>
                <Text weight="semibold">
                  {t("checkout.features.sellList.ui.sellListPage.sell.list.update.pending.title")}
                </Text>
                <Text tone="secondary">{recoveryState.message}</Text>
              </Stack>
              <LinkButton href={recoveryState.refreshHref} tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.refresh.sell.list")}
              </LinkButton>
            </Stack>
          </Surface>
        ) : sellListLines.length === 0 && recoveryState?.kind === "missing-after-fresh-write" ? (
          <MarketplaceEmptyState
            title={t("checkout.features.sellList.ui.sellListPage.sell.list.update.missing.title")}
            description={recoveryState.message}
            recoveryActions={
              <>
                <LinkButton href={recoveryState.refreshHref} tone="secondary">
                  {t("checkout.features.sellList.ui.sellListPage.refresh.sell.list")}
                </LinkButton>
                <LinkButton href="/search">
                  {t("checkout.features.sellList.ui.sellListPage.browse.products")}
                </LinkButton>
              </>
            }
          />
        ) : sellListLines.length === 0 && recoveryMessage ? (
          <MarketplaceNotice
            tone="info"
            title={t("checkout.features.sellList.ui.sellListPage.checkout")}
            description={recoveryMessage}
          />
        ) : sellListLines.length === 0 ? (
          <MarketplaceEmptyState
            title={t("checkout.features.sellList.ui.sellListPage.your.sell.list.is.empty")}
            description={t("checkout.features.sellList.ui.sellListPage.add.selected.offers.or.products")}
            recoveryActions={
              <LinkButton href="/search">{t("checkout.features.sellList.ui.sellListPage.browse.products")}</LinkButton>
            }
          />
        ) : (
          <CheckoutLayout
            summaryLabel={t("checkout.features.sellList.ui.sellListPage.sale.checkout.summary")}
            summary={summary}
          >
            <Stack gap={5}>
              <MarketplaceNotice
                tone={blockedLineCount > 0 ? "warning" : "success"}
                title={
                  blockedLineCount > 0
                    ? t("checkout.features.sellList.ui.sellListPage.some.items.need.action")
                    : t("checkout.features.sellList.ui.sellListPage.ready.for.seller.checkout")
                }
                description={
                  blockedLineCount > 0
                    ? t("checkout.features.sellList.ui.sellListPage.resolve.before.seller.checkout", {
                        count: blockedLineCount,
                      })
                    : t("checkout.features.sellList.ui.sellListPage.ready.for.seller.checkout.description")
                }
              />

              {isSignedIn && payoutReadiness?.status !== "ready" ? (
                <MarketplaceNotice
                  tone="warning"
                  title={t("checkout.features.sellList.ui.sellListPage.payout.setup.required")}
                  description={
                    payoutReadiness
                      ? t("checkout.features.sellList.ui.sellListPage.payout.setup.required.description", {
                          requirements: payoutReadiness.missing_requirements.join(", ") || payoutReadiness.status,
                        })
                      : t("checkout.features.sellList.ui.sellListPage.payout.readiness.unavailable.description")
                  }
                  action={
                    <LinkButton
                      href="/account/payouts/setup?returnTo=%2Faccount%2Fsell-list"
                      tone="secondary"
                      size="sm"
                    >
                      {t("checkout.features.sellList.ui.sellListPage.set.up.payouts")}
                    </LinkButton>
                  }
                />
              ) : null}

              <PageSection title={t("checkout.features.sellList.ui.sellListPage.review.items")}>
                <Stack gap={3}>
                  {selectedOfferLines.map((line) => (
                    <SelectedOfferRow key={line.line_id} line={line} review={offerReviewsByLineId.get(line.line_id)} />
                  ))}
                  {productLines.map((line) => (
                    <ProductLineRow
                      key={line.line_id}
                      line={line}
                      review={productOfferReviewsByLineId.get(line.line_id)}
                      inventoryOptions={inventoryByProductId.get(line.product_id) ?? []}
                    />
                  ))}
                </Stack>
              </PageSection>

              <Surface elevated>
                <Stack gap={3}>
                  <Text weight="semibold">
                    {t("checkout.features.sellList.ui.sellListPage.seller.checkout.readiness")}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("checkout.features.sellList.ui.sellListPage.seller.checkout.readiness.description")}
                  </Text>
                  <Inline gap={2}>
                    <Form spacing="none" id="sell-list-checkout-form" method="post">
                      <Button
                        type="submit"
                        name="intent"
                        value="review-sell-list-checkout"
                        leadingIcon="check"
                        disabled={!canContinue}
                      >
                        {primarySellerCheckoutLabel}
                      </Button>
                    </Form>
                    <LinkButton href={recoveryHref} tone="secondary">
                      {recoveryLabel}
                    </LinkButton>
                  </Inline>
                </Stack>
              </Surface>

              <StickyCtaBar
                price={formatMoney(expectedSellerPayout)}
                context={t("checkout.features.sellList.ui.sellListPage.expected.payout.before.checkout")}
                primaryAction={
                  <Button
                    type="submit"
                    form="sell-list-checkout-form"
                    name="intent"
                    value="review-sell-list-checkout"
                    leadingIcon="check"
                    disabled={!canContinue}
                  >
                    {primarySellerCheckoutLabel}
                  </Button>
                }
                secondaryAction={
                  <LinkButton href={recoveryHref} tone="secondary">
                    {recoveryLabel}
                  </LinkButton>
                }
              />
            </Stack>
          </CheckoutLayout>
        )}
      </Stack>
    </Page>
  );
}
