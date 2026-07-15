// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
