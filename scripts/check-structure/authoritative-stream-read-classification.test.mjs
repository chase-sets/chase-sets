import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import * as classification from "./authoritative-stream-read-classification.mjs";

const resultKeys = ["anchors", "candidates", "checker", "diagnostics", "program", "repoRoot", "roots", "totals", "ts"];
const candidateKeys = [
  "admitted",
  "callNode",
  "declarations",
  "file",
  "line",
  "memberOrigin",
  "outcome",
  "receiverWidth",
  "sourceFile",
  "sourceStart",
];
const diagnosticKeys = ["file", "line", "node", "outcome", "sourceFile", "sourceStart"];

const production = classification.analyzeAuthoritativeStreamReads({ repoRoot });
const approvedStandaloneRoot = "bounded-contexts/inventory/features/inventory-items/ui/offline-sale-form.tsx";
const excludedStandaloneTestRoot = "bounded-contexts/inventory/features/inventory-items/ui/offline-sale-form.test.tsx";

describe("authoritative-stream-read-classification-acceptance-control", () => {
  it("loads the exact tracked Program corpus and reports the anchor-tree classification", () => {
    expect(ts.version).toBe("6.0.3");
    expect(production.roots).toHaveLength(2_916);
    expect(production.roots.filter((root) => root.endsWith("/offline-sale-form.tsx"))).toEqual([
      approvedStandaloneRoot,
    ]);
    expect(production.roots).not.toContain(excludedStandaloneTestRoot);
    expect(production.totals).toMatchObject({
      roots: 2_916,
      loadedRoots: 2_916,
      extensionCounts: {
        ".ts": 2_279,
        ".tsx": 616,
        ".mts": 7,
        ".cts": 0,
        ".js": 0,
        ".jsx": 0,
        ".mjs": 14,
        ".cjs": 0,
      },
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
    expect(production.candidates.map(({ file, outcome }) => [file, outcome])).toEqual([
      ["bounded-contexts/auth/support/request-support/csat-outcome-facts.ts", "CANONICAL"],
      [
        "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts",
        "CANONICAL",
      ],
      [
        "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts",
        "CANONICAL",
      ],
      ["bounded-contexts/discovery/support/request-support/csat-outcome-facts.ts", "CANONICAL"],
      ["bounded-contexts/identity/api.ts", "CANONICAL"],
      ["bounded-contexts/identity/support/request-support/csat-outcome-facts.ts", "CANONICAL"],
      ["contracts/event-core/complete-stream.ts", "HELPER"],
      ["infrastructure/bounded-context-runtime/subscriptions.ts", "CANONICAL"],
    ]);
    expect(production.anchors.canonicalDeclarations).toEqual(["contracts/event-core/event-store.ts:73"]);
    expect(production.anchors.helperDeclarations).toEqual(["contracts/event-core/complete-stream.ts:5"]);
    expect(production.program.getCompilerOptions()).toMatchObject({
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    });
    expect(
      production.program
        .getRootFileNames()
        .map((file) => normalize(path.relative(repoRoot, file)))
        .sort(),
    ).toEqual([...production.roots].sort());
  });

  it("freezes the five exports, nine result keys, candidate schema, and reserved diagnostics transport", () => {
    expect(Object.keys(classification).sort()).toEqual([
      "analyzeAuthoritativeStreamReads",
      "createClassificationProgram",
      "enumerateTrackedRoots",
      "resolveClassificationAnchors",
      "withTemporaryCorpus",
    ]);
    expect(Object.keys(production).sort()).toEqual(resultKeys);
    expect(production.diagnostics).toEqual([]);
    expect(Object.keys(production.candidates[0]).sort()).toEqual(candidateKeys);
    expect(diagnosticKeys).toEqual(["file", "line", "node", "outcome", "sourceFile", "sourceStart"]);
    expect(
      production.candidates.every((candidate) => candidate.sourceFile === candidate.callNode.getSourceFile()),
    ).toBe(true);
    expect(production.candidates).toEqual(
      [...production.candidates].sort(
        (left, right) => left.file.localeCompare(right.file) || left.sourceStart - right.sourceStart,
      ),
    );
  });

  it("uses the sanctioned compiler facade once and leaves forbidden integration surfaces untouched", () => {
    const source = readFileSync(
      path.join(repoRoot, "scripts/check-structure/authoritative-stream-read-classification.mjs"),
      "utf8",
    );
    expect(source.match(/ts\.createProgram\s*\(/g)).toHaveLength(1);
    expect(source).toContain('from "@chase-sets/typescript-compiler-api"');
    expect(source).not.toMatch(/from\s+["']typescript["']/);
    const changed = execFileSync("git", ["diff", "--name-only", "origin/main", "--"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(changed).not.toEqual(
      expect.arrayContaining([
        "package.json",
        "scripts/check-structure/run.mjs",
        "scripts/lib/heavy-slot.mjs",
        "scripts/verify-static-surfaces.mjs",
        "scripts/verify-static-scoped.mjs",
        "tsconfig.json",
        "tsconfig.base.json",
      ]),
    );
  });

  it("fails closed on a dropped root, corrupt config, and option diagnostics", async () => {
    await classification.withTemporaryCorpus(baseFixture(), async (temporaryRoot) => {
      const roots = classification.enumerateTrackedRoots(temporaryRoot);
      expect(() => classification.createClassificationProgram(temporaryRoot, roots.slice(1))).toThrow(
        /construction roots differ/,
      );
    });
    await classification.withTemporaryCorpus(
      { ...baseFixture(), "tsconfig.json": "{ invalid json" },
      async (temporaryRoot) => {
        expect(() => classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot })).toThrow();
      },
    );
    await classification.withTemporaryCorpus(
      {
        ...baseFixture(),
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, isolatedDeclarations: true, noEmit: true },
          include: ["**/*"],
        }),
      },
      async (temporaryRoot) => {
        expect(() => classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot })).toThrow();
      },
    );
  });

  it("derives roots from tracked files and catches an arbitrary-path candidate", async () => {
    await classification.withTemporaryCorpus(
      {
        ...baseFixture(),
        "packages/arbitrary/opaque-name.ts": fixtureModule(`
export async function arbitrary(store: Pick<EventStore, "readStream">) {
  return store.readStream(input);
}`),
        "packages/arbitrary/ignored.test.ts": fixtureModule(`void store.readStream(input);`),
      },
      async (temporaryRoot) => {
        const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
        expect(result.roots).toContain("packages/arbitrary/opaque-name.ts");
        expect(result.roots).not.toContain("packages/arbitrary/ignored.test.ts");
        expect(result.anchors.canonicalDeclarations).not.toEqual(["contracts/event-core/event-store.ts:73"]);
        expect(candidate(result, "packages/arbitrary/opaque-name.ts", "store.readStream(input)")).toMatchObject({
          outcome: "INSUFFICIENT_RECEIVER_CONTRACT",
          admitted: false,
          receiverWidth: false,
        });
      },
    );
  });

  it("contains temporary corpus seeds inside the disposable repository", async () => {
    await expect(
      classification.withTemporaryCorpus({ "../escape.ts": "export {};" }, async () => undefined),
    ).rejects.toThrow(/escapes its repository/);
  });
});

describe("TypeScript 6.0.3 computed-key authority", () => {
  let computed;

  beforeAll(async () => {
    computed = await classification.withTemporaryCorpus(computedKeyFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      return { result, diagnostics: semanticDiagnostics(result) };
    });
  });

  it("executes the seven-row receiver-owned matrix with exact TS7053 authority", () => {
    expect(ts.version).toBe("6.0.3");
    expect(computed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([7053, 7053, 7053, 7053, 7053, 7053]);

    const expected = [
      ["packages/cases/literal.ts", "store[k](input)", "CANONICAL", true, true],
      ["packages/cases/concat.ts", 'store["read" + "Stream"](input)', "CANONICAL", true, true],
      ["packages/cases/dynamic-canonical.ts", "store[k](input)", "CANONICAL_RECEIVER_DYNAMIC_KEY", false, null],
      ["contracts/event-core/complete-stream.ts", "reader[k](input)", "CANONICAL_RECEIVER_DYNAMIC_KEY", false, null],
      ["packages/cases/dynamic-twin.ts", "twin[k](input)", "TWIN", false, null],
      ["packages/cases/dynamic-unrelated.ts", "unrelated[k](input)", "UNRELATED", false, null],
      ["packages/cases/dynamic-mixed.ts", "store[k](input)", "AMBIGUOUS_MEMBER_ORIGIN", false, null],
    ];
    for (const [file, text, outcome, admitted, receiverWidth] of expected) {
      const target = candidate(computed.result, file, text);
      expect(target).toMatchObject({ outcome, admitted, receiverWidth });
      expect(target.callNode.getText(target.sourceFile)).toBe(text);
      const receiver = target.callNode.expression.expression;
      const receiverType = computed.result.checker.getTypeAtLocation(receiver);
      expect(receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)).toBe(0);
    }
    const diagnosticLocations = computed.diagnostics.map(
      (diagnostic) =>
        `${normalize(path.relative(computed.result.repoRoot, diagnostic.file.fileName))}:${
          diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        }`,
    );
    const permittedTargets = expected
      .slice(1)
      .map(([file, text]) => candidate(computed.result, file, text))
      .map((target) => `${target.file}:${target.line}`)
      .sort();
    expect(diagnosticLocations.sort()).toEqual(permittedTargets);
    for (const file of [
      "packages/cases/literal.ts",
      "packages/cases/concat.ts",
      "packages/cases/dynamic-canonical.ts",
      "contracts/event-core/complete-stream.ts",
      "packages/cases/dynamic-twin.ts",
      "packages/cases/dynamic-unrelated.ts",
      "packages/cases/dynamic-mixed.ts",
    ]) {
      expect(computed.result.candidates.filter((entry) => entry.file === file)[1].callNode.getText()).toContain("[");
    }
  });

  it("cross-binds TWIN and UNRELATED declarations and includes dynamic foreign and mixed candidates", () => {
    const twin = candidate(computed.result, "packages/cases/dynamic-twin.ts", "twin[k](input)");
    const unrelated = candidate(computed.result, "packages/cases/dynamic-unrelated.ts", "unrelated[k](input)");
    expect(twin.declarations).toHaveLength(1);
    expect(unrelated.declarations).toHaveLength(1);
    expect(twin.declarations[0]).not.toBe(unrelated.declarations[0]);
    expect(twin.declarations).not.toContain(unrelated.declarations[0]);
    expect(unrelated.declarations).not.toContain(twin.declarations[0]);
    expect(candidate(computed.result, "packages/cases/dynamic-mixed.ts", "store[k](input)").declarations).toEqual(
      expect.arrayContaining([
        computed.result.anchors.canonicalDeclarations[0],
        expect.stringContaining("packages/cases/dynamic-mixed.ts:"),
      ]),
    );
  });

  it("reproduces the rejected argument-symbol and element-symbol authority sources", () => {
    const literal = candidate(computed.result, "packages/cases/literal.ts", "store[k](input)");
    const element = literal.callNode.expression;
    const keySymbol = computed.result.checker.getSymbolAtLocation(element.argumentExpression);
    expect(keySymbol.declarations).toHaveLength(1);
    expect(keySymbol.declarations[0].getText()).toContain('k = "readStream"');
    expect(computed.result.checker.getSymbolAtLocation(element)).toBeUndefined();
    expect(literal.declarations).toEqual(computed.result.anchors.canonicalDeclarations);
  });

  it("proves the canonical/static versus authority-absent/dynamic negative boundary", async () => {
    await classification.withTemporaryCorpus(authorityBoundaryFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      expect(candidate(result, "packages/boundary.ts", "canonical[kLiteral](input)")).toMatchObject({
        outcome: "CANONICAL",
        admitted: true,
      });
      expect(candidate(result, "packages/boundary.ts", "untyped[kLiteral](input)")).toMatchObject({
        outcome: "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE",
        admitted: false,
        declarations: [],
      });
      expect(candidate(result, "packages/boundary.ts", "canonical[kDynamic](input)")).toMatchObject({
        outcome: "CANONICAL_RECEIVER_DYNAMIC_KEY",
        admitted: false,
      });
      expect(result.candidates.some((entry) => entry.callNode.getText() === "untyped[kDynamic](input)")).toBe(false);
    });
  });

  it("excludes statically known foreign keys before inclusion without shifting siblings", () => {
    const file = "packages/cases/static-key.ts";
    const calls = computed.result.candidates
      .filter((entry) => entry.file === file)
      .map((entry) => entry.callNode.getText());
    expect(calls).toEqual(["store.readStream(input)", 'store["readStream"](input)', "store.readStream(input)"]);
    expect(calls).not.toContain('store["readAll"]()');
    expect(calls).not.toContain('store["appendToStream"](input)');
  });
});

describe("origin totality, width, and optional syntax", () => {
  it("derives every non-uniform origin subset across union, intersection, and constrained shapes", async () => {
    const categories = ["C", "H", "T", "U"];
    const subsets = nonEmptySubsets(categories);
    const uniformIds = ["C", "H", "T", "U", "TU"];
    const uniform = subsets.filter((subset) => uniformIds.includes(subset.join("")));
    const nonUniform = subsets.filter((subset) => !uniformIds.includes(subset.join("")));
    expect(nonUniform.map((subset) => subset.join(""))).toEqual([
      "CH",
      "CT",
      "CU",
      "HT",
      "HU",
      "CHT",
      "CHU",
      "CTU",
      "HTU",
      "CHTU",
    ]);
    expect(nonUniform).toHaveLength(10);

    await classification.withTemporaryCorpus(originMatrixFixture(nonUniform, uniform), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      const candidates = result.candidates.filter((entry) => entry.file === "packages/origin-matrix.ts");
      const matrix = candidates
        .filter((entry) => enclosing(entry.callNode, ts.isFunctionDeclaration).name.text !== undefined)
        .filter((entry) => !enclosing(entry.callNode, ts.isFunctionDeclaration).name.text.startsWith("uniform_"));
      expect(matrix).toHaveLength(30);
      expect(new Set(matrix.map((entry) => entry.outcome))).toEqual(new Set(["AMBIGUOUS_MEMBER_ORIGIN"]));
      expect(matrix.every((entry) => !entry.admitted)).toBe(true);
      expect(matrix.every((entry) => entry.declarations.length >= 2)).toBe(true);
      const uniformOutcomes = outcomesByFunction(result, "packages/origin-matrix.ts");
      expect(uniformOutcomes.get("uniform_C")).toMatchObject({ outcome: "CANONICAL", admitted: true });
      expect(uniformOutcomes.get("uniform_H")).toMatchObject({ outcome: "INDETERMINATE", admitted: false });
      expect(uniformOutcomes.get("uniform_T")).toMatchObject({ outcome: "TWIN", admitted: false });
      expect(uniformOutcomes.get("uniform_U")).toMatchObject({ outcome: "UNRELATED", admitted: false });
      expect(uniformOutcomes.get("uniform_TU")).toMatchObject({ outcome: "TWIN", admitted: false });
    });
  });

  it("keeps receiver width independent and recursive through constraints and unions", async () => {
    await classification.withTemporaryCorpus(widthFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      const outcomes = outcomesByFunction(result, "packages/width.ts");
      for (const name of [
        "direct",
        "alias",
        "canonicalAliases",
        "readonly",
        "generic",
        "intersection",
        "copy",
        "spread",
        "factory",
      ])
        expect(outcomes.get(name)).toMatchObject({ outcome: "CANONICAL", receiverWidth: true, admitted: true });
      for (const name of [
        "pick",
        "requiredPick",
        "partialNarrowed",
        "partialPick",
        "mappedMissing",
        "genericPick",
        "genericRequired",
        "genericPartial",
        "narrowUnion",
        "genericNarrowUnion",
      ])
        expect(outcomes.get(name)).toMatchObject({
          outcome: "INSUFFICIENT_RECEIVER_CONTRACT",
          receiverWidth: false,
          admitted: false,
        });
      expect(outcomes.get("mixedUnion")).toMatchObject({ outcome: "AMBIGUOUS_MEMBER_ORIGIN", admitted: false });
      expect(outcomes.get("optionalUnion")).toMatchObject({
        outcome: "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE",
        admitted: false,
      });
      expect(outcomes.get("narrowedOptional")).toMatchObject({ outcome: "CANONICAL", admitted: true });
    });
  });

  it("orders optional syntax after every receiver-origin arm and before admission", async () => {
    await classification.withTemporaryCorpus(optionalFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      const outcomes = outcomesByFunction(result, "packages/optional.ts");
      for (const name of ["propertyOptional", "callOptional", "elementOptional", "elementCallOptional", "canonical"])
        expect(outcomes.get(name)).toMatchObject({ outcome: "CANONICAL_VALUE_ESCAPE", admitted: false });
      expect(outcomes.get("authorityAbsent").outcome).toBe("AUTHORITY_ABSENT_READ_STREAM_CANDIDATE");
      expect(outcomes.get("twin").outcome).toBe("TWIN");
      expect(outcomes.get("unrelated").outcome).toBe("UNRELATED");
      expect(outcomes.get("mixed").outcome).toBe("AMBIGUOUS_MEMBER_ORIGIN");
      expect(outcomes.get("dynamic").outcome).toBe("CANONICAL_RECEIVER_DYNAMIC_KEY");
      expect(outcomes.get("optionalUnion").outcome).toBe("AUTHORITY_ABSENT_READ_STREAM_CANDIDATE");
      expect(outcomes.get("narrowed")).toMatchObject({ outcome: "CANONICAL", admitted: true });
      const helper = outcomesByFunction(result, "contracts/event-core/complete-stream.ts").get("helperOptional");
      expect(helper).toMatchObject({ outcome: "CANONICAL_VALUE_ESCAPE", memberOrigin: "HELPER", admitted: false });
    });
  });

  it("classifies helper authority by exact source location before width", async () => {
    await classification.withTemporaryCorpus(helperLocationFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      expect(outcomesByFunction(result, "contracts/event-core/complete-stream.ts").get("inside")).toMatchObject({
        outcome: "HELPER",
        admitted: true,
      });
      expect(outcomesByFunction(result, "packages/helper-outside.ts").get("outside")).toMatchObject({
        outcome: "INDETERMINATE",
        memberOrigin: "HELPER",
        admitted: false,
      });
    });
  });
});

describe("authority absence, ordering, and consumer seam", () => {
  it("reaches authority absence across every admitted JavaScript extension and semantic absence shape", async () => {
    await classification.withTemporaryCorpus(authorityAbsentFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      for (const extension of ["js", "jsx", "mjs", "cjs"]) {
        expect(result.candidates.find((entry) => entry.file === `packages/absence.${extension}`)).toMatchObject({
          outcome: "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE",
          admitted: false,
        });
      }
      const outcomes = outcomesByFunction(result, "packages/authority.ts");
      expect(outcomes.get("anyReceiver").outcome).toBe("AUTHORITY_ABSENT_READ_STREAM_CANDIDATE");
      expect(outcomes.get("unknownReceiver").outcome).toBe("AUTHORITY_ABSENT_READ_STREAM_CANDIDATE");
      expect(outcomes.get("errorReceiver").outcome).toBe("AUTHORITY_ABSENT_READ_STREAM_CANDIDATE");
      expect(outcomes.get("unrelated").outcome).toBe("UNRELATED");
      expect(outcomes.get("twin").outcome).toBe("TWIN");
    });
  });

  it("exports every non-admitted candidate in source order with call-owned lines", async () => {
    await classification.withTemporaryCorpus(orderingFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      const fileCandidates = result.candidates.filter((entry) => entry.file === "packages/ordered.ts");
      expect(fileCandidates.map((entry) => entry.outcome)).toEqual([
        "CANONICAL",
        "TWIN",
        "AMBIGUOUS_MEMBER_ORIGIN",
        "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE",
        "CANONICAL",
      ]);
      expect(fileCandidates.map((entry) => entry.sourceStart)).toEqual(
        [...fileCandidates.map((entry) => entry.sourceStart)].sort((left, right) => left - right),
      );
      for (const entry of fileCandidates) {
        expect(entry.line).toBe(
          entry.sourceFile.getLineAndCharacterOfPosition(entry.callNode.getStart(entry.sourceFile)).line + 1,
        );
      }
    });
  });

  it("supports symbol-identity consumers entirely through the returned result", async () => {
    await classification.withTemporaryCorpus(consumerFixture(), async (temporaryRoot) => {
      const result = classification.analyzeAuthoritativeStreamReads({ repoRoot: temporaryRoot });
      const target = candidate(result, "packages/consumer.ts", "store.readStream(input)");
      const declaration = enclosing(target.callNode, ts.isVariableDeclaration);
      const resultSymbol = result.checker.getSymbolAtLocation(declaration.name);
      const uses = [];
      visit(target.sourceFile, (node) => {
        if (ts.isIdentifier(node) && result.checker.getSymbolAtLocation(node) === resultSymbol) uses.push(node);
      });
      expect(uses.map((node) => node.text)).toEqual(["R", "R", "R"]);

      let importedHelper;
      visit(target.sourceFile, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "inspectResult") {
          importedHelper = result.checker.getSymbolAtLocation(node.expression);
        }
      });
      const resolved = result.checker.getAliasedSymbol(importedHelper);
      expect(
        resolved.declarations.map(
          (node) => `${normalize(path.relative(temporaryRoot, node.getSourceFile().fileName))}:${line(node)}`,
        ),
      ).toEqual(["packages/helper.ts:1"]);
      expect(Object.keys(result).sort()).toEqual(resultKeys);
      expect(Object.keys(target).sort()).toEqual(candidateKeys);
    });
  });
});

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

function fixtureModule(body, eventStoreImport = "../../contracts/event-core/event-store") {
  return `
import type { EventStore, ReadStreamInput } from "${eventStoreImport}";
declare const input: ReadStreamInput;
declare const store: EventStore;
${body}
`;
}

function computedKeyFixture() {
  return {
    ...baseFixture(),
    "packages/cases/literal.ts": fixtureModule(`
export async function before(store: EventStore) { return store.readStream(input); }
export async function target(store: EventStore) { const k = "readStream" as const; return store[k](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "packages/cases/concat.ts": fixtureModule(`
export async function before(store: EventStore) { return store.readStream(input); }
export async function target(store: EventStore) { return store["read" + "Stream"](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "packages/cases/dynamic-canonical.ts": fixtureModule(`
export async function before(store: EventStore) { return store.readStream(input); }
export async function target(store: EventStore, k: string) { return store[k](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "contracts/event-core/complete-stream.ts": `
import type { EventStore, ReadStreamInput } from "./event-store";
export type CompleteStreamReader = Readonly<{ readStream: EventStore["readStream"] }>;
declare const input: ReadStreamInput;
export async function before(reader: CompleteStreamReader) { return reader.readStream(input); }
export async function target(reader: CompleteStreamReader, k: string) { return reader[k](input); }
export async function after(reader: CompleteStreamReader) { return reader.readStream(input); }
`,
    "packages/cases/dynamic-twin.ts": fixtureModule(`
type Twin = {
  appendToStream: EventStore["appendToStream"];
  readStream: EventStore["readStream"];
};
export async function before(store: EventStore) { return store.readStream(input); }
export async function twinTarget(twin: Twin, k: string) { return twin[k](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "packages/cases/dynamic-unrelated.ts": fixtureModule(`
type Unrelated = { readStream: (input: ReadStreamInput) => Promise<string> };
export async function before(store: EventStore) { return store.readStream(input); }
export async function unrelatedTarget(unrelated: Unrelated, k: string) { return unrelated[k](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "packages/cases/dynamic-mixed.ts": fixtureModule(`
type Twin = { readStream: EventStore["readStream"] };
export async function before(store: EventStore) { return store.readStream(input); }
export async function target(store: EventStore | Twin, k: string) { return store[k](input); }
export async function after(store: EventStore) { return store.readStream(input); }`),
    "packages/cases/static-key.ts": fixtureModule(`
export async function target(store: EventStore) {
  await store.readStream(input);
  await store["readStream"](input);
  await store["readAll"]();
  await store["appendToStream"]({ streamId: "x" });
  await store.readStream(input);
}`),
  };
}

function authorityBoundaryFixture() {
  return {
    ...baseFixture(),
    "packages/boundary.ts": fixtureModule(
      `
export async function target(canonical: EventStore, untyped: any, kDynamic: string) {
  const kLiteral = "readStream" as const;
  await canonical[kLiteral](input);
  await untyped[kLiteral](input);
  await canonical[kDynamic](input);
  await untyped[kDynamic](input);
}`,
      "../contracts/event-core/event-store",
    ),
  };
}

function originMatrixFixture(nonUniformSubsets, uniformSubsets) {
  const definitions = `
type C = EventStore;
type H = import("../contracts/event-core/complete-stream").CompleteStreamReader;
type T = { readStream: EventStore["readStream"] };
type U = { readStream: (input: ReadStreamInput) => Promise<string> };
`;
  const functions = nonUniformSubsets.flatMap((subset) => {
    const id = subset.join("");
    const union = subset.join(" | ");
    const intersection = subset.join(" & ");
    return [
      `export async function union_${id}(store: ${union}) { return store.readStream(input as never); }`,
      `export async function intersection_${id}(store: ${intersection}) { return store.readStream(input as never); }`,
      `export async function constrained_${id}<X extends ${union}>(store: X) { return store.readStream(input as never); }`,
    ];
  });
  const uniformFunctions = uniformSubsets.map((subset) => {
    const id = subset.join("");
    return `export async function uniform_${id}(store: ${subset.join(" | ")}) { return store.readStream(input as never); }`;
  });
  return {
    ...baseFixture(),
    "packages/origin-matrix.ts": fixtureModule(
      `${definitions}\n${functions.join("\n")}\n${uniformFunctions.join("\n")}`,
      "../contracts/event-core/event-store",
    ),
  };
}

function widthFixture() {
  return {
    ...baseFixture(),
    "packages/width.ts": fixtureModule(
      `
type Alias = EventStore;
type AliasTwo = EventStore;
type Twin = {
  appendToStream: EventStore["appendToStream"];
  readStream: EventStore["readStream"];
};
type Missing = { [K in keyof EventStore as Exclude<K, "readAll">]: EventStore[K] };
declare function copy<T>(value: T): T;
declare function factory(): EventStore;
export async function direct(value: EventStore) { return value.readStream(input); }
export async function alias(value: Alias) { return value.readStream(input); }
export async function canonicalAliases(value: Alias | AliasTwo) { return value.readStream(input); }
export async function readonly(value: Readonly<EventStore>) { return value.readStream(input); }
export async function generic<T extends EventStore>(value: T) { return value.readStream(input); }
export async function intersection(value: EventStore & { extra: string }) { return value.readStream(input); }
export async function copyValue(value: EventStore) { return copy(value).readStream(input); }
export async function spread(value: EventStore) { return ({ ...value }).readStream(input); }
export async function factoryValue() { return factory().readStream(input); }
export async function pick(value: Pick<EventStore, "readStream">) { return value.readStream(input); }
export async function requiredPick(value: Required<Pick<EventStore, "readStream">>) { return value.readStream(input); }
export async function partialNarrowed(value: Partial<EventStore>) { if (value.readStream) return value.readStream(input); }
export async function partialPick(value: Partial<Pick<EventStore, "readStream">>) { if (value.readStream) return value.readStream(input); }
export async function mappedMissing(value: Missing) { return value.readStream(input); }
export async function genericPick<T extends Pick<EventStore, "readStream">>(value: T) { return value.readStream(input); }
export async function genericRequired<T extends Required<Pick<EventStore, "readStream">>>(value: T) { return value.readStream(input); }
export async function genericPartial<T extends Partial<EventStore>>(value: T) { if (value.readStream) return value.readStream(input); }
export async function narrowUnion(value: EventStore | Pick<EventStore, "readStream">) { return value.readStream(input); }
export async function genericNarrowUnion<T extends EventStore | Pick<EventStore, "readStream">>(value: T) { return value.readStream(input); }
export async function mixedUnion(value: EventStore | Twin) { return value.readStream(input); }
export async function optionalUnion(value: EventStore | undefined) { return value?.readStream(input); }
export async function narrowedOptional(value: EventStore | undefined) { if (value) return value.readStream(input); }
declare const twinValue: Twin;
void pick(twinValue);
void requiredPick(twinValue);
void partialNarrowed(twinValue);
void partialPick(twinValue);
void mappedMissing(twinValue);
void genericPick(twinValue);
void genericRequired(twinValue);
void genericPartial(twinValue);
void narrowUnion(twinValue);
void genericNarrowUnion(twinValue);
`,
      "../contracts/event-core/event-store",
    ),
  };
}

function optionalFixture() {
  return {
    ...baseFixture(),
    "contracts/event-core/complete-stream.ts": `
import type { EventStore, ReadStreamInput } from "./event-store";
export type CompleteStreamReader = Readonly<{ readStream: EventStore["readStream"] }>;
declare const input: ReadStreamInput;
export async function helperOptional(reader: CompleteStreamReader) { return reader.readStream?.(input); }
`,
    "packages/optional.ts": fixtureModule(
      `
type Twin = { readStream: EventStore["readStream"] };
type Unrelated = { readStream: (input: ReadStreamInput) => Promise<string> };
export async function propertyOptional(store: EventStore) { return store?.readStream(input); }
export async function callOptional(store: EventStore) { return store.readStream?.(input); }
export async function elementOptional(store: EventStore) { return store?.["readStream"](input); }
export async function elementCallOptional(store: EventStore) { return store["readStream"]?.(input); }
export async function canonical(store: EventStore) { return store.readStream?.(input); }
export async function authorityAbsent(store: any) { return store.readStream?.(input); }
export async function twin(store: Twin) { return store.readStream?.(input); }
export async function unrelated(store: Unrelated) { return store.readStream?.(input); }
export async function mixed(store: EventStore | Twin) { return store.readStream?.(input); }
export async function dynamic(store: EventStore, k: string) { return store[k]?.(input); }
export async function optionalUnion(store: EventStore | undefined) { return store?.readStream(input); }
export async function narrowed(store: EventStore | undefined) { if (store) return store.readStream(input); }
`,
      "../contracts/event-core/event-store",
    ),
  };
}

function helperLocationFixture() {
  return {
    ...baseFixture(),
    "contracts/event-core/complete-stream.ts": `
import type { EventStore, ReadStreamInput } from "./event-store";
export type CompleteStreamReader = Readonly<{ readStream: EventStore["readStream"] }>;
declare const input: ReadStreamInput;
export async function inside(reader: CompleteStreamReader) { return reader.readStream(input); }
`,
    "packages/helper-outside.ts": `
import type { ReadStreamInput } from "../contracts/event-core/event-store";
import type { CompleteStreamReader } from "../contracts/event-core/complete-stream";
declare const input: ReadStreamInput;
export async function outside(reader: CompleteStreamReader) { return reader.readStream(input); }
`,
  };
}

function authorityAbsentFixture() {
  const javascript = `export async function run(store) { return store.readStream({ streamId: "x" }); }`;
  return {
    ...baseFixture(),
    "packages/absence.js": javascript,
    "packages/absence.jsx": javascript,
    "packages/absence.mjs": javascript,
    "packages/absence.cjs": `exports.run = async function run(store) { return store.readStream({ streamId: "x" }); };`,
    "packages/authority.ts": fixtureModule(
      `
type Twin = { readStream: EventStore["readStream"] };
type Unrelated = { readStream: (input: ReadStreamInput) => Promise<string> };
export async function anyReceiver(value: any) { return value.readStream(input); }
export async function unknownReceiver(value: unknown) { return value.readStream(input); }
export async function errorReceiver(value: MissingType) { return value.readStream(input); }
export async function unrelated(value: Unrelated) { return value.readStream(input); }
export async function twin(value: Twin) { return value.readStream(input); }
`,
      "../contracts/event-core/event-store",
    ),
  };
}

function orderingFixture() {
  return {
    ...baseFixture(),
    "packages/ordered.ts": fixtureModule(
      `
type Twin = { readStream: EventStore["readStream"] };
export async function ordered(canonical: EventStore, twin: Twin, mixed: EventStore | Twin, absent: any) {
  await canonical.readStream(input);
  await twin.readStream(input);
  await mixed.readStream(input);
  // The call owns its line even when metadata is inserted directly above it.
  await absent.readStream(input);
  await canonical.readStream(input);
}`,
      "../contracts/event-core/event-store",
    ),
  };
}

function consumerFixture() {
  return {
    ...baseFixture(),
    "packages/helper.ts": `export function inspectResult(value: unknown) { return value; }`,
    "packages/consumer.ts": `
import type { EventStore, ReadStreamInput } from "../contracts/event-core/event-store";
import { inspectResult } from "./helper";
export async function consume(store: EventStore, input: ReadStreamInput) {
  const R = await store.readStream(input);
  inspectResult(R);
  return R;
}`,
  };
}

function semanticDiagnostics(result) {
  return result.program
    .getSemanticDiagnostics()
    .filter(
      (diagnostic) =>
        diagnostic.file && result.roots.includes(normalize(path.relative(result.repoRoot, diagnostic.file.fileName))),
    )
    .sort(
      (left, right) =>
        normalize(left.file.fileName).localeCompare(normalize(right.file.fileName)) || left.start - right.start,
    );
}

function candidate(result, file, callText) {
  const matches = result.candidates.filter(
    (entry) => entry.file === file && entry.callNode.getText(entry.sourceFile) === callText,
  );
  expect(matches, `${file} ${callText}`).toHaveLength(1);
  return matches[0];
}

function outcomesByFunction(result, file) {
  const outcomes = new Map();
  for (const entry of result.candidates.filter((candidateEntry) => candidateEntry.file === file)) {
    const declaration = enclosing(entry.callNode, ts.isFunctionDeclaration);
    if (declaration?.name) outcomes.set(declaration.name.text.replace("Value", "").replace("copyValue", "copy"), entry);
  }
  return outcomes;
}

function nonEmptySubsets(values) {
  const subsets = [];
  const collect = (size, start, current) => {
    if (current.length === size) {
      subsets.push([...current]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      current.push(values[index]);
      collect(size, index + 1, current);
      current.pop();
    }
  };
  for (let size = 1; size <= values.length; size += 1) collect(size, 0, []);
  return subsets;
}

function enclosing(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
  return undefined;
}

function visit(root, callback) {
  const walk = (node) => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function line(node) {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
