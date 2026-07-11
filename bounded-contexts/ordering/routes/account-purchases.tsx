import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { type PurchaseListItem } from "../support/request-support/api-client";
import { createOrderingRequestApiClient } from "../support/request-support/api-client";
import { OrderingOrderListPage } from "../features/orders/ui/order-list-page";
import { orderListPageQuery } from "../support/request-support/list-pagination";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountPurchases.track.purchases.and.drill.into.each");

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.view" });
  const api = createOrderingRequestApiClient(request);

  return {
    purchases: await api.listPurchases(orderListPageQuery(request)),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountPurchases.purchases.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountPurchasesRoute() {
  const data = useLoaderData<typeof loader>();
  const purchases = data.purchases as ListResponse<PurchaseListItem> & {
    limit: number;
    offset: number;
    summary: { total_quantity: number; pending_count: number };
  };

  return (
    <OrderingOrderListPage
      title={t("ordering.routes.accountPurchases.purchases")}
      eyebrow={t("ordering.routes.accountPurchases.buyer")}
      emptyTitle={t("ordering.routes.accountPurchases.no.purchases.yet")}
      emptyDescription={t("ordering.routes.accountPurchases.your.checkout.activity.and.accepted.offers")}
      orderDetailBasePath="/account/purchases"
      orders={purchases.items}
      total={purchases.total}
      summary={purchases.summary}
      pagination={{ limit: purchases.limit, offset: purchases.offset, total: purchases.total }}
    />
  );
}
