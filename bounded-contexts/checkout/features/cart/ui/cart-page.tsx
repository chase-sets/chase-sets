import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import {
  AccountReputationSummary,
  Badge,
  Banner,
  Button,
  OrderProtectionModule,
  Card,
  CheckoutLayout,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceCartLineItem,
  MarketplaceEmptyState,
  NativeSelect,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { CheckoutCartLine } from "./contracts";

type CheckoutCartLineGroup = CheckoutCartLine & {
  lineIds: readonly string[];
};

const CART_ITEM_FALLBACK_IMAGE_URL = "/fake-cdn/assets/pokemon-card-back.png";

function cartLineGroupKey(line: CheckoutCartLine) {
  return [
    line.catalog_catalog_item_id,
    line.product_id,
    line.fulfillment_mode,
    line.locked_listing_id ?? "",
    line.seller_preference_id ?? "",
  ].join(":");
}

function groupCartLines(cartLines: readonly CheckoutCartLine[]): CheckoutCartLineGroup[] {
  const grouped = new Map<string, CheckoutCartLineGroup>();

  for (const line of cartLines) {
    const key = cartLineGroupKey(line);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...line,
        lineIds: [line.line_id],
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      quantity: existing.quantity + line.quantity,
      lineIds: [...existing.lineIds, line.line_id],
      seller_options: mergeSellerOptions(existing.seller_options, line.seller_options),
      updated_at:
        new Date(line.updated_at).getTime() > new Date(existing.updated_at).getTime()
          ? line.updated_at
          : existing.updated_at,
    });
  }

  return [...grouped.values()].sort(
    (left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime() ||
      left.line_id.localeCompare(right.line_id),
  );
}

function mergeSellerOptions(left: CheckoutCartLine["seller_options"], right: CheckoutCartLine["seller_options"]) {
  return [...new Map([...left, ...right].map((option) => [option.listing_id, option] as const)).values()].sort(
    (a, b) => Number(a.price_amount) - Number(b.price_amount) || a.listing_id.localeCompare(b.listing_id),
  );
}

function sellerOptionLabel(option: CheckoutCartLine["seller_options"][number]) {
  const seller = option.seller_display_name?.trim() || "Marketplace seller";
  return `${seller} - $${option.price_amount} - ${option.available_quantity} available`;
}

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
}

function fulfillmentLabel(line: CheckoutCartLine) {
  if (line.fulfillment_mode === "locked-listing") {
    return line.availability_state === "available"
      ? "Locked to seller - not reserved yet"
      : "Locked seller needs review";
  }

  if (line.availability_state === "waiting-for-supply" || line.availability_state === "unavailable") {
    return "Waiting for supply";
  }

  return t("checkout.features.cart.ui.cartPage.smart.match.at.checkout");
}

export function CheckoutCartPage({
  cartLines,
  errorMessage,
}: {
  cartLines: readonly CheckoutCartLine[];
  errorMessage?: string | null;
}) {
  const cartLineGroups = groupCartLines(cartLines);
  const cartLineCount = cartLineGroups.reduce((sum, line) => sum + line.quantity, 0);
  const selectedListingLineGroups = cartLineGroups.filter((line) => line.fulfillment_mode === "locked-listing");
  const productLineGroups = cartLineGroups.filter((line) => line.fulfillment_mode !== "locked-listing");

  function renderCartLine(line: CheckoutCartLineGroup) {
    return (
      <form key={line.line_id} method="post">
        <input type="hidden" name="intent" value="update-cart-line" />
        {line.lineIds.map((lineId) => (
          <input key={lineId} type="hidden" name="lineId" value={lineId} />
        ))}
        <MarketplaceCartLineItem
          imageSrc={line.item_image_url ?? CART_ITEM_FALLBACK_IMAGE_URL}
          imageAlt={t("checkout.features.cart.ui.cartPage.product.image.alt", {
            title: line.item_title,
          })}
          loadingImageSrc={line.item_image_loading_url ?? undefined}
          loadingImageAlt={line.item_image_loading_alt ?? undefined}
          loadingImageSrcSet={line.item_image_loading_srcset ?? undefined}
          loadingImageSizes="5.5rem"
          title={line.item_title}
          subtitle={line.item_subtitle}
          productLabel={t("checkout.features.cart.ui.cartPage.product")}
          productSummary={
            <Stack gap={2}>
              {line.item_language_code ? (
                <Badge tone="neutral">{formatLanguageCodeLabel(line.item_language_code)}</Badge>
              ) : null}
              {line.product_summary ? (
                <ProductOptions options={productOptionsFromSummary(line.product_summary)} variant="chips" />
              ) : (
                <Badge tone="neutral">{t("checkout.features.cart.ui.cartPage.standard")}</Badge>
              )}
              <Inline gap={2}>
                <Badge tone={line.fulfillment_mode === "locked-listing" ? "success" : "accent"}>
                  {fulfillmentLabel(line)}
                </Badge>
                <Badge tone={line.availability_state === "available" ? "neutral" : "warning"}>
                  {line.availability_state === "available"
                    ? t("checkout.features.cart.ui.cartPage.estimated.at.checkout")
                    : t("checkout.features.cart.ui.cartPage.needs.supply")}
                </Badge>
              </Inline>
              {line.fulfillment_mode === "optimize" ? (
                <Text size="sm" tone="secondary">
                  {t("checkout.features.cart.ui.cartPage.lock.preferred.seller.or.optimize")}
                </Text>
              ) : (
                <Text size="sm" tone="secondary">
                  {t("checkout.features.cart.ui.cartPage.unlock.to.reoptimize")}
                </Text>
              )}
            </Stack>
          }
          quantityControl={
            <NumberInput
              label={t("checkout.features.cart.ui.cartPage.quantity.2")}
              name="quantity"
              min="1"
              defaultValue={String(line.quantity)}
              required
            />
          }
          actions={
            <>
              <Button type="submit" size="md" tone="secondary" leadingIcon="check" block>
                {t("checkout.features.cart.ui.cartPage.update")}
              </Button>
              {line.fulfillment_mode === "locked-listing" ? (
                <Button
                  type="submit"
                  size="md"
                  name="intent"
                  value="unlock-cart-line"
                  tone="secondary"
                  leadingIcon="lock"
                  block
                >
                  {t("checkout.features.cart.ui.cartPage.unlock.seller")}
                </Button>
              ) : line.seller_options.length > 0 ? (
                <>
                  <Stack gap={2}>
                    {line.seller_options.map((option) => (
                      <Inline key={`seller-summary:${option.listing_id}`} align="center">
                        <AccountReputationSummary
                          accountName={
                            option.seller_display_name ??
                            option.seller_account_id ??
                            t("checkout.features.cart.ui.cartPage.marketplace.seller")
                          }
                          href={option.seller_slug ? `/accounts/${option.seller_slug}#feedback` : null}
                          averageRating={option.seller_average_rating}
                          reviewCount={option.seller_review_count ?? 0}
                          ratingLabel={t("checkout.features.cart.ui.cartPage.seller.reputation")}
                        />
                        <Text size="sm" tone="secondary">
                          {t("checkout.features.cart.ui.cartPage.seller.option.summary", {
                            price: `$${option.price_amount}`,
                            quantity: option.available_quantity,
                          })}
                        </Text>
                      </Inline>
                    ))}
                  </Stack>
                  <NativeSelect
                    label={t("checkout.features.cart.ui.cartPage.seller.option")}
                    name="lockedListingId"
                    defaultValue=""
                    items={[
                      {
                        value: "",
                        label: t("checkout.features.cart.ui.cartPage.let.checkout.optimize"),
                      },
                      ...line.seller_options.map((option) => ({
                        value: option.listing_id,
                        label: sellerOptionLabel(option),
                      })),
                    ]}
                  />
                  <Button
                    type="submit"
                    size="md"
                    name="intent"
                    value="lock-cart-line"
                    tone="secondary"
                    leadingIcon="lock"
                    block
                  >
                    {t("checkout.features.cart.ui.cartPage.lock.seller")}
                  </Button>
                </>
              ) : null}
              <Button
                type="submit"
                size="md"
                name="intent"
                value="remove-cart-line"
                tone="danger"
                leadingIcon="trash"
                block
              >
                {t("checkout.features.cart.ui.cartPage.remove")}
              </Button>
              {line.availability_state !== "available" ? (
                <LinkButton href={marketRecoveryHref(line.item_title)} tone="secondary" size="md" block>
                  {t("checkout.features.cart.ui.cartPage.make.offer")}
                </LinkButton>
              ) : null}
            </>
          }
        />
      </form>
    );
  }

  function renderLineSection({
    title,
    description,
    lines,
  }: {
    title: string;
    description: string;
    lines: readonly CheckoutCartLineGroup[];
  }) {
    if (lines.length === 0) {
      return null;
    }

    return (
      <Stack gap={3}>
        <Stack gap={1}>
          <Text weight="semibold">{title}</Text>
          <Text size="sm" tone="secondary">
            {description}
          </Text>
        </Stack>
        {lines.map((line) => renderCartLine(line))}
      </Stack>
    );
  }

  const cartContent = (
    <Stack gap={4}>
      {errorMessage ? (
        <Surface tone="subtle" elevated>
          <Stack gap={2}>
            <Badge tone="danger">{t("checkout.features.cart.ui.cartPage.checkout.issue")}</Badge>
            <Text>{errorMessage}</Text>
          </Stack>
        </Surface>
      ) : null}

      <PageSection
        title={t("checkout.features.cart.ui.cartPage.current.buy.cart")}
        description={t("checkout.features.cart.ui.cartPage.review.quantities.before.checkout.snapshots.these")}
      >
        <Stack gap={3}>
          {cartLineGroups.length === 0 ? (
            <MarketplaceEmptyState
              title={t("checkout.features.cart.ui.cartPage.your.cart.is.empty")}
              description={t("checkout.features.cart.ui.cartPage.browse.the.marketplace.and.add.a")}
              trustCue={
                <PlatformCredibilityCue
                  title={t("checkout.features.cart.ui.cartPage.empty.cart.protection.title")}
                  description={t("checkout.features.cart.ui.cartPage.empty.cart.protection.description")}
                />
              }
              recoveryActions={
                <LinkButton href="/search">{t("checkout.features.cart.ui.cartPage.keep.shopping")}</LinkButton>
              }
            />
          ) : (
            <>
              {renderLineSection({
                title: t("checkout.features.cart.ui.cartPage.selected.listings"),
                description: t("checkout.features.cart.ui.cartPage.selected.listings.description"),
                lines: selectedListingLineGroups,
              })}
              {renderLineSection({
                title: t("checkout.features.cart.ui.cartPage.products"),
                description: t("checkout.features.cart.ui.cartPage.products.description"),
                lines: productLineGroups,
              })}
            </>
          )}
        </Stack>
      </PageSection>
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.cart.ui.cartPage.secure.checkout")}
        title={t("checkout.features.cart.ui.cartPage.buy.cart")}
        description={t("checkout.features.cart.ui.cartPage.review.product.level.purchase.intent.before")}
      />

      {cartLineGroups.length > 0 ? (
        <CheckoutLayout
          summaryMobile="hidden"
          summaryLabel={t("checkout.features.cart.ui.cartPage.buy.cart.summary")}
          summary={
            <Stack gap={4}>
              <PriceBreakdown
                lines={[
                  { label: t("checkout.features.cart.ui.cartPage.items"), value: cartLineCount },
                  { label: t("checkout.features.cart.ui.cartPage.buy.cart.lines"), value: cartLineGroups.length },
                  {
                    label: t("checkout.features.cart.ui.cartPage.pricing"),
                    value: t("checkout.features.cart.ui.cartPage.calculated.during.checkout"),
                  },
                  {
                    label: t("checkout.features.cart.ui.cartPage.fulfillment"),
                    value: t("checkout.features.cart.ui.cartPage.live.preview.before.payment"),
                  },
                ]}
                total={t("checkout.features.cart.ui.cartPage.ready.for.checkout")}
                totalLabel={t("checkout.features.cart.ui.cartPage.buy.cart.status")}
                reassurance={<SecurePaymentIndicator label={t("checkout.features.cart.ui.cartPage.secure.payment")} />}
              />
              <Card variant="feature">
                <Stack gap={2}>
                  <Text weight="semibold">{t("checkout.features.cart.ui.cartPage.smart.match.settings")}</Text>
                  <Text size="sm" tone="secondary">
                    {t("checkout.features.cart.ui.cartPage.smart.match.settings.description")}
                  </Text>
                  <KeyValueList
                    density="compact"
                    variant="plain"
                    items={[
                      {
                        key: t("checkout.features.cart.ui.cartPage.optimize.for"),
                        value: t("checkout.features.cart.ui.cartPage.lowest.total.cost"),
                      },
                      {
                        key: t("checkout.features.cart.ui.cartPage.fallback"),
                        value: t("checkout.features.cart.ui.cartPage.place.offers.for.unavailable.quantity"),
                      },
                    ]}
                  />
                </Stack>
              </Card>
              <OrderProtectionModule
                items={[
                  {
                    title: t("checkout.features.cart.ui.cartPage.buyer.protection"),
                    description: t("checkout.features.cart.ui.cartPage.eligible.orders.are.protected.through.payment"),
                  },
                  {
                    title: t("checkout.features.cart.ui.cartPage.secure.payment"),
                    description: t("checkout.features.cart.ui.cartPage.payment.starts.only.after.orders.are"),
                  },
                  {
                    title: t("checkout.features.cart.ui.cartPage.fulfillment.ready"),
                    description: t("checkout.features.cart.ui.cartPage.shipping.preference.is.captured.before.order"),
                  },
                ]}
              />
            </Stack>
          }
        >
          <Stack gap={4}>
            <Banner
              title={t("checkout.features.cart.ui.cartPage.shipping.credit.grows.with.same.seller.cards")}
              description={t(
                "checkout.features.cart.ui.cartPage.listings.earn.five.percent.of.item.value.toward.shipping",
              )}
            />
            {cartContent}
            <StickyCtaBar
              context={t("checkout.features.cart.ui.cartPage.no.payment.until.totals")}
              primaryAction={
                <form method="post" action="/checkout/start">
                  <input type="hidden" name="source" value="cart" />
                  <Button type="submit" leadingIcon="lock" block>
                    {t("checkout.features.cart.ui.cartPage.start.checkout")}
                  </Button>
                </form>
              }
              secondaryAction={
                <LinkButton href="/search" tone="secondary" block>
                  {t("checkout.features.cart.ui.cartPage.keep.shopping")}
                </LinkButton>
              }
            />
          </Stack>
        </CheckoutLayout>
      ) : (
        cartContent
      )}
    </Page>
  );
}
