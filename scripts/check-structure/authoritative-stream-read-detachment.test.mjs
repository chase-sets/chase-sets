import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import * as classification from "./authoritative-stream-read-classification.mjs";

const diagnosticKeys = ["file", "line", "node", "outcome", "sourceFile", "sourceStart"];
const predecessorTotalKeys = [
  "ambiguousOriginSites",
  "authoritativeSites",
  "authorityAbsentCandidates",
  "discoveredCallCandidates",
  "dynamicKeyOutcomes",
  "extensionCounts",
  "helperSites",
  "insufficientReceiverContractSites",
  "loadedRoots",
  "optionalSyntaxOutcomes",
  "outOfLocationHelperSites",
  "roots",
];

const production = classification.analyzeAuthoritativeStreamReads({ repoRoot });
const [detachment, logical, adapter, opaque, localAdapter, mixedAdapter] = await Promise.all([
  analyzeFixture(detachmentFixture()),
  analyzeFixture(logicalArgumentFixture()),
  analyzeFixture(adapterCardinalityFixture()),
  analyzeFixture(opaqueAggregateFixture()),
  analyzeFixture(localAdapterFixture()),
  analyzeFixture(mixedAdapterFixture()),
]);

describe("authoritative-stream-read-detachment-acceptance-control", () => {
  it("keeps whole-object moves and direct calls green while closing projections and every pattern context", () => {
    expect(diagnosticTexts(detachment)).toEqual([
      ["packages/detachment.ts", "readStream", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "kLiteral", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "kUnionWith", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "store[dynamicKey]", "CANONICAL_RECEIVER_DYNAMIC_KEY"],
      ["packages/detachment.ts", "readStream: destructured", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream: assigned", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "...reader", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream: renamed", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream = fallback", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream: nested", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", '["readStream"]: computed', "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream: parameterRead", "CANONICAL_VALUE_ESCAPE"],
      ["packages/detachment.ts", "readStream: iteratedRead", "CANONICAL_VALUE_ESCAPE"],
    ]);
    expect(detachment.candidates.map((entry) => entry.callNode.getText())).toEqual([
      "store.readStream(input)",
      "moved.readStream(input)",
    ]);
    expect(detachment.candidates.every((entry) => entry.outcome === "CANONICAL" && entry.admitted)).toBe(true);
    expect(detachment.diagnostics.some((entry) => entry.node.getText() === 'EventStore["readStream"]')).toBe(false);
    expect(detachment.diagnostics.some((entry) => entry.node.getText() === "typeof store.readStream")).toBe(false);
    expect(
      [...Map.groupBy(detachment.diagnostics, (entry) => `${entry.file}:${entry.line}`).values()].some(
        (entries) => entries.length === 2 && entries[0].node !== entries[1].node,
      ),
    ).toBe(true);
  });

  it("terminates and accounts every opaque aggregate family without opening its hidden values", () => {
    expect(opaque.diagnostics).toEqual([]);
    expect(opaque.totals).toMatchObject({
      detachmentEscapeSites: 0,
      resolvedAggregateFragments: 1,
      opaqueAggregateFragments: 8,
    });
    expect(opaque.roots.filter((file) => file.startsWith("packages/opaque-") && file.endsWith(".ts")).sort()).toEqual([
      "packages/opaque-cross-file.ts",
      "packages/opaque-cycle.ts",
      "packages/opaque-dynamic-spread.ts",
      "packages/opaque-later.ts",
      "packages/opaque-multiple.ts",
      "packages/opaque-mutable.ts",
      "packages/opaque-nonliteral.ts",
      "packages/opaque-nontuple.ts",
    ]);
  });

  it("normalizes direct, spread, alias, sanctioned adapter, sparse, nested, and new logical arguments", () => {
    expect(diagnosticTexts(logical)).toEqual([
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", "kUnionWith", "CANONICAL_VALUE_ESCAPE"],
      ["packages/logical.ts", '"readStream"', "CANONICAL_VALUE_ESCAPE"],
    ]);
    expect(logical.totals.detachmentEscapeSites).toBe(11);
    expect(logical.totals.resolvedAggregateFragments).toBe(16);
    expect(logical.totals.opaqueAggregateFragments).toBe(3);

    const sharedAliasKey = sourceNode(logical, "packages/logical.ts", '"readStream"', "sharedArgs");
    expect(logical.diagnostics.filter((entry) => entry.node === sharedAliasKey)).toHaveLength(1);
    expect(logical.diagnostics.some((entry) => entry.node.getText() === '"readAll"')).toBe(false);
  });
});

describe("authoritative-stream-read-adapter-key-cardinality-control", () => {
  it("sanctions only deduplicated call/apply singletons and makes every other set ordinary", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/check-structure/authoritative-stream-read-classification.mjs"),
      "utf8",
    );
    expect(source).toContain("keyValues.size !== 1");
    expect(source).not.toMatch(/keyValues\.has\(["']call["']\)|keyValues\.has\(["']apply["']\)/);
    const outcomes = diagnosticsByFunction(adapter, "packages/adapters.ts");
    expect(outcomes.get("singletonCall")).toBe(0);
    expect(outcomes.get("singletonTemplateCall")).toBe(0);
    expect(outcomes.get("singletonConcatCall")).toBe(0);
    expect(outcomes.get("duplicateSingletonCall")).toBe(0);
    expect(outcomes.get("singletonApply")).toBe(1);
    expect(outcomes.get("multiCallApplyOrdinary")).toBe(1);
    expect(outcomes.get("multiCallOtherOrdinary")).toBe(1);
    expect(outcomes.get("multiApplyOtherOrdinary")).toBe(1);
    expect(outcomes.get("multiConcatOrdinary")).toBe(1);
    expect(outcomes.get("dynamicOrdinary")).toBe(1);
    expect(outcomes.get("multiCallApplyPacked")).toBe(0);
    expect(outcomes.get("multiApplyOtherPacked")).toBe(0);
    expect(outcomes.get("dynamicPacked")).toBe(0);
    expect(outcomes.get("unsanctionedTerminatesRecursion")).toBe(1);
    expect(outcomes.get("nestedSanctioned")).toBe(1);

    for (const name of ["multiCallApplyPacked", "multiApplyOtherPacked", "dynamicPacked"]) {
      const declaration = functionDeclaration(adapter, "packages/adapters.ts", name);
      expect(fragmentNodesWithin(adapter, declaration)).toEqual([]);
    }
    expect(adapter.totals.resolvedAggregateFragments).toBe(2);
    expect(adapter.totals.opaqueAggregateFragments).toBe(0);
    expect(adapter.program.getSemanticDiagnostics().length).toBeGreaterThan(0);
  });

  it("keeps cardinality independent from local and mixed adapter declaration authority", () => {
    expect(diagnosticsByFunction(localAdapter, "packages/local.ts")).toEqual(
      new Map([
        ["localCall", 1],
        ["localApply", 0],
        ["functionCall", 1],
      ]),
    );

    expect(diagnosticsByFunction(mixedAdapter, "packages/mixed.ts")).toEqual(new Map([["mixedCall", 1]]));
  });
});

describe("authoritative-stream-read-diagnostic-independence-control", () => {
  it("does not consult compiler diagnostics even when the deciding corpus is semantically red", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/check-structure/authoritative-stream-read-classification.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/getSemanticDiagnostics|getSyntacticDiagnostics|getPreEmitDiagnostics/);
    expect(adapter.program.getSemanticDiagnostics().map((entry) => entry.code)).not.toEqual([]);
    expect(adapter.diagnostics.map((entry) => entry.outcome)).toEqual(
      Array(adapter.diagnostics.length).fill("CANONICAL_VALUE_ESCAPE"),
    );
  });
});

describe("authoritative-stream-read-diagnostics-transport-control", () => {
  it("preserves the frozen predecessor surface and returns exact live diagnostics with additive accounting", () => {
    expect(Object.keys(production).sort()).toEqual([
      "anchors",
      "candidates",
      "checker",
      "diagnostics",
      "program",
      "repoRoot",
      "roots",
      "totals",
      "ts",
    ]);
    expect(Object.keys(production.totals).sort()).toEqual(
      [
        ...predecessorTotalKeys,
        "detachmentEscapeSites",
        "opaqueAggregateFragments",
        "resolvedAggregateFragments",
      ].sort(),
    );
    expect(production.diagnostics).toEqual([]);
    expect(production.totals.detachmentEscapeSites).toBe(0);
    expect(production.totals).toMatchObject({
      roots: 2_916,
      loadedRoots: 2_916,
      discoveredCallCandidates: 8,
      authoritativeSites: 8,
      helperSites: 1,
      ambiguousOriginSites: 0,
      outOfLocationHelperSites: 0,
      insufficientReceiverContractSites: 0,
      authorityAbsentCandidates: 0,
      optionalSyntaxOutcomes: 0,
      dynamicKeyOutcomes: 0,
    });

    const combined = [...detachment.diagnostics, ...logical.diagnostics];
    expect(new Set(combined.map((entry) => entry.outcome))).toEqual(
      new Set(["CANONICAL_VALUE_ESCAPE", "CANONICAL_RECEIVER_DYNAMIC_KEY"]),
    );
    for (const entry of combined) {
      expect(Object.keys(entry).sort()).toEqual(diagnosticKeys);
      expect(entry.sourceFile).toBe(entry.node.getSourceFile());
      expect(entry.sourceStart).toBe(entry.node.getStart(entry.sourceFile));
      expect(entry.line).toBe(entry.sourceFile.getLineAndCharacterOfPosition(entry.sourceStart).line + 1);
    }
    expect(detachment.totals.detachmentEscapeSites).toBe(detachment.diagnostics.length);
  });

  it("derives the twelve green grammar instances across eleven live locations without a registry", () => {
    const green = deriveGreenGrammarInstances(production);
    expect(green).toHaveLength(12);
    expect(new Set(green.map((entry) => `${entry.file}:${entry.line}`))).toHaveLength(11);
    const shared = green.filter(
      (entry) => entry.file === "contracts/event-core/complete-stream.ts" && entry.line === 5,
    );
    expect(new Set(shared.map((entry) => entry.category))).toEqual(new Set(["member-declaration", "type-position"]));
    expect(
      green.some(
        (entry) => entry.category === "member-declaration" && propertyNameText(entry.node.name) === "readStreamSql",
      ),
    ).toBe(false);
  });
});

describe("authoritative-stream-read-diagnostics-consumer-control", () => {
  it("supports an identity-preserving consumer using only the returned result", () => {
    const consume = (result) =>
      result.diagnostics.map((record) => ({ record, sourceFile: record.sourceFile, node: record.node }));
    const report = consume(logical);
    expect(report.map((entry) => entry.record)).toEqual(logical.diagnostics);
    expect(report.every((entry, index) => entry.sourceFile === logical.diagnostics[index].sourceFile)).toBe(true);
    expect(report.every((entry, index) => entry.node === logical.diagnostics[index].node)).toBe(true);
  });
});

async function analyzeFixture(seed) {
  return classification.withTemporaryCorpus(seed, async (temporaryRoot) =>
    classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot }),
  );
}

function baseFixture() {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "Preserve",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
      },
      include: ["bounded-contexts/**/*", "contracts/**/*", "deployables/**/*", "infrastructure/**/*", "packages/**/*"],
      exclude: ["**/*.test.*", "**/*.spec.*", "**/*.tmp.*", "**/build/**", "**/dist/**", "**/coverage/**"],
    }),
    "contracts/event-core/event-store.ts": `
export type ReadStreamInput = Readonly<{ streamId: string }>;
export type StoredEvent = Readonly<{ streamVersion: number }>;
export type EventStore = Readonly<{
  appendToStream: (input: { streamId: string }) => Promise<readonly StoredEvent[]>;
  readStream: (input: ReadStreamInput) => Promise<readonly StoredEvent[]>;
  readAll: () => Promise<readonly StoredEvent[]>;
}>;
`,
    "contracts/event-core/complete-stream.ts": `
import type { EventStore } from "./event-store";
export type CompleteStreamReader = Readonly<{ readStream: EventStore["readStream"] }>;
`,
  };
}

function detachmentFixture() {
  return {
    ...baseFixture(),
    "packages/detachment.ts": `
import type { EventStore, ReadStreamInput } from "../contracts/event-core/event-store";
declare const store: EventStore;
declare const stores: readonly EventStore[];
declare const input: ReadStreamInput;
declare const fallback: EventStore["readStream"];
declare const dynamicKey: string;
declare const kLiteral: "readStream";
declare const kUnionWith: "readStream" | "readAll";
declare const kUnionWithout: "readAll" | "toString";
declare const holder: { store: EventStore };
type Twin = { readStream: EventStore["readStream"] };
type Unrelated = { readStream: () => string };
declare const twin: Twin;
declare const unrelated: Unrelated;
declare const mixed: EventStore | Twin;
declare const absent: any;
void store.readStream(input);
const moved = store;
void moved.readStream(input);
const projected = store.readStream;
const sameLineA = store.readStream, sameLineB = store.readStream;
const computedProjection = store["readStream"];
const literalAliasProjection = store[kLiteral];
const unionWithProjection = store[kUnionWith];
const unionWithoutProjection = store[kUnionWithout];
const dynamicProjection = store[dynamicKey];
const twinProjection = twin.readStream;
const unrelatedProjection = unrelated.readStream;
const mixedProjection = mixed.readStream;
const absentProjection = absent.readStream;
const dynamicTwinProjection = twin[dynamicKey];
const { readStream: destructured } = store;
let assigned = fallback;
({ readStream: assigned } = store);
const { appendToStream, ...reader } = store;
const { readStream: renamed } = store;
const { readStream = fallback } = store;
const { store: { readStream: nested } } = holder;
const { ["readStream"]: computed } = store;
function parameter({ readStream: parameterRead }: EventStore) { return parameterRead; }
for (const { readStream: iteratedRead } of stores) void iteratedRead;
type ReadPosition = EventStore["readStream"];
type ReadQuery = typeof store.readStream;
const implementation: EventStore = {
  appendToStream: async () => [],
  readStream: async () => [],
  readAll: async () => [],
};
void projected; void sameLineA; void sameLineB; void computedProjection; void literalAliasProjection; void unionWithProjection;
void unionWithoutProjection; void dynamicProjection; void twinProjection; void unrelatedProjection;
void mixedProjection; void absentProjection; void dynamicTwinProjection; void destructured; void assigned; void reader;
void renamed; void readStream; void nested; void computed; void parameter; void implementation;
`,
  };
}

function logicalArgumentFixture() {
  return {
    ...baseFixture(),
    "packages/logical.ts": `
import type { EventStore } from "../contracts/event-core/event-store";
declare const store: EventStore;
declare function pick(...values: readonly unknown[]): unknown;
declare const typedPick: (...values: readonly unknown[]) => unknown;
declare const kUnionWith: "readStream" | "readAll";
declare const opaqueTail: readonly unknown[];
declare class Extract { constructor(...values: readonly unknown[]); }
pick(store, "readStream");
pick(store, "readAll");
pick(...([store, "readStream"] as const));
const sharedArgs = [store, "readStream"] as const;
pick(...sharedArgs); pick(...sharedArgs);
Reflect.get.apply(Reflect, [store, "readStream"]);
typedPick.apply(undefined, [store, "readStream"]);
typedPick.call(undefined, store, "readStream");
typedPick.call(...([, store, "readStream"] as const));
typedPick.call.call(undefined, undefined, store, "readStream");
new Extract(store, "readStream");
pick([store, "readStream"] as const);
let mutableArgs = [store, "readStream"];
pick(...mutableArgs);
const opaqueHolder = { values: [store, "readStream"] } as const;
typedPick.apply(...([, opaqueHolder, [store, "readStream"]] as const));
pick(store, kUnionWith);
typedPick.apply(undefined, [store, "readStream", ...opaqueTail]);
`,
  };
}

function adapterCardinalityFixture() {
  return {
    ...baseFixture(),
    "packages/adapters.ts": `
import type { EventStore } from "../contracts/event-core/event-store";
declare const store: EventStore;
declare const target: (...values: readonly unknown[]) => unknown;
declare const kCall: "call";
declare const kDuplicateCall: "call" | "call";
declare const kApply: "apply";
declare const kCallApply: "call" | "apply";
declare const kCallOther: "call" | "toString";
declare const kApplyOther: "apply" | "toString";
declare const prefix: "ca" | "ap";
declare const dynamicKey: string;
export function singletonCall() { target[kCall](store, "readStream"); }
export function singletonTemplateCall() { target[\`call\`](store, "readStream"); }
export function singletonConcatCall() { target["ca" + "ll"](store, "readStream"); }
export function duplicateSingletonCall() { target[kDuplicateCall](store, "readStream"); }
export function singletonApply() { target[kApply](undefined, [store, "readStream"]); }
export function multiCallApplyOrdinary() { target[kCallApply](store, "readStream"); }
export function multiCallOtherOrdinary() { target[kCallOther](store, "readStream"); }
export function multiApplyOtherOrdinary() { target[kApplyOther](store, "readStream"); }
export function multiConcatOrdinary() { target[prefix + "ll"](store, "readStream"); }
export function dynamicOrdinary() { target[dynamicKey](store, "readStream"); }
export function multiCallApplyPacked() { target[kCallApply](undefined, [store, "readStream"]); }
export function multiApplyOtherPacked() { target[kApplyOther](undefined, [store, "readStream"]); }
export function dynamicPacked() { target[dynamicKey](undefined, [store, "readStream"]); }
export function unsanctionedTerminatesRecursion() { target.call[kCallApply](undefined, store, "readStream"); }
export function nestedSanctioned() { target.call.call(undefined, undefined, store, "readStream"); }
`,
  };
}

function localAdapterFixture() {
  return {
    ...baseFixture(),
    "packages/local.ts": `
import type { EventStore } from "../contracts/event-core/event-store";
declare const store: EventStore;
declare const local: { call(...values: readonly unknown[]): unknown; apply(...values: readonly unknown[]): unknown };
declare const bare: Function;
export function localCall() { local.call(store, "readStream"); }
export function localApply() { local.apply(undefined, [store, "readStream"]); }
export function functionCall() { bare.call(store, "readStream"); }
`,
  };
}

function mixedAdapterFixture() {
  return {
    ...baseFixture(),
    "packages/mixed.ts": `
import type { EventStore } from "../contracts/event-core/event-store";
declare global { interface CallableFunction { call(thisArg: unknown, a: unknown, b: unknown): void; } }
declare const store: EventStore;
declare const target: (...values: readonly unknown[]) => unknown;
export function mixedCall() { target.call(store, "readStream"); }
export {};
`,
  };
}

function opaqueAggregateFixture() {
  const header = `
import type { EventStore } from "../contracts/event-core/event-store";
declare const store: EventStore;
declare function pick(...values: readonly unknown[]): unknown;
`;
  return {
    ...baseFixture(),
    "packages/opaque-mutable.ts": `${header}
let args = [store, "readStream"];
pick(...args);
`,
    "packages/opaque-multiple.ts": `${header}
var args = [store, "readStream"] as const;
var args: readonly unknown[];
pick(...args);
`,
    "packages/opaque-later.ts": `${header}
pick(...args);
const args = [store, "readStream"] as const;
`,
    "packages/cross-source.ts": `${header}
export const crossArgs = [store, "readStream"] as const;
`,
    "packages/opaque-cross-file.ts": `${header}
import { crossArgs } from "./cross-source";
pick(...crossArgs);
`,
    "packages/opaque-cycle.ts": `${header}
const args: readonly unknown[] = [...args];
pick(...args);
`,
    "packages/opaque-nonliteral.ts": `${header}
declare function makeArgs(): readonly [EventStore, "readStream"];
const args = makeArgs();
pick(...args);
`,
    "packages/opaque-nontuple.ts": `${header}
const args = { values: [store, "readStream"] } as const;
pick(...(args as unknown as readonly unknown[]));
`,
    "packages/opaque-dynamic-spread.ts": `${header}
declare const dynamic: readonly unknown[];
const args = ["readStream", ...dynamic] as const;
pick(...args);
`,
  };
}

function diagnosticTexts(result) {
  return result.diagnostics.map((entry) => [entry.file, entry.node.getText(entry.sourceFile), entry.outcome]);
}

function diagnosticsByFunction(result, file) {
  const functions = new Map();
  for (const declaration of functionDeclarations(result, file)) {
    functions.set(
      declaration.name.text,
      result.diagnostics.filter((entry) => containsNode(declaration, entry.node)).length,
    );
  }
  return functions;
}

function functionDeclarations(result, file) {
  const sourceFile = result.program.getSourceFile(path.join(result.repoRoot, ...file.split("/")));
  return sourceFile.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name);
}

function functionDeclaration(result, file, name) {
  return functionDeclarations(result, file).find((declaration) => declaration.name.text === name);
}

function containsNode(container, node) {
  return container.pos <= node.pos && node.end <= container.end;
}

function fragmentNodesWithin(result, declaration) {
  const fragments = [];
  visit(declaration, (node) => {
    if (result.diagnostics.some((entry) => entry.node === node)) fragments.push(node.getText());
  });
  return fragments;
}

function sourceNode(result, file, text, containingText) {
  const sourceFile = result.program.getSourceFile(path.join(result.repoRoot, ...file.split("/")));
  let match;
  visit(sourceFile, (node) => {
    if (node.getText(sourceFile) !== text) return;
    for (let current = node.parent; current && current !== sourceFile; current = current.parent) {
      if (current.getText(sourceFile).includes(containingText)) {
        match = node;
        return;
      }
    }
  });
  return match;
}

function deriveGreenGrammarInstances(result) {
  const instances = [];
  const rootSet = new Set(result.roots);
  for (const sourceFile of result.program.getSourceFiles()) {
    const file = normalize(path.relative(result.repoRoot, sourceFile.fileName));
    if (!rootSet.has(file)) continue;
    visit(sourceFile, (node) => {
      if (isReadStreamMemberDeclaration(node)) add("member-declaration", node, sourceFile, file);
      if (
        ts.isLiteralTypeNode(node) &&
        ts.isStringLiteral(node.literal) &&
        node.literal.text === "readStream" &&
        enclosing(node, ts.isIndexedAccessTypeNode)
      ) {
        add("type-position", node.literal, sourceFile, file);
      }
      if (ts.isTypeQueryNode(node) && node.exprName.getText(sourceFile).endsWith(".readStream")) {
        add("type-position", node, sourceFile, file);
      }
    });
  }
  return instances;

  function add(category, node, sourceFile, file) {
    const sourceStart = node.getStart(sourceFile);
    instances.push({ category, node, file, line: sourceFile.getLineAndCharacterOfPosition(sourceStart).line + 1 });
  }
}

function isReadStreamMemberDeclaration(node) {
  if (
    !ts.isPropertySignature(node) &&
    !ts.isMethodSignature(node) &&
    !ts.isPropertyDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isPropertyAssignment(node)
  ) {
    return false;
  }
  return node.name && propertyNameText(node.name) === "readStream";
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

function enclosing(node, predicate) {
  for (let current = node.parent; current; current = current.parent) if (predicate(current)) return current;
  return undefined;
}

function visit(root, callback) {
  const walk = (node) => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
