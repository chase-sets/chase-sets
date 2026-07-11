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
    resolution_context: null,
    submitted_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    withdrawn_at: null,
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
    expect(markup).not.toContain("Resolved via refund");
  });

  it("shows the neutral resolved-via-refund badge only for refund-context reviews", () => {
    const markup = renderToString(
      <ReviewListPage
        title="Reviews"
        eyebrow="Reviews"
        emptyTitle="No reviews"
        emptyDescription="Nothing yet."
        reviewDetailBasePath="/account/reviews"
        reviews={[{ ...reviews[0]!, resolution_context: "resolved-via-refund" }]}
      />,
    );

    expect(markup).toContain("Resolved via refund");
  });
});
