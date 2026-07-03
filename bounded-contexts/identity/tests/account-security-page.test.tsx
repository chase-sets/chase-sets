import { renderToString } from "react-dom/server";
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
  it("reveals a newly created or rotated API key secret exactly from transient action data", () => {
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
