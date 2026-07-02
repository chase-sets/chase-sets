import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationListPage } from "./invitation-list-page";

describe("InvitationListPage", () => {
  it("uses an account picker for invitation creation", () => {
    const markup = renderToStaticMarkup(
      <InvitationListPage
        accounts={[
          {
            account_id: "acc_1",
            name: "Card Vault LLC",
            display_name: "Card Vault",
            account_type: "business",
            status: "active",
            badges: [],
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        ]}
        initialData={{
          items: [],
          total: 0,
          count: 0,
          limit: 25,
          offset: 0,
        }}
      />,
    );

    expect(markup).toContain('name="accountId"');
    expect(markup).toContain("<select");
    expect(markup).toContain('value="acc_1"');
    expect(markup).toContain("Card Vault (acc_1)");
    expect(markup).not.toContain('type="text" name="accountId"');
  });
});
