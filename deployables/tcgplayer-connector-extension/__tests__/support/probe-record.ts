export const mechanismNames = [
  "context.close",
  "ServiceWorker.stopWorker",
  "ServiceWorker.stopAllWorkers",
  "runtime.reload",
] as const;
export type MechanismName = (typeof mechanismNames)[number];
export const mechanismRoutes: Record<MechanismName, string> = {
  "context.close": "context.close(); chromium.launchPersistentContext(same userDataDir)",
  "ServiceWorker.stopWorker": 'context.newCDPSession(worker); session.send("ServiceWorker.stopWorker", { versionId })',
  "ServiceWorker.stopAllWorkers": 'context.newCDPSession(worker); session.send("ServiceWorker.stopAllWorkers")',
  "runtime.reload": "worker.evaluate(() => chrome.runtime.reload())",
};
export const mechanismFacts = [
  "terminatedMidFetch",
  "pendingTransactionAtomic",
  "refetchOnlyAfterAlarm",
  "indexedDbSurvived",
] as const;
export const reasonCodes = [
  "route-unavailable",
  "extension-disabled-after-intervention",
  "worker-not-replaced",
  "window-shorter-than-period",
] as const;
export type ObservationReason = { code: (typeof reasonCodes)[number]; message: string };
type Facts<K extends string, T = boolean> = Record<K, T | null> & Partial<Record<`${K}Reason`, ObservationReason>>;
export type Mechanism = Facts<(typeof mechanismFacts)[number]> & {
  name: MechanismName;
  available: boolean;
  unavailableReason?: string;
  route: string;
  intervenedAt: string;
  artifactRef: string;
};
type Source = { artifactRef: string; mechanism: MechanismName };
export type ProbeRecord = {
  schemaVersion: 2;
  chromiumVersion: string;
  playwrightVersion: string;
  capturedAt: string;
  mechanisms: Mechanism[];
  alarm: Source & { requestedPeriodSeconds: 30 } & Facts<"observedFirstFireMs", number> & Facts<"refiredAfterRelaunch">;
  storage: Source & Facts<"localSurvived" | "sessionSurvived">;
};

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    throw new Error(`Expected exactly ${keys.join(",")}`);
  return value as Record<string, unknown>;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Expected boolean observation");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024)
    throw new Error("Expected bounded nonblank text");
  return value;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("Expected a valid millisecond UTC instant");
  }
  return value;
}

function facts<K extends string, T>(
  value: unknown,
  base: string[],
  names: readonly K[],
  parse: (value: unknown) => T,
): Facts<K, T> {
  if (value === null || typeof value !== "object") throw new Error("Expected observations");
  const input = value as Record<string, unknown>;
  const row = object(input, [
    ...base,
    ...names,
    ...names.filter((name) => input[name] === null).map((name) => `${name}Reason`),
  ]);
  const result: Record<string, unknown> = {};
  for (const name of names) {
    result[name] = row[name] === null ? null : parse(row[name]);
    if (row[name] === null) {
      const reason = object(row[`${name}Reason`], ["code", "message"]);
      if (!reasonCodes.includes(reason.code as ObservationReason["code"]))
        throw new Error("Unknown observation reason");
      result[`${name}Reason`] = { code: reason.code, message: text(reason.message) };
    }
  }
  return result as Facts<K, T>;
}

function source(value: unknown, mechanisms: Mechanism[]): Source {
  const row = value as Record<string, unknown>;
  if (!mechanismNames.includes(row.mechanism as MechanismName)) throw new Error("Unknown source mechanism");
  const mechanism = mechanisms.find((entry) => entry.name === row.mechanism)!;
  if (text(row.artifactRef) !== mechanism.artifactRef) throw new Error("Source artifact must match mechanism artifact");
  for (const [key, value] of Object.entries(row)) {
    if (!mechanism.available && typeof value === "boolean") throw new Error(`Unavailable source cannot observe ${key}`);
  }
  return { mechanism: mechanism.name, artifactRef: mechanism.artifactRef };
}

function version(value: unknown, parts: number): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^\\d+(?:\\.\\d+){${parts - 1}}$`).test(value) ||
    value.split(".").some((part) => !Number.isSafeInteger(Number(part)) || Number(part) > 1_000_000)
  ) {
    throw new Error("Expected exact bounded release version");
  }
  return value;
}

export function parseProbeRecord(value: unknown): ProbeRecord {
  const record = object(value, [
    "schemaVersion",
    "chromiumVersion",
    "playwrightVersion",
    "capturedAt",
    "mechanisms",
    "alarm",
    "storage",
  ]);
  if (record.schemaVersion !== 2) throw new Error("Expected schemaVersion 2");
  if (!Array.isArray(record.mechanisms) || record.mechanisms.length !== mechanismNames.length)
    throw new Error("Expected all four mechanisms");
  const mechanisms = record.mechanisms.map((value, index): Mechanism => {
    const row = value as Record<string, unknown>;
    const observed = facts(
      value,
      [
        "name",
        "available",
        "route",
        "intervenedAt",
        "artifactRef",
        ...(row?.available === false ? ["unavailableReason"] : []),
      ],
      mechanismFacts,
      boolean,
    );
    const name = mechanismNames[index]!;
    if (row.name !== name) throw new Error("Expected each named mechanism exactly once in canonical order");
    const result: Mechanism = {
      name,
      available: boolean(row.available),
      route: text(row.route),
      intervenedAt: instant(row.intervenedAt),
      artifactRef: text(row.artifactRef),
      ...observed,
    };
    if (result.route !== mechanismRoutes[name]) throw new Error("Expected exact attempted route");
    if (!result.available) {
      result.unavailableReason = text(row.unavailableReason);
      if (mechanismFacts.some((fact) => result[fact] !== null))
        throw new Error("Unavailable mechanism facts must be null");
    }
    return result;
  });
  const alarm = record.alarm as Record<string, unknown>;
  const latency = facts(
    alarm,
    [
      "requestedPeriodSeconds",
      "artifactRef",
      "mechanism",
      "refiredAfterRelaunch",
      ...(alarm?.refiredAfterRelaunch === null ? ["refiredAfterRelaunchReason"] : []),
    ],
    ["observedFirstFireMs"],
    (value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 60_000)
        throw new Error("Alarm latency outside the finite 60 second observation envelope");
      return value;
    },
  );
  const refire = facts(
    alarm,
    [
      "requestedPeriodSeconds",
      "artifactRef",
      "mechanism",
      "observedFirstFireMs",
      ...(alarm.observedFirstFireMs === null ? ["observedFirstFireMsReason"] : []),
    ],
    ["refiredAfterRelaunch"],
    boolean,
  );
  if (alarm.requestedPeriodSeconds !== 30) throw new Error("Expected 30 second alarm period");
  const storage = facts(record.storage, ["artifactRef", "mechanism"], ["localSurvived", "sessionSurvived"], boolean);
  return {
    schemaVersion: 2,
    chromiumVersion: version(record.chromiumVersion, 4),
    playwrightVersion: version(record.playwrightVersion, 3),
    capturedAt: instant(record.capturedAt),
    mechanisms,
    alarm: {
      requestedPeriodSeconds: 30,
      ...source(alarm, mechanisms),
      ...latency,
      ...refire,
    },
    storage: { ...source(record.storage, mechanisms), ...storage },
  };
}

export function selectMechanism(record: ProbeRecord): Mechanism | undefined {
  return record.mechanisms.find(
    (row) =>
      row.available &&
      mechanismFacts.every((fact) => row[fact] === true) &&
      record.alarm.mechanism === row.name &&
      record.alarm.refiredAfterRelaunch === true &&
      record.storage.mechanism === row.name &&
      record.storage.localSurvived !== null &&
      record.storage.sessionSurvived !== null,
  );
}
