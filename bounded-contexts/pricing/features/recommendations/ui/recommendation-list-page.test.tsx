// @vitest-environment jsdom

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountRecommendationListItem } from "../read-model/queries";
import { PricingRecommendationListPage } from "./recommendation-list-page";

const recommendation = {
  recommendation_id: "rec_1",
  catalog_catalog_item_id: "cat_1",
  seller_account_id: "acc_1",
  action_type: "active-listing-price-update",
  status: "proposed",
  listing_id: "lst_1",
  inventory_item_id: "inv_1",
  catalog_item_title: "Charizard ex",
  catalog_item_language_code: "ja",
  catalog_item_subtitle: "Obsidian Flames",
  catalog_item_status: "active",
  market_price_amount: 20,
  market_currency: "USD",
  market_signal_type: "competition",
  market_observed_at: "2026-05-09T00:00:00.000Z",
  current_price_amount: 23,
  recommended_list_amount: 22,
  recommendation_reason: "Protect margin.",
  quantity_cap: 1,
  applied_listing_id: null,
  last_error: null,
  recommendation_published_at: "2026-05-09T00:01:00.000Z",
  stock_on_hand_quantity: 4,
  stock_reserved_quantity: 1,
  active_listing_count: 3,
  lowest_listing_price_amount: 18,
  active_offer_count: 2,
  highest_offer_price_amount: 19,
  committed_order_quantity: 5,
  delivered_quantity: 4,
  returned_quantity: 1,
  updated_at: "2026-05-09T00:02:00.000Z",
} satisfies AccountRecommendationListItem;

describe("PricingRecommendationListPage", () => {
  it("renders feed signals and flattens batch-control furniture", () => {
    const html = renderToString(<PricingRecommendationListPage recommendations={[recommendation]} />);

    expect(html).toContain("Refresh");
    expect(html).toContain("Apply selected");
    expect(html).toContain("Dismiss selected");
    expect(html).toContain("Charizard ex");
    expect(html).toContain("Japanese");
    expect(html).toContain("$20.00");
    expect(html).toContain("$22.00");
    expect(html).toContain("Current: $23.00");
    expect(html).toContain("Lowest active: $18.00");
    expect(html).toContain("Offers: 2; Highest: $19.00");
    expect(html).toContain("Delivered: 4; Returned: 1");
    expect(html).toContain("Update active");
    expect(html).toContain("Competition anchor");
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const batchFurniture = rendered.querySelector('[data-testid="recommendation-batch-furniture"]');
    expect(batchFurniture?.closest(".ds-glass")).toBeNull();
    expect(batchFurniture?.closest(".shadow-tokenSm")).toBeNull();
    expect(html).not.toContain("Publish listing");
  });

  it("renders applied and failed states distinctly", () => {
    const html = renderToString(
      <PricingRecommendationListPage
        recommendations={[
          { ...recommendation, status: "applied", recommendation_id: "rec_applied" },
          {
            ...recommendation,
            status: "failed",
            recommendation_id: "rec_failed",
            last_error: "Fee quote changed.",
          },
        ]}
      />,
    );

    expect(html).toContain("applied");
    expect(html).toContain("failed");
    expect(html).toContain("Fee quote changed.");
  });

  it("pauses recommendation controls while a command-owned job snapshot is active", () => {
    const html = renderToString(
      <PricingRecommendationListPage
        recommendations={[recommendation]}
        activeJobId="job_1"
        initialActiveJob={{
          jobId: "job_1",
          jobKind: "apply",
          status: "queued",
          progress: {
            phase: "queued",
            completed: 0,
            total: 1,
            message: "Recommendation job queued.",
          },
          result: null,
          errorMessage: null,
          createdAt: "2026-05-09T00:00:00.000Z",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-05-09T00:00:00.000Z",
        }}
      />,
    );

    expect(html).toContain("Recommendation job queued.");
    expect(html).toContain('value="refresh-recommendations"');
    expect(html).toContain('value="apply-recommendations"');
    expect(html).toContain('value="dismiss-recommendations"');
    expect(html.match(/disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
