// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { InventoryOfflineSaleResult } from "../../../client";
import type { InventoryItemListItem } from "./contracts";
import { InventoryItemListPage } from "./inventory-item-list-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const inventoryItem: InventoryItemListItem = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::raw",
  language_code: "en",
  item_title: "Bulbasaur",
  item_subtitle: null,
  selected_options: [],
  product_summary: "Condition: Raw",
  graded_card: null,
  storage_location_id: "loc_1",
  storage_location_name: "Main shelf",
  ship_from_code: "STL",
  ship_from_address: {
    name: "Chase Sets",
    line1: "100 Market St",
    city: "St. Louis",
    state: "MO",
    postalCode: "63101",
    country: "US",
  },
  total_quantity: 3,
  held_quantity: 0,
  available_quantity: 3,
  acquisition_cost_amount: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

const completedSale: InventoryOfflineSaleResult = {
  itemId: "inv_1",
  version: 2,
  requestedQuantity: 1,
  appliedQuantity: 1,
  refusedQuantity: 0,
  collision: null,
};

function stubViewport(desktop: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(min-width: 1024px)" ? desktop : false,
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

function renderListHarness() {
  let publishResult!: (result: InventoryOfflineSaleResult) => void;

  function Harness() {
    const [result, setResult] = useState<InventoryOfflineSaleResult | null>(null);
    publishResult = setResult;
    return (
      <InventoryItemListPage
        data={{ items: [inventoryItem] }}
        pagination={{ limit: 25, offset: 0, total: 1 }}
        locations={[]}
        canRecordOfflineSale={true}
        offlineSaleFormTokens={{ inv_1: "sale-token" }}
        offlineSaleResult={result}
        offlineSaleFreshness={result ? { itemId: "inv_1", state: "fresh" } : null}
        offlineSaleAuthoritativeAvailableQuantity={result ? 2 : undefined}
      />
    );
  }

  const router = createMemoryRouter([{ path: "/", element: <Harness /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return { publishResult };
}

describe.each([
  { branch: "mobile", desktop: false, selector: '[role="list"]' },
  { branch: "desktop", desktop: true, selector: ".hidden.md\\:block" },
])("inventory list offline sale on the $branch branch", ({ desktop, selector }) => {
  it("renders one controlled form, dialog, and result and restores focus to the visible invoking trigger", async () => {
    stubViewport(desktop);
    const user = userEvent.setup();
    const { publishResult } = renderListHarness();
    const visibleBranch = document.querySelector(selector);
    expect(visibleBranch).not.toBeNull();
    const visibleTrigger = within(visibleBranch as HTMLElement).getByRole("button", { name: "Record sale" });

    await user.click(visibleTrigger);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.querySelectorAll('form input[name="intent"][value="record-offline-sale"]')).toHaveLength(1);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain(desktop ? "md:right-4" : "lg:hidden");

    act(() => publishResult(completedSale));

    await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
    const results = document.querySelectorAll('[role="status"][tabindex="-1"]');
    expect(results).toHaveLength(1);
    expect(results[0]?.textContent).toContain("Authoritative available quantity: 2");
    await waitFor(() => expect(document.activeElement).toBe(visibleTrigger));
  });
});
