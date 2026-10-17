import { describe, expect, it } from "vitest";
import type {
  PaymentRefundFailedPayload,
  PaymentRefundIssuedPayload,
  PaymentRefundRequestedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { RefundFailedEvent, RefundIssuedEvent, RefundRequestedEvent } from "./domain";

type EventData<TEvent extends Readonly<{ data: unknown }>> = TEvent["data"];
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type HasSameKeys<Left, Right> = [Exclude<keyof Left, keyof Right>, Exclude<keyof Right, keyof Left>] extends [
  never,
  never,
]
  ? true
  : false;

const publisherToPublicPayloadType = {
  "payments.refund-requested": {
    publisherAssignable: true satisfies IsAssignable<EventData<RefundRequestedEvent>, PaymentRefundRequestedPayload>,
    sameKeys: true satisfies HasSameKeys<EventData<RefundRequestedEvent>, PaymentRefundRequestedPayload>,
  },
  "payments.refund-issued": {
    publisherAssignable: true satisfies IsAssignable<EventData<RefundIssuedEvent>, PaymentRefundIssuedPayload>,
    sameKeys: true satisfies HasSameKeys<EventData<RefundIssuedEvent>, PaymentRefundIssuedPayload>,
  },
  "payments.refund-failed": {
    publisherAssignable: true satisfies IsAssignable<EventData<RefundFailedEvent>, PaymentRefundFailedPayload>,
    sameKeys: true satisfies HasSameKeys<EventData<RefundFailedEvent>, PaymentRefundFailedPayload>,
  },
} as const;

describe("refund public event payload contract", () => {
  it("keeps every covered publisher shape assignable with the same field names", () => {
    expect(Object.values(publisherToPublicPayloadType).every((mapping) => mapping.publisherAssignable)).toBe(true);
    expect(Object.values(publisherToPublicPayloadType).every((mapping) => mapping.sameKeys)).toBe(true);
  });
});
