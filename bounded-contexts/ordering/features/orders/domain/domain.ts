import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
  MarketplaceSalesFeeLineSnapshotPayload,
} from "@chase-sets/event-core";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId } from "@chase-sets/primitives/typed-ids";
import { moneyToCents } from "@chase-sets/primitives/money";
import type { PackagePlan } from "@chase-sets/product-measures";
import type { ListingEvidenceSnapshot } from "../../../support/request-support/listing-evidence";
import {
  assert,
  assertNever,
  ensureNonNegativeInteger,
  ensurePositiveInteger,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeRequiredText,
  normalizeShippingOption,
  normalizeVersionSelection,
  type OrderLineId,
  type OrderSourceType,
  type OrderStatus,
  type ShippingOption,
  type VersionSelectedOptionEntry,
} from "./common";
import { resolveOrderPaymentDeadline, type OrderPaymentDeadlinePolicyToken } from "./policies";

export type OrderingOrderLine = Readonly<{
  lineId: OrderLineId;
  listingId: string;
  inventoryItemId: string;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: VersionSelectedOptionEntry[];
  productSummary: string | null;
  gradedCard: Readonly<{
    gradingCompany: string;
    grade: string;
    certificationNumber: string | null;
  }> | null;
  unitPriceAmount: string;
  quantity: number;
  lineTotalAmount: string;
  marketplaceSalesFeePercentageBps?: number;
  marketplaceSalesFeeFixedAmount?: string;
  marketplaceSalesFeeCapAmount?: string | null;
  marketplaceSalesFeeUnitAmount: string;
  marketplaceSalesFeeTotalAmount: string;
  sellerNetUnitAmount: string;
  sellerNetTotalAmount: string;
  listingEvidenceSnapshot?: ListingEvidenceSnapshot | null;
}>;

export type OrderingReservationRequest = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId: string | null;
  status: "pending" | "confirmed" | "rejected" | "released";
  rejectionReason: string | null;
  releasedAt: string | null;
}>;

export type OrderingCommercialTermsSnapshot = Readonly<{
  marketplaceSalesFeeAmount: string;
  marketplaceSalesFeeLines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  sellerNetAmount: string;
  sellerItemNetAmount?: string;
  shippingAllowanceAmount?: string;
  sellerShippingPayoutAmount?: string;
  protectionAmount?: string;
  protectionAllowanceAmount?: string;
  protectionOverageAmount?: string;
  sellerPayoutAmount?: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

export type OrderingTaxSnapshot = Readonly<{
  taxableAmount: string;
  salesTaxAmount: string;
  jurisdictionCountry: string;
  jurisdictionState: string | null;
  rateBps: number;
  providerName: string;
  providerQuoteReference: string | null;
  quotedAt: string;
}>;

/**
 * Frozen at order creation when the buyer opted into the authenticity
 * check at checkout (m109): the fact the `authenticity` context
 * consumes to open a case (a later m109 slice). The fee amount is
 * additive to the order total (a buyer-charged line, like tax), and
 * `payer` is always "buyer" in v1 -- seller opt-in and platform-mandated
 * tiers are Phase 2 follow-ons.
 */
export type OrderingAuthenticityPlanSnapshot = Readonly<{
  feeAmount: string;
  payer: "buyer";
  policyVersion: string;
  category: "raw" | "graded" | "any";
  thresholdAmount: string;
  orderValueAmount: string;
  quotedAt: string;
}>;

export type OrderingOrderState = Readonly<{
  orderId: OrderId | null;
  sourceType: OrderSourceType | null;
  sourceReferenceId: string | null;
  buyerAccountId: AccountId | null;
  sellerAccountId: AccountId | null;
  shippingOption: ShippingOption | null;
  itemSubtotalAmount: string | null;
  shippingBaseAmount: string | null;
  shippingDiscountAmount: string | null;
  shippingAllowanceAmount: string | null;
  shippingOverageAmount: string | null;
  protectionAmount: string | null;
  protectionAllowanceAmount: string | null;
  protectionOverageAmount: string | null;
  shippingChargeAmount: string | null;
  shippingPlanSnapshot: PackagePlan | null;
  salesTaxAmount: string | null;
  totalAmount: string | null;
  taxSnapshot: OrderingTaxSnapshot | null;
  commercialTermsSnapshot: OrderingCommercialTermsSnapshot | null;
  authenticityPlanSnapshot: OrderingAuthenticityPlanSnapshot | null;
  shippingDestinationSnapshot: AddressSnapshot | null;
  shippingOriginSnapshot: AddressSnapshot | null;
  lines: OrderingOrderLine[];
  reservationRequests: OrderingReservationRequest[];
  status: OrderStatus | null;
  pendingPaymentAt: string | null;
  paymentDeadlineAt: string | null;
  paymentDeadlinePolicy: OrderPaymentDeadlinePolicyToken | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  readyForFulfillmentAt: string | null;
}>;

export const initialOrderingOrderState: OrderingOrderState = {
  orderId: null,
  sourceType: null,
  sourceReferenceId: null,
  buyerAccountId: null,
  sellerAccountId: null,
  shippingOption: null,
  itemSubtotalAmount: null,
  shippingBaseAmount: null,
  shippingDiscountAmount: null,
  shippingAllowanceAmount: null,
  shippingOverageAmount: null,
  protectionAmount: null,
  protectionAllowanceAmount: null,
  protectionOverageAmount: null,
  shippingChargeAmount: null,
  shippingPlanSnapshot: null,
  salesTaxAmount: null,
  totalAmount: null,
  taxSnapshot: null,
  commercialTermsSnapshot: null,
  authenticityPlanSnapshot: null,
  shippingDestinationSnapshot: null,
  shippingOriginSnapshot: null,
  lines: [],
  reservationRequests: [],
  status: null,
  pendingPaymentAt: null,
  paymentDeadlineAt: null,
  paymentDeadlinePolicy: null,
  cancelledAt: null,
  cancellationReason: null,
  readyForFulfillmentAt: null,
};

export type CreateOrderCommand = Readonly<{
  type: "CreateOrder";
  orderId: OrderId;
  sourceType: OrderSourceType;
  sourceReferenceId: string | null;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingAllowanceAmount?: string;
  shippingOverageAmount?: string;
  protectionAmount?: string;
  protectionAllowanceAmount?: string;
  protectionOverageAmount?: string;
  shippingChargeAmount: string;
  shippingPlanSnapshot: PackagePlan;
  salesTaxAmount: string;
  totalAmount: string;
  taxSnapshot: OrderingTaxSnapshot;
  commercialTermsSnapshot: OrderingCommercialTermsSnapshot;
  authenticityPlanSnapshot?: OrderingAuthenticityPlanSnapshot | null;
  shippingDestinationSnapshot: AddressSnapshot;
  shippingOriginSnapshot: AddressSnapshot;
  lines: OrderingOrderLine[];
  reservationRequests: Array<
    Readonly<{
      reservationRequestId: string;
      inventoryItemId: string;
      sellerAccountId: string;
      quantity: number;
      holdId?: string | null;
    }>
  >;
}>;

export type RecordReservationConfirmedCommand = Readonly<{
  type: "RecordReservationConfirmed";
  reservationRequestId: string;
  holdId: string;
  confirmedAt: string;
}>;

export type RecordReservationRejectedCommand = Readonly<{
  type: "RecordReservationRejected";
  reservationRequestId: string;
  rejectedAt: string;
  reason: string;
}>;

export type RecordReservationReleasedCommand = Readonly<{
  type: "RecordReservationReleased";
  reservationRequestId: string;
  holdId: string;
  releasedAt: string;
}>;

export type CancelOrderCommand = Readonly<{
  type: "CancelOrder";
  cancelledAt: string;
  reason: string;
}>;

export type MarkReadyForFulfillmentCommand = Readonly<{
  type: "MarkReadyForFulfillment";
  readyForFulfillmentAt: string;
}>;

export type OrderingOrderCommand =
  | CreateOrderCommand
  | RecordReservationConfirmedCommand
  | RecordReservationRejectedCommand
  | RecordReservationReleasedCommand
  | CancelOrderCommand
  | MarkReadyForFulfillmentCommand;

export type OrderCreatedEvent = DomainEvent<
  "ordering.order.created",
  Readonly<{
    orderId: OrderId;
    sourceType: OrderSourceType;
    sourceReferenceId: string | null;
    buyerAccountId: AccountId;
    sellerAccountId: AccountId;
    shippingOption: ShippingOption;
    itemSubtotalAmount: string;
    shippingBaseAmount: string;
    shippingDiscountAmount: string;
    shippingAllowanceAmount: string;
    shippingOverageAmount: string;
    protectionAmount: string;
    protectionAllowanceAmount: string;
    protectionOverageAmount: string;
    shippingChargeAmount: string;
    shippingPlanSnapshot: PackagePlan;
    salesTaxAmount: string;
    totalAmount: string;
    taxSnapshot: OrderingTaxSnapshot;
    commercialTermsSnapshot: OrderingCommercialTermsSnapshot;
    authenticityPlanSnapshot: OrderingAuthenticityPlanSnapshot | null;
    shippingDestinationSnapshot: AddressSnapshot;
    shippingOriginSnapshot: AddressSnapshot;
    lines: OrderingOrderLine[];
    reservationRequests: Array<
      Readonly<{
        reservationRequestId: string;
        inventoryItemId: string;
        sellerAccountId: string;
        quantity: number;
        holdId?: string | null;
      }>
    >;
  }>
>;

/**
 * Additive support-facing fact. The original order-created event is kept
 * immutable; downstream support projections consume this smaller, replayable
 * amount source instead of reaching into Ordering storage.
 */
export type OrderLineItemAmountsPublishedEvent = DomainEvent<
  "ordering.order.line-item-amounts-published",
  Readonly<{
    orderId: OrderId;
    lineItems: readonly Readonly<{ lineId: string; amount: string }>[];
  }>
>;

export type OrderReservationConfirmedEvent = DomainEvent<
  "ordering.order.reservation-confirmed",
  Readonly<{
    orderId: OrderId;
    reservationRequestId: string;
    inventoryItemId: string;
    sellerAccountId: string;
    quantity: number;
    holdId: string;
    confirmedAt: string;
  }>
>;

export type OrderReservationRejectedEvent = DomainEvent<
  "ordering.order.reservation-rejected",
  Readonly<{
    orderId: OrderId;
    reservationRequestId: string;
    rejectedAt: string;
    reason: string;
  }>
>;

export type OrderPendingPaymentRecordedEvent = DomainEvent<
  "ordering.order.pending-payment-recorded",
  Readonly<{
    orderId: OrderId;
    pendingPaymentAt: string;
    paymentDeadlineAt: string;
    paymentDeadlinePolicy: OrderPaymentDeadlinePolicyToken;
  }>
>;

/**
 * `statusBeforeCancellation` is derived from the aggregate's own status field. It excludes
 * the pre-creation null sentinel and the post-transition cancelled steady state, so an
 * emitter cannot write either value or a status outside the aggregate vocabulary.
 */
export type OrderStatusBeforeCancellation = Exclude<OrderingOrderState["status"], "cancelled" | null>;

export type OrderCancelledEvent = DomainEvent<
  "ordering.order.cancelled",
  Readonly<{
    orderId: OrderId;
    cancelledAt: string;
    reason: string;
    buyerEmail: string | null;
    buyerAccountId: AccountId | null;
    statusBeforeCancellation: OrderStatusBeforeCancellation;
    reservationRequests: OrderingReservationRequest[];
  }>
>;

export type OrderReservationReleasedEvent = DomainEvent<
  "ordering.order.reservation-released",
  Readonly<{
    orderId: OrderId;
    reservationRequestId: string;
    holdId: string;
    releasedAt: string;
  }>
>;

export type OrderReadyForFulfillmentEvent = DomainEvent<
  "ordering.order.ready-for-fulfillment-recorded",
  Readonly<{
    orderId: OrderId;
    readyForFulfillmentAt: string;
  }>
>;

export type OrderingOrderEvent =
  | OrderCreatedEvent
  | OrderLineItemAmountsPublishedEvent
  | OrderReservationConfirmedEvent
  | OrderReservationRejectedEvent
  | OrderPendingPaymentRecordedEvent
  | OrderCancelledEvent
  | OrderReservationReleasedEvent
  | OrderReadyForFulfillmentEvent;

function normalizeOrderLines(lines: readonly OrderingOrderLine[]) {
  assert(lines.length > 0, "Orders must include at least one line.");
  return lines.map((line) => {
    const normalized = {
      lineId: line.lineId,
      listingId: normalizeRequiredText(line.listingId, "Order lines must reference a listing."),
      inventoryItemId: normalizeRequiredText(line.inventoryItemId, "Order lines must reference inventory."),
      catalogItemId: normalizeRequiredText(
        line.catalogItemId,
        "Order lines must reference a catalog item.",
      ) as CatalogItemId,
      productId: normalizeRequiredText(
        String(line.productId),
        "Order lines must reference a product id.",
      ) as ProductKey,
      itemTitle: normalizeRequiredText(line.itemTitle, "Order lines must include an item title snapshot."),
      itemSubtitle: normalizeOptionalText(line.itemSubtitle),
      selectedOptions: normalizeVersionSelection(line.selectedOptions),
      productSummary: normalizeOptionalText(line.productSummary),
      gradedCard: normalizeGradedCardSnapshot(line.gradedCard),
      unitPriceAmount: normalizeMoneyAmount(line.unitPriceAmount, {
        fieldName: "Unit price",
      }),
      quantity: ensurePositiveInteger(line.quantity, "Order line quantity must be a positive whole number."),
      lineTotalAmount: normalizeMoneyAmount(line.lineTotalAmount, {
        fieldName: "Line total",
      }),
      marketplaceSalesFeePercentageBps: ensureNonNegativeInteger(
        line.marketplaceSalesFeePercentageBps ?? 0,
        "Line marketplace sales fee percentage must be zero or more basis points.",
      ),
      marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(
        line.marketplaceSalesFeeFixedAmount ?? line.marketplaceSalesFeeUnitAmount,
        {
          fieldName: "Line marketplace sales fee fixed amount",
          allowZero: true,
        },
      ),
      marketplaceSalesFeeCapAmount:
        line.marketplaceSalesFeeCapAmount == null
          ? null
          : normalizeMoneyAmount(line.marketplaceSalesFeeCapAmount, {
              fieldName: "Line marketplace sales fee cap amount",
            }),
      marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(line.marketplaceSalesFeeUnitAmount, {
        fieldName: "Line marketplace sales fee unit amount",
        allowZero: true,
      }),
      marketplaceSalesFeeTotalAmount: normalizeMoneyAmount(line.marketplaceSalesFeeTotalAmount, {
        fieldName: "Line marketplace sales fee total amount",
        allowZero: true,
      }),
      sellerNetUnitAmount: normalizeMoneyAmount(line.sellerNetUnitAmount, {
        fieldName: "Line seller net unit amount",
        allowZero: true,
      }),
      sellerNetTotalAmount: normalizeMoneyAmount(line.sellerNetTotalAmount, {
        fieldName: "Line seller net total amount",
        allowZero: true,
      }),
      listingEvidenceSnapshot: line.listingEvidenceSnapshot ?? null,
    };

    assert(
      moneyToCents(normalized.unitPriceAmount) * BigInt(normalized.quantity) ===
        moneyToCents(normalized.lineTotalAmount),
      "Order line total must equal unit price times quantity.",
    );
    assert(
      moneyToCents(normalized.marketplaceSalesFeeUnitAmount) * BigInt(normalized.quantity) ===
        moneyToCents(normalized.marketplaceSalesFeeTotalAmount),
      "Order line marketplace fee total must equal its unit fee times quantity.",
    );
    assert(
      moneyToCents(normalized.sellerNetUnitAmount) * BigInt(normalized.quantity) ===
        moneyToCents(normalized.sellerNetTotalAmount),
      "Order line seller net total must equal its unit net times quantity.",
    );
    assert(
      moneyToCents(normalized.marketplaceSalesFeeUnitAmount) + moneyToCents(normalized.sellerNetUnitAmount) ===
        moneyToCents(normalized.unitPriceAmount) &&
        moneyToCents(normalized.marketplaceSalesFeeTotalAmount) + moneyToCents(normalized.sellerNetTotalAmount) ===
          moneyToCents(normalized.lineTotalAmount),
      "Order line marketplace fee plus seller net must equal the line total.",
    );

    return normalized;
  });
}

function normalizeGradedCardSnapshot(line: OrderingOrderLine["gradedCard"]) {
  if (!line) {
    return null;
  }

  return {
    gradingCompany: normalizeRequiredText(line.gradingCompany, "Order line graded card company is required."),
    grade: normalizeRequiredText(line.grade, "Order line graded card grade is required."),
    certificationNumber: normalizeOptionalText(line.certificationNumber),
  };
}

function normalizeReservationRequests(requests: CreateOrderCommand["reservationRequests"], sellerAccountId: string) {
  assert(requests.length > 0, "Orders must include inventory reservation requests for committed quantity.");
  return requests.map((request) => {
    const normalizedSellerAccountId = normalizeRequiredText(
      request.sellerAccountId,
      "Reservation requests must include a seller account id.",
    );
    assert(normalizedSellerAccountId === sellerAccountId, "Reservation requests must belong to the committed seller.");

    return {
      reservationRequestId: normalizeRequiredText(
        request.reservationRequestId,
        "Reservation requests must include an id.",
      ),
      inventoryItemId: normalizeRequiredText(
        request.inventoryItemId,
        "Reservation requests must include an inventory item id.",
      ),
      sellerAccountId: normalizedSellerAccountId,
      quantity: ensurePositiveInteger(
        request.quantity,
        "Reservation request quantity must be a positive whole number.",
      ),
      holdId: normalizeOptionalText(request.holdId),
    };
  });
}

function normalizeCommercialTermsSnapshot(snapshot: OrderingCommercialTermsSnapshot) {
  const marketplaceSalesFeeAmount = normalizeMoneyAmount(snapshot.marketplaceSalesFeeAmount, {
    fieldName: "Marketplace sales fee amount",
    allowZero: true,
  });
  const marketplaceSalesFeeLines = (snapshot.marketplaceSalesFeeLines ?? []).map((line) => ({
    lineId: normalizeRequiredText(line.lineId, "Marketplace sales fee lines must reference an order line."),
    unitPriceAmount: normalizeMoneyAmount(line.unitPriceAmount, { fieldName: "Fee line unit price" }),
    quantity: ensurePositiveInteger(line.quantity, "Fee line quantity must be a positive whole number."),
    marketplaceSalesFeePercentageBps: ensureNonNegativeInteger(
      line.marketplaceSalesFeePercentageBps,
      "Fee line percentage must be zero or more basis points.",
    ),
    marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(line.marketplaceSalesFeeFixedAmount, {
      fieldName: "Fee line fixed amount",
      allowZero: true,
    }),
    marketplaceSalesFeeCapAmount:
      line.marketplaceSalesFeeCapAmount === null
        ? null
        : normalizeMoneyAmount(line.marketplaceSalesFeeCapAmount, { fieldName: "Fee line cap amount" }),
    marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(line.marketplaceSalesFeeUnitAmount, {
      fieldName: "Fee line unit fee",
      allowZero: true,
    }),
    marketplaceSalesFeeTotalAmount: normalizeMoneyAmount(line.marketplaceSalesFeeTotalAmount, {
      fieldName: "Fee line total fee",
      allowZero: true,
    }),
  }));
  if (marketplaceSalesFeeLines.length > 0) {
    assert(
      marketplaceSalesFeeLines.reduce((sum, line) => sum + moneyToCents(line.marketplaceSalesFeeTotalAmount), 0n) ===
        moneyToCents(marketplaceSalesFeeAmount),
      "Marketplace sales fee line totals must equal the order marketplace sales fee amount.",
    );
  }
  return {
    marketplaceSalesFeeAmount,
    marketplaceSalesFeeLines,
    sellerNetAmount: normalizeMoneyAmount(snapshot.sellerNetAmount, {
      fieldName: "Seller net amount",
      allowZero: true,
    }),
    sellerItemNetAmount: normalizeMoneyAmount(snapshot.sellerItemNetAmount ?? snapshot.sellerNetAmount, {
      fieldName: "Seller item net amount",
      allowZero: true,
    }),
    shippingAllowanceAmount: normalizeMoneyAmount(snapshot.shippingAllowanceAmount ?? "0.00", {
      fieldName: "Shipping allowance amount",
      allowZero: true,
    }),
    sellerShippingPayoutAmount: normalizeMoneyAmount(
      snapshot.sellerShippingPayoutAmount ?? snapshot.shippingAllowanceAmount ?? "0.00",
      {
        fieldName: "Seller shipping payout amount",
        allowZero: true,
      },
    ),
    protectionAmount: normalizeMoneyAmount(snapshot.protectionAmount ?? "0.00", {
      fieldName: "Order protection amount",
      allowZero: true,
    }),
    protectionAllowanceAmount: normalizeMoneyAmount(snapshot.protectionAllowanceAmount ?? "0.00", {
      fieldName: "Allowance-funded Order Protection amount",
      allowZero: true,
    }),
    protectionOverageAmount: normalizeMoneyAmount(snapshot.protectionOverageAmount ?? "0.00", {
      fieldName: "Overage-funded Order Protection amount",
      allowZero: true,
    }),
    sellerPayoutAmount: normalizeMoneyAmount(snapshot.sellerPayoutAmount ?? snapshot.sellerNetAmount, {
      fieldName: "Seller payout amount",
      allowZero: true,
    }),
    shippingAllowancePercentageBps: Math.max(0, Math.trunc(Number(snapshot.shippingAllowancePercentageBps ?? 500))),
    termsScheduleId: normalizeOptionalText(snapshot.termsScheduleId),
    termsAgreementId: normalizeOptionalText(snapshot.termsAgreementId),
    termsResolvedAt: normalizeRequiredText(
      snapshot.termsResolvedAt,
      "Order economics snapshot must include a resolution timestamp.",
    ),
  };
}

function normalizeTaxSnapshot(snapshot: OrderingTaxSnapshot) {
  return {
    taxableAmount: normalizeMoneyAmount(snapshot.taxableAmount, {
      fieldName: "Taxable amount",
      allowZero: true,
    }),
    salesTaxAmount: normalizeMoneyAmount(snapshot.salesTaxAmount, {
      fieldName: "Sales tax amount",
      allowZero: true,
    }),
    jurisdictionCountry: normalizeRequiredText(
      snapshot.jurisdictionCountry,
      "Tax snapshot must include a jurisdiction country.",
    ),
    jurisdictionState: normalizeOptionalText(snapshot.jurisdictionState),
    rateBps: Math.max(0, Math.trunc(Number(snapshot.rateBps))),
    providerName: normalizeRequiredText(snapshot.providerName, "Tax snapshot must include a provider name."),
    providerQuoteReference: normalizeOptionalText(snapshot.providerQuoteReference),
    quotedAt: normalizeRequiredText(snapshot.quotedAt, "Tax snapshot must include a quote timestamp."),
  };
}

function assertSeparateTransactionAccounts(buyerAccountId: AccountId, sellerAccountId: AccountId) {
  assert(buyerAccountId !== sellerAccountId, "Buyer and seller accounts must be different for an order.");
}

function normalizeAuthenticityPlanSnapshot(
  snapshot: OrderingAuthenticityPlanSnapshot | null | undefined,
): OrderingAuthenticityPlanSnapshot | null {
  if (!snapshot) {
    return null;
  }

  return {
    feeAmount: normalizeMoneyAmount(snapshot.feeAmount, {
      fieldName: "Authenticity check fee amount",
      allowZero: true,
    }),
    payer: "buyer",
    policyVersion: normalizeRequiredText(
      snapshot.policyVersion,
      "Authenticity plan must include a fee policy version.",
    ),
    category: snapshot.category === "raw" || snapshot.category === "graded" ? snapshot.category : "any",
    thresholdAmount: normalizeMoneyAmount(snapshot.thresholdAmount, {
      fieldName: "Authenticity check opt-in threshold",
      allowZero: true,
    }),
    orderValueAmount: normalizeMoneyAmount(snapshot.orderValueAmount, {
      fieldName: "Authenticity check order value",
      allowZero: true,
    }),
    quotedAt: normalizeRequiredText(snapshot.quotedAt, "Authenticity plan must include a quote timestamp."),
  };
}

function updateReservationRequest(
  state: OrderingOrderState,
  reservationRequestId: string,
  transform: (request: OrderingReservationRequest) => OrderingReservationRequest,
) {
  let matched = false;
  const reservationRequests = state.reservationRequests.map((request) => {
    if (request.reservationRequestId !== reservationRequestId) {
      return request;
    }
    matched = true;
    return transform(request);
  });

  return {
    matched,
    reservationRequests,
  };
}

function hasPendingReservations(state: OrderingOrderState) {
  return state.reservationRequests.some((request) => request.status === "pending");
}

export const decideOrderingOrder: AggregateDecider<OrderingOrderState, OrderingOrderCommand, OrderingOrderEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreateOrder": {
      assert(state.orderId === null, "Order has already been created.");
      const normalizedLines = normalizeOrderLines(command.lines);
      const normalizedSellerAccountId = normalizeRequiredText(
        command.sellerAccountId,
        "Orders must include a seller account.",
      );
      assertSeparateTransactionAccounts(command.buyerAccountId, normalizedSellerAccountId as AccountId);
      const protectionAmount = normalizeMoneyAmount(command.protectionAmount ?? "0.00", {
        fieldName: "Order protection amount",
        allowZero: true,
      });
      const protectionAllowanceAmount = normalizeMoneyAmount(command.protectionAllowanceAmount ?? "0.00", {
        fieldName: "Allowance-funded Order Protection amount",
        allowZero: true,
      });
      const protectionOverageAmount = normalizeMoneyAmount(command.protectionOverageAmount ?? "0.00", {
        fieldName: "Overage-funded Order Protection amount",
        allowZero: true,
      });
      assert(
        moneyToCents(protectionAllowanceAmount) + moneyToCents(protectionOverageAmount) ===
          moneyToCents(protectionAmount),
        "Order Protection funding shares must equal the Order Protection amount.",
      );
      const shippingOverageAmount = normalizeMoneyAmount(
        command.shippingOverageAmount ?? command.shippingChargeAmount,
        {
          fieldName: "Shipping overage amount",
          allowZero: true,
        },
      );
      const shippingChargeAmount = normalizeMoneyAmount(command.shippingChargeAmount, {
        fieldName: "Shipping charge amount",
        allowZero: true,
      });
      assert(
        moneyToCents(shippingOverageAmount) + moneyToCents(protectionOverageAmount) ===
          moneyToCents(shippingChargeAmount),
        "The buyer Shipping amount must equal shipping and Order Protection overflow.",
      );
      const commercialTermsSnapshot = normalizeCommercialTermsSnapshot(command.commercialTermsSnapshot);
      const itemSubtotalAmount = normalizeMoneyAmount(command.itemSubtotalAmount, {
        fieldName: "Item subtotal",
        allowZero: true,
      });
      const salesTaxAmount = normalizeMoneyAmount(command.salesTaxAmount, {
        fieldName: "Sales tax amount",
        allowZero: true,
      });
      const authenticityPlanSnapshot = normalizeAuthenticityPlanSnapshot(command.authenticityPlanSnapshot);
      const totalAmount = normalizeMoneyAmount(command.totalAmount, {
        fieldName: "Order total",
        allowZero: true,
      });
      assert(
        normalizedLines.reduce((sum, line) => sum + moneyToCents(line.lineTotalAmount), 0n) ===
          moneyToCents(itemSubtotalAmount),
        "Order item subtotal must equal the sum of line totals.",
      );
      assert(
        normalizedLines.reduce((sum, line) => sum + moneyToCents(line.marketplaceSalesFeeTotalAmount), 0n) ===
          moneyToCents(commercialTermsSnapshot.marketplaceSalesFeeAmount) &&
          normalizedLines.reduce((sum, line) => sum + moneyToCents(line.sellerNetTotalAmount), 0n) ===
            moneyToCents(commercialTermsSnapshot.sellerNetAmount),
        "Order line fee and seller-net totals must match the commercial terms snapshot.",
      );
      assert(
        moneyToCents(itemSubtotalAmount) +
          moneyToCents(shippingChargeAmount) +
          moneyToCents(salesTaxAmount) +
          moneyToCents(authenticityPlanSnapshot?.feeAmount ?? "0.00") ===
          moneyToCents(totalAmount),
        "Order total must equal item subtotal, Shipping, sales tax, and authenticity check fee.",
      );
      assert(
        commercialTermsSnapshot.protectionAmount === protectionAmount &&
          commercialTermsSnapshot.protectionAllowanceAmount === protectionAllowanceAmount &&
          commercialTermsSnapshot.protectionOverageAmount === protectionOverageAmount,
        "Order Protection economics must match the immutable commercial terms snapshot.",
      );
      return [
        {
          type: "ordering.order.created",
          data: {
            orderId: command.orderId,
            sourceType: command.sourceType,
            sourceReferenceId: normalizeOptionalText(command.sourceReferenceId),
            buyerAccountId: command.buyerAccountId,
            sellerAccountId: normalizedSellerAccountId as AccountId,
            shippingOption: normalizeShippingOption(command.shippingOption),
            itemSubtotalAmount,
            shippingBaseAmount: normalizeMoneyAmount(command.shippingBaseAmount, {
              fieldName: "Shipping base amount",
              allowZero: true,
            }),
            shippingDiscountAmount: normalizeMoneyAmount(command.shippingDiscountAmount, {
              fieldName: "Shipping discount amount",
              allowZero: true,
            }),
            shippingAllowanceAmount: normalizeMoneyAmount(
              command.shippingAllowanceAmount ?? command.shippingChargeAmount,
              {
                fieldName: "Shipping allowance amount",
                allowZero: true,
              },
            ),
            shippingOverageAmount,
            protectionAmount,
            protectionAllowanceAmount,
            protectionOverageAmount,
            shippingChargeAmount,
            shippingPlanSnapshot: command.shippingPlanSnapshot,
            salesTaxAmount,
            totalAmount,
            taxSnapshot: normalizeTaxSnapshot(command.taxSnapshot),
            commercialTermsSnapshot,
            authenticityPlanSnapshot,
            shippingDestinationSnapshot: normalizeAddressSnapshot(
              command.shippingDestinationSnapshot,
              "Shipping destination",
            ),
            shippingOriginSnapshot: normalizeAddressSnapshot(command.shippingOriginSnapshot, "Shipping origin"),
            lines: normalizedLines,
            reservationRequests: normalizeReservationRequests(command.reservationRequests, normalizedSellerAccountId),
          },
        },
        {
          type: "ordering.order.line-item-amounts-published",
          data: {
            orderId: command.orderId,
            lineItems: normalizedLines.map((line) => ({
              lineId: line.lineId,
              amount: line.lineTotalAmount,
            })),
          },
        },
      ];
    }
    case "RecordReservationConfirmed": {
      assert(state.orderId !== null, "Order must be created first.");
      if (state.status === "cancelled") {
        return [];
      }

      const holdId = normalizeRequiredText(command.holdId, "Reservation confirmation must include a hold id.");
      const reservationRequestId = normalizeRequiredText(
        command.reservationRequestId,
        "Reservation confirmation must include a request id.",
      );
      const updated = updateReservationRequest(state, reservationRequestId, (request) => {
        if (request.status === "confirmed" && request.holdId === holdId) {
          return request;
        }
        assert(request.status === "pending", "Only pending reservation requests can be confirmed.");
        return {
          ...request,
          holdId,
          status: "confirmed",
        };
      });

      assert(updated.matched, "Reservation confirmation must reference an existing reservation request.");

      const nextState = {
        ...state,
        reservationRequests: updated.reservationRequests,
      };
      const confirmedRequest = nextState.reservationRequests.find(
        (request) => request.reservationRequestId === reservationRequestId,
      );
      assert(confirmedRequest, "Reservation confirmation must reference an existing reservation request.");

      const events: OrderingOrderEvent[] = [
        {
          type: "ordering.order.reservation-confirmed",
          data: {
            orderId: state.orderId,
            reservationRequestId,
            inventoryItemId: confirmedRequest.inventoryItemId,
            sellerAccountId: confirmedRequest.sellerAccountId,
            quantity: confirmedRequest.quantity,
            holdId,
            confirmedAt: normalizeRequiredText(
              command.confirmedAt,
              "Reservation confirmation must record a timestamp.",
            ),
          },
        },
      ];

      if (!hasPendingReservations(nextState)) {
        const pendingPaymentAt = normalizeRequiredText(
          command.confirmedAt,
          "Reservation confirmation must record a timestamp.",
        );
        const deadline = resolveOrderPaymentDeadline(pendingPaymentAt);
        events.push({
          type: "ordering.order.pending-payment-recorded",
          data: {
            orderId: state.orderId,
            pendingPaymentAt,
            paymentDeadlineAt: deadline.paymentDeadlineAt,
            paymentDeadlinePolicy: deadline.paymentDeadlinePolicy,
          },
        });
      }

      return events;
    }
    case "RecordReservationRejected": {
      assert(state.orderId !== null && state.status !== null, "Order must be created first.");
      if (state.status === "cancelled") {
        return [];
      }

      const updated = updateReservationRequest(state, command.reservationRequestId, (request) => {
        if (
          request.status === "rejected" &&
          request.rejectionReason ===
            normalizeRequiredText(command.reason, "Reservation rejection must include a reason.")
        ) {
          return request;
        }
        assert(request.status === "pending", "Only pending reservation requests can be rejected.");
        return {
          ...request,
          status: "rejected",
          rejectionReason: normalizeRequiredText(command.reason, "Reservation rejection must include a reason."),
        };
      });

      if (!updated.matched) {
        return [];
      }

      return [
        {
          type: "ordering.order.reservation-rejected",
          data: {
            orderId: state.orderId,
            reservationRequestId: normalizeRequiredText(
              command.reservationRequestId,
              "Reservation rejection must include a request id.",
            ),
            rejectedAt: normalizeRequiredText(command.rejectedAt, "Reservation rejection must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Reservation rejection must include a reason."),
          },
        },
        {
          type: "ordering.order.cancelled",
          data: {
            orderId: state.orderId,
            cancelledAt: command.rejectedAt,
            reason: "inventory-unavailable",
            buyerEmail: state.shippingDestinationSnapshot?.email?.trim() || null,
            buyerAccountId: state.buyerAccountId,
            // Read before the fold to cancelled; `updateReservationRequest` returns new
            // arrays and never mutates `state`, so this is still the pre-transition status.
            statusBeforeCancellation: state.status,
            reservationRequests: updated.reservationRequests,
          },
        },
      ];
    }
    case "RecordReservationReleased": {
      assert(state.orderId !== null, "Order must be created first.");

      const holdId = normalizeRequiredText(command.holdId, "Reservation release must include a hold id.");
      const updated = updateReservationRequest(state, command.reservationRequestId, (request) => {
        if (request.status === "released") {
          return request;
        }
        assert(request.status === "confirmed", "Only confirmed reservation requests can be released.");
        assert(request.holdId === holdId, "Reservation release must reference the confirmed hold id.");
        return {
          ...request,
          status: "released",
          releasedAt: normalizeRequiredText(command.releasedAt, "Reservation release must record a timestamp."),
        };
      });

      if (!updated.matched) {
        return [];
      }

      return [
        {
          type: "ordering.order.reservation-released",
          data: {
            orderId: state.orderId,
            reservationRequestId: normalizeRequiredText(
              command.reservationRequestId,
              "Reservation release must include a request id.",
            ),
            holdId,
            releasedAt: normalizeRequiredText(command.releasedAt, "Reservation release must record a timestamp."),
          },
        },
      ];
    }
    case "CancelOrder":
      assert(state.orderId !== null, "Order must be created first.");
      if (state.status === "cancelled") {
        return [];
      }
      {
        const reason = normalizeRequiredText(command.reason, "Order cancellation must include a reason.");
        if (reason === "payment-deadline") {
          assert(state.status === "pending-payment", "Payment-deadline cancellation requires a pending-payment order.");
        }
      }
      assert(
        state.status === "pending-reservation" ||
          state.status === "pending-payment" ||
          state.status === "ready-for-fulfillment",
        "Only pending or fulfillment-ready orders can be cancelled.",
      );
      return [
        {
          type: "ordering.order.cancelled",
          data: {
            orderId: state.orderId,
            cancelledAt: normalizeRequiredText(command.cancelledAt, "Order cancellation must record a timestamp."),
            reason: normalizeRequiredText(command.reason, "Order cancellation must include a reason."),
            buyerEmail: state.shippingDestinationSnapshot?.email?.trim() || null,
            buyerAccountId: state.buyerAccountId,
            // Read before the fold to cancelled, narrowed by the assertion above to the
            // three non-cancelled statuses this command accepts.
            statusBeforeCancellation: state.status,
            reservationRequests: state.reservationRequests,
          },
        },
      ];
    case "MarkReadyForFulfillment":
      assert(state.orderId !== null, "Order must be created first.");
      if (state.status === "ready-for-fulfillment" || state.status === "cancelled") {
        return [];
      }
      assert(state.status === "pending-payment", "Only pending-payment orders can become ready for fulfillment.");
      return [
        {
          type: "ordering.order.ready-for-fulfillment-recorded",
          data: {
            orderId: state.orderId,
            readyForFulfillmentAt: normalizeRequiredText(
              command.readyForFulfillmentAt,
              "Order readiness must record a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveOrderingOrder: AggregateEvolver<OrderingOrderState, OrderingOrderEvent> = (state, event) => {
  switch (event.type) {
    case "ordering.order.created":
      return {
        orderId: event.data.orderId,
        sourceType: event.data.sourceType,
        sourceReferenceId: event.data.sourceReferenceId,
        buyerAccountId: event.data.buyerAccountId,
        sellerAccountId: event.data.sellerAccountId,
        shippingOption: event.data.shippingOption,
        itemSubtotalAmount: event.data.itemSubtotalAmount,
        shippingBaseAmount: event.data.shippingBaseAmount,
        shippingDiscountAmount: event.data.shippingDiscountAmount,
        shippingAllowanceAmount: event.data.shippingAllowanceAmount,
        shippingOverageAmount: event.data.shippingOverageAmount,
        protectionAmount: event.data.protectionAmount ?? "0.00",
        protectionAllowanceAmount: event.data.protectionAllowanceAmount ?? "0.00",
        protectionOverageAmount: event.data.protectionOverageAmount ?? "0.00",
        shippingChargeAmount: event.data.shippingChargeAmount,
        shippingPlanSnapshot: event.data.shippingPlanSnapshot,
        salesTaxAmount: event.data.salesTaxAmount,
        totalAmount: event.data.totalAmount,
        taxSnapshot: event.data.taxSnapshot,
        commercialTermsSnapshot: event.data.commercialTermsSnapshot,
        authenticityPlanSnapshot: event.data.authenticityPlanSnapshot ?? null,
        shippingDestinationSnapshot: event.data.shippingDestinationSnapshot,
        shippingOriginSnapshot: event.data.shippingOriginSnapshot,
        lines: event.data.lines,
        reservationRequests: event.data.reservationRequests.map((request) => ({
          reservationRequestId: request.reservationRequestId,
          inventoryItemId: request.inventoryItemId,
          sellerAccountId: request.sellerAccountId,
          quantity: request.quantity,
          holdId: request.holdId ?? null,
          status: "pending",
          rejectionReason: null,
          releasedAt: null,
        })),
        status: "pending-reservation",
        cancelledAt: null,
        cancellationReason: null,
        pendingPaymentAt: null,
        paymentDeadlineAt: null,
        paymentDeadlinePolicy: null,
        readyForFulfillmentAt: null,
      };
    case "ordering.order.line-item-amounts-published":
      return state;
    case "ordering.order.reservation-confirmed":
      return {
        ...state,
        reservationRequests: state.reservationRequests.map((request) =>
          request.reservationRequestId === event.data.reservationRequestId
            ? {
                ...request,
                holdId: event.data.holdId,
                status: "confirmed",
              }
            : request,
        ),
      };
    case "ordering.order.reservation-rejected":
      return {
        ...state,
        reservationRequests: state.reservationRequests.map((request) =>
          request.reservationRequestId === event.data.reservationRequestId
            ? {
                ...request,
                status: "rejected",
                rejectionReason: event.data.reason,
              }
            : request,
        ),
      };
    case "ordering.order.pending-payment-recorded":
      return {
        ...state,
        status: "pending-payment",
        pendingPaymentAt: event.data.pendingPaymentAt,
        paymentDeadlineAt: event.data.paymentDeadlineAt,
        paymentDeadlinePolicy: event.data.paymentDeadlinePolicy,
      };
    case "ordering.order.cancelled":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.data.cancelledAt,
        cancellationReason: event.data.reason,
      };
    case "ordering.order.reservation-released":
      return {
        ...state,
        reservationRequests: state.reservationRequests.map((request) =>
          request.reservationRequestId === event.data.reservationRequestId
            ? {
                ...request,
                status: "released",
                releasedAt: event.data.releasedAt,
              }
            : request,
        ),
      };
    case "ordering.order.ready-for-fulfillment-recorded":
      return {
        ...state,
        status: "ready-for-fulfillment",
        readyForFulfillmentAt: event.data.readyForFulfillmentAt,
      };
    default:
      return assertNever(event);
  }
};
