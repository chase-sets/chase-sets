import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { supportFlowCatalog } from "../domain/flow-catalog";
import { SupportRequestListPage } from "./support-request-list-page";

function renderPage(supportOrder: Parameters<typeof SupportRequestListPage>[0]["supportOrder"] = null) {
  const router = createMemoryRouter(
    [
      {
        path: "/account/support",
        element: (
          <SupportRequestListPage
            flows={supportFlowCatalog}
            buyerRequests={[]}
            sellerRequests={[]}
            supportOrder={supportOrder}
          />
        ),
      },
    ],
    { initialEntries: ["/account/support"] },
  );

  render(<RouterProvider router={router} />);
}

describe("SupportRequestListPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("starts with an order lookup form instead of a blind support-request write", () => {
    renderPage();

    const orderInput = screen.getByLabelText("Order ID");
    const form = orderInput.closest("form");
    expect(form).toBeTruthy();
    expect(form?.getAttribute("method")).toBe("get");
    expect(screen.getByRole("button", { name: "Find order" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open support request" })).toBeNull();
  });

  it("opens support only after the order context has been resolved for the account", () => {
    renderPage({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
    });

    expect(screen.getByText("ord_1")).toBeTruthy();
    expect(screen.getByText("ready-for-fulfillment")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Change order" }).getAttribute("href")).toBe("/account/support");
    const hiddenOrder = document.querySelector<HTMLInputElement>('input[type="hidden"][name="orderId"]');
    const hiddenRole = document.querySelector<HTMLInputElement>('input[type="hidden"][name="openedByRole"]');
    expect(hiddenOrder?.value).toBe("ord_1");
    expect(hiddenRole?.value).toBe("buyer");
    expect(hiddenOrder?.closest("form")?.getAttribute("method")).toBe("post");
    expect(screen.queryByLabelText("Order ID")).toBeNull();
    expect(screen.getByRole("button", { name: "Open support request" })).toBeTruthy();
  });
});
