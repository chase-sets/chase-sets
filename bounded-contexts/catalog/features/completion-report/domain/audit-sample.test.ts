import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CatalogAuditSampleRequestError,
  catalogAuditSampleForm,
  catalogAuditSamplePublicPath,
  parseCatalogAuditSampleRequest,
  selectCatalogAuditSample,
  type CatalogAuditSamplePopulationItem,
} from "./audit-sample";
import { findSupportSafetyViolations } from "./redaction";

const auditAllocation = "magic=40/10,pokemon:en=40/10,pokemon:ja=20/5,yugioh=40/10,one-piece=40/10,lorcana=40/10";

function items(
  prefix: string,
  count: number,
  fields: Omit<CatalogAuditSamplePopulationItem, "catalogItemId">,
): CatalogAuditSamplePopulationItem[] {
  return Array.from({ length: count }, (_, index) => ({
    catalogItemId: `${prefix}_${String(index).padStart(3, "0")}`,
    ...fields,
  }));
}

// SYNTHETIC active batch items: magic has more items than its allocation,
// pokemon falls short in both language strata.
const population: readonly CatalogAuditSamplePopulationItem[] = [
  ...items("cat_magic_single", 60, { productDomain: "magic", languageCode: "en", productForm: "magic-card-print" }),
  ...items("cat_magic_sealed", 15, { productDomain: "magic", languageCode: "en", productForm: "booster-box" }),
  ...items("cat_pokemon_en", 30, { productDomain: "pokemon", languageCode: "en", productForm: "pokemon-card" }),
  ...items("cat_pokemon_ja", 3, { productDomain: "pokemon", languageCode: "ja", productForm: "elite-trainer-box" }),
  ...items("cat_pokemon_zh", 4, { productDomain: "pokemon", languageCode: "zh", productForm: "pokemon-card" }),
  ...items("cat_magic_unknown", 2, { productDomain: "magic", languageCode: "en", productForm: "magic-set-reference" }),
];

describe("parseCatalogAuditSampleRequest", () => {
  it("parses the fixed audit allocation as singles/sealed per stratum", () => {
    expect(parseCatalogAuditSampleRequest({ strata: auditAllocation, seed: "audit-1" })).toEqual({
      seed: "audit-1",
      strata: [
        { productDomain: "magic", languageCode: null, singles: 40, sealed: 10 },
        { productDomain: "pokemon", languageCode: "en", singles: 40, sealed: 10 },
        { productDomain: "pokemon", languageCode: "ja", singles: 20, sealed: 5 },
        { productDomain: "yugioh", languageCode: null, singles: 40, sealed: 10 },
        { productDomain: "one-piece", languageCode: null, singles: 40, sealed: 10 },
        { productDomain: "lorcana", languageCode: null, singles: 40, sealed: 10 },
      ],
    });
  });

  it.each([
    ["magic", "audit-1", "magic"],
    ["magic=40", "audit-1", "magic=40"],
    ["magic=40/x", "audit-1", "magic=40/x"],
    ["magic=-1/0", "audit-1", "magic=-1/0"],
    ["magic=1001/0", "audit-1", "magic=1001/0"],
    ["Magic=1/1", "audit-1", "Magic=1/1"],
    ["magic=1/1,magic=2/2", "audit-1", "magic"],
    ["pokemon=1/1,pokemon:en=1/1", "audit-1", "pokemon"],
    ["", "audit-1", "empty"],
    ["magic=1/1", "", "seed"],
    ["magic=1/1", "https://example.invalid/seed", "seed"],
  ])("refuses %j with seed %j by name", (strata, seed, named) => {
    expect(() => parseCatalogAuditSampleRequest({ strata, seed })).toThrow(CatalogAuditSampleRequestError);
    expect(() => parseCatalogAuditSampleRequest({ strata, seed })).toThrow(named);
  });
});

describe("catalogAuditSampleForm", () => {
  it.each([
    ["magic-card-print", "singles"],
    ["pokemon-card", "singles"],
    ["single-card", "singles"],
    ["single", "singles"],
    ["card", "singles"],
    ["booster-box", "sealed"],
    ["elite-trainer-box", "sealed"],
    ["starter-deck", "sealed"],
    ["gift-set", "sealed"],
    ["trove", "sealed"],
    ["sealed", "sealed"],
    ["lorcana-sealed-product", "sealed"],
    [" Booster-Pack ", "sealed"],
    ["magic-set-reference", null],
    ["provider-product", null],
    ["", null],
    [null, null],
  ])("classifies %j as %j", (productForm, form) => {
    expect(catalogAuditSampleForm(productForm)).toBe(form);
  });
});

describe("selectCatalogAuditSample", () => {
  const request = parseCatalogAuditSampleRequest({ strata: auditAllocation, seed: "audit-2026-10" });

  it("AC1: the same seed gives the same sample, whatever order the population arrives in", () => {
    const first = selectCatalogAuditSample(request, population);
    expect(selectCatalogAuditSample(request, population)).toEqual(first);
    expect(selectCatalogAuditSample(request, [...population].reverse())).toEqual(first);
  });

  it("AC1: a different seed differs where a stratum has more items than its allocation", () => {
    const left = selectCatalogAuditSample(request, population);
    const right = selectCatalogAuditSample({ ...request, seed: "audit-2026-11" }, population);
    const ids = (sample: typeof left, form: "singles" | "sealed") =>
      sample.items
        .filter((item) => item.productDomain === "magic" && item.productForm === form)
        .map((item) => item.catalogItemId);
    expect(ids(left, "singles")).toHaveLength(40);
    expect(ids(right, "singles")).toHaveLength(40);
    expect(ids(right, "singles")).not.toEqual(ids(left, "singles"));
    expect(ids(right, "sealed")).not.toEqual(ids(left, "sealed"));
    // Strata at or under their allocation take every item for any seed.
    const pokemon = (sample: typeof left) =>
      sample.items
        .filter((item) => item.productDomain === "pokemon")
        .map((item) => item.catalogItemId)
        .sort();
    expect(pokemon(right)).toEqual(pokemon(left));
  });

  it("AC1: pins the sample for a fixed seed so any change to the selection fails", () => {
    const pinned = selectCatalogAuditSample(parseCatalogAuditSampleRequest({ strata: "magic=3/2", seed: "pin-1" }), [
      ...items("cat_single", 8, { productDomain: "magic", languageCode: "en", productForm: "magic-card-print" }),
      ...items("cat_sealed", 5, { productDomain: "magic", languageCode: "en", productForm: "booster-pack" }),
    ]);
    expect(pinned.items.map((item) => item.catalogItemId)).toEqual(PINNED_SAMPLE);
  });

  it("AC2: takes every item of a short stratum and reports the shortfall", () => {
    const sample = selectCatalogAuditSample(request, population);
    expect(sample.strata).toEqual([
      {
        productDomain: "magic",
        languageCode: null,
        productForm: "singles",
        allocated: 40,
        available: 60,
        sampled: 40,
        shortfall: 0,
      },
      {
        productDomain: "magic",
        languageCode: null,
        productForm: "sealed",
        allocated: 10,
        available: 15,
        sampled: 10,
        shortfall: 0,
      },
      {
        productDomain: "pokemon",
        languageCode: "en",
        productForm: "singles",
        allocated: 40,
        available: 30,
        sampled: 30,
        shortfall: 10,
      },
      {
        productDomain: "pokemon",
        languageCode: "en",
        productForm: "sealed",
        allocated: 10,
        available: 0,
        sampled: 0,
        shortfall: 10,
      },
      {
        productDomain: "pokemon",
        languageCode: "ja",
        productForm: "singles",
        allocated: 20,
        available: 0,
        sampled: 0,
        shortfall: 20,
      },
      {
        productDomain: "pokemon",
        languageCode: "ja",
        productForm: "sealed",
        allocated: 5,
        available: 3,
        sampled: 3,
        shortfall: 2,
      },
      {
        productDomain: "yugioh",
        languageCode: null,
        productForm: "singles",
        allocated: 40,
        available: 0,
        sampled: 0,
        shortfall: 40,
      },
      {
        productDomain: "yugioh",
        languageCode: null,
        productForm: "sealed",
        allocated: 10,
        available: 0,
        sampled: 0,
        shortfall: 10,
      },
      {
        productDomain: "one-piece",
        languageCode: null,
        productForm: "singles",
        allocated: 40,
        available: 0,
        sampled: 0,
        shortfall: 40,
      },
      {
        productDomain: "one-piece",
        languageCode: null,
        productForm: "sealed",
        allocated: 10,
        available: 0,
        sampled: 0,
        shortfall: 10,
      },
      {
        productDomain: "lorcana",
        languageCode: null,
        productForm: "singles",
        allocated: 40,
        available: 0,
        sampled: 0,
        shortfall: 40,
      },
      {
        productDomain: "lorcana",
        languageCode: null,
        productForm: "sealed",
        allocated: 10,
        available: 0,
        sampled: 0,
        shortfall: 10,
      },
    ]);
    expect(sample.items).toHaveLength(83);
    // Pokemon in a language outside the allocation is not part of the audit;
    // a requested-domain item with no single or sealed form is counted.
    expect(sample.items.some((item) => item.languageCode === "zh")).toBe(false);
    expect(sample.unclassifiedItemCount).toBe(2);
  });

  it("emits id, domain, language, form, and Discovery path only, and stays support-safe", () => {
    const sample = selectCatalogAuditSample(request, population);
    expect(sample.items.find((item) => item.productDomain === "pokemon" && item.languageCode === "ja")).toEqual({
      catalogItemId: expect.stringMatching(/^cat_pokemon_ja_/),
      productDomain: "pokemon",
      languageCode: "ja",
      productForm: "sealed",
      publicPath: expect.stringMatching(/^\/items\/cat_pokemon_ja_/),
    });
    expect(findSupportSafetyViolations(sample)).toEqual([]);
  });
});

describe("catalogAuditSamplePublicPath", () => {
  it("AC3: builds the public item path exactly as Discovery's set page does", () => {
    const setRoute = readFileSync(new URL("../../../../discovery/routes/set.tsx", import.meta.url), "utf8");
    const construction = /const href = `\/items\/\$\{item\.(\w+) \|\| item\.(\w+)\}`;/.exec(setRoute);
    expect(construction?.slice(1)).toEqual(["slug", "catalog_item_id"]);
    // The construction set.tsx pins above, applied to the same inputs.
    const discoveryHref = (item: { slug: string | null; catalog_item_id: string }) =>
      `/items/${item.slug || item.catalog_item_id}`;
    for (const slug of ["pikachu-base-set-cat_1", "", null]) {
      expect(catalogAuditSamplePublicPath({ slug, catalogItemId: "cat_1" })).toBe(
        discoveryHref({ slug, catalog_item_id: "cat_1" }),
      );
    }
    // Catalog holds no slug, so the sample takes the id branch.
    expect(catalogAuditSamplePublicPath({ catalogItemId: "cat_1" })).toBe("/items/cat_1");
  });
});

// sha256("<seed>:<catalogItemId>") ascending per form, computed independently.
const PINNED_SAMPLE: readonly string[] = [
  "cat_single_001",
  "cat_single_005",
  "cat_single_002",
  "cat_sealed_003",
  "cat_sealed_002",
];
