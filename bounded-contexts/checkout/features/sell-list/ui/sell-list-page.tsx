import {
  Badge,
  Banner,
  Button,
  CheckoutLayout,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceEmptyState,
  MarketplaceNotice,
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
import type { CheckoutSellListLineRow } from "../read-model/queries";

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
  errorMessage = null,
}: {
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn?: boolean;
  reviewCompleted?: boolean;
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
            value: isSignedIn
              ? t("checkout.features.sellList.ui.sellListPage.checked.before.commitment")
              : t("checkout.features.sellList.ui.sellListPage.sign.in.required"),
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
          <MarketplaceNotice
            tone="success"
            title={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review.recorded")}
            description={t("checkout.features.sellList.ui.sellListPage.sale.checkout.review.recorded.description")}
          />
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
              <PageSection title={t("checkout.features.sellList.ui.sellListPage.selected.offers")}>
                {selectedOfferLines.length > 0 ? (
                  <Stack gap={3}>
                    {selectedOfferLines.map((line) => (
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
                                { key: t("checkout.features.sellList.ui.sellListPage.quantity"), value: line.quantity },
                                {
                                  key: t("checkout.features.sellList.ui.sellListPage.execution"),
                                  value: t(
                                    "checkout.features.sellList.ui.sellListPage.accept.selected.offer.during.checkout.review",
                                  ),
                                },
                              ]}
                            />
                            <Inline gap={2}>
                              <Button type="submit" tone="secondary" size="sm">
                                {t("checkout.features.sellList.ui.sellListPage.remove")}
                              </Button>
                            </Inline>
                          </Stack>
                        </form>
                      </Surface>
                    ))}
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
                    {productLines.map((line) => (
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
                        </Stack>
                      </Surface>
                    ))}
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
                      <form method="post">
                        <input type="hidden" name="intent" value="review-sell-list-checkout" />
                        <Button type="submit" leadingIcon="check">
                          {t("checkout.features.sellList.ui.sellListPage.review.sale.checkout")}
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
                    <form method="post">
                      <input type="hidden" name="intent" value="review-sell-list-checkout" />
                      <Button type="submit" leadingIcon="check">
                        {t("checkout.features.sellList.ui.sellListPage.review.sale.checkout")}
                      </Button>
                    </form>
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
