import { describe, expect, it, vi } from "vitest";
import { reduceSealedProducts } from "../../../domain/extension/sealed-products/reducer";
import { runSealedProducts } from "../../../domain/extension/sealed-products/run";
import { parseTcgplayerSealedProductObservationPost } from "../../../domain/extension/sealed-products/contract";
import { detail, selection, page, response, counts } from "./fixture";
import { salvage } from "../../sealed-product-observation-fixture";
const observedAt = "2026-10-18T00:00:00.000Z";
describe("sealed product reduction and run", () => {
  it.each(salvage.cases.filter((entry) => entry.detail.productLineId === 1 || entry.detail.productLineId === 3))(
    "accepts the bound-line salvage case $unitKey",
    ({ detail: body }) => {
      const posts = reduceSealedProducts(
        [{ productId: body.productId, body }],
        { productLineId: body.productLineId, setId: body.setId, setName: body.setName },
        observedAt,
      );
      expect(posts).toHaveLength(1);
      expect(parseTcgplayerSealedProductObservationPost(posts![0]).ok).toBe(true);
    },
  );
  it("reduces salvage details, removes prices at every depth and never posts cards", () => {
    const body = {
      ...detail(),
      marketPrice: 23,
      customAttributes: { ...detail().customAttributes, price: 99 },
      skus: detail().skus.map((sku) => ({ ...sku, marketPrice: 23 })),
    };
    const posts = reduceSealedProducts(
      [
        { productId: body.productId, body },
        { productId: 123, body: { ...body, productId: 123, sealed: false } },
      ],
      selection(),
      observedAt,
    )!;
    expect(posts).toHaveLength(1);
    expect(posts[0]!.products).toHaveLength(1);
    expect(parseTcgplayerSealedProductObservationPost(posts[0]).ok).toBe(true);
    expect(JSON.stringify(posts)).not.toMatch(/price/i);
  });
  it.each([
    "productTypeName",
    "rarityName",
    "sealed",
    "productName",
    "setId",
    "setCode",
    "productId",
    "setName",
    "productLineId",
    "productStatusId",
    "productLineName",
    "customAttributes",
    "skus",
  ])("posts nothing for the %s guard bypass mutant", async (field) => {
    const post = vi.fn();
    const body = { ...detail(), [field]: null };
    const result = await runSealedProducts({
      selection: selection(),
      environment: "staging",
      post,
      now: () => observedAt,
      request: async (request) =>
        response(
          request.endpoint === "search"
            ? {
                errors: [],
                results: [{ ...page(0, 1).results[0], results: [{ ...detail(), setUrlName: "synthetic" }] }],
              }
            : body,
        ),
    });
    expect(result.outcome).toBe("unqualified");
    expect(post).not.toHaveBeenCalled();
  });
  it.each([
    { setId: 999 },
    { setName: "another set" },
    { productLineId: 3 },
    { productLineName: "Pokemon" },
    { productId: 999 },
    { errors: ["private"] },
    { skus: [] },
    { skus: Array(251).fill(detail().skus[0]) },
    { skus: [detail().skus[0], detail().skus[0]] },
    { skus: [{ ...detail().skus[0], sku: 0 }] },
    { skus: [{ ...detail().skus[0], condition: null }] },
    { skus: [{ ...detail().skus[0], variant: null }] },
    { skus: [{ ...detail().skus[0], language: null }] },
    { barcode: "abc" },
    { gtin: 123 },
    { upc: "abc" },
    { formattedAttributes: null },
    { formattedAttributes: { Artist: 12 } },
    ...["number", "releaseDate", "cardType", "detailNote", "barcode", "gtin", "upc", "packCount"].map((field) => ({
      customAttributes: { [field]: null },
    })),
    { productName: "Bearer private" },
    { productName: "a".repeat(257) },
    { productId: 2_147_483_648 },
  ])("rejects independently mutated identity and nested fields: %j", (mutation) => {
    const body = { ...detail(), ...mutation };
    expect(reduceSealedProducts([{ productId: detail().productId, body }], selection(), observedAt)).toBeNull();
  });
  it("bounds every post to 24 details and 2 MiB and rejects invalid observation time", () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      productId: index + 1,
      body: { ...detail(), productId: index + 1 },
    }));
    expect(reduceSealedProducts(entries, selection(), "bad")).toBeNull();
    const posts = reduceSealedProducts(entries, selection(), observedAt)!;
    expect(posts.map((post) => post.products.length)).toEqual([24, 1]);
    for (const post of posts)
      expect(new TextEncoder().encode(JSON.stringify(post)).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(reduceSealedProducts([entries[0], entries[0]], selection(), observedAt)).toBeNull();
  });
  it("splits maximum valid SKU/attribute details at the UTF-8 byte cap, not only the product count", () => {
    const large = {
      ...detail(),
      customAttributes: { cardType: Array(256).fill("\u754c".repeat(256)) },
      skus: Array.from({ length: 250 }, (_, index) => ({
        sku: index + 1,
        condition: "\u754c".repeat(256),
        variant: "\u754c".repeat(256),
        language: "\u754c".repeat(256),
      })),
    };
    const entries = Array.from({ length: 12 }, (_, index) => ({
      productId: index + 1,
      body: { ...large, productId: index + 1 },
    }));
    const posts = reduceSealedProducts(entries, selection(), observedAt)!;
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.flatMap((post) => post.products)).toHaveLength(12);
    for (const post of posts) {
      expect(parseTcgplayerSealedProductObservationPost(post).ok).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(post)).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });
  it("emits the complete response receipt before reduction and stops on first post refusal", async () => {
    const order: string[] = [];
    const post = vi.fn(async () => ({ outcome: "grant-invalid" as const }));
    const result = await runSealedProducts({
      selection: selection(),
      environment: "staging",
      post,
      onReceipt: (receipt) => {
        if (receipt.verdict === "complete") order.push("receipt");
      },
      now: () => {
        order.push("reduce");
        return observedAt;
      },
      request: async (request) =>
        response(
          request.endpoint === "search"
            ? {
                errors: [],
                results: [
                  {
                    totalResults: 25,
                    resultId: "synthetic",
                    results: Array.from({ length: request.from === 0 ? 24 : 1 }, (_, index) => ({
                      ...detail(),
                      productId: request.from + index + 1,
                      setUrlName: "synthetic",
                    })),
                  },
                ],
              }
            : { ...detail(), productId: request.productId },
        ),
    });
    expect(order.indexOf("receipt")).toBeLessThan(order.indexOf("reduce"));
    expect(result.outcome).toBe("grant-invalid");
    expect(post).toHaveBeenCalledOnce();
  });
  it("aggregates Catalog counts without retaining exclusion ids or codes in the receipt", async () => {
    const result = await runSealedProducts({
      selection: selection(),
      environment: "staging",
      post: async () => ({ outcome: "recorded", ...counts, exclusions: [{ productId: 7654321, code: "private" }] }),
      request: async (request) => response(request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: 1 }),
    });
    expect(result.receipt).toMatchObject({ sealedDetails: 1, posts: 1, catalog: { ...counts, exclusions: 1 } });
    expect(JSON.stringify(result.receipt)).not.toMatch(/7654321|private|productId/);
  });
});
