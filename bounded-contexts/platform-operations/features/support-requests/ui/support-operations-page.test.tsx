// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SupportOperationsPage } from "./support-operations-page";
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
    remedy: null,
    remedy_approval: null,
    case_presentation: "decision-pending",
    closure_eligible: false,
    closure_blocking_reasons: [],
    next_remedy_action: null,
    remedy_repair_guidance: [],
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
    { initialEntries: ["/support/requests?priority=urgent&search=ord_1"] },
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
    expect(screen.getByRole("button", { name: "Ready for support" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("urgent");
    expect(screen.getByText("Search: ord_1")).toBeTruthy();
    expect(screen.getByText("Status: Ready for support")).toBeTruthy();
    expect(screen.getByText("Priority: Urgent")).toBeTruthy();

    const searchInput = screen.getByLabelText("Search") as HTMLInputElement;
    expect(searchInput.closest("form")?.getAttribute("method")).toBe("get");
    expect(searchInput.closest("form")?.querySelector<HTMLInputElement>('input[name="status"]')?.value).toBe(
      "ready-for-support",
    );
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

  it("shows deadline countdowns and links each row back to a drawer on the current queue", () => {
    renderPage({
      queue: { items: [buildQueueItem()], total: 1, count: 1 },
      queueNow: "2026-06-02T02:00:00.000Z",
    });

    expect(screen.getAllByText("Overdue by 2 hours").length).toBeGreaterThan(0);
    const open = screen.getAllByRole("link", { name: "Open" })[0]!;
    expect(open).toBeTruthy();
    expect(open.getAttribute("href")).toContain("/support/requests?");
    expect(open.getAttribute("href")).toContain("requestId=sup_1");
    expect(open.getAttribute("href")).toContain("priority=urgent");
    expect(open.getAttribute("href")).toContain("search=ord_1");
  });

  it("shows the earliest applicable deadline when a request has multiple deadlines", () => {
    renderPage({
      queue: {
        items: [
          buildQueueItem({
            seller_response_due_at: "2026-06-03T00:00:00.000Z",
            support_review_due_at: "2026-06-02T00:00:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      queueNow: "2026-06-01T00:00:00.000Z",
    });

    expect(screen.getAllByText("Due in 24 hours").length).toBeGreaterThan(0);
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
  it("renders a ready-for-support request with resolve as the primary drawer action", () => {
    renderPage({
      selectedRequest: buildDetailItem(),
      queueNow: "2026-06-01T12:00:00.000Z",
      marketplaceOrigin: "https://marketplace.chasesets.com",
    });

    const reason = screen.getByLabelText("Responsibility reason") as HTMLSelectElement;
    const evidenceBasis = screen.getByLabelText("Evidence basis") as HTMLSelectElement;
    expect(document.querySelector('[data-support-primary-action="resolve"]')).toBeTruthy();
    expect(reason.required).toBe(true);
    expect([...reason.options].map((option) => option.text)).toContain("Carrier lost the shipment (carrier)");
    expect(evidenceBasis.required).toBe(true);
    expect([...evidenceBasis.options].map((option) => option.text)).toEqual([
      "Operator finding",
      "Insufficient evidence",
    ]);
    expect(screen.getByRole("link", { name: /View purchase \(buyer\)/ })).toBeTruthy();
  });

  it("chooses escalate for an overdue request and respond for a future urgent request", () => {
    renderPage({
      selectedRequest: buildDetailItem({
        status: "waiting-on-seller",
        support_review_due_at: "2026-06-01T00:00:00.000Z",
      }),
      queueNow: "2026-06-02T00:00:00.000Z",
    });
    expect(document.querySelector('[data-support-primary-action="escalate"]')).toBeTruthy();

    cleanup();

    renderPage({
      selectedRequest: buildDetailItem({
        status: "waiting-on-seller",
        support_review_due_at: "2026-06-03T00:00:00.000Z",
      }),
      queueNow: "2026-06-02T00:00:00.000Z",
    });
    expect(document.querySelector('[data-support-primary-action="response"]')).toBeTruthy();
  });

  it("shows support notes, structured offers, and the audit trail in the drawer", () => {
    renderPage({
      selectedRequest: buildDetailItem({
        evidence: [
          {
            evidenceId: "ev_note",
            submittedByAccountId: null,
            submittedByRole: "support",
            evidenceType: "support-note",
            summary: "Called the buyer.",
            occurredAt: null,
            submittedAt: "2026-06-01T01:00:00.000Z",
            attachments: [],
          },
          {
            evidenceId: "ev_photo",
            submittedByAccountId: "acc_buyer" as never,
            submittedByRole: "buyer",
            evidenceType: "photo",
            summary: "Damaged corner.",
            occurredAt: null,
            submittedAt: "2026-06-01T01:30:00.000Z",
            attachments: [
              "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg",
            ],
          },
        ],
        offers: [
          {
            offerId: "off_1",
            responseId: "res_1",
            offeredByAccountId: "acc_seller",
            offeredByRole: "seller",
            pendingWithRole: "buyer",
            responseType: "offer-partial-refund",
            resolutionType: "partial-refund",
            refundAmount: "5.00",
            summary: "Refund five dollars.",
            offeredAt: "2026-06-01T02:00:00.000Z",
            status: "pending",
            decidedByAccountId: null,
            decidedByRole: null,
            decidedAt: null,
            decisionSummary: null,
          },
        ],
      }),
    });

    expect(screen.getByText("Support notes")).toBeTruthy();
    expect(screen.getAllByText("Called the buyer.").length).toBeGreaterThan(0);
    expect(screen.getByText("Structured offers")).toBeTruthy();
    expect(screen.getAllByText("Refund five dollars.").length).toBeGreaterThan(0);
    expect(screen.getByText("Audit trail")).toBeTruthy();
    expect(
      screen
        .getAllByRole("img", { name: "Evidence photo 1" })
        .every(
          (image) => image.getAttribute("src") === "/api/marketplace/support-requests/sup_1/attachments/sea_photo",
        ),
    ).toBe(true);
    expect(screen.getAllByRole("link", { name: "View full-size photo 1" }).length).toBeGreaterThan(0);
  });

  it("posts drawer actions through the existing detail command route and returns to the filtered queue", () => {
    renderPage({ selectedRequest: buildDetailItem() });

    const resolveForm = document.querySelector<HTMLFormElement>('[data-support-action="resolve"]');
    expect(resolveForm?.getAttribute("action")).toContain("/support/requests/sup_1?returnTo=");
    expect(decodeURIComponent(resolveForm?.getAttribute("action") ?? "")).toContain("priority=urgent");
    expect(decodeURIComponent(resolveForm?.getAttribute("action") ?? "")).toContain("search=ord_1");
  });

  it("renders all four independent remedy dimensions and the server-produced exposure preview", () => {
    const request = buildDetailItem({
      status: "resolved",
      resolution: {
        resolutionType: "full-refund",
        summary: "Buyer is made whole.",
        refundAmount: "100.00",
        resolvedByAccountId: "acc_operator" as never,
        resolvedByRole: "support",
        resolvedAt: "2026-07-14T00:00:00.000Z",
        responsibility: "undetermined",
        evidenceBasis: { type: "insufficient-evidence", reference: "evidence-1" },
        responsibilityReasonCode: "product-not-received.insufficient-evidence",
      },
    });
    renderPage({
      selectedRequest: request,
      actorPermissions: ["support.remedies.propose"],
      remedyPreview: {
        customerOutcome: "100.00 usd full-refund",
        sellerImpact: "0.00 usd",
        protectionReserveImpact: "100.00 usd",
        returnLabelCostPayer: "platform",
        refundTrigger: "facility-intake",
        reservationExpiresAt: "2026-07-15T00:00:00.000Z",
        requiredApprovalCount: 2,
        requiresElevatedApproval: true,
        returnOverrideRequired: false,
        policyVersion: "platform-operations.platform-remedies:compiled-v1",
      },
    });

    expect(screen.getByLabelText("Buyer remedy amount")).toBeTruthy();
    expect(screen.getByLabelText("Funding allocation")).toBeTruthy();
    expect(screen.getByLabelText("Return directive")).toBeTruthy();
    expect(screen.getByLabelText("Refund trigger")).toBeTruthy();
    expect(screen.getByText("Financial exposure preview")).toBeTruthy();
    expect(screen.getByText("100.00 usd")).toBeTruthy();
    expect(screen.getByText("Elevated approval is required.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request reservation" })).not.toHaveProperty("disabled", true);
  });

  it("lists exact remedy effects that block closure", () => {
    renderPage({
      selectedRequest: buildDetailItem({
        status: "resolved",
        closure_eligible: false,
        closure_blocking_reasons: ["refund-completion:failed-retryable", "settlement-reconciliation:pending"],
      }),
    });
    expect(screen.getByText("refund-completion:failed-retryable")).toBeTruthy();
    expect(screen.getByText("settlement-reconciliation:pending")).toBeTruthy();
    expect(document.querySelector('[data-support-action="close"] button[type="submit"]')).toHaveProperty(
      "disabled",
      true,
    );
  });
});
