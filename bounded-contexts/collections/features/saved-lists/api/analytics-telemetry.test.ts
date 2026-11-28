import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SavedListAdditionResponse } from "./discovery-contracts";
import type { SavedListValuationCoverage } from "../../saved-list-valuation/domain/contracts";
import {
  additionAnalytics,
  analyticsLabel,
  createSavedListAnalyticsRecorder,
  recordSavedListAnalytics,
  savedListAnalyticsEvents,
  savedListAnalyticsKeys,
  savedListAnalyticsValues,
  valuationAnalytics,
  type SavedListAnalyticsEvent,
} from "./analytics-telemetry";

const forbidden = [
  "listId",
  "lineId",
  "commandId",
  "catalogItemId",
  "productId",
  "accountId",
  "verifier",
  "secret",
  "note",
  "tag",
  "trackedQuantity",
  "unitEstimateAmount",
  "estimatedValueAmount",
  "estimatedTotalAmount",
  "estimatedValueBand",
  "estimatedTotalBand",
  "lowAmount",
  "highAmount",
];
const marker = "synthetic_private_marker_7137";

function recorderWithSinks() {
  const add = vi.fn();
  const createCounter = vi.fn(() => ({ add }));
  const logger = { info: vi.fn(), warn: vi.fn() };
  return { recorder: createSavedListAnalyticsRecorder({ createCounter, logger }), createCounter, add, logger };
}

describe("Saved List analytics recorder", () => {
  it("emits the exact metric and log fields for every event, ignoring labels outside its tuple", () => {
    const { recorder, createCounter, add, logger } = recorderWithSinks();
    expect(createCounter).toHaveBeenCalledExactlyOnceWith("chase_sets_collections_saved_list_events_total");
    expect(add).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();

    const populated = {
      surface: "item-detail",
      outcome: "merged",
      coverage_band: "partial",
      estimate_state: "stale",
    } as const;
    const expected = [
      { event: "list_created", surface: "item-detail", outcome: "none", coverage_band: "none", estimate_state: "none" },
      {
        event: "product_added",
        surface: "item-detail",
        outcome: "merged",
        coverage_band: "none",
        estimate_state: "none",
      },
      {
        event: "first_five_lines",
        surface: "item-detail",
        outcome: "none",
        coverage_band: "none",
        estimate_state: "none",
      },
      {
        event: "valuation_coverage_band",
        surface: "none",
        outcome: "none",
        coverage_band: "partial",
        estimate_state: "stale",
      },
    ] as const;
    for (const { event } of expected) recorder.record({ event, ...populated });
    const attributes = expected.map((fields) => ({ context: "collections", ...fields }));
    expect(add.mock.calls).toEqual(attributes.map((fields) => [1, fields]));
    expect(logger.info.mock.calls).toEqual(
      attributes.map((fields) => [
        "Collections Saved List analytics event captured.",
        { ...fields, type: "collections.saved_list.analytics_event" },
      ]),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sanitizes malformed labels and unknown events without forwarding sensitive input", () => {
    const { recorder, add, logger } = recorderWithSinks();
    const sensitive = Object.fromEntries(forbidden.map((key) => [key, marker]));
    const inputs = [
      { event: "product_added", surface: null, outcome: "", coverage_band: marker, estimate_state: marker },
      {
        event: "valuation_coverage_band",
        surface: marker,
        outcome: marker,
        coverage_band: marker,
        estimate_state: "current",
      },
      { event: marker, surface: "search", outcome: "added", coverage_band: "high", estimate_state: "current" },
    ];
    for (const input of inputs) recorder.record({ ...input, ...sensitive } as unknown as SavedListAnalyticsEvent);

    const expected = [
      {
        context: "collections",
        event: "product_added",
        surface: "invalid",
        outcome: "invalid",
        coverage_band: "none",
        estimate_state: "none",
      },
      {
        context: "collections",
        event: "valuation_coverage_band",
        surface: "none",
        outcome: "none",
        coverage_band: "invalid",
        estimate_state: "current",
      },
      {
        context: "collections",
        event: "invalid",
        surface: "none",
        outcome: "none",
        coverage_band: "none",
        estimate_state: "none",
      },
    ];
    expect(add.mock.calls).toEqual(expected.map((fields) => [1, fields]));
    expect(logger.info.mock.calls).toEqual(
      expected.map((fields) => [
        "Collections Saved List analytics event captured.",
        { ...fields, type: "collections.saved_list.analytics_event" },
      ]),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([false, true])("isolates counter and log failures (warning throws: %s)", (warningThrows) => {
    const { recorder, add, logger } = recorderWithSinks();
    const fail = () => {
      throw new Error(marker);
    };
    add.mockImplementation((_increment, fields) => {
      fields.note = marker;
      fail();
    });
    if (warningThrows) logger.warn.mockImplementation(fail);
    logger.info.mockImplementation(fail);
    expect(() => recorder.record(valuationAnalytics(coverage(0, 0)))).not.toThrow();
    expect(add).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Collections Saved List analytics recorder failed.", {
      failure: "counter",
      type: "collections.saved_list.analytics_recorder_failure",
    });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(marker);
  });

  it("ignores unreadable event objects without calling any sink", () => {
    const { recorder, add, logger } = recorderWithSinks();
    const signal = {
      ...valuationAnalytics(coverage(0, 0)),
      get event(): never {
        throw new Error(marker);
      },
    };
    expect(() => recorder.record(signal)).not.toThrow();
    expect(add).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function addition(
  count: number,
  prior: number,
  outcome: "created" | "line-changes-applied" = "line-changes-applied",
  replayed = false,
  lineStatus: "added" | "merged" = "added",
): SavedListAdditionResponse {
  return {
    command: {
      receipt: {
        schemaVersion: 1,
        commandId: marker,
        listId: marker,
        outcome,
        previousVersion: 0,
        committedVersion: 1,
        replayed,
        lineResults: count > prior ? [{ operationId: marker, status: "added", lineId: null, error: null }] : [],
      },
      savedList: { lines: Array.from({ length: count }, () => ({ note: marker, tag: marker, trackedQuantity: 7137 })) },
    },
    listId: marker,
    title: marker,
    lineStatus,
    alreadyClaimed: false,
    analyticsLabel: "saved-list.added",
  } as unknown as SavedListAdditionResponse;
}

function coverage(
  priced: number,
  total: number,
  missing = 0,
  stale = 0,
  lowConfidence = 0,
): SavedListValuationCoverage {
  const value = (lines: number) => ({ lines, units: 7137 });
  return {
    priced: value(priced),
    total: value(total),
    missing: value(missing),
    stale: value(stale),
    lowConfidence: value(lowConfidence),
  };
}

describe("Saved List analytics closed privacy contract", () => {
  it("exports the four frozen events in order", () => {
    expect(savedListAnalyticsEvents).toEqual([
      "list_created",
      "product_added",
      "first_five_lines",
      "valuation_coverage_band",
    ]);
    expect(Object.isFrozen(savedListAnalyticsEvents)).toBe(true);
  });

  it.each(Object.entries(savedListAnalyticsValues))(
    "maps every allowed %s token and rejects adversarial values",
    (key, values) => {
      for (const value of values)
        expect(analyticsLabel(key as keyof typeof savedListAnalyticsValues, value)).toBe(value);
      for (const value of [
        null,
        undefined,
        "",
        "x".repeat(500),
        "é",
        "a!",
        "synthetic_valid_but_unregistered_value_000001",
        marker,
      ]) {
        expect(analyticsLabel(key as keyof typeof savedListAnalyticsValues, value)).toBe("invalid");
      }
    },
  );

  it("emits only tuple-member keys and values, never adversarial private input", () => {
    const response = addition(5, 4);
    const events = [
      ...additionAnalytics(response, "search", { ...response.command.receipt, outcome: "created" }),
      valuationAnalytics(coverage(2, 4, 1)),
    ];
    expect(events.map((item) => item.event)).toEqual([...savedListAnalyticsEvents]);
    for (const item of events) {
      expect(Object.keys(item).sort()).toEqual(["event", ...Object.keys(savedListAnalyticsValues)].sort());
      expect(forbidden.filter((key) => Object.hasOwn(item, key))).toEqual([]);
      for (const [key, values] of Object.entries(savedListAnalyticsValues)) {
        const output = item[key as keyof typeof savedListAnalyticsValues];
        expect([...values, "none", "invalid"]).toContain(output);
        if (!(savedListAnalyticsKeys[item.event] as readonly string[]).includes(key)) expect(output).toBe("none");
      }
      expect(JSON.stringify(item)).not.toContain(marker);
      expect(JSON.stringify(item)).not.toContain("7137");
    }
  });

  it("records only a four-to-five crossing and never its replay, merge or sixth add", () => {
    expect(additionAnalytics(addition(3, 2), "search").map((item) => item.event)).not.toContain("first_five_lines");
    expect(additionAnalytics(addition(4, 3), "search").map((item) => item.event)).not.toContain("first_five_lines");
    expect(additionAnalytics(addition(5, 4), "search").map((item) => item.event)).toContain("first_five_lines");
    expect(additionAnalytics(addition(6, 5), "search").map((item) => item.event)).not.toContain("first_five_lines");
    expect(
      additionAnalytics(addition(5, 5, "line-changes-applied", false, "merged"), "search").map((item) => item.event),
    ).not.toContain("first_five_lines");
    expect(additionAnalytics(addition(5, 4, "created", true), "search")).toEqual([]);
  });

  it.each([
    [coverage(0, 0), "empty", "empty"],
    [coverage(0, 5, 5), "none", "incomplete"],
    [coverage(1, 5, 0, 4), "low", "stale"],
    [coverage(2, 4, 0, 0, 1), "partial", "low_confidence"],
    [coverage(9, 10), "high", "current"],
    [coverage(10, 10), "full", "current"],
  ] as const)("classifies count-only valuation coverage %#", (input, band, state) => {
    expect(valuationAnalytics(input)).toMatchObject({ coverage_band: band, estimate_state: state });
  });

  it("detaches throwing and rejecting recorders", async () => {
    expect(() =>
      recordSavedListAnalytics(
        {
          record: () => {
            throw new Error(marker);
          },
        },
        [valuationAnalytics(coverage(0, 0))],
      ),
    ).not.toThrow();
    const record = vi.fn().mockRejectedValue(new Error(marker));
    recordSavedListAnalytics({ record }, [valuationAnalytics(coverage(0, 0))]);
    await Promise.resolve();
    expect(record).toHaveBeenCalledOnce();
  });

  it("keeps document sets equal to event, per-event key and per-key value tuples in both directions", () => {
    const doc = readFileSync(new URL("../../../docs/saved-list-analytics.md", import.meta.url), "utf8");
    const rows = (section: string) =>
      doc
        .split(`## ${section}\n`)[1]!
        .split("\n## ")[0]!
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"));
    const pairs = (section: string) =>
      rows(section)
        .slice(1)
        .map((line) =>
          line
            .split("|")
            .slice(1, 3)
            .map((cell) => cell.trim()),
        );
    const events = pairs("Events");
    expect(events.map(([name]) => name)).toEqual([...savedListAnalyticsEvents]);
    for (const [name, keys] of events)
      expect(keys!.split(", ")).toEqual([...savedListAnalyticsKeys[name as keyof typeof savedListAnalyticsKeys]]);
    const values = pairs("Allowed values");
    expect(values.map(([key]) => key).sort()).toEqual(Object.keys(savedListAnalyticsValues).sort());
    for (const [key, tokens] of values)
      expect(tokens!.split(", ")).toEqual([...savedListAnalyticsValues[key as keyof typeof savedListAnalyticsValues]]);
    const forbiddenSection = doc.split("## Forbidden keys")[1]!.split("## Derivation")[0]!;
    const forbiddenKeys = [...forbiddenSection.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)].map(([, key]) => key);
    expect(forbiddenKeys).toEqual(forbidden);
  });
});
