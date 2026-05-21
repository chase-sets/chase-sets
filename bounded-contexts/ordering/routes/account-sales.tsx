import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type SaleListItem } from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";
import { OrderingOrderListPage } from "../features/orders/ui/order-list-page";

const DEFAULT_ORDER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountSales.review.sales.created.by.checkout.and");

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response(t("ordering.routes.accountSales.forbidden"), { status: 403 });
  }

  const api = createOrderingRequestApiClient(request);

  return {
    sales: await api.listSales(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountSales.sales.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountSalesRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <OrderingOrderListPage
      title={t("ordering.routes.accountSales.sales")}
      eyebrow={t("ordering.routes.accountSales.seller")}
      emptyTitle={t("ordering.routes.accountSales.no.sales.yet")}
      emptyDescription={t("ordering.routes.accountSales.accepted.offers.and.checkout.activity.create")}
      orderDetailBasePath="/account/sales"
      orders={(data.sales as ListResponse<SaleListItem>).items}
    />
  );
}
