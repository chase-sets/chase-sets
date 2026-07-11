import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { loadAfterWrite } from "@chase-sets/platform-runtime/http";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import { type SaleListItem } from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";
import { OrderingOrderListPage } from "../features/orders/ui/order-list-page";
import { orderListPageQuery } from "../support/request-support/list-pagination";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountSales.review.sales.created.by.checkout.and");

function salesPreparingResponse() {
  return new Response("We are preparing your sales. Refresh in a moment and they should appear.", {
    status: 503,
    statusText: "Preparing sales",
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  const actor = await requireActorFromAuthApi({
    request: resolvedRequest,
    permission: "orders.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("ordering.routes.accountSales.forbidden"), { status: 403 });
  }

  const api = createOrderingRequestApiClient(resolvedRequest);
  const salesRead = await loadAfterWrite({
    request: resolvedRequest,
    load: () => api.listSales(orderListPageQuery(resolvedRequest)),
    isNotFound: () => false,
  });
  if (salesRead.kind === "pending") {
    throw salesPreparingResponse();
  }
  if (salesRead.kind === "permanent-failure") {
    throw "error" in salesRead ? salesRead.error : new Response("Sales handoff is no longer valid.", { status: 410 });
  }

  return {
    sales: salesRead.data,
  };
}

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
