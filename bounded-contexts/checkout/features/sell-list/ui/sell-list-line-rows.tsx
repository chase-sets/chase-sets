import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  CurrencyInput,
  Divider,
  Form,
  Grid,
  HiddenInput,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  ProductOptions,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { CheckoutSellListLineRow } from "../read-model/queries";
import { buyerLabel, formatMoney, productOptionsFromSelectedOptions } from "./sell-list-formatting";
import {
  inventorySetupHref,
  productLineReadiness,
  selectedOfferReadiness,
  sellListLineSetupHref,
} from "./sell-list-readiness";
import { comparisonInlineDetail, SellListTermsReferenceInfo } from "./sell-list-terms-reference";
import type {
  LineReadiness,
  SellListInventoryItem,
  SellListOfferReview,
  SellListProductOfferReview,
} from "./sell-list-page-types";

function readinessBadge(readiness: LineReadiness) {
  return <Badge tone={readiness.tone}>{readiness.label}</Badge>;
}

export function SelectedOfferRow({
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

export function ProductLineRow({
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
              currencyCode="USD"
              currencyAccessibleDescription={t("localization.currency.amountIn", {
                currency: t("localization.currency.usd"),
              })}
              decrementLabel={t("localization.currency.decreaseAmount")}
              incrementLabel={t("localization.currency.increaseAmount")}
              defaultValue={defaultPrice || undefined}
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
