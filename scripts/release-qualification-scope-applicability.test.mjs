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
      'import type { EventStore } from "./event-store";\nexport type CompleteStreamReader = Pick<EventStore, "readStream">;\n',
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

function evaluate(root, files, applicability, rootPath = "src/root.ts") {
  return evaluateReleaseQualificationApplicability({
    repoRoot: root,
    rootPath,
    applicability,
    now,
    sourceFiles: files,
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
      "src/root.ts": 'import type { LeafType } from "./leaf";\nimport "./types";\nexport { value } from "./leaf";\n',
      "src/leaf.ts": 'import crypto from "node:crypto"; export const value = crypto;\n',
      "src/types.ts": "export type LeafType = string;\n",
    });
    const result = evaluate(root, files, {
      kind: "pure-module/v1",
      modules: [
        {
          path: "src/root.ts",
          specifiers: [
            { specifier: "./leaf", binding: "value" },
            { specifier: "./types", binding: "value" },
          ],
        },
        { path: "src/leaf.ts", specifiers: [{ specifier: "node:crypto", binding: "value" }] },
        { path: "src/types.ts", specifiers: [] },
      ],
    });
    expect(result.applies).toBe(true);
    expect(result.withdrawalCodes).toEqual([]);
    expect(result.graph).toEqual([
      { path: "src/leaf.ts", specifiers: [{ specifier: "node:crypto", binding: "value" }] },
      {
        path: "src/root.ts",
        specifiers: [
          { specifier: "./leaf", binding: "value" },
          { specifier: "./types", binding: "value" },
        ],
      },
      { path: "src/types.ts", specifiers: [] },
    ]);
  });

  it("withdraws for graph drift, external drift, dynamic imports and forbidden members", () => {
    const { root, files } = fixture({
      "src/root.ts": 'import fs from "node:fs"; export const load = (store) => store.readStream(fs);\n',
    });
    const result = evaluate(root, files, {
      kind: "pure-module/v1",
      modules: [{ path: "src/root.ts", specifiers: [] }],
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
});
