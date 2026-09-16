import assert from "node:assert/strict";
import { test } from "vitest";
import {
  mechanismFacts,
  mechanismNames,
  mechanismRoutes,
  parseProbeRecord,
  reasonCodes,
  selectMechanism,
  type ProbeRecord,
} from "./probe-record";

type ProbeFixture = Omit<ProbeRecord, "schemaVersion" | "mechanisms" | "alarm" | "storage"> & {
  schemaVersion: number;
  mechanisms: Record<string, unknown>[];
  alarm: Record<string, unknown>;
  storage: Record<string, unknown>;
};

const reason = () => ({ code: "route-unavailable", message: "SYNTHETIC route unavailable control" });

const syntheticRecord = (): ProbeFixture => ({
  schemaVersion: 2,
  chromiumVersion: "149.0.0.0",
  playwrightVersion: "1.60.0",
  capturedAt: "2026-09-15T22:00:00.000Z",
  mechanisms: mechanismNames.map((name) => ({
    name,
    available: false,
    route: mechanismRoutes[name],
    intervenedAt: "2026-09-15T22:00:00.000Z",
    artifactRef: `SYNTHETIC/${name}.json`,
    unavailableReason: reason().message,
    ...Object.fromEntries(
      mechanismFacts.flatMap((fact) => [
        [fact, null],
        [`${fact}Reason`, reason()],
      ]),
    ),
  })),
  alarm: {
    mechanism: "context.close",
    artifactRef: "SYNTHETIC/context.close.json",
    requestedPeriodSeconds: 30,
    observedFirstFireMs: 30_001,
    refiredAfterRelaunch: null,
    refiredAfterRelaunchReason: reason(),
  },
  storage: {
    mechanism: "context.close",
    artifactRef: "SYNTHETIC/context.close.json",
    localSurvived: null,
    localSurvivedReason: reason(),
    sessionSurvived: null,
    sessionSurvivedReason: reason(),
  },
});

test("synthetic schema control round-trips a complete negative record, not Chromium evidence", () => {
  assert.deepEqual(parseProbeRecord(syntheticRecord()), syntheticRecord());
});

const negatives: [string, (record: ProbeFixture) => unknown][] = [
  ["empty", () => ({})],
  ["partial", () => ({ schemaVersion: 2 })],
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
  ...[-1, 60_001, 1.5, Infinity, NaN].map((value): [string, (r: ProbeFixture) => unknown] => [
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

function availableRecord(): ProbeFixture {
  const record = syntheticRecord();
  for (const row of record.mechanisms) {
    row.available = true;
    delete row.unavailableReason;
    for (const fact of mechanismFacts) {
      row[fact] = true;
      delete row[`${fact}Reason`];
    }
  }
  for (const [row, names] of [
    [record.alarm, ["refiredAfterRelaunch"]],
    [record.storage, ["localSurvived", "sessionSurvived"]],
  ] as const) {
    for (const name of names) {
      row[name] = true;
      delete row[`${name}Reason`];
    }
  }
  return record;
}

test("available means executed, including independently measured false facts", () => {
  const record = availableRecord();
  for (const row of record.mechanisms) for (const fact of mechanismFacts) row[fact] = false;
  record.alarm.refiredAfterRelaunch = false;
  record.storage.localSurvived = false;
  record.storage.sessionSurvived = false;
  assert.deepEqual(parseProbeRecord(record), record);
  assert.equal(selectMechanism(parseProbeRecord(record)), undefined);
});

test("executed intervention may have all facts unobserved with captured reasons", () => {
  const record = syntheticRecord();
  for (const row of record.mechanisms) {
    row.available = true;
    delete row.unavailableReason;
    for (const fact of mechanismFacts)
      row[`${fact}Reason`] = { code: "worker-not-replaced", message: "SYNTHETIC replacement timeout" };
  }
  assert.deepEqual(parseProbeRecord(record), record);
  assert.equal(selectMechanism(parseProbeRecord(record)), undefined);
});

const surfaces = [
  ...mechanismFacts.map((fact) => ({
    label: `mechanism ${fact}`,
    row: (r: ProbeFixture) => r.mechanisms[0],
    fact,
  })),
  { label: "alarm latency", row: (r: ProbeFixture) => r.alarm, fact: "observedFirstFireMs" },
  { label: "alarm refire", row: (r: ProbeFixture) => r.alarm, fact: "refiredAfterRelaunch" },
  ...["localSurvived", "sessionSurvived"].map((fact) => ({
    label: `storage ${fact}`,
    row: (r: ProbeFixture) => r.storage,
    fact,
  })),
];
for (const { label, row, fact } of surfaces) {
  const reject = (name: string, mutate: (r: Record<string, unknown>) => void) =>
    test(`${label} rejects ${name}`, () => {
      const record = availableRecord();
      mutate(row(record));
      assert.throws(() => parseProbeRecord(record));
    });
  reject("missing fact", (r) => {
    delete r[fact];
  });
  reject("null without reason", (r) => {
    r[fact] = null;
  });
  reject("observed value with reason", (r) => {
    r[`${fact}Reason`] = reason();
  });
  for (const [name, value] of [
    ["unknown code", { ...reason(), code: "unknown" }],
    ["nested unknown", { ...reason(), unknown: true }],
    ["missing code", { message: reason().message }],
    ["missing message", { code: reason().code }],
    ["blank message", { ...reason(), message: " " }],
    ["oversized message", { ...reason(), message: "x".repeat(1025) }],
  ] as const)
    reject(name, (r) => {
      r[fact] = null;
      r[`${fact}Reason`] = value;
    });
  for (const code of reasonCodes)
    test(`${label} accepts reasoned null ${code}`, () => {
      const record = availableRecord();
      row(record)[fact] = null;
      row(record)[`${fact}Reason`] = { code, message: "SYNTHETIC captured reason control" };
      assert.deepEqual(parseProbeRecord(record), record);
    });
}

const v2Negatives: [string, (r: ProbeFixture) => void][] = [
  [
    "v1 record",
    (r) => {
      r.schemaVersion = 1;
    },
  ],
  [
    "available all-null without reasons",
    (r) => {
      for (const fact of mechanismFacts) r.mechanisms[0][fact] = null;
    },
  ],
  [
    "available with unavailableReason",
    (r) => {
      r.mechanisms[0].unavailableReason = "SYNTHETIC";
    },
  ],
  [
    "substituted CDP route",
    (r) => {
      r.mechanisms[1].route = "context.newCDPSession(page)";
    },
  ],
  [
    "intervention date only",
    (r) => {
      r.mechanisms[0].intervenedAt = "2026-09-15";
    },
  ],
  [
    "intervention invalid date",
    (r) => {
      r.mechanisms[0].intervenedAt = "2026-02-30T22:00:00.000Z";
    },
  ],
  [
    "Chromium upper bound",
    (r) => {
      r.chromiumVersion = "1000001.0.0.0";
    },
  ],
  [
    "Playwright upper bound",
    (r) => {
      r.playwrightVersion = "1.1000001.0";
    },
  ],
];
for (const key of ["route", "artifactRef", "intervenedAt"])
  v2Negatives.push([
    `missing ${key}`,
    (r) => {
      delete r.mechanisms[0][key];
    },
  ]);
for (const surface of ["alarm", "storage"] as const)
  for (const key of ["artifactRef", "mechanism"])
    for (const value of [undefined, "", " ", "unknown", "x".repeat(1025)])
      v2Negatives.push([
        `${surface} invalid ${key} ${String(value).slice(0, 12)}`,
        (r) => {
          r[surface][key] = value;
        },
      ]);
for (const [name, mutate] of v2Negatives)
  test(`v2 rejects ${name}`, () => {
    const record = availableRecord();
    mutate(record);
    assert.throws(() => parseProbeRecord(record));
  });
for (const fact of mechanismFacts)
  for (const value of [false, true])
    test(`unavailable rejects measured ${fact} ${value}`, () => {
      const record = syntheticRecord();
      record.mechanisms[0][fact] = value;
      delete record.mechanisms[0][`${fact}Reason`];
      assert.throws(() => parseProbeRecord(record));
    });
for (const [surface, fact] of [
  ["alarm", "refiredAfterRelaunch"],
  ["storage", "localSurvived"],
  ["storage", "sessionSurvived"],
] as const)
  for (const value of [false, true])
    test(`unavailable source rejects ${surface}.${fact} ${value}`, () => {
      const record = syntheticRecord();
      record[surface!][fact!] = value;
      delete record[surface!][`${fact}Reason`];
      assert.throws(() => parseProbeRecord(record));
    });
for (const value of [undefined, "", " ", "x".repeat(1025)])
  test(`unavailable rejects invalid reason ${String(value).slice(0, 12)}`, () => {
    const record = syntheticRecord();
    record.mechanisms[0].unavailableReason = value;
    assert.throws(() => parseProbeRecord(record));
  });

test("downstream requires one source with four true facts, refire, and both storage observations", () => {
  assert.equal(selectMechanism(parseProbeRecord(syntheticRecord())), undefined);
  const record = availableRecord();
  record.storage.sessionSurvived = false;
  assert.equal(selectMechanism(parseProbeRecord(record))?.name, "context.close");
  for (const { row, fact } of surfaces.filter((surface) => surface.fact !== "observedFirstFireMs")) {
    const copy = structuredClone(record);
    row(copy)[fact] = null;
    row(copy)[`${fact}Reason`] = reason();
    assert.equal(selectMechanism(parseProbeRecord(copy)), undefined);
  }
  for (const surface of ["alarm", "storage"] as const) {
    const copy = structuredClone(record);
    copy[surface].mechanism = "runtime.reload";
    copy[surface].artifactRef = "SYNTHETIC/runtime.reload.json";
    assert.equal(selectMechanism(parseProbeRecord(copy)), undefined);
  }
  record.alarm.refiredAfterRelaunch = false;
  assert.equal(selectMechanism(parseProbeRecord(record)), undefined);
});
