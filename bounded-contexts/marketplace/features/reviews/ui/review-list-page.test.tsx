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

  it("shows a pending placeholder without content for a redacted (not-yet-revealed) review (m108 #4267)", () => {
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
});
