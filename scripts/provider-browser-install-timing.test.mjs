import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeTimingRecords,
  isValidTimingRecord,
  parseTimingRecord,
  timingRecordLine,
} from "./provider-browser-install-timing.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";

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
  phase: "browser-download",
  source: "provider-download",
  cache: "miss",
  retryCount: 0,
  terminalOutcome: "timeout",
};
const owningJob = {
  id: Number(record.jobId),
  run_id: Number(record.runId),
  run_attempt: 1,
  head_sha: headSha,
  steps: [
    {
      name: record.step,
      status: "completed",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2027-01-01T00:00:00Z",
    },
  ],
};
const authority = { headSha, owningJob };
const line = (value) => `provider-browser-install-timing/v1 ${JSON.stringify(value)}`;
afterEach(() => vi.useRealTimers());

describe("provider-browser-install-timing/v1", () => {
  it("accepts provider-browser-install-timing/v1", () => {
    expect(parseTimingRecord(timingRecordLine(record))).toEqual(record);
    expect(consumeTimingRecords([timingRecordLine(record)], authority)).toEqual([record]);
  });
  it.each([
    { ...record, runId: 123 },
    { ...record, jobId: "x" },
    { ...record, runAttempt: -1 },
    { ...record, elapsedMs: 1.5 },
    { ...record, elapsedMs: 1 },
    { ...record, phase: "unknown" },
    { ...record, step: "setup" },
    { ...record, startedAt: "2026-02-30T18:23:08.000Z" },
    { ...record, endedAt: "2026-10-22T18:23:07.000Z" },
    { ...record, startedAt: "2026-10-22T18:23:08-05:00" },
    { ...record, extra: "PRIVATE" },
  ])("rejects malformed records", (value) => expect(consumeTimingRecords([line(value)], authority)).toEqual([]));
  it("rejects malformed JSON and missing fields", () => {
    expect(parseTimingRecord("provider-browser-install-timing/v1 {")).toBeNull();
    for (const field of Object.keys(record)) {
      const value = { ...record };
      delete value[field];
      expect(isValidTimingRecord(value), field).toBe(false);
    }
  });
  it("rejects wrong-head records", () =>
    expect(consumeTimingRecords([line({ ...record, headSha: "b".repeat(40) })], authority)).toEqual([]));
  it("excludes skipped/cancelled-before-step records", () => {
    expect(consumeTimingRecords([line(record)], { headSha, stepExecuted: false })).toEqual([]);
    expect(consumeTimingRecords([line(record)])).toEqual([]);
    expect(consumeTimingRecords([line({ ...record, terminalOutcome: "skipped" })], authority)).toEqual([]);
    expect(consumeTimingRecords([line({ ...record, terminalOutcome: "cancelled-before-step" })], authority)).toEqual(
      [],
    );
  });
  it("excludes duplicate owning records", () =>
    expect(consumeTimingRecords([line(record), line(record)], authority)).toEqual([]));
  it.each([
    { ...owningJob, id: 1 },
    { ...owningJob, run_id: 1 },
    { ...owningJob, run_attempt: 2 },
    { ...owningJob, head_sha: "b".repeat(40) },
    { ...owningJob, steps: [] },
    { ...owningJob, steps: {} },
    { ...owningJob, steps: [{ ...owningJob.steps[0], started_at: "invalid" }] },
    { ...owningJob, steps: [...owningJob.steps, ...owningJob.steps] },
    { ...owningJob, steps: [{ ...owningJob.steps[0], conclusion: "skipped" }] },
    { ...owningJob, steps: [{ ...owningJob.steps[0], conclusion: "cancelled", started_at: null }] },
  ])("rejects non-owning or nonexecuted job API authority", (job) => {
    expect(consumeTimingRecords([line(record)], { headSha, owningJob: job })).toEqual([]);
  });
  it("rejects oversized/raw payloads and malformed companion records", () => {
    expect(parseTimingRecord(line({ ...record, extra: "x".repeat(3000) }))).toBeNull();
    expect(consumeTimingRecords([line(record), "provider-browser-install-timing/v1 {"], authority)).toEqual([]);
  });
  it("rejects nonzero-retry records", () =>
    expect(consumeTimingRecords([line({ ...record, retryCount: 1 })], authority)).toEqual([]));
  it("validates source/cache classification", () => {
    for (const [source, cache] of [
      ["cache", "hit"],
      ["provider-download", "miss"],
      ["provider-download", "not-applicable"],
    ]) {
      expect(isValidTimingRecord({ ...record, source, cache })).toBe(true);
    }
    for (const [source, cache] of [
      ["cache", "miss"],
      ["provider-download", "hit"],
      ["raw-provider", "miss"],
      ["cache", "unknown"],
    ]) {
      expect(isValidTimingRecord({ ...record, source, cache })).toBe(false);
    }
  });
  it("live emit/consume uses the wrapper's sole terminal record", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 555,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: vi.fn(),
    });
    const lines = [];
    const result = runInstaller({
      identity: { runId: record.runId, runAttempt: 1, jobId: record.jobId, headSha },
      env: { INSTALLER_TIMEOUT_SECONDS: "600" },
      spawnImpl: () => child,
      write: (value) => lines.push(value),
    });
    child.stdout.write("provider-boundary-setup-stage:install-chromium\nprovider-boundary-setup-stage:complete\n");
    child.emit("message", { installerStatus: 0 });
    child.emit("close", 0);
    const actual = await result;
    expect(consumeTimingRecords(lines, authority)).toEqual([actual.record]);
    expect(lines).toHaveLength(1);
  });
});
