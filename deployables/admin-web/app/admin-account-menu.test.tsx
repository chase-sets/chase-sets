import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { AdminAccountMenu } from "./admin-account-menu";

const actor: ResolvedActor = {
  sessionId: "ses_admin",
  tenantId: "tnt_chase_sets",
  userId: "usr_01HZY6K3G8P8V9Q4T7X2W5N0AB",
  accountId: "acc_01HZY6K3G8P8V9Q4T7X2W5N0CD",
  membershipId: "mbr_01HZY6K3G8P8V9Q4T7X2W5N0EF",
  roleKey: "fulfillment_manager",
  permissions: ["accounts.view"],
};

async function openAccountMenu() {
  const user = userEvent.setup({ document });
  await user.click(screen.getByRole("button", { name: "Account menu" }));
  return screen.findByRole("menu", { name: "Account menu" });
}

describe("AdminAccountMenu", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows real account, user, and role display names from the current actor display", async () => {
    render(
      <AdminAccountMenu
        actor={actor}
        actorDisplay={{
          account: { account_id: actor.accountId, display_name: "Card Vault", name: "Card Vault LLC", badges: [] },
          membership: { membership_id: actor.membershipId, role_key: "fulfillment_manager" },
          user: { user_id: actor.userId, display_name: "Alex Clerk", primary_email: "alex@example.com" },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Account menu" }).textContent).toContain("Card Vault");
    expect(screen.getByRole("button", { name: "Account menu" }).textContent).toContain("Fulfillment Manager");

    const menu = await openAccountMenu();
    expect(within(menu).getByText("Alex Clerk")).toBeTruthy();
    expect(document.body.textContent).not.toContain(actor.accountId);
    expect(document.body.textContent).not.toContain(actor.userId);
  });

  it("falls back to name when display_name is unset, and to the natural id when neither name is available", async () => {
    render(
      <AdminAccountMenu
        actor={actor}
        actorDisplay={{
          account: { account_id: actor.accountId, display_name: null, name: "Card Vault LLC", badges: [] },
          membership: { membership_id: actor.membershipId, role_key: "owner" },
          user: { user_id: actor.userId, display_name: null, primary_email: null },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Account menu" }).textContent).toContain("Card Vault LLC");

    const menu = await openAccountMenu();
    expect(within(menu).getByText(actor.userId)).toBeTruthy();
  });

  it("falls back to placeholder labels, never a stripped ULID, when the current actor display is unavailable", async () => {
    render(<AdminAccountMenu actor={actor} actorDisplay={null} />);

    const trigger = screen.getByRole("button", { name: "Account menu" });
    expect(trigger.textContent).toContain("Admin account");
    expect(trigger.textContent).toContain("Fulfillment Manager");

    const menu = await openAccountMenu();
    expect(within(menu).getByText("Admin user")).toBeTruthy();
    expect(document.body.textContent).not.toContain(actor.accountId);
    expect(document.body.textContent).not.toContain(actor.userId);
  });
});
