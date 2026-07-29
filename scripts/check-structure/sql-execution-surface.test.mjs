import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SANCTIONED_SQL_RECEIVER_RESOLUTION,
  classifySqlExecutionSurface,
  deriveChangedSqlExecutionFiles,
  listNonTestTypeScriptModules,
} from "./sql-execution-surface.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtureFile = "scripts/check-structure/fixtures/sql-execution-surface/fixture-cases.ts";
const tempRoots = [];

function classify(files, root = repoRoot) {
  return classifySqlExecutionSurface({ repoRoot: root, files });
}

function withoutChangedFilesJson(run) {
  const previous = process.env.CHANGED_FILES_JSON;
  delete process.env.CHANGED_FILES_JSON;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CHANGED_FILES_JSON;
    else process.env.CHANGED_FILES_JSON = previous;
  }
}

function callAt(result, file, line) {
  return result.modules.find((module) => module.file === file)?.calls.find((call) => call.line === line);
}

function expectSql(result, file, line, receiver) {
  expect(callAt(result, file, line), `${file}:${line}`).toMatchObject({
    receiver,
    outcome: "sql-execution",
  });
}

function createContractRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "sql-execution-contract-"));
  tempRoots.push(root);
  const contractDir = path.join(root, "infrastructure", "event-core-postgres");
  mkdirSync(contractDir, { recursive: true });
  cpSync(path.join(repoRoot, "infrastructure", "event-core-postgres", "types.ts"), path.join(contractDir, "types.ts"));
  cpSync(path.join(repoRoot, "infrastructure", "event-core-postgres", "index.ts"), path.join(contractDir, "index.ts"));
  writeFileSync(
    path.join(contractDir, "package.json"),
    JSON.stringify({
      name: "@chase-sets/event-core-postgres",
      exports: { ".": "./index.ts", "./*": "./*.ts" },
    }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "infrastructure/*"\n');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SQL execution fixture matrix through the real guard entrypoint", () => {
  it("classifies P1-P10 and P12-P18 as SQL-executing at their named anchors", () => {
    const anchors = [
      ["bounded-contexts/ordering/features/orders/read-model/support-lookup.ts", 37, "db"],
      ["infrastructure/event-core-postgres/catalog-mirror.ts", 236, "db"],
      ["infrastructure/event-core-postgres/types.ts", 40, "client"],
      ["scripts/catalog-integration-reset.ts", 216, "db"],
      ["infrastructure/event-core-postgres/projection-store.ts", 358, "config.db"],
      ["bounded-contexts/catalog/features/product-measures/api/runtime.ts", 144, "deps.db"],
      ["bounded-contexts/auth/support/ucp-support/oauth.ts", 283, "options.auth.db"],
      ["bounded-contexts/commercial-terms/support/runtime-support/seed.ts", 235, "db"],
      ["bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts", 311, "db"],
      ["infrastructure/event-core-postgres/postgres-db-test-support.ts", 24, "adminPool"],
      ["bounded-contexts/catalog/features/catalog-items/read-model/projection.ts", 28, "projectionDb"],
      [
        "bounded-contexts/collections/features/saved-lists/read-model/shared-page-projection.ts",
        38,
        "resolveProjectionDb(context, db)",
      ],
      ["bounded-contexts/catalog/features/categories/read-model/queries.ts", 82, "db"],
      ["bounded-contexts/discovery/features/search/read-model/market-signals.ts", 70, "db"],
      [fixtureFile, 29, "db"],
      [fixtureFile, 33, "db"],
      [fixtureFile, 37, "db"],
    ];
    const result = classify([...new Set(anchors.map(([file]) => file))]);
    for (const [file, line, receiver] of anchors) expectSql(result, file, line, receiver);
  });

  it("classifies all package-internal modules, with pool.ts explicitly silent under N13", () => {
    const files = [
      "infrastructure/event-core-postgres/catalog-mirror.ts",
      "infrastructure/event-core-postgres/projection-store.ts",
      "infrastructure/event-core-postgres/event-store.ts",
      "infrastructure/event-core-postgres/postgres-db-test-support.ts",
      "infrastructure/event-core-postgres/projection-helpers.ts",
      "infrastructure/event-core-postgres/aggregate-snapshot-store.ts",
      "infrastructure/event-core-postgres/list-query.ts",
      "infrastructure/event-core-postgres/pool.ts",
    ];
    const result = classify(files);
    for (const file of files.slice(0, -1)) {
      expect(result.modules.find((module) => module.file === file)?.outcome, file).toBe("sql-executing");
    }
    expect(callAt(result, "infrastructure/event-core-postgres/pool.ts", 125)).toMatchObject({
      receiver: "client",
      outcome: "not-sql",
    });
    expect(result.violations).not.toEqual(
      expect.arrayContaining([expect.stringContaining("infrastructure/event-core-postgres/pool.ts")]),
    );
  });

  it("proves every already contract-annotated receiver, including P18", () => {
    const cases = [
      ["bounded-contexts/ordering/features/orders/read-model/support-lookup.ts", 37],
      ["infrastructure/event-core-postgres/catalog-mirror.ts", 236],
      ["bounded-contexts/commercial-terms/support/runtime-support/seed.ts", 235],
      ["bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts", 311],
      [fixtureFile, 29],
      [fixtureFile, 37],
    ];
    const result = classify([...new Set(cases.map(([file]) => file))]);
    for (const [file, line] of cases)
      expect(callAt(result, file, line)?.outcome, `${file}:${line}`).toBe("sql-execution");
    const identityServicesLines = readFileSync(
      path.join(repoRoot, "bounded-contexts/identity/support/runtime-support/services.ts"),
      "utf8",
    ).split(/\r?\n/);
    expect(identityServicesLines[51]).toContain("pool as PgQueryable");
  });

  it("classifies every P14 bind-then-call sibling module as SQL-executing", () => {
    const files = [
      "bounded-contexts/catalog/features/catalog-items/read-model/projection.ts",
      "bounded-contexts/catalog/features/display-templates/read-model/projection.ts",
      "bounded-contexts/checkout/features/cart/read-model/projection.ts",
      "bounded-contexts/checkout/features/sessions/read-model/projection.ts",
      "bounded-contexts/collections/features/saved-lists/read-model/shared-page-projection.ts",
      "bounded-contexts/settlement/features/wallets/read-model/projection.ts",
      "bounded-contexts/settlement/features/wallets/read-model/wallet-adjustment-projection.ts",
    ];
    const result = classify(files);
    for (const file of files) {
      expect(result.modules.find((module) => module.file === file)?.outcome, file).toBe("sql-executing");
    }
    expectSql(result, files[0], 28, "projectionDb");
    expectSql(result, files[4], 38, "resolveProjectionDb(context, db)");
  });

  it("classifies N1-N15 exactly, including P18/N15 contract-bound discrimination", () => {
    const realFiles = [
      "bounded-contexts/auth/support/ucp-support/oauth.ts",
      "bounded-contexts/customer-feedback/features/attention/api/route.ts",
      "bounded-contexts/identity/features/api-keys/api/route.ts",
      "infrastructure/event-core-postgres/pool.ts",
      "contracts/event-core/projector.ts",
    ];
    const result = classify([fixtureFile, ...realFiles]);
    const expectations = [
      [fixtureFile, 41, "not-sql"],
      [fixtureFile, 45, "not-sql"],
      [fixtureFile, 49, "not-sql"],
      [fixtureFile, 53, "not-sql"],
      [fixtureFile, 57, "unprovable-form"],
      [fixtureFile, 61, "unprovable-form"],
      [fixtureFile, 65, "unprovable-form"],
      [fixtureFile, 69, "unprovable-form"],
      [fixtureFile, 73, "unprovable-form"],
      [fixtureFile, 77, "unprovable-form"],
      [fixtureFile, 81, "unprovable-form"],
      [fixtureFile, 85, "unprovable-form"],
      [fixtureFile, 90, "not-sql"],
      [fixtureFile, 94, "not-sql"],
      ["infrastructure/event-core-postgres/pool.ts", 125, "not-sql"],
    ];
    for (const [file, line, outcome] of expectations) {
      expect(callAt(result, file, line)?.outcome, `${file}:${line}`).toBe(outcome);
    }
    expect(callAt(result, "bounded-contexts/auth/support/ucp-support/oauth.ts", 613)?.outcome).toBe("not-sql");
    expect(callAt(result, "bounded-contexts/customer-feedback/features/attention/api/route.ts", 44)?.outcome).toBe(
      "not-sql",
    );
    expect(callAt(result, "bounded-contexts/identity/features/api-keys/api/route.ts", 154)?.outcome).toBe("not-sql");
    expect(callAt(result, "contracts/event-core/projector.ts", 128)).toBeUndefined();
    const projectorLines = readFileSync(path.join(repoRoot, "contracts/event-core/projector.ts"), "utf8").split(
      /\r?\n/,
    );
    expect(projectorLines[127]).toContain('NonNullable<ProjectorHandlerContext["db"]>');
  });

  it("reports complete unprovable-form messages and only the sanctioned resolution", () => {
    const root = createContractRepo();
    const controlFile = "control.ts";
    writeFileSync(path.join(root, controlFile), 'export async function control(db) { await db.query("control"); }\n');
    const result = classify([controlFile], root);
    expect(result.violations).not.toHaveLength(0);
    for (const violation of result.violations) {
      expect(violation).toContain(controlFile);
      expect(violation).toMatch(/call \.(?:query|execute)\(\)/);
      expect(violation).toContain("receiver ");
      expect(violation).toMatch(
        /reason: (?:unresolvable declaration|unresolved module hop|bound exceeded|unsupported shape)/,
      );
      expect(violation).toContain(SANCTIONED_SQL_RECEIVER_RESOLUTION);
    }
    const source = readFileSync(path.join(repoRoot, "scripts/check-structure/sql-execution-surface.mjs"), "utf8");
    expect(source).not.toMatch(/\b(?:allowlist|exemption|bypass)\b/i);
  });
});

describe("SQL execution startup self-check negative controls", () => {
  it("fails with SQL_CONTRACT_NAME_MISSING when the contract loses a declaration", () => {
    const root = createContractRepo();
    const typesPath = path.join(root, "infrastructure", "event-core-postgres", "types.ts");
    writeFileSync(typesPath, readFileSync(typesPath, "utf8").replace("PgQueryable", "FormerPgQueryable"));
    expect(() => classify([], root)).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_CONTRACT_NAME_MISSING" }),
    );
  });

  it("fails with SQL_CONTRACT_REEXPORT_MISSING when the index loses its re-export", () => {
    const root = createContractRepo();
    const indexPath = path.join(root, "infrastructure", "event-core-postgres", "index.ts");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace('export * from "./types";', ""));
    expect(() => classify([], root)).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_CONTRACT_REEXPORT_MISSING" }),
    );
  });
});

describe("SQL execution diff scope fail-closed controls", () => {
  it.each([
    ["malformed CHANGED_FILES_JSON", "{", "SQL_CHANGED_FILES_INVALID_JSON"],
    ["non-array CHANGED_FILES_JSON", "{}", "SQL_CHANGED_FILES_NOT_ARRAY"],
  ])("%s", (_label, changedFilesJson, code) => {
    expect(() => deriveChangedSqlExecutionFiles({ repoRoot, changedFilesJson })).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code }),
    );
  });

  it.each([
    ["missing origin/main", ["merge-base", "origin/main", "HEAD"], "SQL_MERGE_BASE_FAILED"],
    ["failed diff", ["diff", "--name-only"], "SQL_DIFF_FAILED"],
  ])("%s", (_label, failingPrefix, code) => {
    const execGit = (args) => {
      if (args.slice(0, failingPrefix.length).join(" ") === failingPrefix.join(" ")) throw new Error("control");
      return "abc123\n";
    };
    expect(() => withoutChangedFilesJson(() => deriveChangedSqlExecutionFiles({ repoRoot, execGit }))).toThrowError(
      expect.objectContaining({ name: "SqlExecutionGuardError", code }),
    );
  });

  it("fails outside Git and accepts only a successfully derived empty diff", () => {
    expect(() =>
      withoutChangedFilesJson(() =>
        deriveChangedSqlExecutionFiles({
          repoRoot,
          execGit: () => {
            throw new Error("not git");
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ name: "SqlExecutionGuardError", code: "SQL_MERGE_BASE_FAILED" }));
    expect(
      withoutChangedFilesJson(() =>
        deriveChangedSqlExecutionFiles({
          repoRoot,
          execGit: (args) => (args[0] === "merge-base" ? "abc123\n" : ""),
        }),
      ),
    ).toEqual([]);
  });
});

describe("repository-wide SQL execution partition", () => {
  it("enumerates only cached Git index entries", () => {
    const calls = [];
    const files = listNonTestTypeScriptModules(repoRoot, {
      execGit: (args) => {
        calls.push(args);
        return [
          "src/tracked.ts",
          "src/tracked.mts",
          "src/tracked.test.ts",
          "src/tracked.d.ts",
          "src/fixtures/tracked.ts",
          "",
        ].join("\0");
      },
    });
    expect(calls).toEqual([["ls-files", "-z", "--cached"]]);
    expect(files).toEqual(["src/tracked.mts", "src/tracked.ts"]);
  });

  it("classifies every non-test TypeScript module and measures unresolved member roots", () => {
    const files = listNonTestTypeScriptModules(repoRoot);
    const result = classify(files);
    const actual = {
      sqlExecuting: result.modules.filter((module) => module.outcome === "sql-executing").map((module) => module.file),
      unprovableForm: result.modules
        .filter((module) => module.outcome === "unprovable-form")
        .map((module) => module.file),
      notSql: result.modules.filter((module) => module.outcome === "not-sql").map((module) => module.file),
      unresolvedMemberRoots: result.unresolvedMemberRoots,
    };
    const expected = JSON.parse(
      readFileSync(path.join(repoRoot, "scripts/check-structure/sql-execution-surface-partition.json"), "utf8"),
    );
    expect(actual).toEqual(expected);
    expect(result.modules).toHaveLength(files.length);
  }, 120_000);
});
