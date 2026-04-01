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
  await requireMarketplaceActor(request, "orders.view");
  const api = createMarketplaceOrderingApiClient(request);

  return {
    orders: await api.listBuyerOrders(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Orders | Marketplace" });

export default function MarketplaceAccountOrdersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <OrderingOrderListPage
      title="Orders"
      eyebrow="Buyer"
      emptyTitle="No orders yet"
      emptyDescription="Checkout creates buyer orders once live marketplace supply is committed."
      orderDetailBasePath="/account/orders"
      orders={(data.orders as ListResponse<OrderingOrderListItem>).items}
    />
  );
}
