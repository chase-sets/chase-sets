import { describe, expect, it } from "vitest";

/** One contract property every registered entry must satisfy; a check fails by throwing. */
export type ConformanceProperty<Entry> = Readonly<{
  name: string;
  check: (entry: Entry) => void | Promise<void>;
}>;

export type ConformanceSuite<Entry, Registration = Entry> = Readonly<{
  /** The factory the entries are registered through; the structure guard resolves this argument. */
  registry: (...args: never[]) => unknown;
  /** The production registrations, read from the composition that registers them, never a hand-written list. */
  entries: () => readonly Entry[] | Promise<readonly Entry[]>;
  key: (entry: Entry) => string;
  properties: readonly ConformanceProperty<Entry>[];
  /** The key of the entry that exercises one recorded registration; defaults to `key`. */
  registrationKey?: (registration: Registration) => string;
  /** Keys of exercised entries that no registration supplies, such as a provider wired beside the registry. */
  unregisteredKeys?: readonly string[];
}>;

export type ConformanceFailure = Readonly<{ entry: string | null; property: string; message: string }>;

type Recording = { constructions: number; registrations: unknown[] };
const recordings = new WeakMap<object, Recording>();
const registerMember = /^register[A-Z0-9_]/;

/**
 * Returns `module` with its registry factory `name` replaced by one that records
 * every construction and every entry registered through it: the factory's
 * initial entries and each `register<Name>` member call. Return it from
 * `vi.mock` of the factory's module, so production compositions register
 * through the recording factory.
 */
export function recordRegistrations<Module extends object, Name extends keyof Module>(
  module: Module,
  name: Name,
): Module {
  const factory = module[name] as (...args: unknown[]) => Record<string, unknown>;
  const recording: Recording = { constructions: 0, registrations: [] };
  const recordingFactory = (...args: unknown[]) => {
    const registry = factory(...args);
    recording.constructions += 1;
    if (Array.isArray(args[0])) recording.registrations.push(...args[0]);
    return Object.fromEntries(
      Object.entries(registry).map(([member, value]) => [
        member,
        registerMember.test(member) && typeof value === "function"
          ? (entry: unknown, ...rest: unknown[]) => {
              const result = value.call(registry, entry, ...rest);
              recording.registrations.push(entry);
              return result;
            }
          : value,
      ]),
    );
  };
  Object.defineProperty(recordingFactory, "name", { value: factory.name });
  recordings.set(recordingFactory, recording);
  return { ...module, [name]: recordingFactory };
}

/** Every registration a recorded factory has received so far. */
export function recordedRegistrations<Registration>(
  registry: ConformanceSuite<unknown>["registry"],
): readonly Registration[] {
  const recording = recordings.get(registry);
  if (!recording) throw new Error(`${registry.name} is not recorded; vi.mock its module through recordRegistrations.`);
  return recording.registrations as Registration[];
}

/**
 * Runs every property over every entry and returns the failures. An empty
 * registry or a repeated entry key fails, so a suite never passes vacuously.
 */
export async function runConformance<Entry, Registration = Entry>(
  suite: ConformanceSuite<Entry, Registration>,
  properties: readonly ConformanceProperty<Entry>[] = suite.properties,
): Promise<readonly ConformanceFailure[]> {
  const entries = await suite.entries();
  if (entries.length === 0)
    return [
      { entry: null, property: "registered-entries", message: "No registered entries; an empty run proves nothing." },
    ];
  const keys = entries.map(suite.key);
  const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (repeated.length > 0)
    return [{ entry: null, property: "registered-entries", message: `Repeated entry keys: ${repeated.join(", ")}.` }];
  const failures: ConformanceFailure[] = [];
  for (const property of properties) {
    for (const [index, entry] of entries.entries()) {
      try {
        await property.check(entry);
      } catch (error) {
        failures.push({
          entry: keys[index]!,
          property: property.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return failures;
}

/**
 * Fails unless the exercised entries are exactly the recorded production
 * registrations plus the suite's declared `unregisteredKeys`, so a registration
 * a hand-written entry list omits fails by its key.
 */
export async function registrationCoverage<Entry, Registration = Entry>(
  suite: ConformanceSuite<Entry, Registration>,
): Promise<readonly ConformanceFailure[]> {
  const property = "production-registrations";
  const recording = recordings.get(suite.registry);
  if (!recording)
    return [
      {
        entry: null,
        property,
        message: `${suite.registry.name} is not recorded; vi.mock its module through recordRegistrations so the run reads every production registration.`,
      },
    ];
  const exercised = new Set((await suite.entries()).map(suite.key));
  if (recording.constructions === 0)
    return [
      {
        entry: null,
        property,
        message: `No production composition constructed ${suite.registry.name}; load the composition that registers its entries.`,
      },
    ];
  const registrationKey = suite.registrationKey ?? (suite.key as unknown as (registration: Registration) => string);
  const registered = new Set((recording.registrations as Registration[]).map(registrationKey));
  const unregistered = new Set(suite.unregisteredKeys ?? []);
  const failure = (entry: string, message: string): ConformanceFailure => ({ entry, property, message });
  return [
    ...[...registered]
      .filter((key) => !exercised.has(key))
      .map((key) => failure(key, "Registered in production but not exercised by this run.")),
    ...[...exercised]
      .filter((key) => !registered.has(key) && !unregistered.has(key))
      .map((key) => failure(key, "Exercised but neither registered in production nor declared in unregisteredKeys.")),
    ...[...unregistered]
      .filter((key) => registered.has(key))
      .map((key) => failure(key, "Declared in unregisteredKeys but registered in production.")),
  ];
}

/** One test per property, each run over every registered entry. */
export function describeConformance<Entry, Registration = Entry>(suite: ConformanceSuite<Entry, Registration>): void {
  describe(`${suite.registry.name} conformance`, () => {
    it("registers at least one entry under unique keys", async () => {
      expect(await runConformance(suite, [])).toEqual([]);
    });
    it("exercises exactly the entries production registers", async () => {
      expect(await registrationCoverage(suite)).toEqual([]);
    });
    it.each(suite.properties.map((property) => [property.name, property] as const))(
      "%s, for every registered entry",
      async (_, property) => {
        expect(await runConformance(suite, [property])).toEqual([]);
      },
    );
  });
}

/** Freezes a captured input so a check observes any mutation as a thrown TypeError. */
export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
