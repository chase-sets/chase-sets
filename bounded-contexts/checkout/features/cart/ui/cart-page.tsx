import { useMemo, type ReactNode } from "react";
import { formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import {
  AccountReputationSummary,
  ActionStack,
  Badge,
  Banner,
  Box,
  Button,
  CheckoutNoticeStack,
  CheckoutTotals,
  DestructiveAction,
  Form,
  HiddenInput,
  Inline,
  LinkButton,
  MarketplaceCartLineItem,
  MarketplaceEmptyState,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  ProductOptions,
  QuantityStepper,
  SecurePaymentIndicator,
  Stack,
  StickyCtaBar,
  Surface,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import {
  createCartReadinessSnapshot,
  lowestCartReadinessListing,
  selectedCartReadinessListing,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
} from "../domain/readiness";
import type { CheckoutCartLine } from "./contracts";
import { useOptimisticCartMutationConsistency, type OptimisticCorrectionStatus } from "./optimistic-correction";

type CheckoutCartLineGroup = CheckoutCartLine & {
  groupKey: string;
  lineIds: readonly string[];
  sourceQuantity: number;
};

type CartRecoveryState = Readonly<
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
        groupKey: key,
        lineIds: [line.line_id],
        sourceQuantity: line.quantity,
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      quantity: existing.quantity + line.quantity,
      sourceQuantity: existing.sourceQuantity + line.quantity,
      lineIds: [...existing.lineIds, line.line_id],
      seller_options: mergeSellerOptions(existing.seller_options, line.seller_options),
      ...selectedListingSnapshotFields(existing.selected_listing_id ? existing : line),
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

function selectedListingSnapshotFields(
  line: Pick<
    CheckoutCartLine,
    | "selected_listing_id"
    | "selected_listing_seller_account_id"
    | "selected_listing_seller_display_name"
    | "selected_listing_seller_slug"
    | "selected_listing_price_amount"
    | "selected_listing_snapshot_source"
    | "selected_listing_snapshot_captured_at"
  >,
) {
  return {
    selected_listing_id: line.selected_listing_id,
    selected_listing_seller_account_id: line.selected_listing_seller_account_id,
    selected_listing_seller_display_name: line.selected_listing_seller_display_name,
    selected_listing_seller_slug: line.selected_listing_seller_slug,
    selected_listing_price_amount: line.selected_listing_price_amount,
    selected_listing_snapshot_source: line.selected_listing_snapshot_source,
    selected_listing_snapshot_captured_at: line.selected_listing_snapshot_captured_at,
  };
}

function lowestKnownUnitPrice(line: CheckoutCartLineGroup) {
  if (!lineHasMeasuredPricedSupply(line)) {
    return null;
  }

  const optionPrices = line.seller_options
    .filter((option) => sellerOptionHasPricedAvailability(option) && sellerOptionHasProductMeasure(option))
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

    const snapshotPrice = Number(line.selected_listing_price_amount);
    if (line.selected_listing_id === line.locked_listing_id && Number.isFinite(snapshotPrice) && snapshotPrice >= 0) {
      return snapshotPrice;
    }

    return null;
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

// A locked listing is pinned, so its price is a charge-grade `exact` value. An
// `optimize` line resolves its final listing under Smart Match at checkout, so
// its known floor is surfaced as an `indicative` `from $X`. A line with no
// priced options defers to a single quiet `Priced at checkout` statement.
function linePriceState(line: CheckoutCartLineGroup): "exact" | "indicative" | "deferred" {
  if (!hasKnownLinePrice(line)) {
    return "deferred";
  }

  return line.fulfillment_mode === "locked-listing" && line.locked_listing_id ? "exact" : "indicative";
}

function linePrice(line: CheckoutCartLineGroup): ReactNode {
  const unitPrice = selectedUnitPrice(line);
  if (unitPrice === null) {
    return null;
  }

  return formatMoney((unitPrice * line.quantity).toFixed(2), "USD");
}

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
}

function hasFulfillmentPath(line: CheckoutCartLineGroup) {
  if (line.availability_state !== "available") {
    return false;
  }

  if (line.fulfillment_mode === "locked-listing") {
    const selected = findSellerOption(line, line.locked_listing_id);
    return selected ? sellerOptionCanFulfill(selected, line.quantity) : false;
  }

  return lineHasMeasuredPricedSupply(line);
}

function lockedListingIsWaitingForSupply(line: CheckoutCartLineGroup) {
  return (
    line.fulfillment_mode === "locked-listing" && Boolean(line.locked_listing_id) && line.seller_options.length === 0
  );
}

function lockedListingChanged(line: CheckoutCartLineGroup) {
  return (
    line.fulfillment_mode === "locked-listing" &&
    Boolean(line.locked_listing_id) &&
    line.seller_options.length > 0 &&
    findSellerOption(line, line.locked_listing_id) === null
  );
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

  if (lockedListingIsWaitingForSupply(line)) {
    return t("checkout.features.cart.ui.cartPage.waiting.for.supply");
  }

  if (lockedListingChanged(line)) {
    return t("checkout.features.cart.ui.cartPage.needs.review");
  }

  if (lineHasMissingShippingMeasure(line)) {
    return t("checkout.features.cart.ui.cartPage.shipping.measure.missing");
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
  const options = line.product_summary ? productOptionsFromSummary(line.product_summary) : [];

  // A truthy `product_summary` can still yield no usable options (e.g. a summary
  // of only separators). Fall back to the quiet "Standard" badge rather than
  // rendering an empty `ProductOptions` placeholder.
  return options.length > 0 ? (
    <ProductOptions options={options} variant="chips" />
  ) : (
    <Badge tone="neutral">{t("checkout.features.cart.ui.cartPage.standard")}</Badge>
  );
}

type CheckoutCartSellerOption = CheckoutCartLineGroup["seller_options"][number];
type CheckoutCartSellerAttribution = Pick<
  CheckoutCartSellerOption,
  "seller_display_name" | "seller_average_rating" | "seller_review_count"
>;

function findSellerOption(line: CheckoutCartLineGroup, listingId: string | null): CheckoutCartSellerOption | null {
  if (!listingId) {
    return null;
  }

  return line.seller_options.find((option) => option.listing_id === listingId) ?? null;
}

function sellerOptionCanFulfill(option: CheckoutCartSellerOption, quantity: number) {
  return sellerOptionHasPricedQuantity(option, quantity) && sellerOptionHasProductMeasure(option);
}

function sellerOptionHasPricedAvailability(option: CheckoutCartSellerOption) {
  const price = Number(option.price_amount);
  return option.available_quantity > 0 && Number.isFinite(price) && price >= 0;
}

function sellerOptionHasPricedQuantity(option: CheckoutCartSellerOption, quantity: number) {
  const price = Number(option.price_amount);
  return option.available_quantity >= quantity && Number.isFinite(price) && price >= 0;
}

function sellerOptionHasProductMeasure(option: CheckoutCartSellerOption) {
  return typeof option.product_measure_snapshot === "object" && option.product_measure_snapshot !== null;
}

function aggregateSellerOptionQuantity(
  line: CheckoutCartLineGroup,
  predicate: (option: CheckoutCartSellerOption) => boolean,
) {
  return line.seller_options.reduce((sum, option) => (predicate(option) ? sum + option.available_quantity : sum), 0);
}

function lineHasPricedSupply(line: CheckoutCartLineGroup) {
  return aggregateSellerOptionQuantity(line, sellerOptionHasPricedAvailability) >= line.quantity;
}

function lineHasMeasuredPricedSupply(line: CheckoutCartLineGroup) {
  return (
    aggregateSellerOptionQuantity(
      line,
      (option) => sellerOptionHasPricedAvailability(option) && sellerOptionHasProductMeasure(option),
    ) >= line.quantity
  );
}

function lineHasMissingShippingMeasure(line: CheckoutCartLineGroup) {
  if (line.availability_state !== "available") {
    return false;
  }

  if (line.fulfillment_mode === "locked-listing") {
    const selected = findSellerOption(line, line.locked_listing_id);
    return selected
      ? sellerOptionHasPricedQuantity(selected, line.quantity) && !sellerOptionHasProductMeasure(selected)
      : false;
  }

  return lineHasPricedSupply(line) && !lineHasMeasuredPricedSupply(line);
}

function selectedListingSnapshotSeller(line: CheckoutCartLineGroup, listingId: string | null) {
  if (!listingId || line.selected_listing_id !== listingId || !line.selected_listing_seller_display_name) {
    return null;
  }

  return {
    seller_display_name: line.selected_listing_seller_display_name,
    seller_average_rating: null,
    seller_review_count: 0,
  };
}

function cartListingLabel(line: CheckoutCartLineGroup, listingId: string | null) {
  const listing = findSellerOption(line, listingId);
  const snapshot = selectedListingSnapshotSeller(line, listingId);
  return (
    listing?.seller_display_name ??
    snapshot?.seller_display_name ??
    t("checkout.features.cart.ui.cartPage.selected.listing")
  );
}

/**
 * Resolves the seller the cart would check out for a line: a pinned listing can
 * use either the current seller option or the durable selected-listing snapshot,
 * while Smart Match still resolves from current seller options.
 */
function selectedListingSellerOption(line: CheckoutCartLineGroup): CheckoutCartSellerAttribution | null {
  if (line.fulfillment_mode === "locked-listing") {
    return (
      findSellerOption(line, line.locked_listing_id) ?? selectedListingSnapshotSeller(line, line.locked_listing_id)
    );
  }

  const resolved = lowestCartReadinessListing(line);
  return findSellerOption(line, resolved?.listing_id ?? null);
}

/**
 * Renders the seller's account reputation for a resolved listing via the DS
 * `AccountReputationSummary` primitive. The primitive owns the empty state: a
 * null `seller_average_rating` or zero `seller_review_count` renders the "No
 * reviews yet" label instead of stars, so a seller with no feedback degrades
 * gracefully without a custom branch here.
 */
function SellerReputation({ option }: { option: CheckoutCartSellerAttribution | null }) {
  if (!option?.seller_display_name) {
    return null;
  }

  return (
    <AccountReputationSummary
      accountName={option.seller_display_name}
      averageRating={option.seller_average_rating}
      reviewCount={option.seller_review_count ?? 0}
      ratingLabel={t("checkout.features.cart.ui.cartPage.seller.reputation.label")}
      emptyLabel={t("checkout.features.cart.ui.cartPage.seller.reputation.empty")}
      emptyAccessibleLabel={t("checkout.features.cart.ui.cartPage.seller.reputation.empty")}
    />
  );
}

function ListingPreferenceStatus({ line }: { line: CheckoutCartLineGroup }) {
  if (line.fulfillment_mode === "locked-listing" && line.locked_listing_id) {
    return (
      <Text size="sm" tone="secondary">
        {t("checkout.features.cart.ui.cartPage.locked.listing.summary", {
          listing: cartListingLabel(line, line.locked_listing_id),
        })}
      </Text>
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

function LinePrice({ line }: { line: CheckoutCartLineGroup }) {
  const state = linePriceState(line);

  if (state === "deferred") {
    return (
      <Text size="sm" tone="tertiary">
        {t("checkout.features.cart.ui.cartPage.priced.at.checkout")}
      </Text>
    );
  }

  return (
    <Inline gap={1} wrap={false}>
      {state === "indicative" ? (
        <Text size="xs" tone="secondary">
          {t("checkout.features.cart.ui.cartPage.from")}
        </Text>
      ) : null}
      <Text weight="semibold">{linePrice(line)}</Text>
    </Inline>
  );
}

function QuantityControl({
  line,
  status,
  onQuantityChange,
}: {
  line: CheckoutCartLineGroup;
  status: OptimisticCorrectionStatus;
  onQuantityChange: (line: CheckoutCartLineGroup, quantity: number) => void;
}) {
  const safeQuantity = Math.max(1, Number(line.quantity) || 1);

  function setQuantity(nextQuantity: number | null) {
    if (nextQuantity === null) {
      return;
    }
    const quantity = Math.max(1, nextQuantity);
    if (quantity === safeQuantity) {
      return;
    }
    onQuantityChange(line, quantity);
  }

  return (
    <Box
      data-optimistic-strategy="optimistic-with-correction"
      data-correction-source="fresh-read:loader-revalidation"
      data-optimistic-resource={line.lineIds.join(":")}
      data-optimistic-status={status}
    >
      {/*
       * Intentionally NOT passing `loading={status === "pending"}` here.
       * The stepper's `loading` prop disables both −/+ buttons while a write is in
       * flight, which would kill the rapid-coalescing optimistic UX: a buyer can
       * tap +/+/+ faster than a single write settles, and those edits coalesce into
       * one cart-level target (see optimistic-correction.ts and the "coalesces rapid
       * repeated quantity clicks" test). A disabled stepper drops every edit after
       * the first. Pending state is surfaced non-blockingly via the wrapper's
       * `data-optimistic-status` hook instead; the stepper stays live by design.
       */}
      <QuantityStepper
        label={t("checkout.features.cart.ui.cartPage.quantity")}
        value={safeQuantity}
        min={1}
        onValueChange={setQuantity}
        decrementLabel={t("checkout.features.cart.ui.cartPage.decrease")}
        incrementLabel={t("checkout.features.cart.ui.cartPage.increase")}
      />
    </Box>
  );
}

function CartLineActions({
  line,
  status,
  onRemove,
  onLockPreferredListing,
}: {
  line: CheckoutCartLineGroup;
  status: OptimisticCorrectionStatus;
  onRemove: (line: CheckoutCartLineGroup) => void;
  onLockPreferredListing: (line: CheckoutCartLineGroup) => void;
}) {
  const lockAction =
    line.seller_preference_id && line.fulfillment_mode !== "locked-listing" ? (
      <Button
        type="button"
        size="sm"
        tone="secondary"
        block
        data-optimistic-strategy="optimistic-with-correction"
        data-correction-source="fresh-read:loader-revalidation"
        data-optimistic-resource={line.lineIds.join(":")}
        data-optimistic-status={status}
        onClick={() => onLockPreferredListing(line)}
      >
        {t("checkout.features.cart.ui.cartPage.lock.this.listing")}
      </Button>
    ) : null;

  const alternativesAction = !hasFulfillmentPath(line) ? (
    <LinkButton href={marketRecoveryHref(line.item_title)} tone="secondary" size="sm" block>
      {t("checkout.features.cart.ui.cartPage.find.alternatives")}
    </LinkButton>
  ) : null;

  const removeAction = (
    <DestructiveAction
      type="button"
      data-optimistic-strategy="optimistic-with-correction"
      data-correction-source="fresh-read:loader-revalidation"
      data-optimistic-resource={line.lineIds.join(":")}
      data-optimistic-status={status}
      onClick={() => onRemove(line)}
    >
      {t("checkout.features.cart.ui.cartPage.remove")}
    </DestructiveAction>
  );

  return (
    <ActionStack
      secondary={
        lockAction || alternativesAction ? (
          <Stack gap={2}>
            {lockAction}
            {alternativesAction}
          </Stack>
        ) : null
      }
      lowEmphasis={removeAction}
    />
  );
}

function CartLineRow({
  line,
  status,
  onQuantityChange,
  onRemove,
  onLockPreferredListing,
}: {
  line: CheckoutCartLineGroup;
  status: OptimisticCorrectionStatus;
  onQuantityChange: (line: CheckoutCartLineGroup, quantity: number) => void;
  onRemove: (line: CheckoutCartLineGroup) => void;
  onLockPreferredListing: (line: CheckoutCartLineGroup) => void;
}) {
  return (
    <MarketplaceCartLineItem
      imageSrc={line.item_image_url ?? CART_ITEM_FALLBACK_IMAGE_URL}
      imageAlt={t("checkout.features.cart.ui.cartPage.product.image.alt", { title: line.item_title })}
      imageSrcSet={line.item_image_srcset ?? undefined}
      imageSizes="6rem"
      loadingImageSrc={line.item_image_loading_url ?? undefined}
      loadingImageAlt={line.item_image_loading_alt ?? undefined}
      loadingImageSrcSet={line.item_image_loading_srcset ?? undefined}
      title={line.item_title}
      subtitle={line.item_subtitle ?? undefined}
      productLabel={
        <Inline gap={2} align="center">
          {line.item_language_code ? (
            <Badge tone="neutral">{formatLanguageCodeLabel(line.item_language_code)}</Badge>
          ) : null}
          <Badge tone={readinessTone(line)}>{readinessLabel(line)}</Badge>
        </Inline>
      }
      productSummary={
        <Stack gap={2}>
          {renderLineOptions(line)}
          <ListingPreferenceStatus line={line} />
          <SellerReputation option={selectedListingSellerOption(line)} />
          <LinePrice line={line} />
        </Stack>
      }
      quantityControl={<QuantityControl line={line} status={status} onQuantityChange={onQuantityChange} />}
      actions={
        <CartLineActions
          line={line}
          status={status}
          onRemove={onRemove}
          onLockPreferredListing={onLockPreferredListing}
        />
      }
    />
  );
}

function readinessHiddenFields(snapshot: CartReadinessSnapshot, decisions: CartReadinessDecisionInput | null) {
  return (
    <>
      <HiddenInput name="readinessSnapshotId" value={snapshot.snapshotId} />
      <HiddenInput name="readinessSourceRevision" value={snapshot.sourceRevision} />
      <HiddenInput name="readinessDecisions" value={JSON.stringify(decisions ?? {})} />
    </>
  );
}

function CheckoutForm({
  label,
  tone,
  snapshot,
  decisions,
}: {
  label: string;
  tone?: "primary" | "secondary";
  snapshot: CartReadinessSnapshot;
  decisions: CartReadinessDecisionInput | null;
}) {
  return (
    <Form spacing="none" method="post" action="/checkout/buy/readiness">
      <HiddenInput name="source" value="cart" />
      {readinessHiddenFields(snapshot, decisions)}
      <Button type="submit" tone={tone} leadingIcon="lock" block>
        {label}
      </Button>
    </Form>
  );
}

function CheckoutPrimaryAction({
  snapshot,
  decisions,
}: {
  snapshot: CartReadinessSnapshot;
  decisions: CartReadinessDecisionInput | null;
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
      <CheckoutForm
        label={t("checkout.features.cart.ui.cartPage.check.out")}
        tone="primary"
        snapshot={snapshot}
        decisions={decisions}
      />
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

export function CheckoutCartPage({
  cartLines,
  errorMessage,
  recoveryState,
}: {
  cartLines: readonly CheckoutCartLine[];
  errorMessage?: string | null;
  recoveryState?: CartRecoveryState | null;
}) {
  const sourceCartLineGroups = useMemo(() => groupCartLines(cartLines), [cartLines]);
  const cartMutations = useOptimisticCartMutationConsistency({ sourceCartLineGroups });
  const cartLineGroups = cartMutations.cartLineGroups;
  const visibleErrorMessage = cartMutations.errorMessage ?? errorMessage;
  const cartLineCount = cartLineGroups.reduce((sum, line) => sum + line.quantity, 0);
  const estimatedSubtotal = estimateCartSubtotal(cartLineGroups);
  const pricedLineCount = cartLineGroups.filter(hasKnownLinePrice).length;
  const hasKnownTotal = pricedLineCount > 0;
  const estimatedTotal = hasKnownTotal
    ? formatMoney(estimatedSubtotal.toFixed(2), "USD")
    : t("checkout.features.cart.ui.cartPage.priced.at.checkout");
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
  const optimizationAvailable = cartReady && checkoutReadinessSnapshot.optimization.available;
  const optimizationSavings = checkoutReadinessSnapshot.optimization.savingsAmount ?? "0.00";
  // Resolve the seller behind the proposed lower-cost listing so the savings
  // notice can name the seller and show its reputation (helps the buyer decide
  // whether the switch is worth it), falling back to the seller-less copy when
  // the proposed seller has no display name projected yet.
  const proposedOptimizationLine = checkoutReadinessSnapshot.optimization.proposedLineId
    ? (cartLineGroups.find((line) => line.line_id === checkoutReadinessSnapshot.optimization.proposedLineId) ?? null)
    : null;
  const proposedOptimizationOption = proposedOptimizationLine
    ? findSellerOption(proposedOptimizationLine, checkoutReadinessSnapshot.optimization.proposedListingId)
    : null;
  const proposedOptimizationSeller = proposedOptimizationOption?.seller_display_name ?? null;

  // §4 priority ladder: a blocking/needs-review banner and a savings notice are
  // mutually exclusive — `CheckoutNoticeStack` renders exactly the highest
  // priority active notice. Per-line state lives on each line's badge; this is
  // the single aggregate notice for the whole surface.
  const aggregateNotice = (
    <CheckoutNoticeStack
      candidates={[
        {
          priority: "needs-review",
          active: cartLineGroups.length > 0 && !cartReady,
          notice: (
            <Banner
              tone="warning"
              title={t("checkout.features.cart.ui.cartPage.fulfillment.needs.review")}
              description={fulfillmentReviewDescription(blockedLineCount)}
            />
          ),
        },
        {
          priority: "savings",
          active: optimizationAvailable,
          notice: (
            <Banner
              tone="info"
              title={
                proposedOptimizationSeller
                  ? t("checkout.features.cart.ui.cartPage.optimization.switch.to.seller.title", {
                      savings: optimizationSavings,
                      seller: proposedOptimizationSeller,
                    })
                  : t("checkout.features.cart.ui.cartPage.optimization.available.title", {
                      savings: optimizationSavings,
                    })
              }
              description={
                <Stack gap={2}>
                  <Text size="sm" tone="inherit">
                    {t("checkout.features.cart.ui.cartPage.optimization.available.description")}
                  </Text>
                  <SellerReputation option={proposedOptimizationOption} />
                </Stack>
              }
            />
          ),
        },
      ]}
    />
  );

  const checkoutContext = (
    <Text size="sm" tone="tertiary">
      {cartReady
        ? t("checkout.features.cart.ui.cartPage.taxes.and.shipping.calculated")
        : t("checkout.features.cart.ui.cartPage.resolve.before.payment")}
    </Text>
  );

  const secureIndicator = (
    <SecurePaymentIndicator label={t("checkout.features.cart.ui.cartPage.no.payment.until.checkout")} />
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
          {visibleErrorMessage ? (
            <Surface tone="subtle" elevation="tinted">
              <Stack gap={2}>
                <Badge tone="danger">{t("checkout.features.cart.ui.cartPage.checkout.issue")}</Badge>
                <Text>{visibleErrorMessage}</Text>
              </Stack>
            </Surface>
          ) : null}

          {recoveryState?.kind === "pending-fresh-write" ? (
            <Surface tone="subtle" elevation="tinted">
              <Stack gap={3}>
                <Badge tone="neutral">
                  {recoveryState.isAutoRevalidating
                    ? t("checkout.features.cart.ui.cartPage.cart.update.pending")
                    : t("checkout.features.cart.ui.cartPage.cart.update.refreshing")}
                </Badge>
                <Stack gap={1}>
                  <Text weight="semibold">{t("checkout.features.cart.ui.cartPage.cart.update.pending.title")}</Text>
                  <Text tone="secondary">{recoveryState.message}</Text>
                </Stack>
                <LinkButton href={recoveryState.refreshHref} tone="secondary">
                  {t("checkout.features.cart.ui.cartPage.refresh.cart")}
                </LinkButton>
              </Stack>
            </Surface>
          ) : cartLineGroups.length === 0 && recoveryState?.kind === "missing-after-fresh-write" ? (
            <MarketplaceEmptyState
              title={t("checkout.features.cart.ui.cartPage.your.cart.is.empty")}
              description={recoveryState.message}
              recoveryActions={
                <>
                  <LinkButton href={recoveryState.refreshHref} tone="secondary">
                    {t("checkout.features.cart.ui.cartPage.refresh.cart")}
                  </LinkButton>
                  <LinkButton href="/search">{t("checkout.features.cart.ui.cartPage.keep.shopping")}</LinkButton>
                </>
              }
            />
          ) : cartLineGroups.length === 0 ? (
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
              {aggregateNotice}
              <Stack gap={3}>
                {cartLineGroups.map((line) => (
                  <CartLineRow
                    key={line.line_id}
                    line={line}
                    status={cartMutations.statusForLine(line)}
                    onQuantityChange={cartMutations.setQuantity}
                    onRemove={cartMutations.removeLine}
                    onLockPreferredListing={cartMutations.lockPreferredListing}
                  />
                ))}
              </Stack>
              <CheckoutTotals
                lines={[
                  { label: t("checkout.features.cart.ui.cartPage.items"), value: cartLineCount },
                  {
                    label: t("checkout.features.cart.ui.cartPage.shipping.and.tax"),
                    value: t("checkout.features.cart.ui.cartPage.calculated.at.checkout"),
                    muted: true,
                  },
                ]}
                totalLabel={t("checkout.features.cart.ui.cartPage.estimated.total")}
                total={estimatedTotal}
                totalCaption={t("checkout.features.cart.ui.cartPage.final.total.confirmed")}
                deferred={!hasKnownTotal}
              />
              <StickyCtaBar
                totalLabel={t("checkout.features.cart.ui.cartPage.estimated.total")}
                total={estimatedTotal}
                context={checkoutContext}
                reassurance={secureIndicator}
                primaryAction={
                  <CheckoutPrimaryAction
                    snapshot={checkoutReadinessSnapshot}
                    decisions={declinedOptimizationDecision}
                  />
                }
                secondaryAction={
                  <Stack gap={2}>
                    {optimizationAvailable && acceptedOptimization ? (
                      <CheckoutForm
                        label={t("checkout.features.cart.ui.cartPage.use.lower.fulfillment")}
                        tone="secondary"
                        snapshot={acceptedOptimization.snapshot}
                        decisions={acceptedOptimization.decisions}
                      />
                    ) : null}
                    <LinkButton href="/search" tone="secondary" block>
                      {t("checkout.features.cart.ui.cartPage.keep.shopping")}
                    </LinkButton>
                  </Stack>
                }
              />
            </>
          )}
        </Stack>
      </PageSection>
    </Page>
  );
}
