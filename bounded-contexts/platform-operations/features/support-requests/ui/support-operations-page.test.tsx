// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SupportOperationsDetailPage, SupportOperationsPage } from "./support-operations-page";
import type { SupportRequestDetail, SupportRequestListItem } from "./contracts";

function buildQueueItem(overrides: Partial<SupportRequestListItem> = {}): SupportRequestListItem {
  return {
    support_request_id: "sup_1",
    display_reference: "SUP-TEST1234",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    status: "ready-for-support",
    priority: "urgent",
    opened_by_account_id: "acc_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: "2026-06-02T00:00:00.000Z",
    seller_condition_attestation_due_at: null,
    order_return_context: [],
    return_investigation: null,
    checklist: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
    return_refund_gate_status: null,
    return_delivered_at: null,
    return_refund_release_due_at: null,
    return_condition_disputed_at: null,
    ...overrides,
  };
}

function buildDetailItem(overrides: Partial<SupportRequestDetail> = {}): SupportRequestDetail {
  return {
    ...buildQueueItem(),
    evidence: [],
    responses: [],
    offers: [],
    ...overrides,
  };
}

function renderPage(props: Partial<Parameters<typeof SupportOperationsPage>[0]> = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/support/requests",
        element: <SupportOperationsPage queue={{ items: [], total: 0, count: 0 }} {...props} />,
      },
    ],
    { initialEntries: ["/support/requests"] },
  );

  render(<RouterProvider router={router} />);
}

function renderDetailPage(props: Partial<Parameters<typeof SupportOperationsDetailPage>[0]> = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/support/requests/:id",
        element: <SupportOperationsDetailPage request={buildDetailItem()} {...props} />,
      },
    ],
    { initialEntries: ["/support/requests/sup_1"] },
  );

  render(<RouterProvider router={router} />);
}

describe("SupportOperationsPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders URL-persisted status, priority, and search filters as applied filter chips", () => {
    renderPage({
      queue: { items: [buildQueueItem()], total: 1, count: 1 },
      filters: { status: "ready-for-support", priority: "urgent", search: "ord_1" },
    });

    expect((screen.getByLabelText("Search") as HTMLInputElement).value).toBe("ord_1");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("ready-for-support");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("urgent");
    expect(screen.getByText("Search: ord_1")).toBeTruthy();
    expect(screen.getByText("Status: Ready for support")).toBeTruthy();
    expect(screen.getByText("Priority: Urgent")).toBeTruthy();

    const searchInput = screen.getByLabelText("Search") as HTMLInputElement;
    expect(searchInput.closest("form")?.getAttribute("method")).toBe("get");
  });

  it("renders no applied filter chips and a plain clear-filters state when no filters are active", () => {
    renderPage({ queue: { items: [], total: 0, count: 0 }, filters: { status: "all", priority: "all", search: "" } });

    expect(screen.queryByText(/^Search:/)).toBeNull();
    expect(screen.queryByText(/^Status:/)).toBeNull();
    expect(screen.queryByText(/^Priority:/)).toBeNull();
  });

  it("shows pagination once the queue spans more than one page and omits it otherwise", () => {
    renderPage({
      queue: { items: [buildQueueItem()], total: 120, count: 1 },
      pagination: { limit: 50, offset: 0 },
    });
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();

    cleanup();

    renderPage({
      queue: { items: [buildQueueItem()], total: 1, count: 1 },
      pagination: { limit: 50, offset: 0 },
    });
    expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
  });

  it("marks an overdue-escalation sweep as partial when the active queue exceeded the sweep's page limit", () => {
    renderPage({
      escalationResult: { escalated: 3, skipped: 2, capped: true, total: 120 },
    });

    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText("Escalated 3 overdue requests; skipped 2.")).toBeTruthy();
    expect(
      screen.getByText("120 requests remain in the active queue. Escalate overdue again to process the rest."),
    ).toBeTruthy();
  });

  it("reports an overdue-escalation sweep as a full success when it was not capped", () => {
    renderPage({
      escalationResult: { escalated: 1, skipped: 0, capped: false, total: 1 },
    });

    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.queryByText(/requests remain in the active queue/)).toBeNull();
  });

  it("still surfaces the raw showing-of-total count operators depend on", () => {
    renderPage({ queue: { items: [buildQueueItem()], total: 4, count: 1 } });

    expect(screen.getByText("Showing 1 of 4")).toBeTruthy();
  });

  it("renders actionable buyer/seller marketplace order links when a marketplace origin is configured", () => {
    renderPage({
      queue: { items: [buildQueueItem()], total: 1, count: 1 },
      marketplaceOrigin: "https://marketplace.chasesets.com",
    });

    expect(screen.getAllByText("ord_1").length).toBeGreaterThan(0);
    const purchaseLink = screen.getAllByRole("link", { name: /View purchase \(buyer\)/ })[0] as HTMLAnchorElement;
    const saleLink = screen.getAllByRole("link", { name: /View sale \(seller\)/ })[0] as HTMLAnchorElement;
    expect(purchaseLink.href).toBe("https://marketplace.chasesets.com/account/purchases/ord_1");
    expect(saleLink.href).toBe("https://marketplace.chasesets.com/account/sales/ord_1");
    expect(purchaseLink.target).toBe("_blank");
    expect(purchaseLink.rel).toContain("noreferrer");
  });

  it("renders a visible configuration hint instead of a dead order id when no marketplace origin is configured", () => {
    renderPage({ queue: { items: [buildQueueItem()], total: 1, count: 1 } });

    expect(screen.getAllByText("ord_1").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Marketplace link unavailable — set CHASE_SETS_MARKETPLACE_ORIGIN").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: /View purchase/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /View sale/ })).toBeNull();
  });
});

describe("SupportOperationsDetailPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders actionable buyer/seller marketplace order links on the case detail order row", () => {
    renderDetailPage({ marketplaceOrigin: "https://marketplace.chasesets.com" });

    const purchaseLink = screen.getByRole("link", { name: /View purchase \(buyer\)/ }) as HTMLAnchorElement;
    const saleLink = screen.getByRole("link", { name: /View sale \(seller\)/ }) as HTMLAnchorElement;
    expect(purchaseLink.href).toBe("https://marketplace.chasesets.com/account/purchases/ord_1");
    expect(saleLink.href).toBe("https://marketplace.chasesets.com/account/sales/ord_1");
  });

  it("renders a visible configuration hint on the case detail order row when no marketplace origin is configured", () => {
    renderDetailPage();

    expect(screen.getByText("Marketplace link unavailable — set CHASE_SETS_MARKETPLACE_ORIGIN")).toBeTruthy();
  });
});
