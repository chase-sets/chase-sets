import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogAdminLayout } from "../../../../bounded-contexts/catalog/authoring/shell/layout";
import { DimensionDetailPage } from "../../../../bounded-contexts/catalog/authoring/dimensions/ui/dimension-detail-page";
import { DimensionListPage } from "../../../../bounded-contexts/catalog/authoring/dimensions/ui/dimension-list-page";
import { loader as dimensionsLoader } from "./dimensions";

describe("catalog admin SSR routes", () => {
  it("renders a list page into HTML before hydration", () => {
    const html = renderToString(
      <CatalogAdminLayout activeKey="dimensions">
        <DimensionListPage
          initialData={{
            items: [
              {
                dimension_id: "dim_1",
                key: "size",
                name: "Size",
                description: "Card size",
                status: "active",
                updated_at: "2026-03-26T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }}
        />
      </CatalogAdminLayout>,
    );

    expect(html).toContain("Catalog Admin");
    expect(html).toContain("Dimensions");
    expect(html).toContain("Size");
  });

  it("renders a detail page into HTML before hydration", () => {
    const html = renderToString(
      <CatalogAdminLayout activeKey="dimensions">
        <DimensionDetailPage
          id="dim_1"
          initialData={{
            dimension_id: "dim_1",
            key: "size",
            name: "Size",
            description: "Card size",
            status: "active",
            updated_at: "2026-03-26T00:00:00.000Z",
            choices: [
              {
                choice_id: "choice_1",
                dimension_id: "dim_1",
                code: "standard",
                labels: [{ locale: "en", value: "Standard" }],
                display_order: 0,
                numeric_value: null,
                status: "active",
              },
            ],
          }}
        />
      </CatalogAdminLayout>,
    );

    expect(html).toContain("Card size");
    expect(html).toContain("standard");
  });

  it("loads the initial dimension list through the catalog API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [],
              total: 0,
              count: 0,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const result = await dimensionsLoader({
      request: new Request("http://localhost/dimensions"),
      params: {},
      context: undefined,
    } as never);

    expect(result.items).toEqual([]);
  });
});
