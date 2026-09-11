import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountProfilePage } from "./account-profile-page";

const account = {
  account_id: "acc_card_vault",
  account_type: "business",
  display_name: "Card Vault",
  name: "Card Vault LLC",
  status: "active",
  badges: ["founding-account"],
  updated_at: "2026-05-13T12:00:00.000Z",
};

const actorDisplay = {
  account: {
    account_id: "acc_card_vault",
    display_name: "Card Vault",
    name: "Card Vault LLC",
    badges: ["founding-account"],
  },
  membership: {
    membership_id: "mbr_card_vault_alex",
    role_key: "fulfillment_manager",
  },
  user: {
    user_id: "usr_alex",
    display_name: "Alex Clerk",
    primary_email: "alex@example.com",
  },
};

describe("AccountProfilePage", () => {
  it("shows the signed-in user and selected account before account details", () => {
    const html = renderToString(<AccountProfilePage account={account} actorDisplay={actorDisplay} />);

    expect(html).toContain("Signed-In Identity");
    expect(html).toContain("Card Vault");
    expect(html).toContain("Alex Clerk");
    expect(html).toContain("alex@example.com");
    expect(html).toContain("Unrecognized Membership role");
    expect(html).not.toContain("fulfillment_manager");
    expect(html).toContain("Founding Account");
    expect(html.indexOf("Signed-In Identity")).toBeLessThan(html.indexOf("Marketplace Readiness"));
  });

  it("keeps buyer shipping addresses separate from seller ship-from setup", () => {
    const html = renderToString(<AccountProfilePage account={account} actorDisplay={actorDisplay} />);

    expect(html).toContain('href="/account/shipping-addresses"');
    expect(html).toContain("Manage shipping addresses");
    expect(html).toContain('href="/account/inventory/locations"');
    expect(html).toContain("Manage ship-from locations");
  });
});
