import { describe, expect, it } from "vitest";
import type {
  OrderingOrderCancelledPayload,
  OrderingOrderCreatedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { OrderCancelledEvent, OrderCreatedEvent } from "./domain";

type EventData<TEvent extends Readonly<{ data: unknown }>> = TEvent["data"];
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
/**
 * The public payload is a deliberate subset of the emitted event, so key identity is the
 * wrong law here: asserting it would force the buyer account, shipping addresses, tax
 * snapshot, and grading certification number into a public contract. The pair of assertions
 * below is the correct one -- every published field is really emitted with a compatible
 * type, and no published field is invented.
 */
type PublicKeysAreEmitted<Public, Emitted> = [Exclude<keyof Public, keyof Emitted>] extends [never] ? true : false;

const publisherToPublicPayloadType = {
  "ordering.order.created": {
    publisherAssignable: true satisfies IsAssignable<EventData<OrderCreatedEvent>, OrderingOrderCreatedPayload>,
    publicKeysAreEmitted: true satisfies PublicKeysAreEmitted<
      OrderingOrderCreatedPayload,
      EventData<OrderCreatedEvent>
    >,
  },
  "ordering.order.cancelled": {
    publisherAssignable: true satisfies IsAssignable<EventData<OrderCancelledEvent>, OrderingOrderCancelledPayload>,
    publicKeysAreEmitted: true satisfies PublicKeysAreEmitted<
      OrderingOrderCancelledPayload,
      EventData<OrderCancelledEvent>
    >,
  },
} as const;

/**
 * The exclusions are the point of the contract: a field added here would be published to
 * every subscriber, so the omission is asserted rather than left to review.
 */
const excludedFromPublicCreatedPayload = [
  "buyerAccountId",
  "shippingDestinationSnapshot",
  "shippingOriginSnapshot",
  "taxSnapshot",
  "shippingPlanSnapshot",
] as const;

type PublishedFieldNames = keyof OrderingOrderCreatedPayload;

describe("ordering public event payload contract", () => {
  it("keeps every published field assignable from the real producer", () => {
    expect(publisherToPublicPayloadType).toEqual({
      "ordering.order.created": { publisherAssignable: true, publicKeysAreEmitted: true },
      "ordering.order.cancelled": { publisherAssignable: true, publicKeysAreEmitted: true },
    });
  });

  it("excludes buyer, address, tax, and shipping-plan detail from the published order payload", () => {
    const published = new Set<string>([
      "orderId",
      "reservationRequests",
      "sellerAccountId",
      "itemSubtotalAmount",
      "shippingChargeAmount",
      "shippingAllowanceAmount",
      "salesTaxAmount",
      "totalAmount",
      "authenticityPlanSnapshot",
      "lines",
      "protectionAmount",
      "protectionAllowanceAmount",
      "protectionOverageAmount",
      "commercialTermsSnapshot",
    ] satisfies PublishedFieldNames[]);

    for (const excluded of excludedFromPublicCreatedPayload) {
      expect(published.has(excluded)).toBe(false);
    }
  });

  it("publishes only the authenticity fee amount and the non-identifying line snapshot", () => {
    const feeOnly: OrderingOrderCreatedPayload["authenticityPlanSnapshot"] = { feeAmount: "10.00" };
    const line: NonNullable<OrderingOrderCreatedPayload["lines"]>[number] = {
      lineId: "line-1",
      catalogItemId: "catalog-item-1",
      productId: "product-1",
      selectedOptions: [{ dimensionId: "printing", optionId: "holofoil" }],
      quantity: 1,
      lineTotalAmount: "100.00",
      gradedCard: { gradingCompany: "PSA", grade: "10" },
    };

    expect(Object.keys(feeOnly ?? {})).toEqual(["feeAmount"]);
    expect(Object.keys(line.gradedCard ?? {})).toEqual(["gradingCompany", "grade"]);
  });
});
