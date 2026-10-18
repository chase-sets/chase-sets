import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";
import {
  buildModuleResolutionContextFixture,
  enumerateCanonicalModuleCandidates,
  resolveModule,
} from "./check-structure/module-resolution.mjs";
import { classifySqlExecutionSurface, listNonTestTypeScriptModules } from "./check-structure/sql-execution-surface.mjs";
import {
  classifyReleaseQualificationScope,
  collectReleaseWorkflowScriptReferences,
  releaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";
import {
  deriveForbiddenEventStoreMembers,
  evaluateReleaseQualificationApplicability,
  RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES,
} from "./release-qualification-scope-applicability.mjs";

const tempRoots = [];
const now = () => 0;
const AC12_PINNED_CANDIDATE = "46834e05bc5d09c0dc98e4525289f8c405e0f786";
const AC12_PINNED_MERGE_BASE = "e579491f2ec47eb9018e260754cb81b2c61196ff";
const AC12_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/release-qualification-ac12/ac12-candidate-sweep-v1.json", import.meta.url), "utf8"),
);

function assertAc12PinnedEvidence(AC12_FIXTURE, candidate, mergeBase) {
  const tree = (sha) => execFileSync("git", ["rev-parse", `${sha}^{tree}`], { encoding: "utf8" }).trim();
  const governed = (sha) =>
    listNonTestTypeScriptModules(process.cwd(), {
      execGit: () => execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]).toString("utf8"),
    });

  if (candidate && mergeBase) {
    expect(tree(candidate)).toBe(AC12_FIXTURE.candidate.treeSha);
    expect(tree(mergeBase)).toBe(AC12_FIXTURE.mergeBase.treeSha);
    expect(execFileSync("git", ["merge-base", candidate, mergeBase], { encoding: "utf8" }).trim()).toBe(mergeBase);
    expect(
      execFileSync("git", ["diff", "--name-only", mergeBase, candidate], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    ).toEqual(AC12_FIXTURE.changedFiles);
    const governedCandidate = governed(candidate);
    expect(governedCandidate).toEqual(governed(mergeBase));
    expect(createHash("sha256").update(JSON.stringify(governedCandidate)).digest("hex")).toBe(
      AC12_FIXTURE.governedModulesSha256,
    );
    return;
  }

  if (!mergeBase) throw new Error(`AC12_PINNED_MERGE_BASE ${AC12_FIXTURE.mergeBase.sha}`);
  expect(tree(mergeBase), `AC12_PINNED_MERGE_BASE_TREE ${AC12_FIXTURE.mergeBase.treeSha}`).toBe(
    AC12_FIXTURE.mergeBase.treeSha,
  );
  expect(AC12_FIXTURE.changedFiles).toEqual([
    "scripts/release-qualification-scope-applicability.mjs",
    "scripts/release-qualification-scope-applicability.test.mjs",
  ]);
  expect(
    createHash("sha256")
      .update(JSON.stringify(governed(mergeBase)))
      .digest("hex"),
    `AC12_GOVERNED_MODULES_DIGEST ${AC12_FIXTURE.governedModulesSha256}`,
  ).toBe(AC12_FIXTURE.governedModulesSha256);
}

function fixture(extra = {}, packages = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-applicability-"));
  tempRoots.push(root);
  const files = {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "infrastructure/event-core-postgres/types.ts":
      "export interface PgQueryable { query(...args: unknown[]): unknown }\nexport interface PgPoolClient extends PgQueryable {}\nexport interface PgTransactionalPool extends PgQueryable {}\n",
    "infrastructure/event-core-postgres/index.ts": 'export * from "./types";\n',
    "contracts/event-core/event-store.ts": readFileSync(
      new URL("../contracts/event-core/event-store.ts", import.meta.url),
      "utf8",
    ),
    "contracts/event-core/complete-stream.ts": readFileSync(
      new URL("../contracts/event-core/complete-stream.ts", import.meta.url),
      "utf8",
    ),
    ...extra,
  };
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  const resolutionContext = buildModuleResolutionContextFixture({
    files: Object.keys(files),
    packages,
  });
  return { root, files, resolutionContext };
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function evaluate(
  root,
  files,
  applicability,
  rootPath = "bounded-contexts/synthetic/domain/root.ts",
  resolutionContext = buildModuleResolutionContextFixture({ files: Object.keys(files), packages: [] }),
) {
  return evaluateReleaseQualificationApplicability({
    repoRoot: root,
    rootPath,
    applicability,
    now,
    files,
    resolutionContext,
  });
}

describe("release qualification applicability evaluator", () => {
  it("returns the closed frozen shape and exact ordered vocabulary", () => {
    const value = evaluateReleaseQualificationApplicability({ applicability: { kind: "unknown" } });
    const walk = (entry) => {
      if (!entry || typeof entry !== "object") return [];
      return [...Reflect.ownKeys(entry), ...Object.values(entry).flatMap((child) => walk(child))];
    };
    expect(Reflect.ownKeys(value)).toEqual(["applies", "withdrawalCodes", "graph"]);
    expect(value.applies).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES)).toBe(true);
    expect(RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES).toEqual([
      "malformed_applicability_metadata",
      "unsupported_applicability_kind",
      "undeclared_graph_node",
      "graph_shape_drift",
      "undeclared_module_specifier",
      "undeclared_external_specifier",
      "binding_mode_drift",
      "persistent_dependency",
      "sql_execution_surface",
      "event_store_member_reference",
      "ambiguous_member_reference_key",
      "event_store_contract_unreadable",
      "unresolvable_module_specifier",
      "module_specifier_escapes_repository",
      "ambiguous_dynamic_import",
      "unparseable_module",
    ]);
    expect(value.withdrawalCodes).toEqual(["unsupported_applicability_kind"]);
    const admitted = fixture({ "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n" });
    const admittedValue = evaluate(
      admitted.root,
      admitted.files,
      { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
      "bounded-contexts/synthetic/domain/root.ts",
      admitted.resolutionContext,
    );
    for (const forbiddenKey of ["class", "reasonCodes", "record"])
      expect(walk(admittedValue)).not.toContain(forbiddenKey);
    expect(
      value.withdrawalCodes.every((code) => RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES.includes(code)),
    ).toBe(true);
  });

  it("admits a recursively closed graph and reports its exact edges", () => {
    const { root, files, resolutionContext } = fixture(
      {
        "bounded-contexts/synthetic/domain/root.ts":
          'import type { WorkspaceType } from "@chase-sets/synthetic/types";\nimport type { LeafType } from "./types";\nexport { value } from "./leaf";\n',
        "bounded-contexts/synthetic/domain/leaf.ts": 'import crypto from "node:crypto"; export const value = crypto;\n',
        "bounded-contexts/synthetic/domain/types.ts": "export type LeafType = string;\n",
        "packages/synthetic/src/types.ts": "export type WorkspaceType = string;\n",
      },
      [["@chase-sets/synthetic", { root: "packages/synthetic", exports: { "./types": "./src/types.ts" } }]],
    );
    const result = evaluate(
      root,
      files,
      {
        kind: "pure-module/v1",
        modules: [
          {
            path: "bounded-contexts/synthetic/domain/root.ts",
            specifiers: [
              { specifier: "@chase-sets/synthetic/types", binding: "type-only" },
              { specifier: "./types", binding: "type-only" },
              { specifier: "./leaf", binding: "value" },
            ],
          },
          {
            path: "bounded-contexts/synthetic/domain/leaf.ts",
            specifiers: [{ specifier: "node:crypto", binding: "value" }],
          },
        ],
      },
      "bounded-contexts/synthetic/domain/root.ts",
      resolutionContext,
    );
    expect(result.applies).toBe(true);
    expect(result.withdrawalCodes).toEqual([]);
    expect(result.graph).toEqual([
      {
        path: "bounded-contexts/synthetic/domain/leaf.ts",
        specifiers: [{ specifier: "node:crypto", binding: "value" }],
      },
      {
        path: "bounded-contexts/synthetic/domain/root.ts",
        specifiers: [
          { specifier: "@chase-sets/synthetic/types", binding: "type-only" },
          { specifier: "./types", binding: "type-only" },
          { specifier: "./leaf", binding: "value" },
        ],
      },
    ]);
    expect(result.graph).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "bounded-contexts/synthetic/domain/types.ts" })]),
    );
  });

  it("withdraws for graph drift, external drift, dynamic imports and forbidden members", () => {
    const { root, files } = fixture({
      "bounded-contexts/synthetic/domain/root.ts":
        'import fs from "node:fs"; export const load = (store) => store.readStream(fs);\n',
    });
    const result = evaluate(root, files, {
      kind: "pure-module/v1",
      modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }],
    });
    expect(result.applies).toBe(false);
    expect(result.withdrawalCodes).toContain("event_store_member_reference");
    expect(result.withdrawalCodes).toContain("undeclared_external_specifier");
  });

  it("derives the shipped member set rather than spelling it locally", () => {
    const { root } = fixture();
    expect(deriveForbiddenEventStoreMembers({ repoRoot: root })).toEqual([
      "appendToStream",
      "appendToStreams",
      "appendToStreamsIndependently",
      "readAll",
      "readStream",
    ]);
  });

  const evaluateLeaf = (source, rootPath = "bounded-contexts/synthetic/domain/root.ts") => {
    const { root, files } = fixture({ [rootPath]: source });
    return evaluate(
      root,
      files,
      {
        kind: "pure-module/v1",
        modules: [{ path: rootPath, specifiers: [] }],
      },
      rootPath,
    );
  };

  const leafCase = (name, source, code, rootPath = "bounded-contexts/synthetic/domain/root.ts") => {
    it(name, () => {
      const result = evaluateLeaf(source, rootPath);
      if (code) {
        expect(result.applies).toBe(false);
        expect(result.withdrawalCodes).toContain(code);
      } else {
        expect(result.applies).toBe(true);
        expect(result.withdrawalCodes).toEqual([]);
      }
    });
  };

  const rootAndLeaf = ({
    rootSource,
    leafSource,
    leafPath = "bounded-contexts/synthetic/domain/leaf.ts",
    leafSpecifiers = [],
  }) => {
    const rootPath = "bounded-contexts/synthetic/domain/root.ts";
    const { root, files, resolutionContext } = fixture({
      [rootPath]: rootSource,
      [leafPath]: leafSource,
    });
    const result = evaluate(
      root,
      files,
      {
        kind: "pure-module/v1",
        modules: [
          { path: rootPath, specifiers: [{ specifier: "./leaf", binding: "value" }] },
          { path: leafPath, specifiers: leafSpecifiers },
        ],
      },
      rootPath,
      resolutionContext,
    );
    return { root, files, result, rootPath, leafPath };
  };

  leafCase("D1 derives the shipped Readonly contracts", "export const value = 1;");

  it("D3/D4 fail closed when either Event Store declaration is missing or malformed", () => {
    const missing = fixture({
      "contracts/event-core/event-store.ts": "export type Other = Readonly<{ appendToStream: unknown }>;\n",
      "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n",
    });
    expect(deriveForbiddenEventStoreMembers({ repoRoot: missing.root })).toBeNull();
    const malformed = fixture({
      "contracts/event-core/event-store.ts": "export type EventStore = Readonly<{ ;\n",
      "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n",
    });
    expect(deriveForbiddenEventStoreMembers({ repoRoot: malformed.root })).toBeNull();
  });

  leafCase(
    "Y1 withdraws for a non-literal dynamic import",
    "export const load = (name) => import(name);",
    "ambiguous_dynamic_import",
  );

  it("Y2/Y3 read literal dynamic imports and reject undeclared external edges", () => {
    const y2 = fixture({
      "bounded-contexts/synthetic/domain/root.ts": 'export const load = () => import("./leaf");\n',
      "bounded-contexts/synthetic/domain/leaf.ts": "export const load = (store) => store.readStream(1);\n",
    });
    const y2Result = evaluate(y2.root, y2.files, {
      kind: "pure-module/v1",
      modules: [
        { path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [{ specifier: "./leaf", binding: "value" }] },
        { path: "bounded-contexts/synthetic/domain/leaf.ts", specifiers: [] },
      ],
    });
    expect(y2Result.withdrawalCodes).toContain("event_store_member_reference");
    const y3 = fixture({
      "bounded-contexts/synthetic/domain/root.ts": 'export const load = () => import("node:net");\n',
    });
    const y3Result = evaluate(y3.root, y3.files, {
      kind: "pure-module/v1",
      modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }],
    });
    expect(y3Result.withdrawalCodes).toContain("undeclared_external_specifier");
  });

  it("X5 walks a literal import with options and X6/X7 withdraw ambiguous dynamic loads", () => {
    const x5 = fixture({
      "bounded-contexts/synthetic/domain/root.ts":
        'export const load = () => import("./persist", { with: { type: "json" } });\n',
      "bounded-contexts/synthetic/domain/persist.ts": "export const value = (store) => store.readStream(1);\n",
    });
    expect(
      evaluate(
        x5.root,
        x5.files,
        {
          kind: "pure-module/v1",
          modules: [
            {
              path: "bounded-contexts/synthetic/domain/root.ts",
              specifiers: [{ specifier: "./persist", binding: "value" }],
            },
            { path: "bounded-contexts/synthetic/domain/persist.ts", specifiers: [] },
          ],
        },
        undefined,
        x5.resolutionContext,
      ).withdrawalCodes,
    ).toContain("event_store_member_reference");
    expect(evaluateLeaf("export const load = (name) => import(name, {});").withdrawalCodes).toContain(
      "ambiguous_dynamic_import",
    );
    expect(evaluateLeaf("export const load = (name) => require(name);").withdrawalCodes).toContain(
      "ambiguous_dynamic_import",
    );
    expect(evaluateLeaf('export const load = () => require("./persist");').withdrawalCodes).toContain(
      "unresolvable_module_specifier",
    );
  });

  for (const [name, source, code] of [
    [
      "X9 instantiation-expression detached read",
      "export const f = (store) => store.readStream<number>;",
      "event_store_member_reference",
    ],
    [
      "X10 class heritage value expression",
      "export const f = (store) => class extends store.readStream {};",
      "event_store_member_reference",
    ],
    ["X11 typeof type query neutral", "type Read = typeof store.readStream; export const f = () => 1;", undefined],
  ])
    leafCase(name, source, code);

  it("AC7 derives the shipped names, follows a rename, and reports evaluator unreadable", () => {
    const renamed = fixture({
      "contracts/event-core/event-store.ts":
        "export interface EventStore { renamedAppend: unknown; appendToStreams: unknown; appendToStreamsIndependently: unknown; readStream: unknown; readAll: unknown }\n",
      "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n",
    });
    expect(deriveForbiddenEventStoreMembers({ repoRoot: renamed.root })).toEqual([
      "appendToStreams",
      "appendToStreamsIndependently",
      "readAll",
      "readStream",
      "renamedAppend",
    ]);
    const newMember = evaluate(
      renamed.root,
      { ...renamed.files, "bounded-contexts/synthetic/domain/root.ts": "export const value = store.renamedAppend;\n" },
      { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
      undefined,
      renamed.resolutionContext,
    );
    expect(newMember.withdrawalCodes).toContain("event_store_member_reference");
    const oldMember = evaluate(
      renamed.root,
      { ...renamed.files, "bounded-contexts/synthetic/domain/root.ts": "export const value = store.appendToStream;\n" },
      { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
      undefined,
      renamed.resolutionContext,
    );
    expect(oldMember.withdrawalCodes).not.toContain("event_store_member_reference");
    const unreadable = fixture({
      "contracts/event-core/event-store.ts": "export type Other = Readonly<{ appendToStream: unknown }>;\n",
      "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n",
    });
    expect(
      evaluate(
        unreadable.root,
        unreadable.files,
        { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
        undefined,
        unreadable.resolutionContext,
      ),
    ).toMatchObject({ applies: false, withdrawalCodes: ["event_store_contract_unreadable"] });
  });

  it.each([
    ["backslash declaration path", "bounded-contexts\\synthetic\\domain\\root.ts"],
    ["dot-prefixed declaration path", "./bounded-contexts/synthetic/domain/root.ts"],
    ["parent declaration path", "bounded-contexts/synthetic/../domain/root.ts"],
  ])("AC8 %s is malformed metadata, not normalized", (_name, pathValue) => {
    const result = evaluateReleaseQualificationApplicability({
      rootPath: pathValue,
      applicability: { kind: "pure-module/v1", modules: [{ path: pathValue, specifiers: [] }] },
    });
    expect(result).toMatchObject({ applies: false, withdrawalCodes: ["malformed_applicability_metadata"] });
  });

  it("N17 rejects a non-canonical root path independently of module paths", () => {
    const canonical = "bounded-contexts/synthetic/domain/root.ts";
    expect(
      evaluateReleaseQualificationApplicability({
        rootPath: `./${canonical}`,
        applicability: { kind: "pure-module/v1", modules: [{ path: canonical, specifiers: [] }] },
      }),
    ).toMatchObject({ applies: false, withdrawalCodes: ["malformed_applicability_metadata"] });
  });

  it("N17 rejects a non-canonical module path independently of root path", () => {
    const canonical = "bounded-contexts/synthetic/domain/root.ts";
    expect(
      evaluateReleaseQualificationApplicability({
        rootPath: canonical,
        applicability: { kind: "pure-module/v1", modules: [{ path: `./${canonical}`, specifiers: [] }] },
      }),
    ).toMatchObject({ applies: false, withdrawalCodes: ["malformed_applicability_metadata"] });
  });

  it.each([
    ["missing file", 'export { value } from "./missing";', "unresolvable_module_specifier"],
    ["repository escape", 'export { value } from "../../../../outside";', "module_specifier_escapes_repository"],
  ])("AC8 delegates %s resolution failure to the canonical resolver", (_name, source, code) => {
    expect(evaluateLeaf(source).withdrawalCodes).toContain(code);
  });

  it("AC8 refuses a workspace subpath rejected by the exports map", () => {
    const { root, files, resolutionContext } = fixture(
      { "bounded-contexts/synthetic/domain/root.ts": 'export { value } from "@chase-sets/synthetic/private";\n' },
      [["@chase-sets/synthetic", { root: "packages/synthetic", exports: { "./types": "./src/types.ts" } }]],
    );
    expect(
      evaluate(
        root,
        files,
        { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
        undefined,
        resolutionContext,
      ).withdrawalCodes,
    ).toContain("unresolvable_module_specifier");
  });

  it("AC8 pins the exact public exports, canonical delegation, and test-only import inventory", async () => {
    const source = readFileSync(new URL("./release-qualification-scope-applicability.mjs", import.meta.url), "utf8");
    expect(Object.keys(await import("./release-qualification-scope-applicability.mjs"))).toEqual([
      "RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES",
      "deriveForbiddenEventStoreMembers",
      "evaluateReleaseQualificationApplicability",
    ]);
    expect(source).not.toMatch(/enumerateGuardImportCandidates|normalizeRepoPath|path\.posix\.normalize/);
    expect(source).toContain("resolveModule");
    expect(typeof enumerateCanonicalModuleCandidates).toBe("function");
    expect(typeof resolveModule).toBe("function");
    const imports = execFileSync("git", ["ls-files", "--", "*.mjs"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((file) => readFileSync(file, "utf8").includes('from "./release-qualification-scope-applicability.mjs"'));
    expect(imports).toEqual(["scripts/release-qualification-scope-applicability.test.mjs"]);
  });

  it.each([
    [
      "discovered node absent from declaration",
      'export { value } from "./leaf";',
      [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [{ specifier: "./leaf", binding: "value" }] }],
      "undeclared_graph_node",
    ],
    [
      "declared node never reached",
      "export const value = 1;",
      [
        { path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] },
        { path: "bounded-contexts/synthetic/domain/leaf.ts", specifiers: [] },
      ],
      "graph_shape_drift",
    ],
    [
      "discovered specifier absent from declaration",
      'export { value } from "./leaf";',
      [
        { path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] },
        { path: "bounded-contexts/synthetic/domain/leaf.ts", specifiers: [] },
      ],
      "undeclared_module_specifier",
    ],
    [
      "declared specifier absent from discovery",
      "export const value = 1;",
      [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [{ specifier: "./leaf", binding: "value" }] }],
      "graph_shape_drift",
    ],
  ])("AC3 %s withdraws with the quoted graph-shape code", (_name, source, modules, code) => {
    const { root, files, resolutionContext } = fixture({
      "bounded-contexts/synthetic/domain/root.ts": source,
      "bounded-contexts/synthetic/domain/leaf.ts": "export const value = 1;\n",
    });
    const result = evaluate(root, files, { kind: "pure-module/v1", modules }, undefined, resolutionContext);
    expect(result.applies).toBe(false);
    expect(result.withdrawalCodes).toContain(code);
  });

  it.each([
    ["type-only to value", 'import type { value } from "./leaf"; export const root = value;', "value", "type-only"],
    ["value to type-only", 'import { value } from "./leaf"; export const root = value;', "type-only", "value"],
  ])("AC3 binding drift %s is load-bearing", (_name, source, declaredBinding, actualBinding) => {
    const { root, files, resolutionContext } = fixture({
      "bounded-contexts/synthetic/domain/root.ts": source,
      "bounded-contexts/synthetic/domain/leaf.ts": "export const value = 1;\n",
    });
    const result = evaluate(
      root,
      files,
      {
        kind: "pure-module/v1",
        modules: [
          {
            path: "bounded-contexts/synthetic/domain/root.ts",
            specifiers: [{ specifier: "./leaf", binding: declaredBinding }],
          },
          { path: "bounded-contexts/synthetic/domain/leaf.ts", specifiers: [] },
        ],
      },
      undefined,
      resolutionContext,
    );
    expect(actualBinding).toBeDefined();
    expect(result.withdrawalCodes).toContain("binding_mode_drift");
  });

  it("AC4 withdraws an undeclared external edge and admits the matching declaration", () => {
    const undeclared = rootAndLeaf({
      rootSource: 'export { value } from "./leaf";',
      leafSource: 'import fs from "node:fs"; export const value = fs;\n',
    });
    expect(undeclared.result.applies).toBe(false);
    expect(undeclared.result.withdrawalCodes).toContain("undeclared_external_specifier");
    const declared = rootAndLeaf({
      rootSource: 'export { value } from "./leaf";',
      leafSource: 'import fs from "node:fs"; export const value = fs;\n',
      leafSpecifiers: [{ specifier: "node:fs", binding: "value" }],
    });
    expect(declared.result).toMatchObject({ applies: true, withdrawalCodes: [] });
    const rootRecord = classifyReleaseQualificationScope({
      now,
      base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
      candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
      changedFiles: [{ path: declared.rootPath, status: "added" }],
      readFileAt: (_side, file) => declared.files[file] ?? null,
    });
    expect(rootRecord).toMatchObject({ class: "isolated", reasonCodes: ["application_runtime"] });
    const leafRecord = classifyReleaseQualificationScope({
      now,
      base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
      candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
      changedFiles: [{ path: declared.leafPath, status: "added" }],
      readFileAt: (_side, file) => declared.files[file] ?? null,
    });
    expect(leafRecord.files).toEqual([
      expect.objectContaining({
        path: declared.leafPath,
        class: "isolated",
        reasonCodes: ["application_runtime"],
      }),
    ]);
  });

  it.each([
    ["leaf SQL", 'export async function load(pool) { return pool.query("SELECT * FROM t"); }', "sql_execution_surface"],
    [
      "leaf Event Store read",
      'export async function load(store) { return store.readStream("s"); }',
      "event_store_member_reference",
    ],
  ])("AC5 catches a %s violation two edges from the root", (_name, leafSource, code) => {
    const { result, rootPath, files } = rootAndLeaf({ rootSource: 'export { load } from "./leaf";', leafSource });
    expect(result.applies).toBe(false);
    expect(result.withdrawalCodes).toContain(code);
    const rootRecord = classifyReleaseQualificationScope({
      now,
      base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
      candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
      changedFiles: [{ path: rootPath, status: "added" }],
      readFileAt: (_side, file) => files[file] ?? null,
    });
    expect(rootRecord.class).toBe("isolated");
    expect(rootRecord.reasonCodes).toEqual(["application_runtime"]);
  });

  it("AC5 catches a persistent dependency on the leaf while the root remains isolated", () => {
    const { result, rootPath, files } = rootAndLeaf({
      rootSource: 'export { value } from "./leaf";',
      leafSource: 'export { EventStore as value } from "../../../contracts/event-core/event-store";\n',
      leafSpecifiers: [{ specifier: "../../../contracts/event-core/event-store", binding: "value" }],
    });
    expect(result.withdrawalCodes).toContain("persistent_dependency");
    const rootRecord = classifyReleaseQualificationScope({
      now,
      base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
      candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
      changedFiles: [{ path: rootPath, status: "added" }],
      readFileAt: (_side, file) => files[file] ?? null,
    });
    expect(rootRecord).toMatchObject({ class: "isolated", reasonCodes: ["application_runtime"] });
  });

  for (const [name, source] of [
    [
      "E10 shorthand destructuring",
      "export const f = (store) => { const { readStream } = store; return readStream; };",
    ],
    ["E11 parameter destructuring", "export const f = ({ readStream }) => readStream(1);"],
    [
      "E12 assignment destructuring",
      "export const f = (store) => { let read; ({ readStream: read } = store); return read; };",
    ],
  ])
    leafCase(name, source, "event_store_member_reference");

  for (const [name, source] of [
    ["E2 literal element access", 'export const f = (store, input) => store["readStream"](input);'],
    ["E3 optional member access", "export const f = (store, input) => store?.readStream(input);"],
    ["E4 optional call", "export const f = (store, input) => store.readStream?.(input);"],
    ["E5 detached read", "export const f = (store) => store.readStream;"],
    ["E6 detached alias", "export const f = (store, input) => { const read = store.readStream; return read(input); };"],
    ["E13 append member", "export const f = (store, input) => store.appendToStream(input);"],
    [
      "AC6 property-renamed destructuring",
      "export const f = (store, input) => { const { readStream: read } = store; return read(input); };",
    ],
    ["AC7 optional append member", "export const f = (store, input) => store.appendToStreams(input);"],
    ["nested arrow", "export const f = (store, input) => () => store.readStream(input);"],
    [
      "local helper",
      "export const f = (store, input) => { function helper() { return store.readStream(input); } return helper(); };",
    ],
  ])
    leafCase(name, source, "event_store_member_reference");

  for (const [name, source] of [
    ["N_map neutral", "export const f = (items) => items.map((item) => item.value);"],
    ["N_line_comment neutral", "// store.readStream(input)\nexport const f = () => 1;"],
    ["N_block_comment neutral", "/* store.readStream(input) */\nexport const f = () => 1;"],
    ["N_string neutral", 'export const f = () => "store.readStream(input)";'],
    [
      "N_indexedAccessType neutral",
      'type EventStore = { readStream: unknown }; export const f: EventStore["readStream"] = 1;',
    ],
    ["N18 interface heritage neutral", "interface Child extends store.readStream {} export const f = () => 1;"],
    ["N18 implements heritage neutral", "class Child implements store.readStream {} export const f = () => 1;"],
  ])
    leafCase(name, source, undefined);

  for (const [name, source] of [
    ["X1 alias receiver dynamic key", "export const f = (es, k, input) => es[k](input);"],
    [
      "X2 rebound receiver dynamic key",
      "export const f = (store, k, input) => { const es = store; return es[k](input); };",
    ],
    ["X3 concatenated alias key", 'export const f = (es, input) => es["read" + "Stream"](input);'],
    ["X4 template alias key", "export const f = (es, x, input) => es[`read${x}`](input);"],
  ])
    leafCase(name, source, "ambiguous_member_reference_key");

  it("N_import_type neutral stays applicable when its type edge is declared", () => {
    const rootPath = "bounded-contexts/synthetic/domain/root.ts";
    const specifier = "../../../contracts/event-core/event-store";
    const { root, files, resolutionContext } = fixture({
      [rootPath]: `import type { EventStore } from "${specifier}"; export const f = () => 1;`,
    });
    expect(
      evaluate(
        root,
        files,
        { kind: "pure-module/v1", modules: [{ path: rootPath, specifiers: [{ specifier, binding: "type-only" }] }] },
        rootPath,
        resolutionContext,
      ),
    ).toMatchObject({ applies: true, withdrawalCodes: [] });
  });

  it("AC7 derives exactly the shipped Event Store member set from shipped declaration text", () => {
    expect(deriveForbiddenEventStoreMembers({ repoRoot: process.cwd() })).toEqual([
      "appendToStream",
      "appendToStreams",
      "appendToStreamsIndependently",
      "readAll",
      "readStream",
    ]);
  });

  leafCase(
    "AC6 dynamic key withdraws regardless of receiver name",
    "export const f = (es, someVariable, input) => es[someVariable](input);",
    "ambiguous_member_reference_key",
  );

  it("AC6 typed non-PostgreSQL query is not SQL and remains applicable", () => {
    const { root, files } = fixture({
      "bounded-contexts/synthetic/domain/root.ts":
        'type Queryable = { query(...args: unknown[]): unknown }; export const f = (client: Queryable) => client.query("SELECT 1");',
    });
    const sql = classifySqlExecutionSurface({ repoRoot: root, files: ["bounded-contexts/synthetic/domain/root.ts"] });
    expect(sql.modules[0]).toMatchObject({ file: "bounded-contexts/synthetic/domain/root.ts", outcome: "not-sql" });
    expect(sql.unresolvedMemberRoots).toMatchObject({ count: 0, fileList: [] });
    expect(
      evaluate(root, files, {
        kind: "pure-module/v1",
        modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }],
      }),
    ).toMatchObject({
      applies: true,
      withdrawalCodes: [],
    });
  });

  leafCase("N_numericIndex does not treat numeric keys as member names", "export const f = (xs) => xs[0];", undefined);

  it("U1 withdraws unknown-surface persistent classification", () => {
    const { root, files } = fixture({ "misc/unknown.ts": "export const value = 1;\n" });
    const result = evaluate(
      root,
      files,
      { kind: "pure-module/v1", modules: [{ path: "misc/unknown.ts", specifiers: [] }] },
      "misc/unknown.ts",
    );
    expect(result.withdrawalCodes).toContain("persistent_dependency");
  });

  it("RR1 derives contracts readably against the real repository", () => {
    const rootPath = "bounded-contexts/public-presence/features/waitlist/domain/public-referral-code.ts";
    const result = evaluateReleaseQualificationApplicability({
      repoRoot: process.cwd(),
      rootPath,
      applicability: {
        kind: "pure-module/v1",
        modules: [{ path: rootPath, specifiers: [{ specifier: "node:crypto", binding: "value" }] }],
      },
      now,
    });
    expect(result.withdrawalCodes).not.toContain("event_store_contract_unreadable");
    expect(result.graph).toEqual([{ path: rootPath, specifiers: [{ specifier: "node:crypto", binding: "value" }] }]);
  });

  it("AC9 reads a type edge without walking it, while value mode is load-bearing", () => {
    const rootPath = "bounded-contexts/synthetic/domain/root.ts";
    const specifier = "../../../contracts/event-core/event-store";
    const typeOnly = fixture({
      [rootPath]: `import type { EventStore } from "${specifier}"; export const value = 1;`,
    });
    const typeResult = evaluate(
      typeOnly.root,
      typeOnly.files,
      { kind: "pure-module/v1", modules: [{ path: rootPath, specifiers: [{ specifier, binding: "type-only" }] }] },
      rootPath,
      typeOnly.resolutionContext,
    );
    expect(typeResult).toMatchObject({ applies: true, withdrawalCodes: [] });
    expect(typeResult.graph).toEqual([{ path: rootPath, specifiers: [{ specifier, binding: "type-only" }] }]);
    const value = fixture({
      [rootPath]: `import { EventStore } from "${specifier}"; export const value = EventStore;`,
    });
    const drift = evaluate(
      value.root,
      value.files,
      { kind: "pure-module/v1", modules: [{ path: rootPath, specifiers: [{ specifier, binding: "type-only" }] }] },
      rootPath,
      value.resolutionContext,
    );
    expect(drift.withdrawalCodes).toContain("binding_mode_drift");
    const persistent = evaluate(
      value.root,
      value.files,
      { kind: "pure-module/v1", modules: [{ path: rootPath, specifiers: [{ specifier, binding: "value" }] }] },
      rootPath,
      value.resolutionContext,
    );
    expect(persistent.withdrawalCodes).toContain("persistent_dependency");
  });

  it("AC10 withdraws unparseable source and labels malformed controls helper-only", () => {
    const broken = fixture({ "bounded-contexts/synthetic/domain/root.ts": "export const = ;" });
    expect(
      evaluate(
        broken.root,
        broken.files,
        { kind: "pure-module/v1", modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [] }] },
        undefined,
        broken.resolutionContext,
      ).withdrawalCodes,
    ).toContain("unparseable_module");
    const malformed = evaluateReleaseQualificationApplicability({
      applicability: {
        kind: "pure-module/v1",
        modules: [{ path: "bounded-contexts/synthetic/domain/root.ts", specifiers: [{ specifier: "./x" }] }],
      },
    });
    expect(malformed.withdrawalCodes).toEqual(["malformed_applicability_metadata"]);
    const unknown = evaluateReleaseQualificationApplicability({
      applicability: { kind: "path-scope/v0", modules: [] },
    });
    expect(unknown.withdrawalCodes).toEqual(["unsupported_applicability_kind"]);
    const classifierSource = readFileSync("scripts/release-qualification-scope.mjs", "utf8");
    expect(classifierSource).toContain("function classifyOrThrow");
    expect(classifierSource).toContain("validateReleaseQualificationScopeRegistry");
  });

  it.each([
    ["R1 empty modules", { kind: "pure-module/v1", modules: [] }],
    ["R2 missing modules", { kind: "pure-module/v1" }],
    ["R3 null module", { kind: "pure-module/v1", modules: [null] }],
    ["R4 non-array modules", { kind: "pure-module/v1", modules: 7 }],
  ])("AC10 helper-only %s returns the named malformed metadata refusal", (_name, applicability) => {
    expect(evaluateReleaseQualificationApplicability({ applicability })).toEqual({
      applies: false,
      withdrawalCodes: ["malformed_applicability_metadata"],
      graph: [],
    });
  });

  it("AC11 materializes the SQL contract corpus, rejects its omission, and passes fixture context through", () => {
    const corpus = fixture({ "bounded-contexts/synthetic/domain/root.ts": "export const value = 1;\n" });
    const emitted = Object.keys(corpus.files).sort();
    expect(emitted).toEqual(
      expect.arrayContaining([
        "infrastructure/event-core-postgres/types.ts",
        "infrastructure/event-core-postgres/index.ts",
      ]),
    );
    const expectedContext = buildModuleResolutionContextFixture({ files: Object.keys(corpus.files), packages: [] });
    expect([...corpus.resolutionContext.workspacePackages]).toEqual([...expectedContext.workspacePackages]);
    expect([...corpus.resolutionContext.existingPaths]).toEqual([...expectedContext.existingPaths]);
    rmSync(path.join(corpus.root, "infrastructure", "event-core-postgres", "types.ts"));
    expect(() =>
      classifySqlExecutionSurface({ repoRoot: corpus.root, files: ["bounded-contexts/synthetic/domain/root.ts"] }),
    ).toThrowError(expect.objectContaining({ code: "SQL_CONTRACT_MODULE_MISSING" }));
  });

  it("AC12 keeps the classifier untouched and proves candidate-sweep records against its exact merge base", () => {
    const applicabilitySource = readFileSync("scripts/release-qualification-scope.mjs", "utf8");
    expect(applicabilitySource).not.toContain("release-qualification-scope-applicability.mjs");
    const trackedImports = execFileSync("git", ["ls-files", "--", "*.mjs"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((file) => readFileSync(file, "utf8").includes('from "./release-qualification-scope-applicability.mjs"'));
    expect(trackedImports).toEqual(["scripts/release-qualification-scope-applicability.test.mjs"]);

    const staticClosure = new Set();
    const visit = (file) => {
      if (staticClosure.has(file)) return;
      staticClosure.add(file);
      const source = readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const specifiers = [];
      const add = (node) => {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
          specifiers.push(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) ? node.expression.text : "") === "require") {
          if (ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, add);
      };
      add(parsed);
      for (const specifier of specifiers.filter((value) => value.startsWith("."))) {
        const base = path.resolve(path.dirname(file), specifier);
        const target = [base, `${base}.mjs`, `${base}.js`, `${base}.json`, path.join(base, "index.mjs")].find(
          (candidate) => {
            try {
              return readFileSync(candidate);
            } catch {
              return false;
            }
          },
        );
        if (target) visit(target);
      }
    };
    visit(path.resolve("scripts/release-qualification-scope.mjs"));
    expect([...staticClosure].some((file) => file.endsWith("release-qualification-scope-applicability.mjs"))).toBe(
      false,
    );

    const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => file.replaceAll("\\", "/"));
    const excludedPattern =
      /\.(?:md|mdx)$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__fixtures__|tests|test-support|fixtures)\//;
    const pathTokenPattern =
      /(?:^|[-_./])(?:seed|seeds|seeding|bootstrap|reconcile|reconciliation|backfill)(?=[-_./]|$)|import-to-promotion|representative-commerce|integration-reset/i;
    const seedImportPattern = /from\s+["'][^"']*(?:runtime-support\/seed|seed-support\/|\/seeding)["']/;
    const discovered = trackedFiles.filter((filePath) => {
      if (
        !["bounded-contexts", "contracts", "deployables", "infrastructure", "scripts"].some((root) =>
          filePath.startsWith(`${root}/`),
        ) ||
        excludedPattern.test(filePath)
      )
        return false;
      if (pathTokenPattern.test(filePath)) return true;
      if (/\.(?:ts|tsx|mjs)$/.test(filePath)) return seedImportPattern.test(readFileSync(filePath, "utf8"));
      return false;
    });
    const readReal = (_side, filePath) => {
      try {
        return readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    };
    const releaseWorkflowScriptReferences = collectReleaseWorkflowScriptReferences({
      registry: releaseQualificationScopeRegistry,
      readFileAt: readReal,
    });
    const records = discovered
      .map(
        (filePath) =>
          classifyReleaseQualificationScope({
            base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
            candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
            changedFiles: [{ path: filePath, status: "modified" }],
            readFileAt: readReal,
            releaseWorkflowScriptReferences,
            now,
          }).files[0],
      )
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    const histogram = Object.fromEntries(
      [...new Set(records.map((record) => record.class))]
        .sort()
        .map((className) => [className, records.filter((record) => record.class === className).length]),
    );
    const digest = createHash("sha256").update(JSON.stringify(records)).digest("hex");
    process.stdout.write(`AC12_CANDIDATE_RECORDS ${JSON.stringify({ count: records.length, histogram, digest })}\n`);
    expect(records.some((record) => record.path.endsWith("release-qualification-scope-applicability.mjs"))).toBe(false);
    expect(records.some((record) => record.path.endsWith("release-qualification-scope-applicability.test.mjs"))).toBe(
      false,
    );

    expect(AC12_FIXTURE.schemaVersion).toBe("release-qualification-ac12-fixture/v1");
    expect(AC12_FIXTURE.candidate.sha).toBe(AC12_PINNED_CANDIDATE);
    expect(AC12_FIXTURE.mergeBase.sha).toBe(AC12_PINNED_MERGE_BASE);
    expect(AC12_FIXTURE.candidate.treeSha).not.toBe(AC12_FIXTURE.mergeBase.treeSha);
    const resolvePinnedCommit = (sha) => {
      try {
        return execFileSync("git", ["rev-parse", "--verify", `${sha}^{commit}`], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    };
    const candidate = resolvePinnedCommit(AC12_FIXTURE.candidate.sha);
    const mergeBase = resolvePinnedCommit(AC12_FIXTURE.mergeBase.sha);
    process.stdout.write(
      `AC12_PINNED_EVIDENCE ${JSON.stringify({ branch: candidate && mergeBase ? "live" : "fallback" })}\n`,
    );
    assertAc12PinnedEvidence(AC12_FIXTURE, candidate, mergeBase);
  });

  it("AC12 fallback rejects a tampered merge-base tree or governed digest", () => {
    const mergeBase = AC12_FIXTURE.mergeBase.sha;
    expect(() => assertAc12PinnedEvidence(AC12_FIXTURE, null, mergeBase)).not.toThrow();

    const tamperedTree = structuredClone(AC12_FIXTURE);
    tamperedTree.mergeBase.treeSha = "0".repeat(40);
    expect(() => assertAc12PinnedEvidence(tamperedTree, null, mergeBase)).toThrowError(
      expect.stringContaining(tamperedTree.mergeBase.treeSha),
    );

    const tamperedDigest = structuredClone(AC12_FIXTURE);
    tamperedDigest.governedModulesSha256 = "0".repeat(64);
    expect(() => assertAc12PinnedEvidence(tamperedDigest, null, mergeBase)).toThrowError(
      expect.stringContaining(tamperedDigest.governedModulesSha256),
    );

    expect(() => assertAc12PinnedEvidence(AC12_FIXTURE, null, null)).toThrowError(
      expect.stringContaining(AC12_FIXTURE.mergeBase.sha),
    );
  });

  function neutralityError(code, reachedClause) {
    throw Object.assign(new Error(code), { code, reachedClause });
  }

  function rawTreeMembers(bytes, aliases = new Map()) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.at(-1) !== 0)
      neutralityError("NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree");
    let decoded;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      neutralityError("NEUTRALITY_INVALID_UTF8", "fatal-tree-decoder");
    }
    const names = decoded.slice(0, -1).split("\0");
    if (names.some((name) => !name)) neutralityError("NEUTRALITY_TREE_INCOMPLETE", "empty-tree-member");
    const members = names.map((name) => {
      const canonical = listNonTestTypeScriptModules(process.cwd(), { execGit: () => `${name}\0` });
      if (canonical.length === 0) return null;
      const raw = Buffer.from(name, "utf8").toString("hex");
      if (aliases.has(canonical[0]) && aliases.get(canonical[0]) !== raw)
        neutralityError("NEUTRALITY_CANONICAL_ALIAS_COLLISION", "canonical-to-raw-one-to-one");
      aliases.set(canonical[0], raw);
      return { canonicalName: canonical[0], raw };
    });
    return members.filter(Boolean);
  }

  function compareNeutrality(base, candidate) {
    const aliases = new Map();
    const before = rawTreeMembers(base, aliases);
    const after = rawTreeMembers(candidate, aliases);
    if (JSON.stringify(before) !== JSON.stringify(after))
      neutralityError("NEUTRALITY_MEMBER_SET_CHANGED", "complete-raw-member-set");
    return after;
  }

  it("N1 replays a recorded landed pair through real git reads, not synthetic buffers", () => {
    const forkPoint = "406d9bf5d82cbee79fcc5b295c67aa7cc9f35bb9";
    const landing = "c08e1e4ec547dcbd70959874b48afd70931026cc";
    for (const sha of [forkPoint, landing]) {
      let present = true;
      try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        present = false;
      }
      expect(present).toBe(true);
    }
    expect(execFileSync("git", ["rev-list", "--parents", "-n", "1", landing], { encoding: "utf8" }).trim()).toBe(
      `${landing} ${forkPoint}`,
    );
    const readTree = (sha) =>
      listNonTestTypeScriptModules(process.cwd(), {
        execGit: () => execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha]).toString("utf8"),
      });
    expect(readTree(landing)).toEqual(readTree(forkPoint));
    expect(readTree(landing).length > 0).toBe(true);
  });

  it.each([
    ["N2 addition", "bounded-contexts/a.ts\0", "bounded-contexts/a.ts\0bounded-contexts/b.ts\0"],
    ["N3 removal", "bounded-contexts/a.ts\0bounded-contexts/b.ts\0", "bounded-contexts/a.ts\0"],
    ["N4 membership", "bounded-contexts/a.ts\0", "bounded-contexts/b.ts\0"],
  ])("%s refuses complete raw membership inequality", (_name, base, candidate) => {
    expect(() => compareNeutrality(Buffer.from(base), Buffer.from(candidate))).toThrowError(
      expect.objectContaining({ code: "NEUTRALITY_MEMBER_SET_CHANGED", reachedClause: "complete-raw-member-set" }),
    );
  });

  it.each([
    ["empty", Buffer.alloc(0), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    ["short", Buffer.from("bounded-contexts/a.ts"), "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
    ["failed", null, "NEUTRALITY_TREE_INCOMPLETE", "nul-terminated-tree"],
  ])("N5 refuses %s tree input", (_name, bytes, code, reachedClause) => {
    expect(() => rawTreeMembers(bytes)).toThrowError(expect.objectContaining({ code, reachedClause }));
  });

  it("N6 preserves raw identities and refuses invalid UTF-8 or same-tree aliases", () => {
    expect(() => rawTreeMembers(Buffer.from("bounded-contexts/a\\b.ts\0bounded-contexts/a/b.ts\0"))).toThrowError(
      expect.objectContaining({ code: "NEUTRALITY_CANONICAL_ALIAS_COLLISION" }),
    );
    expect(() => rawTreeMembers(Buffer.from("7372632fff2e747300", "hex"))).toThrowError(
      expect.objectContaining({ code: "NEUTRALITY_INVALID_UTF8" }),
    );
    const identities = Buffer.from("bounded-contexts/A.ts\0bounded-contexts/a.ts\0bounded-contexts/é.ts\0", "utf8");
    expect(rawTreeMembers(identities)).toHaveLength(3);
  });

  it.each([
    [Buffer.from("bounded-contexts/a\\b.ts\0"), Buffer.from("bounded-contexts/a/b.ts\0")],
    [Buffer.from("bounded-contexts/./a.ts\0"), Buffer.from("bounded-contexts/a.ts\0")],
  ])("N8 cross-tree canonical aliases refuse while canonical-only comparison is green", (base, candidate) => {
    expect(() => compareNeutrality(base, candidate)).toThrowError(
      expect.objectContaining({ code: "NEUTRALITY_CANONICAL_ALIAS_COLLISION" }),
    );
    expect(listNonTestTypeScriptModules(process.cwd(), { execGit: () => base.toString("utf8") })).toEqual(
      listNonTestTypeScriptModules(process.cwd(), { execGit: () => candidate.toString("utf8") }),
    );
  });

  it("AC14 reports bounded closure-node and SQL-call counts with one shared context", () => {
    const corpus = fixture({
      "bounded-contexts/synthetic/domain/root.ts": 'export { value } from "./leaf";\n',
      "bounded-contexts/synthetic/domain/leaf.ts": "export const value = 1;\n",
    });
    let sqlCalls = 0;
    const sqlClassifier = (input) => {
      sqlCalls += 1;
      return classifySqlExecutionSurface(input);
    };
    const result = evaluateReleaseQualificationApplicability({
      repoRoot: corpus.root,
      rootPath: "bounded-contexts/synthetic/domain/root.ts",
      applicability: {
        kind: "pure-module/v1",
        modules: [
          {
            path: "bounded-contexts/synthetic/domain/root.ts",
            specifiers: [{ specifier: "./leaf", binding: "value" }],
          },
          { path: "bounded-contexts/synthetic/domain/leaf.ts", specifiers: [] },
        ],
      },
      files: corpus.files,
      resolutionContext: corpus.resolutionContext,
      sqlClassifier,
      now,
    });
    const counts = { closureNodes: result.graph.length, sqlCalls };
    expect(counts).toEqual({ closureNodes: 2, sqlCalls: 2 });
    process.stdout.write(`AC14_COST_COUNTS ${JSON.stringify(counts)}\n`);
  });
});
