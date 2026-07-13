import type { PlatformFeedbackWorkflow } from "./common";

export type PlatformFeedbackPlacementKey =
  | "seller-listing-detail"
  | "submitted-offer-detail"
  | "offer-match-detail"
  | "inventory-list"
  | "inventory-item-detail";

export type PlatformFeedbackPlacementContract = Readonly<{
  key: PlatformFeedbackPlacementKey;
  routeTemplates: readonly string[];
  workflows: readonly PlatformFeedbackWorkflow[];
  visibility: Readonly<{
    kind: "feedback-workflow-search-param";
    param: "feedbackWorkflow";
  }>;
  relatedEntityTypes: readonly string[];
}>;

export const platformFeedbackPlacementContracts: readonly PlatformFeedbackPlacementContract[] = [
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
