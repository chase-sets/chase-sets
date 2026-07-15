// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamPage } from "./account-team-page";

afterEach(cleanup);

describe("account team page heading hierarchy", () => {
  it("renders one top-level heading followed by member section headings", () => {
    render(
      <TeamPage
        invitations={[]}
        memberships={[
          {
            membership_id: "mem_1",
            user_id: "usr_1",
            user_display_name: "Alex Seller",
            user_primary_email: "alex@example.test",
            account_id: "acc_1",
            account_display_name: "Alex Cards",
            account_name: "Alex Cards",
            role_key: "owner",
            status: "active",
            updated_at: "2026-07-15T12:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Team" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Alex Seller" })).toBeTruthy();
  });
});
