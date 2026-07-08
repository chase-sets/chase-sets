import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { createPaymentMcpHandlers } from "./mcp";
import type { PaymentServices } from "./runtime";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_buyer",
  membershipId: "mem_1",
  roleKey: "manager",
  permissions: ["orders.view"],
} satisfies ResolvedActor;

const legacyMcpProtocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function mcpRequest(arguments_: Record<string, unknown>, requestActor: ResolvedActor = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: legacyMcpProtocol,
  };
}

const payment = {
  payment_id: "pay_1",
  buyer_account_id: "acc_buyer",
  order_ids: ["ord_1"],
  status: "partially-refunded",
  processor_status: "succeeded",
  refunded_amount: "5.00",
  refunded_at: "2026-07-08T00:00:00.000Z",
  disputed_at: null,
  failure_code: null,
  failure_message: null,
  order_refund_caps: [{ orderId: "ord_1", amount: "25.00" }],
  order_refunded_amounts: [{ orderId: "ord_1", amount: "5.00" }],
};

function services(): Pick<PaymentServices, "getAccountPayment" | "getPaymentMoneyTimeline"> {
  return {
    getAccountPayment: vi.fn(async (paymentId, accountId) =>
      accountId === "acc_buyer" ? { ...payment, payment_id: paymentId, buyer_account_id: accountId } : null,
    ),
    getPaymentMoneyTimeline: vi.fn(async () => ({
      payment_id: "pay_1",
      account_id: "acc_buyer",
      items: [{ kind: "payment-refunded", amount: "5.00" }],
    })),
  } as unknown as Pick<PaymentServices, "getAccountPayment" | "getPaymentMoneyTimeline">;
}

describe("payment MCP handlers", () => {
  it("reads payment state with refund and dispute status", async () => {
    const fakeServices = services();
    const handlers = createPaymentMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["payments.get-payment"]?.(
      mcpRequest({ accountId: "acc_buyer", paymentId: "pay_1" }),
    );

    expect(result).toMatchObject({
      accountId: "acc_buyer",
      payment: { payment_id: "pay_1", status: "partially-refunded" },
      status: { paymentStatus: "partially-refunded", refundedAmount: "5.00", disputedAt: null },
    });
    expect(fakeServices.getPaymentMoneyTimeline).toHaveBeenCalledWith({ paymentId: "pay_1", accountId: "acc_buyer" });
  });

  it("returns a compact refund status and reads payment resources", async () => {
    const fakeServices = services();
    const handlers = createPaymentMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["payments.get-refund-status"]?.(mcpRequest({ accountId: "acc_buyer", paymentId: "pay_1" })),
    ).resolves.toMatchObject({
      accountId: "acc_buyer",
      paymentId: "pay_1",
      orderRefundedAmounts: [{ orderId: "ord_1", amount: "5.00" }],
    });

    await expect(
      handlers.resourceHandlers["chase-sets://payments/{accountId}/payments/{paymentId}"]?.({
        actor,
        resource: null as never,
        uri: "chase-sets://payments/acc_buyer/payments/pay_1",
        request: new Request("https://api.test/mcp"),
        protocol: legacyMcpProtocol,
      }),
    ).resolves.toMatchObject({ payment: { payment_id: "pay_1" } });
  });
});
