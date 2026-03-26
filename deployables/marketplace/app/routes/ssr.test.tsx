import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { DiscoveryShellLayout } from "../../../../bounded-contexts/discovery/shell/layout";
import { ItemDetailPage } from "../../../../bounded-contexts/discovery/items/detail/item-detail-page";
import { SearchPage } from "../../../../bounded-contexts/discovery/items/search/search-page";
import { loader as searchLoader } from "./search";

describe("marketplace SSR routes", () => {
  it("renders search results into HTML before hydration", () => {
    const html = renderToString(
      <MemoryRouter>
        <DiscoveryShellLayout activeKey="search">
          <SearchPage
            search=""
            category=""
            sort="relevance"
            page={1}
            data={{
              total: 1,
              count: 1,
              items: [
                {
                  item_id: "item-1",
                  title: "Charizard ex",
                  subtitle: "Illustration Rare",
                  description: "Rendered on the server.",
                  blueprint_id: "bp-1",
                  blueprint_name: "Pokemon Card",
                  status: "active",
                  category_names: ["Pokemon"],
                  tags: ["Fire"],
                  image_urls: [],
                  updated_at: "2026-03-26T00:00:00.000Z",
                },
              ],
            }}
            categories={[]}
            onSearchChange={() => undefined}
            onCategoryChange={() => undefined}
            onSortChange={() => undefined}
            onPageChange={() => undefined}
          />
        </DiscoveryShellLayout>
      </MemoryRouter>,
    );

    expect(html).toContain("Marketplace");
    expect(html).toContain("Charizard ex");
  });

  it("renders item detail content into HTML before hydration", () => {
    const html = renderToString(
      <DiscoveryShellLayout activeKey="search">
        <ItemDetailPage
          data={{
            item_id: "item-1",
            title: "Charizard ex",
            subtitle: "Illustration Rare",
            description: "Server rendered detail page.",
            blueprint_id: "bp-1",
            blueprint: { blueprintId: "bp-1", name: "Pokemon Card" },
            status: "active",
            field_values: [{ fieldId: "field-1", fieldName: "Number", value: "199/165" }],
            categories: [{ categoryId: "cat-1", name: "Pokemon" }],
            tags: ["Fire"],
            image_urls: [],
            version_schema: null,
            updated_at: "2026-03-26T00:00:00.000Z",
          }}
        />
      </DiscoveryShellLayout>,
    );

    expect(html).toContain("Charizard ex");
    expect(html).toContain("Server rendered detail page.");
  });

  it("loads discovery data through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/marketplace/categories")) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [], total: 0, count: 0 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        return Promise.resolve(
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
        );
      }),
    );

    const result = await searchLoader({
      request: new Request("http://localhost/search?search=charizard"),
      params: {},
      context: undefined,
    } as never);

    expect(result.search).toBe("charizard");
    expect(result.data.items).toEqual([]);
  });
});
