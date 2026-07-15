import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction, defineResourceRoute, formActionRedirect } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createOrderingRequestApiClient,
  OrderingApiError,
  type SaleDetail,
} from "../support/request-support/api-client";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";
import contextManifest from "../context.json";
import { orderingApiErrorAdapter } from "../support/request-support/route-api-error";
import {
  OrderReviewOpportunityCallout,
  type OrderReviewOpportunity,
} from "../features/orders/ui/order-review-opportunity-callout";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountSale.inspect.a.sale.cancel.it.while");

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
  load: ({ request, params }) => createOrderingRequestApiClient(request).getSale(params.orderId!),
  map: (sale) => ({ sale, reviewOpportunity: sale.reviewOpportunity ?? null }),
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
  const reviewOpportunity = data.reviewOpportunity as OrderReviewOpportunity | null;

  return (
    <OrderingOrderDetailPage
      role="seller"
      backHref="/account/sales"
      supportHref={`/account/support?orderId=${encodeURIComponent(data.sale.order_id)}&flow=seller-cannot-fulfill`}
      fulfillmentHref="/account/sales/shipments"
      order={data.sale as SaleDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle={t("ordering.routes.accountSale.review")}
      supplementarySection={
        reviewOpportunity ? (
          <OrderReviewOpportunityCallout
            opportunity={reviewOpportunity}
            reviewHref={`/account/sales/${data.sale.order_id}/review`}
            transactionLabel="sale"
          />
        ) : null
      }
    />
  );
}
