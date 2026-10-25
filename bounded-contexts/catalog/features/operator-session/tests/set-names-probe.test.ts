import { describe, expect, it, vi } from "vitest";
import { probeTcgplayerSetNames, tcgplayerSingleCardUnitConstraints } from "../domain/extension/set-names/probe";

const validEntry = (categoryId: number) => ({
  setNameId: 1,
  categoryId,
  name: "Synthetic Set",
  cleanSetName: "Synthetic Set",
  urlName: "synthetic-set",
  abbreviation: "SYN",
  releaseDate: "2026-01-01",
  isSupplemental: false,
  active: true,
});

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("TCGplayer SetNames probe", () => {
  it("defines the five fixture product-line units", () => {
    expect(tcgplayerSingleCardUnitConstraints.map((unit) => unit.productLineId)).toEqual(["1", "2", "3", "68", "82"]);
  });

  it("records receipt and summary before reduction and redacts hostile values", async () => {
    const order: string[] = [];
    const request = vi.fn(async (productLineId: string) => {
      order.push("fetch");
      return {
        ok: true,
        status: 200,
        contentClass: "json" as const,
        bytes: 100,
        body: { errors: [], results: [{ ...validEntry(Number(productLineId)), hostile: "DO_NOT_REPORT" }] },
      };
    });
    const report = await probeTcgplayerSetNames({
      request,
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      probedAt: "2026-10-24T00:00:00.000Z",
      productLineIds: ["3"],
      onReceipt: () => order.push("receipt"),
      onSummary: () => order.push("summary"),
    });
    expect(order).toEqual(["fetch", "receipt", "summary"]);
    expect(JSON.stringify(report)).not.toContain("DO_NOT_REPORT");
    expect(report.rows[0]?.summary.otherFieldCount).toBe(1);
  });

  it.each([
    [
      "non-2xx",
      { ok: false, status: 503, contentClass: "unknown", bytes: 2, body: null, code: "http-not-success" },
      "http-not-success",
    ],
    [
      "non-json",
      { ok: false, status: 200, contentClass: "non-json", bytes: 5, body: null, code: "non-json" },
      "non-json",
    ],
    [
      "errors",
      {
        ok: true,
        status: 200,
        contentClass: "json",
        bytes: 10,
        body: { errors: [{ message: "secret" }], results: [validEntry(3)] },
      },
      "errors-present",
    ],
    [
      "empty",
      { ok: true, status: 200, contentClass: "json", bytes: 10, body: { errors: [], results: [] } },
      "results-empty",
    ],
    [
      "missing field",
      {
        ok: true,
        status: 200,
        contentClass: "json",
        bytes: 10,
        body: { errors: [], results: [{ ...validEntry(3), active: undefined }] },
      },
      "field-invalid",
    ],
    [
      "category mismatch",
      { ok: true, status: 200, contentClass: "json", bytes: 10, body: { errors: [], results: [validEntry(2)] } },
      "category-id-mismatch",
    ],
  ])("leaves %s unqualified with a fixed code", async (_label, result, reason) => {
    const report = await probeTcgplayerSetNames({
      request: vi.fn(async () => result),
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      probedAt: "2026-10-24T00:00:00.000Z",
      productLineIds: ["3"],
    });
    expect(report.rows[0]?.qualification).toEqual({ status: "unqualified", reasons: [reason] });
  });
});
