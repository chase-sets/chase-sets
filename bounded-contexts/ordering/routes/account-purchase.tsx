import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { loadAfterWrite, navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createOrderingRequestApiClient,
  OrderingApiError,
  type PurchaseDetail,
} from "../support/request-support/api-client";
import { createReputationRequestApiClient, type ReviewOpportunity } from "@chase-sets/marketplace/server";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";
import { OrderReviewOpportunityCallout } from "../features/orders/ui/order-review-opportunity-callout";

const MARKETPLACE_DESCRIPTION = t("ordering.routes.accountPurchase.inspect.a.purchase.cancel.it.while");

function purchasePreparingResponse() {
  return new Response("We are preparing your purchase. Refresh in a moment and it should appear.", {
    status: 503,
    statusText: "Preparing purchase",
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  const orderingApi = createOrderingRequestApiClient(request);
  const reputationApi = createReputationRequestApiClient(request);

  try {
    const purchaseRead = await loadAfterWrite({
      request,
      load: () => orderingApi.getPurchase(params.purchaseId!),
      isNotFound: (error) => error instanceof OrderingApiError && error.status === 404,
    });
    if (purchaseRead.kind === "pending") {
      throw purchasePreparingResponse();
    }
    if (purchaseRead.kind === "permanent-failure") {
      throw "error" in purchaseRead
        ? purchaseRead.error
        : new Response("Purchase handoff is no longer valid.", { status: 410 });
    }

    const purchase = purchaseRead.data;
    let reviewOpportunity: ReviewOpportunity | null = null;

    if (actor.permissions.includes("reputation.view") && actor.permissions.includes("reputation.manage")) {
      try {
        reviewOpportunity = await reputationApi.getOrderReviewOpportunity(params.purchaseId!);
      } catch (error) {
        if (!(error instanceof Error && "status" in error && error.status === 404)) {
          throw error;
        }
      }
    }

    return {
      purchase,
      reviewOpportunity,
    };
  } catch (error) {
    if (error instanceof OrderingApiError && error.status === 404) {
      throw new Response(t("ordering.routes.accountPurchase.purchase.not.found"), { status: 404 });
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
    if (intent === "cancel-purchase") {
      const result = await api.cancelPurchase(params.purchaseId!);
      return redirect(navigateAfterWrite(result, `/account/purchases/${params.purchaseId!}`));
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : t("ordering.routes.accountPurchase.request.failed"),
    };
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("ordering.routes.accountPurchase.purchase.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountPurchaseRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const reviewOpportunity = data.reviewOpportunity as ReviewOpportunity | null;

  return (
    <OrderingOrderDetailPage
      role="buyer"
      backHref="/account/purchases"
      paymentHref={
        data.purchase.status === "pending-payment"
          ? `/account/payments/new?orderIds=${encodeURIComponent(data.purchase.order_id)}`
          : null
      }
      supportHref={`/account/support?orderId=${encodeURIComponent(data.purchase.order_id)}&role=buyer`}
      fulfillmentHref="/account/shipments"
      order={data.purchase as PurchaseDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle={t("ordering.routes.accountPurchase.review")}
      supplementarySection={
        reviewOpportunity ? (
          <OrderReviewOpportunityCallout
            opportunity={reviewOpportunity}
            reviewHref={`/account/purchases/${data.purchase.order_id}/review`}
            transactionLabel="purchase"
          />
        ) : null
      }
    />
  );
}
