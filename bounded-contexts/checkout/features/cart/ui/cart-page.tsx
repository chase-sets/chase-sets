import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  BuyerProtectionModule,
  CheckoutLayout,
  Inline,
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
  ProductSelectionSummary,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
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

function mergeSellerOptions(
  left: CheckoutCartLine["seller_options"],
  right: CheckoutCartLine["seller_options"],
) {
  return [
    ...new Map(
      [...left, ...right].map((option) => [option.listing_id, option] as const),
    ).values(),
  ].sort((a, b) =>
    Number(a.price_amount) - Number(b.price_amount) ||
    a.listing_id.localeCompare(b.listing_id),
  );
}

function productSelectionDetails(summary: string | null) {
  const normalized = summary?.trim() ?? "";
  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  const labeledParts = parts
    .map((part) => {
      const [label, ...valueParts] = part.split(":");
      const value = valueParts.join(":").trim();

      return label.trim() && value
        ? { label: label.trim(), value }
        : null;
    })
    .filter((part): part is { label: string; value: string } => part !== null);

  return labeledParts.length === parts.length ? labeledParts : [];
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

  if (
    line.availability_state === "waiting-for-supply" ||
    line.availability_state === "unavailable"
  ) {
    return "Waiting for supply";
  }

  return "Optimized at checkout";
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
        title={t("checkout.features.cart.ui.cartPage.current.cart")}
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
                <LinkButton href="/search">
                  {t("checkout.features.cart.ui.cartPage.keep.shopping")}
                </LinkButton>
              }
            />
          ) : (
            cartLineGroups.map((line) => (
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
                  title={line.item_title}
                  subtitle={line.item_subtitle}
                  productLabel={t("checkout.features.cart.ui.cartPage.product")}
                  productSummary={
                    <Stack gap={2}>
                      <ProductSelectionSummary
                        selections={productSelectionDetails(line.product_summary)}
                        summary={line.product_summary ?? t("checkout.features.cart.ui.cartPage.standard")}
                        summaryAsChip
                      />
                      <Inline gap={2}>
                        <Badge tone={line.fulfillment_mode === "locked-listing" ? "success" : "accent"}>
                          {fulfillmentLabel(line)}
                        </Badge>
                        <Badge tone={line.availability_state === "available" ? "neutral" : "warning"}>
                          {line.availability_state === "available" ? "Estimated at checkout" : "Needs supply"}
                        </Badge>
                      </Inline>
                      {line.fulfillment_mode === "optimize" ? (
                        <Text size="sm" tone="secondary">
                          Lock a preferred seller here or let checkout optimize fulfillment.
                        </Text>
                      ) : (
                        <Text size="sm" tone="secondary">
                          Unlock to let checkout re-optimize this product intent.
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
                          Unlock seller
                        </Button>
                      ) : line.seller_options.length > 0 ? (
                        <>
                          <NativeSelect
                            label="Seller option"
                            name="lockedListingId"
                            defaultValue=""
                            items={[
                              { value: "", label: "Let checkout optimize" },
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
                            Lock seller
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
                        <LinkButton
                          href={marketRecoveryHref(line.item_title)}
                          tone="secondary"
                          size="md"
                          block
                        >
                          Make offer
                        </LinkButton>
                      ) : null}
                    </>
                  }
                />
              </form>
            ))
          )}
        </Stack>
      </PageSection>
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.cart.ui.cartPage.secure.checkout")}
        title={t("checkout.features.cart.ui.cartPage.cart")}
        description={t("checkout.features.cart.ui.cartPage.review.product.level.purchase.intent.before")}
      />

      {cartLineGroups.length > 0 ? (
        <CheckoutLayout
          summaryMobile="hidden"
          summary={
            <Stack gap={4}>
              <PriceBreakdown
                lines={[
                  { label: t("checkout.features.cart.ui.cartPage.items"), value: cartLineCount },
                  { label: t("checkout.features.cart.ui.cartPage.cart.lines"), value: cartLineGroups.length },
                  { label: t("checkout.features.cart.ui.cartPage.pricing"), value: t("checkout.features.cart.ui.cartPage.calculated.during.checkout") },
                  { label: "Fulfillment", value: "Live preview before payment" },
                ]}
                total={t("checkout.features.cart.ui.cartPage.ready.for.checkout")}
                totalLabel={t("checkout.features.cart.ui.cartPage.cart.status")}
                reassurance={<SecurePaymentIndicator label={t("checkout.features.cart.ui.cartPage.secure.payment")} />}
              />
              <BuyerProtectionModule
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
              description={t("checkout.features.cart.ui.cartPage.listings.earn.five.percent.of.item.value.toward.shipping")}
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
