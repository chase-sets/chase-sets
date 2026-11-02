// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InventoryCatalogItemSnapshot } from "../../inventory-items/integrations/catalog/queries";
import type { InventoryStorageLocation } from "../../storage-locations/api/contracts";
import {
  nativeCsvImportAdapter,
  tcgplayerCsvImportAdapter,
  type NormalizedInventoryImportRow,
} from "../domain/import-source-adapters";
import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
import { InventoryImportBatchPage } from "./import-batch-page";
import { InventoryMutationProvider } from "../../../support/ui-support/mutation-recovery";

const timestamp = "2026-05-09T00:00:00.000Z";

function batch(overrides: Partial<InventoryImportBatch> = {}): InventoryImportBatch {
  return {
    batch_id: "imb_1",
    account_id: "acc_1",
    status: "uploaded",
    source_key: "native-csv",
    adapter_version: 1,
    quantity_mode: "add",
    default_storage_location_id: "loc_1",
    total_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    committed_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function row(overrides: Partial<InventoryImportBatchRow> = {}): InventoryImportBatchRow {
  return {
    row_id: "imr_1",
    batch_id: "imb_1",
    row_number: 2,
    status: "accepted",
    raw_row: {},
    external_reference: null,
    row_fingerprint: "native-csv|2|cat_1",
    quantity_mode: "add",
    quantity_delta: 3,
    set_quantity: null,
    source_price_amount: null,
    resolution_status: "native",
    catalog_item_id: "cat_1",
    product_id: "cat_1::condition:near_mint",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    storage_location_id: "loc_1",
    total_quantity: 3,
    acquisition_occurred_at: null,
    acquisition_cost_amount: "1.00",
    acquisition_cost_currency_code: "USD",
    seller_sku: "SKU-1",
    listing_price_amount: "5.00",
    listing_price_currency_code: "USD",
    listing_quantity_cap: 2,
    row_note: null,
    validation_errors: [],
    committed_inventory_item_id: null,
    committed_listing_id: null,
    committed_at: null,
    needs_seller: false,
    created_at: timestamp,
    updated_at: timestamp,
    row_version: "2026-05-09T00:00:00.000001Z",
    ...overrides,
  };
}

function detail(rows: readonly InventoryImportBatchRow[]): InventoryImportBatchDetail {
  const acceptedCount = rows.filter((entry) => entry.status === "accepted" || entry.status === "committed").length;
  const committedCount = rows.filter((entry) => entry.status === "committed").length;
  const rejectedCount = rows.filter((entry) => entry.status === "rejected").length;
  return {
    ...batch({
      total_count: rows.length,
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      committed_count: committedCount,
      status: rows.length > 0 && acceptedCount > 0 && acceptedCount === committedCount ? "committed" : "uploaded",
    }),
    can_commit: acceptedCount > committedCount,
    commit_ready_count: acceptedCount - committedCount,
    rows,
  };
}

describe("InventoryImportBatchPage", () => {
  it("draws commit controls and count only from the API readiness", () => {
    const hidden = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={{ ...detail([row()]), can_commit: false }}
      />,
    );
    expect(hidden).not.toContain('value="commit-batch"');
    const shown = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={{ ...detail([]), status: "committed", can_commit: true, commit_ready_count: 7 }}
      />,
    );
    expect(shown).toContain('value="commit-batch"');
    expect(shown).toContain("7 accepted rows are ready to commit.");
  });

  it("draws the notice, queue and row triggers from needs_seller despite contradictory row facts", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1"
        detail={detail([
          row({ row_id: "imr_api_yes", needs_seller: true }),
          row({
            row_id: "imr_api_no",
            status: "rejected",
            resolution_status: "unresolved",
            product_id: null,
            needs_seller: false,
          }),
        ])}
      />,
    );
    expect(html).toContain("1 rows need you");
    expect(html).toContain("resolveRowId=imr_api_yes");
    expect(html).not.toContain("resolveRowId=imr_api_no");
  });
  it.each(["validating", "failed-safe", "ambiguous", "expired"] as const)("never offers commit while %s", (status) => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={{ ...detail([row()]), status, can_commit: false }}
      />,
    );
    expect(html).not.toContain('value="commit-batch"');
  });
  it("issue-7169-c3-upload-recovery: expiry is visible and never offers commit", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={{ ...detail([row()]), status: "expired", can_commit: false }}
      />,
    );
    expect(html).toContain("Import expired");
    expect(html).toContain("24 hours");
    expect(html).not.toContain('value="commit-batch"');
  });

  it("keeps review rows beyond the first page reachable", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1?offset=100"
        detail={{ ...detail([row()]), total_count: 10_001 }}
      />,
    );
    expect(html).toContain("Previous 100 rows");
    expect(html).toContain("/account/inventory/imports/imb_1?offset=0");
    expect(html).toContain("Next 100 rows");
    expect(html).toContain("/account/inventory/imports/imb_1?offset=200");
  });
  it("renders the empty upload and recent import state", () => {
    const html = renderToString(<InventoryImportBatchPage batches={[]} storageLocations={[]} detail={null} />);

    expect(html).toContain("Inventory import");
    expect(html).toContain("Upload CSV");
    expect(html).toContain("Download native template");
    expect(html).toContain("/api/inventory/import-batches/templates/native-csv");
    expect(html).toContain("Export current inventory");
    expect(html).toContain("/api/inventory/import-batches/exports/native-csv");
    expect(html).toContain("No imports yet");
  });

  it("references each recent import by its batch id", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ batch_id: "imb_recent_synthetic" })]}
        storageLocations={[]}
        detail={null}
      />,
    );

    expect(html).toContain("Recent imports");
    expect(html).toMatch(/>imb_recent_synthetic</);
  });

  it("renders accepted, rejected, and committed row outcomes", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
        detail={detail([
          row(),
          row({
            row_id: "imr_2",
            row_number: 3,
            status: "rejected",
            validation_errors: ["Catalog item was not found."],
            catalog_item_id: "cat_unknown",
            product_id: null,
          }),
          row({
            row_id: "imr_3",
            row_number: 4,
            status: "committed",
            committed_inventory_item_id: "inv_3",
            committed_listing_id: "lst_3",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(html).toContain("Commit accepted rows");
    expect(html).toContain("Catalog item was not found.");
    expect(html).toContain("Inventory item inv_3 created.");
    expect(html).toContain("Draft listing lst_3 created.");
    expect(html).toContain("Cap: 2");
  });

  it("renders a resolve trigger and attention banner for unresolved native rows", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1"
        detail={detail([
          row({
            status: "rejected",
            resolution_status: "unresolved",
            catalog_item_id: null,
            product_id: null,
            storage_location_id: "loc_active",
            validation_errors: ["Seller SKU 'box-a-101' is not mapped for this account."],
            needs_seller: true,
          }),
        ])}
      />,
    );

    // The batch surface shows the resolution work and a deep link into the drawer;
    // the in-cell picker is gone (resolution now happens in the drawer).
    expect(html).toContain("1 rows need you");
    expect(html).toContain("Resolve rows");
    expect(html).toContain("resolveRowId=imr_1");
    expect(html).not.toMatch(/<select[^>]*name="catalogItemId"/);
  });

  it("renders a resolve trigger for Saved List rows that need a location", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ source_key: "saved-list", default_storage_location_id: null })]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1"
        detail={{
          ...detail([
            row({
              status: "rejected",
              storage_location_id: null,
              validation_errors: ["storageLocationId or defaultStorageLocationId is required."],
              needs_seller: true,
            }),
          ]),
          source_key: "saved-list",
          default_storage_location_id: null,
        }}
      />,
    );

    expect(html).toContain("Saved List");
    expect(html).toContain("resolveRowId=imr_1");
    expect(html).not.toMatch(/<select[^>]*name="storageLocationId"/);
  });

  it("renders the all-rejected and fully committed states without commit controls", () => {
    const allRejected = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
        detail={detail([
          row({
            status: "rejected",
            validation_errors: ["Storage location is archived."],
          }),
        ])}
      />,
    );
    const committed = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ status: "committed" })]}
        storageLocations={[]}
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(allRejected).toContain("Storage location is archived.");
    expect(allRejected).not.toContain("Commit accepted rows");
    expect(committed).toContain("Inventory item inv_1 created.");
    expect(committed).toContain("/account/listings/new?inventoryItemId=inv_1");
    expect(committed).not.toContain("Commit accepted rows");
  });

  it("renders mixed committed import outcomes with inventory and listing handoffs", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[
          batch({ status: "committed", total_count: 2, accepted_count: 1, rejected_count: 1, committed_count: 1 }),
        ]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1?afterWrite=fresh&postWriteHandoff=handoff"
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
          row({
            row_id: "imr_2",
            row_number: 3,
            status: "rejected",
            validation_errors: ["Catalog item was not found."],
            catalog_item_id: "cat_missing",
            product_id: null,
          }),
        ])}
      />,
    );

    expect(html).toContain("Inventory item inv_1 created.");
    expect(html).toContain("Catalog item was not found.");
    expect(html).toContain("/account/inventory?afterWrite=fresh&amp;postWriteHandoff=handoff");
    expect(html).toContain(
      "/account/listings/new?inventoryItemId=inv_1&amp;afterWrite=fresh&amp;postWriteHandoff=handoff",
    );
    expect(html).not.toContain("Commit accepted rows");
  });

  it("renders a route-owned import updating notice", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={null}
        detailLoadMessage="The import batch is still updating. Reload this page in a moment."
      />,
    );

    expect(html).toContain("Import still updating");
    expect(html).toContain("The import batch is still updating. Reload this page in a moment.");
  });

  it("preserves import freshness metadata in inventory and listing handoff links", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ status: "committed" })]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1?afterWrite=fresh&postWriteHandoff=handoff"
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(html).toContain("/account/inventory?afterWrite=fresh&amp;postWriteHandoff=handoff");
    expect(html).toContain(
      "/account/listings/new?inventoryItemId=inv_1&amp;afterWrite=fresh&amp;postWriteHandoff=handoff",
    );
  });
});

const pickerRequestPattern = /^(\/api\/marketplace\/items\/suggest\?q=[^&]+|\/api\/inventory\/catalog-items\/[^/?&]+)$/;

const storageLocation: InventoryStorageLocation = {
  storage_location_id: "loc_1",
  account_id: "acc_1",
  name: "Main shelf",
  description: null,
  ship_from_code: "CHI",
  ship_from_address: {
    name: "Chase Sets",
    line1: "100 Market St",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  is_archived: false,
  updated_at: timestamp,
};

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
    catalog_item_id: "cat_zard",
    language_code: "en",
    title: "Charizard",
    subtitle: "Base Set 4/102",
    blueprint_id: "bpr_card",
    status: "active",
    product_schema: conditionSchema,
    updated_at: timestamp,
    ...overrides,
  };
}

// "Lizardon" (Charizard's Japanese name) appears in no suggestion label; a default substring filter hides both.
const lizardonSuggestions = [
  {
    catalogItemId: "cat_zard",
    title: "Charizard",
    subtitle: "Base Set 4/102",
    slug: "charizard-cat-zard",
    category: "Pokemon TCG",
  },
  {
    catalogItemId: "cat_zard_ex",
    title: "Charizard ex",
    subtitle: "Obsidian Flames",
    slug: "charizard-ex",
    category: null,
  },
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

function unresolvedRow(overrides: Partial<InventoryImportBatchRow> = {}): InventoryImportBatchRow {
  return row({
    status: "rejected",
    resolution_status: "unresolved",
    catalog_item_id: null,
    product_id: null,
    selected_options: [],
    validation_errors: ["Catalog item is required."],
    needs_seller: true,
    ...overrides,
  });
}

// Rows exactly as the source adapters normalize them, so the seed reads the persisted adapter fields.
function adapterRow(
  normalized: NormalizedInventoryImportRow | undefined,
  overrides: Partial<InventoryImportBatchRow> = {},
) {
  return unresolvedRow({
    raw_row: normalized!.rawRow,
    external_reference: normalized!.externalReference,
    row_note: normalized!.values.rowNote?.trim() || null,
    ...overrides,
  });
}

function tcgplayerRow(csvText: string) {
  return adapterRow(tcgplayerCsvImportAdapter.normalize({ csvText, quantityMode: "add" })[0]);
}

function renderResolveRow(
  resolveRow: InventoryImportBatchRow,
  sourceKey: InventoryImportBatch["source_key"] = "tcgplayer-csv",
) {
  render(
    <InventoryMutationProvider authority={{ accountId: "acc_1", actorUserId: "usr_1" }}>
      <InventoryImportBatchPage
        batches={[batch({ source_key: sourceKey })]}
        storageLocations={[storageLocation]}
        detail={{ ...detail([resolveRow]), source_key: sourceKey }}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_1"
      />
    </InventoryMutationProvider>,
  );
  const input = screen.getByRole("combobox", { name: "Catalog item" }) as HTMLInputElement;
  return { input, form: input.closest("form")! };
}

function hiddenCatalogItemId() {
  return (document.querySelector('input[name="catalogItemId"]') as HTMLInputElement).value;
}

function applyButton() {
  // An open listbox hides the rest of the drawer from the accessibility tree; the gate is read either way.
  return screen.getByText("Apply row fix").closest("button") as HTMLButtonElement;
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

function settle(ms = 400) {
  return new Promise((done) => setTimeout(done, ms));
}

describe("Import row Catalog picker", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      seed: "platform displayName",
      row: () => tcgplayerRow("SKU,Product Name,Set Name,Condition,Quantity\n8812,Charizard,Base Set,Near Mint,1"),
      query: "Charizard | Base Set | Near Mint",
    },
    {
      seed: "adapter rowNote without a displayName",
      row: () => tcgplayerRow("Product Name,Set Name,Condition,Quantity\nCharizard,Base Set,Near Mint,1"),
      query: "Charizard | Base Set | Near Mint",
    },
    {
      seed: "displayName ahead of a different rowNote (synthetic)",
      row: () =>
        unresolvedRow({
          external_reference: { providerKey: "tcgplayer", externalKey: "sku:8812", displayName: "Charizard ex" },
          row_note: "binder page 4",
        }),
      query: "Charizard ex",
    },
    {
      seed: "blank displayName and rowNote",
      row: () => tcgplayerRow("SKU,Quantity\n8812,1"),
      query: "",
    },
    {
      seed: "native row without evidence",
      row: () =>
        adapterRow(
          nativeCsvImportAdapter.normalize({
            csvText: "catalogItemId,storageLocationId,totalQuantity\n,loc_1,1",
            quantityMode: "add",
          })[0],
        ),
      query: "",
    },
  ])("seeds the $seed without an implicit selection or request", async ({ row: seededRow, query }) => {
    const fetch = stubPickerFetch(() => suggestionsResponse([]));
    const { input } = renderResolveRow(seededRow());

    expect(input.value).toBe(query);
    await settle();
    expect(fetch).not.toHaveBeenCalled();
    expect(hiddenCatalogItemId()).toBe("");
    expect(applyButton().disabled).toBe(true);
    expect(screen.queryByText("Searching catalog items...")).toBeNull();
  });

  it("requests server-ordered alias suggestions for seeded text only after the seller edits it", async () => {
    const fetch = stubPickerFetch(() => suggestionsResponse(lizardonSuggestions));
    const { input } = renderResolveRow(
      tcgplayerRow("SKU,Product Name,Set Name,Condition,Quantity\n8812,Charizard,Base Set,Near Mint,1"),
    );

    await openAndEnter(userEvent.setup(), input, "Lizardon");

    await waitFor(() =>
      expect(optionLabels()).toEqual(["Charizard - Base Set 4/102", "Charizard ex - Obsidian Flames"]),
    );
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=Lizardon"]);
  });

  it.each(["saved-list", "tcgplayer-csv", "native-csv"] as const)(
    "restores a %s row's Catalog item ID with one exact GET ahead of its displayName and rowNote",
    async (sourceKey) => {
      const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
      const { input } = renderResolveRow(
        unresolvedRow({
          catalog_item_id: "cat_zard",
          selected_options: [{ dimensionId: "condition", optionId: "lightly_played" }],
          external_reference: { providerKey: "tcgplayer", externalKey: "sku:8812", displayName: "Charizard holo" },
          row_note: "binder page 4",
        }),
        sourceKey,
      );

      expect(input.value).toBe("");
      expect(screen.getByText("Loading catalog item...")).toBeTruthy();
      await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
      expect(input.value).toBe("Charizard - Base Set 4/102");
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("lightly_played");
      expect(applyButton().disabled).toBe(false);
      await settle();
      expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_zard"]);
    },
  );

  it("loads a pasted Catalog item ID with one exact GET and keeps it unselected until it is chosen", async () => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
    const { input } = renderResolveRow(tcgplayerRow("Product Name,Quantity\nCharizard,1"));

    await openAndEnter(user, input, " cat_zard ");

    const candidate = await screen.findByRole("option", { name: "Charizard - Base Set 4/102" });
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_zard"]);
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(applyButton().disabled).toBe(true);

    await user.click(candidate);

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
    expect(applyButton().disabled).toBe(false);
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_zard"]);
  });

  it("hydrates only an explicit suggestion choice and posts only the hydrated identity and complete Options", async () => {
    const user = userEvent.setup();
    const hydration = deferredResponse();
    const fetch = stubPickerFetch((url) =>
      url.startsWith("/api/marketplace/") ? suggestionsResponse(lizardonSuggestions) : hydration.promise,
    );
    const { input, form } = renderResolveRow(unresolvedRow({ storage_location_id: "loc_1" }));

    await openAndEnter(user, input, "Lizardon");
    await user.click(await screen.findByRole("option", { name: "Charizard - Base Set 4/102" }));

    expect(requestedUrls(fetch)).toEqual([
      "/api/marketplace/items/suggest?q=Lizardon",
      "/api/inventory/catalog-items/cat_zard",
    ]);
    expect(screen.getByText("Loading catalog item...")).toBeTruthy();
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(applyButton().disabled).toBe(true);

    await act(async () => {
      hydration.resolve(Response.json(catalogSnapshot()));
    });
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Charizard - Base Set 4/102" }));
    expect(requestedUrls(fetch)).toHaveLength(2);

    expect([...new FormData(form).entries()].map(([key, value]) => [key, String(value)])).toEqual([
      ["inventoryMutationAttemptId", ""],
      ["intent", "resolve-row"],
      ["batchId", "imb_1"],
      ["rowId", "imr_1"],
      ["expectedRowVersion", "2026-05-09T00:00:00.000001Z"],
      ["expectedRowFingerprint", "native-csv|2|cat_1"],
      ["catalogItemId", "cat_zard"],
      ["selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }])],
      ["storageLocationId", "loc_1"],
    ]);
    for (const url of requestedUrls(fetch)) {
      expect(url).toMatch(pickerRequestPattern);
    }
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
      response: () => Response.json(catalogSnapshot({ status: "retired" })),
      message: "This catalog item is not active. Choose an active catalog item.",
    },
  ])("clears a $failure row ID and blocks the row fix without a fallback search", async ({ response, message }) => {
    const fetch = stubPickerFetch(response);
    const { input } = renderResolveRow(
      unresolvedRow({
        catalog_item_id: "cat_zard",
        external_reference: { providerKey: "tcgplayer", externalKey: "sku:8812", displayName: "Charizard holo" },
      }),
    );

    await screen.findByText(message);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe("");
    expect(hiddenCatalogItemId()).toBe("");
    expect(applyButton().disabled).toBe(true);
    await settle();
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_zard"]);
  });

  it("keeps the row fix blocked while a hydrated item's required Options are incomplete", async () => {
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
    renderResolveRow(unresolvedRow({ catalog_item_id: "cat_zard" }));

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
    expect(screen.getByLabelText("Grade")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
  });

  it("refuses stale row Options, offers the item unselected, and resets Options on an explicit choice", async () => {
    const user = userEvent.setup();
    const fetch = stubPickerFetch(() => Response.json(catalogSnapshot()));
    const { input } = renderResolveRow(
      unresolvedRow({
        catalog_item_id: "cat_zard",
        selected_options: [{ dimensionId: "condition", optionId: "damaged" }],
      }),
    );

    await screen.findByText(
      "The saved product options no longer match this catalog item. Choose the catalog item again to set its options.",
    );
    expect(hiddenCatalogItemId()).toBe("");
    expect(applyButton().disabled).toBe(true);

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "Charizard - Base Set 4/102" }));

    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
    expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
    expect(requestedUrls(fetch)).toEqual(["/api/inventory/catalog-items/cat_zard"]);
  });

  it.each([
    {
      path: "pasted",
      text: " cat_zard ",
      requests: ["/api/inventory/catalog-items/cat_zard", "/api/inventory/catalog-items/cat_zard"],
    },
    {
      path: "suggested",
      text: "Lizardon",
      requests: [
        "/api/inventory/catalog-items/cat_zard",
        "/api/marketplace/items/suggest?q=Lizardon",
        "/api/inventory/catalog-items/cat_zard",
      ],
    },
  ])(
    "does not restore row Options when the seller edits and then chooses the same $path ID",
    async ({ text, requests }) => {
      const user = userEvent.setup();
      const fetch = stubPickerFetch((url) =>
        url.startsWith("/api/marketplace/")
          ? suggestionsResponse(lizardonSuggestions)
          : Response.json(catalogSnapshot()),
      );
      const { input, form } = renderResolveRow(
        unresolvedRow({
          catalog_item_id: "cat_zard",
          selected_options: [{ dimensionId: "condition", optionId: "lightly_played" }],
        }),
      );
      await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("lightly_played");

      await openAndEnter(user, input, text);
      await user.click(await screen.findByRole("option", { name: "Charizard - Base Set 4/102" }));

      await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("near_mint");
      expect(new FormData(form).get("selectedOptions")).toBe(
        JSON.stringify([{ dimensionId: "condition", optionId: "near_mint" }]),
      );
      expect(requestedUrls(fetch)).toEqual(requests);
    },
  );

  it.each([
    {
      state: "populated",
      response: () => suggestionsResponse(lizardonSuggestions),
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
    const { input } = renderResolveRow(unresolvedRow());

    fireEvent.change(input, { target: { value: "Lizardon" } });

    await screen.findByText(status);
    expect(input.getAttribute("aria-invalid") === "true").toBe(invalid);
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=Lizardon"]);
    expect(hiddenCatalogItemId()).toBe("");
  });

  it("stays idle under two trimmed characters and settles 250 ms before one suggestions request", () => {
    vi.useFakeTimers();
    const fetch = stubPickerFetch(() => suggestionsResponse([]));
    const { input } = renderResolveRow(unresolvedRow());

    fireEvent.change(input, { target: { value: " z " } });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText("Searching catalog items...")).toBeNull();

    fireEvent.change(input, { target: { value: "Za" } });
    expect(screen.getByText("Searching catalog items...")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(fetch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(requestedUrls(fetch)).toEqual(["/api/marketplace/items/suggest?q=Za"]);
  });

  it("aborts superseded suggestions, ignores reverse-order completions, and resets Options on edit", async () => {
    const user = userEvent.setup();
    const stale = deferredResponse();
    const latest = deferredResponse();
    const fetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => Promise.resolve(Response.json(catalogSnapshot())))
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => latest.promise);
    vi.stubGlobal("fetch", fetch);
    const { input, form } = renderResolveRow(unresolvedRow({ catalog_item_id: "cat_zard" }));
    await waitFor(() => expect(hiddenCatalogItemId()).toBe("cat_zard"));

    await openAndEnter(user, input, "Lizardon");
    expect(hiddenCatalogItemId()).toBe("");
    expect(screen.queryByLabelText("Condition")).toBeNull();
    expect(new FormData(form).get("selectedOptions")).toBe("[]");
    expect(applyButton().disabled).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.change(input, { target: { value: "Lizardon ex" } });
    expect(fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));

    await act(async () => {
      latest.resolve(suggestionsResponse([lizardonSuggestions[1]]));
    });
    await waitFor(() => expect(optionLabels()).toEqual(["Charizard ex - Obsidian Flames"]));
    await act(async () => {
      stale.resolve(suggestionsResponse([lizardonSuggestions[0]]));
    });
    expect(optionLabels()).toEqual(["Charizard ex - Obsidian Flames"]);
    expect(requestedUrls(fetch)).toEqual([
      "/api/inventory/catalog-items/cat_zard",
      "/api/marketplace/items/suggest?q=Lizardon",
      "/api/marketplace/items/suggest?q=Lizardon+ex",
    ]);
  });
});
