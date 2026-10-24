// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redirect } from "react-router";
import { AccountSelectionPage } from "./account-selection-page";
import MarketplaceAccountSelectionRoute, {
  loader as marketplaceLoader,
} from "../../../routes/marketplace/account-select";
import AccessAdminAccountSelectionRoute, { loader as adminLoader } from "../../../routes/access-admin/account-select";
import { mockNativeRequestSubmit, renderAuthRoute } from "../../../tests/auth-form-route-test-support";

const fixtures = vi.hoisted(() => ({
  memberships: [
    { accountId: "acc_a", accountName: "Account A", roleLabel: "Owner" },
    { accountId: "acc_b", accountName: "Account B", roleLabel: "Viewer" },
    { accountId: "acc_c", accountName: "Account C", roleLabel: "Buyer" },
  ] as const,
  adminMemberships: [{ accountId: "acc_admin", accountName: "Admin Account", roleLabel: "Owner" }] as const,
}));
const { memberships } = fixtures;

vi.mock("../../../support/route-support/auth-host.server", () => ({
  marketplaceAuthHost: {
    createAccountSelectionLoader: () => async () => ({ memberships }),
    createAccountSelectionAction: () => async () => null,
  },
  adminAuthHost: {
    createAccountSelectionLoader: () => async () => ({ memberships: fixtures.adminMemberships }),
    createAccountSelectionAction: () => async () => null,
  },
}));

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
    const route = await renderAuthRoute(
      { path: "/account/select", Component: MarketplaceAccountSelectionRoute, loader: marketplaceLoader },
      "/account/select",
    );
    const buttons = screen.getAllByRole("button", { name: "Continue" });
    const forms = buttons.map((button) => button.closest("form")!);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    expect(forms[1].getAttribute("aria-busy")).toBe("true");
    expect(buttons[1].getAttribute("aria-busy")).toBe("true");
    expect(forms[0].getAttribute("aria-busy")).toBeNull();
    expect(forms[2].getAttribute("aria-busy")).toBeNull();
    expect(buttons[0].getAttribute("aria-busy")).toBeNull();
    expect(buttons[2].getAttribute("aria-busy")).toBeNull();
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buttons[1]);
    expect(route.requests).toHaveBeenCalledOnce();
    await route.settle({ error: "synthetic failure" });
    await waitFor(() => expect(forms[1].getAttribute("aria-busy")).toBeNull());
    expect(buttons[1].getAttribute("aria-busy")).toBeNull();
    fireEvent.click(buttons[2]);
    await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(2));
    await route.settle(redirect("/done"));
    expect(route.router.state.location.pathname).toBe("/done");
  });

  it("admin mounts keep the document form transport", async () => {
    mockNativeRequestSubmit();
    const route = await renderAuthRoute(
      { path: "/access/account-select", Component: AccessAdminAccountSelectionRoute, loader: adminLoader },
      "/access/account-select",
    );
    const form = screen.getByRole("button", { name: "Continue" }).closest("form")!;
    expect(form.getAttribute("data-discover")).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).not.toHaveBeenCalled());
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });
});
