import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { BrowserContext, Worker } from "@playwright/test";
import { test, vi } from "vitest";
import { candidateOptions } from "./build-fixture";
import { settledStartup, type AlarmEnsure } from "./browser-observation";
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

test("synthetic short-window and omitted re-ensure controls never qualify through the real selector", () => {
  const short = availableRecord();
  short.mechanisms[0].refetchOnlyAfterAlarm = null;
  short.mechanisms[0].refetchOnlyAfterAlarmReason = {
    code: "window-shorter-than-period",
    message: "SYNTHETIC elapsed=40000 required=65001",
  };
  short.alarm.refiredAfterRelaunch = null;
  short.alarm.refiredAfterRelaunchReason = short.mechanisms[0].refetchOnlyAfterAlarmReason;
  assert.equal(selectMechanism(parseProbeRecord(short)), undefined);
  const omitted = availableRecord();
  omitted.mechanisms[0].artifactRef = "SYNTHETIC/context.close-without-alarm-reensure.json";
  omitted.alarm.artifactRef = omitted.mechanisms[0].artifactRef;
  omitted.storage.artifactRef = omitted.mechanisms[0].artifactRef;
  omitted.mechanisms[0].refetchOnlyAfterAlarm = false;
  omitted.alarm.refiredAfterRelaunch = false;
  const parsed = parseProbeRecord(omitted);
  assert.equal(parsed.mechanisms[0].terminatedMidFetch, true);
  assert.equal(parsed.mechanisms[0].pendingTransactionAtomic, true);
  assert.equal(parsed.mechanisms[0].indexedDbSurvived, true);
  assert.equal(selectMechanism(parsed), undefined);
});

function syntheticStartupHarness(startedAt: string, listed: boolean) {
  const url = "chrome-extension://SYNTHETIC/worker.js";
  const previousWorker = { url: () => url } as Worker;
  let ready!: () => void;
  let evaluating!: () => void;
  const evaluationStarted = new Promise<void>((resolve) => {
    evaluating = resolve;
  });
  const probe = {
    startedAt,
    startupReady: new Promise<void>((resolve) => {
      ready = resolve;
    }),
    ensures: [
      {
        entrypoint: "top-level",
        startedAt,
        settledAt: "2026-10-04T13:11:54.031Z",
        coalesced: false,
        getResult: null,
        created: true,
        createStartedAt: startedAt,
        alarm: { name: "probe-work", scheduledTime: 1791119544030.5, periodInMinutes: 0.5 },
      },
    ],
  };
  const calls: string[] = [];
  const worker = {
    url: () => url,
    async evaluate(callback: () => unknown) {
      calls.push("evaluate");
      evaluating();
      return runInNewContext(`(${callback.toString()})()`, { restartProbe: probe, Date });
    },
  } as Worker;
  const context = {
    serviceWorkers: () => (listed ? [worker] : []),
    async waitForEvent(event: string, options: { predicate: (worker: Worker) => boolean; timeout: number }) {
      calls.push(event);
      assert.equal(event, "serviceworker");
      assert.equal(options.timeout, 10_000);
      assert(options.predicate(worker));
      return worker;
    },
  } as BrowserContext;
  return { context, previousWorker, worker, probe, ready, evaluationStarted, calls };
}

for (const listed of [false, true]) {
  test(`synthetic startup observation accepts ${listed ? "script before passive discovery" : "passive discovery before script"} only after readiness`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T13:11:54.027Z"));
      const startedAt = listed ? "2026-10-04T13:11:54.025Z" : "2026-10-04T13:11:54.029Z";
      const harness = syntheticStartupHarness(startedAt, listed);
      let returned = false;
      const observation = settledStartup(harness.context, harness.previousWorker, "2026-10-04T13:11:54.000Z").then(
        (value) => {
          returned = true;
          return value;
        },
      );
      await harness.evaluationStarted;
      assert.equal(returned, false);
      vi.setSystemTime(new Date("2026-10-04T13:11:54.032Z"));
      harness.ready();
      const result = await observation;
      assert.equal(result.attachedAt, "2026-10-04T13:11:54.027Z");
      assert.equal(result.startedAt, startedAt);
      assert.equal(result.settledAt, "2026-10-04T13:11:54.032Z");
      assert.deepEqual(result.ensures, harness.probe.ensures);
      assert.deepEqual(harness.calls, listed ? ["evaluate"] : ["serviceworker", "evaluate"]);
    } finally {
      vi.useRealTimers();
    }
  });
}

const startupMutants: [string, (harness: ReturnType<typeof syntheticStartupHarness>) => void, RegExp][] = [
  [
    "original worker",
    (h) => {
      h.previousWorker = h.worker;
    },
    /replacement worker/,
  ],
  [
    "different fixture",
    (h) => {
      h.previousWorker = { url: () => "chrome-extension://OTHER/worker.js" } as Worker;
    },
    /same fixture/,
  ],
  [
    "pre-intervention startup",
    (h) => {
      h.probe.startedAt = "2026-10-04T13:11:53.999Z";
    },
    /after intervention/,
  ],
  [
    "startup after readiness",
    (h) => {
      h.probe.startedAt = "2026-10-04T13:11:54.033Z";
    },
    /before readiness/,
  ],
  [
    "coalesced initial ensure",
    (h) => {
      h.probe.ensures[0].coalesced = true;
      h.probe.ensures[0].startedAt = "2026-10-04T13:11:53.999Z";
    },
    /this startup/,
  ],
  [
    "ensure settled before start",
    (h) => {
      h.probe.ensures[0].settledAt = "2026-10-04T13:11:54.028Z";
    },
    /after it starts/,
  ],
  [
    "ensure still pending at readiness",
    (h) => {
      h.probe.ensures[0].settledAt = "2026-10-04T13:11:54.033Z";
    },
    /before readiness/,
  ],
];

for (const [name, mutate, message] of startupMutants) {
  test(`synthetic startup observation rejects ${name}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T13:11:54.032Z"));
      const harness = syntheticStartupHarness("2026-10-04T13:11:54.029Z", true);
      mutate(harness);
      harness.ready();
      await assert.rejects(
        settledStartup(harness.context, harness.previousWorker, "2026-10-04T13:11:54.000Z"),
        message,
      );
    } finally {
      vi.useRealTimers();
    }
  });
}

function workerHarness(omitAlarmReensure = false, prepared = true) {
  let alarm: chrome.alarms.Alarm | undefined;
  let creates = 0;
  let reads = 0;
  const local: Record<string, unknown> = prepared ? { localCanary: "SYNTHETIC_LOCAL_CANARY", fires: ["retained"] } : {};
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const event = (name: string) => ({
    addListener: (listener: (...args: unknown[]) => void) => {
      listeners[name] = listener;
    },
  });
  const scope = {
    options: { ...candidateOptions, omitAlarmReensure },
    createTransport: () => () => {
      throw new Error("Unexpected work in ensure-only control");
    },
    chrome: {
      runtime: { getManifest: () => ({}), onStartup: event("startup"), onInstalled: event("installed") },
      alarms: {
        onAlarm: event("alarm"),
        async get() {
          reads++;
          return alarm;
        },
        async create() {
          creates++;
          alarm = { name: "probe-work", periodInMinutes: 0.5, scheduledTime: Date.now() + 30_000 };
        },
      },
      storage: {
        local: {
          async get() {
            return local;
          },
          async set(value: object) {
            Object.assign(local, value);
          },
        },
        session: { async set() {} },
      },
    },
    indexedDB: {
      open() {
        const request = { result: {}, onsuccess: () => {} };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
  };
  const source = readFileSync(new URL("../fixtures/restart-probe/worker.js", import.meta.url), "utf8").replace(
    /^import .*;\r?\n/gm,
    "",
  );
  const probe = runInNewContext(`${source}\nrestartProbe;`, scope) as {
    startupReady: Promise<unknown>;
    ensures: AlarmEnsure[];
    ensureAlarm(entrypoint: string): Promise<AlarmEnsure>;
    prepare(): Promise<unknown>;
  };
  return {
    probe,
    listeners,
    local,
    counts: () => ({ creates, reads }),
    alarm: () => alarm,
    remove: () => {
      alarm = undefined;
    },
  };
}

test("actual fixture registers listeners synchronously and coalesces all startup paths without changing schedules or retained state", async () => {
  const harness = workerHarness();
  assert.deepEqual(Object.keys(harness.listeners).sort(), ["alarm", "installed", "startup"]);
  harness.listeners.startup();
  harness.listeners.installed({ reason: "install" });
  await harness.probe.startupReady;
  assert.deepEqual(harness.counts(), { creates: 1, reads: 2 });
  assert.equal(harness.probe.ensures.length, 3);
  assert.equal(harness.probe.ensures.filter((entry) => entry.coalesced).length, 2);
  const schedule = harness.alarm()!.scheduledTime;
  const present = await Promise.all([harness.probe.ensureAlarm("repeat-1"), harness.probe.ensureAlarm("repeat-2")]);
  await harness.probe.ensureAlarm("repeat-3");
  assert.equal(harness.counts().creates, 1);
  for (const invocation of present) {
    assert.equal(invocation.created, false);
    assert.equal(invocation.getResult!.scheduledTime, schedule);
    assert.equal(invocation.alarm.scheduledTime, schedule);
  }
  harness.remove();
  await Promise.all([harness.probe.ensureAlarm("missing-1"), harness.probe.ensureAlarm("missing-2")]);
  assert.equal(harness.counts().creates, 2);
  assert.deepEqual(harness.local.fires, ["retained"]);
});

test("actual fixture initial startup waits for prepare; omission disables only startup paths and prepare still creates", async () => {
  for (const omitted of [false, true]) {
    const harness = workerHarness(omitted, false);
    harness.listeners.startup();
    harness.listeners.installed({ reason: "install" });
    await Promise.resolve();
    assert.equal(harness.counts().creates, 0);
    await harness.probe.prepare();
    assert.equal(harness.counts().creates, 1);
    assert.equal(harness.local.localCanary, "SYNTHETIC_LOCAL_CANARY");
    assert.equal(JSON.stringify(harness.local.fires), "[]");
    if (omitted) assert.equal(harness.probe.ensures.map((entry) => entry.entrypoint).join(), "prepare");
  }
});
