import assert from "node:assert/strict";
import { test } from "node:test";
import { mechanismNames, parseProbeRecord } from "./probe-record.ts";

const syntheticRecord = () => ({
  schemaVersion: 1,
  chromiumVersion: "149.0.0.0",
  playwrightVersion: "1.60.0",
  capturedAt: "2026-09-15T22:00:00.000Z",
  mechanisms: mechanismNames.map((name) => ({
    name,
    available: false,
    terminatedMidFetch: false,
    pendingTransactionAtomic: false,
    refetchOnlyAfterAlarm: false,
    indexedDbSurvived: false,
  })),
  alarm: { requestedPeriodSeconds: 30, observedFirstFireMs: 30_001, refiredAfterRelaunch: false },
  storage: { localSurvived: false, sessionSurvived: false },
});

test("synthetic schema control round-trips a complete negative record, not Chromium evidence", () => {
  assert.deepEqual(parseProbeRecord(syntheticRecord()), syntheticRecord());
});

const negatives: [string, (record: Record<string, any>) => unknown][] = [
  ["empty", () => ({})],
  ["partial", () => ({ schemaVersion: 1 })],
  ["top unknown", (r) => ({ ...r, unknown: true })],
  [
    "mechanism unknown",
    (r) => {
      r.mechanisms[0].unknown = true;
      return r;
    },
  ],
  [
    "alarm unknown",
    (r) => {
      r.alarm.unknown = true;
      return r;
    },
  ],
  [
    "storage unknown",
    (r) => {
      r.storage.unknown = true;
      return r;
    },
  ],
  [
    "missing mechanism field",
    (r) => {
      delete r.mechanisms[0].indexedDbSurvived;
      return r;
    },
  ],
  [
    "duplicate mechanism",
    (r) => {
      r.mechanisms[1] = r.mechanisms[0];
      return r;
    },
  ],
  [
    "missing mechanism",
    (r) => {
      r.mechanisms.pop();
      return r;
    },
  ],
  [
    "unavailable positive",
    (r) => {
      r.mechanisms[0].terminatedMidFetch = true;
      return r;
    },
  ],
  ["date only", (r) => ({ ...r, capturedAt: "2026-09-15" })],
  ["missing zone", (r) => ({ ...r, capturedAt: "2026-09-15T22:00:00.000" })],
  ["non UTC", (r) => ({ ...r, capturedAt: "2026-09-15T22:00:00.000+00:00" })],
  ["invalid date", (r) => ({ ...r, capturedAt: "2026-02-30T22:00:00.000Z" })],
  ["non four-part Chromium", (r) => ({ ...r, chromiumVersion: "149.0.0" })],
  ["version range", (r) => ({ ...r, chromiumVersion: "99999999999999999.0.0.0" })],
  ["Playwright range", (r) => ({ ...r, playwrightVersion: "1.999999999.0" })],
  [
    "wrong type",
    (r) => {
      r.storage.localSurvived = "false";
      return r;
    },
  ],
  ...[-1, 60_001, 1.5, Infinity, NaN].map((value): [string, (r: Record<string, any>) => unknown] => [
    `latency ${value}`,
    (r) => {
      r.alarm.observedFirstFireMs = value;
      return r;
    },
  ]),
  [
    "period out of range",
    (r) => {
      r.alarm.requestedPeriodSeconds = 0;
      return r;
    },
  ],
];
for (const [name, mutate] of negatives)
  test(`closed record rejects ${name}`, () => assert.throws(() => parseProbeRecord(mutate(syntheticRecord()))));
