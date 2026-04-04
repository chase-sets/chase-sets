import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import { createOrderingRequestApiClient } from "../client";
import {
  OrderingOrderListPage,
  type OrderingOrderListItem,
} from "../web";

const DEFAULT_ORDER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Review seller-side sales orders created by checkout and accepted offers.";

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createOrderingRequestApiClient(request);

  return {
    orders: await api.listSellerOrders(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Sales | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountSalesRoute() {
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
