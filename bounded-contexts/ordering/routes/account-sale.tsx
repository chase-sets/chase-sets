import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createOrderingRequestApiClient,
  OrderingApiError,
  type SaleDetail,
} from "../support/request-support/api-client";
import {
  createReputationRequestApiClient,
  type ReviewOpportunity,
} from "@chase-sets/reputation/server";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";
import { OrderReviewOpportunityCallout } from "../features/orders/ui/order-review-opportunity-callout";

const MARKETPLACE_DESCRIPTION =
  "Inspect a sale, cancel it while open, and review the counterpart feedback workflow.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const orderingApi = createOrderingRequestApiClient(request);
  const reputationApi = createReputationRequestApiClient(request);

  try {
    const sale = await orderingApi.getSale(params.orderId!);
    let reviewOpportunity: ReviewOpportunity | null = null;

    if (
      actor.permissions.includes("reputation.view") &&
      actor.permissions.includes("reputation.manage")
    ) {
      try {
        reviewOpportunity = await reputationApi.getOrderReviewOpportunity(params.orderId!);
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) {
          throw error;
        }
      }
    }

    return {
      sale,
      reviewOpportunity,
    };
  } catch (error) {
    if (error instanceof OrderingApiError && error.status === 404) {
      throw new Response("Sale not found.", { status: 404 });
    }

    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "orders.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createOrderingRequestApiClient(request);

  try {
    if (intent === "cancel-sale") {
      await api.cancelSale(params.orderId!);
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
  buildOpenGraphMeta({
    title: "Sale | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountSaleRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const reviewOpportunity = data.reviewOpportunity as ReviewOpportunity | null;

  return (
    <OrderingOrderDetailPage
      role="seller"
      backHref="/account/sales"
      order={data.sale as SaleDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle="Review"
      supplementarySection={
        reviewOpportunity ? (
          <OrderReviewOpportunityCallout
            opportunity={reviewOpportunity}
            reviewHref={`/account/sales/${data.sale.order_id}/review`}
            transactionLabel="sale"
          />
        ) : null
      }
    />
  );
}
