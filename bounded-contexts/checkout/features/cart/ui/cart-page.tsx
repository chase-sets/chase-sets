import type { ReactNode } from "react";
import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Badge,
  Banner,
  Box,
  Button,
  Grid,
  Image,
  Inline,
  LinkButton,
  MarketplaceEmptyState,
  MediaFrame,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  PriceBreakdown,
  ProductOptions,
  SecurePaymentIndicator,
  Show,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import {
  createCartReadinessSnapshot,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
} from "../domain/readiness";
import type { CheckoutCartLine } from "./contracts";

type CheckoutCartLineGroup = CheckoutCartLine & {
  lineIds: readonly string[];
};

const CART_ITEM_FALLBACK_IMAGE_URL = "/fake-cdn/assets/pokemon-card-back.png";
const BUY_READINESS_ROUTE = "/checkout/buy/readiness";

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

function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function lowestKnownUnitPrice(line: CheckoutCartLineGroup) {
  const optionPrices = line.seller_options
    .map((option) => Number(option.price_amount))
    .filter((price) => Number.isFinite(price) && price >= 0);
  if (optionPrices.length === 0) {
    return null;
  }

  return Math.min(...optionPrices);
}

function selectedUnitPrice(line: CheckoutCartLineGroup) {
  if (line.locked_listing_id) {
    const selected = line.seller_options.find((option) => option.listing_id === line.locked_listing_id);
    const selectedPrice = Number(selected?.price_amount);
    if (Number.isFinite(selectedPrice) && selectedPrice >= 0) {
      return selectedPrice;
    }
  }

  return lowestKnownUnitPrice(line);
}

function estimateCartSubtotal(lines: readonly CheckoutCartLineGroup[]) {
  return lines.reduce((sum, line) => {
    const unitPrice = selectedUnitPrice(line);
    return unitPrice === null ? sum : sum + unitPrice * line.quantity;
  }, 0);
}

function hasKnownLinePrice(line: CheckoutCartLineGroup) {
  return selectedUnitPrice(line) !== null;
}

function linePriceLabel(line: CheckoutCartLineGroup) {
  const unitPrice = selectedUnitPrice(line);
  if (unitPrice === null) {
    return t("checkout.features.cart.ui.cartPage.price.at.checkout");
  }

  return formatMoney(unitPrice * line.quantity);
}

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
}

function hasFulfillmentPath(line: CheckoutCartLineGroup) {
  if (line.availability_state !== "available") {
    return false;
  }

  if (line.fulfillment_mode === "locked-listing") {
    return Boolean(line.locked_listing_id);
  }

  return line.seller_options.length > 0;
}

function readinessLabel(line: CheckoutCartLineGroup) {
  if (line.availability_state === "unavailable") {
    return t("checkout.features.cart.ui.cartPage.unavailable");
  }

  if (line.availability_state === "waiting-for-supply") {
    return t("checkout.features.cart.ui.cartPage.waiting.for.supply");
  }

  if (line.availability_state === "changed") {
    return t("checkout.features.cart.ui.cartPage.needs.review");
  }

  if (!hasFulfillmentPath(line)) {
    return t("checkout.features.cart.ui.cartPage.needs.fulfillment");
  }

  return t("checkout.features.cart.ui.cartPage.ready");
}

function readinessTone(line: CheckoutCartLineGroup) {
  return hasFulfillmentPath(line) ? "success" : "warning";
}

function renderLineOptions(line: CheckoutCartLineGroup) {
  return line.product_summary ? (
    <ProductOptions options={productOptionsFromSummary(line.product_summary)} variant="chips" />
  ) : (
    <Badge tone="neutral">{t("checkout.features.cart.ui.cartPage.standard")}</Badge>
  );
}

function cartListingLabel(line: CheckoutCartLineGroup, listingId: string | null) {
  if (!listingId) {
    return t("checkout.features.cart.ui.cartPage.selected.listing");
  }

  const listing = line.seller_options.find((option) => option.listing_id === listingId);
  return listing?.seller_display_name ?? t("checkout.features.cart.ui.cartPage.selected.listing");
}

function ListingPreferenceStatus({ line }: { line: CheckoutCartLineGroup }) {
  if (line.fulfillment_mode === "locked-listing" && line.locked_listing_id) {
    return (
      <Stack gap={1}>
        <Badge tone="success">{t("checkout.features.cart.ui.cartPage.locked.listing")}</Badge>
        <Text size="sm" tone="secondary">
          {t("checkout.features.cart.ui.cartPage.locked.listing.summary", {
            listing: cartListingLabel(line, line.locked_listing_id),
          })}
        </Text>
      </Stack>
    );
  }

  if (!line.seller_preference_id) {
    return null;
  }

  return (
    <Stack gap={1}>
      <Badge tone="neutral">{t("checkout.features.cart.ui.cartPage.preferred.listing")}</Badge>
      <Text size="sm" tone="secondary">
        {t("checkout.features.cart.ui.cartPage.preferred.listing.summary", {
          listing: cartListingLabel(line, line.seller_preference_id),
        })}
      </Text>
    </Stack>
  );
}

function ProductImage({ line }: { line: CheckoutCartLineGroup }) {
  return (
    <MediaFrame size="md">
      <Image
        src={line.item_image_url ?? CART_ITEM_FALLBACK_IMAGE_URL}
        alt={t("checkout.features.cart.ui.cartPage.product.image.alt", { title: line.item_title })}
        srcSet={line.item_image_srcset ?? undefined}
        sizes="6rem"
        fit="contain"
        loading="lazy"
      />
    </MediaFrame>
  );
}

function QuantityControls({ line }: { line: CheckoutCartLineGroup }) {
  return (
    <Stack gap={2}>
      <NumberInput
        label={t("checkout.features.cart.ui.cartPage.quantity")}
        name="quantity"
        min="1"
        defaultValue={String(line.quantity)}
        required
      />
      <Inline gap={2} wrap={false}>
        <Button type="submit" size="sm" tone="secondary" name="quantityDelta" value="-1" leadingIcon="minus">
          {t("checkout.features.cart.ui.cartPage.decrease")}
        </Button>
        <Button type="submit" size="sm" tone="secondary" name="quantityDelta" value="1" leadingIcon="plus">
          {t("checkout.features.cart.ui.cartPage.increase")}
        </Button>
      </Inline>
    </Stack>
  );
}

function CartLineActions({ line }: { line: CheckoutCartLineGroup }) {
  return (
    <Stack gap={2}>
      {line.seller_preference_id && line.fulfillment_mode !== "locked-listing" ? (
        <Button type="submit" size="md" name="intent" value="lock-preferred-listing" tone="secondary" block>
          {t("checkout.features.cart.ui.cartPage.lock.this.listing")}
        </Button>
      ) : null}
      <Button type="submit" size="md" tone="secondary" leadingIcon="check" block>
        {t("checkout.features.cart.ui.cartPage.update")}
      </Button>
      <Button type="submit" size="md" name="intent" value="remove-cart-line" tone="danger" leadingIcon="trash" block>
        {t("checkout.features.cart.ui.cartPage.remove")}
      </Button>
      {!hasFulfillmentPath(line) ? (
        <LinkButton href={marketRecoveryHref(line.item_title)} tone="secondary" size="md" block>
          {t("checkout.features.cart.ui.cartPage.find.alternatives")}
        </LinkButton>
      ) : null}
    </Stack>
  );
}

function CartLineRow({ line }: { line: CheckoutCartLineGroup }) {
  return (
    <Form spacing="none" key={line.line_id} method="post">
      <HiddenInput type="hidden" name="intent" value="update-cart-line" />
      {line.lineIds.map((lineId) => (
        <HiddenInput key={lineId} type="hidden" name="lineId" value={lineId} />
      ))}
      <HiddenInput type="hidden" name="sellerPreferenceId" value={line.seller_preference_id ?? ""} />
      <Surface element="article" tone="default" padding={4}>
        <Grid templateColumns="auto minmax(0,1fr) minmax(10rem,12rem) minmax(9rem,11rem)" stackUntil="md" gap={4}>
          <Stack direction="row" gap={3} minWidth="0">
            <ProductImage line={line} />
            <Show until="md" minWidth="0">
              <Stack gap={1}>
                <Text weight="semibold" wrap="anywhere">
                  {line.item_title}
                </Text>
                {line.item_subtitle ? (
                  <Text size="sm" tone="secondary" wrap="anywhere">
                    {line.item_subtitle}
                  </Text>
                ) : null}
                <Text weight="semibold">{linePriceLabel(line)}</Text>
              </Stack>
            </Show>
          </Stack>
          <Stack gap={2}>
            <Show from="md" minWidth="0">
              <Text weight="semibold" wrap="anywhere">
                {line.item_title}
              </Text>
              {line.item_subtitle ? (
                <Text size="sm" tone="secondary" wrap="anywhere">
                  {line.item_subtitle}
                </Text>
              ) : null}
            </Show>
            <Inline gap={2}>
              {line.item_language_code ? (
                <Badge tone="neutral">{formatLanguageCodeLabel(line.item_language_code)}</Badge>
              ) : null}
              <Badge tone={readinessTone(line)}>{readinessLabel(line)}</Badge>
            </Inline>
            {renderLineOptions(line)}
            <ListingPreferenceStatus line={line} />
            {!hasFulfillmentPath(line) ? (
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.cartPage.resolve.before.checkout")}
              </Text>
            ) : null}
          </Stack>
          <QuantityControls line={line} />
          <Stack gap={3}>
            <Show from="md">
              <Text size="sm" tone="secondary">
                {t("checkout.features.cart.ui.cartPage.total")}
              </Text>
              <Text weight="semibold">{linePriceLabel(line)}</Text>
            </Show>
            <CartLineActions line={line} />
          </Stack>
        </Grid>
      </Surface>
    </Form>
  );
}

function readinessHiddenFields(snapshot: CartReadinessSnapshot, decisions: CartReadinessDecisionInput | null) {
  return (
    <>
      <HiddenInput type="hidden" name="readinessSnapshotId" value={snapshot.snapshotId} />
      <HiddenInput type="hidden" name="readinessSourceRevision" value={snapshot.sourceRevision} />
      <HiddenInput type="hidden" name="readinessDecisions" value={JSON.stringify(decisions ?? {})} />
    </>
  );
}

function CheckoutForm({
  label,
  snapshot,
  decisions,
}: {
  label: string;
  snapshot: CartReadinessSnapshot;
  decisions: CartReadinessDecisionInput | null;
}) {
  return (
    <Form spacing="none" method="post" action="/checkout/buy/readiness">
      <HiddenInput type="hidden" name="source" value="cart" />
      {readinessHiddenFields(snapshot, decisions)}
      <Button type="submit" leadingIcon="lock" block>
        {label}
      </Button>
    </Form>
  );
}

function CheckoutAction({
  snapshot,
  decisions,
  acceptedOptimization,
}: {
  snapshot: CartReadinessSnapshot;
  decisions: CartReadinessDecisionInput | null;
  acceptedOptimization: { snapshot: CartReadinessSnapshot; decisions: CartReadinessDecisionInput } | null;
}) {
  if (snapshot.status !== "ready") {
    return (
      <Box minWidth="action">
        <LinkButton href={BUY_READINESS_ROUTE} tone="primary" size="md" block>
          {t("checkout.features.cart.ui.cartPage.resolve.fulfillment")}
        </LinkButton>
      </Box>
    );
  }

  return (
    <Box minWidth="action">
      <Stack gap={2}>
        <CheckoutForm
          label={t("checkout.features.cart.ui.cartPage.check.out")}
          snapshot={snapshot}
          decisions={decisions}
        />
        {acceptedOptimization ? (
          <CheckoutForm
            label={t("checkout.features.cart.ui.cartPage.use.lower.fulfillment")}
            snapshot={acceptedOptimization.snapshot}
            decisions={acceptedOptimization.decisions}
          />
        ) : null}
      </Stack>
    </Box>
  );
}

function fulfillmentReviewDescription(count: number) {
  return t(
    count === 1
      ? "checkout.features.cart.ui.cartPage.fulfillment.needs.review.description.one"
      : "checkout.features.cart.ui.cartPage.fulfillment.needs.review.description.many",
    { count },
  );
}

function SummaryText({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" tone="secondary">
      {children}
    </Text>
  );
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
  const estimatedSubtotal = estimateCartSubtotal(cartLineGroups);
  const pricedLineCount = cartLineGroups.filter(hasKnownLinePrice).length;
  const subtotalLabel =
    pricedLineCount > 0 ? formatMoney(estimatedSubtotal) : t("checkout.features.cart.ui.cartPage.price.at.checkout");
  const blockedLineCount = cartLineGroups.filter((line) => !hasFulfillmentPath(line)).length;
  const baseReadinessSnapshot = createCartReadinessSnapshot(cartLineGroups);
  const declinedOptimizationDecision =
    baseReadinessSnapshot.optimization.available &&
    baseReadinessSnapshot.optimization.proposedLineId &&
    baseReadinessSnapshot.optimization.proposedListingId
      ? ({
          optimization: {
            decision: "declined",
            lineId: baseReadinessSnapshot.optimization.proposedLineId,
            listingId: baseReadinessSnapshot.optimization.proposedListingId,
          },
        } satisfies CartReadinessDecisionInput)
      : null;
  const checkoutReadinessSnapshot = declinedOptimizationDecision
    ? createCartReadinessSnapshot(cartLineGroups, declinedOptimizationDecision)
    : baseReadinessSnapshot;
  const acceptedOptimizationDecision =
    baseReadinessSnapshot.optimization.available &&
    baseReadinessSnapshot.optimization.proposedLineId &&
    baseReadinessSnapshot.optimization.proposedListingId
      ? ({
          optimization: {
            decision: "accepted",
            lineId: baseReadinessSnapshot.optimization.proposedLineId,
            listingId: baseReadinessSnapshot.optimization.proposedListingId,
          },
        } satisfies CartReadinessDecisionInput)
      : null;
  const acceptedOptimization = acceptedOptimizationDecision
    ? {
        decisions: acceptedOptimizationDecision,
        snapshot: createCartReadinessSnapshot(cartLineGroups, acceptedOptimizationDecision),
      }
    : null;
  const cartReady = cartLineGroups.length > 0 && checkoutReadinessSnapshot.status === "ready";

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
        <Stack gap={3}>
          {!cartReady ? (
            <Banner
              title={t("checkout.features.cart.ui.cartPage.fulfillment.needs.review")}
              description={fulfillmentReviewDescription(blockedLineCount)}
            />
          ) : null}
          {cartReady && checkoutReadinessSnapshot.optimization.available ? (
            <Banner
              title={t("checkout.features.cart.ui.cartPage.optimization.available.title", {
                savings: checkoutReadinessSnapshot.optimization.savingsAmount ?? "0.00",
              })}
              description={t("checkout.features.cart.ui.cartPage.optimization.available.description")}
            />
          ) : null}
          {cartLineGroups.map((line) => (
            <CartLineRow key={line.line_id} line={line} />
          ))}
        </Stack>
      )}
    </Stack>
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("checkout.features.cart.ui.cartPage.buy.cart")}
        title={t("checkout.features.cart.ui.cartPage.your.cart")}
        description={t("checkout.features.cart.ui.cartPage.simple.cart.description")}
      />

      <PageSection
        title={t("checkout.features.cart.ui.cartPage.items")}
        description={t("checkout.features.cart.ui.cartPage.review.items.before.checkout")}
      >
        <Stack gap={4}>
          {cartContent}
          {cartLineGroups.length > 0 ? (
            <>
              <PriceBreakdown
                lines={[
                  { label: t("checkout.features.cart.ui.cartPage.items"), value: cartLineCount },
                  { label: t("checkout.features.cart.ui.cartPage.subtotal"), value: subtotalLabel },
                  {
                    label: t("checkout.features.cart.ui.cartPage.shipping.and.tax"),
                    value: t("checkout.features.cart.ui.cartPage.calculated.at.checkout"),
                    muted: true,
                  },
                ]}
                total={subtotalLabel}
                totalLabel={t("checkout.features.cart.ui.cartPage.subtotal")}
                reassurance={
                  <SecurePaymentIndicator label={t("checkout.features.cart.ui.cartPage.no.payment.until.checkout")} />
                }
              />
              <StickyCtaBar
                price={subtotalLabel}
                context={
                  <SummaryText>
                    {cartReady
                      ? t("checkout.features.cart.ui.cartPage.taxes.and.shipping.calculated")
                      : t("checkout.features.cart.ui.cartPage.resolve.before.payment")}
                  </SummaryText>
                }
                primaryAction={
                  <CheckoutAction
                    snapshot={checkoutReadinessSnapshot}
                    decisions={declinedOptimizationDecision}
                    acceptedOptimization={acceptedOptimization}
                  />
                }
                secondaryAction={
                  <LinkButton href="/search" tone="secondary" block>
                    {t("checkout.features.cart.ui.cartPage.keep.shopping")}
                  </LinkButton>
                }
              />
            </>
          ) : null}
        </Stack>
      </PageSection>
    </Page>
  );
}
