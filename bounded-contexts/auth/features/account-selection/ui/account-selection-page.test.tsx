// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AccountSelectionPage } from "./account-selection-page";

afterEach(cleanup);

describe("account selection page", () => {
  it("shows account names and localized role labels without exposing raw identifiers", () => {
    const memberships = [
      {
        accountId: "acc_competitive_cards",
        accountName: "Competitive Cards",
        roleKey: "owner",
        roleLabel: "Owner",
      },
    ] as const;

    render(<AccountSelectionPage memberships={memberships} />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Choose Account" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Competitive Cards" })).toBeTruthy();
    expect(screen.getByText("Competitive Cards")).toBeTruthy();
    expect(screen.getByText("Role: Owner")).toBeTruthy();
    expect(screen.queryByText("acc_competitive_cards")).toBeNull();
    expect(screen.queryByText("owner")).toBeNull();
    expect(document.querySelector('input[name="accountId"]')?.getAttribute("value")).toBe("acc_competitive_cards");
    expect(document.querySelectorAll(".rounded-tokenLg.overflow-hidden.shadow-tokenSm")).toHaveLength(
      memberships.length,
    );
  });

  it("marketplace mounts busy only the submitted form", async () => {
    let release!: () => void;
    const action = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const router = createMemoryRouter(
      [
        {
          path: "/account/select",
          action,
          element: (
            <AccountSelectionPage
              submissionMode="router"
              memberships={[
                { accountId: "acc_a", accountName: "Account A", roleLabel: "Owner" },
                { accountId: "acc_b", accountName: "Account B", roleLabel: "Viewer" },
                { accountId: "acc_c", accountName: "Account C", roleLabel: "Buyer" },
              ]}
            />
          ),
        },
      ],
      { initialEntries: ["/account/select"] },
    );
    render(<RouterProvider router={router} />);
    const buttons = screen.getAllByRole("button", { name: "Continue" });
    const forms = buttons.map((button) => button.closest("form")!);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(forms[1].getAttribute("aria-busy")).toBe("true");
    expect(forms[0].getAttribute("aria-busy")).toBeNull();
    expect(forms[2].getAttribute("aria-busy")).toBeNull();
    fireEvent.click(buttons[1]);
    expect(action).toHaveBeenCalledOnce();
    await act(async () => release());
    await waitFor(() => expect(forms[1].getAttribute("aria-busy")).toBeNull());
    router.dispose();
  });

  it("admin mounts keep the document form transport", () => {
    render(
      <AccountSelectionPage
        memberships={[{ accountId: "acc_admin", accountName: "Admin Account", roleLabel: "Owner" }]}
      />,
    );
    const form = screen.getByRole("button", { name: "Continue" }).closest("form")!;
    expect(form.getAttribute("data-discover")).toBeNull();
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });
});
