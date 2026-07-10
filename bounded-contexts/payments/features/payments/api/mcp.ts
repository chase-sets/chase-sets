import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import {
  ensureMcpActorAccount,
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PaymentServices } from "./runtime";

export type PaymentMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

/**
 * Permission that gates the stored-payment-method rail. Card setup exists only to make
 * in-chat checkout completion possible, so it shares the `checkout:write` scope's permission
 * rather than introducing a parallel one.
 */
const PAYMENT_METHOD_SETUP_PERMISSION = "orders.manage";

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

/**
 * Parse an agent-supplied return URL, enforcing the HTTPS-only boundary. A payment-method setup
 * hop must never bounce the buyer through a plaintext origin.
 */
function readHttpsUrl(args: Readonly<Record<string, unknown>>, key: string) {
  const value = readRequiredString(args, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${key} must be an absolute HTTPS URL.`);
  }

  return url;
}

/**
 * Guarantee the processor handed back a hosted setup page (not an embedded client secret) and that
 * the page is HTTPS. This keeps the rail hosted-only: a card number never transits chat, and a
 * client secret never leaves the server.
 */
function requireHostedSetupUrl(redirectUrl: string | null) {
  if (!redirectUrl) {
    throw new Error("A hosted payment-method setup URL is not available for this account.");
  }
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new Error("A hosted payment-method setup URL is not available for this account.");
  }
  if (url.protocol !== "https:") {
    throw new Error("A hosted payment-method setup URL is not available for this account.");
  }

  return url.toString();
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
  services: Pick<
    PaymentServices,
    | "getAccountPayment"
    | "getPaymentMoneyTimeline"
    | "createSavedCheckoutSetupSession"
    | "reconcileSavedCheckoutSetupSession"
  >,
): PaymentMcpHandlers {
  const startPaymentMethodSetup: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, PAYMENT_METHOD_SETUP_PERMISSION);
    const returnUrl = readHttpsUrl(args, "returnUrl");
    const session = await services.createSavedCheckoutSetupSession({
      accountId: scopedActor.accountId as AccountId,
      returnUrlBase: `${returnUrl.protocol}//${returnUrl.host}`,
      returnUrlPath: `${returnUrl.pathname}${returnUrl.search}`,
      agentGrantId: scopedActor.agentGrant?.grantId ?? null,
    });

    // Return only the hosted page URL. The processor client secret stays server-side and is never
    // echoed into a tool result or audit log.
    return {
      accountId: scopedActor.accountId,
      id: session.setup_reference_id,
      setupReferenceId: session.setup_reference_id,
      status: session.processor_status,
      url: requireHostedSetupUrl(session.processor_redirect_url),
      consentText: session.consent_text,
    };
  };

  const confirmPaymentMethodSetup: McpToolHandler = async ({ actor, arguments: args }) => {
    const scopedActor = ensureMcpActorAccount(actor, readRequiredString(args, "accountId"));
    requirePermission(scopedActor, PAYMENT_METHOD_SETUP_PERMISSION);
    // Idempotent provider-state reconcile: safe to poll until the buyer finishes the hosted hop.
    const instrument = await services.reconcileSavedCheckoutSetupSession(
      {
        accountId: scopedActor.accountId as AccountId,
        setupReference: readRequiredString(args, "setupReferenceId"),
      },
      createActorEventStoreContext(scopedActor),
    );

    if (!instrument) {
      return {
        accountId: scopedActor.accountId,
        setupReferenceId: readRequiredString(args, "setupReferenceId"),
        attached: false,
        status: "pending",
        paymentMethod: null,
      };
    }

    // Expose only display-safe facts. The provider payment-method reference and fingerprint are
    // never returned — a PM reference must not appear in tool results unredacted.
    return {
      accountId: scopedActor.accountId,
      setupReferenceId: readRequiredString(args, "setupReferenceId"),
      attached: instrument.readiness === "ready",
      status: instrument.readiness === "ready" ? "attached" : "pending",
      paymentMethod: {
        instrumentId: instrument.instrument_id,
        displayLabel: instrument.display_label,
        paymentMethodCategory: instrument.payment_method_category,
        isDefault: instrument.is_default,
        readiness: instrument.readiness,
      },
    };
  };

  const getPayment: McpToolHandler = ({ actor, arguments: args }) =>
    readPayment(
      services,
      readRequiredString(args, "accountId"),
      readMcpTypedIdArgument(args, "paymentId", "pay"),
      actor,
    );

  const getRefundStatus: McpToolHandler = async ({ actor, arguments: args }) => {
    const result = await readPayment(
      services,
      readRequiredString(args, "accountId"),
      readMcpTypedIdArgument(args, "paymentId", "pay"),
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
      "payments.start-payment-method-setup": startPaymentMethodSetup,
      "payments.confirm-payment-method-setup": confirmPaymentMethodSetup,
      "payments.get-payment": getPayment,
      "payments.get-refund-status": getRefundStatus,
    },
    resourceHandlers: {
      "chase-sets://payments/{accountId}/payments/{paymentId}": readPaymentResource,
    },
  };
}
