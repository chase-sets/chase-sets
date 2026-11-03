import { useEffect, useMemo } from "react";
import { formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import { centsToSignedMoneyAmount, trySignedMoneyToCents } from "@chase-sets/primitives/money";
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
  Heading,
  HiddenInput,
  Inline,
  LinkButton,
  LiveRegion,
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
  type CartReadinessDecisionInput,
  type CartReadinessLinePresentation,
  type CartReadinessRead,
  type CartReadinessSnapshot,
} from "../api/contracts";
import type { CheckoutCartLine } from "./contracts";
import {
  useOptimisticCartMutationConsistency,
  type CartAttemptState,
  type OptimisticCorrectionStatus,
} from "./optimistic-correction";

type CheckoutCartLineGroup = CheckoutCartLine & {
  groupKey: string;
  lineIds: readonly string[];
  sourceQuantity: number;
  presentation: CartReadinessLinePresentation | null;
  presentationQuantity: number;
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

function cartLinePresentationKey(line: CheckoutCartLine, presentation: CartReadinessLinePresentation | null) {
  if (!presentation) {
    return "no-read";
  }

  const price = presentation.price;
  const quantity = Math.max(1, Number(line.quantity) || 1);
  const amountMinor = price ? trySignedMoneyToCents(price.amount) : null;
  const normalizedPrice =
    price && amountMinor !== null && amountMinor % BigInt(quantity) === 0n
      ? { state: price.state, currency: price.currency, unitAmountMinor: String(amountMinor / BigInt(quantity)) }
      : price
        ? { state: price.state, currency: price.currency, amount: price.amount }
        : null;

  return JSON.stringify({
    reason: presentation.reason,
    fulfillmentAvailable: presentation.fulfillmentAvailable,
    listingId: presentation.listingId,
    price: normalizedPrice,
  });
}

function cartLineGroupKey(line: CheckoutCartLine, presentation: CartReadinessLinePresentation | null) {
  return [
    line.catalog_catalog_item_id,
    line.product_id,
    line.fulfillment_mode,
    line.locked_listing_id ?? "",
    line.seller_preference_id ?? "",
    cartLinePresentationKey(line, presentation),
  ].join(":");
}

function groupCartLines(
  cartLines: readonly CheckoutCartLine[],
  linePresentations: readonly CartReadinessLinePresentation[] = [],
): CheckoutCartLineGroup[] {
  const grouped = new Map<string, CheckoutCartLineGroup>();
  const presentationByLineId = new Map(linePresentations.map((presentation) => [presentation.lineId, presentation]));

  for (const line of cartLines) {
    const presentation = presentationByLineId.get(line.line_id) ?? null;
    const key = cartLineGroupKey(line, presentation);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        ...line,
        groupKey: key,
        lineIds: [line.line_id],
        sourceQuantity: line.quantity,
        presentation,
        presentationQuantity: line.quantity,
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      quantity: existing.quantity + line.quantity,
      sourceQuantity: existing.sourceQuantity + line.quantity,
      lineIds: [...existing.lineIds, line.line_id],
      presentation: mergeLinePresentations(existing.presentation, presentation),
      presentationQuantity: existing.presentationQuantity + line.quantity,
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

function mergeLinePresentations(
  left: CartReadinessLinePresentation | null,
  right: CartReadinessLinePresentation | null,
): CartReadinessLinePresentation | null {
  if (!left || !right || !left.price || !right.price) {
    return left ?? right;
  }
  const leftAmount = trySignedMoneyToCents(left.price.amount);
  const rightAmount = trySignedMoneyToCents(right.price.amount);
  if (
    leftAmount === null ||
    rightAmount === null ||
    left.price.state !== right.price.state ||
    left.price.currency !== right.price.currency
  ) {
    return left;
  }
  return {
    ...left,
    price: {
      ...left.price,
      amount: centsToSignedMoneyAmount(leftAmount + rightAmount),
    },
  };
}

function mergeSellerOptions(left: CheckoutCartLine["seller_options"], right: CheckoutCartLine["seller_options"]) {
  return [...new Map([...left, ...right].map((option) => [option.listing_id, option] as const)).values()].sort(
    (a, b) => {
      const currencyOrder = (a.price_currency_code ?? "").localeCompare(b.price_currency_code ?? "");
      if (currencyOrder !== 0) {
        return currencyOrder;
      }

      const leftAmount = trySignedMoneyToCents(a.price_amount);
      const rightAmount = trySignedMoneyToCents(b.price_amount);
      const amountOrder =
        leftAmount === rightAmount ? 0 : leftAmount === null || leftAmount > (rightAmount ?? 0n) ? 1 : -1;
      return amountOrder || a.listing_id.localeCompare(b.listing_id);
    },
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
    | "selected_listing_price_currency_code"
    | "selected_listing_stream_version"
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
    selected_listing_price_currency_code: line.selected_listing_price_currency_code ?? null,
    selected_listing_stream_version: line.selected_listing_stream_version ?? null,
    selected_listing_snapshot_source: line.selected_listing_snapshot_source,
    selected_listing_snapshot_captured_at: line.selected_listing_snapshot_captured_at,
  };
}

function optimisticLinePrice(line: CheckoutCartLineGroup): CartReadinessLinePresentation["price"] {
  const price = line.presentation?.price;
  if (!price || price.state !== "indicative" || line.presentationQuantity < 1) {
    return null;
  }
  const amountMinor = trySignedMoneyToCents(price.amount);
  const sourceQuantity = BigInt(line.presentationQuantity);
  if (amountMinor === null || amountMinor % sourceQuantity !== 0n) {
    return null;
  }
  return {
    ...price,
    amount: centsToSignedMoneyAmount((amountMinor / sourceQuantity) * BigInt(line.quantity)),
  };
}

function optimisticIndicativeSubtotal(
  lines: readonly CheckoutCartLineGroup[],
): { amount: string; currency: string } | null {
  let currency: string | null = null;
  let amountMinor = 0n;

  for (const line of lines) {
    const price = line.presentation?.price;
    if (!price || price.state !== "indicative" || line.presentationQuantity < 1) {
      return null;
    }

    const unitAmountMinor = trySignedMoneyToCents(price.amount);
    if (unitAmountMinor === null || unitAmountMinor < 0n) {
      return null;
    }
    const divisor = BigInt(line.presentationQuantity);
    if (unitAmountMinor % divisor !== 0n) {
      return null;
    }
    if (currency === null) {
      currency = price.currency;
    } else if (currency !== price.currency) {
      return null;
    }
    amountMinor += (unitAmountMinor / divisor) * BigInt(line.quantity);
  }

  return currency === null ? null : { amount: centsToSignedMoneyAmount(amountMinor), currency };
}

function marketRecoveryHref(itemTitle: string) {
  return `/search?q=${encodeURIComponent(itemTitle)}`;
}

function readinessLabel(line: CheckoutCartLineGroup, status: OptimisticCorrectionStatus) {
  if (status === "pending") {
    return t("checkout.features.cart.ui.cartPage.cart.update.pending");
  }
  switch (line.presentation?.reason) {
    case "unavailable":
      return t("checkout.features.cart.ui.cartPage.unavailable");
    case "waiting-for-supply":
      return t("checkout.features.cart.ui.cartPage.waiting.for.supply");
    case "changed":
    case "currency-mismatch":
      return t("checkout.features.cart.ui.cartPage.needs.review");
    case "shipping-measure-missing":
      return t("checkout.features.cart.ui.cartPage.shipping.measure.missing");
    case "unassigned-fulfillment":
      return t("checkout.features.cart.ui.cartPage.needs.fulfillment");
    case "ready":
      return t("checkout.features.cart.ui.cartPage.ready");
    default:
      return t("checkout.features.cart.ui.cartPage.needs.review");
  }
}

function readinessTone(line: CheckoutCartLineGroup, status: OptimisticCorrectionStatus) {
  if (status === "pending") {
    return "neutral";
  }
  return line.presentation?.reason === "ready" && line.presentation.fulfillmentAvailable ? "success" : "warning";
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
function selectedListingSellerOption(
  line: CheckoutCartLineGroup,
  listingId: string | null,
): CheckoutCartSellerAttribution | null {
  if (line.fulfillment_mode === "locked-listing") {
    return (
      findSellerOption(line, line.locked_listing_id) ?? selectedListingSnapshotSeller(line, line.locked_listing_id)
    );
  }

  return findSellerOption(line, listingId);
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

function LinePrice({ line, status }: { line: CheckoutCartLineGroup; status: OptimisticCorrectionStatus }) {
  const price = status === "pending" ? optimisticLinePrice(line) : line.presentation?.price;
  const state = price?.state ?? "deferred";

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
      <Text weight="semibold">{price ? formatMoney(price.amount, price.currency) : null}</Text>
    </Inline>
  );
}

function QuantityControl({
  line,
  status,
  onQuantityChange,
  disabled,
}: {
  line: CheckoutCartLineGroup;
  status: OptimisticCorrectionStatus;
  onQuantityChange: (line: CheckoutCartLineGroup, quantity: number) => void;
  disabled: boolean;
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
        disabled={disabled}
      />
    </Box>
  );
}

function CartLineActions({
  line,
  status,
  onRemove,
  onLockPreferredListing,
  disabled,
}: {
  line: CheckoutCartLineGroup;
  status: OptimisticCorrectionStatus;
  onRemove: (line: CheckoutCartLineGroup) => void;
  onLockPreferredListing: (line: CheckoutCartLineGroup) => void;
  disabled: boolean;
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
        disabled={disabled}
        onClick={() => onLockPreferredListing(line)}
      >
        {t("checkout.features.cart.ui.cartPage.lock.this.listing")}
      </Button>
    ) : null;

  const alternativesAction =
    line.presentation?.fulfillmentAvailable === false ? (
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
      disabled={disabled}
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
  listingId,
  status,
  onQuantityChange,
  onRemove,
  onLockPreferredListing,
  disabled,
}: {
  line: CheckoutCartLineGroup;
  listingId: string | null;
  status: OptimisticCorrectionStatus;
  onQuantityChange: (line: CheckoutCartLineGroup, quantity: number) => void;
  onRemove: (line: CheckoutCartLineGroup) => void;
  onLockPreferredListing: (line: CheckoutCartLineGroup) => void;
  disabled: boolean;
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
          <Badge tone={readinessTone(line, status)}>{readinessLabel(line, status)}</Badge>
        </Inline>
      }
      productSummary={
        <Stack gap={2}>
          {renderLineOptions(line)}
          <ListingPreferenceStatus line={line} />
          <SellerReputation option={selectedListingSellerOption(line, line.presentation?.listingId ?? listingId)} />
          <LinePrice line={line} status={status} />
        </Stack>
      }
      quantityControl={
        <QuantityControl line={line} status={status} onQuantityChange={onQuantityChange} disabled={disabled} />
      }
      actions={
        <CartLineActions
          line={line}
          status={status}
          onRemove={onRemove}
          onLockPreferredListing={onLockPreferredListing}
          disabled={disabled}
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

const CART_ATTEMPT_HEADING_ID = "checkout-cart-attempt-result";

function cartAttemptTitle(state: CartAttemptState["state"]) {
  switch (state) {
    case "ambiguous":
      return t("checkout.features.cart.ui.cartPage.attempt.ambiguous.title");
    case "partial":
      return t("checkout.features.cart.ui.cartPage.attempt.partial.title");
    case "failed-safe":
      return t("checkout.features.cart.ui.cartPage.attempt.failed.safe.title");
  }
}

function cartAttemptDescription(attempt: CartAttemptState) {
  switch (attempt.state) {
    case "ambiguous":
      return t("checkout.features.cart.ui.cartPage.attempt.ambiguous.description");
    case "partial":
      return t("checkout.features.cart.ui.cartPage.attempt.partial.description");
    case "failed-safe":
      return attempt.message ?? t("checkout.features.cart.ui.cartPage.attempt.failed.safe.description");
  }
}

/**
 * The owner's answer to the last cart submission that did not simply succeed.
 * Its heading takes focus and its description is announced, so a buyer using
 * assistive technology learns the outcome without hunting for it. An
 * ambiguous attempt offers only an explicit resend of the same attempt or a
 * fresh read of the cart -- never an automatic retry.
 */
function CartAttemptNotice({
  attempt,
  onResend,
  resending,
}: {
  attempt: CartAttemptState;
  onResend: () => void;
  resending: boolean;
}) {
  useEffect(() => {
    globalThis.document?.getElementById(CART_ATTEMPT_HEADING_ID)?.focus();
  }, [attempt.attemptId, attempt.state]);

  return (
    <Surface tone="subtle" elevation="tinted">
      <Stack gap={3}>
        <Heading level={2} visualSize={4} id={CART_ATTEMPT_HEADING_ID} tabIndex={-1}>
          {cartAttemptTitle(attempt.state)}
        </Heading>
        <LiveRegion politeness="polite">
          <Text tone="secondary">{cartAttemptDescription(attempt)}</Text>
        </LiveRegion>
        {attempt.state === "partial" && attempt.terminalLines.length > 0 ? (
          <Stack gap={1}>
            {attempt.terminalLines.map((line, index) => (
              <Text key={`${line.lineId ?? "line"}-${index}`} size="sm">
                {line.message ?? t("checkout.features.cart.ui.cartPage.attempt.line.not.applied")}
              </Text>
            ))}
          </Stack>
        ) : null}
        {attempt.state === "ambiguous" ? (
          <Inline gap={2}>
            <Button type="button" tone="secondary" onClick={onResend} disabled={resending}>
              {t("checkout.features.cart.ui.cartPage.attempt.resend")}
            </Button>
            <LinkButton href="/account/cart" tone="secondary">
              {t("checkout.features.cart.ui.cartPage.refresh.cart")}
            </LinkButton>
          </Inline>
        ) : null}
      </Stack>
    </Surface>
  );
}

export function CheckoutCartPage({
  cartLines,
  readiness: providedReadiness,
  errorMessage,
  recoveryState,
  attemptState,
}: {
  cartLines: readonly CheckoutCartLine[];
  readiness: CartReadinessRead | null;
  errorMessage?: string | null;
  recoveryState?: CartRecoveryState | null;
  attemptState?: CartAttemptState | null;
}) {
  const sourceCartLineGroups = useMemo(
    () => groupCartLines(cartLines, providedReadiness?.loaded.linePresentations ?? []),
    [cartLines, providedReadiness],
  );
  const cartMutations = useOptimisticCartMutationConsistency({ sourceCartLineGroups });
  const visibleAttempt = cartMutations.attemptState ?? attemptState ?? null;
  const cartLineGroups = cartMutations.cartLineGroups;
  const hasPendingOptimisticMutation = sourceCartLineGroups.some(
    (line) => cartMutations.statusForLine(line) !== "idle",
  );
  const readiness = providedReadiness && !hasPendingOptimisticMutation ? providedReadiness : null;
  const visibleErrorMessage = cartMutations.errorMessage ?? errorMessage;
  const cartLineCount = cartLineGroups.reduce((sum, line) => sum + line.quantity, 0);
  const checkoutReadinessSnapshot = readiness?.declined ?? null;
  const declinedOptimizationDecision =
    checkoutReadinessSnapshot?.optimization.decision === "declined" &&
    checkoutReadinessSnapshot.optimization.proposedLineId &&
    checkoutReadinessSnapshot.optimization.proposedListingId
      ? {
          optimization: {
            decision: "declined" as const,
            lineId: checkoutReadinessSnapshot.optimization.proposedLineId,
            listingId: checkoutReadinessSnapshot.optimization.proposedListingId,
          },
        }
      : null;
  const blockedLineCount = readiness?.blockedLineCount ?? 0;
  const estimatedSubtotal =
    readiness?.estimatedSubtotal ??
    (hasPendingOptimisticMutation ? optimisticIndicativeSubtotal(cartLineGroups) : null);
  const hasKnownTotal = estimatedSubtotal !== null;
  const estimatedTotal = estimatedSubtotal
    ? formatMoney(estimatedSubtotal.amount, estimatedSubtotal.currency)
    : t("checkout.features.cart.ui.cartPage.priced.at.checkout");
  const acceptedOptimizationDecision = readiness?.accepted
    ? ({
        optimization: {
          decision: "accepted",
          lineId: readiness.accepted.optimization.proposedLineId!,
          listingId: readiness.accepted.optimization.proposedListingId!,
        },
      } satisfies CartReadinessDecisionInput)
    : null;
  const acceptedOptimization =
    readiness?.accepted && acceptedOptimizationDecision
      ? { decisions: acceptedOptimizationDecision, snapshot: readiness.accepted }
      : null;
  const cartReady = Boolean(readiness && cartLineGroups.length > 0 && checkoutReadinessSnapshot?.status === "ready");
  const optimizationAvailable = cartReady && checkoutReadinessSnapshot?.optimization.available === true;
  const optimizationSavings = readiness?.savings
    ? formatMoney(readiness.savings.amount, readiness.savings.currency)
    : t("checkout.features.cart.ui.cartPage.priced.at.checkout");
  // Resolve the seller behind the proposed lower-cost listing so the savings
  // notice can name the seller and show its reputation (helps the buyer decide
  // whether the switch is worth it), falling back to the seller-less copy when
  // the proposed seller has no display name projected yet.
  const proposedOptimizationLine = checkoutReadinessSnapshot?.optimization.proposedLineId
    ? (cartLineGroups.find((line) => line.line_id === checkoutReadinessSnapshot.optimization.proposedLineId) ?? null)
    : null;
  const proposedOptimizationListingId = checkoutReadinessSnapshot?.optimization.proposedListingId ?? null;
  const proposedOptimizationOption = proposedOptimizationLine
    ? findSellerOption(proposedOptimizationLine, proposedOptimizationListingId)
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
          active: readiness !== null && cartLineGroups.length > 0 && !cartReady,
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
      {cartReady || readiness === null
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
          {visibleAttempt ? (
            <CartAttemptNotice
              attempt={visibleAttempt}
              onResend={cartMutations.resend}
              resending={cartMutations.resending}
            />
          ) : null}
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
                    listingId={
                      readiness
                        ? (line.presentation?.listingId ?? readiness.lineListingIds[line.line_id] ?? null)
                        : null
                    }
                    status={cartMutations.statusForLine(line)}
                    disabled={cartMutations.actionsDisabled}
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
                  checkoutReadinessSnapshot ? (
                    <CheckoutPrimaryAction
                      snapshot={checkoutReadinessSnapshot}
                      decisions={declinedOptimizationDecision}
                    />
                  ) : (
                    <Box minWidth="action">
                      <LinkButton href={BUY_READINESS_ROUTE} tone="primary" size="md" block>
                        {t("checkout.features.cart.ui.cartPage.resolve.fulfillment")}
                      </LinkButton>
                    </Box>
                  )
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
