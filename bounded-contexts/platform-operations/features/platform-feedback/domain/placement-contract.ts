import type { PlatformFeedbackWorkflow } from "./common";

export type PlatformFeedbackPlacementKey =
  | "checkout-payment-confirmation"
  | "seller-listing-detail"
  | "submitted-offer-detail"
  | "offer-match-detail"
  | "inventory-list"
  | "inventory-item-detail";

export type PlatformFeedbackPlacementContract = Readonly<{
  key: PlatformFeedbackPlacementKey;
  routeTemplates: readonly string[];
  workflows: readonly PlatformFeedbackWorkflow[];
  visibility:
    | Readonly<{
        kind: "payment-completed";
        capturedStatuses: readonly string[];
        zeroDollarProcessorAmount: string;
        zeroDollarExcludedStatuses: readonly string[];
      }>
    | Readonly<{
        kind: "feedback-workflow-search-param";
        param: "feedbackWorkflow";
      }>;
  relatedEntityTypes: readonly string[];
}>;

type PaymentCompletedVisibility = Extract<
  PlatformFeedbackPlacementContract["visibility"],
  { kind: "payment-completed" }
>;

const checkoutPaymentVisibility: PaymentCompletedVisibility = {
  kind: "payment-completed",
  capturedStatuses: ["captured"],
  zeroDollarProcessorAmount: "0.00",
  zeroDollarExcludedStatuses: ["pending-confirmation", "failed", "cancelled"],
};

export const platformFeedbackPlacementContracts: readonly PlatformFeedbackPlacementContract[] = [
  {
    key: "checkout-payment-confirmation",
    routeTemplates: ["/account/payments/:paymentId", "/checkout/payments/:paymentId"],
    workflows: ["checkout-payment"],
    visibility: checkoutPaymentVisibility,
    relatedEntityTypes: ["payment", "order"],
  },
  {
    key: "seller-listing-detail",
    routeTemplates: ["/account/listings/:listingId"],
    workflows: ["listing-publish", "listing-update"],
    visibility: { kind: "feedback-workflow-search-param", param: "feedbackWorkflow" },
    relatedEntityTypes: ["listing", "inventory-item"],
  },
  {
    key: "submitted-offer-detail",
    routeTemplates: ["/account/offers/submitted/:offerId"],
    workflows: ["offer-submit"],
    visibility: { kind: "feedback-workflow-search-param", param: "feedbackWorkflow" },
    relatedEntityTypes: ["offer", "catalog-item"],
  },
  {
    key: "offer-match-detail",
    routeTemplates: ["/account/offers/matches/:offerId"],
    workflows: ["offer-accept"],
    visibility: { kind: "feedback-workflow-search-param", param: "feedbackWorkflow" },
    relatedEntityTypes: ["offer", "catalog-item"],
  },
  {
    key: "inventory-list",
    routeTemplates: ["/account/inventory"],
    workflows: ["inventory-create"],
    visibility: { kind: "feedback-workflow-search-param", param: "feedbackWorkflow" },
    relatedEntityTypes: ["inventory-item"],
  },
  {
    key: "inventory-item-detail",
    routeTemplates: ["/account/inventory/items/:itemId"],
    workflows: ["inventory-create", "inventory-adjust"],
    visibility: { kind: "feedback-workflow-search-param", param: "feedbackWorkflow" },
    relatedEntityTypes: ["inventory-item"],
  },
];

export function platformFeedbackPlacementContract(key: PlatformFeedbackPlacementKey) {
  return platformFeedbackPlacementContracts.find((contract) => contract.key === key) ?? null;
}

export function platformFeedbackWorkflowFromSearchParams(
  placementKey: PlatformFeedbackPlacementKey,
  searchParams: URLSearchParams,
): PlatformFeedbackWorkflow | null {
  const contract = platformFeedbackPlacementContract(placementKey);
  if (!contract || contract.visibility.kind !== "feedback-workflow-search-param") {
    return null;
  }

  const workflow = searchParams.get(contract.visibility.param);
  return contract.workflows.includes(workflow as PlatformFeedbackWorkflow)
    ? (workflow as PlatformFeedbackWorkflow)
    : null;
}

export function shouldShowCheckoutPaymentFeedbackPrompt(
  payment: Readonly<{ status: string; processor_amount: string }>,
) {
  const visibility = checkoutPaymentVisibility;
  if (visibility.capturedStatuses.includes(payment.status)) {
    return true;
  }

  return (
    payment.processor_amount === visibility.zeroDollarProcessorAmount &&
    !visibility.zeroDollarExcludedStatuses.includes(payment.status)
  );
}
