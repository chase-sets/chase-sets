import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewContext, ReviewCard } from "../index";

describe("review context", () => {
  it("states excluded rating impact in words and keeps cause separate from remedy", () => {
    const markup = renderToString(
      <ReviewContext
        scoringStatus="excluded"
        scoringLabel="Not included in rating"
        explanation="This feedback shares the experience but does not change the aggregate rating."
        outcomeLabel="Carrier-related issue"
        remedyLabel="Refund issued"
      />,
    );

    expect(markup).toContain("Not included in rating");
    expect(markup).toContain("Carrier-related issue");
    expect(markup).toContain("Refund issued");
    expect(markup).toContain("does not change the aggregate rating");
    expect(markup).toContain('role="status"');
  });

  it("uses an account-neutral response label and exposes review actions", () => {
    const markup = renderToString(
      <ReviewCard
        author="Buyer account"
        rating={4}
        body="Clear communication."
        response="Thank you."
        responseLabel="Account response"
        actions={<button type="button">Report review</button>}
      />,
    );

    expect(markup).toContain("Account response");
    expect(markup).not.toContain("Seller response");
    expect(markup).toContain("Report review");
  });
});
