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

export type EconomicsOverrideEntry = Readonly<{
  factName: EconomicsFactName;
  value: unknown | null;
  revision: number;
  setAt: string | null;
  clearedAt: string | null;
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
  if (key.accountId.length === 0 || key.connectionId.length === 0) throw new Error("Economics override identity is required.");
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
  return {
    ...state,
    version: eventToApply.streamVersion,
    entries: {
      ...state.entries,
      [data.factName]: {
        factName: data.factName,
        value,
        revision: eventToApply.streamVersion,
        setAt: isSet ? occurredAt : null,
        clearedAt: isSet ? null : occurredAt,
      },
    },
  };
}

export function applyEconomicsOverrides(
  facts: EconomicsFacts,
  state: EconomicsOverridesState,
): EconomicsFacts {
  const result: Record<string, unknown> = {};
  for (const factName of economicsFactNames) {
    const sourceFact = facts[factName];
    const entry = state.entries[factName];
    if (!entry || entry.value === null || entry.setAt === null) {
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
            revision: entry.revision,
            value: entry.value,
            setAt: entry.setAt,
            clearedAt: entry.clearedAt,
          }
        : { factName, revision: 0, value: null, setAt: null, clearedAt: null };
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
