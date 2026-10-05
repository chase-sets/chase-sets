import assert from "node:assert/strict";
import { register } from "node:module";

register("./loader-hook.mjs", import.meta.url);
const moduleUrl = process.argv[2] ?? new URL("../../module-resolution.mjs", import.meta.url).href;
const environment = process.env;
const reads = [];
let phase = "import";
process.env = new Proxy(environment, {
  get(target, key) {
    reads.push({ key: String(key), phase, stack: new Error().stack });
    return Reflect.get(target, key);
  },
});

function assertFrozen(value) {
  if (value && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    for (const member of Object.values(value)) assertFrozen(member);
  }
}

function denied(channel) {
  return () => {
    throw new Error(`DENIED:${channel}`);
  };
}

const caught = {};
function catchProbe(label, probe, channel = label) {
  assert.throws(probe, { message: `DENIED:${channel}` });
  caught[label] = true;
}

try {
  const m = await import(moduleUrl);
  const { probes } = await import("./ambient-probe.mjs");
  const attributed = (file, stage) => reads.filter((read) => read.phase === stage && read.stack.includes(file));
  assert.equal(attributed(moduleUrl, "import").length, 0);
  catchProbe("filesystem", probes.filesystem);
  catchProbe("loadModuleResolutionContext", () => m.loadModuleResolutionContext("synthetic-root"), "filesystem");
  phase = "probe";
  probes.environment();
  assert.equal(attributed("ambient-probe.mjs", "probe").length, 1);
  caught.environment = true;

  const stubDate = function () {
    throw new Error("DENIED:clock");
  };
  stubDate.now = denied("clock");
  const stubs = [
    [globalThis, "Date", stubDate],
    [Math, "random", denied("randomness")],
    [globalThis, "performance", new Proxy({}, { get: denied("performance") })],
    [globalThis, "Intl", new Proxy({}, { get: denied("locale") })],
    [process, "cwd", denied("cwd")],
  ];
  const originals = stubs.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
  const input = { importerPath: "bounded-contexts/example/source.ts", specifierText: "./inferred" };
  const inputBefore = structuredClone(input);
  const globalsBefore = Object.getOwnPropertyNames(globalThis);
  let result;
  try {
    for (const [object, key, value] of stubs) Object.defineProperty(object, key, { configurable: true, value });
    for (const label of ["dateNow", "dateConstruction", "dateApplication"]) catchProbe(label, probes[label], "clock");
    for (const label of ["randomness", "performance", "locale", "cwd"]) catchProbe(label, probes[label]);
    phase = "call";
    result = m.enumerateGuardImportCandidates(input);
    assert.deepEqual(result, {
      specifierForm: "dot-prefixed-relative",
      candidates: ["", ".ts", ".tsx", ".mjs", "/index.ts"].map((suffix) => ({
        path: `bounded-contexts/example/inferred${suffix}`,
        rule: "dot-prefixed-relative-target",
        suffix,
        speculativeRoot: null,
        mappedSubpath: null,
      })),
    });
    const firstBefore = structuredClone(result);
    const second = m.enumerateGuardImportCandidates({ ...input, specifierText: "@chase-sets/example/other" });
    assert.deepEqual(result, firstBefore);
    assert.notEqual(result, second);
    assert.notEqual(result.candidates, second.candidates);
    assert.ok(result.candidates.every((candidate) => !second.candidates.includes(candidate)));
    assert.deepEqual(input, inputBefore);
    assert.deepEqual(Object.getOwnPropertyNames(globalThis), globalsBefore);
    for (const value of [
      result,
      second,
      ...Object.entries(m)
        .filter(([key]) => key.startsWith("GUARD_IMPORT_"))
        .map(([, value]) => value),
    ]) {
      assertFrozen(value);
    }
    assert.equal(attributed(moduleUrl, "call").length, 0);
  } finally {
    for (const [index, [object, key]] of stubs.entries()) Object.defineProperty(object, key, originals[index]);
  }
  for (const [index, [object, key]] of stubs.entries()) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), originals[index]);
  }
  console.log(
    JSON.stringify({
      pinnedRecord: result,
      environmentReads: {
        import: attributed(moduleUrl, "import").length,
        call: attributed(moduleUrl, "call").length,
        synthetic: attributed("ambient-probe.mjs", "probe").length,
      },
      stubsRestored: true,
      globalNamesUnchanged: true,
      inputUnchanged: true,
      firstRecordUnchanged: true,
      noAliasing: true,
      deeplyFrozen: true,
      caught,
    }),
  );
} finally {
  process.env = environment;
}
