import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SavedListAdditionResponse } from "./discovery-contracts";
import type { SavedListValuationCoverage } from "../../saved-list-valuation/domain/contracts";
import {
  additionAnalytics,
  analyticsLabel,
  recordSavedListAnalytics,
  savedListAnalyticsEvents,
  savedListAnalyticsKeys,
  savedListAnalyticsValues,
  valuationAnalytics,
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
  });
});
