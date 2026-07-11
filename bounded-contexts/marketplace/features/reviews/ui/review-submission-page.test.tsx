import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewSubmissionPage } from "./review-submission-page";

const opportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_buyer",
  subject_display_name: "Buyer Account",
  author_role: "seller",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
  window_expired: false,
  window_expires_at: "2026-06-01T00:00:00.000Z",
};

describe("review submission page", () => {
  it("renders account-to-account review language for the counterparty", () => {
    const markup = renderToString(<ReviewSubmissionPage backHref="/account/sales/ord_1" opportunity={opportunity} />);

    expect(markup).toContain("Review Buyer Account");
    expect(markup).toContain("Counterparty:");
    expect(markup).toContain("Buyer Account");
    expect(markup).toContain("Submit account review");
    expect(markup).toContain("Tell the account what went well or what needs improvement.");
  });

  it("preserves submitted values when the route returns an error", () => {
    const markup = renderToString(
      <ReviewSubmissionPage
        backHref="/account/sales/ord_1"
        opportunity={opportunity}
        errorMessage="Review could not be submitted."
        defaultRating={3}
        defaultFeedback="Quick payer."
      />,
    );

    expect(markup).toContain("Review could not be submitted.");
    expect(markup).toContain("Quick payer.");
  });

  it("shows the review-window-closed state instead of the form once the window has expired (m108 #4267)", () => {
    const markup = renderToString(
      <ReviewSubmissionPage backHref="/account/sales/ord_1" opportunity={{ ...opportunity, window_expired: true }} />,
    );

    expect(markup).not.toContain("Submit account review");
    expect(markup).toContain("Review window closed");
  });
});
