// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceListingCreatePage } from "./listing-create-page";
import { ListingEvidenceReadiness } from "./listing-evidence-readiness";

function expectTintedCard(root: Element | null, label: string) {
  expect(root, `${label} root`).not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  expect(tokens.has("bg-surface-2"), `${label} includes bg-surface-2`).toBe(true);
  for (const excluded of [
    "ds-glass",
    "border",
    "border-muted",
    "shadow-tokenSm",
    "shadow-tokenLg",
    "ds-glow",
    "hover:border-accent",
    "hover:shadow-tokenMd",
  ])
    expect(tokens.has(excluded), `${label} excludes ${excluded}`).toBe(false);
}

function expectOutlinedPhoto(root: Element | null) {
  expect(root, "active evidence photo root").not.toBeNull();
  const tokens = new Set((root as HTMLElement).className.split(/\s+/));
  for (const included of ["border", "border-muted", "bg-surface"])
    expect(tokens.has(included), `active evidence photo includes ${included}`).toBe(true);
  for (const excluded of [
    "ds-glass",
    "shadow-tokenSm",
    "shadow-tokenLg",
    "ds-glow",
    "hover:border-accent",
    "hover:shadow-tokenMd",
  ])
    expect(tokens.has(excluded), `active evidence photo excludes ${excluded}`).toBe(false);
}

const acerolaProductSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "form" },
    { dimensionId: "condition" },
    { dimensionId: "grading_company" },
    { dimensionId: "grade" },
  ],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "graded", code: "graded", label: "Graded" },
        { optionId: "raw", code: "raw", label: "Raw" },
      ],
    },
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["raw"] }],
      allowedOptions: [
        { optionId: "damaged", code: "damaged", label: "Damaged" },
        { optionId: "near_mint", code: "near_mint", label: "Near Mint" },
      ],
    },
    {
      dimensionId: "grading_company",
      dimensionName: "Grading Company",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "psa", code: "psa", label: "PSA" }],
    },
    {
      dimensionId: "grade",
      dimensionName: "Grade",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "gem_mint_10", code: "gem_mint_10", label: "Gem Mint 10" }],
    },
  ],
};

const acerolaItem = {
  catalog_item_id: "cat_acerola",
  language_code: "en",
  title: "Acerola's Mischief",
  subtitle: "Base Set",
  blueprint_id: null,
  status: "active",
  product_schema: acerolaProductSchema,
  updated_at: "2026-10-01T00:00:00.000Z",
};

// Alias suggestions for "ETB": neither label contains the typed text, and the server order is not alphabetical.
const etbSuggestions = [
  {
    catalogItemId: "cat_surging_etb",
    title: "Surging Sparks Elite Trainer Box",
    subtitle: null,
    slug: "surging-sparks-elite-trainer-box",
    category: "Pokemon TCG",
  },
  {
    catalogItemId: "cat_acerola",
    title: "Acerola's Mischief",
    subtitle: "Base Set",
    slug: "acerolas-mischief",
    category: "Pokemon TCG",
  },
];

const SUGGEST_URL = "/api/marketplace/items/suggest";
const CATALOG_ITEM_URL = "/api/inventory/catalog-items";
const ALLOWED_PICKER_REQUEST =
  /^\/api\/marketplace\/items\/suggest\?q=[^&]+$|^\/api\/inventory\/catalog-items\/[^/?&]+$/;

type PickerRequest = { url: string; signal: AbortSignal | null };
let pickerRequests: PickerRequest[] | null = null;

function stubPickerFetch(respond: (url: string) => Response | Promise<Response>) {
  const requests: PickerRequest[] = [];
  pickerRequests = requests;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, signal: init?.signal ?? null });
      return Promise.resolve(respond(url));
    }),
  );
  return requests;
}

function catalogRoutes(routes: Record<string, () => Response | Promise<Response>>) {
  return (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`Unexpected picker request ${url}`);
    return route();
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function renderPicker(createForm?: Parameters<typeof MarketplaceListingCreatePage>[0]["createForm"]) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return render(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation createForm={createForm} />);
}

function catalogInput() {
  return screen.getByRole("combobox", { name: "Search catalog" }) as HTMLInputElement;
}

// A typed or pasted edit carries an inputType; without one the Combobox treats it as autofill and stays closed.
function editCatalogInput(value: string) {
  fireEvent.input(catalogInput(), { target: { value }, inputType: "insertText" });
}

function catalogStatus() {
  return document.getElementById(`${catalogInput().id}-status`)?.textContent ?? null;
}

function optionLabels() {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}

function submitted(container: HTMLElement) {
  const form = container.querySelector("form") as HTMLFormElement;
  const data = new FormData(form);
  return { catalogItemId: data.get("catalogItemId"), selectedOptions: data.get("selectedOptions") };
}

// Queried by intent value: an open Combobox popup hides the rest of the page from the accessibility tree.
function intentButton(intent: string) {
  const button = document.querySelector(`button[name="intent"][value="${intent}"]`);
  expect(button, intent).not.toBeNull();
  return button as HTMLButtonElement;
}

function expectMutations(state: "blocked" | "allowed") {
  for (const intent of ["preview-listing", "create-listing"]) {
    expect(intentButton(intent).disabled, `${intent} ${state}`).toBe(state === "blocked");
  }
  if (state === "blocked") {
    expect(intentButton("create-and-publish-listing").disabled).toBe(true);
  }
}

function chooseOption(name: RegExp) {
  fireEvent.click(screen.getByRole("option", { name }));
}

afterEach(() => {
  const requests = pickerRequests ?? [];
  pickerRequests = null;
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Every picker trace may only reach the seller suggestion route or one exact Catalog item.
  for (const request of requests) {
    expect(request.url).toMatch(ALLOWED_PICKER_REQUEST);
  }
});

describe("marketplace listing create page", () => {
  it("renders the create-listing form as tinted furniture", () => {
    const { container } = render(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation />);

    expectTintedCard(
      container.querySelector('button[name="intent"][value="create-listing"]')?.closest(".rounded-tokenLg") ?? null,
      "create-listing form",
    );
  });

  it("directly renders a populated evidence photo as an outlined entity", () => {
    render(
      <ListingEvidenceReadiness
        listing={
          {
            status: "draft",
            evidence: [
              {
                photoId: "lpho_create_1",
                altText: "Create flow active photo",
                slotId: null,
                viewKind: null,
                status: "active",
                sortOrder: 0,
              },
            ],
            evidence_readiness: {
              ready: true,
              policy: {
                policyId: null,
                policyVersion: null,
                policyHash: "sha256:test",
                requirementHash: "sha256:req",
                evaluatedAt: "2026-08-19T00:00:00.000Z",
                explanationCodes: [],
              },
              requirements: {
                minimumPhotoCount: 1,
                requiredSlots: [],
                sellerTrustRequirements: [],
                buyerAcknowledgment: "none",
              },
              coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 1, minimumPhotoCount: 1 },
              nextActions: [],
              publicGallery: [],
            },
          } as never
        }
      />,
    );

    expectOutlinedPhoto(screen.getByText("Create flow active photo").closest(".rounded-tokenLg"));
  });

  it("keeps create-listing multipart payload fields after migration to shared Form", () => {
    const markup = renderToString(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation />);

    expect(markup).toContain('method="post"');
    expect(markup).toMatch(/encType="multipart\/form-data"|enctype="multipart\/form-data"/);
    expect(markup).toContain('name="selectedOptions"');
    expect(markup).toContain('name="catalogItemId"');
    expect(markup).toContain('name="priceAmount"');
    expect(markup).toContain('name="priceCurrencyCode"');
    expect(markup).not.toContain('name="priceCurrencyCode" value="USD"');
    expect(markup).toContain('name="quantityCap"');
    expect(markup).toContain('name="evidence"');
    expect(markup).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(markup).toContain('value="create-and-publish-listing"');
    expect(markup).toContain('value="preview-listing"');
    expect(markup).toContain('value="create-listing"');
  });

  it("renders catalog item creation as one suggestion picker whose submitted ID is hidden, not a raw ID field", () => {
    const markup = renderToString(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation />);

    expect(markup).toContain("Search catalog");
    expect(markup).toMatch(/<input[^>]*role="combobox"/);
    expect(markup).not.toMatch(/<select[^>]*name="catalogItemId"/);
    expect(markup.match(/<input[^>]*name="catalogItemId"[^>]*>/g)).toEqual([
      expect.stringMatching(/type="hidden"(?=[^>]*value="")/),
    ]);
  });

  it("keeps create-and-publish honest when server-owned evidence readiness is incomplete", () => {
    const markup = renderToString(
      <MarketplaceListingCreatePage
        inventoryItems={[]}
        hasListingStockLocation
        evidenceReadiness={{
          ready: false,
          policy: {
            policyId: "pol_1",
            policyVersion: 2,
            policyHash: "sha256:test",
            requirementHash: "sha256:requirement",
            evaluatedAt: "2026-07-13T00:00:00.000Z",
            explanationCodes: ["configured-evidence"],
          },
          requirements: {
            minimumPhotoCount: 1,
            requiredSlots: [],
            sellerTrustRequirements: [],
            buyerAcknowledgment: "none",
          },
          coverage: {
            complete: false,
            unmetCodes: ["min-photo-count-unmet"],
            slots: [],
            activePhotoCount: 0,
            minimumPhotoCount: 1,
          },
          nextActions: [
            {
              code: "min-photo-count-unmet",
              localeKey: "marketplace.features.listings.evidenceCoverage.min-photo-count-unmet",
              slotIds: [],
            },
          ],
          publicGallery: [],
        }}
      />,
    );

    expect(markup).toContain("Evidence required");
    expect(markup).toContain("Add more photos to meet the required number of evidence images.");
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*value="create-and-publish-listing")[^>]*>/);
    expect(markup).toContain('capture="environment"');
  });

  it("blocks create-and-publish for selected inventory without a shipping measure", () => {
    render(
      <MarketplaceListingCreatePage
        inventoryItems={[
          {
            item_id: "inv_missing_measure",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::raw",
            item_language_code: "en",
            item_title: "Charizard",
            item_subtitle: "Base Set",
            selected_options: [],
            product_summary: "Raw",
            product_measure_snapshot: null,
            graded_card: null,
            storage_location_id: "loc_1",
            storage_location_name: "North shelf",
            ship_from_code: "CHI",
            ship_from_address: {
              name: "Seller Shipping",
              line1: "1 Warehouse Way",
              city: "Chicago",
              state: "IL",
              postalCode: "60601",
              country: "US",
            },
            total_quantity: 1,
            available_quantity: 1,
            acquisition_cost_amount: null,
            acquisition_cost_currency_code: null,
          },
        ]}
        hasListingStockLocation
        createForm={{
          inventoryItemId: "inv_missing_measure",
          priceAmount: "20.00",
          quantityCap: "1",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Create and publish" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Resolve the catalog shipping measure before creating an active listing from this inventory."),
    ).toBeTruthy();
    // Inventory Item-first creation is owned by the selected inventory, not the catalog picker.
    expect(screen.getByRole("button", { name: "Save as draft" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Preview fees" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("listing create catalog picker", () => {
  const etbUrl = `${SUGGEST_URL}?q=ETB`;
  const acerolaUrl = `${CATALOG_ITEM_URL}/cat_acerola`;
  const graded = JSON.stringify([
    { dimensionId: "form", optionId: "graded" },
    { dimensionId: "grading_company", optionId: "psa" },
    { dimensionId: "grade", optionId: "gem_mint_10" },
  ]);
  const noSubmission = { catalogItemId: "", selectedOptions: "[]" };

  it("keeps a blank create idle and request-free", async () => {
    const requests = stubPickerFetch(catalogRoutes({}));
    const { container } = renderPicker();

    await settle(1000);

    expect(requests).toEqual([]);
    expect(catalogStatus()).toBe("Select a catalog item");
    expect(document.getElementById(`${catalogInput().id}-status`)?.getAttribute("aria-live")).toBe("polite");
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");
  });

  it.each(["E", "  E  "])("treats the trimmed one-character edit %j as idle with zero requests", async (value) => {
    const requests = stubPickerFetch(catalogRoutes({}));
    renderPicker();

    editCatalogInput(value);
    await settle(1000);

    expect(requests).toEqual([]);
    expect(catalogStatus()).toBe("Select a catalog item");
    expect(optionLabels()).toEqual([]);
  });

  it("settles 250 ms, asks only /suggest, and renders alias labels unfiltered in server order without selecting", async () => {
    const requests = stubPickerFetch(
      catalogRoutes({ [etbUrl]: () => Response.json({ items: etbSuggestions, count: 2 }) }),
    );
    const { container } = renderPicker();

    editCatalogInput("  ETB ");
    await settle(249);
    expect(requests).toEqual([]);
    expect(catalogStatus()).toBe("Searching catalog items...");

    await settle(1);
    expect(requests.map((request) => request.url)).toEqual([etbUrl]);
    expect(optionLabels()).toEqual(["Surging Sparks Elite Trainer BoxPokemon TCG", "Acerola's MischiefBase Set"]);
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"))).not.toContain("true");
    expect(catalogStatus()).toBe("Choose the catalog item from the visible search results.");
    expect(catalogInput().value).toBe("  ETB ");
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");
  });

  it("restores an initial active ID with one encoded exact GET, zero suggestions, and the caller's options", async () => {
    const encodedUrl = `${CATALOG_ITEM_URL}/cat_acerola%231`;
    const requests = stubPickerFetch(
      catalogRoutes({ [encodedUrl]: () => Response.json({ ...acerolaItem, catalog_item_id: "cat_acerola#1" }) }),
    );
    const { container } = renderPicker({
      catalogItemId: " cat_acerola#1 ",
      selectedOptions: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "damaged" },
      ],
      priceAmount: "21.74",
      priceCurrencyCode: "EUR",
      quantityCap: "1",
    });

    expect(requests.map((request) => request.url)).toEqual([encodedUrl]);
    await settle(1000);

    expect(requests.map((request) => request.url)).toEqual([encodedUrl]);
    expect(catalogInput().value).toBe("Acerola's Mischief");
    expect(catalogStatus()).toBeNull();
    expect(submitted(container)).toEqual({
      catalogItemId: "cat_acerola#1",
      selectedOptions: JSON.stringify([
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "damaged" },
      ]),
    });
    expect(screen.getByLabelText("Condition")).toBeTruthy();
    expect(screen.queryByLabelText("Grading Company")).toBeNull();
    expect(screen.queryByLabelText("Grade")).toBeNull();
    expect((screen.getByLabelText("Price currency code") as HTMLInputElement).value).toBe("EUR");
    expectMutations("allowed");
  });

  it.each([
    [
      "missing",
      () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
      "No active catalog items matched that search.",
    ],
    [
      "inactive",
      () => Response.json({ ...acerolaItem, status: "archived" }),
      "No active catalog items matched that search.",
    ],
    [
      "mismatched",
      () => Response.json({ ...acerolaItem, catalog_item_id: "cat_other" }),
      "No active catalog items matched that search.",
    ],
    ["failing", () => Response.json({ error: "unavailable" }, { status: 503 }), "Catalog item lookup failed."],
  ])("fails an initial %s ID visibly with no suggestion fallback", async (_case, respond, message) => {
    const requests = stubPickerFetch(catalogRoutes({ [acerolaUrl]: respond }));
    const { container } = renderPicker({
      catalogItemId: "cat_acerola",
      selectedOptions: [{ dimensionId: "form", optionId: "raw" }],
    });

    await settle(1000);

    expect(requests.map((request) => request.url)).toEqual([acerolaUrl]);
    expect(catalogStatus()).toBe(message);
    expect(catalogInput().value).toBe("cat_acerola");
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");
  });

  it.each([
    {
      stale: "an option the current schema no longer allows",
      initial: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "mint_plus" },
      ],
      formValue: "raw",
      clearedDimension: "Condition",
      resolve: { label: "Condition", value: "near_mint" },
      resolved: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "near_mint" },
      ],
    },
    {
      stale: "a parent option with dependent options",
      initial: [
        { dimensionId: "form", optionId: "foil" },
        { dimensionId: "condition", optionId: "damaged" },
      ],
      formValue: "",
      clearedDimension: "Form",
      resolve: { label: "Form", value: "raw" },
      resolved: [
        { dimensionId: "form", optionId: "raw" },
        { dimensionId: "condition", optionId: "damaged" },
      ],
    },
  ])("clears stale initial options for $stale and blocks mutations until the seller chooses", async (scenario) => {
    const requests = stubPickerFetch(catalogRoutes({ [acerolaUrl]: () => Response.json(acerolaItem) }));
    const { container } = renderPicker({ catalogItemId: "cat_acerola", selectedOptions: scenario.initial });

    await settle(0);

    const notice = "Product options changed since this listing was started. Choose the current options to continue.";
    expect(screen.getByText(notice)).toBeTruthy();
    expect((screen.getByLabelText("Form") as HTMLSelectElement).value).toBe(scenario.formValue);
    expect((screen.getByLabelText(scenario.clearedDimension) as HTMLSelectElement).value).toBe("");
    if (scenario.clearedDimension === "Form") {
      expect(screen.queryByLabelText("Condition")).toBeNull();
    }
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");

    fireEvent.change(screen.getByLabelText(scenario.resolve.label), { target: { value: scenario.resolve.value } });
    if (scenario.clearedDimension === "Form") {
      expect((screen.getByLabelText("Condition") as HTMLSelectElement).value).toBe("");
      expectMutations("blocked");
      fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "damaged" } });
    }

    expect(screen.queryByText(notice)).toBeNull();
    expect(submitted(container)).toEqual({
      catalogItemId: "cat_acerola",
      selectedOptions: JSON.stringify(scenario.resolved),
    });
    expectMutations("allowed");
    await settle(1000);
    expect(requests.map((request) => request.url)).toEqual([acerolaUrl]);
  });

  it("hydrates a pasted ID with one exact GET as an unselected candidate, then selects it request-free", async () => {
    const requests = stubPickerFetch(catalogRoutes({ [acerolaUrl]: () => Response.json(acerolaItem) }));
    const { container } = renderPicker();

    editCatalogInput("  cat_acerola ");
    await settle(249);
    expect(requests).toEqual([]);
    await settle(1);

    expect(requests.map((request) => request.url)).toEqual([acerolaUrl]);
    expect(optionLabels()).toEqual(["Acerola's MischiefBase Set"]);
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");

    chooseOption(/Acerola's Mischief/);
    await settle(1000);

    expect(requests.map((request) => request.url)).toEqual([acerolaUrl]);
    expect(catalogInput().value).toBe("Acerola's Mischief");
    expect(screen.getByLabelText("Form")).toBeTruthy();
    expect(submitted(container)).toEqual({ catalogItemId: "cat_acerola", selectedOptions: graded });
    expectMutations("allowed");
  });

  it("fails a pasted unknown ID visibly without falling back to suggestions", async () => {
    const missingUrl = `${CATALOG_ITEM_URL}/cat_missing`;
    const requests = stubPickerFetch(
      catalogRoutes({ [missingUrl]: () => Response.json({ error: { code: "not_found" } }, { status: 404 }) }),
    );
    const { container } = renderPicker();

    editCatalogInput("cat_missing");
    await settle(1000);

    expect(requests.map((request) => request.url)).toEqual([missingUrl]);
    expect(catalogStatus()).toBe("No active catalog items matched that search.");
    expect(optionLabels()).toEqual([]);
    expect(submitted(container)).toEqual(noSubmission);
  });

  it("hydrates an explicit suggestion choice before Options, keeps re-choice request-free, and resets on edit", async () => {
    const hydration = deferredResponse();
    const requests = stubPickerFetch(
      catalogRoutes({
        [etbUrl]: () => Response.json({ items: etbSuggestions, count: 2 }),
        [acerolaUrl]: () => hydration.promise,
        [`${SUGGEST_URL}?q=Acerola`]: () => Response.json({ items: [], count: 0 }),
      }),
    );
    const { container } = renderPicker();

    editCatalogInput("ETB");
    await settle(250);
    chooseOption(/Acerola's Mischief/);
    await settle(0);

    expect(requests.map((request) => request.url)).toEqual([etbUrl, acerolaUrl]);
    expect(catalogInput().value).toBe("Acerola's Mischief");
    expect(catalogStatus()).toBe("Searching catalog items...");
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");

    hydration.resolve(Response.json(acerolaItem));
    await settle(0);

    expect(screen.getByLabelText("Form")).toBeTruthy();
    expect(submitted(container)).toEqual({ catalogItemId: "cat_acerola", selectedOptions: graded });
    expectMutations("allowed");

    fireEvent.click(screen.getByRole("button", { name: "Search catalog" }));
    chooseOption(/Acerola's Mischief/);
    await settle(1000);
    expect(requests.map((request) => request.url)).toEqual([etbUrl, acerolaUrl]);
    expect(submitted(container)).toEqual({ catalogItemId: "cat_acerola", selectedOptions: graded });

    editCatalogInput("Acerola");
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");
    await settle(250);
    expect(requests.map((request) => request.url)).toEqual([etbUrl, acerolaUrl, `${SUGGEST_URL}?q=Acerola`]);
  });

  it("does not select a chosen suggestion whose exact Catalog item is no longer active", async () => {
    const requests = stubPickerFetch(
      catalogRoutes({
        [etbUrl]: () => Response.json({ items: etbSuggestions, count: 2 }),
        [acerolaUrl]: () => Response.json({ ...acerolaItem, status: "archived" }),
      }),
    );
    const { container } = renderPicker();

    editCatalogInput("ETB");
    await settle(250);
    chooseOption(/Acerola's Mischief/);
    await settle(1000);

    expect(requests.map((request) => request.url)).toEqual([etbUrl, acerolaUrl]);
    expect(catalogStatus()).toBe("No active catalog items matched that search.");
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
    expectMutations("blocked");
  });

  it.each([
    ["empty", () => Response.json({ items: [], count: 0 }), "No active catalog items matched that search."],
    ["error", () => Response.json({ error: "unavailable" }, { status: 503 }), "Catalog item lookup failed."],
    ["network failure", () => Promise.reject(new TypeError("offline")), "Catalog item lookup failed."],
  ])("announces the %s suggestion state in the live status", async (_case, respond, message) => {
    stubPickerFetch(catalogRoutes({ [etbUrl]: respond }));
    renderPicker();

    editCatalogInput("ETB");
    await settle(250);

    expect(catalogStatus()).toBe(message);
    expect(document.getElementById(`${catalogInput().id}-status`)?.getAttribute("aria-live")).toBe("polite");
    expect(optionLabels()).toEqual([]);
  });

  it("aborts a superseded suggestion request and ignores its late response", async () => {
    const stale = deferredResponse();
    const requests = stubPickerFetch(
      catalogRoutes({
        [`${SUGGEST_URL}?q=Char`]: () => stale.promise,
        [`${SUGGEST_URL}?q=Charm`]: () =>
          Response.json({
            items: [
              {
                catalogItemId: "cat_charmander",
                title: "Charmander",
                subtitle: null,
                slug: "charmander",
                category: null,
              },
            ],
            count: 1,
          }),
      }),
    );
    renderPicker();

    editCatalogInput("Char");
    await settle(250);
    editCatalogInput("Charm");
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(catalogStatus()).toBe("Searching catalog items...");
    await settle(250);
    expect(optionLabels()).toEqual(["Charmander"]);

    stale.resolve(
      Response.json({
        items: [
          { catalogItemId: "cat_charizard", title: "Charizard", subtitle: null, slug: "charizard", category: null },
        ],
        count: 1,
      }),
    );
    await settle(0);

    expect(optionLabels()).toEqual(["Charmander"]);
    expect(catalogStatus()).toBe("Choose the catalog item from the visible search results.");
    expect(requests.map((request) => request.url)).toEqual([`${SUGGEST_URL}?q=Char`, `${SUGGEST_URL}?q=Charm`]);
  });

  it.each([
    {
      exact: "pasted ID candidate",
      startExact: async () => {
        editCatalogInput("cat_acerola");
      },
    },
    {
      exact: "explicit suggestion choice",
      startExact: async () => {
        editCatalogInput("ETB");
        await settle(250);
        chooseOption(/Acerola's Mischief/);
      },
    },
  ])("ignores a late exact hydration for a $exact after the seller edits", async ({ startExact }) => {
    const hydration = deferredResponse();
    const requests = stubPickerFetch(
      catalogRoutes({
        [etbUrl]: () => Response.json({ items: etbSuggestions, count: 2 }),
        [acerolaUrl]: () => hydration.promise,
      }),
    );
    const { container } = renderPicker();

    await startExact();
    await settle(250);
    expect(requests.at(-1)?.url).toBe(acerolaUrl);
    editCatalogInput("E");
    expect(requests.at(-1)?.signal?.aborted).toBe(true);

    hydration.resolve(Response.json(acerolaItem));
    await settle(1000);

    expect(catalogStatus()).toBe("Select a catalog item");
    expect(optionLabels()).toEqual([]);
    expect(screen.queryByLabelText("Form")).toBeNull();
    expect(submitted(container)).toEqual(noSubmission);
  });

  it("ignores a late failure from a superseded suggestion request", async () => {
    const stale = deferredResponse();
    stubPickerFetch(
      catalogRoutes({
        [`${SUGGEST_URL}?q=Char`]: () => stale.promise,
        [etbUrl]: () => Response.json({ items: etbSuggestions, count: 2 }),
      }),
    );
    renderPicker();

    editCatalogInput("Char");
    await settle(250);
    editCatalogInput("ETB");
    await settle(250);
    stale.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
    await settle(0);

    expect(catalogStatus()).toBe("Choose the catalog item from the visible search results.");
    expect(optionLabels()).toHaveLength(2);
  });

  it("returns an aborted request to idle when the edit drops below two characters", async () => {
    const stale = deferredResponse();
    const requests = stubPickerFetch(catalogRoutes({ [`${SUGGEST_URL}?q=Ch`]: () => stale.promise }));
    renderPicker();

    editCatalogInput("Ch");
    await settle(250);
    editCatalogInput("C");
    expect(requests[0]?.signal?.aborted).toBe(true);

    stale.resolve(Response.json({ items: etbSuggestions, count: 2 }));
    await settle(1000);

    expect(catalogStatus()).toBe("Select a catalog item");
    expect(optionLabels()).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe("issue-5258-marketplace-ac4 Listing create standards links", () => {
  it("links the canonical community guidelines and support before creating or publishing", () => {
    const { container } = render(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation />);

    const guidelines = screen.getByRole("link", { name: "Community guidelines" });
    const support = screen.getByRole("link", { name: "Contact support" });
    expect(guidelines.getAttribute("href")).toBe("/help/buying/community-guidelines-and-enforcement");
    expect(support.getAttribute("href")).toBe("/contact");
    for (const intent of ["create-and-publish-listing", "create-listing"]) {
      const submit = container.querySelector(`button[name="intent"][value="${intent}"]`)!;
      expect(guidelines.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(support.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});
