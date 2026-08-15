// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewSubmissionPage } from "./review-submission-page";
import { REVIEW_RESOLUTION_ANALYTICS_EVENT } from "./review-resolution";

const opportunity = {
  order_id: "ord_1",
  subject_account_id: "acc_buyer",
  subject_display_name: "Buyer Account",
  author_role: "seller",
  eligible_at: "2026-04-02T00:00:00.000Z",
  active_review_id: null,
  window_expired: false,
  window_expires_at: "2026-06-01T00:00:00.000Z",
  submission_state: "allowed" as const,
  hold_reason: null,
};

const buyerOpportunity = {
  ...opportunity,
  subject_account_id: "acc_seller",
  subject_display_name: "Seller Account",
  author_role: "buyer",
};

function captureResolutionEvents() {
  const events: Array<Record<string, unknown>> = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent).detail as Record<string, unknown>);
  };
  window.addEventListener(REVIEW_RESOLUTION_ANALYTICS_EVENT, listener);
  return {
    events,
    dispose: () => window.removeEventListener(REVIEW_RESOLUTION_ANALYTICS_EVENT, listener),
  };
}

function expectTintedCard(root: Element | null) {
  expect(root).toBeTruthy();
  const className = (root as HTMLElement).className;
  expect(className.split(/\s+/)).toContain("bg-surface-2");
  expect(className).not.toMatch(
    /\b(?:ds-glass|border|border-muted|shadow-\S+|ds-glow|hover:border-accent|hover:shadow-tokenMd)\b/,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("review submission page (server render)", () => {
  it("renders account-to-account review language for the counterparty", () => {
    const markup = renderToString(<ReviewSubmissionPage backHref="/account/sales/ord_1" opportunity={opportunity} />);

    expect(markup).toContain("Review Buyer Account");
    expect(markup).toContain("Counterparty:");
    expect(markup).toContain("Buyer Account");
    expect(markup).toContain("Submit account review");
    expect(markup).toContain("Tell the account what went well or what needs improvement.");
    expect(markup).toContain('class="rounded-tokenLg overflow-hidden bg-surface-2 p-4"');
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

  it("shows the review-window-closed state instead of the form once the window has expired", () => {
    const markup = renderToString(
      <ReviewSubmissionPage backHref="/account/sales/ord_1" opportunity={{ ...opportunity, window_expired: true }} />,
    );

    expect(markup).not.toContain("Submit account review");
    expect(markup).toContain("Review window closed");
  });
});

describe("existing order issue blocks submission", () => {
  it("replaces the form with a track-order-issue action while a support review is open", () => {
    render(
      <ReviewSubmissionPage
        backHref="/account/purchases/ord_1"
        opportunity={{ ...buyerOpportunity, submission_state: "held", hold_reason: "feedback-on-hold" }}
      />,
    );

    const paused = screen.getByText("Review paused");
    expect(paused).toBeTruthy();
    expectTintedCard(paused.closest(".bg-surface-2"));
    const track = screen.getByRole("link", { name: "Track order issue" });
    expect(track.getAttribute("href")).toBe("/account/support?orderId=ord_1");
    expect(screen.queryByRole("button", { name: "Submit account review" })).toBeNull();
  });
});

describe("buyer resolution-first funnel", () => {
  it("shows the resolution interstitial before submitting a 1-2 star review", () => {
    const { events, dispose } = captureResolutionEvents();
    render(
      <ReviewSubmissionPage backHref="/account/purchases/ord_1" opportunity={buyerOpportunity} defaultRating={2} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit account review" }));

    const resolution = screen.getByText("Resolve this issue");
    expect(resolution).toBeTruthy();
    expectTintedCard(resolution.closest(".bg-surface-2"));
    expect(screen.getByRole("link", { name: "Open an order issue" })).toBeTruthy();
    expect(screen.getByText("Leave feedback only")).toBeTruthy();
    expect(events.some((event) => event.event === "review_resolution_interstitial_shown")).toBe(true);
    dispose();
  });

  it("routes a structured problem indicator even with a high rating", () => {
    render(
      <ReviewSubmissionPage backHref="/account/purchases/ord_1" opportunity={buyerOpportunity} defaultRating={5} />,
    );

    fireEvent.click(screen.getByLabelText("Arrived damaged"));
    fireEvent.click(screen.getByRole("button", { name: "Submit account review" }));

    const resolve = screen.getByRole("link", { name: "Open an order issue" });
    expect(resolve.getAttribute("href")).toBe("/account/support?orderId=ord_1&flow=product-damaged");
  });

  it("preserves the draft locally and does not submit when the buyer resolves first", () => {
    const { events, dispose } = captureResolutionEvents();
    render(
      <ReviewSubmissionPage
        backHref="/account/purchases/ord_1"
        opportunity={buyerOpportunity}
        defaultRating={1}
        defaultFeedback="Never arrived."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit account review" }));
    fireEvent.click(screen.getByRole("link", { name: "Open an order issue" }));

    const stored = window.sessionStorage.getItem("chase-sets:review-draft:ord_1");
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ rating: 1, feedback: "Never arrived." });
    expect(events.some((event) => event.event === "review_resolution_resolve_first_selected")).toBe(true);
    expect(events.some((event) => event.event === "review_resolution_case_routed")).toBe(true);
    // Analytics never carries the review text.
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("Never arrived.");
    }
    dispose();
  });

  it("requires an explicit acknowledgement before the feedback-only escape hatch submits", () => {
    const { events, dispose } = captureResolutionEvents();
    render(
      <ReviewSubmissionPage backHref="/account/purchases/ord_1" opportunity={buyerOpportunity} defaultRating={1} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit account review" }));

    const feedbackOnly = screen.getByRole("button", { name: "Continue with feedback only" });
    expect(feedbackOnly.hasAttribute("disabled")).toBe(true);

    fireEvent.click(
      screen.getByLabelText(
        "I understand that leaving feedback only will not request a refund, return, replacement, or payment hold.",
      ),
    );
    expect(feedbackOnly.hasAttribute("disabled")).toBe(false);

    fireEvent.click(feedbackOnly);
    expect(events.some((event) => event.event === "review_resolution_feedback_only_selected")).toBe(true);
    dispose();
  });

  it("explains an unavailable intake and keeps feedback-only available", () => {
    const { events, dispose } = captureResolutionEvents();
    render(
      <ReviewSubmissionPage
        backHref="/account/purchases/ord_1"
        opportunity={buyerOpportunity}
        defaultRating={1}
        resolution={{ intakeAvailable: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit account review" }));

    expect(screen.getByText("An order issue can't be opened")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open an order issue" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with feedback only" })).toBeTruthy();
    expect(events.some((event) => event.event === "review_resolution_intake_unavailable")).toBe(true);
    dispose();
  });

  it("resumes a preserved draft once the direction is eligible again", () => {
    const { events, dispose } = captureResolutionEvents();
    window.sessionStorage.setItem(
      "chase-sets:review-draft:ord_1",
      JSON.stringify({ rating: 2, feedback: "Wrong card sent.", problemCategories: ["not-as-described"] }),
    );

    render(
      <ReviewSubmissionPage backHref="/account/purchases/ord_1" opportunity={buyerOpportunity} defaultRating={5} />,
    );

    expect((screen.getByLabelText("Feedback") as HTMLTextAreaElement).value).toBe("Wrong card sent.");
    expect(window.sessionStorage.getItem("chase-sets:review-draft:ord_1")).toBeNull();
    expect(events.some((event) => event.event === "review_resolution_draft_resumed")).toBe(true);
    dispose();
  });
});

describe("seller order-help action", () => {
  it("offers general order help without buyer payment-protection copy and never blocks submission", () => {
    render(<ReviewSubmissionPage backHref="/account/sales/ord_1" opportunity={opportunity} defaultRating={1} />);

    // Sellers get the persistent problem action but no structured problem indicators.
    expect(screen.queryByText("Was there a problem with this order?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Problem with this order?" }));

    expect(screen.getByText("Open order help so our team can look into what happened.")).toBeTruthy();
    expect(screen.queryByText("Leave feedback only")).toBeNull();
    expect(
      screen.queryByText(
        "Open an order issue so we can review what happened. Eligible payments stay protected while the issue is open.",
      ),
    ).toBeNull();
  });
});
