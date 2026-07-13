import { describe, expect, it } from "vitest";
import {
  platformFeedbackPlacementContract,
  platformFeedbackPlacementContracts,
  platformFeedbackWorkflowFromSearchParams,
} from "../features/platform-feedback/domain/placement-contract";

describe("platform feedback prompt placement contract", () => {
  it("publishes the workflows and route surfaces that may show feedback prompts", () => {
    expect(platformFeedbackPlacementContracts).toMatchObject([
      {
        key: "seller-listing-detail",
        routeTemplates: ["/account/listings/:listingId"],
        workflows: ["listing-publish", "listing-update"],
        relatedEntityTypes: ["listing", "inventory-item"],
      },
      {
        key: "submitted-offer-detail",
        routeTemplates: ["/account/offers/submitted/:offerId"],
        workflows: ["offer-submit"],
        relatedEntityTypes: ["offer", "catalog-item"],
      },
      {
        key: "offer-match-detail",
        routeTemplates: ["/account/offers/matches/:offerId"],
        workflows: ["offer-accept"],
        relatedEntityTypes: ["offer", "catalog-item"],
      },
      {
        key: "inventory-list",
        routeTemplates: ["/account/inventory"],
        workflows: ["inventory-create"],
        relatedEntityTypes: ["inventory-item"],
      },
      {
        key: "inventory-item-detail",
        routeTemplates: ["/account/inventory/items/:itemId"],
        workflows: ["inventory-create", "inventory-adjust"],
        relatedEntityTypes: ["inventory-item"],
      },
    ]);
  });

  it("keeps query-param placements scoped to their declared workflows", () => {
    const listingSearchParams = new URLSearchParams("feedbackWorkflow=listing-update");
    const offerSearchParams = new URLSearchParams("feedbackWorkflow=offer-submit");
    const wrongSurfaceSearchParams = new URLSearchParams("feedbackWorkflow=inventory-adjust");

    expect(platformFeedbackWorkflowFromSearchParams("seller-listing-detail", listingSearchParams)).toBe(
      "listing-update",
    );
    expect(platformFeedbackWorkflowFromSearchParams("submitted-offer-detail", offerSearchParams)).toBe("offer-submit");
    expect(platformFeedbackWorkflowFromSearchParams("seller-listing-detail", wrongSurfaceSearchParams)).toBeNull();
  });
});
