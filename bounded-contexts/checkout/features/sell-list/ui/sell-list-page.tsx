import {
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  CurrencyInput,
  Grid,
  Inset,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
  NativeSelect,
  OrderProtectionModule,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CheckoutSellListLineRow, CheckoutSellListReceiptRow } from "../read-model/queries";

type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: Readonly<{
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    shipping_allowance_percentage_bps: number;
    fee_quote_fingerprint: string;
  }> | null;
  message: string | null;
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

function formatMoney(value: string | null) {
  if (!value) {
    return "-";
  }

  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return value;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function productOptionsFromSelectedOptions(selections: readonly { dimensionId: string; optionId: string }[]) {
  return selections.map((selection) => ({
    dimensionLabel: selection.dimensionId,
    optionLabel: selection.optionId,
  }));
}

export function CheckoutSellListPage({
  sellListLines,
  isSignedIn = true,
  reviewCompleted = false,
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
  latestReceipt?: CheckoutSellListReceiptRow | null;
  offerReviews?: readonly SellListOfferReview[];
  productOfferReviews?: readonly SellListProductOfferReview[];
  inventoryItems?: readonly SellListInventoryItem[];
  payoutReadiness?: PayoutReadiness | null;
  errorMessage?: string | null;
}) {
  const selectedOfferLines = sellListLines.filter((line) => line.line_type === "selected-offer");
  const productLines = sellListLines.filter((line) => line.line_type === "product");
  const totalQuantity = sellListLines.reduce((sum, line) => sum + line.quantity, 0);
  const estimatedSelectedOfferValue = selectedOfferLines.reduce(
    (sum, line) => sum + Number(line.offer_price_amount ?? 0) * line.quantity,
    0,
  );
  const estimatedFallbackListingValue = productLines.reduce(
    (sum, line) => sum + Number(line.minimum_listing_price_amount ?? 0) * line.quantity,
    0,
  );
  const estimatedSaleValue = estimatedSelectedOfferValue + estimatedFallbackListingValue;
  const offerReviewsByLineId = new Map((offerReviews ?? []).map((review) => [review.lineId, review]));
  const inventoryByProductId = new Map<string, SellListInventoryItem[]>();
  for (const item of inventoryItems ?? []) {
    inventoryByProductId.set(item.product_id, [...(inventoryByProductId.get(item.product_id) ?? []), item]);
  }
  const summary = (
    <Stack gap={4}>
      <PriceBreakdown
        lines={[
          { label: t("checkout.features.sellList.ui.sellListPage.items"), value: totalQuantity },
          { label: t("checkout.features.sellList.ui.sellListPage.sell.list.lines"), value: sellListLines.length },
          {
            label: t("checkout.features.sellList.ui.sellListPage.selected.offer.value"),
            value: formatMoney(String(estimatedSelectedOfferValue)),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.fallback.listing.floor"),
            value: formatMoney(String(estimatedFallbackListingValue)),
          },
          {
            label: t("checkout.features.sellList.ui.sellListPage.payout.readiness"),
            value: !isSignedIn
              ? t("checkout.features.sellList.ui.sellListPage.sign.in.required")
              : payoutReadiness?.status === "ready"
                ? t("checkout.features.sellList.ui.sellListPage.ready")
                : t("checkout.features.sellList.ui.sellListPage.setup.required"),
          },
        ]}
        total={formatMoney(String(estimatedSaleValue))}
        totalLabel={t("checkout.features.sellList.ui.sellListPage.review.value")}
        reassurance={
          <SecurePaymentIndicator
            label={t("checkout.features.sellList.ui.sellListPage.buyer.payment.already.authorized")}
          />
        }
      />
      <OrderProtectionModule
        title={t("checkout.features.sellList.ui.sellListPage.sale.checkout.confidence")}
        items={[
          {
            title: t("checkout.features.sellList.ui.sellListPage.buyer.payment.confidence"),
            description: t("checkout.features.sellList.ui.sellListPage.selected.offers.keep.buyer.payment"),
          },
          {
            title: t("checkout.features.sellList.ui.sellListPage.fulfillment.commitment"),
            description: t("checkout.features.sellList.ui.sellListPage.inventory.and.shipping.are.confirmed"),
          },
          {
            title: t("checkout.features.sellList.ui.sellListPage.payout.readiness"),
            description: t("checkout.features.sellList.ui.sellListPage.payout.setup.is.checked.before"),
          },
        ]}
      />
    </Stack>
  );
  const payoutIsReady = !isSignedIn || payoutReadiness?.status === "ready";
  const productOfferReviewsByLineId = new Map((productOfferReviews ?? []).map((review) => [review.lineId, review]));

  return (
    <Page>
      <Stack gap={6}>
        <PageHeader
          eyebrow={t("checkout.features.sellList.ui.sellListPage.checkout")}
          title={t("checkout.features.sellList.ui.sellListPage.sell.list")}
          description={t("checkout.features.sellList.ui.sellListPage.review.selected.offers.and.product.level")}
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
          <Surface tone="subtle" elevated>
            <Text>{errorMessage}</Text>
          </Surface>
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
                      <Inset key={`${outcome.lineId}:${outcome.status}`}>
                        <KeyValueList
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
                              key: t("checkout.features.sellList.ui.sellListPage.receipt.action"),
                              value: outcome.action,
                            },
                            {
                              key: t("checkout.features.sellList.ui.sellListPage.receipt.quantity"),
                              value: outcome.quantity,
                            },
                            {
                              key: t("checkout.features.sellList.ui.sellListPage.receipt.remaining"),
                              value: outcome.remainingQuantity,
                            },
                            {
                              key: t("checkout.features.sellList.ui.sellListPage.receipt.recovery"),
                              value: outcome.detail,
                            },
                          ]}
                        />
                      </Inset>
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
                tone="info"
                title={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review")}
                description={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review.description")}
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
                />
              ) : null}
              <PageSection title={t("checkout.features.sellList.ui.sellListPage.selected.offers")}>
                {selectedOfferLines.length > 0 ? (
                  <Stack gap={3}>
                    {selectedOfferLines.map((line) => {
                      const review = offerReviewsByLineId.get(line.line_id);

                      return (
                        <Surface key={line.line_id} elevated>
                          <form method="post">
                            <input type="hidden" name="intent" value="remove-sell-list-line" />
                            <input type="hidden" name="lineId" value={line.line_id} />
                            <Stack gap={3}>
                              <Inline gap={2}>
                                <Badge tone="success">
                                  {t("checkout.features.sellList.ui.sellListPage.selected.offer")}
                                </Badge>
                                <Text weight="semibold">{formatMoney(line.offer_price_amount)}</Text>
                              </Inline>
                              <Stack gap={1}>
                                <Text weight="semibold">{line.item_title}</Text>
                                {line.item_subtitle ? (
                                  <Text size="sm" tone="secondary">
                                    {line.item_subtitle}
                                  </Text>
                                ) : null}
                                <ProductOptions
                                  options={productOptionsFromSelectedOptions(line.selected_options)}
                                  emptyLabel={
                                    line.product_summary ?? t("checkout.features.sellList.ui.sellListPage.standard")
                                  }
                                />
                              </Stack>
                              <KeyValueList
                                density="compact"
                                variant="plain"
                                items={[
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.buyer"),
                                    value:
                                      line.buyer_display_name ??
                                      line.buyer_account_id ??
                                      t("checkout.features.sellList.ui.sellListPage.buyer"),
                                  },
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.quantity"),
                                    value: line.quantity,
                                  },
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.sales.fee"),
                                    value: review?.terms
                                      ? formatMoney(review.terms.marketplace_sales_fee_unit_amount)
                                      : t("checkout.features.sellList.ui.sellListPage.needs.refresh"),
                                  },
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.seller.net"),
                                    value: review?.terms
                                      ? formatMoney(review.terms.seller_net_unit_amount)
                                      : t("checkout.features.sellList.ui.sellListPage.needs.refresh"),
                                  },
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.payment.authorization"),
                                    value:
                                      review?.status === "ready"
                                        ? t("checkout.features.sellList.ui.sellListPage.ready.to.accept")
                                        : (review?.message ??
                                          t("checkout.features.sellList.ui.sellListPage.needs.refresh")),
                                  },
                                  {
                                    key: t("checkout.features.sellList.ui.sellListPage.execution"),
                                    value: t(
                                      "checkout.features.sellList.ui.sellListPage.accept.selected.offer.during.checkout.review",
                                    ),
                                  },
                                ]}
                              />
                              {review?.terms ? (
                                <input
                                  type="hidden"
                                  form="sell-list-checkout-form"
                                  name={`offerFeeQuoteFingerprint:${line.line_id}`}
                                  value={review.terms.fee_quote_fingerprint}
                                />
                              ) : null}
                              <Inline gap={2}>
                                <Button type="submit" tone="secondary" size="sm">
                                  {t("checkout.features.sellList.ui.sellListPage.remove")}
                                </Button>
                              </Inline>
                            </Stack>
                          </form>
                        </Surface>
                      );
                    })}
                  </Stack>
                ) : (
                  <MarketplaceEmptyState
                    title={t("checkout.features.sellList.ui.sellListPage.no.selected.offers")}
                    description={t("checkout.features.sellList.ui.sellListPage.selected.offer.lines.will.appear")}
                  />
                )}
              </PageSection>

              <PageSection title={t("checkout.features.sellList.ui.sellListPage.products")}>
                {productLines.length > 0 ? (
                  <Stack gap={3}>
                    {productLines.map((line) => {
                      const inventoryOptions = inventoryByProductId.get(line.product_id) ?? [];
                      const defaultInventoryItem = inventoryOptions[0] ?? null;
                      const defaultPrice = line.minimum_listing_price_amount ?? "";
                      const productOfferReview = productOfferReviewsByLineId.get(line.line_id);
                      const matchingOfferQuantity =
                        productOfferReview?.offers.reduce((sum, item) => sum + item.offer.quantity_requested, 0) ?? 0;
                      const matchingOffersCoverLine = matchingOfferQuantity >= line.quantity;

                      return (
                        <Surface key={line.line_id} elevated>
                          <Stack gap={2}>
                            <Text weight="semibold">{line.item_title}</Text>
                            <ProductOptions
                              options={productOptionsFromSelectedOptions(line.selected_options)}
                              emptyLabel={
                                line.product_summary ?? t("checkout.features.sellList.ui.sellListPage.standard")
                              }
                            />
                            <Text size="sm" tone="secondary">
                              {t("checkout.features.sellList.ui.sellListPage.smart.match.offers.for.quantity", {
                                quantity: line.quantity,
                                fallback:
                                  line.fallback_mode === "create-listing"
                                    ? t("checkout.features.sellList.ui.sellListPage.create.listings")
                                    : t("checkout.features.sellList.ui.sellListPage.disabled"),
                              })}
                            </Text>
                            <KeyValueList
                              density="compact"
                              variant="plain"
                              items={[
                                {
                                  key: t("checkout.features.sellList.ui.sellListPage.matching.offers"),
                                  value:
                                    matchingOfferQuantity > 0
                                      ? t("checkout.features.sellList.ui.sellListPage.matching.offer.quantity", {
                                          quantity: matchingOfferQuantity,
                                        })
                                      : (productOfferReview?.message ??
                                        t("checkout.features.sellList.ui.sellListPage.no.ready.matching.offers")),
                                },
                                {
                                  key: t("checkout.features.sellList.ui.sellListPage.minimum.listing.price"),
                                  value: formatMoney(line.minimum_listing_price_amount),
                                },
                                {
                                  key: t("checkout.features.sellList.ui.sellListPage.execution"),
                                  value:
                                    line.fallback_mode === "create-listing"
                                      ? t(
                                          "checkout.features.sellList.ui.sellListPage.create.fallback.listing.after.review",
                                        )
                                      : t("checkout.features.sellList.ui.sellListPage.accept.matching.offers.only"),
                                },
                              ]}
                            />
                            {productOfferReview?.offers.length ? (
                              <Stack gap={2}>
                                {productOfferReview.offers.map(({ offer, terms }) => (
                                  <Inset key={offer.offer_id}>
                                    <Stack gap={2}>
                                      <KeyValueList
                                        density="compact"
                                        variant="plain"
                                        items={[
                                          {
                                            key: t("checkout.features.sellList.ui.sellListPage.buyer"),
                                            value:
                                              offer.buyer_display_name ??
                                              offer.buyer_account_id ??
                                              t("checkout.features.sellList.ui.sellListPage.buyer"),
                                          },
                                          {
                                            key: t("checkout.features.sellList.ui.sellListPage.offer"),
                                            value: formatMoney(offer.price_amount),
                                          },
                                          {
                                            key: t("checkout.features.sellList.ui.sellListPage.quantity"),
                                            value: offer.quantity_requested,
                                          },
                                          {
                                            key: t("checkout.features.sellList.ui.sellListPage.seller.net"),
                                            value: formatMoney(terms.seller_net_unit_amount),
                                          },
                                        ]}
                                      />
                                      <input
                                        form="sell-list-checkout-form"
                                        type="hidden"
                                        name={`productOfferId:${line.line_id}`}
                                        value={offer.offer_id}
                                      />
                                      <input
                                        form="sell-list-checkout-form"
                                        type="hidden"
                                        name={`productOfferFeeQuoteFingerprint:${line.line_id}:${offer.offer_id}`}
                                        value={terms.fee_quote_fingerprint}
                                      />
                                    </Stack>
                                  </Inset>
                                ))}
                              </Stack>
                            ) : null}
                            <Grid columns={{ base: 1, md: 3 }} gap={3}>
                              <NativeSelect
                                form="sell-list-checkout-form"
                                label={t("checkout.features.sellList.ui.sellListPage.fallback.action")}
                                name={`fallbackMode:${line.line_id}`}
                                defaultValue={
                                  matchingOffersCoverLine ? "none" : defaultInventoryItem ? "create-listing" : "none"
                                }
                                items={[
                                  {
                                    value: "none",
                                    label: matchingOfferQuantity
                                      ? t("checkout.features.sellList.ui.sellListPage.accept.ready.matches.only")
                                      : t("checkout.features.sellList.ui.sellListPage.keep.in.sell.list"),
                                  },
                                  {
                                    value: "create-listing",
                                    label:
                                      matchingOfferQuantity > 0
                                        ? t(
                                            "checkout.features.sellList.ui.sellListPage.create.fallback.listing.for.remaining",
                                          )
                                        : t("checkout.features.sellList.ui.sellListPage.create.fallback.listing"),
                                    disabled: !defaultInventoryItem,
                                  },
                                ]}
                              />
                              <NativeSelect
                                form="sell-list-checkout-form"
                                label={t("checkout.features.sellList.ui.sellListPage.inventory")}
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
                              <input
                                form="sell-list-checkout-form"
                                type="hidden"
                                name={`quantityCap:${line.line_id}`}
                                value={Math.min(
                                  line.quantity,
                                  defaultInventoryItem?.available_quantity ?? line.quantity,
                                )}
                              />
                            </Grid>
                            {defaultInventoryItem ? (
                              <MarketplaceNotice
                                tone="info"
                                title={t("checkout.features.sellList.ui.sellListPage.inventory.ready")}
                                description={t(
                                  "checkout.features.sellList.ui.sellListPage.inventory.ready.description",
                                )}
                              />
                            ) : (
                              <MarketplaceNotice
                                tone="warning"
                                title={t("checkout.features.sellList.ui.sellListPage.inventory.required")}
                                description={t(
                                  "checkout.features.sellList.ui.sellListPage.inventory.required.description",
                                )}
                              />
                            )}
                          </Stack>
                        </Surface>
                      );
                    })}
                  </Stack>
                ) : (
                  <MarketplaceEmptyState
                    title={t("checkout.features.sellList.ui.sellListPage.no.product.lines")}
                    description={t("checkout.features.sellList.ui.sellListPage.product.level.smart.match.selling")}
                  />
                )}
              </PageSection>

              <Surface elevated>
                <Stack gap={2}>
                  <Text weight="semibold">{t("checkout.features.sellList.ui.sellListPage.smart.match.settings")}</Text>
                  <Text size="sm" tone="secondary">
                    {isSignedIn
                      ? t("checkout.features.sellList.ui.sellListPage.checkout.owns.the.review.step")
                      : t("checkout.features.sellList.ui.sellListPage.sign.in.to.review.sale.checkout")}
                  </Text>
                  <Inline gap={2}>
                    {isSignedIn ? (
                      <form id="sell-list-checkout-form" method="post">
                        <input type="hidden" name="intent" value="review-sell-list-checkout" />
                        <Button type="submit" leadingIcon="check" disabled={!payoutIsReady}>
                          {t("checkout.features.sellList.ui.sellListPage.execute.sale.checkout")}
                        </Button>
                      </form>
                    ) : (
                      <LinkButton href="/register?returnTo=%2Faccount%2Fsell-list">
                        {t("checkout.features.sellList.ui.sellListPage.create.account")}
                      </LinkButton>
                    )}
                    <LinkButton href="/search" tone="secondary">
                      {t("checkout.features.sellList.ui.sellListPage.keep.selling")}
                    </LinkButton>
                  </Inline>
                </Stack>
              </Surface>
              <StickyCtaBar
                price={formatMoney(String(estimatedSaleValue))}
                context={t("checkout.features.sellList.ui.sellListPage.sale.review.before.commitment")}
                primaryAction={
                  isSignedIn ? (
                    <Button
                      type="submit"
                      form="sell-list-checkout-form"
                      name="intent"
                      value="review-sell-list-checkout"
                      leadingIcon="check"
                      disabled={!payoutIsReady}
                    >
                      {t("checkout.features.sellList.ui.sellListPage.execute.sale.checkout")}
                    </Button>
                  ) : (
                    <LinkButton href="/register?returnTo=%2Faccount%2Fsell-list" leadingIcon="shield">
                      {t("checkout.features.sellList.ui.sellListPage.create.account")}
                    </LinkButton>
                  )
                }
                secondaryAction={
                  <LinkButton href="/search" tone="secondary">
                    {t("checkout.features.sellList.ui.sellListPage.keep.selling")}
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
