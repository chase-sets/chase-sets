// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PlatformFeedbackListItem, PlatformFeedbackMetrics } from "../api/contracts";
import { PlatformFeedbackAdminDetailPage, PlatformFeedbackAdminListPage } from "./admin-pages";

const feedbackItem = {
  feedback_id: "pfb_test",
  user_id: "usr_test",
  account_id: "acc_test",
  rating: 4,
  topic: "checkout-payment",
  comment: "Checkout was clear.",
  follow_up_consent: true,
  workflow: "checkout-payment",
  source_route_path: "/account/payments/pay_test",
  related_entities: [{ type: "payment", id: "pay_test" }],
  related_entity_key: "payment:pay_test",
  status: "new",
  submitted_at: "2026-05-07T12:00:00.000Z",
  updated_at: "2026-05-07T12:00:00.000Z",
  reviewed_by_user_id: null,
  reviewed_at: null,
  archived_by_user_id: null,
  archived_at: null,
} satisfies PlatformFeedbackListItem;

const metrics = {
  total_count: 3,
  new_count: 1,
  reviewed_count: 1,
  archived_count: 1,
  average_rating: "4.33",
  by_topic: [],
  by_workflow: [],
} satisfies PlatformFeedbackMetrics;

describe("platform feedback admin UI", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders metrics, filters, and queue actions", () => {
    render(
      <PlatformFeedbackAdminListPage
        feedback={{ items: [feedbackItem], total: 1, count: 1 }}
        metrics={metrics}
        filters={{ status: "new", topic: "checkout-payment", workflow: "checkout-payment" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Platform Feedback" })).toBeTruthy();
    expect(screen.getByLabelText("Status")).toMatchObject({ value: "new" });
    expect(screen.getByLabelText("Topic")).toMatchObject({ value: "checkout-payment" });
    expect(screen.getByLabelText("Workflow")).toMatchObject({ value: "checkout-payment" });
    const form = screen.getByLabelText("Status").closest("form");
    if (!form) {
      throw new Error("Expected platform feedback filters to render inside a GET form.");
    }
    const formData = new FormData(form);
    expect(form.getAttribute("method")).toBe("get");
    expect(formData.get("status")).toBe("new");
    expect(formData.get("topic")).toBe("checkout-payment");
    expect(formData.get("workflow")).toBe("checkout-payment");
    expect(screen.getAllByRole("link", { name: "Open" })[0]?.getAttribute("href")).toBe(
      "/support/platform-feedback/pfb_test",
    );
    expect(screen.getByText("4.33")).toBeTruthy();
  });

  it("renders detail attribution, marketplace related links, and status actions", () => {
    render(
      <PlatformFeedbackAdminDetailPage
        feedback={feedbackItem}
        marketplaceOrigin="https://marketplace.chasesets.com"
      />,
    );

    expect(screen.getByRole("heading", { name: "Feedback pfb_test" })).toBeTruthy();
    expect(screen.getByText("Checkout was clear.")).toBeTruthy();
    const relatedLink = screen.getByRole("link", { name: "payment: pay_test" });
    expect(relatedLink.getAttribute("href")).toBe("https://marketplace.chasesets.com/account/payments/pay_test");
    expect(relatedLink.getAttribute("target")).toBe("_blank");
    expect(relatedLink.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("renders related entity text instead of an admin-host account link when no marketplace origin is configured", () => {
    render(<PlatformFeedbackAdminDetailPage feedback={feedbackItem} />);

    expect(screen.queryByRole("link", { name: "payment: pay_test" })).toBeNull();
    expect(screen.getByText("payment: pay_test")).toBeTruthy();
  });
});
