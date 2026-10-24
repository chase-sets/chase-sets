// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionDetailPage } from "./session-detail-page";

afterEach(cleanup);

describe("SessionDetailPage destructive actions", () => {
  it("requires confirmation before exposing the revoke session form", async () => {
    render(
      <SessionDetailPage
        data={{
          session_id: "session_alex_card_vault",
          user_id: "usr_alex",
          user_display_name: "Alex Clerk",
          user_primary_email: "alex@example.com",
          account_id: "acc_card_vault",
          account_display_name: "Card Vault",
          account_name: "Card Vault LLC",
          available_account_ids: ["acc_card_vault"],
          authentication_method: "password",
          status: "active",
          expires_at: "2026-07-15T12:00:00.000Z",
          updated_at: "2026-07-14T12:00:00.000Z",
        }}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelector('input[name="intent"][value="revoke"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog", { name: "Revoke session for Alex Clerk?" });
    expect(
      within(dialog).getByText(
        "This signs Alex Clerk out of the session for Card Vault. They will need to sign in again to use it.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Confirm revoke" })).toBeTruthy();
    expect(within(dialog).getByDisplayValue("revoke")).toBeTruthy();
  });

  it("marketplace mounts busy only the submitted form", async () => {
    let release!: () => void;
    const action = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const data = {
      session_id: "session_a",
      user_id: "usr_a",
      user_display_name: "Alex Clerk",
      user_primary_email: "alex@example.com",
      account_id: "acc_a",
      account_display_name: "Account A",
      account_name: "Account A",
      available_account_ids: ["acc_a", "acc_b"],
      authentication_method: "password" as const,
      status: "active" as const,
      expires_at: "2026-07-15T12:00:00.000Z",
      updated_at: "2026-07-14T12:00:00.000Z",
    };
    const router = createMemoryRouter(
      [
        {
          path: "/account/sessions/a",
          action,
          element: <SessionDetailPage data={data} submissionMode="router" />,
        },
      ],
      { initialEntries: ["/account/sessions/a"] },
    );
    render(<RouterProvider router={router} />);
    const switchButton = screen.getByRole("button", { name: "Switch Account" });
    const switchForm = switchButton.closest("form")!;
    fireEvent.click(switchButton);
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(switchForm.getAttribute("aria-busy")).toBe("true");
    const revokeButton = screen.getByRole("button", { name: "Revoke" });
    expect(revokeButton.getAttribute("aria-busy")).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(switchForm.getAttribute("aria-busy")).toBeNull());
    router.dispose();
  });

  it("admin mounts keep the document form transport", () => {
    render(
      <SessionDetailPage
        data={{
          session_id: "session_admin",
          user_id: "usr_admin",
          user_display_name: "Admin User",
          user_primary_email: "admin@example.com",
          account_id: "acc_admin",
          account_display_name: "Admin Account",
          account_name: "Admin Account",
          available_account_ids: ["acc_admin"],
          authentication_method: "password",
          status: "active",
          expires_at: "2026-07-15T12:00:00.000Z",
          updated_at: "2026-07-14T12:00:00.000Z",
        }}
      />,
    );
    const form = screen.getByRole("button", { name: "Switch Account" }).closest("form")!;
    expect(form.getAttribute("data-discover")).toBeNull();
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });
});
