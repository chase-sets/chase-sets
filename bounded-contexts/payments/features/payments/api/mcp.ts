import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { PaymentServices } from "./runtime";

export type PaymentMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function readRequiredString(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readMcpStringArgument(args, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }

  return value;
}

function requirePermission(actor: Readonly<{ permissions: readonly string[] }>, permission: string) {
  if (!actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
}

function paymentUriParts(uri: string): Readonly<{ accountId: string; paymentId: string }> | null {
  const match = /^chase-sets:\/\/payments\/([^/]+)\/payments\/([^/]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    accountId: decodeURIComponent(match[1] ?? ""),
    paymentId: decodeURIComponent(match[2] ?? ""),
  };
}

async function readPayment(
  services: Pick<PaymentServices, "getAccountPayment" | "getPaymentMoneyTimeline">,
  accountId: string,
  paymentId: string,
  actor: Parameters<typeof ensureMcpActorAccount>[0],
) {
  const scopedActor = ensureMcpActorAccount(actor, accountId);
  requirePermission(scopedActor, "orders.view");
  const payment = await services.getAccountPayment(paymentId, scopedActor.accountId);
  if (!payment) {
    throw new Error("Payment not found.");
  }
  const timeline = await services.getPaymentMoneyTimeline({ paymentId, accountId: scopedActor.accountId });

  return {
    accountId: scopedActor.accountId,
    payment,
    moneyTimeline: timeline,
    status: {
      paymentStatus: payment.status,
      processorStatus: payment.processor_status,
      refundedAmount: payment.refunded_amount,
      refundedAt: payment.refunded_at,
      disputedAt: payment.disputed_at,
      failureCode: payment.failure_code,
      failureMessage: payment.failure_message,
    },
  };
}

export function createPaymentMcpHandlers(
  services: Pick<PaymentServices, "getAccountPayment" | "getPaymentMoneyTimeline">,
): PaymentMcpHandlers {
  const getPayment: McpToolHandler = ({ actor, arguments: args }) =>
    readPayment(services, readRequiredString(args, "accountId"), readRequiredString(args, "paymentId"), actor);

  const getRefundStatus: McpToolHandler = async ({ actor, arguments: args }) => {
    const result = await readPayment(
      services,
      readRequiredString(args, "accountId"),
      readRequiredString(args, "paymentId"),
      actor,
    );

    return {
      accountId: result.accountId,
      paymentId: result.payment.payment_id,
      orderIds: result.payment.order_ids,
      status: result.status,
      orderRefundCaps: result.payment.order_refund_caps,
      orderRefundedAmounts: result.payment.order_refunded_amounts,
      moneyTimeline: result.moneyTimeline,
    };
  };

  const readPaymentResource: McpResourceHandler = ({ actor, uri }) => {
    const parts = paymentUriParts(uri);
    if (!parts) {
      throw new Error("Unsupported payments payment resource URI.");
    }

    return readPayment(services, parts.accountId, parts.paymentId, actor);
  };

  return {
    toolHandlers: {
      "payments.get-payment": getPayment,
      "payments.get-refund-status": getRefundStatus,
    },
    resourceHandlers: {
      "chase-sets://payments/{accountId}/payments/{paymentId}": readPaymentResource,
    },
  };
}
