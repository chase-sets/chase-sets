// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { OrderOutcomePanel, OrderReviewOpportunityCallout } from "./order-review-opportunity-callout";
import type {
  ReviewOpportunityChangedV1,
  ReviewOpportunitySlot,
} from "@chase-sets/event-core/review-opportunity-facts";
import { orderReviewOutcome } from "../integrations/reputation/reputation-queries";
import type { OrderingOrderReviewOpportunity } from "./contracts";

afterEach(cleanup);

const opportunity: OrderingOrderReviewOpportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_seller",
  subject_display_name: "Seller",
  author_role: "buyer",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
  active_review_revealed_at: null,
  window_expires_at: "2026-04-20T00:00:00.000Z",
  submission_state: "allowed",
  hold_reason: null,
  window_expired: false,
  revealed: false,
};

const slot: ReviewOpportunitySlot = {
  authorRole: "buyer",
  eligibleAt: "2026-04-02T00:00:00.000Z",
  effectiveDeadlineAt: "2026-04-20T00:00:00.000Z",
  submissionState: "allowed",
  held: false,
  activeReviewId: null,
  activeReviewRevealedAt: null,
};

const states: readonly {
  name: string;
  slot: ReviewOpportunitySlot | null;
  now?: string;
  current?: boolean;
  expected: string;
  action?: "leave" | "view";
}[] = [
  { name: "allowed", slot, expected: "ready for your", action: "leave" },
  {
    name: "active-unrevealed",
    slot: { ...slot, activeReviewId: "rev_1" },
    expected: "Awaiting publication",
    action: "view",
  },
  {
    name: "active-revealed",
    slot: { ...slot, activeReviewId: "rev_1", activeReviewRevealedAt: "2026-04-03T00:00:00.000Z" },
    expected: "Published",
    action: "view",
  },
  {
    name: "revealed-after-expiry",
    slot: { ...slot, activeReviewId: "rev_1", activeReviewRevealedAt: "2026-04-03T00:00:00.000Z" },
    now: "2026-05-01T00:00:00.000Z",
    expected: "Published",
    action: "view",
  },
  {
    name: "pending-after-expiry",
    slot: { ...slot, activeReviewId: "rev_1" },
    now: "2026-05-01T00:00:00.000Z",
    expected: "Awaiting publication",
    action: "view",
  },
  { name: "held", slot: { ...slot, held: true }, expected: "Review paused" },
  {
    name: "held-plus-revealed",
    slot: { ...slot, held: true, activeReviewId: "rev_1", activeReviewRevealedAt: "2026-04-03T00:00:00.000Z" },
    expected: "Review paused",
  },
  { name: "expired-without-review", slot, now: "2026-05-01T00:00:00.000Z", expected: "Review window closed" },
  // The content-free DTO represents withdrawal as no active review, so this aliases allowed.
  {
    name: "withdrawn/open-window",
    slot: { ...slot, activeReviewId: null },
    expected: "ready for your",
    action: "leave",
  },
  { name: "current-null", slot: null, expected: "Review not available yet" },
  { name: "unavailable/lagging", slot, current: false, expected: "Review status is temporarily unavailable" },
];

describe.each(["purchase", "sale"] as const)("canonical %s outcome matrix", (transactionLabel) => {
  it.each(states)("renders $name through the typed mapper and full panel", (state) => {
    const role = transactionLabel === "purchase" ? "buyer" : "seller";
    const directionalSlot: ReviewOpportunitySlot | null = state.slot ? { ...state.slot, authorRole: role } : null;
    const fact: ReviewOpportunityChangedV1 = {
      factSchemaVersion: 1,
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      generation: "1",
      sourceGeneration: "synthetic-test-generation",
      generatedAt: "2026-04-02T00:00:00.000Z",
      provenance: { ordering: "1", fulfillment: "1", support: "0", marketplace: "1" },
      buyerToSeller: role === "buyer" ? directionalSlot : null,
      sellerToBuyer: role === "seller" ? directionalSlot : null,
    };
    const outcome = orderReviewOutcome(
      {
        fact,
        valid: true,
        current: state.current ?? true,
        buyer_account_id: fact.buyerAccountId,
        seller_account_id: fact.sellerAccountId,
        subject_display_name: "Counterparty",
        source_positions: null,
      },
      `acc_${role}`,
      new Date(state.now ?? "2026-04-05T00:00:00.000Z"),
    );
    const unexpectedMetadata = outcome.opportunity
      ? { ...outcome.opportunity, response: "Private response sentinel", scoring_disposition: "context-only" }
      : null;
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={unexpectedMetadata}
        reviewReadStatus={outcome.status}
        reviewHref={`/account/${transactionLabel === "purchase" ? "purchases" : "sales"}/ord_1/review`}
        supportHref={`/account/support?orderId=ord_1&role=${role}`}
        transactionLabel={transactionLabel}
      />,
    );
    expect(markup).toContain("Order outcome");
    expect(markup).toContain("Track issue");
    expect(markup).toContain(state.expected);
    for (const label of [
      "Awaiting publication",
      "Published",
      "Review paused",
      "Review window closed",
      "Review not available yet",
      "Review status is temporarily unavailable",
    ])
      if (label !== state.expected) expect(markup).not.toContain(label);
    expect(markup.includes("Leave account review")).toBe(state.action === "leave");
    expect(markup.includes("Open your review")).toBe(state.action === "view");
    expect(markup.includes('href="/account/reviews/rev_1"')).toBe(state.action === "view");
    expect(markup.includes(`/ord_1/review"`)).toBe(state.action === "leave");
    expect(markup).not.toContain("Account response");
    expect(markup).not.toContain("Private response sentinel");
    expect(markup).not.toContain("Published, context only");
    expect(markup).not.toContain("Reviews open only after delivery verifies");
  });

  it("unavailable outranks even an active opportunity and forbids every review link", () => {
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={{
          ...opportunity,
          author_role: transactionLabel === "purchase" ? "buyer" : "seller",
          active_review_id: "rev_1",
          revealed: true,
        }}
        reviewReadStatus="unavailable"
        reviewHref="/forbidden/review"
        supportHref="/account/support"
        transactionLabel={transactionLabel}
      />,
    );
    expect(markup).toContain("Review status is temporarily unavailable");
    for (const forbidden of [
      "Published",
      "Awaiting publication",
      "Open your review",
      "Leave account review",
      "/forbidden/review",
      "/account/reviews/rev_1",
    ])
      expect(markup).not.toContain(forbidden);
  });

  it.each([true, false])("an active review outranks an expired flag with revealed=%s", (revealed) => {
    const markup = renderToString(
      <OrderOutcomePanel
        orderStatus="ready-for-fulfillment"
        opportunity={{
          ...opportunity,
          author_role: transactionLabel === "purchase" ? "buyer" : "seller",
          active_review_id: "rev_1",
          submission_state: "expired",
          window_expired: true,
          active_review_revealed_at: revealed ? "2026-04-03T00:00:00.000Z" : null,
          revealed,
        }}
        reviewReadStatus="ready"
        reviewHref="/forbidden/review"
        supportHref="/account/support"
        transactionLabel={transactionLabel}
      />,
    );
    expect(markup).toContain(revealed ? "Published" : "Awaiting publication");
    expect(markup).toContain('href="/account/reviews/rev_1"');
    for (const forbidden of ["Review window closed", "Leave account review", "/forbidden/review"])
      expect(markup).not.toContain(forbidden);
  });
});

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
  it.each(["held", "expired"] as const)(
    "does not offer a leave link for an unsubmitted %s opportunity",
    (submission_state) => {
      const markup = renderToString(
        <OrderReviewOpportunityCallout
          opportunity={{ ...opportunity, submission_state, active_review_id: null }}
          reviewHref="/forbidden/review"
          transactionLabel="purchase"
        />,
      );
      expect(markup).not.toContain("Leave account review");
      expect(markup).not.toContain("Open your review");
      expect(markup).not.toContain("/forbidden/review");
    },
  );

  it("renders review opportunity as tinted furniture", () => {
    render(
      <OrderReviewOpportunityCallout
        opportunity={{ ...opportunity, author_role: "seller", active_review_id: null }}
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
          ...opportunity,
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
          ...opportunity,
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

  it("does not invent response or scoring metadata absent from the canonical contract", () => {
    const unexpectedMetadata = {
      ...opportunity,
      active_review_id: "rev_1",
      active_review_revealed_at: "2026-04-03T00:00:00.000Z",
      revealed: true,
      response: "Private response sentinel",
      scoring_disposition: "context-only",
    };
    const markup = renderToString(
      <OrderReviewOpportunityCallout
        opportunity={unexpectedMetadata}
        reviewHref="/account/purchases/ord_1/review"
        transactionLabel="purchase"
      />,
    );

    expect(markup).not.toContain("Account response");
    expect(markup).not.toContain("Private response sentinel");
    expect(markup).not.toContain("Published, context only");
    expect(markup).toContain("Published");
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
          ...opportunity,
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
          ...opportunity,
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
