// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import {
  createMemoryRouter,
  redirect,
  RouterProvider,
  useActionData,
  useNavigation,
  type ActionFunction,
} from "react-router";
import { useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryAdjustmentReasons } from "@chase-sets/event-core/public-event-payloads";
import { hasTranslation } from "@chase-sets/localization";
import { createInventoryApiClient, type InventoryOfflineSaleResult } from "../../../client";
import { InventoryMutationProvider } from "../../../support/request-support/mutation-form";
import type { InventoryCatalogItemSnapshot } from "../integrations/catalog/queries";
import { InventoryItemDetailPage } from "./inventory-item-detail-page";
import { InventoryItemListPage } from "./inventory-item-list-page";
import type { InventoryItemDetail, InventoryItemListItem } from "./contracts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("has an English item-ledger translation for every Inventory adjustment reason", () => {
  for (const reason of inventoryAdjustmentReasons) {
    expect(
      hasTranslation(`inventory.features.inventoryItems.ui.inventoryItemDetailPage.adjustment.reason.${reason}`),
    ).toBe(true);
  }
  expect(
    hasTranslation("inventory.features.inventoryItems.ui.inventoryItemDetailPage.adjustment.reason.synthetic-missing"),
  ).toBe(false);
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
  acquisition_cost_currency_code: null,
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
  acquisition_cost_currency_code: null,
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

  it("labels retained acquisition amounts whose source currency was never recorded", () => {
    const html = renderInventoryRoute(
      <InventoryItemListPage
        data={{ items: [{ ...inventoryItem, acquisition_cost_amount: "4.25" }] }}
        locations={[]}
      />,
    );

    expect(html).toContain("4.25 (currency not recorded)");
    expect(html).not.toContain("$4.25");
  });

  it("renders catalog item creation as a suggestion combobox with an empty identity until a choice hydrates", () => {
    const html = renderInventoryRoute(<InventoryItemListPage data={{ items: [] }} locations={[]} />);

    expect(html).toMatch(/<input[^>]*role="combobox"/);
    expect(html).toContain("Search or paste catalog item");
    expect(html.match(/name="catalogItemId"/g)).toHaveLength(1);
    expect(html).toMatch(/<input(?=[^>]*name="catalogItemId")(?=[^>]*value="")(?=[^>]*type="hidden")/);
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)/);
    expect(html).toMatch(/<input[^>]*name="acquisitionCostCurrencyCode"/);
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

const pickerRequestPattern = /^(\/api\/marketplace\/items\/suggest\?q=[^&]+|\/api\/inventory\/catalog-items\/[^/?&]+)$/;

const conditionSchema: NonNullable<InventoryCatalogItemSnapshot["product_schema"]> = {
  canonicalDimensionOrder: [{ dimensionId: "condition", dimensionName: "Condition" }],
  dimensions: [
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "near_mint", code: "NM", label: "Near Mint" },
        { optionId: "lightly_played", code: "LP", label: "Lightly Played" },
      ],
    },
  ],
};

function catalogSnapshot(overrides: Partial<InventoryCatalogItemSnapshot> = {}): InventoryCatalogItemSnapshot {
  return {
    catalog_item_id: "cat_etb",
    language_code: "en",
    title: "Elite Trainer Box",
    subtitle: "Scarlet & Violet",
    blueprint_id: "bpr_sealed",
    status: "active",
    product_schema: conditionSchema,
    updated_at: "2026-05-13T00:00:00.000Z",
    ...overrides,
  };
}

// The alias row's label never contains the typed "ETB"; a default substring filter would hide it.
const etbSuggestions = [
  {
    catalogItemId: "cat_etb",
    title: "Elite Trainer Box",
    subtitle: "Scarlet & Violet",
    slug: "elite-trainer-box-cat-etb",
    category: "Sealed Product",
  },
  { catalogItemId: "cat_etb_case", title: "ETB Case", subtitle: null, slug: "etb-case-cat-etb-case", category: null },
];

function suggestionsResponse(items: readonly unknown[]) {
  return Response.json({ items, count: items.length });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function stubPickerFetch(respond: (url: string) => Response | Promise<Response>) {
  const fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(respond(String(input))));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestedUrls(fetch: { mock: { calls: ReadonlyArray<readonly [RequestInfo | URL, RequestInit?]> } }) {
  return fetch.mock.calls.map(([input]) => String(input));
}

function expectOnlyPickerRequests(fetch: Parameters<typeof requestedUrls>[0]) {
  for (const url of requestedUrls(fetch)) {
    expect(url).toMatch(pickerRequestPattern);
  }
}

// Mirrors the account-inventory route: the create form is writable only inside the recovery provider.
function renderCreateItemForm(
  props: Partial<ComponentProps<typeof InventoryItemListPage>> = {},
  action?: ActionFunction,
) {
  function CreatePage() {
    const result = useActionData() as { error?: string } | undefined;
    const navigation = useNavigation();
    return (
      <InventoryMutationProvider
        authority={{ accountId: "acc_1", actorUserId: "usr_1" }}
        navigationPending={navigation.state !== "idle"}
      >
        <InventoryItemListPage
          data={{ items: [] }}
          locations={[]}
          {...props}
          errorMessage={result?.error ?? props.errorMessage}
        />
      </InventoryMutationProvider>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <CreatePage />,
        action,
      },
      { path: "/account/inventory/items/:id", element: <p>Created inventory item</p> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  const input = screen.getByRole("combobox", { name: "Catalog item" }) as HTMLInputElement;
  const form = input.closest("form")!;
  expect(form.getAttribute("aria-disabled")).toBeNull();
  return { input, form, router };
}

function hiddenCatalogItemId() {
  return (document.querySelector('input[name="catalogItemId"]') as HTMLInputElement).value;
}

function createButton() {
  // An open listbox hides the rest of the page from the accessibility tree; the gate is read either way.
  return screen.getByRole("button", { name: "Create inventory item", hidden: true }) as HTMLButtonElement;
}

function optionLabels() {
  return within(screen.getByRole("listbox", { name: "Catalog item" }))
    .queryAllByRole("option")
    .map((option) => option.textContent?.trim());
}

// A bare change event looks like autofill to the combobox, so open it the way a seller's click does first.
async function openAndEnter(user: ReturnType<typeof userEvent.setup>, input: HTMLInputElement, value: string) {
  await user.click(input);
  fireEvent.change(input, { target: { value } });
}

const gradedCreateSchema: NonNullable<InventoryCatalogItemSnapshot["product_schema"]> = {
  canonicalDimensionOrder: [
    { dimensionId: "dim_form", dimensionName: "Form" },
    { dimensionId: "dim_company", dimensionName: "Grading Company" },
    { dimensionId: "dim_grade", dimensionName: "Grade" },
  ],
  dimensions: [
    {
      dimensionId: "dim_form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "opt_raw", code: "raw", label: "Raw" },
        { optionId: "opt_graded", code: "graded", label: "Graded" },
      ],
    },
    {
      dimensionId: "dim_company",
      dimensionName: "Grading Company",
      required: true,
      appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
      allowedOptions: [{ optionId: "opt_psa", code: "psa", label: "PSA" }],
    },
    {
      dimensionId: "dim_grade",
      dimensionName: "Grade",
      required: true,
      appliesWhen: [{ dimensionId: "dim_form", optionIds: ["opt_graded"] }],
      allowedOptions: [{ optionId: "opt_ten", code: "ten", label: "10" }],
    },
  ],
};

describe("inventory create-item graded submission", () => {
  afterEach(() => window.sessionStorage.clear());
  const gradedSelections = [{ dimensionId: "dim_form", optionId: "opt_graded" }];
  const certificationLabel = "Certification number (optional)";

  function setup(
    action: ActionFunction,
    schema = gradedCreateSchema,
    metadata: "graded-selections" | "none" = "graded-selections",
  ) {
    const hydration = deferredResponse();
    stubPickerFetch(() => hydration.promise);
    const view = renderCreateItemForm(
      {
        locations: [{ storage_location_id: "loc_1", account_id: "acc_1", name: "Main shelf" } as never],
        createItemDraft: { catalogItemId: "cat_etb", selectedOptions: [] },
      },
      action,
    );
    return {
      ...view,
      hydrate: () =>
        act(async () => {
          hydration.resolve(
            Response.json(
              catalogSnapshot({
                product_schema: schema,
                ...(metadata === "none" ? {} : { graded_selections: gradedSelections }),
              }),
            ),
          );
        }),
    };
  }

  const gradedOptions = JSON.stringify([
    { dimensionId: "dim_form", optionId: "opt_graded" },
    { dimensionId: "dim_company", optionId: "opt_psa" },
    { dimensionId: "dim_grade", optionId: "opt_ten" },
  ]);
  const rawOptions = JSON.stringify([{ dimensionId: "dim_form", optionId: "opt_raw" }]);

  it.each([
    { form: "cert", certification: "cert-123", selectedOptions: gradedOptions },
    { form: "blank", certification: "   ", selectedOptions: gradedOptions },
    { form: "raw", certification: undefined, selectedOptions: rawOptions },
    { form: "raw-after-cert", certification: undefined, selectedOptions: rawOptions },
    { form: "no-metadata", certification: undefined, selectedOptions: gradedOptions },
  ])(
    "submits the $form form once through pending to the item redirect",
    async ({ form: variant, certification, selectedOptions }) => {
      const user = userEvent.setup();
      const completion = deferredResponse();
      const submissions: FormData[] = [];
      const action = vi.fn<ActionFunction>(async ({ request }) => {
        submissions.push(await request.formData());
        return completion.promise;
      });
      const { form, router, hydrate } = setup(
        action,
        gradedCreateSchema,
        variant === "no-metadata" ? "none" : "graded-selections",
      );
      expect(createButton().disabled).toBe(true);
      expect(screen.getByText("Loading catalog item...")).toBeTruthy();
      expect(new FormData(form).get("catalogItemId")).toBe("");
      await hydrate();
      await waitFor(() => expect(createButton().disabled).toBe(false));
      expect(screen.queryByLabelText(certificationLabel)).toBeNull();
      if (variant !== "raw") {
        await user.selectOptions(screen.getByLabelText("Form"), "opt_graded");
        await waitFor(() => expect((screen.getByLabelText("Grade") as HTMLSelectElement).value).toBe("opt_ten"));
      }
      if (variant === "no-metadata") {
        expect(screen.queryByLabelText(certificationLabel)).toBeNull();
      } else if (variant !== "raw") {
        await user.type(screen.getByLabelText(certificationLabel), certification ?? "stale-cert");
      }
      if (variant === "raw-after-cert") {
        await user.selectOptions(screen.getByLabelText("Form"), "opt_raw");
        await waitFor(() => expect(screen.queryByLabelText("Grade")).toBeNull());
        expect(screen.queryByLabelText(certificationLabel)).toBeNull();
      }
      await user.selectOptions(screen.getByLabelText("Storage location"), "loc_1");
      fireEvent.change(screen.getByLabelText("Total quantity"), { target: { value: "3" } });
      const payload = new FormData(form);
      expect(Object.fromEntries(payload)).toMatchObject({
        intent: "create-item",
        catalogItemId: "cat_etb",
        selectedOptions,
        storageLocationId: "loc_1",
        totalQuantity: "3",
        acquisitionCostAmount: "",
        acquisitionCostCurrencyCode: "",
      });
      expect(payload.getAll("certificationNumber")).toEqual(certification === undefined ? [] : [certification]);
      expect(["gradedCard", "gradingCompany", "grade"].filter((key) => payload.has(key))).toEqual([]);
      await user.click(createButton());
      await waitFor(() => expect(router.state.navigation.state).toBe("submitting"));
      await waitFor(() => expect(createButton().matches(":disabled")).toBe(true));
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(action).toHaveBeenCalledTimes(1);
      expect([...submissions[0].entries()]).toEqual(
        [...payload.entries()].map(([key, value]) =>
          key === "inventoryMutationAttemptId" ? [key, submissions[0].get(key)] : [key, value],
        ),
      );
      await act(async () => completion.resolve(redirect("/account/inventory/items/inv_created")));
      await screen.findByText("Created inventory item");
      expect(router.state.location.pathname).toBe("/account/inventory/items/inv_created");
      expect(router.state.navigation.state).toBe("idle");
    },
  );

  it("leaves missing grading details to Inventory and shows its answer in the existing error card", async () => {
    const user = userEvent.setup();
    const message = "Choose a grading company and grade before creating a Graded inventory item.";
    const action = vi.fn<ActionFunction>(async () => ({ error: message }));
    const schema = {
      ...gradedCreateSchema,
      dimensions: gradedCreateSchema.dimensions.map((dimension) =>
        dimension.dimensionId === "dim_company" ? { ...dimension, required: false } : dimension,
      ),
    };
    const { form, hydrate } = setup(action, schema);
    await hydrate();
    await user.selectOptions(await screen.findByLabelText("Form"), "opt_graded");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Storage location"), "loc_1");
    fireEvent.change(screen.getByLabelText("Total quantity"), { target: { value: "1" } });
    expect(new FormData(form).get("selectedOptions")).toBe(
      JSON.stringify([
        { dimensionId: "dim_form", optionId: "opt_graded" },
        { dimensionId: "dim_grade", optionId: "opt_ten" },
      ]),
    );
    expect(createButton().disabled).toBe(false);
    await user.click(createButton());
    await screen.findByText(message);
    expect(action).toHaveBeenCalledTimes(1);
    expect(hasTranslation("inventory.features.inventoryItems.ui.inventoryItemListPage.graded.details.required")).toBe(
      false,
    );
  });

  it("settles a refused Graded submission without redirecting or resending", async () => {
    const user = userEvent.setup();
    const action = vi.fn<ActionFunction>(async () => ({ error: "Storage location not found." }));
    const { router, hydrate } = setup(action);
    await hydrate();
    await user.selectOptions(await screen.findByLabelText("Form"), "opt_graded");
    await waitFor(() => expect((screen.getByLabelText("Grade") as HTMLSelectElement).value).toBe("opt_ten"));
    await user.selectOptions(screen.getByLabelText("Storage location"), "loc_1");
    fireEvent.change(screen.getByLabelText("Total quantity"), { target: { value: "1" } });
    await user.click(createButton());
    await screen.findByText("Storage location not found.");
    await waitFor(() => expect(screen.queryByText("Submitting Inventory change.")).toBeNull());
    expect(
      screen.getByText(
        "The Inventory result is uncertain. Check the original result or contact support before making another change.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard recovery metadata" })).toBeTruthy();
    expect(router.state.navigation.state).toBe("idle");
    expect(router.state.location.pathname).toBe("/");
    expect(action).toHaveBeenCalledTimes(1);
  });
});
describe("inventory create-item Catalog picker", () => {
  afterEach(() => window.sessionStorage.clear());

  it("renders server-ordered suggestions unfiltered, including an alias label that omits the typed text", async () => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch(() => suggestionsResponse(etbSuggestions));
    const { input } = renderCreateItemForm();

    await openAndEnter(user, input, "ETB");

    await waitFor(() => expect(optionLabels()).toEqual(["Elite Trainer Box - Scarlet & Violet", "ETB Case"]));
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=ETB"]);
    expect(screen.getByText("Choose the catalog item from the visible search results.")).toBeTruthy();
    expect(hiddenCatalogItemId()).toBe("");
  });

  it("stays idle under two trimmed characters and settles 250 ms before one suggestions request", () => {
    vi.useFakeTimers();
    const fetch = stubPickerFetch(() => suggestionsResponse([]));
    const { input } = renderCreateItemForm();

    fireEvent.change(input, { target: { value: " c " } });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText("Searching catalog items...")).toBeNull();

    fireEvent.change(input, { target: { value: " ch " } });
    expect(screen.getByText("Searching catalog items...")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(fetch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=ch"]);
  });

  it.each([
    {
      state: "populated",
      response: () => suggestionsResponse(etbSuggestions),
      status: "Choose the catalog item from the visible search results.",
      invalid: false,
    },
    {
      state: "empty",
      response: () => suggestionsResponse([]),
      status: "No active catalog items matched that search.",
      invalid: false,
    },
    {
      state: "error",
      response: () => Response.json({ error: { message: "Suggestions are unavailable." } }, { status: 503 }),
      status: "Suggestions are unavailable.",
      invalid: true,
    },
  ])("announces the $state suggestions state", async ({ response, status, invalid }) => {
    const fetch = stubPickerFetch(response);
    const { input } = renderCreateItemForm();

    fireEvent.change(input, { target: { value: "ETB" } });

    await screen.findByText(status);
    expect(input.getAttribute("aria-invalid") === "true").toBe(invalid);
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=ETB"]);
    expect(hiddenCatalogItemId()).toBe("");
    expect(createButton().disabled).toBe(true);
  });

  it("aborts superseded suggestions, ignores reverse-order completions, and drops an aborted request on idle", async () => {
    const stale = deferredResponse();
    const latest = deferredResponse();
    const abandoned = deferredResponse();
    const fetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => latest.promise)
      .mockImplementationOnce(() => abandoned.promise);
    vi.stubGlobal("fetch", fetch);
    const { input } = renderCreateItemForm();

    await openAndEnter(userEvent.setup(), input, "char");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "chariz" } });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      latest.resolve(
        suggestionsResponse([
          { catalogItemId: "cat_zard", title: "Charizard", subtitle: null, slug: "charizard", category: null },
        ]),
      );
    });
    await waitFor(() => expect(optionLabels()).toEqual(["Charizard"]));
    await act(async () => {
      stale.resolve(
        suggestionsResponse([
          { catalogItemId: "cat_old", title: "Charmander", subtitle: null, slug: "old", category: null },
        ]),
      );
    });
    expect(optionLabels()).toEqual(["Charizard"]);

    fireEvent.change(input, { target: { value: "charizard ex" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    fireEvent.change(input, { target: { value: "c" } });
    expect(fetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      abandoned.resolve(
        suggestionsResponse([
          { catalogItemId: "cat_late", title: "Late Result", subtitle: null, slug: "late", category: null },
        ]),
      );
    });
    expect(screen.queryByRole("option", { name: "Late Result" })).toBeNull();
    expect(screen.queryByText("Searching catalog items...")).toBeNull();
    expect(requestedUrls(fetch)).toEqual([
      "/api/marketplace/items/suggest?q=char",
      "/api/marketplace/items/suggest?q=chariz",
      "/api/marketplace/items/suggest?q=charizard+ex",
    ]);
  });

  it("loads a pasted Catalog item ID with one exact GET and keeps it unselected until it is chosen", async () => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
    const { input } = renderCreateItemForm();

    await openAndEnter(user, input, "  cat_etb  ");

    const candidate = await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" });
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_etb"]);
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(createButton().disabled).toBe(true);

    await user.click(candidate);

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
    expect(createButton().disabled).toBe(false);
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_etb"]);
  });

  it("restores a create-item handoff ID with one exact GET, zero suggestions, and its saved Options", async () => {
    const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
    const { input } = renderCreateItemForm({
      createItemDraft: {
        catalogItemId: "cat_etb",
        selectedOptions: [{ dimensionId: "condition", optionId: "lightly_played" }],
      },
    });

    expect(screen.getByText("Loading catalog item...")).toBeTruthy();
    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
    expect(input.value).toBe("Elite Trainer Box - Scarlet & Violet");
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("lightly_played");
    expect(createButton().disabled).toBe(false);
    await new Promise((settle) => setTimeout(settle, 300));
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_etb"]);
  });

  it("hydrates only an explicit choice, gates creation on hydration, and keeps a repeat choice request-free", async () => {
    const user = userEvent.setup();
    const hydration = deferredResponse();
    const fetch = stubPickerFetch((url) =>
      url.startsWith("/api/marketplace/") ? suggestionsResponse(etbSuggestions) : hydration.promise,
    );
    const { input, form } = renderCreateItemForm();

    await openAndEnter(user, input, "ETB");
    await user.click(await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" }));

    expect(requestedUrls(fetch)).toEqual([
      "/api/marketplace/items/suggest?q=ETB",
      "/api/inventory/catalog-items/cat_etb",
    ]);
    expect(screen.getByText("Loading catalog item...")).toBeTruthy();
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(createButton().disabled).toBe(true);

    await act(async () => {
      hydration.resolve(Response.json(catalogSnapshot()));
    });
    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
    expect(createButton().disabled).toBe(false);

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" }));
    expect(requestedUrls(fetch)).toHaveLength(2);

    const payload = [...new FormData(form).entries()].map(([key, value]) => [key, String(value)]);
    expect(payload).toEqual(
      expect.arrayContaining([
        ["catalogItemId", "cat_etb"],
        ["selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }])],
        ["selectedOptions:condition", "near_mint"],
      ]),
    );
    const serialized = JSON.stringify(payload);
    for (const metadata of ["elite-trainer-box-cat-etb", "Sealed Product", "Elite Trainer Box", "ETB"]) {
      expect(serialized).not.toContain(metadata);
    }
    expectOnlyPickerRequests(fetch);
  });

  it.each([
    {
      failure: "missing",
      response: () =>
        Response.json({ error: { code: "not_found", message: "Catalog item not found." } }, { status: 404 }),
      message: "Catalog item not found.",
    },
    {
      failure: "inactive",
      response: () => Response.json(catalogSnapshot({ status: "archived" })),
      message: "This catalog item is not active. Choose an active catalog item.",
    },
  ])("clears a $failure choice and blocks creation without a fallback search", async ({ response, message }) => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch((url) =>
      url.startsWith("/api/marketplace/") ? suggestionsResponse(etbSuggestions) : response(),
    );
    const { input } = renderCreateItemForm();

    await openAndEnter(user, input, "ETB");
    await user.click(await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" }));

    await screen.findByText(message);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(createButton().disabled).toBe(true);
    await new Promise((settle) => setTimeout(settle, 300));
    expect(requestedUrls(fetch)).toEqual([
      "/api/marketplace/items/suggest?q=ETB",
      "/api/inventory/catalog-items/cat_etb",
    ]);
  });

  it("refuses stale saved Options, offers the item unselected, and resets Options on an explicit choice", async () => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
    const { input } = renderCreateItemForm({
      createItemDraft: {
        catalogItemId: "cat_etb",
        selectedOptions: [{ dimensionId: "condition", optionId: "damaged" }],
      },
    });

    await screen.findByText(
      "The saved product options no longer match this catalog item. Choose the catalog item again to set its options.",
    );
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(createButton().disabled).toBe(true);

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" }));

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_etb"]);
  });

  it("keeps creation blocked while a hydrated item's required Options are incomplete", async () => {
    stubPickerFetch(() =>
      Response.json(
        catalogSnapshot({
          product_schema: {
            canonicalDimensionOrder: [
              ...conditionSchema.canonicalDimensionOrder,
              { dimensionId: "grade", dimensionName: "Grade" },
            ],
            dimensions: [
              ...conditionSchema.dimensions,
              { dimensionId: "grade", dimensionName: "Grade", required: true, appliesWhen: [], allowedOptions: [] },
            ],
          },
        }),
      ),
    );
    renderCreateItemForm({ createItemDraft: { catalogItemId: "cat_etb", selectedOptions: [] } });

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
    expect(screen.getByLabelText("Grade")).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });

  it("clears the hydrated identity and Options when the seller edits the text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(catalogSnapshot())),
    );
    const { input, form } = renderCreateItemForm({
      createItemDraft: { catalogItemId: "cat_etb", selectedOptions: [] },
    });
    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));

    fireEvent.change(input, { target: { value: "Elite Trainer" } });

    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(createButton().disabled).toBe(true);
    expect(new FormData(form).get("selectedOptions")).toBe("[]");
  });

  it.each([
    {
      path: "pasted",
      text: "cat_etb",
      requests: ["/api/inventory/catalog-items/cat_etb", "/api/inventory/catalog-items/cat_etb"],
    },
    {
      path: "suggested",
      text: "ETB",
      requests: [
        "/api/inventory/catalog-items/cat_etb",
        "/api/marketplace/items/suggest?q=ETB",
        "/api/inventory/catalog-items/cat_etb",
      ],
    },
  ])(
    "does not restore saved Options when the seller edits and then chooses the same $path ID",
    async ({ text, requests }) => {
      const user = userEvent.setup();
      const fetch = stubPickerFetch((url) =>
        url.startsWith("/api/marketplace/") ? suggestionsResponse(etbSuggestions) : Response.json(catalogSnapshot()),
      );
      const { input, form } = renderCreateItemForm({
        createItemDraft: {
          catalogItemId: "cat_etb",
          selectedOptions: [{ dimensionId: "condition", optionId: "lightly_played" }],
        },
      });
      await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("lightly_played");

      await openAndEnter(user, input, text);
      await user.click(await screen.findByRole("option", { name: "Elite Trainer Box - Scarlet & Violet" }));

      await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_etb"));
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
      expect(new FormData(form).get("selectedOptions")).toBe(
        JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]),
      );
      expect(requestedUrls(fetch)).toEqual(requests);
    },
  );

  it("no longer exposes the zero-caller substring Catalog search on the Inventory client", () => {
    expect("searchCatalogItems" in createInventoryApiClient({ fetch: vi.fn() })).toBe(false);
  });
});
