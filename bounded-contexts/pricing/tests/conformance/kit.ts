import { describe, expect, it } from "vitest";

/** One contract property every registered entry must satisfy; a check fails by throwing. */
export type ConformanceProperty<Entry> = Readonly<{
  name: string;
  check: (entry: Entry) => void | Promise<void>;
}>;

export type ConformanceSuite<Entry> = Readonly<{
  /** The factory the entries are registered through; the structure guard resolves this argument. */
  registry: (...args: never[]) => unknown;
  /** The production registrations, read from the composition that registers them, never a hand-written list. */
  entries: () => readonly Entry[] | Promise<readonly Entry[]>;
  key: (entry: Entry) => string;
  properties: readonly ConformanceProperty<Entry>[];
}>;

export type ConformanceFailure = Readonly<{ entry: string | null; property: string; message: string }>;

/**
 * Runs every property over every entry and returns the failures. An empty
 * registry or a repeated entry key fails, so a suite never passes vacuously.
 */
export async function runConformance<Entry>(
  suite: ConformanceSuite<Entry>,
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

/** One test per property, each run over every registered entry. */
export function describeConformance<Entry>(suite: ConformanceSuite<Entry>): void {
  describe(`${suite.registry.name} conformance`, () => {
    it("registers at least one entry under unique keys", async () => {
      expect(await runConformance(suite, [])).toEqual([]);
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
