import {
  economicsFactNames,
  parseFactValue,
  requireCurrency,
  requireRfc3339Instant,
  type EconomicsFactName,
  type EconomicsFacts,
} from "./contracts";

export type EconomicsOverrideKey = Readonly<{
  accountId: string;
  connectionId: string;
  currency: string;
}>;

export type EconomicsOverrideEntry =
  | Readonly<{
      kind: "active";
      factName: EconomicsFactName;
      value: unknown;
      revision: number;
      setAt: string;
      clearedAt: null;
    }>
  | Readonly<{
      kind: "cleared";
      factName: EconomicsFactName;
      value: null;
      revision: number;
      setAt: null;
      clearedAt: string;
    }>;

export type EconomicsOverridesState = Readonly<{
  key: EconomicsOverrideKey;
  version: number;
  entries: Readonly<Partial<Record<EconomicsFactName, EconomicsOverrideEntry>>>;
}>;

export type SetEconomicsFactOverride = Readonly<{
  type: "SetEconomicsFactOverride";
  expectedVersion: number;
  factName: EconomicsFactName;
  value: unknown;
  setAt: string;
}>;

export type ClearEconomicsFactOverride = Readonly<{
  type: "ClearEconomicsFactOverride";
  expectedVersion: number;
  factName: EconomicsFactName;
  clearedAt: string;
}>;

export type ClearAllEconomicsFactOverrides = Readonly<{
  type: "ClearAllEconomicsFactOverrides";
  expectedVersion: number;
  clearedAt: string;
}>;

export type EconomicsOverrideCommand =
  | SetEconomicsFactOverride
  | ClearEconomicsFactOverride
  | ClearAllEconomicsFactOverrides;

export type EconomicsOverrideEvent = Readonly<{
  type: "pricing.economics-fact-override-set" | "pricing.economics-fact-override-cleared";
  streamVersion: number;
  data: Readonly<{
    accountId: string;
    connectionId: string;
    currency: string;
    factName: EconomicsFactName;
    value: unknown | null;
    occurredAt: string;
  }>;
}>;

export class EconomicsOverrideConflictError extends Error {
  public constructor(expected: number, actual: number) {
    super(`Economics override version conflict: expected ${expected}, actual ${actual}.`);
    this.name = "EconomicsOverrideConflictError";
  }
}

export function initialEconomicsOverridesState(key: EconomicsOverrideKey): EconomicsOverridesState {
  if (
    key.accountId.length === 0 ||
    key.accountId.trim() !== key.accountId ||
    key.connectionId.length === 0 ||
    key.connectionId.trim() !== key.connectionId
  ) {
    throw new Error("Economics override identity must be non-empty and already trimmed.");
  }
  return {
    key: { ...key, currency: requireCurrency(key.currency, "currency") },
    version: 0,
    entries: {},
  };
}

export function decideEconomicsOverride(
  state: EconomicsOverridesState,
  command: EconomicsOverrideCommand,
): readonly EconomicsOverrideEvent[] {
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new Error("expectedVersion must be a non-negative safe integer.");
  }
  if (command.expectedVersion !== state.version) {
    throw new EconomicsOverrideConflictError(command.expectedVersion, state.version);
  }
  assertClosedCommand(command);
  switch (command.type) {
    case "SetEconomicsFactOverride": {
      assertFactName(command.factName);
      const value = parseFactValue(command.factName, command.value, state.key.currency);
      return [event(state, command.factName, value, command.setAt, state.version + 1, "set")];
    }
    case "ClearEconomicsFactOverride":
      assertFactName(command.factName);
      return [event(state, command.factName, null, command.clearedAt, state.version + 1, "cleared")];
    case "ClearAllEconomicsFactOverrides":
      return economicsFactNames.map((factName, index) =>
        event(state, factName, null, command.clearedAt, state.version + index + 1, "cleared"),
      );
    default:
      throw new Error("Unknown Economics override command.");
  }
}

export function evolveEconomicsOverrides(
  state: EconomicsOverridesState,
  eventToApply: EconomicsOverrideEvent,
): EconomicsOverridesState {
  if (eventToApply.streamVersion <= state.version) return state;
  if (eventToApply.streamVersion !== state.version + 1) {
    throw new Error(`Economics override event stream has a gap at ${eventToApply.streamVersion}.`);
  }
  const data = eventToApply.data;
  assertClosedEvent(eventToApply);
  if (
    data.accountId !== state.key.accountId ||
    data.connectionId !== state.key.connectionId ||
    data.currency !== state.key.currency
  ) {
    throw new Error("Economics override event belongs to another aggregate.");
  }
  assertFactName(data.factName);
  const occurredAt = requireRfc3339Instant(data.occurredAt, "occurredAt");
  const isSet = eventToApply.type === "pricing.economics-fact-override-set";
  const value = isSet ? parseFactValue(data.factName, data.value, state.key.currency) : null;
  const entry: EconomicsOverrideEntry = isSet
    ? {
        kind: "active",
        factName: data.factName,
        value,
        revision: eventToApply.streamVersion,
        setAt: occurredAt,
        clearedAt: null,
      }
    : {
        kind: "cleared",
        factName: data.factName,
        value: null,
        revision: eventToApply.streamVersion,
        setAt: null,
        clearedAt: occurredAt,
      };
  return {
    ...state,
    version: eventToApply.streamVersion,
    entries: {
      ...state.entries,
      [data.factName]: entry,
    },
  };
}

export function applyEconomicsOverrides(facts: EconomicsFacts, state: EconomicsOverridesState): EconomicsFacts {
  const result: Record<string, unknown> = {};
  for (const factName of economicsFactNames) {
    const sourceFact = facts[factName];
    const entry = state.entries[factName];
    if (!entry || entry.kind === "cleared") {
      result[factName] = sourceFact;
      continue;
    }
    const value = parseFactValue(factName, entry.value, state.key.currency);
    result[factName] = {
      ...sourceFact,
      effectiveValue: value,
      override: { value, revision: entry.revision, setAt: entry.setAt },
    };
  }
  return result as EconomicsFacts;
}

export function economicsOverrideRevisionMaterial(state: EconomicsOverridesState): unknown {
  return {
    version: state.version,
    facts: economicsFactNames.map((factName) => {
      const entry = state.entries[factName];
      return entry
        ? {
            factName,
            kind: entry.kind,
            revision: entry.revision,
            value: entry.value,
            setAt: entry.setAt,
            clearedAt: entry.clearedAt,
          }
        : { factName, kind: "absent", revision: 0, value: null, setAt: null, clearedAt: null };
    }),
  };
}

function event(
  state: EconomicsOverridesState,
  factName: EconomicsFactName,
  value: unknown | null,
  occurredAt: string,
  streamVersion: number,
  kind: "set" | "cleared",
): EconomicsOverrideEvent {
  requireRfc3339Instant(occurredAt, "occurredAt");
  return {
    type: kind === "set" ? "pricing.economics-fact-override-set" : "pricing.economics-fact-override-cleared",
    streamVersion,
    data: { ...state.key, factName, value, occurredAt },
  };
}

function assertFactName(value: string): asserts value is EconomicsFactName {
  if (!(economicsFactNames as readonly string[]).includes(value)) throw new Error(`Unknown Economics fact ${value}.`);
}

function assertClosedCommand(command: EconomicsOverrideCommand): void {
  const expected =
    command.type === "SetEconomicsFactOverride"
      ? ["expectedVersion", "factName", "setAt", "type", "value"]
      : command.type === "ClearEconomicsFactOverride"
        ? ["clearedAt", "expectedVersion", "factName", "type"]
        : command.type === "ClearAllEconomicsFactOverrides"
          ? ["clearedAt", "expectedVersion", "type"]
          : null;
  if (expected === null) throw new Error("Unknown Economics override command.");
  assertExactKeys(command as unknown as Record<string, unknown>, expected, "Economics override command");
}

function assertClosedEvent(eventToApply: EconomicsOverrideEvent): void {
  if (
    eventToApply.type !== "pricing.economics-fact-override-set" &&
    eventToApply.type !== "pricing.economics-fact-override-cleared"
  ) {
    throw new Error("Unknown Economics override event.");
  }
  assertExactKeys(
    eventToApply as unknown as Record<string, unknown>,
    ["data", "streamVersion", "type"],
    "Economics override event",
  );
  assertExactKeys(
    eventToApply.data as unknown as Record<string, unknown>,
    ["accountId", "connectionId", "currency", "factName", "occurredAt", "value"],
    "Economics override event data",
  );
  if (eventToApply.type === "pricing.economics-fact-override-cleared" && eventToApply.data.value !== null) {
    throw new Error("A cleared Economics override event must carry a null value.");
  }
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${name} must contain exactly: ${sortedExpected.join(", ")}.`);
  }
}
