import { parseReadinessDecisionInputBase } from "../../../support/request-support/readiness-decision-parser";

export type CartReadinessAvailabilityState = "available" | "unavailable" | "changed" | "waiting-for-supply";

export type CartReadinessSellerOption = Readonly<{
  listing_id: string;
  seller_account_id?: string | null;
  seller_display_name: string | null;
  price_amount: string;
  available_quantity: number;
  product_summary: string | null;
  product_measure_snapshot: Readonly<Record<string, unknown>> | null;
}>;

export type CartReadinessLine = Readonly<{
  line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle?: string | null;
  selected_options?: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  product_summary?: string | null;
  quantity: number;
  fulfillment_mode: "optimize" | "locked-listing";
  locked_listing_id: string | null;
  seller_preference_id: string | null;
  availability_state: CartReadinessAvailabilityState;
  seller_options: readonly CartReadinessSellerOption[];
  updated_at: string;
}>;

export type CartReadinessUnionSource = Readonly<{
  accountId: string;
  presentedAnonymousCartId: string;
}>;

export type CartReadinessLineOutcome = "checkout" | "save-for-later" | "removed";
export type CartReadinessOptimizationDecision = "none" | "accepted" | "declined";

export type CartReadinessMoney = Readonly<{
  amount: string;
  currency: "USD";
}>;

export type CartReadinessFulfillmentGroup = Readonly<{
  groupId: string;
  lineIds: readonly string[];
  listingIds: readonly string[];
  sellerAccountId: string | null;
  sellerDisplayName: string | null;
  itemCount: number;
  packageCount: number;
  deliveryPromise: string | null;
  shippingAmount: CartReadinessMoney | null;
  supportReference: string;
  downstreamReferenceStatus: "not-started";
}>;

export type CartReadinessDecisionInput = Readonly<{
  lineOutcomes?: readonly Readonly<{ lineId: string; outcome: Exclude<CartReadinessLineOutcome, "checkout"> }>[];
  optimization?: Readonly<{
    decision: Exclude<CartReadinessOptimizationDecision, "none">;
    lineId: string;
    listingId: string;
  }> | null;
}>;

export type CartReadinessSnapshot = Readonly<{
  schemaVersion: "checkout.cart-readiness.v1";
  source: "cart";
  sourceRevision: string;
  snapshotId: string;
  status: "ready" | "needs-resolution" | "blocked";
  lineCount: number;
  includedLineIds: readonly string[];
  unresolvedLineIds: readonly string[];
  lineOutcomes: readonly Readonly<{
    lineId: string;
    outcome: CartReadinessLineOutcome;
    reason:
      | "ready"
      | "unassigned-fulfillment"
      | "unavailable"
      | "waiting-for-supply"
      | "changed"
      | "shipping-measure-missing";
  }>[];
  optimization: Readonly<{
    available: boolean;
    decision: CartReadinessOptimizationDecision;
    proposedLineId: string | null;
    proposedListingId: string | null;
    currentListingId: string | null;
    savingsAmount: string | null;
    currency: "USD";
  }>;
  fulfillmentGroups: readonly CartReadinessFulfillmentGroup[];
  customerSafeFacts: readonly string[];
}>;

export function parseCartReadinessDecisionInput(value: unknown): CartReadinessDecisionInput {
  const parsed = parseReadinessDecisionInputBase(value, {
    lineOutcomeValues: ["removed", "save-for-later"] as const,
    optimizationDecisionValues: ["accepted", "declined"] as const,
  });

  return {
    lineOutcomes: parsed.lineOutcomes,
    optimization: parsed.optimization,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function stableHash(value: unknown) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `cr_${(hash >>> 0).toString(36)}`;
}

function moneyValue(amount: string | null | undefined) {
  const value = Number(amount);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatAmount(value: number) {
  return value.toFixed(2);
}

function optionHasProductMeasure(option: CartReadinessSellerOption) {
  return typeof option.product_measure_snapshot === "object" && option.product_measure_snapshot !== null;
}

function optionHasPricedAvailability(option: CartReadinessSellerOption) {
  return option.available_quantity > 0 && moneyValue(option.price_amount) !== null;
}

function optionHasAvailablePricedQuantity(option: CartReadinessSellerOption, quantity: number) {
  return option.available_quantity >= quantity && moneyValue(option.price_amount) !== null;
}

function optionCanFulfill(option: CartReadinessSellerOption, quantity: number) {
  return optionHasAvailablePricedQuantity(option, quantity) && optionHasProductMeasure(option);
}

function pricedAvailableQuantity(options: readonly CartReadinessSellerOption[]) {
  return options.reduce(
    (sum, option) => (optionHasPricedAvailability(option) ? sum + option.available_quantity : sum),
    0,
  );
}

function measuredPricedAvailableQuantity(options: readonly CartReadinessSellerOption[]) {
  return options.reduce(
    (sum, option) =>
      optionHasPricedAvailability(option) && optionHasProductMeasure(option) ? sum + option.available_quantity : sum,
    0,
  );
}

function groupHash(value: unknown) {
  return stableHash(value).replace(/^cr_/, "cfg_");
}

export function selectedCartReadinessListing(line: CartReadinessLine) {
  if (!line.locked_listing_id) {
    return null;
  }

  return line.seller_options.find((option) => option.listing_id === line.locked_listing_id) ?? null;
}

export function lowestCartReadinessListing(line: CartReadinessLine) {
  return (
    line.seller_options
      .filter((option) => optionCanFulfill(option, line.quantity))
      .sort(
        (left, right) =>
          (moneyValue(left.price_amount) ?? Number.POSITIVE_INFINITY) -
            (moneyValue(right.price_amount) ?? Number.POSITIVE_INFINITY) ||
          left.listing_id.localeCompare(right.listing_id),
      )[0] ?? null
  );
}

/**
 * A locked listing is "gone" when its `locked_listing_id` is absent from a
 * NON-EMPTY `seller_options` set (the pinned listing was withdrawn or sold
 * out). Empty options mean no projected data yet, not a gone listing — so we
 * degrade gracefully and do not treat that as gone.
 */
function lockedListingIsGone(line: CartReadinessLine) {
  return (
    line.fulfillment_mode === "locked-listing" &&
    Boolean(line.locked_listing_id) &&
    line.seller_options.length > 0 &&
    selectedCartReadinessListing(line) === null
  );
}

function lockedListingIsWaitingForSupply(line: CartReadinessLine) {
  return (
    line.fulfillment_mode === "locked-listing" && Boolean(line.locked_listing_id) && line.seller_options.length === 0
  );
}

function lineHasMissingShippingMeasure(line: CartReadinessLine) {
  if (line.availability_state !== "available") {
    return false;
  }

  if (line.fulfillment_mode === "locked-listing") {
    const selected = selectedCartReadinessListing(line);
    return selected
      ? optionHasAvailablePricedQuantity(selected, line.quantity) && !optionHasProductMeasure(selected)
      : false;
  }

  return (
    pricedAvailableQuantity(line.seller_options) >= line.quantity &&
    measuredPricedAvailableQuantity(line.seller_options) < line.quantity
  );
}

export function cartReadinessLineHasFulfillment(line: CartReadinessLine) {
  if (line.availability_state !== "available") {
    return false;
  }

  if (line.fulfillment_mode === "locked-listing") {
    if (!line.locked_listing_id) {
      return false;
    }

    const selected = selectedCartReadinessListing(line);
    if (selected) {
      return optionCanFulfill(selected, line.quantity);
    }

    return false;
  }

  return measuredPricedAvailableQuantity(line.seller_options) >= line.quantity;
}

function lineReason(line: CartReadinessLine): CartReadinessSnapshot["lineOutcomes"][number]["reason"] {
  if (line.availability_state === "unavailable") {
    return "unavailable";
  }
  if (line.availability_state === "waiting-for-supply") {
    return "waiting-for-supply";
  }
  if (line.availability_state === "changed") {
    return "changed";
  }
  if (lockedListingIsGone(line)) {
    return "changed";
  }
  if (lockedListingIsWaitingForSupply(line)) {
    return "waiting-for-supply";
  }
  if (lineHasMissingShippingMeasure(line)) {
    return "shipping-measure-missing";
  }
  return cartReadinessLineHasFulfillment(line) ? "ready" : "unassigned-fulfillment";
}

function normalizeDecisions(decisions: CartReadinessDecisionInput | null | undefined) {
  const lineOutcomes = new Map<string, Exclude<CartReadinessLineOutcome, "checkout">>();
  for (const decision of decisions?.lineOutcomes ?? []) {
    if (decision.outcome === "removed" || decision.outcome === "save-for-later") {
      lineOutcomes.set(decision.lineId, decision.outcome);
    }
  }

  const optimization =
    decisions?.optimization?.decision === "accepted" || decisions?.optimization?.decision === "declined"
      ? decisions.optimization
      : null;

  return { lineOutcomes, optimization };
}

function findOptimizationProposal(lines: readonly CartReadinessLine[]) {
  let best: Readonly<{
    line: CartReadinessLine;
    current: CartReadinessSellerOption;
    proposed: CartReadinessSellerOption;
    savings: number;
  }> | null = null;

  for (const line of lines) {
    if (line.availability_state !== "available" || line.fulfillment_mode !== "locked-listing") {
      continue;
    }

    const current = selectedCartReadinessListing(line);
    const proposed = lowestCartReadinessListing(line);
    const currentPrice = moneyValue(current?.price_amount);
    const proposedPrice = moneyValue(proposed?.price_amount);
    if (
      !current ||
      !proposed ||
      current.listing_id === proposed.listing_id ||
      currentPrice === null ||
      proposedPrice === null
    ) {
      continue;
    }

    const savings = (currentPrice - proposedPrice) * line.quantity;
    if (savings <= 0) {
      continue;
    }

    if (!best || savings > best.savings) {
      best = { line, current, proposed, savings };
    }
  }

  return best;
}

function selectedListingForCheckout(
  line: CartReadinessLine,
  optimizationAccepted: boolean,
  optimizationProposal: ReturnType<typeof findOptimizationProposal>,
) {
  if (optimizationAccepted && optimizationProposal?.line.line_id === line.line_id) {
    return optimizationProposal.proposed;
  }

  if (line.fulfillment_mode === "locked-listing") {
    return selectedCartReadinessListing(line);
  }

  return lowestCartReadinessListing(line);
}

function buildFulfillmentGroups(
  lines: readonly CartReadinessLine[],
  includedLineIds: readonly string[],
  optimizationAccepted: boolean,
  optimizationProposal: ReturnType<typeof findOptimizationProposal>,
): readonly CartReadinessFulfillmentGroup[] {
  const included = new Set(includedLineIds);
  const groups = new Map<
    string,
    {
      lineIds: string[];
      listingIds: string[];
      sellerAccountId: string | null;
      sellerDisplayName: string | null;
      itemCount: number;
    }
  >();

  for (const line of lines) {
    if (!included.has(line.line_id)) {
      continue;
    }

    const selected = selectedListingForCheckout(line, optimizationAccepted, optimizationProposal);
    const listingId = selected?.listing_id ?? line.locked_listing_id ?? null;
    const sellerAccountId = selected?.seller_account_id?.trim() || null;
    const sellerDisplayName = selected?.seller_display_name?.trim() || null;
    const groupKey = sellerAccountId ? `seller:${sellerAccountId}` : `listing:${listingId ?? line.line_id}`;
    const group = groups.get(groupKey) ?? {
      lineIds: [],
      listingIds: [],
      sellerAccountId,
      sellerDisplayName,
      itemCount: 0,
    };

    group.lineIds.push(line.line_id);
    if (listingId) {
      group.listingIds.push(listingId);
    }
    group.itemCount += line.quantity;
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .map((group) => {
      const lineIds = [...new Set(group.lineIds)].sort();
      const listingIds = [...new Set(group.listingIds)].sort();
      const groupId = groupHash({
        lineIds,
        listingIds,
        sellerAccountId: group.sellerAccountId,
      });

      return {
        groupId,
        lineIds,
        listingIds,
        sellerAccountId: group.sellerAccountId,
        sellerDisplayName: group.sellerDisplayName,
        itemCount: group.itemCount,
        packageCount: 1,
        deliveryPromise: null,
        shippingAmount: null,
        supportReference: `CSG-${groupId.slice(4).toUpperCase()}`,
        downstreamReferenceStatus: "not-started" as const,
      };
    })
    .sort((left, right) => left.groupId.localeCompare(right.groupId));
}

function legacySourceRevisionFor(lines: readonly CartReadinessLine[]) {
  return stableHash(
    lines.map((line) => ({
      lineId: line.line_id,
      productId: line.product_id,
      quantity: line.quantity,
      fulfillmentMode: line.fulfillment_mode,
      lockedListingId: line.locked_listing_id,
      sellerPreferenceId: line.seller_preference_id,
      availabilityState: line.availability_state,
      sellerOptions: line.seller_options.map((option) => ({
        listingId: option.listing_id,
        sellerAccountId: option.seller_account_id ?? null,
        sellerDisplayName: option.seller_display_name,
        priceAmount: option.price_amount,
        availableQuantity: option.available_quantity,
        productMeasureSnapshot: option.product_measure_snapshot,
      })),
      updatedAt: line.updated_at,
    })),
  );
}

function normalizedUnionSellerOptions(options: readonly CartReadinessSellerOption[]) {
  return [...options]
    .map((option) => ({
      listingId: option.listing_id,
      sellerAccountId: option.seller_account_id ?? null,
      sellerDisplayName: option.seller_display_name,
      priceAmount: option.price_amount,
      availableQuantity: option.available_quantity,
      productMeasureSnapshot: option.product_measure_snapshot,
    }))
    .sort((left, right) => left.listingId.localeCompare(right.listingId));
}

function unionSourceRevisionFor(lines: readonly CartReadinessLine[], source: CartReadinessUnionSource) {
  return stableHash({
    accountId: source.accountId.trim(),
    presentedAnonymousCartId: source.presentedAnonymousCartId.trim(),
    lines: [...lines]
      .sort((left, right) => left.line_id.localeCompare(right.line_id))
      .map((line) => ({
        lineId: line.line_id,
        catalogItemId: line.catalog_catalog_item_id,
        productId: line.product_id,
        itemTitle: line.item_title,
        itemSubtitle: line.item_subtitle ?? null,
        selectedOptions: [...(line.selected_options ?? [])]
          .map((option) => ({ dimensionId: option.dimensionId, optionId: option.optionId }))
          .sort(
            (left, right) =>
              left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
          ),
        productSummary: line.product_summary ?? null,
        quantity: line.quantity,
        fulfillmentMode: line.fulfillment_mode,
        lockedListingId: line.locked_listing_id,
        sellerPreferenceId: line.seller_preference_id,
        availabilityState: line.availability_state,
        sellerOptions: normalizedUnionSellerOptions(line.seller_options),
      })),
  });
}

export function createCartReadinessSnapshot(
  lines: readonly CartReadinessLine[],
  decisions?: CartReadinessDecisionInput | null,
  unionSource?: CartReadinessUnionSource | null,
): CartReadinessSnapshot {
  const sortedLines = [...lines].sort((left, right) => left.line_id.localeCompare(right.line_id));
  const normalized = normalizeDecisions(decisions);
  const optimizationProposal = findOptimizationProposal(sortedLines);
  const optimizationDecision =
    normalized.optimization && optimizationProposal
      ? normalized.optimization.decision
      : ("none" as CartReadinessOptimizationDecision);
  const optimizationAccepted =
    optimizationDecision === "accepted" &&
    normalized.optimization?.lineId === optimizationProposal?.line.line_id &&
    normalized.optimization?.listingId === optimizationProposal?.proposed.listing_id;

  const lineOutcomes = sortedLines.map((line) => {
    const reason = lineReason(line);
    const explicitOutcome = normalized.lineOutcomes.get(line.line_id);
    const outcome: CartReadinessLineOutcome = explicitOutcome ?? "checkout";
    return {
      lineId: line.line_id,
      outcome,
      reason,
    };
  });

  const includedLineIds = lineOutcomes
    .filter((outcome) => outcome.outcome === "checkout" && outcome.reason === "ready")
    .map((outcome) => outcome.lineId);
  if (
    optimizationAccepted &&
    optimizationProposal &&
    !normalized.lineOutcomes.has(optimizationProposal.line.line_id) &&
    !includedLineIds.includes(optimizationProposal.line.line_id)
  ) {
    includedLineIds.push(optimizationProposal.line.line_id);
  }
  includedLineIds.sort();

  const unresolvedLineIds = lineOutcomes
    .filter((outcome) => outcome.outcome === "checkout" && outcome.reason !== "ready")
    .map((outcome) => outcome.lineId);

  const status =
    includedLineIds.length === 0 ? "blocked" : unresolvedLineIds.length > 0 ? "needs-resolution" : ("ready" as const);
  const sourceRevision = unionSource
    ? unionSourceRevisionFor(sortedLines, unionSource)
    : legacySourceRevisionFor(sortedLines);
  const fulfillmentGroups =
    status === "ready"
      ? buildFulfillmentGroups(sortedLines, includedLineIds, optimizationAccepted, optimizationProposal)
      : [];
  const snapshotSeed = {
    sourceRevision,
    includedLineIds,
    lineOutcomes,
    optimizationDecision,
    proposedListingId: optimizationProposal?.proposed.listing_id ?? null,
    fulfillmentGroups,
  };

  return {
    schemaVersion: "checkout.cart-readiness.v1",
    source: "cart",
    sourceRevision,
    snapshotId: stableHash(snapshotSeed),
    status,
    lineCount: sortedLines.reduce((sum, line) => sum + line.quantity, 0),
    includedLineIds,
    unresolvedLineIds,
    lineOutcomes,
    optimization: {
      available: Boolean(optimizationProposal),
      decision: optimizationDecision,
      proposedLineId: optimizationProposal?.line.line_id ?? null,
      proposedListingId: optimizationProposal?.proposed.listing_id ?? null,
      currentListingId: optimizationProposal?.current.listing_id ?? null,
      savingsAmount: optimizationProposal ? formatAmount(optimizationProposal.savings) : null,
      currency: "USD",
    },
    fulfillmentGroups,
    customerSafeFacts: [
      status === "ready"
        ? "Ready for checkout."
        : status === "blocked"
          ? "No cart items are ready for checkout."
          : "Some cart items need attention before checkout.",
      ...(optimizationProposal
        ? [`Save $${formatAmount(optimizationProposal.savings)} by changing fulfillment before checkout.`]
        : []),
    ],
  };
}

export function applyCartReadinessToLines<TLine extends CartReadinessLine>(
  lines: readonly TLine[],
  snapshot: CartReadinessSnapshot,
): TLine[] {
  const included = new Set(snapshot.includedLineIds);
  return lines
    .filter((line) => included.has(line.line_id))
    .map((line) => {
      if (line.fulfillment_mode === "optimize") {
        const selected = lowestCartReadinessListing(line);
        if (selected) {
          return {
            ...line,
            fulfillment_mode: "locked-listing",
            locked_listing_id: selected.listing_id,
          };
        }
      }

      if (
        snapshot.optimization.decision === "accepted" &&
        snapshot.optimization.proposedLineId === line.line_id &&
        snapshot.optimization.proposedListingId
      ) {
        return {
          ...line,
          fulfillment_mode: "locked-listing",
          locked_listing_id: snapshot.optimization.proposedListingId,
        };
      }

      return line;
    });
}

export function validateCartReadinessSnapshot(
  lines: readonly CartReadinessLine[],
  provided: Pick<CartReadinessSnapshot, "snapshotId" | "sourceRevision"> & { decisions?: CartReadinessDecisionInput },
  unionSource?: CartReadinessUnionSource | null,
) {
  const current = createCartReadinessSnapshot(lines, provided.decisions, unionSource);
  return {
    current,
    valid: current.snapshotId === provided.snapshotId && current.sourceRevision === provided.sourceRevision,
  };
}

export function cartReadinessDecisionsFromSnapshot(snapshot: CartReadinessSnapshot): CartReadinessDecisionInput {
  return {
    lineOutcomes: snapshot.lineOutcomes
      .filter(
        (
          outcome,
        ): outcome is Readonly<{
          lineId: string;
          outcome: Exclude<CartReadinessLineOutcome, "checkout">;
          reason: CartReadinessSnapshot["lineOutcomes"][number]["reason"];
        }> => outcome.outcome === "removed" || outcome.outcome === "save-for-later",
      )
      .map((outcome) => ({
        lineId: outcome.lineId,
        outcome: outcome.outcome,
      })),
    optimization:
      (snapshot.optimization.decision === "accepted" || snapshot.optimization.decision === "declined") &&
      snapshot.optimization.proposedLineId &&
      snapshot.optimization.proposedListingId
        ? {
            decision: snapshot.optimization.decision,
            lineId: snapshot.optimization.proposedLineId,
            listingId: snapshot.optimization.proposedListingId,
          }
        : null,
  };
}
