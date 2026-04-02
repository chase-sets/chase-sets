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
  if (!actor.permissions.includes("listings.view")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  const orderingApi = createMarketplaceOrderingApiClient(request);
  const reputationApi = createMarketplaceReputationApiClient(request);

  try {
    const order = await orderingApi.getSellerOrder(params.orderId!);
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
  const reviewOpportunity = data.reviewOpportunity as ReputationReviewOpportunity | null;
  const subjectRole =
    reviewOpportunity?.author_role === "buyer" ? "seller" : "buyer";

  return (
    <OrderingOrderDetailPage
      role="seller"
      backHref="/account/sales"
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
                    : `/account/sales/${data.order.order_id}/review`
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
