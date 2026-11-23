import { describe, expect, it, vi } from "vitest";
import {
  collectSealedProducts,
  sealedProductLines,
  sealedCollectionLimits,
  type SealedFetch,
} from "../../../domain/extension/sealed-products/collector";
import { page, response, selection, detail } from "./fixture";
describe("sealed product collector", () => {
  it("retains the endpoint's fixed failure code without copying a response body", async () => {
    const request = vi.fn<SealedFetch>(async () =>
      response(
        { diagnostic: "Never include this provider data" },
        {
          ok: false,
          status: null,
          contentClass: "unknown",
          bytes: 0,
          code: "network-error",
        },
      ),
    );
    const { receipt } = await collectSealedProducts({ selection: selection(), request });
    expect(receipt).toMatchObject({
      verdict: "unqualified",
      pages: 0,
      posts: 0,
      requests: [{ endpoint: "search", status: null, contentClass: "unknown", bytes: 0, code: "network-error" }],
    });
    expect(JSON.stringify(receipt)).not.toContain("Never include this provider data");
    expect(request).toHaveBeenCalledOnce();
  });

  it("reconciles three pages, finding the only sealed product beyond page two", async () => {
    const request = vi.fn<SealedFetch>(async (request) =>
      response(request.endpoint === "search" ? page(request.from, 49) : { ...detail(), productId: request.productId }),
    );
    const { receipt, details } = await collectSealedProducts({ selection: selection(), request });
    expect(receipt).toMatchObject({
      verdict: "complete",
      totalResults: 49,
      pages: 3,
      summaries: 49,
      sealedCandidates: 1,
    });
    expect(details).toHaveLength(1);
    expect(request.mock.calls.map(([request]) => request.endpoint)).toEqual(["search", "search", "search", "detail"]);
    expect(JSON.stringify(receipt)).not.toContain(selection().setName);
    expect(receipt.requests.map((request) => Object.keys(request))).toEqual(
      Array(4).fill(["endpoint", "status", "contentClass", "bytes"]),
    );
  });
  it.each([
    "missing",
    "short",
    "duplicate",
    "partial-duplicate",
    "drift",
    "cap",
    "errors",
    "type",
    "http",
    "non-json",
    "not-ok",
  ])("never completes the %s bypass mutant with a sealed product still unread", async (mutation) => {
    const request = vi.fn<SealedFetch>(async (request) => {
      if (request.endpoint !== "search") throw new Error("detail-must-not-run");
      if (mutation === "cap") return response(page(0, sealedCollectionLimits.maxProducts + 1));
      if (request.from === 0) return response(page(0, 49));
      const body = page(24, 49);
      if (mutation === "missing") throw new Error("missing");
      if (mutation === "short") body.results[0]!.results.pop();
      if (mutation === "duplicate") body.results[0]!.results = page(0, 49).results[0]!.results;
      if (mutation === "partial-duplicate") body.results[0]!.results[0] = page(0, 49).results[0]!.results[0]!;
      if (mutation === "drift") body.results[0]!.totalResults++;
      if (mutation === "errors") return response({ ...body, errors: ["private"] });
      if (mutation === "type") return response({ errors: [], results: [{ ...body.results[0], totalResults: "49" }] });
      return response(
        body,
        mutation === "http"
          ? { status: 500 }
          : mutation === "non-json"
            ? { contentClass: "non-json" }
            : mutation === "not-ok"
              ? { ok: false }
              : {},
      );
    });
    const result = await collectSealedProducts({ selection: selection(), request });
    expect(result.receipt.verdict).not.toBe("complete");
    expect(result.details).toEqual([]);
    expect(request.mock.calls.every(([request]) => request.endpoint === "search")).toBe(true);
  });
  it("uses the salvage fallback only after a reconciled empty scoped search", async () => {
    const request = vi.fn<SealedFetch>(async (request) =>
      response(
        request.endpoint === "search" ? page(0, request.includeProductLine ? 0 : 1) : { ...detail(), productId: 1 },
      ),
    );
    const result = await collectSealedProducts({ selection: selection(), request });
    expect(result.receipt.verdict).toBe("complete");
    expect(
      request.mock.calls.slice(0, 2).map(([request]) => request.endpoint === "search" && request.includeProductLine),
    ).toEqual([true, false]);
  });
  it("stops at the page cap even when fallback is needed", async () => {
    const request = vi.fn<SealedFetch>(async (request) =>
      response(request.endpoint === "search" ? page(request.from, 12_000, -1) : null),
    );
    expect((await collectSealedProducts({ selection: selection(), request })).receipt.verdict).toBe("incomplete");
    expect(request).toHaveBeenCalledTimes(500);
  });
  it("never completes when retained detail bytes hit cap+1", async () => {
    const request = vi.fn<SealedFetch>(async (request) =>
      response(
        request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: 1 },
        request.endpoint === "detail" ? { bytes: sealedCollectionLimits.maxDetailBytes + 1 } : {},
      ),
    );
    expect((await collectSealedProducts({ selection: selection(), request })).receipt.verdict).toBe("incomplete");
  });
  it.each([2, 68, 82])("refuses unsupported or unbound line %s without any request", async (productLineId) => {
    const request = vi.fn();
    expect(
      (await collectSealedProducts({ selection: { ...selection(), productLineId }, request })).receipt.verdict,
    ).toBe("unqualified");
    expect(request).not.toHaveBeenCalled();
    expect(sealedProductLines().map((line) => line.id)).toEqual([1, 3, 71]);
  });
  it.each([
    "productId",
    "productName",
    "productLineId",
    "productLineName",
    "productTypeName",
    "setId",
    "setName",
    "setUrlName",
    "rarityName",
    "sealed",
    "productStatusId",
    "customAttributes",
  ])("rejects ill-typed summary field %s", async (field) => {
    const body = page(0, 1);
    Object.assign(body.results[0]!.results[0]!, { [field]: null });
    const result = await collectSealedProducts({ selection: selection(), request: async () => response(body) });
    expect(result.receipt.verdict).toBe("unqualified");
  });
});
