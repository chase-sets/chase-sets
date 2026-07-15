import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineResourceRoute } from "@chase-sets/platform-runtime/http";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { type SaleListItem } from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";
import { OrderingOrderListPage } from "../features/orders/ui/order-list-page";
import { orderListPageQuery } from "../support/request-support/list-pagination";
import contextManifest from "../context.json";
import { orderingApiErrorAdapter } from "../support/request-support/route-api-error";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountSales.review.sales.created.by.checkout.and");

export const loader = defineResourceRoute({
  manifest: contextManifest,
  routeId: "account-sales",
  prepare: async (args) => ({ ...args, request: await resolvePlatformPostWriteRequest(args.request) }),
  authorization: async ({ request }) => {
    const actor = await requireActorFromAuthApi({ request, permission: "orders.view" });
    if (!actor.permissions.includes("listings.view")) {
      throw new Response(t("ordering.routes.accountSales.forbidden"), { status: 403 });
    }
    return actor;
  },
  errorAdapter: orderingApiErrorAdapter,
  load: ({ request }) => createOrderingRequestApiClient(request).listSales(orderListPageQuery(request)),
  map: (sales) => ({ sales }),
  messages: {
    pending: "We are preparing your sales. Refresh in a moment and they should appear.",
    pendingStatusText: "Preparing sales",
    unverified: "Sales handoff is no longer valid.",
  },
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountSales.sales.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountSalesRoute() {
  const data = useLoaderData<typeof loader>();
  const sales = data.sales as ListResponse<SaleListItem> & {
    limit: number;
    offset: number;
    summary: { total_quantity: number; pending_count: number };
  };

  return (
    <OrderingOrderListPage
      title={t("ordering.routes.accountSales.sales")}
      eyebrow={t("ordering.routes.accountSales.seller")}
      emptyTitle={t("ordering.routes.accountSales.no.sales.yet")}
      emptyDescription={t("ordering.routes.accountSales.accepted.offers.and.checkout.activity.create")}
      orderDetailBasePath="/account/sales"
      kind="sale"
      orders={sales.items}
      total={sales.total}
      summary={sales.summary}
      pagination={{ limit: sales.limit, offset: sales.offset, total: sales.total }}
    />
  );
}
