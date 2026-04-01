import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  OrderingOrderListPage,
  type OrderingOrderListItem,
} from "@chase-sets/ordering/web";
import { createMarketplaceOrderingApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_ORDER_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "orders.view");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceOrderingApiClient(request);

  return {
    orders: await api.listSellerOrders(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Sales | Marketplace" });

export default function MarketplaceAccountSalesRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <OrderingOrderListPage
      title="Sales"
      eyebrow="Seller"
      emptyTitle="No sales yet"
      emptyDescription="Accepted offers and buyer checkout create seller-side sales orders."
      orderDetailBasePath="/account/sales"
      orders={(data.orders as ListResponse<OrderingOrderListItem>).items}
    />
  );
}
