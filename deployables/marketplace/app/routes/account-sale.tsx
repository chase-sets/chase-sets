import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  ApiError as OrderingApiError,
  OrderingOrderDetailPage,
  type OrderingOrderDetail,
} from "@chase-sets/ordering/web";
import { createMarketplaceOrderingApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "orders.view");
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const api = createMarketplaceOrderingApiClient(request);

  try {
    return {
      order: await api.getSellerOrder(params.orderId!),
    };
  } catch (error) {
    if (error instanceof OrderingApiError && error.status === 404) {
      throw new Response("Order not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "orders.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceOrderingApiClient(request);

  try {
    if (intent === "cancel-order") {
      await api.cancelSellerOrder(params.orderId!);
      return redirect(`/account/sales/${params.orderId!}`);
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Sale | Marketplace" });

export default function MarketplaceAccountSaleRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <OrderingOrderDetailPage
      role="seller"
      backHref="/account/sales"
      order={data.order as OrderingOrderDetail}
      errorMessage={actionData?.error ?? null}
    />
  );
}
