import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CatalogAuditSampleRequestError,
  assertCatalogAuditSampleEnvelope,
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

  it("accepts the fixed audit allocation at exactly 275 items and refuses any larger total", () => {
    const fixed = parseCatalogAuditSampleRequest({ strata: auditAllocation, seed: "audit-1" });
    expect(fixed.strata.reduce((total, stratum) => total + stratum.singles + stratum.sealed, 0)).toBe(275);
    for (const strata of [
      "magic=276/0",
      "magic=200/76",
      "magic=1001/0",
      "magic=99999999999999999999/0",
      auditAllocation.replace("lorcana=40/10", "lorcana=40/11"),
    ]) {
      expect(() => parseCatalogAuditSampleRequest({ strata, seed: "audit-1" })).toThrow(CatalogAuditSampleRequestError);
      expect(() => parseCatalogAuditSampleRequest({ strata, seed: "audit-1" })).toThrow("at most 275");
    }
  });

  it("refuses a request built without the parser when it exceeds the 275-item envelope", () => {
    const fixed = parseCatalogAuditSampleRequest({ strata: auditAllocation, seed: "audit-1" });
    expect(() => assertCatalogAuditSampleEnvelope(fixed)).not.toThrow();
    const oversized = {
      ...fixed,
      strata: [...fixed.strata, { productDomain: "x", languageCode: null, singles: 1, sealed: 0 }],
    };
    expect(() => assertCatalogAuditSampleEnvelope(oversized)).toThrow("276");
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

  it("AC1: a rotated population still gives the same seed the same IDs", () => {
    const rotated = [...population.slice(41), ...population.slice(0, 41)];
    expect(selectCatalogAuditSample(request, rotated)).toEqual(selectCatalogAuditSample(request, population));
  });

  // A finite stratum has finitely many possible samples, so distinct seeds may
  // collide. With slack (more items than the allocation) each seed selects
  // exactly the allocation; alpha/beta is a documented differing pair and
  // s1/s2 is the accepted collision from review 10079-review-r1.
  describe("AC1: seeds on a slack stratum (3 items, 2 allocated)", () => {
    const slack = parseCatalogAuditSampleRequest({ strata: "magic=2/0", seed: "alpha" });
    const slackPopulation = Array.from({ length: 3 }, (_, index) => ({
      catalogItemId: `id${index}`,
      productDomain: "magic",
      languageCode: "en",
      productForm: "single-card",
    }));
    const selected = (seed: string) =>
      selectCatalogAuditSample({ ...slack, seed }, slackPopulation)
        .items.map((item) => item.catalogItemId)
        .sort();

    it("selects exactly the allocation for every seed", () => {
      for (const seed of ["alpha", "beta", "s1", "s2"]) expect(selected(seed)).toHaveLength(2);
    });

    it("alpha and beta select different items", () => {
      expect(selected("alpha")).toEqual(["id0", "id1"]);
      expect(selected("beta")).toEqual(["id1", "id2"]);
    });

    it("accepts that s1 and s2 select the same items", () => {
      expect(selected("s1")).toEqual(["id0", "id2"]);
      expect(selected("s2")).toEqual(selected("s1"));
    });
  });

  it("AC1: a saturated or short stratum selects every item for every seed with the same shortfall", () => {
    const bounded = [
      ...items("cat_single", 3, { productDomain: "magic", languageCode: "en", productForm: "magic-card-print" }),
      ...items("cat_sealed", 2, { productDomain: "magic", languageCode: "en", productForm: "booster-pack" }),
    ];
    const samples = ["alpha", "beta", "s1", "s2", "audit-2026-10"].map((seed) =>
      selectCatalogAuditSample(parseCatalogAuditSampleRequest({ strata: "magic=3/4", seed }), bounded),
    );
    for (const sample of samples) {
      expect(sample.items.map((item) => item.catalogItemId).sort()).toEqual(
        bounded.map((item) => item.catalogItemId).sort(),
      );
      expect(sample.strata).toEqual([
        {
          productDomain: "magic",
          languageCode: null,
          productForm: "singles",
          allocated: 3,
          available: 3,
          sampled: 3,
          shortfall: 0,
        },
        {
          productDomain: "magic",
          languageCode: null,
          productForm: "sealed",
          allocated: 4,
          available: 2,
          sampled: 2,
          shortfall: 2,
        },
      ]);
    }
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
