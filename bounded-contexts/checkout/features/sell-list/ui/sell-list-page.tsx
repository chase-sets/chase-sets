import {
  Badge,
  Banner,
  Button,
  Card,
  Container,
  Heading,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceEmptyState,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
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
  errorMessage = null,
}: {
  sellListLines: readonly CheckoutSellListLineRow[];
  isSignedIn?: boolean;
  errorMessage?: string | null;
}) {
  const selectedOfferLines = sellListLines.filter((line) => line.line_type === "selected-offer");
  const productLines = sellListLines.filter((line) => line.line_type === "product");
  const totalQuantity = sellListLines.reduce((sum, line) => sum + line.quantity, 0);
  const estimatedSelectedOfferValue = selectedOfferLines.reduce(
    (sum, line) => sum + Number(line.offer_price_amount ?? 0) * line.quantity,
    0,
  );

  return (
    <Container width="wide">
      <Stack gap={6}>
        <Stack gap={2}>
          <Text size="sm" weight="semibold" tone="accent">
            {t("checkout.features.sellList.ui.sellListPage.checkout")}
          </Text>
          <Heading level={1}>{t("checkout.features.sellList.ui.sellListPage.sell.list")}</Heading>
          <Text tone="secondary">
            {t("checkout.features.sellList.ui.sellListPage.review.selected.offers.and.product.level")}
          </Text>
        </Stack>

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
          <Card variant="feature">
            <Text>{errorMessage}</Text>
          </Card>
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
          <Stack gap={5}>
            <PriceBreakdown
              lines={[
                { label: t("checkout.features.sellList.ui.sellListPage.items"), value: totalQuantity },
                { label: t("checkout.features.sellList.ui.sellListPage.sell.list.lines"), value: sellListLines.length },
                {
                  label: t("checkout.features.sellList.ui.sellListPage.selected.offers"),
                  value: selectedOfferLines.length,
                },
                {
                  label: t("checkout.features.sellList.ui.sellListPage.product.lines"),
                  value: productLines.length,
                },
              ]}
              total={formatMoney(String(estimatedSelectedOfferValue))}
              totalLabel={t("checkout.features.sellList.ui.sellListPage.selected.offer.value")}
              reassurance={
                <SecurePaymentIndicator
                  label={t("checkout.features.sellList.ui.sellListPage.buyer.payment.already.authorized")}
                />
              }
            />

            <PageSection title={t("checkout.features.sellList.ui.sellListPage.selected.offers")}>
              {selectedOfferLines.length > 0 ? (
                <Stack gap={3}>
                  {selectedOfferLines.map((line) => (
                    <Card key={line.line_id}>
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
                    </Card>
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
                    <Card key={line.line_id}>
                      <Stack gap={2}>
                        <Text weight="semibold">{line.item_title}</Text>
                        <ProductOptions
                          options={productOptionsFromSelectedOptions(line.selected_options)}
                          emptyLabel={line.product_summary ?? t("checkout.features.sellList.ui.sellListPage.standard")}
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
                      </Stack>
                    </Card>
                  ))}
                </Stack>
              ) : (
                <MarketplaceEmptyState
                  title={t("checkout.features.sellList.ui.sellListPage.no.product.lines")}
                  description={t("checkout.features.sellList.ui.sellListPage.product.level.smart.match.selling")}
                />
              )}
            </PageSection>

            <Card variant="feature">
              <Stack gap={2}>
                <Text weight="semibold">{t("checkout.features.sellList.ui.sellListPage.smart.match.settings")}</Text>
                <Text size="sm" tone="secondary">
                  {isSignedIn
                    ? t("checkout.features.sellList.ui.sellListPage.checkout.owns.the.review.step")
                    : t("checkout.features.sellList.ui.sellListPage.sign.in.to.review.sale.checkout")}
                </Text>
                <Inline gap={2}>
                  {isSignedIn ? (
                    <Button type="button" disabled>
                      {t("checkout.features.sellList.ui.sellListPage.review.sale.checkout")}
                    </Button>
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
            </Card>
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
