import { describe, expect, it } from "vitest";
import { toCatalogAdminHref } from "./catalog-admin-hrefs";

describe("toCatalogAdminHref", () => {
  it("keeps Catalog admin links inside the Catalog section prefix", () => {
    expect(toCatalogAdminHref("/catalog-items/cat_1")).toBe("/catalog/catalog-items/cat_1");
    expect(toCatalogAdminHref("/reference-records/ref_1")).toBe("/catalog/reference-records/ref_1");
    expect(toCatalogAdminHref("/blueprints")).toBe("/catalog/blueprints");
  });

  it("leaves already-prefixed, relative, and external links unchanged", () => {
    expect(toCatalogAdminHref("/catalog/reference-types/rft_1")).toBe("/catalog/reference-types/rft_1");
    expect(toCatalogAdminHref("#details")).toBe("#details");
    expect(toCatalogAdminHref("https://marketplace.example/catalog-items/cat_1")).toBe(
      "https://marketplace.example/catalog-items/cat_1",
    );
  });
});
