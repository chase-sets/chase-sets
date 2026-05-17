import { describe, expect, it, vi } from "vitest";
import { buildCatalogAdminCatalogItemProjectionHandlers } from "./admin-projection";
import { buildCatalogItemProjectionHandlers } from "./projection";

function event() {
  return {
    streamId: "catalog.item-cat_1",
    data: {},
    timing: { recordedAt: "2026-05-17T00:00:00.000Z" },
  } as never;
}

describe("Catalog Item projections", () => {
  it("deletes removed drafts from the base read model", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.draft-removed"]?.(event());

    expect(query).toHaveBeenCalledWith(
      "DELETE FROM catalog_items WHERE catalog_item_id = $1",
      ["cat_1"],
    );
  });

  it("deletes removed drafts from admin list and detail pages", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handlers = buildCatalogAdminCatalogItemProjectionHandlers({ query });

    await handlers["catalog.catalog-item.draft-removed"]?.(event());

    expect(query).toHaveBeenCalledWith(
      "DELETE FROM catalog_admin_catalog_item_list_pages WHERE catalog_item_id = $1",
      ["cat_1"],
    );
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM catalog_admin_catalog_item_detail_pages WHERE catalog_item_id = $1",
      ["cat_1"],
    );
  });
});
