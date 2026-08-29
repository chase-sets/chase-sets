// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryOfflineSaleResult } from "../../../client";
import { InventoryItemDetailPage } from "./inventory-item-detail-page";
import { InventoryItemListPage } from "./inventory-item-list-page";
import type { InventoryItemDetail, InventoryItemListItem } from "./contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const inventoryItem: InventoryItemListItem = {
  item_id: "inv_1",
  account_id: "acc_1",
  catalog_catalog_item_id: "cat_1",
  product_id: "cat_1::raw",
  language_code: "ja",
  item_title: "Bulbasaur",
  item_subtitle: "Japanese Base Set",
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
  held_quantity: 1,
  available_quantity: 2,
  acquisition_cost_amount: null,
  created_at: "2026-05-13T00:00:00.000Z",
  updated_at: "2026-05-13T00:00:00.000Z",
};

const elevationRoleAttribute = ["data", "elevation", "role"].join("-");

const offlineSaleInventoryItem: InventoryItemListItem = {
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
        data={{ items: [offlineSaleInventoryItem] }}
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

function markedRoleCount(markup: string, role: "entity" | "furniture") {
  return markup.match(new RegExp(`${elevationRoleAttribute}="${role}"`, "g"))?.length ?? 0;
}

function renderInventoryRoute(element: ReactNode) {
  const router = createMemoryRouter([{ path: "/", element }], { initialEntries: ["/"] });
  return renderToString(<RouterProvider router={router} />);
}

describe("inventory item pages", () => {
  it("renders inventory list language codes as localized labels", () => {
    const html = renderInventoryRoute(<InventoryItemListPage data={{ items: [inventoryItem] }} locations={[]} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("renders catalog item creation as a visible search and selection flow", () => {
    const html = renderInventoryRoute(<InventoryItemListPage data={{ items: [] }} locations={[]} />);

    expect(html).toContain("Search catalog");
    expect(html).toMatch(/<select[^>]*name="catalogItemId"/);
    expect(html).not.toMatch(/<input[^>]*name="catalogItemId"/);
  });

  it("renders inventory detail language codes as localized labels", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("requires an operator adjustment reason and keeps free text plus an optional note", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toMatch(/<select[^>]*name="reasonCode"[^>]*required/);
    expect(html).toContain('<option value="damaged">Damaged</option>');
    expect(html).toContain('<option value="lost">Lost</option>');
    expect(html).toContain('<option value="found">Found</option>');
    expect(html).toContain('<option value="correction">Correction</option>');
    expect(html).toMatch(/<input(?=[^>]*name="reason")(?=[^>]*required)/);
    expect(html).toMatch(/<textarea[^>]*name="note"/);
  });

  it("offers a list-from-inventory action when stock is available", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    // The list-from-inventory drawer trigger replaces the navigate-away create link.
    expect(html).toContain("List it");
    expect(html).not.toContain("/account/listings/new?inventoryItemId=");
  });

  it("hides the list-from-inventory action when nothing is available", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, available_quantity: 0, holds: [], ledger: [] };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).not.toContain("List it");
  });

  it("renders one stay-in-context offline-sale form on detail and one responsive-sheet trigger per list row", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const detailHtml = renderInventoryRoute(
      <InventoryItemDetailPage
        item={detail}
        canRecordOfflineSale={true}
        canHonorOffline={true}
        offlineSaleFormToken="detail-sale-token"
      />,
    );
    const listHtml = renderInventoryRoute(
      <InventoryItemListPage
        data={{ items: [inventoryItem] }}
        locations={[]}
        canRecordOfflineSale={true}
        offlineSaleFormTokens={{ inv_1: "list-sale-token" }}
      />,
    );

    expect(detailHtml.match(/name="intent" value="record-offline-sale"/g)).toHaveLength(1);
    expect(detailHtml).toContain("Record offline sale");
    // DataTable renders one responsive representation for each breakpoint; each has the single row trigger.
    expect(listHtml.match(/Record sale/g)).toHaveLength(2);
    expect(listHtml).not.toContain("/account/inventory/items/inv_1/offline-sales");
  });

  it("renders a receiptless detail result as unverified without completed or authoritative wording", () => {
    const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
    const html = renderInventoryRoute(
      <InventoryItemDetailPage
        item={detail}
        canRecordOfflineSale={true}
        offlineSaleFormToken="detail-sale-token"
        offlineSaleResult={completedSale}
        offlineSaleVerificationState="unverified"
      />,
    );

    expect(html).toContain("could not be verified");
    expect(html).not.toContain("Completed:");
    expect(html).not.toContain("Authoritative available quantity");
  });

  it.each([
    { intent: "record-offline-sale", pageErrorMessage: null, offlineSaleErrorMessage: "Sale failed." },
    { intent: "adjust-item", pageErrorMessage: "Adjustment failed.", offlineSaleErrorMessage: null },
    { intent: "create-hold", pageErrorMessage: "Create hold failed.", offlineSaleErrorMessage: null },
    { intent: "release-hold", pageErrorMessage: "Release hold failed.", offlineSaleErrorMessage: null },
  ])(
    "renders the $intent error exactly once in its owned detail surface",
    ({ pageErrorMessage, offlineSaleErrorMessage }) => {
      const detail: InventoryItemDetail = { ...inventoryItem, holds: [], ledger: [] };
      const message = pageErrorMessage ?? offlineSaleErrorMessage!;
      const html = renderInventoryRoute(
        <InventoryItemDetailPage
          item={detail}
          canRecordOfflineSale={true}
          offlineSaleFormToken="detail-sale-token"
          errorMessage={pageErrorMessage}
          offlineSaleErrorMessage={offlineSaleErrorMessage}
        />,
      );

      expect(html.match(new RegExp(message.replaceAll(".", "\\."), "g"))).toHaveLength(1);
    },
  );

  it("renders order hold provenance without a seller release affordance", () => {
    const detail: InventoryItemDetail = {
      ...inventoryItem,
      ledger: [],
      holds: [
        {
          hold_id: "hld_order",
          account_id: "acc_1",
          item_id: "inv_1",
          quantity: 1,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          source_ref: {
            orderId: "ord_1",
            reservationRequestId: "rsv_1",
          },
          expires_at: null,
          status: "active",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
        {
          hold_id: "hld_manual",
          account_id: "acc_1",
          item_id: "inv_1",
          quantity: 1,
          reason: "Shelf audit",
          notes: null,
          purpose: "manual",
          source_ref: null,
          expires_at: null,
          status: "active",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
      ],
    };
    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(html).toContain("Order");
    expect(html).toContain("/account/sales/ord_1");
    expect(html).toContain("View order ord_1");
    expect(html).toContain("Manual");
    expect(html.match(/name="intent" value="release-hold"/g) ?? []).toHaveLength(1);
  });

  it("renders one marked inventory entity with populated furniture sections", () => {
    const detail: InventoryItemDetail = {
      ...inventoryItem,
      holds: [
        {
          hold_id: "hld_order",
          account_id: "acc_1",
          item_id: "inv_1",
          quantity: 1,
          reason: "Ordering commitment",
          notes: null,
          purpose: "order",
          source_ref: { orderId: "ord_1", reservationRequestId: "rsv_1" },
          expires_at: null,
          status: "active",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
        {
          hold_id: "hld_manual",
          account_id: "acc_1",
          item_id: "inv_1",
          quantity: 1,
          reason: "Shelf audit",
          notes: null,
          purpose: "manual",
          source_ref: null,
          expires_at: null,
          status: "active",
          created_at: "2026-05-13T00:00:00.000Z",
          updated_at: "2026-05-13T00:00:00.000Z",
          released_at: null,
          release_reason: null,
        },
      ],
      ledger: [
        {
          ledger_entry_id: "led_created",
          item_id: "inv_1",
          account_id: "acc_1",
          occurred_at: "2026-05-13T00:00:00.000Z",
          kind: "created",
          quantity_delta: 3,
          hold_quantity: null,
          purpose: null,
          reason: "Inventory item created",
          reason_code: null,
          note: null,
          sale_price_amount: null,
          channel: null,
          source_ref: null,
          actor: "seller",
          event_type: "inventory.item.created",
          stream_id: "inventory-item-inv_1",
          stream_version: 1,
          recorded_at: "2026-05-13T00:00:00.000Z",
        },
        {
          ledger_entry_id: "led_hold",
          item_id: "inv_1",
          account_id: "acc_1",
          occurred_at: "2026-05-13T01:00:00.000Z",
          kind: "hold-placed",
          quantity_delta: null,
          hold_quantity: 1,
          purpose: "order",
          reason: "Ordering commitment",
          reason_code: null,
          note: null,
          sale_price_amount: null,
          channel: null,
          source_ref: { orderId: "ord_1", reservationRequestId: "rsv_1" },
          actor: "system",
          event_type: "inventory.hold.placed",
          stream_id: "inventory-item-inv_1",
          stream_version: 2,
          recorded_at: "2026-05-13T01:00:00.000Z",
        },
      ],
    };

    const html = renderToString(<InventoryItemDetailPage item={detail} />);

    expect(markedRoleCount(html, "entity")).toBe(1);
    expect(markedRoleCount(html, "furniture")).toBe(4);
    expect(html).toContain("Inventory Item Summary");
    expect(html).toContain("Ordering commitment");
    expect(html).toContain("Shelf audit");
    expect(html).toContain("Inventory item created");
    expect(html).not.toContain("No holds have been created");
    expect(html).not.toContain("No stock movements");
    expect({
      headings: (html.match(/<h[1-6]\b/g) ?? []).length,
      forms: (html.match(/<form\b/g) ?? []).length,
      buttons: (html.match(/<button\b/g) ?? []).length,
      definitionLists: (html.match(/<dl\b/g) ?? []).length,
    }).toEqual({ headings: 6, forms: 3, buttons: 8, definitionLists: 0 });
  });
});

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
