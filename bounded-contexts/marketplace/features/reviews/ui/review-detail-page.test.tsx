import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
  resolution_context: null,
  submitted_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  withdrawn_at: null,
} satisfies ReviewDetail;

describe("review detail page", () => {
  it("renders account-to-account review labels", () => {
    const markup = renderToString(<ReviewDetailPage backHref="/account/reviews/received" review={review} />);

    expect(markup).toContain("Review author:");
    expect(markup).toContain("Author Account");
    expect(markup).toContain("Reviewed account:");
    expect(markup).toContain("Reviewed Account");
    expect(markup).not.toContain("Subject:");
    expect(markup).not.toContain("Resolved via refund");
  });

  it("shows the neutral resolved-via-refund badge for refund-context reviews", () => {
    const markup = renderToString(
      <ReviewDetailPage
        backHref="/account/reviews/written"
        review={{ ...review, author_role: "buyer", resolution_context: "resolved-via-refund" }}
      />,
    );

    expect(markup).toContain("Resolved via refund");
  });
});
