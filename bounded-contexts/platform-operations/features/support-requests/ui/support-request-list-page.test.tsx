import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { supportFlowCatalog } from "../domain/flow-catalog";
import { SupportRequestListPage } from "./support-request-list-page";

function renderPage(
  supportOrder: Parameters<typeof SupportRequestListPage>[0]["supportOrder"] = null,
  buyerRequests: Parameters<typeof SupportRequestListPage>[0]["buyerRequests"] = [],
  sellerRequests: Parameters<typeof SupportRequestListPage>[0]["sellerRequests"] = [],
) {
  const router = createMemoryRouter(
    [
      {
        path: "/account/support",
        element: (
          <SupportRequestListPage
            flows={supportFlowCatalog}
            buyerRequests={buyerRequests}
            sellerRequests={sellerRequests}
            supportOrder={supportOrder}
          />
        ),
      },
    ],
    { initialEntries: ["/account/support"] },
  );

  render(<RouterProvider router={router} />);
}

const buyerOrder = {
  orderId: "ord_1",
  openedByRole: "buyer" as const,
  status: "ready-for-fulfillment",
  totalAmount: "35.00",
  lines: [
    {
      lineId: "line_1",
      itemTitle: "Charizard",
      productSummary: "Near mint",
      quantity: 1,
      amount: "20.00",
      currencyCode: "USD",
    },
    {
      lineId: "line_2",
      itemTitle: "Pikachu",
      productSummary: null,
      quantity: 2,
      amount: "15.00",
      currencyCode: "USD",
    },
  ],
};

describe("SupportRequestListPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("removes raw order and role lookup from marketplace support", () => {
    renderPage();

    expect(screen.queryByLabelText("Order ID")).toBeNull();
    expect(screen.queryByLabelText("Opening as")).toBeNull();
    expect(screen.queryByRole("button", { name: "Find order" })).toBeNull();
    expect(screen.getByRole("link", { name: "View purchases" }).getAttribute("href")).toBe("/account/purchases");
    expect(screen.getByRole("link", { name: "View sales" }).getAttribute("href")).toBe("/account/sales");
  });

  it("guides a buyer through affected lines, plain-language issue selection, and outcome preview", async () => {
    const user = userEvent.setup();
    renderPage(buyerOrder);

    expect(screen.getAllByText("Choose items")).toHaveLength(2);
    expect(screen.queryByText("buyer")).toBeNull();
    expect(document.querySelector('input[name="openedByRole"]')).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: /Charizard/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("radio", { name: /Product not as described/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const submit = screen.getByRole("button", { name: "Open case" });
    const form = submit.closest("form");
    expect(form).toBeTruthy();
    const intake = within(form!);
    expect(intake.getAllByText("Review outcome")).toHaveLength(2);
    expect(intake.getByText("Product not as described")).toBeTruthy();
    expect(intake.getByText("Return for refund")).toBeTruthy();
    expect(intake.getByText("48 hours")).toBeTruthy();
    expect(intake.getByText(/If the seller does not respond by the deadline/)).toBeTruthy();
    expect(intake.getByLabelText("Add evidence photos")).toBeTruthy();
    expect(intake.getByLabelText("Add evidence photos").hasAttribute("required")).toBe(true);
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(intake.getByText("Report item problems within 30 days of delivery.")).toBeTruthy();
    expect(intake.getByRole("link", { name: "Read Order Protection terms" }).getAttribute("href")).toBe(
      "/help/buying/order-protection",
    );
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>('input[name="affectedLineIds"]')).map(
        (input) => input.value,
      ),
    ).toEqual(["line_1"]);
  });

  it("offers seller-cannot-fulfill from a sale-owned order without a role control", async () => {
    const user = userEvent.setup();
    renderPage({
      ...buyerOrder,
      openedByRole: "seller",
      lines: [buyerOrder.lines[0]],
    });

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("radio", { name: /Seller cannot fulfill/ })).toBeTruthy();
    expect(screen.queryByLabelText("Opening as")).toBeNull();
  });

  it("blocks another case for the order and links to the existing case summary", () => {
    renderPage({
      ...buyerOrder,
      existingOpenRequest: {
        supportRequestId: "sup_existing",
        displayReference: "SUP-EXISTING",
        flowType: "product-damaged",
        status: "waiting-on-seller",
      },
    });

    expect(screen.getByText("A case is already open for this order")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View existing case" }).getAttribute("href")).toBe(
      "#existing-support-request",
    );
    expect(screen.getByText("SUP-EXISTING")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open case" })).toBeNull();
  });

  it("links buyer and seller rows to the participant-scoped case detail page", () => {
    const request = {
      support_request_id: "sup_case_detail",
      display_reference: "SUP-CASEDETA",
      order_id: "ord_case_detail",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      flow_type: "product-damaged",
      status: "waiting-on-seller",
      priority: "normal",
      opened_by_account_id: "acc_buyer",
      opened_by_role: "buyer",
      opened_at: "2026-07-15T08:00:00.000Z",
      updated_at: "2026-07-15T08:00:00.000Z",
      seller_response_due_at: "2026-07-17T08:00:00.000Z",
      support_review_due_at: "2026-07-16T08:00:00.000Z",
      seller_condition_attestation_due_at: null,
      order_return_context: null,
      affected_line_items: [],
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
      case_presentation: "decision-pending" as const,
      closure_eligible: false,
      closure_blocking_reasons: [],
      next_remedy_action: null,
      remedy_repair_guidance: [],
    };

    renderPage(null, [request], [request]);

    const links = screen.getAllByRole("link", { name: "SUP-CASEDETA" });
    expect(links).toHaveLength(4);
    expect(links.every((link) => link.getAttribute("href") === "/account/support/sup_case_detail")).toBe(true);
  });
});
