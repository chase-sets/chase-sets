import { t } from "@chase-sets/localization";
import type { MetaFunction } from "react-router";
import { useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createReputationRequestApiClient,
  ReputationApiError,
  type ReviewOpportunity,
} from "@chase-sets/marketplace/server";
import { createOrderingRequestApiClient, type SaleDetail } from "../support/request-support/api-client";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";
import { OrderOutcomePanel } from "../features/orders/ui/order-review-opportunity-callout";
import contextManifest from "../context.json";
import { orderingApiErrorAdapter } from "../support/request-support/route-api-error";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountSale.inspect.a.sale.cancel.it.while");

async function loadMarketplaceReviewOutcome(request: Request, orderId: string) {
  try {
    const api = createReputationRequestApiClient(request);
    const opportunity = await api.getOrderReviewOpportunity(orderId);
    let response: string | null = null;
    let revealed: boolean | undefined;
    let scoringDisposition: "included" | "context-only" | null | undefined;
    if (opportunity.active_review_id) {
      try {
        const review = await api.getAccountReview(opportunity.active_review_id);
        response = review.reply_status === "active" ? review.reply_feedback : null;
        revealed = review.revealed_at !== null;
        scoringDisposition = review.scoring_disposition;
      } catch {
        // The opportunity remains useful when its supplementary review read lags or fails.
      }
    }
    return {
      status: "ready" as const,
      opportunity: { ...opportunity, response, revealed, scoring_disposition: scoringDisposition },
    };
  } catch (error) {
    if (error instanceof ReputationApiError && error.status === 404) {
      return { status: "ready" as const, opportunity: null };
    }
    return { status: "unavailable" as const, opportunity: null };
  }
}

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-sale",
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "orders.view" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("ordering.routes.accountSale.forbidden"), { status: 403 });
    }
    return actor;
  },
  errorAdapter: orderingApiErrorAdapter,
  load: async ({ request, params }) => {
    const sale = await createOrderingRequestApiClient(request).getSale(params.orderId!);
    return {
      sale,
      reviewOutcome: await loadMarketplaceReviewOutcome(request, sale.order_id),
    };
  },
  map: (result) => result,
  messages: {
    pending: "We are preparing your sale. Refresh in a moment and it should appear.",
    pendingStatusText: "Preparing sale",
    unverified: "Sale handoff is no longer valid.",
    notFound: t("ordering.routes.accountSale.sale.not.found"),
  },
});

export const action = defineFormAction({
  authorization: { permission: "orders.manage" },
  intents: {
    "cancel-sale": async ({ request, params }) =>
      formActionRedirect(
        await createOrderingRequestApiClient(request).cancelSale(params.orderId!),
        `/account/sales/${params.orderId!}`,
      ),
  },
  onUnknownIntent: () => null,
  onError: (error) => ({
    error: error instanceof Error ? error.message : t("ordering.routes.accountSale.request.failed"),
  }),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountSale.sale.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountSaleRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <OrderingOrderDetailPage
      role="seller"
      backHref="/account/sales"
      supportHref={`/account/support?orderId=${encodeURIComponent(data.sale.order_id)}&flow=seller-cannot-fulfill`}
      fulfillmentHref="/account/sales/shipments"
      order={data.sale as SaleDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle={t("ordering.routes.accountSale.order.outcome")}
      supplementarySection={
        <OrderOutcomePanel
          orderStatus={data.sale.status}
          opportunity={data.reviewOutcome.opportunity as ReviewOpportunity | null}
          reviewReadStatus={data.reviewOutcome.status}
          reviewHref={`/account/sales/${data.sale.order_id}/review`}
          supportHref={`/account/support?orderId=${encodeURIComponent(data.sale.order_id)}&role=seller`}
          transactionLabel="sale"
        />
      }
    />
  );
}
