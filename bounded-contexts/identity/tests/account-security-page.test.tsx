import { renderAccountManagementPageToString as renderToString } from "../features/account-management/ui/test-support";
import { describe, expect, it } from "vitest";
import { SecurityPage } from "../features/api-keys/ui/account-security-page";

const user = {
  user_id: "usr_alex",
  display_name: "Alex Clerk",
  given_name: "Alex",
  family_name: "Clerk",
  primary_email: "alex@example.com",
  status: "active",
  contact_methods: [],
  auth_methods: ["password"],
  updated_at: "2026-05-13T12:00:00.000Z",
};

const apiKeys = [
  {
    api_key_id: "key_storefront",
    user_id: "usr_alex",
    user_display_name: "Alex Clerk",
    user_primary_email: "alex@example.com",
    name: "Storefront",
    key_prefix: "key_store_",
    status: "active",
    last_used_at: null,
    updated_at: "2026-05-13T12:00:00.000Z",
  },
];

describe("Marketplace account security page", () => {
  it("renders one localized confirmed active-link action without a subject/email and no inactive control", () => {
    const link = {
      providerName: "google",
      linkKey: "c".repeat(64),
      state: "active" as const,
      linkedAt: user.updated_at,
    };
    const html = renderToString(<SecurityPage user={{ ...user, social_login_links: [link] }} apiKeys={[]} />);
    expect(html).toContain("Remove link");
    expect(html).toContain("Social Login Link");
    expect(html).not.toContain("providerSubject");
    for (const social_login_links of [
      undefined,
      [],
      [{ ...link, state: "revocation-requested" as const }],
      [{ ...link, state: "revoked" as const }],
    ])
      expect(renderToString(<SecurityPage user={{ ...user, social_login_links }} apiKeys={[]} />)).not.toContain(
        "Remove link",
      );
  });
  it("renders a secret supplied from controller memory", () => {
    const html = renderToString(
      <SecurityPage
        user={user}
        apiKeys={apiKeys}
        oneTimeSecret={{
          apiKeyId: "key_storefront",
          keyPrefix: "key_store_",
          secret: "key_marketplace_full_secret_value",
          action: "created",
        }}
      />,
    );

    expect(html).toContain("API key secret created");
    expect(html).toContain("key_marketplace_full_secret_value");
    expect(html).toContain("Copy");
    expect(html).toContain("shown only once");
    expect(html).toContain("Storefront");
  });
});
