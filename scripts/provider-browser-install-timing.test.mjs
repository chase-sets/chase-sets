import { describe, expect, it } from "vitest";
import { consumeTimingRecords, isValidTimingRecord, parseTimingRecord, timingRecordLine } from "./provider-browser-install-timing.mjs";

const headSha = "a".repeat(40);
const record = {
  runId: "39824283716",
  jobId: "120004594778",
  runAttempt: 1,
  elapsedMs: 600000,
  step: "Install provider browser boundary",
  headSha,
  startedAt: "2026-10-22T18:23:08.000Z",
  endedAt: "2026-10-22T18:33:08.000Z",
  phase: "terminal",
  source: "provider-download",
  cache: "miss",
  retryCount: 0,
  terminalOutcome: "timeout",
};

describe("provider-browser-install-timing/v1", () => {
  it("accepts provider-browser-install-timing/v1", () => {
    const line = timingRecordLine(record);
    expect(parseTimingRecord(line)).toEqual(record);
    expect(isValidTimingRecord(record, { headSha })).toBe(true);
  });

  it.each([
    ["malformed", "provider-browser-install-timing/v1 {"] ,
    ["wrong-head", { ...record, headSha: "b".repeat(40) }],
    ["skipped/cancelled-before-step", { ...record, terminalOutcome: "success", elapsedMs: -1 }],
    ["duplicate", [record, record]],
    ["nonzero-retry", { ...record, retryCount: 1 }],
  ])("rejects %s records", (_name, value) => {
    if (typeof value === "string") expect(parseTimingRecord(value)).toBeNull();
    else if (Array.isArray(value)) expect(value).toHaveLength(2);
    else expect(isValidTimingRecord(value, { headSha })).toBe(false);
  });

  it("classifies source and cache values", () => {
    expect(isValidTimingRecord({ ...record, source: "cache", cache: "hit" }, { headSha })).toBe(true);
    expect(isValidTimingRecord({ ...record, source: "provider-download", cache: "not-applicable" }, { headSha })).toBe(true);
  });

  it("consumes one owning record and excludes skipped or cancelled-before-step jobs", () => {
    const line = timingRecordLine(record);
    expect(consumeTimingRecords([line, line], { headSha })).toEqual([]);
    expect(consumeTimingRecords([line], { headSha, stepExecuted: false })).toEqual([]);
  });
});
