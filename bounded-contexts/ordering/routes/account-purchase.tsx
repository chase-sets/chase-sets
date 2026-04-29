import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { Card, LinkButton, Stack, Text } from "@chase-sets/design-system";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import {
  createOrderingRequestApiClient,
  OrderingApiError,
  type PurchaseDetail,
} from "../support/request-support/api-client";
import {
  createReputationRequestApiClient,
  type ReviewOpportunity,
} from "@chase-sets/reputation/server";
import { OrderingOrderDetailPage } from "../features/orders/ui/order-detail-page";

const MARKETPLACE_DESCRIPTION =
  "Inspect a purchase, cancel it while still open, and see review readiness.";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireActorFromAuthApi({
    request,
    permission: "orders.view",
  });
  const orderingApi = createOrderingRequestApiClient(request);
  const reputationApi = createReputationRequestApiClient(request);

  try {
    const purchase = await orderingApi.getPurchase(params.purchaseId!);
    let reviewOpportunity: ReviewOpportunity | null = null;

    if (
      actor.permissions.includes("reputation.view") &&
      actor.permissions.includes("reputation.manage")
    ) {
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
      throw new Response("Purchase not found.", { status: 404 });
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
      await api.cancelPurchase(params.purchaseId!);
      return redirect(`/account/purchases/${params.purchaseId!}`);
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
    title: "Purchase | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

export default function OrderingAccountPurchaseRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const reviewOpportunity = data.reviewOpportunity as ReviewOpportunity | null;
  const subjectRole =
    reviewOpportunity?.author_role === "buyer" ? "seller" : "buyer";

  return (
    <OrderingOrderDetailPage
      role="buyer"
      backHref="/account/purchases"
      paymentHref={
        data.purchase.status === "pending-payment"
          ? `/account/payments/new?orderIds=${encodeURIComponent(data.purchase.order_id)}`
          : null
      }
      order={data.purchase as PurchaseDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle="Review"
      supplementarySection={
        reviewOpportunity ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">
                {reviewOpportunity.active_review_id
                  ? `Your ${subjectRole} review is already active.`
                  : `This verified purchase is ready for your ${subjectRole} review.`}
              </Text>
              <Text size="sm" tone="secondary">
                Reviews open only after delivery verifies the purchase.
              </Text>
              <LinkButton
                href={
                  reviewOpportunity.active_review_id
                    ? `/account/reviews/${reviewOpportunity.active_review_id}`
                    : `/account/purchases/${data.purchase.order_id}/review`
                }
              >
                {reviewOpportunity.active_review_id
                  ? "Open your review"
                  : `Leave ${subjectRole} review`}
              </LinkButton>
            </Stack>
          </Card>
        ) : null
      }
    />
  );
}
