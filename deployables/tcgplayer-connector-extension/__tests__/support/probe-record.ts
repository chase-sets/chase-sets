export const mechanismNames = [
  "context.close",
  "ServiceWorker.stopWorker",
  "ServiceWorker.stopAllWorkers",
  "runtime.reload",
] as const;
export type MechanismName = (typeof mechanismNames)[number];
export type Mechanism = {
  name: MechanismName;
  available: boolean;
  terminatedMidFetch: boolean;
  pendingTransactionAtomic: boolean;
  refetchOnlyAfterAlarm: boolean;
  indexedDbSurvived: boolean;
};
export type ProbeRecord = {
  schemaVersion: 1;
  chromiumVersion: string;
  playwrightVersion: string;
  capturedAt: string;
  mechanisms: Mechanism[];
  alarm: { requestedPeriodSeconds: 30; observedFirstFireMs: number; refiredAfterRelaunch: boolean };
  storage: { localSurvived: boolean; sessionSurvived: boolean };
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
  if (record.schemaVersion !== 1) throw new Error("Expected schemaVersion 1");
  if (
    typeof record.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.capturedAt) ||
    !Number.isFinite(Date.parse(record.capturedAt)) ||
    new Date(record.capturedAt).toISOString() !== record.capturedAt
  ) {
    throw new Error("Expected a valid millisecond UTC instant");
  }
  if (!Array.isArray(record.mechanisms) || record.mechanisms.length !== mechanismNames.length)
    throw new Error("Expected all four mechanisms");
  const mechanisms = record.mechanisms.map((value, index): Mechanism => {
    const row = object(value, [
      "name",
      "available",
      "terminatedMidFetch",
      "pendingTransactionAtomic",
      "refetchOnlyAfterAlarm",
      "indexedDbSurvived",
    ]);
    const name = mechanismNames[index]!;
    if (row.name !== name) throw new Error("Expected each named mechanism exactly once in canonical order");
    const result = {
      name,
      available: boolean(row.available),
      terminatedMidFetch: boolean(row.terminatedMidFetch),
      pendingTransactionAtomic: boolean(row.pendingTransactionAtomic),
      refetchOnlyAfterAlarm: boolean(row.refetchOnlyAfterAlarm),
      indexedDbSurvived: boolean(row.indexedDbSurvived),
    };
    if (!result.available && Object.entries(result).some(([key, value]) => key !== "name" && value === true)) {
      throw new Error("Unavailable mechanism cannot claim observed success");
    }
    return result;
  });
  const alarm = object(record.alarm, ["requestedPeriodSeconds", "observedFirstFireMs", "refiredAfterRelaunch"]);
  if (
    alarm.requestedPeriodSeconds !== 30 ||
    typeof alarm.observedFirstFireMs !== "number" ||
    !Number.isSafeInteger(alarm.observedFirstFireMs) ||
    alarm.observedFirstFireMs < 0 ||
    alarm.observedFirstFireMs > 60_000
  ) {
    throw new Error("Alarm latency outside the finite 60 second observation envelope");
  }
  const storage = object(record.storage, ["localSurvived", "sessionSurvived"]);
  return {
    schemaVersion: 1,
    chromiumVersion: version(record.chromiumVersion, 4),
    playwrightVersion: version(record.playwrightVersion, 3),
    capturedAt: record.capturedAt,
    mechanisms,
    alarm: {
      requestedPeriodSeconds: 30,
      observedFirstFireMs: alarm.observedFirstFireMs,
      refiredAfterRelaunch: boolean(alarm.refiredAfterRelaunch),
    },
    storage: { localSurvived: boolean(storage.localSurvived), sessionSurvived: boolean(storage.sessionSurvived) },
  };
}
