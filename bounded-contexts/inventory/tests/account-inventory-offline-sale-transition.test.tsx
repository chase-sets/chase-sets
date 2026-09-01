// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import MarketplaceInventoryRoute, {
  action as inventoryAction,
  loader as inventoryLoader,
  transitionReceiptlessRetention,
} from "../routes/marketplace/account-inventory";
import MarketplaceInventoryItemRoute, {
  action as inventoryItemAction,
  loader as inventoryItemLoader,
} from "../routes/marketplace/account-inventory-item";

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

function inventoryCommit(position: string) {
  return {
    commandReceipt: {
      mode: "eventual",
      commitPosition: position,
      commitEventIds: [`evt_inventory_${position}`],
      commitPositions: [
        {
          sourceContextName: "inventory",
          maxGlobalPosition: position,
          eventIds: [`evt_inventory_${position}`],
        },
      ],
    },
  };
}

const priorFreshSale = {
  itemId: "inv_1",
  version: 2,
  requestedQuantity: 1,
  appliedQuantity: 1,
  refusedQuantity: 0,
  collision: null,
};

const laterReceiptlessSale = {
  itemId: "inv_1",
  version: 3,
  requestedQuantity: 3,
  appliedQuantity: 2,
  refusedQuantity: 1,
  collision: null,
};

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

function stubMobileViewport() {
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
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("account inventory offline-sale router transition", () => {
  it("applies receiptless retention transitions by location and submission identity", () => {
    const result = laterReceiptlessSale;
    const receiptless = (locationKey: string, itemId = "inv_1", idempotencyKey = "sale-1") => ({
      locationKey,
      stateResult: undefined,
      action: { kind: "receiptless" as const, identity: { itemId, idempotencyKey }, result },
    });
    const actionless = (locationKey: string) => ({ locationKey, stateResult: undefined, action: null });
    const retained = transitionReceiptlessRetention(null, receiptless("loc-1"));

    expect(retained?.result).toBe(result);
    expect(transitionReceiptlessRetention(retained, actionless("loc-1"))).toBe(retained);
    expect(transitionReceiptlessRetention(retained, actionless("loc-2"))).toBeNull();
    expect(
      transitionReceiptlessRetention(retained, {
        locationKey: "loc-1",
        stateResult: undefined,
        action: { kind: "receipt" },
      }),
    ).toBeNull();
    expect(
      transitionReceiptlessRetention(retained, {
        locationKey: "loc-1",
        stateResult: undefined,
        action: { kind: "error", identity: { itemId: "inv_1", idempotencyKey: "sale-1" } },
      }),
    ).toBe(retained);
    expect(
      transitionReceiptlessRetention(retained, {
        locationKey: "loc-1",
        stateResult: undefined,
        action: { kind: "error", identity: { itemId: "inv_2", idempotencyKey: "sale-2" } },
      }),
    ).toBeNull();
  });

  it("survives action serialization, revalidates with the outer receipt, and preserves the selected list location", async () => {
    const requests: { url: string; method: string; headers: Headers }[] = [];
    let listReads = 0;
    stubMobileViewport();
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

  it("retains a later receiptless list result and token through a changed-field conflict", async () => {
    const actionBodies: Record<string, unknown>[] = [];
    let actionCalls = 0;
    let itemReads = 0;
    const receiptlessResponse = deferred<Response>();
    const conflictResponse = deferred<Response>();
    stubMobileViewport();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/api/auth/session")) {
          return jsonResponse({
            actor: {
              sessionId: "ses_1",
              tenantId: "tnt_identity",
              userId: "usr_1",
              accountId: "acc_1",
              membershipId: "mbr_1",
              roleKey: "owner",
              permissions: ["inventory.view", "inventory.manage"],
            },
          });
        }
        if (url.includes("/api/inventory/items/inv_1/offline-sales")) {
          actionCalls += 1;
          const request =
            input instanceof Request ? input.clone() : new Request(new URL(String(input), "http://localhost"), init);
          actionBodies.push((await request.json()) as Record<string, unknown>);
          if (actionCalls === 1) {
            return await receiptlessResponse.promise;
          }
          return await conflictResponse.promise;
        }
        if (url.includes("/api/inventory/items/inv_1")) {
          itemReads += 1;
          return jsonResponse({ ...staleSaleItem, total_quantity: 2, available_quantity: 2, holds: [], ledger: [] });
        }
        if (url.includes("/api/inventory/storage-locations")) {
          return jsonResponse({ items: [], total: 0, count: 0 });
        }
        return jsonResponse({ items: [staleSaleItem], total: 1, count: 1, limit: 25, offset: 0 });
      }),
    );

    const initialPath = appendFreshWriteToken("/account/inventory?offlineSaleItemId=inv_1", inventoryCommit("92"));
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
            search: new URL(initialPath, "http://localhost").search,
            state: { offlineSaleResult: priorFreshSale },
          },
        ],
      },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await screen.findByText(/Completed: 1 units recorded as sold/);
    expect(screen.getByText(/Authoritative available quantity: 2/)).toBeTruthy();
    const mobileCards = await waitFor(() => {
      const branch = document.querySelector('[role="list"]');
      expect(branch).not.toBeNull();
      return branch as HTMLElement;
    });
    await user.click(within(mobileCards).getByRole("button", { name: "Record sale" }));
    const tokenInput = document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
    const activeToken = tokenInput.value;
    const priorLocation = router.state.location;
    await user.type(screen.getByLabelText("Quantity sold"), "3");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "card-show");
    let receiptlessNavigation!: Promise<void>;
    await act(async () => {
      receiptlessNavigation = router.navigate(`${priorLocation.pathname}${priorLocation.search}`, {
        formMethod: "post",
        formData: new FormData(tokenInput.form!),
        state: priorLocation.state,
      });
    });
    expect(router.state.navigation.state).toBe("submitting");
    await act(async () => {
      receiptlessResponse.resolve(jsonResponse(laterReceiptlessSale));
      await receiptlessNavigation;
    });

    expect(router.state.navigation.state).toBe("idle");
    expect(screen.getByText("Recorded 2 units. 1 units were not recorded.")).toBeTruthy();
    expect(screen.getByText(/could not be verified/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Completed:/)).toBeNull());
    expect(screen.queryByText(/Authoritative available quantity/)).toBeNull();
    expect(actionCalls).toBe(1);
    expect(actionBodies).toEqual([expect.objectContaining({ idempotencyKey: activeToken, quantity: 3 })]);
    expect(router.state.location.pathname).toBe(priorLocation.pathname);
    expect(router.state.location.search).toBe(priorLocation.search);
    expect(router.state.location.state).toEqual(priorLocation.state);
    const currentMobileCards = document.querySelector('[role="list"]') as HTMLElement;
    await user.click(within(currentMobileCards).getByRole("button", { name: "Record sale" }));
    const retryTokenInput = document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
    expect(retryTokenInput.value).toBe(activeToken);
    await user.type(screen.getByLabelText("Quantity sold"), "4");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "other");
    let conflictNavigation!: Promise<void>;
    await act(async () => {
      conflictNavigation = router.navigate(`${priorLocation.pathname}${priorLocation.search}`, {
        formMethod: "post",
        formData: new FormData(retryTokenInput.form!),
        state: priorLocation.state,
      });
    });
    expect(router.state.navigation.state).toBe("submitting");
    await act(async () => {
      conflictResponse.resolve(jsonResponse({ error: "This token already records different sale details." }, 409));
      await conflictNavigation;
    });

    expect(router.state.navigation.state).toBe("idle");
    expect(screen.getByText("This token already records different sale details.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Quantity sold") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Sale channel") as HTMLSelectElement).value).toBe("other");
    expect((document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement).value).toBe(activeToken);
    expect(screen.getByText("Recorded 2 units. 1 units were not recorded.")).toBeTruthy();
    expect(screen.getByText(/could not be verified/i)).toBeTruthy();
    expect(screen.queryByText(/Completed:/)).toBeNull();
    expect(screen.queryByText(/Authoritative available quantity/)).toBeNull();
    expect(actionCalls).toBe(2);
    expect(actionBodies).toEqual([
      expect.objectContaining({ idempotencyKey: activeToken, quantity: 3, channel: "card-show" }),
      expect.objectContaining({ idempotencyKey: activeToken, quantity: 4, channel: "other" }),
    ]);
    expect(router.state.location.pathname).toBe(priorLocation.pathname);
    expect(router.state.location.search).toBe(priorLocation.search);
    expect(router.state.location.state).toEqual(priorLocation.state);
    expect(itemReads).toBeGreaterThanOrEqual(2);
  });

  it("retains a later receiptless detail result and token through a changed-field conflict", async () => {
    const actionBodies: Record<string, unknown>[] = [];
    let actionCalls = 0;
    let itemReads = 0;
    const receiptlessResponse = deferred<Response>();
    const conflictResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/api/auth/session")) {
          return jsonResponse({
            actor: {
              sessionId: "ses_1",
              tenantId: "tnt_identity",
              userId: "usr_1",
              accountId: "acc_1",
              membershipId: "mbr_1",
              roleKey: "owner",
              permissions: ["inventory.view", "inventory.manage"],
            },
          });
        }
        if (url.includes("/api/inventory/items/inv_1/offline-sales")) {
          actionCalls += 1;
          const request =
            input instanceof Request ? input.clone() : new Request(new URL(String(input), "http://localhost"), init);
          actionBodies.push((await request.json()) as Record<string, unknown>);
          return await (actionCalls === 1 ? receiptlessResponse.promise : conflictResponse.promise);
        }
        itemReads += 1;
        return jsonResponse({ ...staleSaleItem, total_quantity: 2, available_quantity: 2, holds: [], ledger: [] });
      }),
    );

    const initialPath = appendFreshWriteToken("/account/inventory/items/inv_1", inventoryCommit("93"));
    const initialUrl = new URL(initialPath, "http://localhost");
    const router = createMemoryRouter(
      [
        {
          path: "/account/inventory/items/:itemId",
          loader: inventoryItemLoader,
          action: async (args) => JSON.parse(JSON.stringify(await inventoryItemAction(args))),
          element: <MarketplaceInventoryItemRoute />,
        },
      ],
      {
        initialEntries: [
          { pathname: initialUrl.pathname, search: initialUrl.search, state: { offlineSaleResult: priorFreshSale } },
        ],
      },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await screen.findByText(/Completed: 1 units recorded as sold/);
    expect(screen.getByText(/Authoritative available quantity: 2/)).toBeTruthy();
    const tokenInput = document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
    const activeToken = tokenInput.value;
    const priorLocation = router.state.location;
    await user.type(screen.getByLabelText("Quantity sold"), "3");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "card-show");
    let receiptlessNavigation!: Promise<void>;
    await act(async () => {
      receiptlessNavigation = router.navigate(`${priorLocation.pathname}${priorLocation.search}`, {
        formMethod: "post",
        formData: new FormData(tokenInput.form!),
        state: priorLocation.state,
      });
    });
    expect(router.state.navigation.state).toBe("submitting");
    await act(async () => {
      receiptlessResponse.resolve(jsonResponse(laterReceiptlessSale));
      await receiptlessNavigation;
    });

    expect(router.state.navigation.state).toBe("idle");
    expect(screen.getByText("Recorded 2 units. 1 units were not recorded.")).toBeTruthy();
    expect(screen.getByText(/could not be verified/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Completed:/)).toBeNull());
    expect(screen.queryByText(/Authoritative available quantity/)).toBeNull();
    expect(actionCalls).toBe(1);
    expect(actionBodies).toEqual([expect.objectContaining({ idempotencyKey: activeToken, quantity: 3 })]);
    const retryTokenInput = document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement;
    expect(retryTokenInput.value).toBe(activeToken);
    expect(router.state.location.pathname).toBe(priorLocation.pathname);
    expect(router.state.location.search).toBe(priorLocation.search);
    expect(router.state.location.state).toEqual(priorLocation.state);
    await user.type(screen.getByLabelText("Quantity sold"), "4");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "other");
    let conflictNavigation!: Promise<void>;
    await act(async () => {
      conflictNavigation = router.navigate(`${priorLocation.pathname}${priorLocation.search}`, {
        formMethod: "post",
        formData: new FormData(retryTokenInput.form!),
        state: priorLocation.state,
      });
    });
    expect(router.state.navigation.state).toBe("submitting");
    await act(async () => {
      conflictResponse.resolve(jsonResponse({ error: "This token already records different sale details." }, 409));
      await conflictNavigation;
    });

    expect(router.state.navigation.state).toBe("idle");
    expect(screen.getByText("This token already records different sale details.")).toBeTruthy();
    expect((screen.getByLabelText("Quantity sold") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Sale channel") as HTMLSelectElement).value).toBe("other");
    expect((document.querySelector('input[name="idempotencyKey"]') as HTMLInputElement).value).toBe(activeToken);
    expect(screen.getByText("Recorded 2 units. 1 units were not recorded.")).toBeTruthy();
    expect(screen.getByText(/could not be verified/i)).toBeTruthy();
    expect(screen.queryByText(/Completed:/)).toBeNull();
    expect(screen.queryByText(/Authoritative available quantity/)).toBeNull();
    expect(actionCalls).toBe(2);
    expect(actionBodies).toEqual([
      expect.objectContaining({ idempotencyKey: activeToken, quantity: 3, channel: "card-show" }),
      expect.objectContaining({ idempotencyKey: activeToken, quantity: 4, channel: "other" }),
    ]);
    expect(router.state.location.pathname).toBe(priorLocation.pathname);
    expect(router.state.location.search).toBe(priorLocation.search);
    expect(router.state.location.state).toEqual(priorLocation.state);
    expect(itemReads).toBeGreaterThanOrEqual(2);
  });

  it("retains a receiptless list replay through revalidation without navigating or claiming completion", async () => {
    stubMobileViewport();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
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
            jsonResponse({
              itemId: "inv_1",
              version: 2,
              requestedQuantity: 1,
              appliedQuantity: 1,
              refusedQuantity: 0,
              collision: null,
            }),
          );
        }
        if (url.includes("/api/inventory/storage-locations")) {
          return Promise.resolve(jsonResponse({ items: [], total: 0, count: 0 }));
        }
        return Promise.resolve(jsonResponse({ items: [staleSaleItem], total: 1, count: 1, limit: 25, offset: 0 }));
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
      { initialEntries: ["/account/inventory"] },
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

    await act(async () => {
      await router.revalidate();
    });

    const presentation = await screen.findByText(/could not be verified/i);
    expect(presentation.closest('[role="alert"]')?.textContent).not.toContain("Completed:");
    expect(presentation.closest('[role="alert"]')?.textContent).not.toContain("Authoritative available quantity");
    expect(router.state.location.search).not.toContain("afterWrite");
    expect(router.state.location.search).not.toContain("offlineSaleItemId");
  });

  it("retains a receiptless detail replay as unverified without navigating or claiming completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
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
            jsonResponse({
              itemId: "inv_1",
              version: 2,
              requestedQuantity: 1,
              appliedQuantity: 1,
              refusedQuantity: 0,
              collision: null,
            }),
          );
        }
        return Promise.resolve(jsonResponse({ ...staleSaleItem, holds: [], ledger: [] }));
      }),
    );

    const router = createMemoryRouter(
      [
        {
          path: "/account/inventory/items/:itemId",
          loader: inventoryItemLoader,
          action: async (args) => JSON.parse(JSON.stringify(await inventoryItemAction(args))),
          element: <MarketplaceInventoryItemRoute />,
        },
      ],
      { initialEntries: ["/account/inventory/items/inv_1"] },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await screen.findByText("Sold item");
    await user.type(screen.getByLabelText("Quantity sold"), "1");
    await user.selectOptions(screen.getByLabelText("Sale channel"), "card-show");
    await user.click(screen.getByRole("button", { name: "Record sale" }));

    const presentation = await screen.findByText(/could not be verified/i);
    expect(presentation.closest('[role="alert"]')?.textContent).not.toContain("Completed:");
    expect(presentation.closest('[role="alert"]')?.textContent).not.toContain("Authoritative available quantity");
    expect(router.state.location.search).not.toContain("afterWrite");
  });
});
