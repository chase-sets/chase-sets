import { describe, expect, it, vi } from "vitest";
import {
  probeTcgplayerSetNames,
  serializeSetNamesProbeReport,
  setNamesProbeUnitConstraints,
  type SetNamesRequestResult,
} from "../domain/extension/set-names/probe";

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
    expect(setNamesProbeUnitConstraints.map((unit) => unit.productLineId)).toEqual(["1", "2", "3", "68", "82"]);
  });

  it("records receipt and summary before reduction and redacts every hostile field and key", async () => {
    const order: string[] = [];
    let reduce: () => void = () => undefined;
    const request = vi.fn(async (productLineId: string) => {
      order.push("fetch");
      const marker = "HOSTILE_MARKER";
      const result = {
        ok: true,
        status: 200,
        contentClass: "json" as const,
        bytes: 100,
        body: {
          unexpectedTopLevel: marker,
          errors: [{ message: marker, [marker]: marker }],
          results: [
            {
              ...validEntry(Number(productLineId)),
              name: marker,
              cleanSetName: marker,
              urlName: marker,
              abbreviation: marker,
              releaseDate: marker,
              [marker]: marker,
            },
          ],
        },
      };
      reduce = () => {
        order.push("reduce");
        result.body.results.splice(0);
      };
      return result;
    });
    const report = await probeTcgplayerSetNames({
      request,
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      probedAt: "2026-10-24T00:00:00.000Z",
      productLineIds: ["3"],
      onReceipt: () => order.push("receipt"),
      onSummary: () => {
        order.push("summary");
        reduce();
      },
    });
    expect(order).toEqual(["fetch", "receipt", "summary", "reduce"]);
    expect(serializeSetNamesProbeReport(report)).not.toContain("HOSTILE_MARKER");
    expect(serializeSetNamesProbeReport(report)).not.toContain("unexpectedTopLevel");
    expect(report.rows[0]?.summary.otherFieldCount).toBe(1);
    expect(report.rows[0]?.summary.otherTopLevelKeyCount).toBe(1);
    expect(report.rows[0]?.receipt.resultCount).toBe(1);
    expect(report.rows[0]?.summary.fields.name.present).toBe(1);
  });

  it("keeps edited and repeated inputs bound to their explicit units", async () => {
    const result = {
      ok: true,
      status: 200,
      contentClass: "json" as const,
      bytes: 10,
      body: { errors: [], results: [validEntry(71)] },
    };
    const report = await probeTcgplayerSetNames({
      request: vi.fn(async () => result),
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      productLineInputs: [
        { unitKey: "tcgplayer:lorcana:single-card:source-observation-import", productLineId: "71" },
        { unitKey: "tcgplayer:mtg:single-card:source-observation-import", productLineId: "71" },
      ],
      minIntervalMs: 0,
    });
    expect(report.rows.map((row) => [row.unitKey, row.requestedProductLineId])).toEqual([
      ["tcgplayer:lorcana:single-card:source-observation-import", "71"],
      ["tcgplayer:mtg:single-card:source-observation-import", "71"],
    ]);
  });

  it("spaces requests by at least one second and never targets Chase Sets", async () => {
    let clock = 0;
    const starts: number[] = [];
    const request = vi.fn(async (productLineId: string) => {
      starts.push(clock);
      expect(productLineId).toMatch(/^\d+$/);
      return {
        ok: false,
        status: 503,
        contentClass: "unknown" as const,
        bytes: 0,
        body: null,
        code: "http-not-success" as const,
      };
    });
    await probeTcgplayerSetNames({
      request,
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      productLineInputs: [
        { unitKey: "u1", productLineId: "1" },
        { unitKey: "u2", productLineId: "2" },
        { unitKey: "u3", productLineId: "3" },
      ],
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    expect(starts).toEqual([0, 1_000, 2_000]);
  });

  it.each<[string, SetNamesRequestResult, string]>([
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
      "ok:true non-2xx",
      { ok: true, status: 503, contentClass: "json", bytes: 2, body: { errors: [], results: [validEntry(3)] } },
      "http-not-success",
    ],
    [
      "ok:true non-json",
      { ok: true, status: 200, contentClass: "non-json", bytes: 5, body: { errors: [], results: [validEntry(3)] } },
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
    [
      "body cap",
      { ok: false, status: 200, contentClass: "json", bytes: 4_194_305, body: null, code: "body-cap-exceeded" },
      "body-cap-exceeded",
    ],
    ["timeout", { ok: false, status: 200, contentClass: "json", bytes: 1, body: null, code: "timeout" }, "timeout"],
    [
      "mistyped field",
      {
        ok: true,
        status: 200,
        contentClass: "json",
        bytes: 10,
        body: { errors: [], results: [{ ...validEntry(3), active: "true" }] },
      },
      "field-invalid",
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

  it("accepts documented release-date strings and classifies offsets honestly", async () => {
    const dates = ["2023-02-10T00:00:00", "2023-02-10T00:00:00Z", "2023-02-10T00:00:00.000+00:00", "2023-02-10"];
    const report = await probeTcgplayerSetNames({
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        contentClass: "json" as const,
        bytes: 10,
        body: { errors: [], results: dates.map((releaseDate) => ({ ...validEntry(3), releaseDate })) },
      })),
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      productLineIds: ["3"],
    });
    expect(report.rows[0]?.qualification.status).toBe("qualified");
    expect(report.rows[0]?.summary.releaseDate).toEqual({ dateOnly: 1, instant: 2, other: 1 });
  });

  it("keeps an unqualified row independent of a qualified row", async () => {
    const report = await probeTcgplayerSetNames({
      request: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          contentClass: "unknown",
          bytes: 0,
          body: null,
          code: "http-not-success",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          contentClass: "json",
          bytes: 10,
          body: { errors: [], results: [validEntry(2)] },
        }),
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      productLineInputs: [
        { unitKey: "u1", productLineId: "1" },
        { unitKey: "u2", productLineId: "2" },
      ],
      minIntervalMs: 0,
    });
    expect(report.rows.map((row) => row.qualification.status)).toEqual(["unqualified", "qualified"]);
  });

  it("counts controls, not printable non-ASCII, as non-printable", async () => {
    const report = await probeTcgplayerSetNames({
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        contentClass: "json" as const,
        bytes: 10,
        body: {
          errors: [],
          results: [{ ...validEntry(3), name: "Pokémon — Set", cleanSetName: "A\u0007B\u200B" }],
        },
      })),
      extensionVersion: "0.1.0",
      buildCommit: "synthetic-build",
      browserMajor: "synthetic-browser",
      productLineIds: ["3"],
    });
    expect(report.rows[0]?.summary.fields.name.nonPrintableCount).toBe(0);
    expect(report.rows[0]?.summary.fields.cleanSetName.nonPrintableCount).toBe(2);
  });
});
