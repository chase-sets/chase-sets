import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  type OrderingOrderListItem,
} from "../request-support/api-client";
import { createOrderingRequestApiClient } from "../request-support/api-client";
import { OrderingOrderListPage } from "../orders/ui/order-list-page";

const DEFAULT_ORDER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Track buyer-side orders and drill into each order's fulfillment state.";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.view" });
  const api = createOrderingRequestApiClient(request);

  return {
    orders: await api.listBuyerOrders(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Orders | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountOrdersRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <OrderingOrderListPage
      title="Orders"
      eyebrow="Buyer"
      emptyTitle="No orders yet"
      emptyDescription="Your checkout activity and accepted seller offers will appear here."
      orderDetailBasePath="/account/orders"
      orders={(data.orders as ListResponse<OrderingOrderListItem>).items}
    />
  );
}
