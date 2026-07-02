import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountDetailPage } from "../features/accounts/ui/account-detail-page";
import { ApiKeyDetailPage } from "../features/api-keys/ui/api-key-detail-page";
import { UserDetailPage } from "../features/users/ui/user-detail-page";
import { AdminDetailPage } from "../support/shell-support/ui/admin-pages";

const account = {
  account_id: "acc_card_vault",
  account_type: "business",
  badges: ["founding-account"],
  display_name: "Card Vault",
  name: "Card Vault LLC",
  status: "active",
  updated_at: "2026-05-13T12:00:00.000Z",
};

const apiKey = {
  api_key_id: "key_live_ops",
  user_id: "usr_alex",
  user_display_name: "Alex Clerk",
  user_primary_email: "alex@example.com",
  name: "Ops Console",
  key_prefix: "cs_live",
  status: "active",
  last_used_at: null,
  updated_at: "2026-05-13T12:00:00.000Z",
};

const user = {
  user_id: "usr_alex",
  display_name: "Alex Clerk",
  given_name: "Alex",
  family_name: "Clerk",
  primary_email: "alex@example.com",
  status: "active",
  contact_methods: [
    {
      contactMethodId: "ctm_email",
      type: "email",
      value: "alex@example.com",
      verifiedAt: null,
    },
  ],
  auth_methods: ["password"],
  updated_at: "2026-05-13T12:00:00.000Z",
};

describe("Access AdminDetailPage", () => {
  it("renders the canonical detail frame with breadcrumbs, actions, status, and details", () => {
    const html = renderToString(
      <AdminDetailPage
        breadcrumbs={[{ label: "Accounts", href: "/access/accounts" }, { label: "Card Vault" }]}
        title="Card Vault"
        status="active"
        actions={<button type="button">Suspend</button>}
        sections={[
          { label: "Account ID", value: "acc_card_vault" },
          { label: "Legal Name", value: "Card Vault LLC" },
        ]}
      />,
    );

    expect(html).toContain('href="/access/accounts"');
    expect(html).toContain("Card Vault");
    expect(html).toContain("active");
    expect(html).toContain("Suspend");
    expect(html).toContain("Account ID");
    expect(html).toContain("acc_card_vault");
  });

  it("standardizes loading, error, and not-found states", () => {
    const loadingHtml = renderToString(<AdminDetailPage title="Loading account" loading sections={[]} />);
    const errorHtml = renderToString(<AdminDetailPage title="Broken account" error="Database timeout" sections={[]} />);
    const notFoundHtml = renderToString(<AdminDetailPage title="Missing account" notFound sections={[]} />);

    expect(loadingHtml).toContain("Loading identity record");
    expect(errorHtml).toContain("Unable to load identity record");
    expect(errorHtml).toContain("Database timeout");
    expect(notFoundHtml).toContain("Identity record not found");
    expect(notFoundHtml).toContain("does not exist or is no longer available");
  });
});

describe("Access Admin detail pages", () => {
  it("gives account details the shared breadcrumb and detail structure", () => {
    const html = renderToString(<AccountDetailPage data={account} />);

    expect(html).toContain('href="/access/accounts"');
    expect(html).toContain("Accounts");
    expect(html).toContain("Card Vault");
    expect(html).toContain("Founding Account");
    expect(html).toContain("Update Profile");
    expect(html).toContain("Invite Member");
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="accountId"');
    expect(html).toContain('value="acc_card_vault"');
    expect(html).toContain("Remove Founding Account badge");
    expect(html).toContain("Assign Manual Payout Review badge");
    expect(html).toContain("Assign Trusted Seller badge");
    expect(html).not.toMatch(/<h1[^>]*><div/);
  });

  it("gives API key details the shared breadcrumb and action structure", () => {
    const html = renderToString(<ApiKeyDetailPage data={apiKey} />);

    expect(html).toContain('href="/access/api-keys"');
    expect(html).toContain("API Keys");
    expect(html).toContain("Ops Console");
    expect(html).toContain("Rotate");
    expect(html).toContain("Revoke");
  });

  it("surfaces user contact-method and auth-method management controls", () => {
    const html = renderToString(<UserDetailPage data={user} />);

    expect(html).toContain("Create API Key");
    expect(html).toContain("API Key Name");
    expect(html).toContain('name="userId"');
    expect(html).toContain('value="usr_alex"');
    expect(html).toContain("Add Contact Method");
    expect(html).toContain("Verify");
    expect(html).toContain("Enable Auth Method");
    expect(html).toContain("Disable");
    expect(html).toContain("alex@example.com");
    expect(html).toContain("password");
  });
});
