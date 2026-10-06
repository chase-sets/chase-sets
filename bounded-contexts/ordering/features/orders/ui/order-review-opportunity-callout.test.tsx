// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { OrderOutcomePanel, OrderReviewOpportunityCallout } from "./order-review-opportunity-callout";

afterEach(cleanup);

function expectTintedCard(root: Element | null, label: string) {
  expect(root, `${label} root`).not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  expect(tokens.has("bg-surface-2"), `${label} includes bg-surface-2`).toBe(true);
  for (const excluded of [
    "ds-glass",
    "border",
    "border-muted",
    "shadow-tokenSm",
    "shadow-tokenLg",
    "ds-glow",
    "hover:border-accent",
    "hover:shadow-tokenMd",
  ])
    expect(tokens.has(excluded), `${label} excludes ${excluded}`).toBe(false);
}

describe("order review opportunity callout", () => {
  it("renders review opportunity as tinted furniture", () => {
    render(
      <OrderReviewOpportunityCallout
        opportunity={{ author_role: "seller", active_review_id: null }}
        reviewHref="/account/sales/ord_1/review"
        transactionLabel="sale"
      />,
    );

    expectTintedCard(screen.getByText("Leave account review").closest(".rounded-tokenLg"), "review opportunity");
  });

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

  it("shows the reviewed account's response beside the active review", () => {
    const markup = renderToString(
      <OrderReviewOpportunityCallout
        opportunity={{
          author_role: "buyer",
          active_review_id: "rev_1",
          response: "Thanks for sharing this outcome.",
          revealed: true,
          scoring_disposition: "context-only",
        }}
        reviewHref="/account/purchases/ord_1/review"
        transactionLabel="purchase"
      />,
    );

    expect(markup).toContain("Account response");
    expect(markup).toContain("Thanks for sharing this outcome.");
    expect(markup).toContain("Published, context only");
  });
});

describe("order outcome panel", () => {
  it("renders the order outcome as tinted furniture", () => {
    render(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={null}
        reviewReadStatus="ready"
        reviewHref="/account/purchases/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=buyer"
        transactionLabel="purchase"
      />,
    );

    expectTintedCard(screen.getByText("Order outcome").closest(".rounded-tokenLg"), "order outcome");
  });

  it("keeps issue, order, and held review facts in one role-aware surface", () => {
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={{
          author_role: "buyer",
          active_review_id: null,
          submission_state: "held",
          hold_reason: "feedback-on-hold",
          window_expired: false,
        }}
        reviewReadStatus="ready"
        reviewHref="/account/purchases/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=buyer"
        transactionLabel="purchase"
      />,
    );

    expect(markup).toContain("Order outcome");
    expect(markup).toContain("Ready for fulfillment");
    expect(markup).toContain("Review paused");
    expect(markup).toContain("Issue is being resolved before feedback continues.");
    expect(markup).toContain("Track issue");
    expect(markup).not.toContain("Leave account review");
  });

  it("renders an honest recoverable review error while preserving the rest of the outcome", () => {
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="cancelled"
        opportunity={null}
        reviewReadStatus="unavailable"
        reviewHref="/account/sales/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=seller"
        transactionLabel="sale"
      />,
    );

    expect(markup).toContain("Cancelled");
    expect(markup).toContain("Review status is temporarily unavailable");
    expect(markup).toContain("Refresh this page to try again.");
    expect(markup).toContain("Track issue");
  });

  it("distinguishes expired and ineligible review outcomes", () => {
    const expired = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={{
          author_role: "seller",
          active_review_id: null,
          submission_state: "expired",
          hold_reason: null,
          window_expired: true,
        }}
        reviewReadStatus="ready"
        reviewHref="/account/sales/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=seller"
        transactionLabel="sale"
      />,
    );
    const ineligible = renderToString(
      <OrderOutcomePanel
        orderStatus="cancelled"
        opportunity={null}
        reviewReadStatus="ready"
        reviewHref="/account/purchases/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=buyer"
        transactionLabel="purchase"
      />,
    );

    expect(expired).toContain("Review window expired");
    expect(ineligible).toContain("Review unavailable for this order");
  });

  it("distinguishes a review that is awaiting transaction eligibility", () => {
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={null}
        reviewReadStatus="ready"
        reviewHref="/account/purchases/ord_1/review"
        supportHref="/account/support?orderId=ord_1&amp;role=buyer"
        transactionLabel="purchase"
      />,
    );

    expect(markup).toContain("Review not available yet");
    expect(markup).toContain("updates after the transaction reaches an eligible outcome");
  });
});
