import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogAdminLayout } from "@chase-sets/catalog/web";
import { createCatalogAdminPrimaryNavItems } from "../context-shell.generated";
import { buildCanonicalUrl } from "../root";
import { loader as dimensionDetailLoader } from "./dimensions-detail";
import { loader as dimensionsLoader, meta as dimensionsMeta } from "./dimensions";

describe("catalog admin SSR routes", () => {
  it("renders a list page into HTML before hydration", () => {
    const html = renderToString(
      <CatalogAdminLayout
        activeKey="dimensions"
        navItems={createCatalogAdminPrimaryNavItems()}
      >
        <div>Dimensions route outlet</div>
      </CatalogAdminLayout>,
    );

    expect(html).toContain("Catalog Admin");
    expect(html).toContain("Dimensions");
    expect(html).toContain("Dimensions route outlet");
  });

  it("renders a detail page into HTML before hydration", () => {
    const html = renderToString(
      <CatalogAdminLayout
        activeKey="dimensions"
        navItems={createCatalogAdminPrimaryNavItems()}
      >
        <div>Dimension detail route outlet</div>
      </CatalogAdminLayout>,
    );

    expect(html).toContain("Dimension detail route outlet");
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

  it("builds canonical URLs for admin pages", () => {
    expect(
      buildCanonicalUrl({
        origin: "https://admin.example",
        pathname: "/dimensions",
        search: "",
      }),
    ).toBe("https://admin.example/dimensions");
  });

  it("returns list route metadata", () => {
    expect(dimensionsMeta({} as never)).toEqual([{ title: "Dimensions | Catalog Admin" }]);
  });

  it("loads the dimension detail through the catalog API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              dimension_id: "dim_1",
              key: "size",
              name: "Size",
              description: "Card size",
              status: "active",
              updated_at: "2026-03-26T00:00:00.000Z",
              choices: [],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        ),
      ),
    );

    const result = await dimensionDetailLoader({
      request: new Request("http://localhost/dimensions/dim_1"),
      params: { id: "dim_1" },
      context: undefined,
    } as never);

    expect(result.id).toBe("dim_1");
    expect(result.data?.name).toBe("Size");
  });
});

