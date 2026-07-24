import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findExecutableSqlCallSites,
  findReadModelDbCoverageViolations,
  isSqlBearingSource,
  validateReadModelDbCoverage,
} from "./read-model-db-coverage.mjs";
import ts from "@chase-sets/typescript-compiler-api";

const tempRoots = [];

function createRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-read-model-db-coverage-"));
  tempRoots.push(root);
  return root;
}

function writeSource(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${content.trim()}\n`, "utf8");
}

function writePackageJson(root, relativeDir, packageJson) {
  writeSource(root, `${relativeDir}/package.json`, JSON.stringify(packageJson, null, 2));
}

function contextManifestsFor(entries) {
  return new Map(entries.map((entry) => [entry.root, entry]));
}

function widgetsContext() {
  return contextManifestsFor([{ root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" }]);
}

function writeWidgetsPackage(root) {
  writePackageJson(root, "bounded-contexts/widgets", {
    name: "@chase-sets/widgets",
    exports: { ".": "./index.ts" },
  });
  writeSource(root, "bounded-contexts/widgets/index.ts", `export const module = {};`);
}

const queriesSource = `
  import type { PgQueryable } from "@chase-sets/event-core-postgres";
  export async function listWidgets(db: PgQueryable) {
    const result = await db.query(\`SELECT id FROM widgets WHERE state = $1\`, ["active"]);
    return result.rows;
  }
`;

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("findExecutableSqlCallSites / isSqlBearingSource", () => {
  function parse(source) {
    return ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  }

  it("detects db.query(`...`) and pool.execute(`...`) template-literal calls", () => {
    const sites = findExecutableSqlCallSites(
      parse(`
        db.query(\`SELECT 1\`);
        pool.execute(\`UPDATE widgets SET state = $1\`, [state]);
      `),
    );
    expect(sites.map((site) => site.methodName)).toEqual(["query", "execute"]);
  });

  it("does not treat a string-literal query-param accessor as SQL (Hono's c.req.query('id'))", () => {
    expect(isSqlBearingSource("route.ts", `const id = c.req.query("id");`)).toBe(false);
  });

  it("does not treat an unrelated .query() call without a template-literal argument as SQL", () => {
    expect(isSqlBearingSource("module.ts", `store.query("some-key");`)).toBe(false);
  });
});

describe("findReadModelDbCoverageViolations", () => {
  it("fails a changed SQL-bearing module with no db-test importer (negative control)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({
        file: "bounded-contexts/widgets/features/widgets/read-model/queries.ts",
        workspace: "@chase-sets/widgets",
      }),
    ]);
    expect(violations[0].message).toContain("bounded-contexts/widgets/features/widgets/read-model/queries.ts");
    expect(violations[0].message).toContain("@chase-sets/widgets");
    expect(violations[0].message).toContain("*.db.test.ts");
  });

  it("passes when a *.db.test.ts imports the module (positive fixture)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.db.test.ts",
      `
        import { listWidgets } from "./queries";
        describe("listWidgets", () => {
          it("works", async () => {
            await listWidgets(fakeDb);
          });
        });
      `,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([]);
  });

  it("still passes when the db test reaches the module transitively through another file", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/index.ts",
      `export { listWidgets } from "./queries";`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.db.test.ts",
      `import { listWidgets } from "./index";`,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([]);
  });

  it("ignores unchanged modules even when a fixture is present in base and current (merge-base scoping)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    // No *.db.test.ts importer exists, but the module is not in changedFilePaths
    // (as if it were present, unmodified, in both merge-base and HEAD).

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: [],
    });

    expect(violations).toEqual([]);
  });

  it("does not flag a changed module by path vocabulary alone when it has no SQL call shape", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/format.ts",
      `export function formatWidgetLabel(id: string) { return \`widget:\${id}\`; }`,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/format.ts"],
    });

    expect(violations).toEqual([]);
  });

  it("flags a SQL-bearing module outside read-model/ (shape-based, not path-based, detection)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/support/write-cursor.ts", queriesSource);

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/support/write-cursor.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({ file: "bounded-contexts/widgets/features/widgets/support/write-cursor.ts" }),
    ]);
  });

  it("does not require a db-test importer from a different bounded context", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writePackageJson(root, "bounded-contexts/other", { name: "@chase-sets/other", exports: { ".": "./index.ts" } });
    writeSource(root, "bounded-contexts/other/index.ts", `export const module = {};`);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/other/features/other/read-model/queries.db.test.ts",
      `import { listWidgets } from "../../../../widgets/features/widgets/read-model/queries";`,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: contextManifestsFor([
        { root: "bounded-contexts/widgets", packageName: "@chase-sets/widgets" },
        { root: "bounded-contexts/other", packageName: "@chase-sets/other" },
      ]),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe("bounded-contexts/widgets/features/widgets/read-model/queries.ts");
  });

  it("keeps every real bounded context's changed SQL-bearing modules covered by a db test (clean checkout)", async () => {
    const result = await validateReadModelDbCoverage();

    expect(result.violations, result.violations.join("\n")).toEqual([]);
  }, 30_000);
});

describe("validateReadModelDbCoverage", () => {
  it("returns violation messages naming the module, workspace, and expected test shape", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);

    const result = await validateReadModelDbCoverage({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("bounded-contexts/widgets/features/widgets/read-model/queries.ts");
    expect(result.violations[0]).toContain("@chase-sets/widgets");
    expect(result.violations[0]).toContain("*.db.test.ts");
    expect(result.warnings).toEqual([]);
  });
});
