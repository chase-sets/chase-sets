import {
  HiddenInput,
  Form,
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  CurrencyInput,
  Grid,
  Inline,
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
import type {
  CheckoutSellListExecutionRow,
  CheckoutSellListLineRow,
  CheckoutSellListReceiptRow,
} from "../read-model/queries";

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: SellListTermsPreview | null;
  message: string | null;
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

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function multiplyMoney(value: string | null | undefined, quantity: number) {
  return moneyNumber(value) * quantity;
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

function buyerLabel(offer: { buyer_display_name: string | null; buyer_account_id: string | null }) {
  return offer.buyer_display_name ?? offer.buyer_account_id ?? t("checkout.features.sellList.ui.sellListPage.buyer");
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

  if (readyOfferCount > 0 || fallbackReady) {
    return {
      ready: true,
      label: t("checkout.features.sellList.ui.sellListPage.ready"),
      detail:
        readyOfferCount > 0
          ? t("checkout.features.sellList.ui.sellListPage.smart.match.ready.detail", { count: readyOfferCount })
          : t("checkout.features.sellList.ui.sellListPage.fallback.listing.ready.detail"),
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

function SellListTermsReferenceInfo({ terms, quantity }: { terms: SellListTermsPreview; quantity: number }) {
  const [open, setOpen] = useState(false);
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
  const lines = isPublicStandardTerms(terms)
    ? [
        t("checkout.features.sellList.ui.sellListPage.public.standard.terms.line1"),
        t("checkout.features.sellList.ui.sellListPage.public.standard.terms.line2"),
      ]
    : [t("checkout.features.sellList.ui.sellListPage.registered.terms.line1")];

  return (
    <>
      <ReferenceInfoTrigger
        tone="subtle"
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

  return (
    <Surface element="article" tone="default" padding={4}>
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(11rem,14rem)_auto] md:items-start">
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
          {review?.terms ? <SellListTermsReferenceInfo terms={review.terms} quantity={line.quantity} /> : null}
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
      </div>
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

  return (
    <Surface element="article" tone="default" padding={4}>
      <Stack gap={4}>
        <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(11rem,14rem)_auto] md:items-start">
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
            <Text size="sm" tone="secondary">
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
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="remove-sell-list-line" />
            <HiddenInput type="hidden" name="lineId" value={line.line_id} />
            <Button type="submit" tone="secondary" size="md" leadingIcon="trash">
              {t("checkout.features.sellList.ui.sellListPage.remove")}
            </Button>
          </Form>
        </div>

        <div className="border-t border-[var(--border)] pt-4">
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
              <Text size="sm" tone="secondary">
                {t("checkout.features.sellList.ui.sellListPage.no.smart.match.offers.available")}
              </Text>
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
        </div>
      </Stack>
    </Surface>
  );
}

export function CheckoutSellListPage({
  sellListLines,
  isSignedIn = true,
  reviewCompleted = false,
  sellListExecutionId = null,
  latestPendingExecution = null,
  latestReceipt = null,
  offerReviews = [],
  productOfferReviews = [],
  inventoryItems = [],
  payoutReadiness = null,
  errorMessage = null,
}: {
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn?: boolean;
  reviewCompleted?: boolean;
  sellListExecutionId?: string | null;
  latestPendingExecution?: CheckoutSellListExecutionRow | null;
  latestReceipt?: CheckoutSellListReceiptRow | null;
  offerReviews?: readonly SellListOfferReview[];
  productOfferReviews?: readonly SellListProductOfferReview[];
  inventoryItems?: readonly SellListInventoryItem[];
  payoutReadiness?: PayoutReadiness | null;
  errorMessage?: string | null;
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
  const blockedLineCount = lineReadiness.filter((readiness) => !readiness.ready).length;
  const readyLineCount = sellListLines.length - blockedLineCount;
  const payoutIsReady = !isSignedIn || payoutReadiness?.status === "ready";
  const canContinue = isSignedIn && payoutIsReady && blockedLineCount === 0 && sellListLines.length > 0;
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
            title={t("checkout.features.sellList.ui.sellListPage.saved.for.later.title")}
            description={t("checkout.features.sellList.ui.sellListPage.saved.for.later.description")}
            tone="info"
            actions={
              <Inline gap={2}>
                <LinkButton href="/register?returnTo=%2Faccount%2Fsell-list">
                  {t("checkout.features.sellList.ui.sellListPage.create.account")}
                </LinkButton>
                <LinkButton href="/sign-in?returnTo=%2Faccount%2Fsell-list" tone="secondary">
                  {t("checkout.features.sellList.ui.sellListPage.sign.in")}
                </LinkButton>
              </Inline>
            }
          />
        ) : null}

        {errorMessage ? (
          <MarketplaceNotice
            tone="warning"
            title={t("checkout.features.sellList.ui.sellListPage.checkout.issue")}
            description={errorMessage}
          />
        ) : null}

        {reviewCompleted ? (
          <Stack gap={3}>
            <MarketplaceNotice
              tone="success"
              title={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review.recorded")}
              description={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review.recorded.description")}
            />
            {latestReceipt?.execution_summary.lineOutcomes?.length ? (
              <Surface elevated>
                <Stack gap={3}>
                  <Inline gap={2}>
                    <Badge tone="success">{t("checkout.features.sellList.ui.sellListPage.sale.receipt")}</Badge>
                    <Text weight="semibold">
                      {t("checkout.features.sellList.ui.sellListPage.sale.receipt.summary", {
                        acceptedOfferCount: latestReceipt.execution_summary.acceptedOfferCount ?? 0,
                        createdListingCount: latestReceipt.execution_summary.createdListingCount ?? 0,
                      })}
                    </Text>
                  </Inline>
                  <Stack gap={2}>
                    {latestReceipt.execution_summary.lineOutcomes.map((outcome) => (
                      <KeyValueList
                        key={`${outcome.lineId}:${outcome.status}`}
                        density="compact"
                        variant="plain"
                        items={[
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.receipt.item"),
                            value: outcome.itemTitle,
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.receipt.result"),
                            value: outcome.status,
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.receipt.quantity"),
                            value: outcome.quantity,
                          },
                          {
                            key: t("checkout.features.sellList.ui.sellListPage.receipt.remaining"),
                            value: outcome.remainingQuantity,
                          },
                        ]}
                      />
                    ))}
                  </Stack>
                </Stack>
              </Surface>
            ) : null}
          </Stack>
        ) : null}

        {sellListLines.length === 0 ? (
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

              {latestPendingExecution ? (
                <Surface tone="subtle" elevated>
                  <Stack gap={3}>
                    <MarketplaceNotice
                      tone="warning"
                      title={t("checkout.features.sellList.ui.sellListPage.pending.seller.checkout")}
                      description={t("checkout.features.sellList.ui.sellListPage.pending.seller.checkout.description")}
                    />
                    <Inline gap={2}>
                      <Button
                        type="submit"
                        form="sell-list-checkout-form"
                        name="intent"
                        value="review-sell-list-checkout"
                        leadingIcon="refreshCcw"
                        disabled={!canContinue}
                      >
                        {t("checkout.features.sellList.ui.sellListPage.continue.pending.checkout")}
                      </Button>
                      <Button
                        type="submit"
                        form="sell-list-checkout-form"
                        name="intent"
                        value="rebuild-sell-list-checkout"
                        tone="secondary"
                        leadingIcon="refreshCcw"
                        disabled={!canContinue}
                      >
                        {t("checkout.features.sellList.ui.sellListPage.rebuild.from.current.sell.list")}
                      </Button>
                    </Inline>
                  </Stack>
                </Surface>
              ) : null}

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
                    {isSignedIn ? (
                      <Form spacing="none" id="sell-list-checkout-form" method="post">
                        <HiddenInput type="hidden" name="sellListExecutionId" value={sellListExecutionId ?? ""} />
                        <Button
                          type="submit"
                          name="intent"
                          value="review-sell-list-checkout"
                          leadingIcon="check"
                          disabled={!canContinue}
                        >
                          {t("checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout")}
                        </Button>
                      </Form>
                    ) : (
                      <LinkButton href="/register?returnTo=%2Faccount%2Fsell-list">
                        {t("checkout.features.sellList.ui.sellListPage.create.account")}
                      </LinkButton>
                    )}
                    {blockedLineCount > 0 ? (
                      <LinkButton href="/checkout/sell/readiness" tone="secondary">
                        {t("checkout.features.sellList.ui.sellListPage.resolve.items")}
                      </LinkButton>
                    ) : (
                      <LinkButton href="/search" tone="secondary">
                        {t("checkout.features.sellList.ui.sellListPage.keep.selling")}
                      </LinkButton>
                    )}
                  </Inline>
                </Stack>
              </Surface>

              <StickyCtaBar
                price={formatMoney(expectedSellerPayout)}
                context={t("checkout.features.sellList.ui.sellListPage.expected.payout.before.checkout")}
                primaryAction={
                  isSignedIn ? (
                    <Button
                      type="submit"
                      form="sell-list-checkout-form"
                      name="intent"
                      value="review-sell-list-checkout"
                      leadingIcon="check"
                      disabled={!canContinue}
                    >
                      {t("checkout.features.sellList.ui.sellListPage.continue.to.seller.checkout")}
                    </Button>
                  ) : (
                    <LinkButton href="/register?returnTo=%2Faccount%2Fsell-list" leadingIcon="shield">
                      {t("checkout.features.sellList.ui.sellListPage.create.account")}
                    </LinkButton>
                  )
                }
                secondaryAction={
                  <LinkButton href={blockedLineCount > 0 ? "/checkout/sell/readiness" : "/search"} tone="secondary">
                    {blockedLineCount > 0
                      ? t("checkout.features.sellList.ui.sellListPage.resolve.items")
                      : t("checkout.features.sellList.ui.sellListPage.keep.selling")}
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
