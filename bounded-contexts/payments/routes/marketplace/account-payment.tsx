import { t } from "@chase-sets/localization";
import { preserveFreshWriteMetadata } from "@chase-sets/http/responses";
import type { MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { LinkButton } from "@chase-sets/design-system";
import { requireActorFromAuthApi, resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, defineResourceRoute, type FormActionContext } from "@chase-sets/platform-runtime/http";
import {
  navigateAfterWriteWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "@chase-sets/platform-runtime/post-write-tokens";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createPaymentsRequestApiClient, PaymentsApiError } from "../../support/request-support/api-client";
import type { PaymentsAccountOrderInput } from "../../support/request-support/api-client";
import type {
  AccountPaymentOrderView,
  PaymentElementDefaultValues,
} from "../../features/payments/ui/account-payment/account-payment-contracts";
import { isClaimablePayment } from "../../features/payments/ui/account-payment/account-payment-display";
import { AccountPaymentErrorBoundary } from "../../features/payments/ui/account-payment/account-payment-error-boundary";
import { AccountPaymentPage } from "../../features/payments/ui/account-payment/account-payment-page";
import contextManifest from "../../context.json";
import { paymentsApiErrorAdapter } from "../../support/request-support/route-api-error";

export { AccountPaymentErrorBoundary as ErrorBoundary };

function isAuthOrAuthorizationStatus(error: unknown, status: number) {
  return (
    (error instanceof PaymentsApiError && error.status === status) ||
    (error instanceof Error && "status" in error && error.status === status)
  );
}

function guestPaymentAccessExpiredResponse() {
  return new Response("This guest checkout payment link is invalid or expired.", {
    status: 401,
    statusText: "Guest checkout link expired",
  });
}

function paymentPreparingResponse() {
  return new Response(t("payments.routes.marketplace.accountPayment.payment.preparing.description"), {
    status: 503,
    statusText: t("payments.routes.marketplace.accountPayment.payment.preparing"),
  });
}

function isPaymentNotFound(error: unknown) {
  return (
    (error instanceof PaymentsApiError && error.status === 404) ||
    (error instanceof Error && "status" in error && error.status === 404)
  );
}

function isInternalPaymentSupportActor(
  actor: Readonly<{ roleKey?: string | null; permissions: readonly string[] }> | null | undefined,
) {
  return actor?.roleKey === "platform-admin" && actor.permissions.includes("support.manage");
}

function orderView(order: PaymentsAccountOrderInput): AccountPaymentOrderView {
  return {
    order_id: order.order_id,
    status: order.status,
    total_amount: order.total_amount,
    seller_payout_amount: order.seller_payout_amount,
    payment_deadline_at: order.payment_deadline_at,
  };
}

function resolvePaymentElementDefaultValues(
  orders: readonly PaymentsAccountOrderInput[],
): PaymentElementDefaultValues | null {
  for (const order of orders) {
    const destination = order.shipping_destination_snapshot;
    const email = order.buyer_email?.trim() || destination?.email?.trim();
    if (email) {
      return {
        billingDetails: {
          email,
          ...(destination?.name?.trim() ? { name: destination.name.trim() } : {}),
          ...(destination
            ? {
                address: {
                  line1: destination.line1,
                  ...(destination.line2 ? { line2: destination.line2 } : {}),
                  city: destination.city,
                  state: destination.state,
                  postal_code: destination.postalCode,
                  country: destination.country,
                },
              }
            : {}),
        },
      };
    }
  }

  return null;
}

function needsPaymentElementDefaultValues(
  payment: Readonly<{ status: string; processor_payment_kind?: string | null }>,
) {
  return payment.status === "pending-confirmation";
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-payment",
  prepare: async (args) => {
    const resolvedRequest = await resolvePlatformPostWriteRequest(args.request);
    const url = new URL(resolvedRequest.url);
    const isGuestCheckoutPayment = url.pathname.startsWith("/checkout/payments/");
    if (isGuestCheckoutPayment && url.searchParams.get("claimContinuation")?.trim()) {
      throw redirect(`/checkout/claim/${args.params.paymentId}${url.search}`);
    }
    return { ...args, request: resolvedRequest };
  },
  authorization: async ({ request, params }) => {
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    const actor = isGuestCheckoutPayment
      ? await resolveActorFromAuthApi({ request })
      : await requireActorFromAuthApi({ request, permission: "orders.view" });
    if (isGuestCheckoutPayment && actor && actor.roleKey !== "guest-buyer") {
      throw redirect(`/account/payments/${params.paymentId}`);
    }
    return actor;
  },
  errorAdapter: paymentsApiErrorAdapter,
  load: ({ request, params }) =>
    createPaymentsRequestApiClient(request).getAccountPayment(params.paymentId!, { readProcessorStatus: true }),
  map: async (payment, { request, params, actor }) => {
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    try {
      const paymentsApi = createPaymentsRequestApiClient(request);
      const { orders } = await paymentsApi.listAccountOrderInputs({ orderIds: payment.order_ids });
      return {
        payment,
        orders: orders.map(orderView),
        isGuestCheckoutPayment,
        guestClaimPath: preserveFreshWriteMetadata(`/checkout/claim/${params.paymentId}`, request),
        showSupportDetails: isInternalPaymentSupportActor(actor),
        paymentElementDefaultValues: needsPaymentElementDefaultValues(payment)
          ? resolvePaymentElementDefaultValues(orders)
          : null,
      };
    } catch (error) {
      if (
        isGuestCheckoutPayment &&
        (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
      ) {
        throw guestPaymentAccessExpiredResponse();
      }
      throw error;
    }
  },
  onPending: () => {
    throw paymentPreparingResponse();
  },
  onPermanentFailure: (result, { request }) => {
    const error = "error" in result ? result.error : null;
    const isGuestCheckoutPayment = new URL(request.url).pathname.startsWith("/checkout/payments/");
    if (
      isGuestCheckoutPayment &&
      (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
    ) {
      throw guestPaymentAccessExpiredResponse();
    }
    if (isPaymentNotFound(error)) {
      throw new Response(t("payments.routes.marketplace.accountPayment.payment.not.found"), { status: 404 });
    }
    if (error) throw error;
    throw new Response("Payment handoff is no longer valid.", { status: 410 });
  },
});

async function handleAction(
  intent: string,
  { request, params, formData }: FormActionContext,
): Promise<Response | Readonly<{ scope: "retry"; error: string }> | null> {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/checkout/payments/")) {
    throw new Response("Not found.", { status: 404 });
  }

  const paymentsApi = createPaymentsRequestApiClient(request);

  try {
    const payment = await paymentsApi.getAccountPayment(params.paymentId!);
    if (intent === "retry-payment") {
      if (payment.status !== "failed" && payment.status !== "cancelled") {
        return {
          scope: "retry",
          error: t("payments.routes.marketplace.accountPayment.this.payment.cannot.be.retried"),
        };
      }

      const requestedBalanceCreditAmount = payment.balance_credit_amount;
      const paymentMethodCategory = payment.payment_method_category ?? "card";
      const checkoutStatus = await paymentsApi.getCheckoutStatus({
        orderIds: payment.order_ids,
        currencyCode: payment.currency_code,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
      });
      const retryPayment = await paymentsApi.recoverCheckoutPayment({
        orderIds: payment.order_ids,
        currencyCode: payment.currency_code,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
        marketplaceCheckoutFeeQuoteFingerprint: checkoutStatus.marketplace_checkout_fee.quote_fingerprint,
        returnUrlPath: "/checkout/payments/:paymentId",
      });
      return redirect(
        await navigateAfterWriteWithPlatformPostWriteToken(
          retryPayment,
          `/checkout/payments/${retryPayment.payment_id}`,
        ),
      );
    }

    return null;
  } catch (error) {
    if (
      intent === "retry-payment" &&
      (isAuthOrAuthorizationStatus(error, 401) || isAuthOrAuthorizationStatus(error, 403))
    ) {
      throw guestPaymentAccessExpiredResponse();
    }

    return {
      scope: "retry",
      error:
        error instanceof Error
          ? error.message
          : t("payments.routes.marketplace.accountPayment.could.not.retry.this.payment"),
    };
  }
}

export const action = defineFormAction({
  intents: {
    "retry-payment": (context) => handleAction("retry-payment", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({ title: t("payments.routes.marketplace.accountPayment.payment.marketplace") });

export default function MarketplaceAccountPaymentRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const retryActionError =
    actionData && "error" in actionData && actionData.scope === "retry" ? actionData.error : null;
  // Payments cannot tell whether Auth can claim this order, so the link promises nothing; the claim
  // page says what is possible.
  const guestClaimSection =
    data.isGuestCheckoutPayment && isClaimablePayment(data.payment) ? (
      <LinkButton href={data.guestClaimPath}>
        {t("payments.routes.marketplace.accountPayment.account.options")}
      </LinkButton>
    ) : null;
  return (
    <AccountPaymentPage
      payment={data.payment}
      orders={data.orders}
      isGuestCheckoutPayment={data.isGuestCheckoutPayment}
      showSupportDetails={data.showSupportDetails}
      paymentElementDefaultValues={data.paymentElementDefaultValues}
      retryActionError={retryActionError}
      guestClaimSection={guestClaimSection}
    />
  );
}
