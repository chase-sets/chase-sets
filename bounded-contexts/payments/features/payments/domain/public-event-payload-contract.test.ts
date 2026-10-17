import { describe, expect, it } from "vitest";
import type { PaymentRefundedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { PaymentRefundedEvent } from "./domain";

type EventData<TEvent extends Readonly<{ data: unknown }>> = TEvent["data"];
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type HasSameKeys<Left, Right> = [Exclude<keyof Left, keyof Right>, Exclude<keyof Right, keyof Left>] extends [
  never,
  never,
]
  ? true
  : false;

const publisherToPublicPayloadType = {
  "payments.payment-refunded": {
    publisherAssignable: true satisfies IsAssignable<EventData<PaymentRefundedEvent>, PaymentRefundedPayload>,
    sameKeys: true satisfies HasSameKeys<EventData<PaymentRefundedEvent>, PaymentRefundedPayload>,
  },
} as const;

describe("payment-refunded public event payload contract", () => {
  it("keeps the publisher shape assignable with the same field names", () => {
    expect(publisherToPublicPayloadType["payments.payment-refunded"]).toEqual({
      publisherAssignable: true,
      sameKeys: true,
    });
  });
});
