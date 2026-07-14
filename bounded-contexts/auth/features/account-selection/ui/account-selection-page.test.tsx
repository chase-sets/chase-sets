// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

    expect(screen.getByText("Competitive Cards")).toBeTruthy();
    expect(screen.getByText("Role: Owner")).toBeTruthy();
    expect(screen.queryByText("acc_competitive_cards")).toBeNull();
    expect(screen.queryByText("owner")).toBeNull();
    expect(document.querySelector('input[name="accountId"]')?.getAttribute("value")).toBe("acc_competitive_cards");
  });
});
