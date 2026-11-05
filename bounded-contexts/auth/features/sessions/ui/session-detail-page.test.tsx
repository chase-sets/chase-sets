// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDetailPage } from "./session-detail-page";
import MarketplaceAccountSessionDetailRoute, {
  loader as marketplaceLoader,
} from "../../../routes/marketplace/account-sessions-detail";
import AccessAdminSessionDetailRoute, { loader as adminLoader } from "../../../routes/access-admin/sessions-detail";
import { mockNativeRequestSubmit, renderAuthRoute } from "../../../tests/auth-form-route-test-support";

const { api } = vi.hoisted(() => ({ api: { getSession: vi.fn() } }));
vi.mock("../../../support/request-support/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../support/request-support/api-client")>()),
  createAuthRequestApiClient: () => api,
}));

const sessionData = {
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
    api.getSession.mockResolvedValue(sessionData);
    const route = await renderAuthRoute(
      { path: "/account/sessions/:id", Component: MarketplaceAccountSessionDetailRoute, loader: marketplaceLoader },
      "/account/sessions/session_a",
    );
    const switchButton = screen.getByRole("button", { name: "Switch Account" });
    const switchForm = switchButton.closest("form")!;
    fireEvent.click(switchButton);
    await waitFor(() => expect(route.requests).toHaveBeenCalledOnce());
    expect(switchForm.getAttribute("aria-busy")).toBe("true");
    expect(switchButton.getAttribute("aria-busy")).toBe("true");
    const revokeButton = screen.getByRole("button", { name: "Revoke" });
    expect(revokeButton.getAttribute("aria-busy")).toBeNull();
    await route.settle(null);
    await waitFor(() => expect(switchForm.getAttribute("aria-busy")).toBeNull());

    fireEvent.click(revokeButton);
    const dialog = await screen.findByRole("dialog", { name: "Revoke session for Alex Clerk?" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm revoke" });
    const revokeForm = confirm.closest("form")!;
    fireEvent.click(confirm);
    await waitFor(() => expect(route.requests).toHaveBeenCalledTimes(2));
    expect(revokeForm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(switchForm.getAttribute("aria-busy")).toBeNull();
    await route.settle(null);
    await waitFor(() => expect(revokeForm.getAttribute("aria-busy")).toBeNull());
  });

  it("admin mounts keep the document form transport", async () => {
    api.getSession.mockResolvedValue({ ...sessionData, session_id: "session_admin" });
    mockNativeRequestSubmit();
    const route = await renderAuthRoute(
      { path: "/access/sessions/:id", Component: AccessAdminSessionDetailRoute, loader: adminLoader },
      "/access/sessions/session_admin",
    );
    const switchButton = screen.getByRole("button", { name: "Switch Account" });
    const form = switchButton.closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).not.toHaveBeenCalled());
    expect(form.getAttribute("data-discover")).toBeNull();
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });

  it("admin revoke remains a document form", async () => {
    api.getSession.mockResolvedValue(sessionData);
    mockNativeRequestSubmit();
    const route = await renderAuthRoute(
      { path: "/access/sessions/:id", Component: AccessAdminSessionDetailRoute, loader: adminLoader },
      "/access/sessions/session_a",
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke session for Alex Clerk?" });
    const form = within(dialog).getByRole("button", { name: "Confirm revoke" }).closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(route.requests).not.toHaveBeenCalled());
    expect(form.getAttribute("data-discover")).toBeNull();
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });

  it("the page default remains a document form", () => {
    render(<SessionDetailPage data={sessionData} />);
    const form = screen.getByRole("button", { name: "Switch Account" }).closest("form")!;
    expect(form.getAttribute("data-discover")).toBeNull();
    expect(form.getAttribute("aria-busy")).toBeNull();
    expect(form.querySelector("fieldset[disabled]")).toBeNull();
  });
});
