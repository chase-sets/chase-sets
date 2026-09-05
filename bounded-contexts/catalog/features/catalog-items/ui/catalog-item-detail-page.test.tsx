// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogItemDetailPage, parseSelectedOptionsInput } from "./catalog-item-detail-page";
import type { CatalogItemDetail, CatalogReferenceRecordRef } from "./contracts";

beforeEach(() => {
  stubCatalogFetches();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const catalogItem: CatalogItemDetail = {
  catalog_item_id: "cat_1",
  language_code: "ja",
  title_i18n: null,
  title: "Bulbasaur",
  subtitle_i18n: null,
  subtitle: "Japanese Base Set",
  display_template_key: null,
  display_identity_hash: null,
  display_identity_resolved_at: null,
  display_identity_publication: {
    status: "current-resolved",
    reason_code: null,
    missing_tokens: [],
    retryable: false,
  },
  description_i18n: null,
  description: "Japanese printed Bulbasaur",
  blueprint: null,
  status: "draft",
  field_values: [],
  categories: [],
  external_catalog_item_references: [],
  external_product_references: [],
  tags: [],
  image_urls: [],
  product_asset_sets: [],
  image_fallback: null,
  updated_at: "2026-05-13T00:00:00.000Z",
};

describe("CatalogItemDetailPage", () => {
  it("renders catalog item language codes as localized labels", () => {
    const html = renderToString(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    expect(html).toContain("Japanese");
    expect(html).not.toContain(">ja<");
  });

  it("does not expose manual title or subtitle controls in metadata editing", () => {
    render(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Description" }));

    const dialog = screen.getByRole("dialog", { name: "Edit Description" });
    expect(within(dialog).queryByLabelText("Title")).toBeNull();
    expect(within(dialog).queryByLabelText("Subtitle")).toBeNull();
    expect(within(dialog).getByLabelText("Description")).toBeTruthy();
  });

  it("keeps an outdated draft editable through failed publish, recheck, and retry", async () => {
    const outdatedItem: CatalogItemDetail = {
      ...catalogItem,
      status: "draft",
      display_identity_publication: {
        status: "outdated",
        reason_code: "display-identity-outdated",
        missing_tokens: [],
        retryable: true,
      },
    };
    stubCatalogFetches({
      publicationResponses: [
        new Response(
          JSON.stringify({
            error: {
              code: "display-identity-outdated",
              message: "Display identity is outdated. Recheck and retry publication.",
              readiness: "outdated",
              missingTokens: [],
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ],
      recheckDetail: {
        ...outdatedItem,
        display_identity_publication: {
          status: "current-resolved",
          reason_code: null,
          missing_tokens: [],
          retryable: false,
        },
      },
    });

    render(<CatalogItemDetailPage id="cat_1" initialData={outdatedItem} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = screen.getByRole("dialog", { name: "Publish Catalog Item" });
    const requiredFields = within(dialog).getByLabelText("Required Field IDs (comma-separated)");
    fireEvent.change(requiredFields, { target: { value: "fld_name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Display identity is outdated");
    expect((requiredFields as HTMLInputElement).value).toBe("fld_name");
    fireEvent.click(within(dialog).getByRole("button", { name: "Recheck display identity" }));
    await waitFor(() => expect(within(dialog).getByText("current-resolved")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish Catalog Item" })).toBeNull());
  });

  it("renders reference field values as flattened clickable detail rows", () => {
    const html = renderToString(
      <CatalogItemDetailPage
        id="cat_1"
        initialData={{
          ...catalogItem,
          field_values: [
            {
              fieldId: "fld_seed_expansion",
              fieldName: "fld_seed_expansion",
              value: { referenceId: "ref_ascended_heroes" },
              reference: {
                referenceId: "ref_ascended_heroes",
                typeKey: "expansion",
                key: "ascended-heroes",
                name: "Ascended Heroes",
                attributes: {
                  "card-count": 217,
                  "release-date": "2026-01-30",
                  abbreviation: "ASC",
                  "source-id": "me02.5",
                },
                relationships: [
                  {
                    relationshipType: "part-of",
                    referenceId: "ref_mega_evolution",
                    reference: {
                      referenceId: "ref_mega_evolution",
                      typeKey: "series",
                      key: "mega-evolution",
                      name: "Mega Evolution",
                      attributes: { "tcgdex-series-id": "mega-evolution" },
                      relationships: [],
                      status: "active",
                    },
                  },
                ],
                status: "active",
              },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Expansion");
    expect(html).toContain("Ascended Heroes");
    expect(html).toContain("Series");
    expect(html).toContain("Mega Evolution");
    expect(html).not.toContain("fld_seed_expansion");
    expect(html).not.toContain("card-count: 217");
  });

  it("opens reference details from catalog field values", () => {
    render(
      <CatalogItemDetailPage
        id="cat_1"
        initialData={{
          ...catalogItem,
          field_values: [
            {
              fieldId: "fld_seed_expansion",
              fieldName: "fld_seed_expansion",
              value: { referenceId: "ref_expansion" },
              reference: expansionReference(),
            },
          ],
        }}
      />,
    );

    const referenceValueTrigger = screen.getAllByRole("link", {
      name: "View Expansion reference details for Perfect Order",
    })[0];

    expect(referenceValueTrigger.getAttribute("href")).toBe("/catalog/reference-records/ref_expansion");
    expect(referenceValueTrigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(referenceValueTrigger.className).toContain("text-accent");
    expect(referenceValueTrigger.className).toContain("hover:underline");
    expect(referenceValueTrigger.className).not.toContain("min-h-8");
    expect(referenceValueTrigger.className).not.toContain("text-xs");

    fireEvent.click(referenceValueTrigger);

    const dialog = screen.getByRole("dialog", { name: "Perfect Order" });
    expect(within(dialog).getByText("Reference type")).toBeTruthy();
    expect(within(dialog).getAllByText("Expansion")[0]).toBeTruthy();
    expect(within(dialog).getByText("tcgdex-set-id")).toBeTruthy();
    expect(within(dialog).getByText("me03")).toBeTruthy();
    expect(within(dialog).getByText("Part Of")).toBeTruthy();
    expect(within(dialog).getByText("Mega Evolution")).toBeTruthy();
  });

  it("renders Product Contents and reverse Included In rows with configured labels", async () => {
    stubCatalogFetches({
      contentLines: [
        {
          lineId: "pcl_pack",
          containerCatalogItemId: "cat_1",
          containerSelectedOptions: null,
          containerProductId: null,
          containedCatalogItemId: "cat_pack",
          containedSelectedOptions: [{ dimensionId: "language", optionId: "en" }],
          containedProductId: "cat_pack::language:en",
          quantity: 36,
          contentTypeId: "pct_pack",
          inclusionPolicyId: "pcp_guaranteed",
          provenance: { source: "operator" },
          resolutionStatus: "resolved",
          targetLifecycleStatus: "active",
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          lineId: "pcl_evidence",
          containerCatalogItemId: "cat_1",
          containerSelectedOptions: null,
          containerProductId: null,
          containedCatalogItemId: null,
          containedSelectedOptions: null,
          containedProductId: null,
          quantity: null,
          contentTypeId: "pct_pack",
          inclusionPolicyId: null,
          provenance: { provider: "tcgplayer" },
          resolutionStatus: "unresolved",
          targetLifecycleStatus: null,
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      containerLines: [
        {
          lineId: "pcl_container",
          containerCatalogItemId: "cat_box",
          containerSelectedOptions: null,
          containerProductId: null,
          containedCatalogItemId: "cat_1",
          containedSelectedOptions: null,
          containedProductId: null,
          quantity: 1,
          contentTypeId: "pct_pack",
          inclusionPolicyId: "pcp_guaranteed",
          provenance: { source: "operator" },
          resolutionStatus: "resolved",
          targetLifecycleStatus: "active",
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    render(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    await waitFor(() =>
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(([request]) => String(request).includes("product-contents")),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("2 content lines")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^Contents/ }));
    expect(screen.getAllByText("Pack")[0]).toBeTruthy();
    expect(screen.getAllByText("Booster pack")[0]).toBeTruthy();
    expect(screen.getAllByText("Guaranteed")[0]).toBeTruthy();
    expect(screen.getAllByText("language:en")[0]).toBeTruthy();
    expect(screen.getAllByText("Unresolved provider evidence")[0]).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Included In/ }));
    expect(screen.getAllByText("Sealed Box")[0]).toBeTruthy();
  });

  it("preserves Product Contents mutation API errors for operators", async () => {
    const fetch = stubCatalogFetches({
      contentLines: [
        {
          lineId: "pcl_pack",
          containerCatalogItemId: "cat_1",
          containerSelectedOptions: null,
          containerProductId: null,
          containedCatalogItemId: "cat_pack",
          containedSelectedOptions: null,
          containedProductId: null,
          quantity: 1,
          contentTypeId: "pct_pack",
          inclusionPolicyId: "pcp_guaranteed",
          provenance: { source: "operator" },
          resolutionStatus: "resolved",
          targetLifecycleStatus: "active",
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      productContentsSaveError: "Required selected option is missing.",
    });

    render(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Contents/ }).textContent).toContain("1 content lines"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Contents/ }));
    const contentRow = screen
      .getAllByText("Booster pack")
      .map((element) => element.closest("tr"))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!contentRow) {
      throw new Error("Expected Product Contents row to render.");
    }
    fireEvent.click(within(contentRow).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Required selected option is missing."));
    expect(
      fetch.mock.calls.some(([request, init]) => {
        const url = String(request);
        return (
          url.includes("/product-contents/containers/cat_1") &&
          init?.method === "PUT" &&
          String(init.body).includes('"lines":[]')
        );
      }),
    ).toBe(true);
  });

  it("uses the Product Contents command snapshot instead of stale projection reads", async () => {
    stubCatalogFetches({
      contentLines: [
        {
          lineId: "pcl_pack",
          containerCatalogItemId: "cat_1",
          containerSelectedOptions: null,
          containerProductId: null,
          containedCatalogItemId: "cat_pack",
          containedSelectedOptions: null,
          containedProductId: null,
          quantity: 1,
          contentTypeId: "pct_pack",
          inclusionPolicyId: "pcp_guaranteed",
          provenance: { source: "operator" },
          resolutionStatus: "resolved",
          targetLifecycleStatus: "active",
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    render(<CatalogItemDetailPage id="cat_1" initialData={catalogItem} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Contents/ }).textContent).toContain("1 content lines"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Contents/ }));
    const contentRow = screen
      .getAllByText("Booster pack")
      .map((element) => element.closest("tr"))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!contentRow) {
      throw new Error("Expected Product Contents row to render.");
    }
    fireEvent.click(within(contentRow).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Contents/ }).textContent).toContain("No Product Contents."),
    );
  });

  it("omits blank Product Contents selected options", () => {
    expect(parseSelectedOptionsInput("")).toBeUndefined();
    expect(parseSelectedOptionsInput("  ,  ")).toBeUndefined();
    expect(parseSelectedOptionsInput("language:en")).toEqual([{ dimensionId: "language", optionId: "en" }]);
  });
});

function expansionReference(): CatalogReferenceRecordRef {
  const series: CatalogReferenceRecordRef = {
    referenceId: "ref_series",
    typeKey: "series",
    key: "mega-evolution",
    name: "Mega Evolution",
    attributes: { "tcgdex-series-id": "mega-evolution" },
    relationships: [],
    status: "active",
  };

  return {
    referenceId: "ref_expansion",
    typeKey: "expansion",
    key: "perfect-order",
    name: "Perfect Order",
    attributes: { "tcgdex-set-id": "me03", "card-count": 88 },
    relationships: [
      {
        relationshipType: "part-of",
        referenceId: series.referenceId,
        reference: series,
      },
    ],
    status: "active",
  };
}

function stubCatalogFetches(
  input: {
    contentLines?: unknown[];
    containerLines?: unknown[];
    productContentsSaveError?: string;
    publicationResponses?: Response[];
    recheckDetail?: CatalogItemDetail;
  } = {},
) {
  const contentLines = input.contentLines ?? [];
  const containerLines = input.containerLines ?? [];
  const jsonResponse = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  vi.stubGlobal(
    "fetch",
    vi.fn((request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === "object" && request !== null && "url" in request
          ? String((request as { url: unknown }).url)
          : String(request);
      if (url.includes("/items/cat_1/publish")) {
        return Promise.resolve(
          input.publicationResponses?.shift() ??
            new Response(JSON.stringify({ status: "active" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );
      }
      if (url.endsWith("/items/cat_1")) {
        return jsonResponse(input.recheckDetail ?? catalogItem);
      }
      if (url.includes("/product-contents/content-types")) {
        return jsonResponse({
          items: [
            {
              content_type_id: "pct_pack",
              key: "pack",
              display_name: { defaultLocale: "en", values: { en: "Pack" } },
              status: "active",
              sort_order: 10,
              discovery_search_weight: 0.2,
              updated_at: "2026-07-01T00:00:00.000Z",
            },
          ],
          total: 1,
          count: 1,
        });
      }
      if (url.includes("/product-contents/inclusion-policies")) {
        return jsonResponse({
          items: [
            {
              inclusion_policy_id: "pcp_guaranteed",
              key: "guaranteed",
              display_name: { defaultLocale: "en", values: { en: "Guaranteed" } },
              status: "active",
              sort_order: 10,
              updated_at: "2026-07-01T00:00:00.000Z",
            },
          ],
          total: 1,
          count: 1,
        });
      }
      if (url.includes("/product-contents/containers/cat_1") && init?.method === "PUT") {
        if (input.productContentsSaveError) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: input.productContentsSaveError } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        const body = init.body ? (JSON.parse(String(init.body)) as { lines?: unknown[] }) : {};
        return jsonResponse({
          containerCatalogItemId: "cat_1",
          containerSelectedOptions: null,
          containerProductId: null,
          lines: body.lines ?? [],
          resolvedFactHash: "hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
        });
      }
      if (url.includes("/product-contents/containers/cat_1")) {
        return jsonResponse({ items: contentLines, total: contentLines.length, count: contentLines.length });
      }
      if (url.includes("/product-contents/contained/cat_1")) {
        return jsonResponse({ items: containerLines, total: containerLines.length, count: containerLines.length });
      }
      if (url.includes("/items")) {
        return jsonResponse({
          items: [
            { catalog_item_id: "cat_pack", title: "Booster pack" },
            { catalog_item_id: "cat_box", title: "Sealed Box" },
          ],
          total: 2,
          count: 2,
        });
      }
      return jsonResponse({ items: [], total: 0, count: 0 });
    }),
  );

  return vi.mocked(globalThis.fetch);
}
