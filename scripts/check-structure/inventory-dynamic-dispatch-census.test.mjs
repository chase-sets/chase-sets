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
  [
    "F2-K3b",
    "export function route(svc: H) { const { [method]: fn } = svc as H & Record<string, Fn>; return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-K3c",
    "export function route(svc: H) { let fn: unknown; ({ [method]: fn } = svc as H & Record<string, Fn>); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-K4",
    'export function route(svc: H) { const { [method as "createHold"]: fn } = svc; return fn(context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D2",
    "export function route(svc: H) { for (const { [method]: fn } of [svc as H & Record<string, Fn>]) fn(); }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D3",
    'export function route() { const { holds: { [method as "createHold"]: fn } } = services; return fn(context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D4",
    'export function route(svc: H) { const { s: { [method as "createHold"]: fn } } = { s: svc }; return fn(context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D5",
    'export function route(svc: H) { const [{ [method as "createHold"]: fn }] = [svc]; return fn(context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D6",
    'export function route(svc: H) { let fn: unknown; ({ s: { [method as "createHold"]: fn } } = { s: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D7",
    'export function route(svc: H) { let fn: unknown; for ({ [method as "createHold"]: fn } of [svc]); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "F2-D10",
    'export function route(list: H[]) { return list.map(({ [method as "createHold"]: fn }) => fn(context, context)); }',
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
  [
    "F4-S1",
    "export const leak = (svc: H): any => svc; export function route(svc: H) { return leak(svc)[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-S2",
    "export const leak = (svc: H): unknown => svc; export function route(svc: H) { return leak(svc); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-S3",
    "export function route(svc: H) { const bag: { holds: any } = { holds: svc }; return bag.holds[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F4-S4",
    "export function route(svc: H) { const bag: Record<string, unknown> = { holds: svc }; return bag.holds; }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["F4-S5", "export function* gen(svc: H): Generator<unknown> { yield svc; }", "FAMILY_TYPE_ERASURE"],
  [
    "F4-S6",
    "declare function later(value: () => unknown): void; export function route(svc: H) { later(() => svc); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "F1-K7",
    'export function route(svc: H) { let k = method as "createHold"; return svc[k](context, context); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W1",
    'export function route(svc: H) { let k = "createHold"; k = method; return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W2",
    'export function route(svc: H) { var k = "createHold"; k = method; return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W3",
    'let k = "createHold"; export function set(m: string) { k = m; } export function route(svc: H) { return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W4",
    'export function route(svc: H) { for (let k = "createHold"; flag; k = method) (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W5",
    'export function route(svc: H) { let k = "createHold"; ({ k } = { k: method }); return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W6",
    'export function route(svc: H) { let k = "create"; k += method; return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "W7",
    'export function route(svc: H) { let a = "createHold"; a = method; const k = a; return (svc as H & Record<string, Fn>)[k](); }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "X6",
    'export function route(svc: H) { let fn: unknown; ({ ["s"]: { [method as "createHold"]: fn } } = { s: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "X6b",
    'export function route(svc: H) { let fn: unknown; ({ 0: { [method as "createHold"]: fn } } = [svc]); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "X6c",
    'export function route(svc: H) { let fn: unknown; ({ [`s`]: { [method as "createHold"]: fn } } = { s: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "X6d",
    'export function route(svc: H) { const o = "s"; let fn: unknown; ({ [o]: { [method as "createHold"]: fn } } = { s: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "N13-S3",
    "export function route(holds: H) { const bag: { holds: any } = { holds }; return bag.holds[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "N13-T1",
    "declare function tag(strings: TemplateStringsArray, ...values: unknown[]): void; export function route(svc: H) { tag`${svc}`; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "N13-X2",
    'export function route(svc: H) { let fn: unknown; let n: number; [n, { [method as "createHold"]: fn }] = [0, svc]; return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "N13-X3",
    'export function route(svc: H) { let fn: unknown; for ([{ [method as "createHold"]: fn }] of [[svc]]); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "N13-J1",
    "declare function C(p: { v: unknown }): null; export function route(svc: H) { return <C v={svc} />; }",
    "FAMILY_TYPE_ERASURE",
  ],
].map(([id, source, reason]) => ({ id, source, reason }));

const finiteAliasCleanControls = [
  [
    "W8",
    'export function route(svc: H) { let k: keyof H = "createHold"; k = flag ? "releaseHold" : "createHold"; return svc[k](context, context); }',
  ],
  ["W9", 'export function route(svc: H) { let k = "createHold" as const; return svc[k](context, context); }'],
].map(([id, source]) => ({ id, source }));

const assignmentClosureControls = [
  [
    "Y1",
    "export function route(svc: H) { let fn: unknown; ({ [method]: fn } = svc); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y2",
    "export function route(svc: H) { let fn: unknown; ({ s: { [method]: fn } } = { s: svc }); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y3",
    "export function route(svc: H) { let fn: unknown; ([{ [method]: fn }] = [svc]); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y3c",
    "export function route(svc: H) { let fn: unknown; ({ 0: { [method]: fn } } = [svc]); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y4",
    "export function route(svc: H) { let fn: unknown; ({ [method as string]: fn } = svc); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y5",
    "export function route(svc: H) { let fn: unknown; for ({ [method]: fn } of [svc]); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y6",
    "export function route(svc: H) { let fn: unknown; for ({ [method]: fn } in svc); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y7",
    "export function route(svc: H) { let fn: unknown; ({ s: { [method]: fn } = {} } = { s: svc }); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y8",
    "export function route(svc: H) { let fn: unknown, rest: any; ({ [method]: fn, ...rest } = svc); return fn; }",
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G1",
    "export function route(svc: H) { let erased: any; ({ holds: erased = svc } = services); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "G2",
    "export function route(svc: H) { let erased: unknown; ({ holds: erased = svc } = services); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "G3",
    "export function route(svc: H) { let erased: any; ({ holds: { value: erased } } = { holds: svc }); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "G4",
    "export function route(svc: H) { let erased: unknown; ([erased = svc] = [svc]); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "G5",
    "export function route(svc: H) { let erased: any; ({ ...erased } = services); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "G6",
    "export function route(svc: H) { let erased: unknown; ([...erased] = [svc]); return erased; }",
    "FAMILY_TYPE_ERASURE",
  ],
].map(([id, source, reason]) => ({ id, source, reason }));

const briefS3Controls = [
  [
    "B1",
    "declare const r: Record<string, H>; export function route() { let a: unknown; ({ [method]: a } = r); return a; }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "B2",
    "declare const r: { [key: string]: H }; export function route() { let a: any; ({ [method]: a } = r); return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "Y1",
    'declare const m: Record<string, H>; export function route() { let fn: unknown; ({ s: { [method as "createHold"]: fn } } = m); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y2",
    'declare const m: { [key: string]: H }; export function route() { let fn: unknown; ({ s: { [method as "createHold"]: fn } } = m); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y3",
    'export function route(list: H[]) { let fn: unknown; ({ 0: { [method as "createHold"]: fn } } = list); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y3c",
    'export function route(list: H[]) { let fn: unknown; ({ [0]: { [method as "createHold"]: fn } } = list); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y4",
    'export function route(svc: H) { let fn: unknown; for ({ [method as "createHold"]: fn } of new Set([svc])); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y5",
    'function* g(svc: H) { yield svc; } export function route(svc: H) { let fn: unknown; for ({ [method as "createHold"]: fn } of g(svc)); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y6",
    'declare const items: Iterable<H>; export function route() { let fn: unknown; for ({ [method as "createHold"]: fn } of items); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y7",
    'export function route(svc: H) { let fn: unknown; [{ [method as "createHold"]: fn }] = new Set([svc]); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Y8",
    'export function route(svc: H) { let fn: unknown; for ([, { [method as "createHold"]: fn }] of new Map([["s", svc]])); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G1",
    'declare const m: { s: H }; export function route() { let fn: unknown; ({ s: { [method as "createHold"]: fn } = {} as Record<string, unknown> } = m); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G2",
    'export function route(svc: H) { let fn: unknown; [{ [method as "createHold"]: fn } = {} as Record<string, unknown>] = [svc]; return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G3",
    'export function route(svc: H) { let fn: unknown; [...[{ [method as "createHold"]: fn }]] = [svc]; return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G4",
    'declare const list: { s: H }[]; export function route() { let fn: unknown; for ({ s: { [method as "createHold"]: fn } = {} as Record<string, unknown> } of list); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G5",
    'declare const items: AsyncIterable<H>; export async function route() { let fn: unknown; for await ({ [method as "createHold"]: fn } of items); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "G6",
    'declare const u: H[] | Set<H>; export function route() { let fn: unknown; for ({ [method as "createHold"]: fn } of u); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "L1",
    "export function route(svc: H) { let a: unknown; ({ a = svc } = {} as { a?: unknown }); return a; }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["L2", "export function route() { let a: unknown; ({ holds: a } = services); consume(a); }", "FAMILY_TYPE_ERASURE"],
  [
    "L6",
    "export function route() { let a: any; ({ holds: a } = services); return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "L9",
    "export function route() { let a: any; for ({ holds: a } of [services]); return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "L11",
    "declare const t: [H]; export function route() { let a: any; [a] = t; return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "L12",
    "export function route(svc: H) { let a: any; ({ a = svc } = {} as { a?: unknown }); return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  [
    "Z1",
    'export function route(svc: H) { let fn: unknown; ({ [flag ? "s" : "t"]: { [method as "createHold"]: fn } } = { s: svc, t: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "Z2",
    'declare const which: "s" | "t"; export function route(svc: H) { let fn: unknown; ({ [which]: { [method as "createHold"]: fn } } = { s: svc, t: svc }); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
  [
    "A3",
    "declare const m: { s: H }; export function route() { let a: any; ({ s: a } = m); return a; }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["A5", "declare const t: H[]; export function route() { let a: any; [a] = t; return a; }", "FAMILY_TYPE_ERASURE"],
  [
    "A6",
    "export function route(svc: H) { let a: any; ({ a = svc } = {} as { a?: number }); return a; }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["A19", "export function route(svc: H) { let a: any; [a] = new Set([svc]); return a; }", "FAMILY_TYPE_ERASURE"],
  [
    "A14",
    "export function route() { let a: any; ({ holds: a = undefined } = services); return a[method](context, context); }",
    "FAMILY_TYPE_ERASURE",
  ],
  ["C5", "export function route(svc: H) { let a: any; [...[a]] = [svc]; return a; }", "FAMILY_TYPE_ERASURE"],
  [
    "C6",
    'declare const rows: H[][]; export function route() { let fn: unknown; for ([...[{ [method as "createHold"]: fn }]] of rows); return fn; }',
    "FAMILY_DYNAMIC_KEY",
  ],
].map(([id, source, reason]) => ({ id, source, reason }));

const briefS3CleanControls = [
  [
    "Y11",
    'export function route(svc: H) { let fn: unknown; ({ ["s"]: { createHold: fn } } = { s: svc }); return fn; }',
  ],
  ["Y12", "export function route(svc: H) { let fn: unknown; ({ 0: { createHold: fn } } = [svc]); return fn; }"],
  [
    "Y13",
    "declare const m: Record<string, H>; export function route() { let fn: unknown; ({ s: { createHold: fn } } = m); return fn; }",
  ],
  [
    "P-NF1",
    "declare const registry: Record<string, unknown>; export function route() { let v: unknown; ({ [method]: v } = registry); return v; }",
  ],
  ["P-S1", 'export function route(svc: H) { let fn: unknown; ({ ["createHold"]: fn } = svc); return fn; }'],
  [
    "P-S2",
    'export function route(svc: H) { const k = "createHold"; let fn: unknown; ({ [k]: fn } = svc); return fn; }',
  ],
  [
    "P-S3",
    'declare const m: Record<string, H>; export function route() { let fn: unknown; ({ ["s"]: { ["createHold"]: fn } } = m); return fn; }',
  ],
  [
    "T1",
    'export function route(svc: H) { let fn: H["createHold"]; ({ ["s"]: { createHold: fn } } = { s: svc }); return fn; }',
  ],
  ["T2", 'export function route(svc: H) { let fn: H["createHold"]; ({ 0: { createHold: fn } } = [svc]); return fn; }'],
  [
    "T3",
    'declare const m: Record<string, H>; export function route() { let fn: H["createHold"]; ({ s: { createHold: fn } } = m); return fn; }',
  ],
  ["T4", "export function route() { let holds: H; ({ holds } = services); return holds; }"],
  [
    "T5",
    "declare const source: number[]; export function route(i: number, j: number) { const rows = [...source]; [rows[i], rows[j]] = [rows[j]!, rows[i]!]; return rows; }",
  ],
  [
    "T6",
    "declare function write(): Promise<{ digest: string }>; export async function route() { let fileSha256: string; ({ digest: fileSha256 } = await write()); return fileSha256; }",
  ],
  [
    "N15-names",
    'declare const src: { n: Record<string, number>; s: H }; export function route() { let v: unknown; ({ ["n"]: { [method]: v } } = src); return v; }',
  ],
  ["A8", "export function route() { let h: H; ({ holds: h } = services); return h; }"],
  ["A10", "export function route(fallback: H) { const { holds: h = fallback } = services; return h; }"],
  ["A11", "export function route({ holds = services.holds }: Partial<InventoryServices>) { return holds; }"],
  ["A12", "export function route(fallback: H) { let h: H; ({ holds: h = fallback } = services); return h; }"],
  [
    "A13",
    'export function route() { let r: InventoryServices["restockDecisions"]; ({ restockDecisions: r } = services); return r; }',
  ],
  ["A17", "declare const t: number[]; export function route() { let a: any; [a] = t; return a; }"],
  [
    "B9",
    "declare const r: { [n: number]: number }; declare const n: number; export function route() { let a: unknown; ({ [n]: a } = r); return a; }",
  ],
  [
    "E3",
    "declare const r: { [key: string]: H }; export function route() { let h: H; ({ [method]: h } = r); return h; }",
  ],
  ["C1", "export function route(x: any) { const xs = [...[x]]; return xs; }"],
  ["C2", "export function route() { consume([...[{ [method]: 1 }]]); }"],
  ["C3", "export function route(x: unknown) { let xs: unknown[]; xs = [...[x]]; return xs; }"],
  ["C4", "export function route(x: any) { return [...[{ value: x }]]; }"],
].map(([id, source]) => ({ id, source }));

async function matrix(cases, run) {
  const fixtures = Object.fromEntries(
    cases.map(({ source, id }, index) => [
      `bounded-contexts/unexpected/features/arbitrary/api/case-${index}${id?.endsWith("J1") ? ".tsx" : ".ts"}`,
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

describe("issue-7169-destructuring-assignment-closure", () => {
  it("keeps the brief's S3 controls compile-clean and rejected", async () => {
    await matrix(briefS3Controls, ({ root, roots, program, families, fixtures }) => {
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      for (const [index, control] of briefS3Controls.entries()) {
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
      emit("s3-brief-controls", { total: briefS3Controls.length, rejected: result.diagnostics.length });
    });
  });

  it("keeps the brief's S3 precision controls compile-clean and admitted", async () => {
    await matrix(briefS3CleanControls, ({ root, roots, program, families, fixtures }) => {
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      for (const [index, control] of briefS3CleanControls.entries()) {
        const file = Object.keys(fixtures)[index];
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), control.id).toEqual([]);
        expect(program.getSemanticDiagnostics(source), control.id).toEqual([]);
        expect(
          result.diagnostics.some(({ file: diagnosticFile }) => diagnosticFile === file),
          control.id,
        ).toBe(false);
      }
      emit("s3-brief-clean", { total: briefS3CleanControls.length, admitted: briefS3CleanControls.length });
    });
  });

  it.each([
    ["assignment-source-syntactic", ["Y1", "Y2", "Y3", "Y3c", "Y4", "Y5", "Y6", "Y7", "Y8"]],
    ["assignment-unresolved-open", ["G1", "G2", "G3", "G4", "C6"]],
    ["assignment-default-trusted", ["G1", "G2", "G4"]],
    ["assignment-target-erasure-off", ["L1", "L2", "L6", "L9", "L11", "L12", "B2", "A14"]],
  ])("kills the %s S3 bypass", async (mutant, ids) => {
    const controls = briefS3Controls.filter(({ id }) => ids.includes(id));
    await matrix(controls, ({ root, roots, program, families, fixtures }) => {
      const options = { repoRoot: root, roots, program, families };
      const candidate = analyzeInventoryDynamicDispatch(options);
      const bypass = analyzeInventoryDynamicDispatch({ ...options, mutant });
      for (const [index, control] of controls.entries()) {
        const file = Object.keys(fixtures)[index];
        expect(
          candidate.diagnostics.some(
            ({ file: diagnosticFile, reason }) => diagnosticFile === file && reason === control.reason,
          ),
          `candidate:${control.id}`,
        ).toBe(true);
        expect(
          bypass.diagnostics.some(({ file: diagnosticFile }) => diagnosticFile === file),
          `${mutant}:${control.id}`,
        ).toBe(false);
      }
      emit("s3-mutant", { mutant, controls: controls.map(({ id }) => id), result: "KILLED" });
    });
  });
});

// Prepare the tracked Program once, as in authoritative-stream-read-classification.test.mjs.
const { roots, sources, production, c1, partition, built, familyTable } = (() => {
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
  return { roots, sources, production, c1, partition, built, familyTable: families.table };
})();

describe("issue-7169-type-resolved-census-matrix", () => {
  it("closes destructuring-assignment sources and erasure sinks", async () => {
    await matrix(assignmentClosureControls, ({ root, roots, program, families, fixtures }) => {
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      for (const [index, control] of assignmentClosureControls.entries()) {
        const file = Object.keys(fixtures)[index];
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), control.id).toEqual([]);
        expect(
          result.diagnostics.some(
            ({ file: diagnosticFile, reason }) => diagnosticFile === file && reason === control.reason,
          ),
          control.id,
        ).toBe(true);
      }
      emit("assignment-closure", { total: assignmentClosureControls.length, rejected: result.diagnostics.length });
    });
  });

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
    const formsByFamily = new Map(
      familyExpressions.map(([family, expression, type]) => [
        family,
        [...shapes(expression, type), ...p1(expression, type, "member")],
      ]),
    );
    const cases = familyExpressions.map(([family]) => ({
      family,
      source: formsByFamily
        .get(family)
        .map((form) => `{ ${form} }`)
        .join("\n"),
    }));
    let rejectedForms = 0;
    let totalDiagnostics = 0;
    const reasonCounts = new Map();
    await matrix(cases, ({ root, roots, program, families, fixtures }) => {
      expect(families.families.map(({ name }) => name).sort()).toEqual(familyExpressions.map(([name]) => name).sort());
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      const expectedLines = prelude.split("\n").length + 1;
      for (const fixture of Object.keys(fixtures)) {
        const diagnostics = result.diagnostics.filter(({ file }) => file === fixture);
        const familyIndex = Number(fixture.match(/case-(\d+)/)?.[1]);
        const forms = formsByFamily.get(cases[familyIndex].family);
        for (const [index, form] of forms.entries()) {
          expect(
            diagnostics.some(({ line }) => line === expectedLines + index),
            form,
          ).toBe(true);
        }
        rejectedForms += forms.length;
        totalDiagnostics += diagnostics.length;
        for (const { reason } of diagnostics) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
      emit(
        "family-matrix",
        familyExpressions.map(([family]) => ({ family, m16: 16, p1: 23, rejected: 39 })),
      );
    });
    expect(rejectedForms).toBe(663);
    expect(totalDiagnostics).toBe(744);
    expect(Object.fromEntries(reasonCounts)).toEqual({
      FAMILY_DYNAMIC_KEY: 510,
      FAMILY_TYPE_ERASURE: 119,
      UNNAMED_FAMILY_MEMBER: 47,
      FAMILY_ENUMERATION: 68,
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
      'let key: "createHold" = "createHold"; services.holds[key]({}, context);',
      'var key: "createHold" = "createHold"; services.holds[key]({}, context);',
      '({ ["s"]: { createHold: fn } } = { s: services.holds });',
      "({ 0: { createHold: fn } } = [services.holds]);",
      "const m = services.holds.createHold; m({}, context);",
      "const { createHold: m } = services.holds; m({}, context);",
      "const { holds: { createHold } } = services; createHold({}, context);",
      "let holds: H; ({ holds } = services); holds.createHold({}, context);",
      'const k = "createHold" as const; services.holds[k]({}, context);',
      'function route(k: "createHold") { services.holds[k]({}, context); }',
      "const bag: { holds: H } = { holds: services.holds }; bag.holds.createHold({}, context);",
      "const holds = services.holds; const bag: { holds: H } = { holds }; bag.holds.createHold({}, context);",
      "const route = (svc: H): H => svc; route(services.holds).createHold({}, context);",
      "function* gen(svc: H): Generator<H> { yield svc; } gen(services.holds).next();",
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
      ...finiteAliasCleanControls.map(({ source }) => source),
    ];
    await matrix(
      cases.map((source) => ({ source })),
      ({ root, roots, program, families }) => {
        expect(analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families }).diagnostics).toEqual([]);
      },
    );
  });

  it("keeps the W8-W9 finite mutable-alias controls clean", async () => {
    await matrix(finiteAliasCleanControls, ({ root, roots, program, families, fixtures }) => {
      const result = analyzeInventoryDynamicDispatch({ repoRoot: root, roots, program, families });
      for (const [index, control] of finiteAliasCleanControls.entries()) {
        const file = Object.keys(fixtures)[index];
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), control.id).toEqual([]);
        expect(program.getSemanticDiagnostics(source), control.id).toEqual([]);
        expect(
          result.diagnostics.some(({ file: diagnosticFile }) => diagnosticFile === file),
          control.id,
        ).toBe(false);
      }
      emit(
        "finite-alias-clean",
        finiteAliasCleanControls.map(({ id }) => ({ id, result: "CLEAN" })),
      );
    });
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
      147, 137, 10,
    ]);
    expect(built.diagnostics).toEqual(result.diagnostics);
    expect(built.scanned).toEqual(result.scanned);
    expect(built.total).toBe(result.total + 1);
    expect(built.ignored).toContain("bounded-contexts/unexpected/build/output.js");
    emit("family-table", familyTable);
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

// One line per form. An optional family member may be undefined, so a value
// passed to a family-typed parameter takes `!` and `satisfies` admits undefined.
function throwOperandForms(expression, type, statement) {
  return [
    ["bare", `export function bare() { ${statement(expression)} }`],
    ["parenthesized", `export function parenthesized() { ${statement(`(${expression})`)} }`],
    ["non-null", `export function nonNull() { ${statement(`${expression}!`)} }`],
    ["as", `export function asserted() { ${statement(`(${expression} as ${type})`)} }`],
    ["satisfies", `export function satisfied() { ${statement(`${expression} satisfies ${type} | undefined`)} }`],
    ["conditional", `export function conditional() { ${statement(`flag ? ${expression} : ${expression}`)} }`],
    ["comma", `export function comma() { ${statement(`(String(method), ${expression})`)} }`],
    ["parameter", `export function parameter(s: ${type}) { ${statement("s")} }`],
    ["call", `declare function make(): ${type}; export function call() { ${statement("make()")} }`],
    ["await", `export async function awaited(p: Promise<${type}>) { ${statement("await p")} }`],
  ];
}

function throwReceiverForms(expression, type) {
  return [
    [
      "catch-any",
      `export function catchAny() { try { throw ${expression}; } catch (e: any) { e[method]({}, context); } }`,
    ],
    [
      "catch-unknown",
      `export function catchUnknown() { try { throw ${expression}; } catch (e: unknown) { consumeUnknown(e); } }`,
    ],
    [
      "catch-implicit",
      `export function catchImplicit() { try { throw ${expression}; } catch (e) { consumeUnknown(e); } }`,
    ],
    [
      "separate-thrower",
      `function fail(s: ${type}): never { throw s; } export function separate() { try { fail(${expression}!); } catch (e: any) { e[method]({}, context); } }`,
    ],
    [
      "async-thrower",
      `async function failAsync(s: ${type}) { throw s; } export function asyncCatch() { return failAsync(${expression}!).catch((e: any) => e[method]({}, context)); }`,
    ],
  ];
}

const throwErasureOff = "throw-erasure-off";
const firstFormLine = prelude.split("\n").length + 1;
const familyFormCases = (formsOf) =>
  familyExpressions.map(([family, expression, type]) => {
    const forms = formsOf(expression, type);
    return { family, forms, source: forms.map(([, line]) => line).join("\n") };
  });
const throwCases = familyFormCases((expression, type) => [
  ...throwOperandForms(expression, type, (operand) => `throw ${operand};`),
  ...throwReceiverForms(expression, type),
]);
const declarationTwinCases = familyFormCases((expression, type) =>
  throwOperandForms(expression, type, (operand) => `const e: any = ${operand}; return e;`),
);
const throwPrecisionControls = [
  ["error", "export function route() { throw new Error(String(method)); }", "ADMITTED"],
  ["rethrow", "export function route() { try { consumeUnknown(method); } catch (e) { throw e; } }", "ADMITTED"],
  ["non-family", "export function route() { throw services.pool; }", "ADMITTED"],
  [
    "static-call-in-try",
    "export function route() { try { services.holds.createHold(context, context); } catch (e) { consumeUnknown(e); } }",
    "ADMITTED",
  ],
  ["object-container", "export function route(svc: H) { throw { svc }; }", "ADMITTED", "#9820 L16 recorded boundary"],
  ["array-container", "export function route(svc: H) { throw [svc]; }", "ADMITTED", "#9820 L16 recorded boundary"],
  ["object-container-twin", "export function route(svc: H) { const e: any = { svc }; return e; }", "ADMITTED"],
  [
    "array-container-twin",
    "export function route(svc: H) { const e: any = [svc]; return e; }",
    "FAMILY_TYPE_ERASURE",
    "L5 element sink",
  ],
  ["error-cause", 'export function route(svc: H) { throw new Error("x", { cause: svc }); }', "FAMILY_TYPE_ERASURE"],
  ["promise-reject", "export function route(svc: H) { return Promise.reject(svc); }", "FAMILY_TYPE_ERASURE"],
].map(([id, source, verdict, note]) => ({ id, source, verdict, note }));

const diagnosticsIn = (result, file) => result.diagnostics.filter((diagnostic) => diagnostic.file === file);

function verdictIn(result, file) {
  const reasons = [...new Set(diagnosticsIn(result, file).map(({ reason }) => reason))];
  return reasons.length ? reasons.join("+") : "ADMITTED";
}

function expectOneErasurePerForm(diagnostics, { family, forms }, file) {
  for (const [offset, [form]] of forms.entries()) {
    const line = firstFormLine + offset;
    expect(
      diagnostics.filter((diagnostic) => diagnostic.line === line),
      `${family}:${form}`,
    ).toEqual([{ file, line, reason: "FAMILY_TYPE_ERASURE" }]);
  }
  expect(diagnostics, family).toHaveLength(forms.length);
}

describe("issue-7169-census-throw-erasure", () => {
  it("rejects every derived family's thrown operand forms whatever catch receives them", async () => {
    await matrix(throwCases, ({ root, roots, program, families, fixtures }) => {
      expect(families.families.map(({ name }) => name).sort()).toEqual(familyExpressions.map(([name]) => name).sort());
      const options = { repoRoot: root, roots, program, families };
      const candidate = analyzeInventoryDynamicDispatch(options);
      // The arm is the only census change, so its bypass reproduces the base verdicts.
      const base = analyzeInventoryDynamicDispatch({ ...options, mutant: throwErasureOff });
      for (const [index, file] of Object.keys(fixtures).entries()) {
        const control = throwCases[index];
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), control.family).toEqual([]);
        expect(program.getSemanticDiagnostics(source), control.family).toEqual([]);
        expect(diagnosticsIn(base, file), control.family).toEqual([]);
        expectOneErasurePerForm(diagnosticsIn(candidate, file), control, file);
      }
      expect(candidate.diagnostics).toHaveLength(255);
      expect(base.diagnostics).toEqual([]);
      emit(
        "throw-erasure-t1",
        throwCases.map(({ family, forms }) => ({
          family,
          forms: forms.map(([form]) => form),
          base: "ADMITTED",
          candidate: "FAMILY_TYPE_ERASURE",
        })),
      );
      emit("mutant-killed", {
        mutant: throwErasureOff,
        controls: candidate.diagnostics.length,
        candidate: "PASS",
        bypass: "FAIL",
        governingInput: "ThrowStatement operand",
        otherInputs: "unchanged",
      });
    });
  });

  it("keeps declaration twins rejected and precision, boundary and preservation controls at their base verdict", async () => {
    const cases = [...declarationTwinCases, ...throwPrecisionControls];
    await matrix(cases, ({ root, roots, program, families, fixtures }) => {
      const options = { repoRoot: root, roots, program, families };
      const candidate = analyzeInventoryDynamicDispatch(options);
      const base = analyzeInventoryDynamicDispatch({ ...options, mutant: throwErasureOff });
      const files = Object.keys(fixtures);
      for (const [index, file] of files.entries()) {
        const label = cases[index].family ?? cases[index].id;
        const source = program.getSourceFile(path.join(root, file));
        expect(program.getSyntacticDiagnostics(source), label).toEqual([]);
        expect(program.getSemanticDiagnostics(source), label).toEqual([]);
        expect(diagnosticsIn(base, file), label).toEqual(diagnosticsIn(candidate, file));
      }
      for (const [index, control] of declarationTwinCases.entries()) {
        expectOneErasurePerForm(diagnosticsIn(candidate, files[index]), control, files[index]);
      }
      const verdicts = throwPrecisionControls.map(({ id, verdict, note }, offset) => {
        const file = files[declarationTwinCases.length + offset];
        const observed = { base: verdictIn(base, file), candidate: verdictIn(candidate, file) };
        expect(observed, id).toEqual({ base: verdict, candidate: verdict });
        return { id, ...observed, ...(note && { note }) };
      });
      emit("throw-erasure-t2-twins", {
        families: declarationTwinCases.length,
        forms: declarationTwinCases[0].forms.map(([form]) => form),
        base: "FAMILY_TYPE_ERASURE",
        candidate: "FAMILY_TYPE_ERASURE",
      });
      emit("throw-erasure-t2", verdicts);
    });
  });

  it.each([
    [
      "S1 family matrix and restock",
      () => [
        ...familyExpressions.map(([family, expression, type]) => ({
          family,
          source: [...shapes(expression, type), ...p1(expression, type, "member")]
            .map((form) => `{ ${form} }`)
            .join("\n"),
        })),
        ...restockControls().map((source) => ({ source })),
      ],
    ],
    [
      "S1 repair, W8-W9, assignment closure and S3",
      () => [
        ...repairControls,
        ...finiteAliasCleanControls,
        ...assignmentClosureControls,
        ...briefS3Controls,
        ...briefS3CleanControls,
      ],
    ],
  ])("keeps every %s verdict under the throw-erasure-off bypass", async (group, controls) => {
    const cases = controls();
    await matrix(cases, ({ root, roots, program, families }) => {
      const options = { repoRoot: root, roots, program, families };
      const candidate = analyzeInventoryDynamicDispatch(options);
      const bypass = analyzeInventoryDynamicDispatch({ ...options, mutant: throwErasureOff });
      expect(candidate.diagnostics.length).toBeGreaterThan(0);
      expect(bypass.diagnostics).toEqual(candidate.diagnostics);
      emit("throw-erasure-off-unchanged", { group, controls: cases.length, diagnostics: candidate.diagnostics.length });
    });
  });
});
