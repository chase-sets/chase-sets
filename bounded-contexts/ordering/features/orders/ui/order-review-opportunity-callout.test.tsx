import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderReviewOpportunityCallout } from "./order-review-opportunity-callout";

describe("order review opportunity callout", () => {
  it("renders a neutral account-review CTA for a new review", () => {
    const markup = renderToString(
      <OrderReviewOpportunityCallout
        opportunity={{
          author_role: "seller",
          active_review_id: null,
        }}
        reviewHref="/account/sales/ord_1/review"
        transactionLabel="sale"
      />,
    );

    expect(markup).toContain("This verified sale is ready for your buyer counterparty review.");
    expect(markup).toContain("Leave account review");
    expect(markup).toContain("/account/sales/ord_1/review");
    expect(markup).toContain("Reviews open only after delivery verifies both accounts in the transaction.");
  });

  it("links to the active review when one already exists", () => {
    const markup = renderToString(
      <OrderReviewOpportunityCallout
        opportunity={{
          author_role: "buyer",
          active_review_id: "rev_1",
        }}
        reviewHref="/account/purchases/ord_1/review"
        transactionLabel="purchase"
      />,
    );

    expect(markup).toContain("Your account review is already active.");
    expect(markup).toContain("Open your review");
    expect(markup).toContain("/account/reviews/rev_1");
  });
});
