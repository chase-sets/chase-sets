import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type {
  AccountId,
  CheckoutSessionId,
  OrderId,
  PaymentId,
} from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensurePositiveInteger,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShippingOption,
  normalizeVersionSelection,
  type ShippingOption,
  type VersionSelectedOptionEntry,
} from "../../../support/runtime-support/common";

export type CheckoutSourceType = "cart" | "buy-now";
export type CheckoutOptimizationGoal = "lowest-total" | "fewest-shipments";

export type CheckoutSessionLine = Readonly<{
  listingId: string | null;
  cartLineId: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type CheckoutShippingAddress = Readonly<{
  name: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;

export type CheckoutSessionState = Readonly<{
  sessionId: CheckoutSessionId | null;
  buyerAccountId: AccountId | null;
  sourceType: CheckoutSourceType | null;
  optimizationGoal: CheckoutOptimizationGoal;
  fulfillmentPreviewRevision: string | null;
  shippingOption: ShippingOption;
  shippingAddress: CheckoutShippingAddress | null;
  lines: CheckoutSessionLine[];
  orderIds: readonly OrderId[];
  paymentId: PaymentId | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export const initialCheckoutSessionState: CheckoutSessionState = {
  sessionId: null,
  buyerAccountId: null,
  sourceType: null,
  optimizationGoal: "lowest-total",
  fulfillmentPreviewRevision: null,
  shippingOption: "standard",
  shippingAddress: null,
  lines: [],
  orderIds: [],
  paymentId: null,
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
  recordedAt: string;
}>;

export type SetShippingAddressCommand = Readonly<{
  type: "SetShippingAddress";
  shippingAddress: CheckoutShippingAddress;
  selectedAt: string;
}>;

export type RecordOrdersCreatedCommand = Readonly<{
  type: "RecordOrdersCreated";
  orderIds: readonly OrderId[];
  recordedAt: string;
}>;

export type RecordPaymentStartedCommand = Readonly<{
  type: "RecordPaymentStarted";
  paymentId: PaymentId;
  recordedAt: string;
}>;

export type CheckoutSessionCommand =
  | StartCheckoutSessionCommand
  | SelectShippingOptionCommand
  | SelectOptimizationGoalCommand
  | RecordFulfillmentPreviewCommand
  | SetShippingAddressCommand
  | RecordOrdersCreatedCommand
  | RecordPaymentStartedCommand;

export type CheckoutSessionStartedEvent = DomainEvent<
  "checkout.session.started",
  Readonly<{
    sessionId: CheckoutSessionId;
    buyerAccountId: AccountId;
    sourceType: CheckoutSourceType;
    optimizationGoal: CheckoutOptimizationGoal;
    fulfillmentPreviewRevision: string | null;
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

export type CheckoutOrdersCreatedEvent = DomainEvent<
  "checkout.session.orders-created",
  Readonly<{
    sessionId: CheckoutSessionId;
    orderIds: OrderId[];
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

export type CheckoutSessionEvent =
  | CheckoutSessionStartedEvent
  | CheckoutShippingOptionSelectedEvent
  | CheckoutOptimizationGoalSelectedEvent
  | CheckoutFulfillmentPreviewRecordedEvent
  | CheckoutShippingAddressSetEvent
  | CheckoutOrdersCreatedEvent
  | CheckoutPaymentStartedEvent;

function normalizeLine(line: CheckoutSessionLine): CheckoutSessionLine {
  const lockedListingId =
    normalizeOptionalText(line.lockedListingId ?? line.listingId);
  const fulfillmentMode =
    line.fulfillmentMode === "locked-listing" || lockedListingId
      ? "locked-listing"
      : "optimize";
  return {
    listingId: lockedListingId,
    cartLineId: normalizeOptionalText(line.cartLineId),
    catalogItemId: normalizeRequiredText(
      line.catalogItemId,
      "Checkout lines must reference a catalog item.",
    ),
    productId: normalizeRequiredText(
      line.productId,
      "Checkout lines must reference a product.",
    ),
    itemTitle: normalizeRequiredText(
      line.itemTitle,
      "Checkout lines must include an item title snapshot.",
    ),
    itemSubtitle: normalizeOptionalText(line.itemSubtitle),
    selectedOptions: normalizeVersionSelection(line.selectedOptions),
    productSummary: normalizeOptionalText(line.productSummary),
    quantity: ensurePositiveInteger(
      line.quantity,
      "Checkout quantity must be a positive whole number.",
    ),
    fulfillmentMode,
    lockedListingId,
    sellerPreferenceId: normalizeOptionalText(line.sellerPreferenceId),
    availabilityState: normalizeAvailabilityState(line.availabilityState),
  };
}

function normalizeOptimizationGoal(value: CheckoutOptimizationGoal | undefined) {
  return value === "fewest-shipments" ? "fewest-shipments" : "lowest-total";
}

function normalizeAvailabilityState(
  value: "available" | "unavailable" | "changed" | "waiting-for-supply" | undefined,
) {
  switch (value) {
    case "unavailable":
    case "changed":
    case "waiting-for-supply":
      return value;
    default:
      return "available";
  }
}

function normalizeShippingAddress(
  address: CheckoutShippingAddress,
): CheckoutShippingAddress {
  return {
    name: normalizeOptionalText(address.name),
    line1: normalizeRequiredText(address.line1, "Shipping address line 1 is required."),
    line2: normalizeOptionalText(address.line2),
    city: normalizeRequiredText(address.city, "Shipping city is required."),
    state: normalizeRequiredText(address.state, "Shipping state is required.").toUpperCase(),
    postalCode: normalizeRequiredText(
      address.postalCode,
      "Shipping postal code is required.",
    ),
    country: normalizeRequiredText(
      address.country,
      "Shipping country is required.",
    ).toUpperCase(),
  };
}

function normalizeOrderIds(orderIds: readonly OrderId[]) {
  const normalized = orderIds.map((orderId) =>
    normalizeRequiredText(orderId, "Checkout must record created orders."),
  ) as OrderId[];
  assert(normalized.length > 0, "Checkout must record at least one order.");
  return normalized;
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
      return [
        {
          type: "checkout.session.started",
          data: {
            sessionId: command.sessionId,
            buyerAccountId: command.buyerAccountId,
            sourceType: command.sourceType,
            optimizationGoal: normalizeOptimizationGoal(command.optimizationGoal),
            fulfillmentPreviewRevision: normalizeOptionalText(
              command.fulfillmentPreviewRevision,
            ),
            shippingOption: normalizeShippingOption(command.shippingOption),
            lines,
            createdAt: normalizeRequiredText(
              command.createdAt,
              "Checkout session must record a creation timestamp.",
            ),
          },
        },
      ];
    }
    case "SelectOptimizationGoal":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(state.orderIds.length === 0, "Optimization cannot change after orders are created.");
      return [
        {
          type: "checkout.session.optimization-goal-selected",
          data: {
            sessionId: state.sessionId,
            optimizationGoal: normalizeOptimizationGoal(command.optimizationGoal),
            selectedAt: normalizeRequiredText(
              command.selectedAt,
              "Optimization selection must record a timestamp.",
            ),
          },
        },
      ];
    case "RecordFulfillmentPreview":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(state.orderIds.length === 0, "Fulfillment preview cannot change after orders are created.");
      return [
        {
          type: "checkout.session.fulfillment-preview-recorded",
          data: {
            sessionId: state.sessionId,
            fulfillmentPreviewRevision: normalizeRequiredText(
              command.fulfillmentPreviewRevision,
              "Fulfillment preview must include a revision.",
            ),
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Fulfillment preview recording must include a timestamp.",
            ),
          },
        },
      ];
    case "SelectShippingOption":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(state.orderIds.length === 0, "Shipping cannot change after orders are created.");
      return [
        {
          type: "checkout.session.shipping-option-selected",
          data: {
            sessionId: state.sessionId,
            shippingOption: normalizeShippingOption(command.shippingOption),
            selectedAt: normalizeRequiredText(
              command.selectedAt,
              "Shipping selection must record a timestamp.",
            ),
          },
        },
      ];
    case "SetShippingAddress":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(
        state.orderIds.length === 0,
        "Shipping address cannot change after orders are created.",
      );
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
    case "RecordOrdersCreated":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(state.shippingAddress !== null, "Checkout requires a shipping address before orders are created.");
      if (state.orderIds.length > 0) {
        return [];
      }
      return [
        {
          type: "checkout.session.orders-created",
          data: {
            sessionId: state.sessionId,
            orderIds: normalizeOrderIds(command.orderIds),
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Order recording must include a timestamp.",
            ),
          },
        },
      ];
    case "RecordPaymentStarted":
      assert(state.sessionId !== null, "Checkout session must be started first.");
      assert(state.orderIds.length > 0, "Orders must be created before payment starts.");
      if (state.paymentId) {
        return [];
      }
      return [
        {
          type: "checkout.session.payment-started",
          data: {
            sessionId: state.sessionId,
            paymentId: command.paymentId,
            recordedAt: normalizeRequiredText(
              command.recordedAt,
              "Payment recording must include a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveCheckoutSession: AggregateEvolver<
  CheckoutSessionState,
  CheckoutSessionEvent
> = (state, event) => {
  switch (event.type) {
    case "checkout.session.started":
      return {
        sessionId: event.data.sessionId,
        buyerAccountId: event.data.buyerAccountId,
        sourceType: event.data.sourceType,
        optimizationGoal: event.data.optimizationGoal ?? "lowest-total",
        fulfillmentPreviewRevision: event.data.fulfillmentPreviewRevision ?? null,
        shippingOption: event.data.shippingOption,
        shippingAddress: null,
        lines: event.data.lines,
        orderIds: [],
        paymentId: null,
        createdAt: event.data.createdAt,
        updatedAt: event.data.createdAt,
      };
    case "checkout.session.optimization-goal-selected":
      return {
        ...state,
        optimizationGoal: event.data.optimizationGoal,
        fulfillmentPreviewRevision: null,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.fulfillment-preview-recorded":
      return {
        ...state,
        fulfillmentPreviewRevision: event.data.fulfillmentPreviewRevision,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.shipping-option-selected":
      return {
        ...state,
        shippingOption: event.data.shippingOption,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.shipping-address-set":
      return {
        ...state,
        shippingAddress: event.data.shippingAddress,
        updatedAt: event.data.selectedAt,
      };
    case "checkout.session.orders-created":
      return {
        ...state,
        orderIds: event.data.orderIds,
        updatedAt: event.data.recordedAt,
      };
    case "checkout.session.payment-started":
      return {
        ...state,
        paymentId: event.data.paymentId,
        updatedAt: event.data.recordedAt,
      };
    default:
      return assertNever(event);
  }
};
