// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InvitationAcceptancePage } from "./invitation-acceptance-page";

afterEach(cleanup);

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
          requiresRegistration: false,
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
  });

  it.each([
    ["expired", "This invitation has expired"],
    ["revoked", "This invitation was revoked"],
    ["accepted", "This invitation was already accepted"],
  ] as const)("shows clear %s copy", (status, copy) => {
    render(<InvitationAcceptancePage invitation={{ status }} token="invite_token" />);

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
  });
});
