import { describe, expect, it } from "vitest";
import {
  assembleProductMeasurePublication,
  digestProductMeasures,
  parseProductMeasurePublicationPart,
  ProductMeasurePublicationError,
  type ProductMeasureSnapshot,
} from "./index";

const measure: ProductMeasureSnapshot = {
  catalogItemId: "synthetic-item",
  productId: "synthetic-product",
  selectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
  measureVersion: "synthetic:v1",
  unitLengthInches: 3,
  unitWidthInches: 2,
  unitHeightInches: 0.1,
  unitWeightOunces: 1,
  physicalFlags: ["raw-card", "bendable"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
};

async function publication() {
  const products = [measure, { ...measure, productId: "second-product" }];
  return {
    completion: {
      streamId: "catalog.product-measures-synthetic-item",
      streamVersion: 7,
      data: {
        catalogItemId: "synthetic-item",
        partCount: 2,
        productCount: 2,
        productsDigest: await digestProductMeasures(products),
      },
    },
    parts: products.map((product, partIndex) => ({
      streamId: "catalog.product-measures-synthetic-item",
      streamVersion: 5 + partIndex,
      data: { catalogItemId: "synthetic-item", partIndex, products: [product] },
    })),
    products,
  };
}

describe("Product Measure Publication", () => {
  it.each(["stackBehavior", "source", "confidence"])("rejects malformed %s without coercion", (field) => {
    expect(() =>
      parseProductMeasurePublicationPart({
        catalogItemId: "synthetic-item",
        partIndex: 0,
        products: [{ ...measure, [field]: { toString: "not callable" } }],
      }),
    ).toThrow(ProductMeasurePublicationError);
  });
  it("pins the browser-safe canonical SHA-256 bytes independently of key and Product order", async () => {
    // Independently computed from the literal canonical JSON with SHA-256.
    expect(await digestProductMeasures([])).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect(await digestProductMeasures([measure])).toBe(
      "92b2d7f4c8ff891851e62940d91f4281f66bab4761491dbedf611ccf5e41b194",
    );
    expect(
      await digestProductMeasures([{ ...measure, selectedOptions: [{ optionId: "foil", dimensionId: "finish" }] }]),
    ).toBe("92b2d7f4c8ff891851e62940d91f4281f66bab4761491dbedf611ccf5e41b194");
    const { products } = await publication();
    const reordered = [...products]
      .reverse()
      .map((product) => Object.fromEntries(Object.entries(product).reverse()) as ProductMeasureSnapshot);
    expect(await digestProductMeasures(products)).toBe(await digestProductMeasures(reordered));
    expect(await digestProductMeasures([{ ...measure, physicalFlags: ["bendable", "raw-card"] }])).not.toBe(
      await digestProductMeasures([measure]),
    );
  });

  it("sorts Product IDs by Unicode codepoint rather than UTF-16 or locale", async () => {
    expect(
      await digestProductMeasures([
        { ...measure, productId: "\u{10000}" },
        { ...measure, productId: "\ue000" },
      ]),
    ).toBe("ea7f3b11b60e00428bab5ad5238c383a4344ccfdc05b2581a95122b344dd088c");
  });

  it("assembles precisely the contiguous predecessors and preserves publication Product order", async () => {
    const { completion, parts, products } = await publication();
    expect(await assembleProductMeasurePublication(completion, [...parts].reverse())).toEqual(products);
  });

  it.each(["missing", "duplicate", "version", "index", "stream", "item", "product", "count", "digest"])(
    "rejects %s corruption with a deterministic typed error",
    async (corruption) => {
      const { completion, parts } = await publication();
      if (corruption === "missing") parts.pop();
      if (corruption === "duplicate") parts[1] = parts[0]!;
      if (corruption === "version") parts[1]!.streamVersion = 9;
      if (corruption === "index") parts[1]!.data.partIndex = 0;
      if (corruption === "stream") parts[1]!.streamId = "catalog.product-measures-other";
      if (corruption === "item") parts[1]!.data.catalogItemId = "other";
      if (corruption === "product") parts[1]!.data.products = parts[0]!.data.products;
      if (corruption === "count") completion.data.productCount = 3;
      if (corruption === "digest") completion.data.productsDigest = "0".repeat(64);
      await expect(assembleProductMeasurePublication(completion, parts)).rejects.toBeInstanceOf(
        ProductMeasurePublicationError,
      );
    },
  );
});
