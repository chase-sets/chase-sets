// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { InvitationListPage } from "./invitation-list-page";

function renderWithRouter(element: React.ReactElement) {
  const router = createMemoryRouter([{ path: "/", element }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

describe("InvitationListPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses an account picker for invitation creation", () => {
    const { container } = renderWithRouter(
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
    const markup = container.innerHTML;

    expect(markup).toContain('name="accountId"');
    expect(markup).toContain("<select");
    expect(markup).toContain('value="acc_1"');
    expect(markup).toContain("Card Vault (acc_1)");
    expect(markup).not.toContain('type="text" name="accountId"');
  });

  it("renders URL-persisted status and search filters as applied filter chips", () => {
    renderWithRouter(
      <InvitationListPage
        accounts={[]}
        initialData={{ items: [], total: 0, count: 0, limit: 25, offset: 0 }}
        filters={{ status: "pending", search: "alex@example.com" }}
      />,
    );

    expect(document.body.textContent).toContain("Search: alex@example.com");
    expect(document.body.textContent).toContain("Status: Pending");
  });
});
