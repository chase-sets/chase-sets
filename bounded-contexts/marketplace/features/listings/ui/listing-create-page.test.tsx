// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function stubSearchFetch(items: readonly Record<string, unknown>[]) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    expect(markup).toContain('name="quantityCap"');
    expect(markup).toContain('name="evidence"');
    expect(markup).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(markup).toContain('value="create-and-publish-listing"');
    expect(markup).toContain('value="preview-listing"');
    expect(markup).toContain('value="create-listing"');
  });

  it("renders catalog item creation as a visible search and selection flow, not a raw ID field", () => {
    const markup = renderToString(<MarketplaceListingCreatePage inventoryItems={[]} hasListingStockLocation />);

    expect(markup).toContain("Search catalog");
    expect(markup).toMatch(/<select[^>]*name="catalogItemId"/);
    expect(markup).not.toMatch(/<input[^>]*name="catalogItemId"/);
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

  it("finds a catalog item by title search and lets the seller select it without an ID", async () => {
    vi.stubGlobal(
      "fetch",
      stubSearchFetch([
        {
          catalog_item_id: "cat_acerola",
          title: "Acerola's Mischief",
          subtitle: "Base Set",
          product_schema: acerolaProductSchema,
        },
      ]),
    );

    render(
      <MarketplaceListingCreatePage
        inventoryItems={[]}
        hasListingStockLocation={false}
        catalogItemApiBaseUrl="/catalog-items"
      />,
    );

    fireEvent.change(screen.getByLabelText("Search catalog"), { target: { value: "Acerola" } });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const requestedUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(requestedUrl).toContain("/catalog-items?");
    expect(requestedUrl).toContain("search=Acerola");

    const catalogItemSelect = (await screen.findByLabelText("Catalog item")) as HTMLSelectElement;
    expect(catalogItemSelect.querySelector('option[value="cat_acerola"]')).toBeTruthy();

    fireEvent.change(catalogItemSelect, { target: { value: "cat_acerola" } });

    await screen.findByText("Acerola's Mischief");
    expect(screen.getByLabelText("Form")).toBeTruthy();
  });

  it("preserves claimed draft product options without posting inactive dimensions", async () => {
    vi.stubGlobal(
      "fetch",
      stubSearchFetch([
        {
          catalog_item_id: "cat_acerola",
          title: "Acerola's Mischief",
          subtitle: null,
          product_schema: acerolaProductSchema,
        },
      ]),
    );

    const { container } = render(
      <MarketplaceListingCreatePage
        inventoryItems={[]}
        hasListingStockLocation={false}
        catalogItemApiBaseUrl="/catalog-items"
        createForm={{
          catalogItemId: "cat_acerola",
          selectedOptions: [
            { dimensionId: "form", optionId: "raw" },
            { dimensionId: "condition", optionId: "damaged" },
          ],
          priceAmount: "21.74",
          quantityCap: "1",
        }}
      />,
    );

    await screen.findByText("Acerola's Mischief");

    await waitFor(() =>
      expect((container.querySelector('input[name="selectedOptions"]') as HTMLInputElement | null)?.value).toBe(
        JSON.stringify([
          { dimensionId: "form", optionId: "raw" },
          { dimensionId: "condition", optionId: "damaged" },
        ]),
      ),
    );
    expect(screen.getByLabelText("Form")).toBeTruthy();
    expect(screen.getByLabelText("Condition")).toBeTruthy();
    expect(screen.queryByLabelText("Grading Company")).toBeNull();
    expect(screen.queryByLabelText("Grade")).toBeNull();
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
  });
});
