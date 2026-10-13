// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvitationAcceptancePage } from "./invitation-acceptance-page";
import MarketplaceInviteRoute from "../../../routes/marketplace/invite";
import { missingPhoneFailure, renderAuthRoute, safeFailure } from "../../../tests/auth-form-route-test-support";
import { createPasskeyCredential } from "../../../support/ui-support/passkey-browser";
import { redirect } from "react-router";

vi.mock("../../../support/ui-support/passkey-browser", () => ({ createPasskeyCredential: vi.fn() }));
vi.mock("../../../support/route-support/auth-host.server", async () => {
  const { defineAuthHost } = await import("../../../support/route-support/auth-host");
  const { marketplaceAuthHostConfig } = await import("../../../support/route-support/host-config");
  return { marketplaceAuthHost: defineAuthHost(marketplaceAuthHostConfig) };
});

afterEach(cleanup);

function elevatedCardCount() {
  return document.querySelectorAll(".rounded-tokenLg.overflow-hidden.shadow-tokenSm").length;
}

describe("invitation acceptance page", () => {
  it("shows the inviter, account, role, and both credential choices", () => {
    render(
      <InvitationAcceptancePage
        invitation={{
          status: "pending",
          invitationId: "ivt_1",
          email: "seller@example.com",
          accountName: "Competitive Cards",
          invitedByName: "Avery Collector",
          roleLabel: "Member",
        }}
        token="invite_token"
      />,
    );

    expect(screen.getByText(/Avery Collector invited you/i)).toBeTruthy();
    expect(screen.getByText(/Competitive Cards/)).toBeTruthy();
    expect(screen.getByText(/Member/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /accept with passkey/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    expect(screen.getByRole("button", { name: /accept with password/i })).toBeTruthy();
    expect(elevatedCardCount()).toBe(1);
  });

  it.each([
    ["expired", "This invitation has expired"],
    ["revoked", "This invitation was revoked"],
    ["accepted", "This invitation was already accepted"],
  ] as const)("shows clear %s copy", (status, copy) => {
    render(<InvitationAcceptancePage invitation={{ status }} token="invite_token" />);

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(elevatedCardCount()).toBe(0);
  });
});

describe("routed invitation errors", () => {
  const invitation = { status: "pending" as const, invitationId: "synthetic-invite", email: "seller@example.com", accountName: "Cards", invitedByName: "Avery", roleLabel: "Member" };
  const route = { path: "/invite/:invitationId", Component: MarketplaceInviteRoute, loader: () => ({ invitation, token: "synthetic-token" }) };

  it("safe fields: credential and unknown targets remain form-only", async () => {
    const rendered = await renderAuthRoute(route, "/invite/synthetic-invite");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    fireEvent.submit(screen.getByRole("button", { name: "Accept with password" }).closest("form")!);
    await waitFor(() => expect(rendered.requests).toHaveBeenCalledOnce());
    await rendered.settle(safeFailure("invitation-accept", 400, { error: { code: "validation_failed", message: "RAW_AUTH_MARKER", details: [{ field: "password", code: "phone_required", message: "RAW_AUTH_MARKER" }] } }));
    expect(screen.getByRole("alert").querySelector("a")).toBeNull();
    expect(screen.getByLabelText("Enter or create a password").getAttribute("aria-invalid")).toBeNull();
    expect(document.body.textContent).not.toContain("RAW_AUTH_MARKER");
    rendered.router.dispose();
  });

  it("focus lifecycle: repeated failures, retry/loading and success obey occurrence ownership", async () => {
    const rendered = await renderAuthRoute(route, "/invite/synthetic-invite");
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    const button = screen.getByRole("button", { name: "Accept with password" });
    for (let attempt = 1; attempt <= 2; attempt++) {
      button.focus();
      fireEvent.submit(button.closest("form")!);
      await waitFor(() => expect(rendered.requests).toHaveBeenCalledTimes(attempt));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(document.activeElement).toBe(button);
      await rendered.settle(safeFailure("invitation-accept"), true);
      expect(screen.queryByRole("alert")).toBeNull();
      await rendered.finishLoading();
      expect(document.activeElement).toBe(screen.getByRole("alert"));
      button.focus();
      await rendered.revalidate();
      expect(document.activeElement).toBe(button);
    }
    fireEvent.submit(button.closest("form")!);
    await waitFor(() => expect(rendered.requests).toHaveBeenCalledTimes(3));
    await rendered.settle(redirect("/done"));
    expect(screen.getByText("Authenticated destination")).toBeTruthy();
    rendered.router.dispose();
  });

  it("auth parity: passkey exceptions are safe and method change clears warnings", async () => {
    vi.mocked(createPasskeyCredential).mockRejectedValueOnce(new Error("RAW_PASSKEY_SECRET_MARKER"));
    const rendered = await renderAuthRoute(route, "/invite/synthetic-invite");
    fireEvent.submit(screen.getByRole("button", { name: "Accept with passkey" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("Passkey registration failed.");
    expect(document.body.textContent).not.toContain("RAW_PASSKEY_SECRET_MARKER");
    expect(document.activeElement).toBe(screen.getByRole("alert"));
    expect(rendered.requests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Password" }));
    expect(screen.queryByRole("alert")).toBeNull();
    rendered.router.dispose();
  });
});
