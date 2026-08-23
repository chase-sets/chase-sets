import { afterEach, describe, expect, it } from "vitest";
import type { CreateProcessorPaymentInput, PaymentProcessorGateway } from "./index";

// vitest-only helper: kept out of ./test-support.ts because that module is
// loaded by production seed/bootstrap code (see
// bounded-contexts/payments/support/runtime-support/seed.ts), which must not
// pull vitest into the production runtime image. Only test files import this.

export type PaymentProcessorGatewayContractOptions = Readonly<{
  createWebhookInput: (
    kind: "payment-captured" | "payment-failed",
  ) => Readonly<{ rawBody: string; signatureHeader: string | null }>;
  prepare?: () => void | Promise<void>;
  assertIdempotency?: () => void;
  cleanup?: () => void;
}>;

/**
 * Behavioral contract shared by the offline fake and provider adapter.
 * Provider-specific webhook encoding stays with each adapter test while the
 * gateway port's status and event-kind vocabulary is asserted once.
 */
export function testPaymentProcessorGatewayContract(
  createGateway: () => PaymentProcessorGateway,
  options: PaymentProcessorGatewayContractOptions,
): void {
  const createPreparedGateway = async () => {
    await options.prepare?.();
    return createGateway();
  };

  describe("payment processor gateway contract", () => {
    afterEach(() => options.cleanup?.());

    it("keeps repeated payment creation idempotent and uses the shared status vocabulary", async () => {
      const gateway = await createPreparedGateway();
      const input: CreateProcessorPaymentInput = {
        paymentId: "pay_gateway_contract" as never,
        buyerAccountId: "acc_gateway_contract" as never,
        orderIds: ["ord_gateway_contract" as never],
        amount: "12.34",
        currencyCode: "usd",
        paymentMethodCategory: "card",
        description: "Gateway contract payment",
        idempotencyKey: "payments:contract:payment",
      };

      const first = await gateway.createPaymentSession(input);
      const retry = await gateway.createPaymentSession(input);

      expect(retry).toEqual(first);
      expect(first).toMatchObject({
        processorName: "stripe",
        processorPaymentKind: "checkout-session",
        processorStatus: expect.stringMatching(/^(open|unpaid)$/),
      });
      options.assertIdempotency?.();
    });

    it.each([
      ["payment-captured" as const, "payment-captured"],
      ["payment-failed" as const, "payment-failed"],
    ])("maps %s into the provider-neutral event kind", async (kind, expectedKind) => {
      const gateway = await createPreparedGateway();

      await expect(gateway.parseWebhook(options.createWebhookInput(kind))).resolves.toMatchObject({
        kind: expectedKind,
        processorStatus: expect.any(String),
      });
    });

    it("payment processor gateway setup-session cancellation contract", async () => {
      const gateway = await createPreparedGateway();

      await expect(gateway.cancelSetupSession("pi_gateway_contract")).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-reference",
        httpStatus: null,
      });

      const reference = "seti_gateway_contract";
      await expect(gateway.cancelSetupSession(reference)).resolves.toEqual({
        outcome: "cancelled",
        processorStatus: "canceled",
      });
      await expect(gateway.cancelSetupSession(reference)).resolves.toEqual({
        outcome: "already-terminal",
        processorStatus: "canceled",
      });
    });
  });
}
