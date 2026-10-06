// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDetailPage } from "./review-detail-page";
import type { ReviewDetail } from "./contracts";

const review = {
  review_id: "rev_1",
  order_id: "ord_1",
  author_account_id: "acc_author",
  author_display_name: "Author Account",
  subject_account_id: "acc_reviewed",
  subject_display_name: "Reviewed Account",
  author_role: "seller",
  rating: 4,
  feedback: "Prompt payment and clear communication.",
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
} satisfies ReviewDetail;

afterEach(cleanup);

function expectTintedCard(root: Element | null) {
  expect(root, "reply form root").not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  expect(tokens.has("bg-surface-2"), "reply form includes bg-surface-2").toBe(true);
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
    expect(tokens.has(excluded), `reply form excludes ${excluded}`).toBe(false);
}

describe("review detail page", () => {
  it("renders account-to-account review labels", () => {
    const markup = renderToString(<ReviewDetailPage backHref="/account/reviews/received" review={review} />);

    expect(markup).toContain("Review author:");
    expect(markup).toContain("Author Account");
    expect(markup).toContain("Reviewed account:");
    expect(markup).toContain("Reviewed Account");
    expect(markup).not.toContain("Subject:");
  });

  it("links back to the role-aware order outcome without exposing private order facts", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/written?role=seller"
        orderHref="/account/sales/ord_1"
        review={review}
      />,
    );

    expect(markup).toContain("View order outcome");
    expect(markup).toContain('href="/account/sales/ord_1"');
  });

  it("redacts rating and feedback for a not-yet-revealed review viewed by the subject", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, rating: null, feedback: null, revealed_at: null, reveal_reason: null }}
      />,
    );

    expect(markup).not.toContain("Prompt payment and clear communication.");
    expect(markup).not.toContain("Review author:");
  });

  it("shows the pending-reveal badge for the author's own pending review", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/written"
        review={{ ...review, revealed_at: null, reveal_reason: null }}
      />,
    );

    expect(markup).toContain("Prompt payment and clear communication.");
  });

  it("shows a neutral hold state without revealing content to the review subject", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, held: true, rating: null, feedback: null }}
        viewerAccountId={review.subject_account_id}
      />,
    );

    expect(markup).toContain("Review paused");
    expect(markup).not.toContain("Prompt payment and clear communication.");
    expect(markup).not.toContain("Respond to this review");
  });

  it("shows the subject response with an account-neutral label", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, reply_status: "active", reply_feedback: "Thanks for the feedback!" }}
      />,
    );

    expect(markup).toContain("Account response");
    expect(markup).toContain("Thanks for the feedback!");
  });

  it("offers structured reporting for every active revealed review and shows privacy-safe status", () => {
    const availableMarkup = renderToString(
      <ReviewDetailPage backHref="/account/reviews/received" review={review} viewerAccountId="acc_viewer" />,
    );
    const submittedMarkup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={review}
        viewerAccountId="acc_viewer"
        reportStatus="submitted"
      />,
    );

    expect(availableMarkup).toContain("Report review");
    expect(submittedMarkup).toContain("Report submitted");
    expect(submittedMarkup).toContain("A report does not automatically remove the review.");
  });

  it("does not offer reporting for pending, held, withdrawn, or moderated content", () => {
    for (const hiddenReview of [
      { ...review, revealed_at: null, rating: null, feedback: null },
      { ...review, held: true, rating: null, feedback: null },
      { ...review, status: "withdrawn" },
      { ...review, feedback_redacted_at: "2026-04-06T00:00:00.000Z" },
    ]) {
      const markup = renderToString(
        <ReviewDetailPage backHref="/account/reviews/received" review={hiddenReview} viewerAccountId="acc_viewer" />,
      );
      expect(markup).not.toContain("Report review");
    }
  });

  it("hides a withdrawn reply", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, reply_status: "withdrawn", reply_feedback: "Redacted reply." }}
      />,
    );

    expect(markup).not.toContain("Redacted reply.");
  });

  it("shows moderation badges for an operator-withdrawn or redacted review", () => {
    const withdrawnMarkup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, status: "withdrawn", withdrawn_by_actor_type: "operator" }}
      />,
    );
    expect(withdrawnMarkup).toContain("Withdrawn by an operator");

    const redactedMarkup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/received"
        review={{ ...review, feedback: null, feedback_redacted_at: "2026-04-06T00:00:00.000Z" }}
      />,
    );
    expect(redactedMarkup).toContain("Feedback redacted by an operator");
  });

  describe("subject reply compose form (m108)", () => {
    it("renders the reply form as tinted furniture", () => {
      render(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={review}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expectTintedCard(screen.getByRole("button", { name: "Post response" }).closest(".rounded-tokenLg"));
    });

    it("renders the compose form for the subject of a revealed, active review with no reply", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={review}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expect(markup).toContain("Respond to this review");
      expect(markup).toContain("Post response");
      expect(markup).toContain('maxLength="1000"');
      expect(markup).toContain("required");
    });

    it("does not render the compose form for the review author", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/written"
          review={review}
          viewerAccountId={review.author_account_id}
        />,
      );

      expect(markup).not.toContain("Respond to this review");
    });

    it("does not render the compose form when no viewer account is provided", () => {
      const markup = renderToString(<ReviewDetailPage backHref="/account/reviews/received" review={review} />);

      expect(markup).not.toContain("Respond to this review");
    });

    it("does not render the compose form once a reply exists (one reply per review)", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={{ ...review, reply_id: "rvr_1", reply_status: "active", reply_feedback: "Already replied." }}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expect(markup).not.toContain("Respond to this review");
      expect(markup).toContain("Already replied.");
    });

    it("does not render the compose form when the reply was withdrawn (one round ever)", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={{ ...review, reply_id: "rvr_1", reply_status: "withdrawn", reply_feedback: "Withdrawn reply." }}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expect(markup).not.toContain("Respond to this review");
      expect(markup).not.toContain("Withdrawn reply.");
    });

    it("does not render the compose form before the review is revealed", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={{ ...review, rating: null, feedback: null, revealed_at: null, reveal_reason: null }}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expect(markup).not.toContain("Respond to this review");
    });

    it("does not render the compose form on a withdrawn review", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={{ ...review, status: "withdrawn" }}
          viewerAccountId={review.subject_account_id}
        />,
      );

      expect(markup).not.toContain("Respond to this review");
    });

    it("surfaces the action error and preserves the draft response", () => {
      const markup = renderToString(
        <ReviewDetailPage
          backHref="/account/reviews/received"
          review={review}
          viewerAccountId={review.subject_account_id}
          replyErrorMessage="A reply already exists for this review."
          defaultReplyFeedback="My draft response."
        />,
      );

      expect(markup).toContain("A reply already exists for this review.");
      expect(markup).toContain("My draft response.");
    });
  });
});
