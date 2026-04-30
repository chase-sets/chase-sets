import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPaymentRuntime } from "./runtime";

function createUnusedEventStore(): EventStore {
  return {
    appendToStream: vi.fn(async () => {
      throw new Error("Payment creation should be idempotent.");
    }),
    readStream: vi.fn(async () => []),
    readAll: vi.fn(async () => []),
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
    saveCheckpoint: vi.fn(async (_projectorName: string, _checkpoint: GlobalPosition) => {}),
  };
}

function existingPaymentRow() {
  return {
    payment_id: "pay_existing",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "24.99",
    marketplace_fee_amount: "1.00",
    payment_fee_amount: "0.50",
    seller_net_amount: "23.49",
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_reference: "pi_existing",
    processor_client_secret: "pi_existing_secret",
    processor_status: "requires_payment_method",
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
  };
}

describe("payment runtime", () => {
  it("reuses checkout-sourced payments by checkout session id", async () => {
    const processorGateway = {
      getPublicConfiguration: vi.fn(() => ({
        processorName: "stripe" as const,
        publishableKey: "pk_test_123",
      })),
      createPaymentIntent: vi.fn(async () => {
        throw new Error("Processor payment should not be recreated.");
      }),
      createRefund: vi.fn(async () => {
        throw new Error("Refunds are not part of this test.");
      }),
      parseWebhook: vi.fn(async () => null),
    };
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("source_context = $1");
        expect(params).toEqual(["checkout", "chk_1", "acc_buyer"]);
        return { rows: [existingPaymentRow()] };
      }),
    };
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.createBuyerPayment(
      {
        buyerAccountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      {
        tenantId: "tnt_identity" as never,
        audit: {
          performedByUserId: "usr_1" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    );

    expect(result).toMatchObject({
      payment_id: "pay_existing",
      source_context: "checkout",
      source_reference_id: "chk_1",
      processor_publishable_key: "pk_test_123",
    });
    expect(processorGateway.createPaymentIntent).not.toHaveBeenCalled();
  });
});
