import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  type PurchaseListItem,
} from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";
import { OrderingOrderListPage } from "../features/orders/ui/order-list-page";

const DEFAULT_ORDER_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Track purchases and drill into each purchase's shipping state.";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.view" });
  const api = createOrderingRequestApiClient(request);

  return {
    purchases: await api.listPurchases(DEFAULT_ORDER_QUERY),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Purchases | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountPurchasesRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <OrderingOrderListPage
      title="Purchases"
      eyebrow="Buyer"
      emptyTitle="No purchases yet"
      emptyDescription="Your checkout activity and accepted offers will appear here."
      orderDetailBasePath="/account/purchases"
      orders={(data.purchases as ListResponse<PurchaseListItem>).items}
    />
  );
}
