import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AddressVerificationSnapshot } from "@chase-sets/primitives/address-snapshot";
import type {
  AccountId,
  CheckoutSessionId,
  OrderId,
  PaymentId,
  ShippingAddressId,
} from "@chase-sets/primitives/typed-ids";
import type { CartReadinessFulfillmentGroup, CartReadinessSnapshot } from "../../cart/domain/readiness";
import type { CheckoutFulfillmentPreview } from "./fulfillment-preview";
import {
  assert,
  assertNever,
  CheckoutDomainError,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShippingOption,
  normalizeVersionSelection,
  type ShippingOption,
  type VersionSelectedOptionEntry,
} from "../../../support/runtime-support/common";

export type CheckoutSourceType = "cart" | "buy-now" | "offer-intent";
export type CheckoutOptimizationGoal = "lowest-total" | "fewest-shipments";

export type CheckoutSourceCommitPosition = Readonly<{
  sourceContextName: string;
  maxGlobalPosition: string;
  eventIds: readonly string[];
}>;

export type CheckoutSessionLine = Readonly<{
  listingId: string | null;
  cartLineId: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: VersionSelectedOptionEntry[];
  productSummary: string | null;
  offerPriceAmount?: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

/**
 * The buyer's authenticity-check opt-in selection (m109), tracked on
 * the checkout session so it can be forwarded to Ordering at order
 * creation. `quoteFingerprint` is the fingerprint of the offer the buyer
 * last saw in the fulfillment preview (`fulfillmentPreviewSnapshot.authenticityCheckOffer`);
 * Ordering re-resolves the policy and rejects the whole checkout
 * submission as stale if it no longer matches its own authoritative
 * recomputation.
 */
export type CheckoutAuthenticityCheckOptIn = Readonly<{
  selected: boolean;
  quoteFingerprint: string | null;
  selectedAt: string;
}>;

export type CheckoutSessionReservation = Readonly<{
  holdId: string;
  lineKey: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
  expiresAt: string;
  extensionCount: number;
  status: "active" | "expired" | "converted" | "released";
}>;

export type CheckoutSplitGroupHandoff = Readonly<{
  status: "ready";
  groups: readonly CartReadinessFulfillmentGroup[];
  supportReference: string;
}>;

export type CheckoutShippingAddress = Readonly<{
  shippingAddressId?: ShippingAddressId | null;
  name: string;
  company?: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  email?: string | null;
  verification?: AddressVerificationSnapshot | null;
}>;

export type OrderCartCleanupPlan = Readonly<{
  buyerAccountId: AccountId;
  sourceOwnerKeys: readonly string[];
  lineIds: readonly string[];
}>;

export type OrderCartCleanup = Readonly<{
  status: "pending" | "complete";
  plan: OrderCartCleanupPlan;
}>;

export type CheckoutSessionState = Readonly<{
  sessionId: CheckoutSessionId | null;
  buyerAccountId: AccountId | null;
  sourceType: CheckoutSourceType | null;
  optimizationGoal: CheckoutOptimizationGoal;
  fulfillmentPreviewRevision: string | null;
  fulfillmentPreviewSnapshot: CheckoutFulfillmentPreview | null;
  cartReadinessSnapshot: CartReadinessSnapshot | null;
  presentedAnonymousCartId: string | null;
  splitGroupHandoff: CheckoutSplitGroupHandoff | null;
  shippingOption: ShippingOption;
  shippingAddress: CheckoutShippingAddress | null;
  authenticityCheckOptIn: CheckoutAuthenticityCheckOptIn | null;
  lines: CheckoutSessionLine[];
  orderIds: readonly OrderId[];
  orderCartCleanup?: OrderCartCleanup;
  orderWriteCommitPositions: readonly CheckoutSourceCommitPosition[];
  checkoutReservations: readonly CheckoutSessionReservation[];
  paymentId: PaymentId | null;
  submittedOfferId: string | null;
  cancelledAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export const initialCheckoutSessionState: CheckoutSessionState = {
  sessionId: null,
  buyerAccountId: null,
  sourceType: null,
  optimizationGoal: "lowest-total",
  fulfillmentPreviewRevision: null,
  fulfillmentPreviewSnapshot: null,
  cartReadinessSnapshot: null,
  presentedAnonymousCartId: null,
  splitGroupHandoff: null,
  shippingOption: "standard",
  shippingAddress: null,
  authenticityCheckOptIn: null,
  lines: [],
  orderIds: [],
  orderWriteCommitPositions: [],
  checkoutReservations: [],
  paymentId: null,
  submittedOfferId: null,
  cancelledAt: null,
  createdAt: null,
  updatedAt: null,
};

export type StartCheckoutSessionCommand = Readonly<{
  type: "StartCheckoutSession";
  sessionId: CheckoutSessionId;
  buyerAccountId: AccountId;
  sourceType: CheckoutSourceType;
  optimizationGoal?: CheckoutOptimizationGoal;
  fulfillmentPreviewRevision?: string | null;
  fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
  cartReadinessSnapshot?: CartReadinessSnapshot | null;
  presentedAnonymousCartId?: string | null;
  shippingOption: ShippingOption;
  lines: readonly CheckoutSessionLine[];
  createdAt: string;
}>;

export type SelectShippingOptionCommand = Readonly<{
  type: "SelectShippingOption";
  shippingOption: ShippingOption;
  selectedAt: string;
}>;

export type SelectOptimizationGoalCommand = Readonly<{
  type: "SelectOptimizationGoal";
  optimizationGoal: CheckoutOptimizationGoal;
  selectedAt: string;
}>;

export type RecordFulfillmentPreviewCommand = Readonly<{
  type: "RecordFulfillmentPreview";
  fulfillmentPreviewRevision: string;
  fulfillmentPreviewSnapshot?: CheckoutFulfillmentPreview | null;
  recordedAt: string;
}>;

export type SetShippingAddressCommand = Readonly<{
  type: "SetShippingAddress";
  shippingAddress: CheckoutShippingAddress;
  selectedAt: string;
}>;

export type SelectAuthenticityCheckOptInCommand = Readonly<{
  type: "SelectAuthenticityCheckOptIn";
  selected: boolean;
  quoteFingerprint: string | null;
  selectedAt: string;
}>;

export type RecordOrdersCreatedCommand = Readonly<{
  type: "RecordOrdersCreated";
  fulfilledLineKeys?: readonly string[];
  orderIds: readonly OrderId[];
  orderWriteCommitPositions?: readonly CheckoutSourceCommitPosition[];
  recordedAt: string;
}>;

export type CompleteOrderCartCleanupCommand = Readonly<{
  type: "CompleteOrderCartCleanup";
  completedAt: string;
}>;

export type RecordCheckoutReservationsCommand = Readonly<{
  type: "RecordCheckoutReservations";
  reservations: readonly CheckoutSessionReservation[];
  recordedAt: string;
}>;

export type RecordPaymentStartedCommand = Readonly<{
  type: "RecordPaymentStarted";
  paymentId: PaymentId;
  recordedAt: string;
}>;

export type RecordOfferSubmittedCommand = Readonly<{
  type: "RecordOfferSubmitted";
  offerId: string;
  recordedAt: string;
}>;

export type CancelCheckoutSessionCommand = Readonly<{
  type: "CancelCheckoutSession";
  cancelledAt: string;
}>;

export type CheckoutSessionCommand =
  | StartCheckoutSessionCommand
  | SelectShippingOptionCommand
  | SelectOptimizationGoalCommand
  | RecordFulfillmentPreviewCommand
  | SetShippingAddressCommand
  | SelectAuthenticityCheckOptInCommand
  | RecordCheckoutReservationsCommand
  | RecordOrdersCreatedCommand
  | CompleteOrderCartCleanupCommand
  | RecordPaymentStartedCommand
  | RecordOfferSubmittedCommand
  | CancelCheckoutSessionCommand;

export type CheckoutSessionStartedEvent = DomainEvent<
  "checkout.session.started",
  Readonly<{
    sessionId: CheckoutSessionId;
    buyerAccountId: AccountId;
    sourceType: CheckoutSourceType;
    optimizationGoal: CheckoutOptimizationGoal;
    fulfillmentPreviewRevision: string | null;
    fulfillmentPreviewSnapshot: CheckoutFulfillmentPreview | null;
    cartReadinessSnapshot: CartReadinessSnapshot | null;
    presentedAnonymousCartId?: string | null;
    splitGroupHandoff: CheckoutSplitGroupHandoff | null;
    shippingOption: ShippingOption;
    lines: CheckoutSessionLine[];
    createdAt: string;
  }>
>;

export type CheckoutOptimizationGoalSelectedEvent = DomainEvent<
  "checkout.session.optimization-goal-selected",
  Readonly<{
    sessionId: CheckoutSessionId;
    optimizationGoal: CheckoutOptimizationGoal;
    selectedAt: string;
  }>
>;

export type CheckoutFulfillmentPreviewRecordedEvent = DomainEvent<
  "checkout.session.fulfillment-preview-recorded",
  Readonly<{
    sessionId: CheckoutSessionId;
    fulfillmentPreviewRevision: string;
    fulfillmentPreviewSnapshot: CheckoutFulfillmentPreview | null;
    recordedAt: string;
  }>
>;

export type CheckoutShippingOptionSelectedEvent = DomainEvent<
  "checkout.session.shipping-option-selected",
  Readonly<{
    sessionId: CheckoutSessionId;
    shippingOption: ShippingOption;
    selectedAt: string;
  }>
>;

export type CheckoutShippingAddressSetEvent = DomainEvent<
  "checkout.session.shipping-address-set",
  Readonly<{
    sessionId: CheckoutSessionId;
    shippingAddress: CheckoutShippingAddress;
    selectedAt: string;
  }>
>;

export type CheckoutAuthenticityCheckOptInSelectedEvent = DomainEvent<
  "checkout.session.authenticity-check-opt-in-selected",
  Readonly<{
    sessionId: CheckoutSessionId;
    selected: boolean;
    quoteFingerprint: string | null;
    selectedAt: string;
  }>
>;

export type CheckoutOrdersCreatedEvent = DomainEvent<
  "checkout.session.orders-created",
  Readonly<{
    sessionId: CheckoutSessionId;
    orderIds: OrderId[];
    orderCartCleanupPlan?: OrderCartCleanupPlan;
    orderWriteCommitPositions: CheckoutSourceCommitPosition[];
    recordedAt: string;
  }>
>;

export type CheckoutCartCleanupCompletedEvent = DomainEvent<
  "checkout.session.cart-cleanup-completed",
  Readonly<{ sessionId: CheckoutSessionId; completedAt: string }>
>;

export type CheckoutReservationsRecordedEvent = DomainEvent<
  "checkout.session.reservations-recorded",
  Readonly<{
    sessionId: CheckoutSessionId;
    reservations: CheckoutSessionReservation[];
    recordedAt: string;
  }>
>;

export type CheckoutPaymentStartedEvent = DomainEvent<
  "checkout.session.payment-started",
  Readonly<{
    sessionId: CheckoutSessionId;
    paymentId: PaymentId;
    recordedAt: string;
  }>
>;

export type CheckoutOfferSubmittedEvent = DomainEvent<
  "checkout.session.offer-submitted",
  Readonly<{
    sessionId: CheckoutSessionId;
    offerId: string;
    recordedAt: string;
  }>
>;

export type CheckoutSessionCancelledEvent = DomainEvent<
  "checkout.session.cancelled",
  Readonly<{
    sessionId: CheckoutSessionId;
    cancelledAt: string;
    releasedReservationIds: string[];
  }>
>;

export type CheckoutSessionEvent =
  | CheckoutSessionStartedEvent
  | CheckoutShippingOptionSelectedEvent
  | CheckoutOptimizationGoalSelectedEvent
  | CheckoutFulfillmentPreviewRecordedEvent
  | CheckoutShippingAddressSetEvent
  | CheckoutAuthenticityCheckOptInSelectedEvent
  | CheckoutReservationsRecordedEvent
  | CheckoutOrdersCreatedEvent
  | CheckoutCartCleanupCompletedEvent
  | CheckoutPaymentStartedEvent
  | CheckoutOfferSubmittedEvent
  | CheckoutSessionCancelledEvent;

function normalizeLine(line: CheckoutSessionLine): CheckoutSessionLine {
  const lockedListingId = normalizeOptionalText(line.lockedListingId ?? line.listingId);
  const fulfillmentMode = line.fulfillmentMode === "locked-listing" || lockedListingId ? "locked-listing" : "optimize";
  return {
    listingId: lockedListingId,
    cartLineId: normalizeOptionalText(line.cartLineId),
    catalogItemId: normalizeRequiredText(line.catalogItemId, "Checkout lines must reference a catalog item."),
    productId: normalizeRequiredText(line.productId, "Checkout lines must reference a product."),
    itemTitle: normalizeRequiredText(line.itemTitle, "Checkout lines must include an item title snapshot."),
    itemSubtitle: normalizeOptionalText(line.itemSubtitle),
    selectedOptions: normalizeVersionSelection(line.selectedOptions),
    productSummary: normalizeOptionalText(line.productSummary),
    offerPriceAmount: normalizeOptionalText(line.offerPriceAmount),
    quantity: ensurePositiveInteger(line.quantity, "Checkout quantity must be a positive whole number."),
    fulfillmentMode,
    lockedListingId,
    sellerPreferenceId: normalizeOptionalText(line.sellerPreferenceId),
    availabilityState: normalizeAvailabilityState(line.availabilityState),
  };
}

function normalizeOptimizationGoal(value: CheckoutOptimizationGoal | undefined) {
  return value === "fewest-shipments" ? "fewest-shipments" : "lowest-total";
}

function normalizeFulfillmentPreviewSnapshot(
  revision: string | null,
  snapshot: CheckoutFulfillmentPreview | null | undefined,
) {
  if (!snapshot) {
    return null;
  }

  assert(
    snapshot.revision === revision,
    "Fulfillment preview snapshot must match the recorded fulfillment preview revision.",
  );
  return snapshot;
}

function normalizeAvailabilityState(value: "available" | "unavailable" | "changed" | "waiting-for-supply" | undefined) {
  switch (value) {
    case "unavailable":
    case "changed":
    case "waiting-for-supply":
      return value;
    default:
      return "available";
  }
}

function normalizeCartReadinessSnapshot(
  sourceType: CheckoutSourceType,
  snapshot: CartReadinessSnapshot | null | undefined,
) {
  if (sourceType !== "cart") {
    return null;
  }

  assert(snapshot?.schemaVersion === "checkout.cart-readiness.v1", "Cart readiness snapshot is required.");
  assert(snapshot.source === "cart", "Cart readiness snapshot source is invalid.");
  assert(snapshot.status === "ready", "Cart readiness must be resolved before checkout starts.");
  assert(snapshot.unresolvedLineIds.length === 0, "Cart readiness cannot include unresolved fulfillment.");
  assert(snapshot.includedLineIds.length > 0, "Cart readiness must include at least one checkout line.");
  return snapshot;
}

function sortedText(values: readonly string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameTextSet(left: readonly string[], right: readonly string[], message: string) {
  const leftSorted = sortedText(left);
  const rightSorted = sortedText(right);
  assert(
    leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]),
    message,
  );
}

function normalizeSplitGroupHandoff(
  sourceType: CheckoutSourceType,
  snapshot: CartReadinessSnapshot | null,
  lines: readonly CheckoutSessionLine[],
): CheckoutSplitGroupHandoff | null {
  if (sourceType !== "cart") {
    return null;
  }

  assert(snapshot, "Cart readiness snapshot is required.");
  const groups = Array.isArray(snapshot.fulfillmentGroups) ? snapshot.fulfillmentGroups : [];
  assert(groups.length > 0, "Cart readiness must include split group facts.");

  const groupIds = new Set<string>();
  const coveredLineIds: string[] = [];
  const expectedLineIds = lines.map((line) => line.cartLineId).filter((lineId): lineId is string => Boolean(lineId));
  assert(expectedLineIds.length === lines.length, "Cart checkout lines must keep their source line references.");

  for (const group of groups) {
    assert(group.groupId.trim(), "Cart readiness split groups must have stable ids.");
    assert(!groupIds.has(group.groupId), "Cart readiness split groups must have unique ids.");
    groupIds.add(group.groupId);
    assert(group.lineIds.length > 0, "Cart readiness split groups must include checkout lines.");
    coveredLineIds.push(...group.lineIds);

    const groupLines = lines.filter((line) => line.cartLineId && group.lineIds.includes(line.cartLineId));
    assertSameTextSet(
      groupLines
        .map((line) => line.lockedListingId ?? line.listingId)
        .filter((listingId): listingId is string => Boolean(listingId)),
      group.listingIds,
      "Cart readiness split groups must match checkout line listings.",
    );
  }

  assertSameTextSet(
    coveredLineIds,
    snapshot.includedLineIds,
    "Cart readiness split groups must cover readiness lines.",
  );
  assertSameTextSet(coveredLineIds, expectedLineIds, "Cart readiness split groups must match checkout lines.");

  return {
    status: "ready",
    groups,
    supportReference: `CS-${snapshot.snapshotId.toUpperCase()}`,
  };
}

function normalizeShippingAddress(address: CheckoutShippingAddress): CheckoutShippingAddress {
  return {
    shippingAddressId: normalizeOptionalText(address.shippingAddressId) as ShippingAddressId | null,
    name: normalizeRequiredShippingAddressText(address.name),
    company: normalizeOptionalText(address.company),
    line1: normalizeRequiredShippingAddressText(address.line1),
    line2: normalizeOptionalText(address.line2),
    city: normalizeRequiredShippingAddressText(address.city),
    state: normalizeRequiredShippingAddressText(address.state).toUpperCase(),
    postalCode: normalizeRequiredShippingAddressText(address.postalCode),
    country: normalizeRequiredShippingAddressText(address.country).toUpperCase(),
    phone: normalizeOptionalText(address.phone),
    email: normalizeOptionalText(address.email),
    verification: normalizeAddressVerification(address.verification),
  };
}

function normalizeAddressVerification(
  verification: AddressVerificationSnapshot | null | undefined,
): AddressVerificationSnapshot | null {
  if (!verification) {
    return null;
  }
  const status =
    verification.status === "verified" ||
    verification.status === "corrected" ||
    verification.status === "unverified" ||
    verification.status === "undeliverable"
      ? verification.status
      : "unverified";
  const buyerDecision =
    verification.buyerDecision === "accepted-suggested" ||
    verification.buyerDecision === "kept-original" ||
    verification.buyerDecision === "provider-unavailable"
      ? verification.buyerDecision
      : null;
  const messages = Array.isArray(verification.messages)
    ? verification.messages.map((message) => message.trim()).filter(Boolean)
    : [];
  return {
    status,
    source: normalizeOptionalText(verification.source) ?? "unknown",
    checkedAt: normalizeRequiredShippingAddressText(verification.checkedAt),
    ...(buyerDecision ? { buyerDecision } : {}),
    ...(verification.suggestedAddress ? { suggestedAddress: verification.suggestedAddress } : {}),
    ...(messages.length > 0 ? { messages } : {}),
  };
}

function normalizeRequiredShippingAddressText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new CheckoutDomainError("Confirm the shipping address before creating orders.", "shipping_address_required");
  }
  return normalized;
}

function normalizeOrderIds(orderIds: readonly OrderId[]) {
  const normalized = orderIds.map((orderId) =>
    normalizeRequiredText(orderId, "Checkout must record created orders."),
  ) as OrderId[];
  assert(normalized.length > 0, "Checkout must record at least one order.");
  return normalized;
}

function normalizeCheckoutReservations(reservations: readonly CheckoutSessionReservation[]) {
  return reservations.map((reservation) => ({
    holdId: normalizeRequiredText(reservation.holdId, "Checkout reservations must include a hold id."),
    lineKey: normalizeRequiredText(reservation.lineKey, "Checkout reservations must include a line key."),
    sellerAccountId: normalizeRequiredText(
      reservation.sellerAccountId,
      "Checkout reservations must include a seller account.",
    ),
    inventoryItemId: normalizeRequiredText(
      reservation.inventoryItemId,
      "Checkout reservations must include an inventory item.",
    ),
    quantity: ensurePositiveInteger(reservation.quantity, "Checkout reservation quantity must be positive."),
    expiresAt: normalizeRequiredText(reservation.expiresAt, "Checkout reservations must include an expiry."),
    extensionCount: Math.max(0, Math.trunc(Number(reservation.extensionCount))),
    status:
      reservation.status === "expired" || reservation.status === "converted" || reservation.status === "released"
        ? reservation.status
        : ("active" as const),
  }));
}

function normalizeCommitPositions(positions: readonly CheckoutSourceCommitPosition[] = []) {
  return positions.flatMap((position) => {
    const sourceContextName = position.sourceContextName.trim();
    const maxGlobalPosition = position.maxGlobalPosition.trim();
    const eventIds = [...new Set(position.eventIds.map((eventId) => eventId.trim()).filter(Boolean))];
    return sourceContextName && /^(0|[1-9]\d*)$/.test(maxGlobalPosition) && eventIds.length > 0
      ? [{ sourceContextName, maxGlobalPosition, eventIds }]
      : [];
  });
}

function assertSessionActive(state: CheckoutSessionState, message = "Checkout session has been cancelled.") {
  assert(state.cancelledAt === null, message);
}

function cleanupSourceOwnerKeys(state: CheckoutSessionState): string[] {
  return [
    ...new Set([state.buyerAccountId!, ...(state.presentedAnonymousCartId ? [state.presentedAnonymousCartId] : [])]),
  ];
}

function orderCartCleanupPlan(
  state: CheckoutSessionState,
  fulfilledLineKeys: readonly string[] = [],
): OrderCartCleanupPlan | undefined {
  if (state.sourceType !== "cart") return undefined;
  const sessionLineIds = state.lines.flatMap((line) => (line.cartLineId ? [line.cartLineId] : []));
  // Preserve the initial Account-only whole-cart fallback outside the retained line lifecycle.
  if (sessionLineIds.length === 0 && fulfilledLineKeys.length === 0) return undefined;
  const selected = new Set(fulfilledLineKeys);
  return {
    buyerAccountId: state.buyerAccountId!,
    sourceOwnerKeys: cleanupSourceOwnerKeys(state),
    lineIds: [...new Set(sessionLineIds.filter((id) => selected.size === 0 || selected.has(id)))],
  };
}

/** Validate retained intent, including snapshots; absence alone denotes legacy history. */
export function retainedOrderCartCleanup(state: CheckoutSessionState): OrderCartCleanup | undefined {
  if (!("orderCartCleanup" in state)) return undefined;
  const cleanup = state.orderCartCleanup;
  const plan = cleanup?.plan;
  const expectedSources = cleanupSourceOwnerKeys(state);
  assert(
    state.sourceType === "cart" &&
      state.orderIds.length > 0 &&
      (cleanup?.status === "pending" || cleanup?.status === "complete") &&
      plan !== null &&
      typeof plan === "object" &&
      plan.buyerAccountId === state.buyerAccountId &&
      Array.isArray(plan.sourceOwnerKeys) &&
      plan.sourceOwnerKeys.length === expectedSources.length &&
      plan.sourceOwnerKeys.every((key, index) => typeof key === "string" && key === expectedSources[index]) &&
      Array.isArray(plan.lineIds) &&
      new Set(plan.lineIds).size === plan.lineIds.length &&
      plan.lineIds.every(
        (id) => typeof id === "string" && id.length > 0 && state.lines.some((line) => line.cartLineId === id),
      ),
    "Invalid retained cart cleanup plan.",
  );
  return cleanup;
}

export const decideCheckoutSession: AggregateDecider<
  CheckoutSessionState,
  CheckoutSessionCommand,
  CheckoutSessionEvent
> = (state, command) => {
  switch (command.type) {
    case "StartCheckoutSession": {
      assert(state.sessionId === null, "Checkout session has already started.");
      const lines = command.lines.map(normalizeLine);
      assert(lines.length > 0, "Checkout session must include at least one line.");
      const cartReadinessSnapshot = normalizeCartReadinessSnapshot(command.sourceType, command.cartReadinessSnapshot);
      const presentedAnonymousCartId =
        command.sourceType === "cart" ? normalizeOptionalText(command.presentedAnonymousCartId) : null;
      const splitGroupHandoff = normalizeSplitGroupHandoff(command.sourceType, cartReadinessSnapshot, lines);
      const fulfillmentPreviewRevision = normalizeOptionalText(command.fulfillmentPreviewRevision);
      return [
        {
          type: "checkout.session.started",
          data: {
            sessionId: command.sessionId,
            buyerAccountId: command.buyerAccountId,
            sourceType: command.sourceType,
            optimizationGoal: normalizeOptimizationGoal(command.optimizationGoal),
            fulfillmentPreviewRevision,
            fulfillmentPreviewSnapshot: normalizeFulfillmentPreviewSnapshot(
              fulfillmentPreviewRevision,
              command.fulfillmentPreviewSnapshot,
            ),
            cartReadinessSnapshot,
            presentedAnonymousCartId,
            splitGroupHandoff,
            shippingOption: normalizeShippingOption(command.shippingOption),
            lines,
            createdAt: normalizeRequiredText(command.createdAt, "Checkout session must record a creation timestamp."),
          },
        },
      ];
    }
    case "SelectOptimizationGoal":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state);
      assert(state.orderIds.length === 0, "Optimization cannot change after orders are created.");
      return [
        {
          type: "checkout.session.optimization-goal-selected",
          data: {
            sessionId: state.sessionId,
            optimizationGoal: normalizeOptimizationGoal(command.optimizationGoal),
            selectedAt: normalizeRequiredText(command.selectedAt, "Optimization selection must record a timestamp."),
          },
        },
      ];
    case "RecordFulfillmentPreview": {
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state);
      assert(state.orderIds.length === 0, "Fulfillment preview cannot change after orders are created.");
      assert(!state.submittedOfferId, "Fulfillment preview cannot change after purchase intent is placed.");
      const fulfillmentPreviewRevision = normalizeRequiredText(
        command.fulfillmentPreviewRevision,
        "Fulfillment preview must include a revision.",
      );
      return [
        {
          type: "checkout.session.fulfillment-preview-recorded",
          data: {
            sessionId: state.sessionId,
            fulfillmentPreviewRevision,
            fulfillmentPreviewSnapshot: normalizeFulfillmentPreviewSnapshot(
              fulfillmentPreviewRevision,
              command.fulfillmentPreviewSnapshot,
            ),
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Fulfillment preview recording must include a timestamp.",
            ),
          },
        },
      ];
    }
    case "SelectShippingOption":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state);
      assert(state.orderIds.length === 0, "Shipping cannot change after orders are created.");
      assert(!state.submittedOfferId, "Shipping cannot change after purchase intent is placed.");
      return [
        {
          type: "checkout.session.shipping-option-selected",
          data: {
            sessionId: state.sessionId,
            shippingOption: normalizeShippingOption(command.shippingOption),
            selectedAt: normalizeRequiredText(command.selectedAt, "Shipping selection must record a timestamp."),
          },
        },
      ];
    case "SetShippingAddress":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state);
      assert(state.orderIds.length === 0, "Shipping address cannot change after orders are created.");
      assert(!state.submittedOfferId, "Shipping address cannot change after purchase intent is placed.");
      return [
        {
          type: "checkout.session.shipping-address-set",
          data: {
            sessionId: state.sessionId,
            shippingAddress: normalizeShippingAddress(command.shippingAddress),
            selectedAt: normalizeRequiredText(
              command.selectedAt,
              "Shipping address selection must record a timestamp.",
            ),
          },
        },
      ];
    case "SelectAuthenticityCheckOptIn":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state);
      assert(state.orderIds.length === 0, "Authenticity check opt-in cannot change after orders are created.");
      assert(!state.submittedOfferId, "Authenticity check opt-in cannot change after purchase intent is placed.");
      assert(state.sourceType !== "offer-intent", "Purchase intent checkout does not offer the authenticity check.");
      if (command.selected) {
        assert(
          normalizeOptionalText(command.quoteFingerprint) !== null,
          "Authenticity check opt-in requires a current fee quote.",
        );
      }
      return [
        {
          type: "checkout.session.authenticity-check-opt-in-selected",
          data: {
            sessionId: state.sessionId,
            selected: command.selected,
            quoteFingerprint: command.selected ? normalizeOptionalText(command.quoteFingerprint) : null,
            selectedAt: normalizeRequiredText(command.selectedAt, "Authenticity check opt-in must record a timestamp."),
          },
        },
      ];
    case "RecordOrdersCreated": {
      retainedOrderCartCleanup(state);
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state, "Cancelled checkout sessions cannot create orders.");
      assert(state.shippingAddress !== null, "Checkout requires a shipping address before orders are created.");
      assert(state.sourceType !== "offer-intent", "Purchase intent does not create orders during checkout.");
      if (state.orderIds.length > 0) {
        return [];
      }
      const cleanupPlan = orderCartCleanupPlan(state, command.fulfilledLineKeys);
      return [
        {
          type: "checkout.session.orders-created",
          data: {
            sessionId: state.sessionId,
            orderIds: normalizeOrderIds(command.orderIds),
            ...(cleanupPlan ? { orderCartCleanupPlan: cleanupPlan } : {}),
            orderWriteCommitPositions: normalizeCommitPositions(command.orderWriteCommitPositions),
            recordedAt: normalizeRequiredText(command.recordedAt, "Order recording must include a timestamp."),
          },
        },
      ];
    }
    case "CompleteOrderCartCleanup": {
      const cleanup = retainedOrderCartCleanup(state);
      assert(state.sessionId !== null && cleanup !== undefined, "Checkout has no retained cart cleanup plan.");
      if (cleanup.status === "complete") return [];
      return [
        {
          type: "checkout.session.cart-cleanup-completed",
          data: {
            sessionId: state.sessionId,
            completedAt: normalizeRequiredText(command.completedAt, "Cart cleanup must record a timestamp."),
          },
        },
      ];
    }
    case "RecordCheckoutReservations":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state, "Cancelled checkout sessions cannot reserve inventory.");
      assert(state.orderIds.length === 0, "Checkout reservations cannot change after orders are created.");
      assert(state.sourceType !== "offer-intent", "Purchase intent does not reserve checkout inventory.");
      return [
        {
          type: "checkout.session.reservations-recorded",
          data: {
            sessionId: state.sessionId,
            reservations: normalizeCheckoutReservations(command.reservations),
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Checkout reservation recording must include a timestamp.",
            ),
          },
        },
      ];
    case "RecordPaymentStarted":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state, "Cancelled checkout sessions cannot start payment.");
      assert(state.orderIds.length > 0, "Orders must be created before payment starts.");
      assert(state.sourceType !== "offer-intent", "Purchase intent does not start payment during checkout.");
      if (state.paymentId) {
        return [];
      }
      return [
        {
          type: "checkout.session.payment-started",
          data: {
            sessionId: state.sessionId,
            paymentId: command.paymentId,
            recordedAt: normalizeRequiredText(command.recordedAt, "Payment recording must include a timestamp."),
          },
        },
      ];
    case "RecordOfferSubmitted":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assertSessionActive(state, "Cancelled checkout sessions cannot place purchase intent.");
      assert(state.shippingAddress !== null, "Checkout requires a shipping address before purchase intent is placed.");
      assert(state.sourceType === "offer-intent", "Only offer-intent checkout can record a submitted offer.");
      assert(state.orderIds.length === 0, "Purchase intent cannot be placed after orders are created.");
      assert(!state.paymentId, "Purchase intent cannot be placed after payment starts.");
      if (state.submittedOfferId) {
        return [];
      }
      return [
        {
          type: "checkout.session.offer-submitted",
          data: {
            sessionId: state.sessionId,
            offerId: normalizeRequiredText(command.offerId, "Checkout must record the submitted offer."),
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Offer submission recording must include a timestamp.",
            ),
          },
        },
      ];
    case "CancelCheckoutSession":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      if (state.cancelledAt) {
        return [];
      }
      assert(!state.paymentId, "Checkout sessions cannot be cancelled after payment starts.");
      assert(state.orderIds.length === 0, "Checkout sessions cannot be cancelled after orders are created.");
      assert(!state.submittedOfferId, "Checkout sessions cannot be cancelled after purchase intent is placed.");
      return [
        {
          type: "checkout.session.cancelled",
          data: {
            sessionId: state.sessionId,
            cancelledAt: normalizeRequiredText(command.cancelledAt, "Checkout cancellation must record a timestamp."),
            releasedReservationIds: state.checkoutReservations
              .filter((reservation) => reservation.status === "active")
              .map((reservation) => reservation.holdId),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCheckoutSession: AggregateEvolver<CheckoutSessionState, CheckoutSessionEvent> = (state, event) => {
  switch (event.type) {
    case "checkout.session.started":
      return {
        sessionId: event.data.sessionId,
        buyerAccountId: event.data.buyerAccountId,
        sourceType: event.data.sourceType,
        optimizationGoal: event.data.optimizationGoal ?? "lowest-total",
        fulfillmentPreviewRevision: event.data.fulfillmentPreviewRevision ?? null,
        fulfillmentPreviewSnapshot: event.data.fulfillmentPreviewSnapshot ?? null,
        cartReadinessSnapshot: event.data.cartReadinessSnapshot ?? null,
        presentedAnonymousCartId: event.data.presentedAnonymousCartId ?? null,
        splitGroupHandoff: event.data.splitGroupHandoff ?? null,
        shippingOption: event.data.shippingOption,
        shippingAddress: null,
        authenticityCheckOptIn: null,
        lines: event.data.lines,
        orderIds: [],
        orderWriteCommitPositions: [],
        checkoutReservations: [],
        paymentId: null,
        submittedOfferId: null,
        cancelledAt: null,
        createdAt: event.data.createdAt,
        updatedAt: event.data.createdAt,
      };
    case "checkout.session.optimization-goal-selected":
      return {
        ...state,
        optimizationGoal: event.data.optimizationGoal,
        fulfillmentPreviewRevision: null,
        fulfillmentPreviewSnapshot: null,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.fulfillment-preview-recorded":
      return {
        ...state,
        fulfillmentPreviewRevision: event.data.fulfillmentPreviewRevision,
        fulfillmentPreviewSnapshot: event.data.fulfillmentPreviewSnapshot,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.shipping-option-selected":
      return {
        ...state,
        shippingOption: event.data.shippingOption,
        fulfillmentPreviewRevision: null,
        fulfillmentPreviewSnapshot: null,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.shipping-address-set":
      return {
        ...state,
        shippingAddress: event.data.shippingAddress,
        fulfillmentPreviewRevision: null,
        fulfillmentPreviewSnapshot: null,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.authenticity-check-opt-in-selected":
      return {
        ...state,
        authenticityCheckOptIn: {
          selected: event.data.selected,
          quoteFingerprint: event.data.quoteFingerprint,
          selectedAt: event.data.selectedAt,
        },
        // Re-fetching the fulfillment preview after this selection changes
        // is required: the delivery-estimate window and the offer's own
        // quote fingerprint both depend on whether the buyer opted in.
        fulfillmentPreviewRevision: null,
        fulfillmentPreviewSnapshot: null,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.orders-created": {
      const next: CheckoutSessionState = {
        ...state,
        orderIds: event.data.orderIds,
        ...("orderCartCleanupPlan" in event.data
          ? { orderCartCleanup: { status: "pending", plan: event.data.orderCartCleanupPlan! } as const }
          : {}),
        checkoutReservations: state.checkoutReservations.map((reservation) => ({
          ...reservation,
          status: "converted",
        })),
        orderWriteCommitPositions: event.data.orderWriteCommitPositions ?? [],
        updatedAt: event.data.recordedAt,
      };
      retainedOrderCartCleanup(next);
      return next;
    }
    case "checkout.session.cart-cleanup-completed": {
      const cleanup = retainedOrderCartCleanup(state);
      assert(cleanup !== undefined && event.data.sessionId === state.sessionId, "Invalid cart cleanup completion.");
      return { ...state, orderCartCleanup: { ...cleanup, status: "complete" } };
    }
    case "checkout.session.reservations-recorded":
      return {
        ...state,
        checkoutReservations: event.data.reservations,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.payment-started":
      return {
        ...state,
        paymentId: event.data.paymentId,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.offer-submitted":
      return {
        ...state,
        submittedOfferId: event.data.offerId,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.cancelled":
      return {
        ...state,
        cancelledAt: event.data.cancelledAt,
        checkoutReservations: state.checkoutReservations.map((reservation) =>
          event.data.releasedReservationIds.includes(reservation.holdId)
            ? {
                ...reservation,
                status: "released" as const,
              }
            : reservation,
        ),
        updatedAt: event.data.cancelledAt,
      };
    default:
      return assertNever(event);
  }
};
