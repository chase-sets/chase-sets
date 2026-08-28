// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import MarketplaceInventoryRoute, {
  action as inventoryAction,
  loader as inventoryLoader,
} from "../routes/marketplace/account-inventory";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function commitHeaders(position: string) {
  return {
    "Chase-Sets-Consistency": "eventual",
    "Chase-Sets-Commit-Position": position,
    "Chase-Sets-Commit-Event-Ids": `evt_inventory_${position}`,
    "Chase-Sets-Commit-Receipt": encodeCommitReceipt([
      {
        sourceContextName: "inventory",
        maxGlobalPosition: position,
        eventIds: [`evt_inventory_${position}`],
      },
    ]),
  };
}

const staleSaleItem = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_sale",
  product_id: "cat_sale::raw",
  language_code: "en",
  item_title: "Sold item",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Condition: Raw",
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "Main shelf",
  ship_from_code: "STL",
  ship_from_address: null,
  total_quantity: 3,
  held_quantity: 0,
  available_quantity: 3,
  acquisition_cost_amount: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

const pageItem = {
  ...staleSaleItem,
  item_id: "inv_page",
  catalog_catalog_item_id: "cat_page",
  product_id: "cat_page::raw",
  item_title: "Page item",
  total_quantity: 4,
  available_quantity: 4,
};

describe("account inventory offline-sale router transition", () => {
  it("survives action serialization, revalidates with the outer receipt, and preserves the selected list location", async () => {
    const requests: { url: string; method: string; headers: Headers }[] = [];
    let listReads = 0;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = request?.url ?? String(input);
        const method = init?.method ?? request?.method ?? "GET";
        const headers = new Headers(init?.headers ?? request?.headers);
        requests.push({ url, method, headers });

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["inventory.view", "inventory.manage"],
              },
            }),
          );
        }
        if (url.includes("/api/inventory/items/inv_1/offline-sales")) {
          return Promise.resolve(
            jsonResponse(
              {
                itemId: "inv_1",
                version: 2,
                requestedQuantity: 1,
                appliedQuantity: 1,
                refusedQuantity: 0,
                collision: null,
              },
              200,
              commitHeaders("91"),
            ),
          );
        }
        if (url.includes("/api/inventory/items/inv_1")) {
          return Promise.resolve(
            jsonResponse({ ...staleSaleItem, total_quantity: 2, available_quantity: 2, holds: [], ledger: [] }),
          );
        }
        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }

        listReads += 1;
        return Promise.resolve(
          jsonResponse({
            items: listReads === 1 ? [staleSaleItem] : [pageItem],
            total: 100,
            count: 1,
            limit: 25,
            offset: 50,
          }),
        );
      }),
    );

    const router = createMemoryRouter(
      [
        {
          path: "/account/inventory",
          loader: inventoryLoader,
          action: async (args) => JSON.parse(JSON.stringify(await inventoryAction(args))),
          element: <MarketplaceInventoryRoute />,
        },
      ],
      {
        initialEntries: [
          {
            pathname: "/account/inventory",
            search: "?query=bulba&limit=25&offset=50",
            state: { returnFocusTo: "inventory-heading" },
          },
        ],
      },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const mobileCards = await waitFor(() => {
      const branch = document.querySelector('[role="list"]');
      expect(branch).not.toBeNull();
      return branch as HTMLElement;
    });
    await user.click(within(mobileCards).getByRole("button", { name: "Record sale" }));
    await user.type(screen.getByLabelText("Quantity sold"), "1");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "card-show");
    await user.click(screen.getByRole("button", { name: "Record sale" }));

    await waitFor(() => {
      const params = new URLSearchParams(router.state.location.search);
      expect(params.get("query")).toBe("bulba");
      expect(params.get("limit")).toBe("25");
      expect(params.get("offset")).toBe("50");
      expect(params.get("offlineSaleItemId")).toBe("inv_1");
      expect(params.get("afterWrite")).toBeTruthy();
    });
    expect(router.state.location.state).toMatchObject({
      returnFocusTo: "inventory-heading",
      offlineSaleResult: { itemId: "inv_1", appliedQuantity: 1 },
    });

    const freshRead = requests.find(
      ({ url }) => url.includes("/api/inventory/items/inv_1") && !url.includes("offline-sales"),
    );
    expect(freshRead?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(await screen.findAllByText("Page item")).toHaveLength(2);
    expect(screen.queryByText("Sold item")).toBeNull();
    await waitFor(() => {
      const result = document.querySelector('[tabindex="-1"][role]');
      expect(result?.textContent).toContain("Authoritative available quantity: 2");
    });
    expect(listReads).toBeGreaterThanOrEqual(2);
  });
});
