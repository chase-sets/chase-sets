import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AccountDetailPage,
  AccountListPage,
  IdentityAdminLayout,
} from "@chase-sets/identity/web";
import { buildCanonicalUrl } from "../root";
import { loader as accountDetailLoader } from "./accounts-detail";
import { loader as accountsLoader, meta as accountsMeta } from "./accounts";

describe("identity admin SSR routes", () => {
  it("renders an account list into HTML before hydration", () => {
    const html = renderToString(
      <IdentityAdminLayout activeKey="accounts">
        <AccountListPage
          initialData={{
            items: [
              {
                account_id: "acc_1",
                name: "North Store LLC",
                display_name: "North Store",
                account_type: "business",
                status: "active",
                updated_at: "2026-03-26T00:00:00.000Z",
              },
            ],
          }}
        />
      </IdentityAdminLayout>,
    );

    expect(html).toContain("Identity Admin");
    expect(html).toContain("North Store");
  });

  it("renders an account detail page into HTML before hydration", () => {
    const html = renderToString(
      <IdentityAdminLayout activeKey="accounts">
        <AccountDetailPage
          data={{
            account_id: "acc_1",
            name: "North Store LLC",
            display_name: "North Store",
            account_type: "business",
            status: "active",
            updated_at: "2026-03-26T00:00:00.000Z",
          }}
        />
      </IdentityAdminLayout>,
    );

    expect(html).toContain("North Store");
    expect(html).toContain("North Store LLC");
  });

  it("loads the account list through the identity API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ items: [], total: 0, count: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    const result = await accountsLoader({
      request: new Request("http://localhost/accounts"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toEqual([]);
  });

  it("loads account detail through the identity API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              account_id: "acc_1",
              name: "North Store LLC",
              display_name: "North Store",
              account_type: "business",
              status: "active",
              updated_at: "2026-03-26T00:00:00.000Z",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const result = await accountDetailLoader({
      request: new Request("http://localhost/accounts/acc_1"),
      params: { id: "acc_1" },
      context: undefined,
    } as never);

    expect(result.data.display_name).toBe("North Store");
  });

  it("builds canonical URLs for identity admin pages", () => {
    expect(
      buildCanonicalUrl({
        origin: "https://identity-admin.example",
        pathname: "/accounts",
      }),
    ).toBe("https://identity-admin.example/accounts");
  });

  it("returns route metadata", () => {
    expect(accountsMeta({} as never)).toEqual([{ title: "Accounts | Identity Admin" }]);
  });
});
