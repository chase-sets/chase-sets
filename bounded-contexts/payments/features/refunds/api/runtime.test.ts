import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION, type StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createRefundRuntime } from "./runtime";

function storedEvent(input: {
  streamId: string;
  streamVersion: number;
  globalPosition: number;
  eventType: string;
  payload: JsonObject;
}): StoredEvent {
  return {
    eventId: `evt_${input.globalPosition}` as never,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    globalPosition: String(input.globalPosition) as GlobalPosition,
    tenantId: "tnt_test" as never,
    eventType: input.eventType,
    payload: input.payload,
    metadata: {},
    occurredAt: "2026-06-01T00:00:00.000Z" as never,
    recordedAt: "2026-06-01T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  };
}

function createEventStore(events: readonly StoredEvent[]): EventStore {
  return {
    appendToStream: vi.fn(async (_input: AppendToStreamInput) => {
      throw new Error("Existing issued refund retry must not append events.");
    }),
    readStream: vi.fn(async (input: ReadStreamInput) =>
      events.filter((event) => event.streamId === input.streamId && event.streamVersion >= (input.fromVersion ?? 1)),
    ),
    readAll: vi.fn(async (_input?: ReadAllInput) => events),
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
    saveCheckpoint: vi.fn(async () => {}),
  };
}

function capturedPaymentRow() {
  return {
    payment_id: "pay_1",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "10.00",
    balance_credit_amount: "0.00",
    processor_amount: "10.00",
    marketplace_sales_fee_amount: "0.00",
    marketplace_checkout_fee_amount: "0.00",
    marketplace_checkout_fee_policy_version: null,
    marketplace_checkout_fee_quote_fingerprint: null,
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "10.00",
    seller_payout_amount: "10.00",
    seller_payouts: [],
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_1",
    processor_client_secret: "pi_1_secret",
    processor_redirect_url: null,
    processor_status: "succeeded",
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "partially-refunded",
    failure_code: null,
    failure_message: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    captured_at: "2026-06-01T00:00:00.000Z",
    failed_at: null,
    cancelled_at: null,
    refunded_at: "2026-06-01T00:01:00.000Z",
    refunded_amount: "10.00",
    disputed_at: null,
  };
}

describe("refund runtime", () => {
  it("returns an existing issued refund retry without creating another provider refund", async () => {
    const streamId = "payments.refund-rfd_retry";
    const events = [
      storedEvent({
        streamId,
        streamVersion: 1,
        globalPosition: 1,
        eventType: "payments.refund-requested",
        payload: {
          refundId: "rfd_retry",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Support sup_1: refund approved",
          processorName: "stripe",
          requestedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      storedEvent({
        streamId,
        streamVersion: 2,
        globalPosition: 2,
        eventType: "payments.refund-issued",
        payload: {
          refundId: "rfd_retry",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Support sup_1: refund approved",
          processorName: "stripe",
          processorRefundReference: "re_retry",
          processorStatus: "succeeded",
          issuedAt: "2026-06-01T00:01:00.000Z",
        },
      }),
    ];
    const createRefund = vi.fn(async () => {
      throw new Error("Existing issued refund retry must not call the processor.");
    });
    const services = createRefundRuntime({
      eventStore: createEventStore(events),
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async () => ({ rows: [capturedPaymentRow()] })),
      } as never,
      processorGateway: {
        createRefund,
      } as never,
    });

    await expect(
      services.issueRefund(
        {
          refundId: "rfd_retry" as never,
          paymentId: "pay_1" as never,
          orderIds: ["ord_1"],
          amount: "10.00",
          reason: "Support sup_1: refund approved",
        },
        {
          tenantId: "tnt_test" as never,
          audit: {
            performedByUserId: "usr_test" as never,
            forAccountId: "acc_buyer" as never,
          },
        },
      ),
    ).resolves.toEqual({ refundId: "rfd_retry", version: 2 });
    expect(createRefund).not.toHaveBeenCalled();
  });
});
