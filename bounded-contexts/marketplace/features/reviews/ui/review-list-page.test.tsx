import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewListPage } from "./review-list-page";
import type { ReviewListItem } from "./contracts";

const reviews = [
  {
    review_id: "rev_1",
    order_id: "ord_1",
    author_account_id: "acc_author",
    author_display_name: "Author Account",
    subject_account_id: "acc_reviewed",
    subject_display_name: "Reviewed Account",
    author_role: "buyer",
    rating: 5,
    feedback: "Packed carefully.",
    status: "active",
    submitted_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    withdrawn_at: null,
    revealed_at: "2026-04-05T00:00:00.000Z",
    reveal_reason: "counterpart-submitted",
    held: false,
    scoring_disposition: "included",
    scoring_reason_code: "normal-completion",
    scoring_policy_version: "resolution-aware-v1",
    scoring_source_fact_versions: [],
    scoring_operational_signal: null,
    rating_contribution_status: true,
    rating_contribution_version: "1",
    withdrawn_by_actor_type: null,
    moderation_operator_user_id: null,
    moderation_reason: null,
    feedback_redacted_at: null,
    reply_id: null,
    reply_feedback: null,
    reply_status: null,
    reply_submitted_at: null,
    reply_withdrawn_at: null,
  },
] satisfies ReviewListItem[];

describe("review list page", () => {
  it.each([
    { rating: null, held: false },
    { rating: 5, held: false },
    { rating: null, held: true },
    { rating: 5, held: true },
  ])("redacts an operator-withdrawn review before rating=$rating and held=$held branches", ({ rating, held }) => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[
          {
            ...reviews[0]!,
            status: "withdrawn",
            rating,
            held,
            withdrawn_by_actor_type: "operator",
            reply_status: "active",
            reply_feedback: "Private response sentinel",
          },
        ]}
      />,
    );
    expect(markup).toContain("Review withdrawn");
    expect(markup).toContain("Withdrawn by an operator");
    for (const hidden of [
      "Packed carefully.",
      "Private response sentinel",
      "Account response",
      "A review is pending",
      "Pending reveal",
      "Review paused",
      "Report review",
      "Review author:",
      'aria-label="5 rating"',
    ])
      expect(markup).not.toContain(hidden);
  });

  it("redacts a server-shaped received held-plus-revealed review with a response", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[
          {
            ...reviews[0]!,
            held: true,
            rating: null,
            feedback: null,
            reply_status: "active",
            reply_feedback: "Private response sentinel",
          },
        ]}
      />,
    );
    expect(markup).toContain("Review paused");
    for (const hidden of [
      "Packed carefully.",
      "Private response sentinel",
      "Account response",
      "Report review",
      "Respond to this review",
      'aria-label="5 rating"',
    ])
      expect(markup).not.toContain(hidden);
  });

  it.each([null, reviews[0]!.revealed_at])(
    "preserves the author's own held preview with revealed_at=%s without exposing a response",
    (revealed_at) => {
      const markup = renderToString(
        <ReviewListPage
          title="Written reviews"
          eyebrow="Reviews"
          emptyTitle="No reviews"
          emptyDescription="Nothing yet."
          reviewDetailBasePath="/account/reviews"
          reviews={[
            {
              ...reviews[0]!,
              held: true,
              revealed_at,
              reply_status: "active",
              reply_feedback: "Private response sentinel",
            },
          ]}
        />,
      );
      expect(markup).toContain("Packed carefully.");
      expect(markup).toContain('aria-label="5 rating"');
      expect(markup).toContain("Review paused");
      expect(markup.includes("Pending reveal")).toBe(revealed_at === null);
      expect(markup).toContain("Open review");
      expect(markup).toContain('href="/account/reviews/rev_1"');
      for (const hidden of ["Private response sentinel", "Account response", "Report review", "Respond to this review"])
        expect(markup).not.toContain(hidden);
    },
  );

  it("preserves the author's pending preview without publishing a private response", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[
          { ...reviews[0]!, revealed_at: null, reply_status: "active", reply_feedback: "Private response sentinel" },
        ]}
      />,
    );
    expect(markup).toContain("Packed carefully.");
    expect(markup).toContain("Pending reveal");
    expect(markup).not.toContain("Private response sentinel");
    expect(markup).not.toContain("Report review");
  });

  it("renders account-to-account review labels for each review", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={reviews}
      />,
    );

    expect(markup).toContain("Review author:");
    expect(markup).toContain("Author Account");
    expect(markup).toContain("Reviewed account:");
    expect(markup).toContain("Reviewed Account");
  });

  it("shows a pending placeholder without content for a redacted not-yet-revealed review", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[{ ...reviews[0]!, rating: null, feedback: null, revealed_at: null, reveal_reason: null }]}
      />,
    );

    expect(markup).not.toContain("Packed carefully.");
    expect(markup).not.toContain("Review author:");
    expect(markup).toContain("A review is pending");
    expect(markup).not.toContain("Report review");
    expect(markup).not.toContain("Account response");
  });

  it("shows neutral hold copy without held review content", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[{ ...reviews[0]!, held: true, rating: null, feedback: null }]}
      />,
    );

    expect(markup).toContain("Review paused");
    expect(markup).not.toContain("Packed carefully.");
  });

  it("shows the same response and report action on active revealed list items", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[
          {
            ...reviews[0]!,
            reply_id: "rvr_1",
            reply_feedback: "Thanks for sharing this.",
            reply_status: "active",
          },
        ]}
      />,
    );

    expect(markup).toContain("Account response");
    expect(markup).toContain("Thanks for sharing this.");
    expect(markup).toContain("Report review");
  });

  it("always explains context-only scoring separately from cause and remedy", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[
          {
            ...reviews[0]!,
            scoring_disposition: "context-only",
            disposition_reason_code: "external-responsibility",
            resolution_context: "carrier",
            remedy_kind: "refund",
          },
        ]}
      />,
    );

    expect(markup).toContain("Not included in rating");
    expect(markup).toContain("does not change the aggregate rating");
    expect(markup).toContain("Carrier-related issue");
    expect(markup).toContain("Refund issued");
  });
});
