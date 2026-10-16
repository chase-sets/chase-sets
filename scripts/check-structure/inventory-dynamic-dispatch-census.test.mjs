import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverInventoryCallers,
  partitionInventoryCallers,
  trackedInventorySources,
} from "../../bounded-contexts/inventory/tests/caller-partition.mjs";
import { repoRoot } from "../lib/repo.mjs";
import {
  createClassificationProgram,
  enumerateTrackedRoots,
  withTemporaryCorpus,
} from "./authoritative-stream-read-classification.mjs";
import { analyzeInventoryDynamicDispatch, resolveInventoryFamilies } from "./inventory-dynamic-dispatch-census.mjs";

const servicesFile = "bounded-contexts/inventory/support/runtime-support/services.ts";
const absoluteImport = (file) => JSON.stringify(path.join(repoRoot, file).replaceAll("\\", "/"));
const fixtureConfig = JSON.stringify({
  extends: path.join(repoRoot, "tsconfig.json"),
  compilerOptions: {
    allowImportingTsExtensions: true,
    typeRoots: [path.join(repoRoot, "node_modules/@types")],
  },
});
const prelude = `
import type { InventoryServices } from ${absoluteImport(servicesFile)};
import { createInventoryApiClient } from ${absoluteImport("bounded-contexts/inventory/client.ts")};
declare const services: InventoryServices;
type RestockService = InventoryServices["restockDecisions"];
type H = InventoryServices["holds"];
type Fn = (...args: never[]) => unknown;
declare const api: ReturnType<typeof createInventoryApiClient>;
declare const method: string, flag: boolean, context: never;
declare function consume(value: any): void;
declare function consumeUnknown(value: unknown): void;
`;
const familyExpressions = [
  ["InventoryServices", "services", "InventoryServices"],
  ["InventoryApiClient", "api", "ReturnType<typeof createInventoryApiClient>"],
  ...[
    "mutations",
    "checkoutReservationAuthority",
    "catalogItems",
    "storageLocations",
    "items",
    "importBatches",
    "holds",
    "holdCleanupAuthority",
    "holdCollisions",
    "channelSales",
    "channelStockAllocations",
    "reservations",
    "restockDecisions",
    "recoveredItems",
    "appendToStreams",
  ].map((name) => [name, `services.${name}`, `NonNullable<InventoryServices["${name}"]>`]),
];

function shapes(expression, type) {
  const receivers = expression.startsWith("services.")
    ? [expression, `services[${JSON.stringify(expression.slice("services.".length))}]`]
    : [expression, `(${expression})`];
  return receivers.flatMap((receiver) =>
    [receiver, `(${receiver})`, `${receiver}!`, `(${receiver} as ${type})`].flatMap((wrapped) => [
      `${wrapped}[method]({}, context);`,
      `const m = ${wrapped}[method]; m({}, context);`,
    ]),
  );
}

function p1(expression, type, property) {
  return [
    `(${expression} satisfies ${type})[method]({}, context);`,
    `(<${type}>${expression})[method]({}, context);`,
    `(void 0, ${expression})[method]({}, context);`,
    `(flag ? ${expression} : ${expression})[method]({}, context);`,
    `const svc = ${expression}; svc[method]({}, context);`,
    `const { ${property}: svc } = { ${property}: ${expression} }; svc![method]({}, context);`,
    `function route(svc: ${type}) { svc[method]({}, context); }`,
    `const key = ${JSON.stringify(property)}; ({ ${property}: ${expression} })[key]![method]({}, context);`,
    `Object.values(${expression})[0]({}, context);`,
    `Object.entries(${expression})[0][1]({}, context);`,
    `for (const m of Object.values(${expression})) m({}, context);`,
    `for (const key in ${expression}) ${expression}[key]({}, context);`,
    `(${expression} as any)[method]({}, context);`,
    `(${expression} as unknown);`,
    `const erased: any = ${expression}; erased[method]({}, context);`,
    `const erased: unknown = ${expression};`,
    `consume(${expression});`,
    `consumeUnknown(${expression});`,
    `function route<T extends ${type}>(svc: T) { svc[method]({}, context); }`,
    `function route(svc: Readonly<${type}>) { svc[method]({}, context); }`,
    `function route(svc: Pick<${type}, keyof ${type}>) { svc[method]({}, context); }`,
    `function route(svc: ${type} | undefined) { svc?.[method]({}, context); }`,
    `function route(svc: ${type} & { extra: string }) { svc[method]({}, context); }`,
  ];
}

function restockControls() {
  const cases = [
    "services.restockDecisions.recordDecision({}, context);",
    'services.restockDecisions["recordDecision"]({}, context);',
    'services["restockDecisions"].recordDecision({}, context);',
    "services.holds[method]({}, context);",
    "services.restockDecisions[method]({}, context);",
    "const mutate = services.restockDecisions[method]; mutate({}, context);",
    'services["restockDecisions"][method]({}, context);',
    'const mutate = services["restockDecisions"][method]; mutate({}, context);',
    "services['restockDecisions'][method]({}, context);",
    "const mutate = services['restockDecisions'][method]; mutate({}, context);",
  ];
  for (const member of ["services.restockDecisions", 'services["restockDecisions"]', "services['restockDecisions']"]) {
    for (const wrapped of [`(${member})`, `${member}!`, `(${member} as RestockService)`]) {
      cases.push(`${wrapped}[method]({}, context);`);
      cases.push(`const mutate = ${wrapped}[method]; mutate({}, context);`);
      cases.push(`${wrapped}["recordDecision"]({}, context);`);
    }
  }
  return cases;
}

const repairControls = [
  [
    "F1-K1",
    'export function route(svc: H) { return svc[method as "createHold"](context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  ["F1-K2", "export function route(svc: H) { const k = method as keyof H; return svc[k]; }", "FAMILY_DYNAMIC_KEY"],
  [
    "F1-K6",
    'export function route(c: ReturnType<typeof createInventoryApiClient>) { return c[method as "createHold"]; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-K3",
    "export function route(svc: H) { const { [method]: fn } = svc as H & Record<string, Fn>; return fn(); }",
    "FAMILY_DYNAMIC_KEY",
  ],
  ["F2-K3b", "export function route(svc: H) { const { [method]: fn } = svc; return fn; }", "FAMILY_DYNAMIC_KEY"],
  [
    "F2-K3c",
    "export function route(svc: H) { let fn: unknown; ({ [method]: fn } = svc); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-K4",
    'export function route(svc: H) { const { [method as "createHold"]: fn } = svc; return fn(context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F3-K5",
    "export function route(svc: H) { for (const k of Object.keys(svc) as (keyof H)[]) svc[k]; }",
    "FAMILY_ENUMERATION",
  ],
  [
    "F3-E4",
    "export function route(svc: H) { return Reflect.get(svc, method)(context, context); }",
    "FAMILY_ENUMERATION",
  ],
  [
    "F4-L1",
    "export function route(svc: H) { let erased: any; erased = svc; return erased[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L2",
    "function leak(svc: H): any { return svc; } export function route(svc: H) { return leak(svc)[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L3",
    "export function route(svc: H) { const bag: { s: any } = { s: svc }; return bag.s[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L4",
    "export function route(svc: H) { const bag: Record<string, unknown> = { s: svc }; return (bag.s as Record<string, Fn>)[method](); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L5",
    "export function route(svc: H) { const arr: any[] = [svc]; return arr[0][method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L6",
    "function call(...values: any[]) { return values[0][values[1]](); } export function route(svc: H) { return call(svc, method); }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["F4-L7", "export class Holder { held: unknown = services.holds; }", "FAMILY_TYPE_ERASURE"],
  [
    "F4-L8",
    "export class Holder { held: any; constructor(svc: H) { this.held = svc; } run() { return this.held[method](context, context); } }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-L9",
    "export function route(svc: H) { const { s = svc }: { s?: any } = {}; return s[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
].map(([id, source, reason]) => ({ id, source, reason }));

async function matrix(cases, run) {
  const fixtures = Object.fromEntries(
    cases.map(({ source }, index) => [
      `bounded-contexts/unexpected/features/arbitrary/api/case-${index}.ts`,
      `${prelude}\n${source}\n`,
    ]),
  );
  return withTemporaryCorpus({ "tsconfig.json": fixtureConfig, ...fixtures }, async (root) => {
    const roots = enumerateTrackedRoots(root);
    const program = createClassificationProgram(root, roots);
    const families = resolveInventoryFamilies(program, repoRoot);
    return run({ root, roots, program, families, fixtures });
  });
}

function emit(name, data) {
  for (const entry of Array.isArray(data) ? data : [data]) process.stdout.write(`${name} ${JSON.stringify(entry)}\n`);
}

// Prepare the tracked Program once, as in authoritative-stream-read-classification.test.mjs.
const roots = enumerateTrackedRoots(repoRoot);
const program = createClassificationProgram(repoRoot, roots);
const families = resolveInventoryFamilies(program, repoRoot);
const sources = trackedInventorySources(repoRoot);
const production = analyzeInventoryDynamicDispatch({ repoRoot, roots, program, families, sources });
const c1 = discoverInventoryCallers(sources);
const registry = JSON.parse(
  readFileSync(path.join(repoRoot, "bounded-contexts/inventory/tests/caller-partition.json"), "utf8"),
);
const partition = partitionInventoryCallers(c1, registry);
const built = analyzeInventoryDynamicDispatch({
  repoRoot,
  roots,
  program,
  families,
  sources: [...sources, { path: "bounded-contexts/unexpected/build/output.js", source: "svc[key]()" }],
});

describe("issue-7169-type-resolved-census-matrix", () => {
  it("rejects the compile-clean F1-F4 escape controls", async () => {
    await matrix(repairControls, ({ root, roots, program, families, fixtures }) => {
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      for (const [index, control] of repairControls.entries()) {
        const file = Object.keys(fixtures)[index];
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), control.id).toEqual([]);
        expect(program.getSemanticDiagnostics(source), control.id).toEqual([]);
        expect(
          result.diagnostics.some(
            ({ file: diagnosticFile, reason }) => diagnosticFile === file && reason === control.reason,
          ),
          control.id,
        ).toBe(true);
      }
      emit("repair-controls", { total: repairControls.length, rejected: result.diagnostics.length });
    });
  });

  it("rejects every derived family's M16 and P1 forms at arbitrary paths", async () => {
    const cases = familyExpressions.flatMap(([family, expression, type]) =>
      [...shapes(expression, type), ...p1(expression, type, "member")].map((source) => ({ family, source })),
    );
    await matrix(cases, ({ root, roots, program, families, fixtures }) => {
      expect(families.families.map(({ name }) => name).sort()).toEqual(familyExpressions.map(([name]) => name).sort());
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      const rejected = new Set(result.diagnostics.map(({ file }) => file));
      for (const file of Object.keys(fixtures)) expect(rejected.has(file), fixtures[file]).toBe(true);
      emit(
        "family-matrix",
        familyExpressions.map(([family]) => ({ family, m16: 16, p1: 23, rejected: 39 })),
      );
    });
  });

  it("rejects all 37 frozen restock inputs end to end, including 12 static C1 controls", async () => {
    const controls = restockControls();
    expect(controls).toHaveLength(37);
    await matrix(
      controls.map((source) => ({ source })),
      ({ root, roots, program, families, fixtures }) => {
        const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
        const rejected = new Set(result.diagnostics.map(({ file }) => file));
        let dynamic = 0;
        let staticCalls = 0;
        for (const [file, source] of Object.entries(fixtures)) {
          if (rejected.has(file)) dynamic++;
          else {
            const discovery = discoverInventoryCallers([{ path: file, source }]);
            expect(discovery.callers.length, source).toBeGreaterThan(0);
            expect(() => partitionInventoryCallers(discovery, {})).toThrow("Unclassified Inventory caller");
            staticCalls++;
          }
        }
        expect({ dynamic, staticCalls }).toEqual({ dynamic: 25, staticCalls: 12 });
        emit("restock-controls", { total: 37, dynamic, staticCalls });
      },
    );
  });

  it("allows named static access, aliases, parameters, spreads and non-family lookalikes", async () => {
    const cases = [
      "services.holds.createHold({}, context);",
      'services.holds["createHold"]({}, context);',
      'const key = flag ? "createHold" as const : "releaseHold" as const; services.holds[key]({}, context);',
      "const m = services.holds.createHold; m({}, context);",
      "const { createHold: m } = services.holds; m({}, context);",
      "const m = services.holds.createHold.bind(services.holds); m({}, context);",
      "services.holds.createHold.bind(services.holds)({}, context);",
      "services.holds.createHold.call(services.holds, {}, context);",
      "services.holds.createHold.apply(services.holds, [context, context]);",
      'services.holds.createHold["bind"](services.holds)({}, context);',
      "(services.holds.createHold.bind)(services.holds)({}, context);",
      'function route(svc: InventoryServices["holds"]) { svc.createHold({}, context); }',
      "const named = { ...services.holds, createHold: services.holds.createHold }; named.createHold({}, context);",
      "declare const registry: Record<string, unknown>; registry[method];",
      "localStorage[method]; sessionStorage[method];",
      "const values = [() => 1]; values[0]();",
      "const unrelated = { createHold() {} }; unrelated[method]();",
      "services.pool[method]; services.db[method]; services.projectors[0];",
    ];
    await matrix(
      cases.map((source) => ({ source })),
      ({ root, roots, program, families }) => {
        expect(analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families }).diagnostics).toEqual([]);
      },
    );
  });

  it.each(["receiver-type-ignored", "laundering-unchecked"])(
    "kills the %s bypass with frozen inputs",
    async (mutant) => {
      await matrix(
        [
          {
            source:
              mutant === "receiver-type-ignored"
                ? 'function route(svc: InventoryServices["holds"]) { svc[method](); }'
                : "const erased: unknown = services.holds;",
          },
        ],
        ({ root, roots, program, families }) => {
          const options = { repoRoot: root, roots, program, families };
          const legacy = discoverInventoryCallers(
            roots.map((file) => ({
              path: file,
              source: readFileSync(path.join(root, file), "utf8"),
            })),
          );
          expect(legacy.callers).toEqual([]);
          expect(() => partitionInventoryCallers(legacy, {})).not.toThrow();
          const candidate = analyzeInventoryDynamicDispatch(options);
          const bypass = analyzeInventoryDynamicDispatch({ ...options, mutant });
          expect(candidate.diagnostics).toHaveLength(1);
          expect(bypass.diagnostics).toEqual([]);
          expect(() => expect(bypass.diagnostics).toHaveLength(1)).toThrow();
          emit("mutant-killed", {
            mutant,
            candidate: "PASS",
            bypass: "FAIL",
            governingInput: mutant,
            otherInputs: "unchanged",
            legacyTextArm: "ADMITTED",
          });
        },
      );
    },
  );
});

describe("issue-7169-type-resolved-census-corpus", () => {
  it("has zero tracked rejections, complete C1 coverage and unchanged clean/built qualification", () => {
    const result = production;
    expect(result.diagnostics).toEqual([]);
    const c1Ignored = new Set(c1.ignored);
    const scanned = new Set(result.scanned);
    for (const source of sources) {
      if (!c1Ignored.has(source.path)) expect(scanned.has(source.path), source.path).toBe(true);
    }
    expect(result.scanned.length + result.ignored.length).toBe(result.total);
    expect(result.total).toBe(new Set([...roots, ...sources.map(({ path: file }) => file)]).size);
    const retained = partition.callers.filter(({ status }) => status !== "unrelated");
    emit("c1-partition", {
      total: partition.callers.length,
      retained: retained.length,
      unrelated: partition.callers.length - retained.length,
    });
    expect([partition.callers.length, retained.length, partition.callers.length - retained.length]).toEqual([
      141, 131, 10,
    ]);
    expect(built.diagnostics).toEqual(result.diagnostics);
    expect(built.scanned).toEqual(result.scanned);
    expect(built.total).toBe(result.total + 1);
    expect(built.ignored).toContain("bounded-contexts/unexpected/build/output.js");
    emit("family-table", families.table);
    emit("corpus-coverage", {
      scanned: result.scanned.length,
      ignored: result.ignored.length,
      total: result.total,
      c1Scanned: c1.scanned,
    });
  });

  it("fails the default arm for a synthetic new Inventory member until listed", async () => {
    await withTemporaryCorpus(
      {
        "tsconfig.json": fixtureConfig,
        [servicesFile]: `import type { InventoryServices as Existing } from ${absoluteImport(servicesFile)};
export type InventoryServices = Existing & { syntheticNew: Existing["holds"] };`,
        "bounded-contexts/arbitrary/api/client.ts": `export { createInventoryApiClient } from ${absoluteImport("bounded-contexts/inventory/client.ts")};`,
      },
      (root) => {
        const roots = enumerateTrackedRoots(root);
        const program = createClassificationProgram(root, roots);
        const options = { apiFile: "bounded-contexts/arbitrary/api/client.ts" };
        expect(() => resolveInventoryFamilies(program, root, options)).toThrow(
          "Unlisted InventoryServices member: syntheticNew",
        );
        const listed = resolveInventoryFamilies(program, root, {
          ...options,
          additionalMembers: { syntheticNew: "FAMILY" },
        });
        expect(listed.table).toContainEqual({ name: "syntheticNew", classification: "FAMILY" });
      },
    );
  });
});
