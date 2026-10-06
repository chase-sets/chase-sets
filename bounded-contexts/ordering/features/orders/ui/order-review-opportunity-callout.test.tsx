// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrderOutcomePanel,
  OrderReviewOpportunityCallout,
  mapOrderReviewOpportunity,
} from "./order-review-opportunity-callout";
import type { ReviewOpportunity } from "@chase-sets/marketplace/server";

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
    expect(markup).not.toContain("Reviews open only after delivery verifies both accounts in the transaction.");
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
  const opportunity: ReviewOpportunity = {
    order_id: "ord_1",
    subject_account_id: "acc_seller",
    subject_display_name: "Seller",
    author_role: "buyer",
    eligible_at: "2026-04-02T00:00:00.000Z",
    active_review_id: null,
    active_review_revealed_at: null,
    window_expired: false,
    window_expires_at: "2026-06-01T00:00:00.000Z",
    submission_state: "allowed",
    hold_reason: null,
  };
  const states: ReadonlyArray<{
    name: string;
    override: Partial<ReviewOpportunity> | null;
    status?: "ready" | "unavailable";
    label: string;
    link?: string;
  }> = [
    { name: "allowed", override: {}, label: "Leave account review", link: "/account/purchases/ord_1/review" },
    {
      name: "active pending",
      override: { active_review_id: "rev_1" },
      label: "Awaiting publication",
      link: "/account/reviews/rev_1",
    },
    {
      name: "active revealed",
      override: { active_review_id: "rev_1", active_review_revealed_at: "2026-04-05" },
      label: "Published",
      link: "/account/reviews/rev_1",
    },
    {
      name: "revealed after expiry",
      override: {
        active_review_id: "rev_1",
        active_review_revealed_at: "2026-04-05",
        submission_state: "expired",
        window_expired: true,
      },
      label: "Published",
      link: "/account/reviews/rev_1",
    },
    { name: "held", override: { submission_state: "held", hold_reason: "feedback-on-hold" }, label: "Review paused" },
    {
      name: "held revealed",
      override: {
        submission_state: "held",
        hold_reason: "feedback-on-hold",
        active_review_id: "rev_1",
        active_review_revealed_at: "2026-04-05",
        window_expired: true,
      },
      label: "Review paused",
    },
    {
      name: "expired without review",
      override: { submission_state: "expired", window_expired: true },
      label: "Review window closed",
    },
    {
      name: "withdrawn with open window",
      override: { active_review_id: null, window_expired: false },
      label: "Leave account review",
      link: "/account/purchases/ord_1/review",
    },
    { name: "not eligible yet", override: null, label: "Review not available yet" },
    { name: "unavailable", override: null, status: "unavailable", label: "Review status is temporarily unavailable" },
  ];

  it.each(states)(
    "renders $name through the mapper and composed panel without contradictions",
    ({ override, status, label, link }) => {
      render(
        <OrderOutcomePanel
          orderStatus="ready-for-fulfillment"
          opportunity={
            override === null
              ? null
              : mapOrderReviewOpportunity(
                  { ...opportunity, ...override },
                  {
                    author_role: "buyer",
                    active_review_id: "rev_1",
                    response: "Response sentinel",
                    scoring_disposition: "context-only",
                  },
                )
          }
          reviewReadStatus={status ?? "ready"}
          reviewHref="/account/purchases/ord_1/review"
          supportHref="/account/support?orderId=ord_1"
          transactionLabel="purchase"
        />,
      );
      expect(screen.getByText(label === "Published" ? "Published, context only" : label)).toBeTruthy();
      for (const other of new Set(states.map((state) => state.label))) {
        if (other !== label && other !== "Published") expect(screen.queryByText(other)).toBeNull();
      }
      if (label !== "Published") expect(screen.queryByText(/Published/)).toBeNull();
      const reviewLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/review"]')];
      expect(reviewLinks.map((anchor) => anchor.getAttribute("href"))).toEqual(link ? [link] : []);
      expect(screen.queryByText(/Reviews open only after delivery/)).toBeNull();
      if (label !== "Published") expect(screen.queryByText("Response sentinel")).toBeNull();
    },
  );

  it("does not attach a different projected review's response", () => {
    expect(
      mapOrderReviewOpportunity(
        { ...opportunity, active_review_id: "rev_new" },
        {
          author_role: "buyer",
          active_review_id: "rev_old",
          response: "Old response",
          scoring_disposition: "context-only",
        },
      ),
    ).toMatchObject({ response: null, scoring_disposition: null, revealed: false });
  });

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

    expect(expired).toContain("Review window closed");
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
