import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { createOrderingRequestApiClient, type PurchaseDetail } from "../support/request-support/api-client";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";
import { OrderOutcomePanel, type OrderReviewOpportunity } from "../features/orders/ui/order-review-opportunity-callout";
import contextManifest from "../context.json";
import { orderingApiErrorAdapter } from "../support/request-support/route-api-error";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountPurchase.inspect.a.purchase.cancel.it.while");

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-purchase",
  authorization: { permission: "orders.view" },
  errorAdapter: orderingApiErrorAdapter,
  load: ({ request, params }) => createOrderingRequestApiClient(request).getPurchase(params.purchaseId!),
  map: (purchase) => ({
    purchase,
    reviewOutcome: {
      status: "ready" as const,
      opportunity: purchase.reviewOpportunity ?? null,
    },
  }),
  messages: {
    pending: "We are preparing your purchase. Refresh in a moment and it should appear.",
    pendingStatusText: "Preparing purchase",
    unverified: "Purchase handoff is no longer valid.",
    notFound: t("ordering.routes.accountPurchase.purchase.not.found"),
  },
});

export const action = defineFormAction({
  authorization: { permission: "orders.manage" },
  intents: {
    "cancel-purchase": async ({ request, params }) =>
      formActionRedirect(
        await createOrderingRequestApiClient(request).cancelPurchase(params.purchaseId!),
        `/account/purchases/${params.purchaseId!}`,
      ),
  },
  onUnknownIntent: () => null,
  onError: (error) => ({
    error: error instanceof Error ? error.message : t("ordering.routes.accountPurchase.request.failed"),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountPurchase.purchase.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountPurchaseRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <OrderingOrderDetailPage
      role="buyer"
      backHref="/account/purchases"
      paymentHref={
        data.purchase.status === "pending-payment"
          ? `/account/payments/new?orderIds=${encodeURIComponent(data.purchase.order_id)}`
          : null
      }
      supportHref={`/account/support?orderId=${encodeURIComponent(data.purchase.order_id)}${
        data.purchase.cancellation_unavailable_reason === "fulfillment-started" ? "&flow=buyer-cancel-request" : ""
      }`}
      fulfillmentHref="/account/shipments"
      order={data.purchase as PurchaseDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle={t("ordering.routes.accountPurchase.order.outcome")}
      supplementarySection={
        <OrderOutcomePanel
          orderStatus={data.purchase.status}
          opportunity={data.reviewOutcome.opportunity as OrderReviewOpportunity | null}
          reviewReadStatus={data.reviewOutcome.status}
          reviewHref={`/account/purchases/${data.purchase.order_id}/review`}
          supportHref={`/account/support?orderId=${encodeURIComponent(data.purchase.order_id)}&role=buyer`}
          transactionLabel="purchase"
        />
      }
    />
  );
}
