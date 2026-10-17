import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveForbiddenEventStoreMembers,
  evaluateReleaseQualificationApplicability,
  RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES,
} from "./release-qualification-scope-applicability.mjs";

const tempRoots = [];
const now = () => 0;

function fixture(extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-applicability-"));
  tempRoots.push(root);
  const files = {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "infrastructure/event-core-postgres/types.ts":
      "export interface PgQueryable { query(...args: unknown[]): unknown }\nexport interface PgPoolClient extends PgQueryable {}\nexport interface PgTransactionalPool extends PgQueryable {}\n",
    "infrastructure/event-core-postgres/index.ts": 'export * from "./types";\n',
    "contracts/event-core/event-store.ts":
      "export interface EventStore { appendToStream: unknown; appendToStreams: unknown; appendToStreamsIndependently: unknown; readStream: unknown; readAll: unknown }\n",
    "contracts/event-core/complete-stream.ts":
      "export type CompleteStreamReader = Readonly<{ readStream: unknown }>;\n",
    ...extra,
  };
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return { root, files };
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function evaluate(root, files, applicability, rootPath = "bounded-contexts/synthetic/domain/root.ts") {
  return evaluateReleaseQualificationApplicability({
    repoRoot: root,
    rootPath,
    applicability,
    now,
    files,
  });
}

describe("release qualification applicability evaluator", () => {
  it("returns the closed frozen shape and exact ordered vocabulary", () => {
    const value = evaluateReleaseQualificationApplicability({ applicability: { kind: "unknown" } });
    expect(Reflect.ownKeys(value)).toEqual(["applies", "withdrawalCodes", "graph"]);
    expect(value.applies).toBe(false);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES)).toBe(true);
    expect(value.withdrawalCodes).toEqual(["unsupported_applicability_kind"]);
  });

  it("admits a recursively closed graph and reports its exact edges", () => {
    const { root, files } = fixture({
      "bounded-contexts/synthetic/domain/root.ts":
        'import type { LeafType } from "./leaf";\nimport "./types";\nexport { value } from "./leaf";\n',
      "bounded-contexts/synthetic/domain/leaf.ts": 'import crypto from "node:crypto"; export const value = crypto;\n',
      "bounded-contexts/synthetic/domain/types.ts": "export type LeafType = string;\n",
    });
    const result = evaluate(root, files, {
      kind: "pure-module/v1",
      modules: [
        {
          path: "bounded-contexts/synthetic/domain/root.ts",
          specifiers: [
            { specifier: "./leaf", binding: "value" },
            { specifier: "./types", binding: "value" },
          ],
        },
        {
          path: "bounded-contexts/synthetic/domain/leaf.ts",
          specifiers: [{ specifier: "node:crypto", binding: "value" }],
        },
        { path: "bounded-contexts/synthetic/domain/types.ts", specifiers: [] },
      ],
    });
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
          { specifier: "./leaf", binding: "value" },
          { specifier: "./types", binding: "value" },
        ],
      },
      { path: "bounded-contexts/synthetic/domain/types.ts", specifiers: [] },
    ]);
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

  const leafCase = (name, source, code, rootPath = "bounded-contexts/synthetic/domain/root.ts") => {
    it(name, () => {
      const { root, files } = fixture({ [rootPath]: source });
      const result = evaluate(
        root,
        files,
        {
          kind: "pure-module/v1",
          modules: [{ path: rootPath, specifiers: [] }],
        },
        rootPath,
      );
      if (code) {
        expect(result.applies).toBe(false);
        expect(result.withdrawalCodes).toContain(code);
      } else {
        expect(result.applies).toBe(true);
        expect(result.withdrawalCodes).toEqual([]);
      }
    });
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

  it("RR1 admits the real pure referral-code leaf", () => {
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
});
