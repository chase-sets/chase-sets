import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { Card, LinkButton, Stack, Text } from "@chase-sets/design-system";
import {
  ApiError as OrderingApiError,
  OrderingOrderDetailPage,
  type OrderingOrderDetail,
} from "@chase-sets/ordering/web";
import {
  ReputationApiError,
  type ReputationReviewOpportunity,
} from "@chase-sets/reputation/web";
import {
  createMarketplaceOrderingApiClient,
  createMarketplaceReputationApiClient,
} from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const actor = await requireMarketplaceActor(request, "orders.view");
  const orderingApi = createMarketplaceOrderingApiClient(request);
  const reputationApi = createMarketplaceReputationApiClient(request);

  try {
    const order = await orderingApi.getBuyerOrder(params.orderId!);
    let reviewOpportunity: ReputationReviewOpportunity | null = null;

    if (
      actor.permissions.includes("reputation.view") &&
      actor.permissions.includes("reputation.manage")
    ) {
      try {
        reviewOpportunity = await reputationApi.getOrderReviewOpportunity(params.orderId!);
      } catch (error) {
        if (!(error instanceof ReputationApiError && error.status === 404)) {
          throw error;
        }
      }
    }

    return {
      order,
      reviewOpportunity,
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
      await api.cancelBuyerOrder(params.orderId!);
      return redirect(`/account/orders/${params.orderId!}`);
    }

    return null;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Order | Marketplace" });

export default function MarketplaceAccountOrderRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const reviewOpportunity = data.reviewOpportunity as ReputationReviewOpportunity | null;
  const subjectRole =
    reviewOpportunity?.author_role === "buyer" ? "seller" : "buyer";

  return (
    <OrderingOrderDetailPage
      role="buyer"
      backHref="/account/orders"
      paymentHref={
        data.order.status === "pending-payment"
          ? `/account/payments/new?orderIds=${encodeURIComponent(data.order.order_id)}`
          : null
      }
      order={data.order as OrderingOrderDetail}
      errorMessage={actionData?.error ?? null}
      supplementarySectionTitle="Review"
      supplementarySection={
        reviewOpportunity ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">
                {reviewOpportunity.active_review_id
                  ? `Your ${subjectRole} review is already active.`
                  : `This verified order is ready for your ${subjectRole} review.`}
              </Text>
              <Text size="sm" tone="secondary">
                Reviews open only after delivery verifies the order.
              </Text>
              <LinkButton
                href={
                  reviewOpportunity.active_review_id
                    ? `/account/reviews/${reviewOpportunity.active_review_id}`
                    : `/account/orders/${data.order.order_id}/review`
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
