// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvitationAcceptancePage } from "./invitation-acceptance-page";
import { createPasskeyCredential } from "../../../support/ui-support/passkey-browser";

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
    ["unavailable", "This invitation is unavailable"],
  ] as const)("shows clear %s copy", (status, copy) => {
    render(<InvitationAcceptancePage invitation={{ status }} token="invite_token" />);

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
    expect(elevatedCardCount()).toBe(0);
  });
});
