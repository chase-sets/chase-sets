import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findExecutableSqlCallSites,
  findReadModelDbCoverageViolations,
  isSqlBearingSource,
  parseTestDbScriptEntryFiles,
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

// `testDb`, when given, is the list of workspace-root-relative file paths
// the fixture's `test:db` script executes — mirroring the real repo's
// `vitest run --config ./tests/vitest.config.mjs <files...>` convention. A
// `*.db.test.ts` written to disk but omitted from this list must behave as
// an orphaned, never-executed test (see the "orphaned db test" regression
// below), so this is opt-in per test rather than baked into every fixture.
function writeWidgetsPackage(root, { testDb } = {}) {
  writePackageJson(root, "bounded-contexts/widgets", {
    name: "@chase-sets/widgets",
    exports: { ".": "./index.ts" },
    ...(testDb ? { scripts: { "test:db": `vitest run --config ./tests/vitest.config.mjs ${testDb.join(" ")}` } } : {}),
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

  it("does not treat a template-literal cache-key argument as SQL (overbroad query-lookalike regression)", () => {
    expect(isSqlBearingSource("cache.ts", "cache.query(`cache-key`);")).toBe(false);
  });

  it("does not treat a command-handler .execute() call as SQL (ambiguous-receiver regression)", () => {
    expect(
      isSqlBearingSource(
        "route.ts",
        `const result = await recoveredItems.execute(c.req.param("id"), command, c.get("context"));`,
      ),
    ).toBe(false);
  });

  it("detects db.query(helperCall(`SELECT ...`)) as SQL (helper-call argument shape, matches Catalog categories' catalogIsoUtcListSql idiom)", () => {
    expect(
      isSqlBearingSource(
        "queries.ts",
        `
          const result = await db.query(
            catalogIsoUtcListSql(\`SELECT * FROM catalog_admin_category_list_pages WHERE category_id = ANY($1::text[])\`, "updated_at"),
            [categoryIds],
          );
        `,
      ),
    ).toBe(true);
  });

  it("detects db.query(SQL_MAP[key]) as SQL when SQL_MAP is a locally-declared object literal of SQL templates (element-access argument shape, matches Discovery market-signals idiom)", () => {
    expect(
      isSqlBearingSource(
        "market-signals.ts",
        `
          const refreshOneMarketSignalSql = {
            discovery_search_items: \`UPDATE discovery_search_items SET lowest_price_amount = $2 WHERE catalog_item_id = $1\`,
          };
          async function refresh(db, catalogItemId, targetTable) {
            await db.query(refreshOneMarketSignalSql[targetTable], [catalogItemId]);
          }
        `,
      ),
    ).toBe(true);
  });

  it("detects db.query(SQL_MAP.key) as SQL (property-access argument shape)", () => {
    expect(
      isSqlBearingSource(
        "queries.ts",
        `
          const statements = { deleteMissing: \`DELETE FROM widgets WHERE id = $1\` };
          async function run(db, id) {
            await db.query(statements.deleteMissing, [id]);
          }
        `,
      ),
    ).toBe(true);
  });

  it("detects db.query(sql) as SQL when sql is a same-scope local constant bound to a template literal (identifier argument shape)", () => {
    expect(
      isSqlBearingSource(
        "queries.ts",
        `
          async function run(db, id) {
            const sql = \`SELECT * FROM widgets WHERE id = $1\`;
            await db.query(sql, [id]);
          }
        `,
      ),
    ).toBe(true);
  });

  it("does not treat db.query(sql) as SQL when sql is an unresolvable parameter (conservative exclusion, no interprocedural resolution)", () => {
    expect(
      isSqlBearingSource(
        "seed.ts",
        `
          async function rowExists(db, sql, params) {
            const existing = await db.query(sql, params);
            return existing.rows.length > 0;
          }
        `,
      ),
    ).toBe(false);
  });

  it("treats an aliased/wrapped SQL client call as SQL regardless of receiver shape", () => {
    expect(
      isSqlBearingSource(
        "shared-page-projection.ts",
        `
          async function apply(context, db) {
            await resolveProjectionDb(context, db).query(
              \`UPDATE collections_saved_list_shared_pages SET title = $2 WHERE list_id = $1\`,
              [listId, title],
            );
          }
        `,
      ),
    ).toBe(true);
  });
});

describe("parseTestDbScriptEntryFiles", () => {
  it("extracts the file-path arguments from a vitest test:db script, skipping the binary, flags, and config path", () => {
    const files = parseTestDbScriptEntryFiles(
      "vitest run --config ./tests/vitest.config.mjs features/orders/api/purchase-limits.db.test.ts features/orders/api/order-capacity.db.test.ts",
    );

    expect(files).toEqual([
      "features/orders/api/purchase-limits.db.test.ts",
      "features/orders/api/order-capacity.db.test.ts",
    ]);
  });

  it("returns an empty list for a script with no listed test files", () => {
    expect(parseTestDbScriptEntryFiles("vitest run --config ./tests/vitest.config.mjs")).toEqual([]);
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
    writeWidgetsPackage(root, { testDb: ["features/widgets/read-model/queries.db.test.ts"] });
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
    writeWidgetsPackage(root, { testDb: ["features/widgets/read-model/queries.db.test.ts"] });
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

  it("fails when a *.db.test.ts exists on disk but is not listed in the workspace's test:db script (orphaned db test, regression for PR #6068 finding 2)", async () => {
    const root = createRepo();
    // test:db lists a different, real file — mirrors bounded-contexts/ordering's
    // package.json, where queries.db.test.ts exists on disk but is absent from
    // test:db and therefore never executes in CI.
    writeWidgetsPackage(root, { testDb: ["features/widgets/read-model/other.db.test.ts"] });
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/other.db.test.ts",
      `describe("other", () => { it("is unrelated", () => {}); });`,
    );
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.db.test.ts",
      `import { listWidgets } from "./queries";`,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({ file: "bounded-contexts/widgets/features/widgets/read-model/queries.ts" }),
    ]);
  });

  it("flags a changed module whose SQL is passed via a helper-call argument (Catalog categories idiom regression)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.ts",
      `
        import type { PgQueryable } from "@chase-sets/event-core-postgres";
        import { catalogIsoUtcListSql } from "../../../support/runtime-support/iso-utc-timestamp";
        export async function getWidgetDetail(db: PgQueryable, widgetId: string) {
          const result = await db.query(
            catalogIsoUtcListSql(\`SELECT * FROM widget_detail_pages WHERE widget_id = $1\`, "updated_at"),
            [widgetId],
          );
          return result.rows[0] ?? null;
        }
      `,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({ file: "bounded-contexts/widgets/features/widgets/read-model/queries.ts" }),
    ]);
  });

  it("flags a changed module whose SQL is passed via an element-access argument (Discovery market-signals idiom regression)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/market-signals.ts",
      `
        import type { PgQueryable } from "@chase-sets/event-core-postgres";
        const refreshOneMarketSignalSql: Readonly<Record<string, string>> = {
          widgets: \`UPDATE widget_search_items SET lowest_price_amount = $2 WHERE catalog_item_id = $1\`,
        };
        export async function refreshMarketSignals(db: PgQueryable, catalogItemId: string, targetTable: string) {
          await db.query(refreshOneMarketSignalSql[targetTable], [catalogItemId]);
        }
      `,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/market-signals.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({ file: "bounded-contexts/widgets/features/widgets/read-model/market-signals.ts" }),
    ]);
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

describe("diff discovery fails closed (regression for PR #6068 finding 3)", () => {
  const originalChangedFilesJson = process.env.CHANGED_FILES_JSON;

  afterEach(() => {
    if (originalChangedFilesJson === undefined) {
      delete process.env.CHANGED_FILES_JSON;
    } else {
      process.env.CHANGED_FILES_JSON = originalChangedFilesJson;
    }
  });

  it("reports a named violation instead of an empty pass when CHANGED_FILES_JSON is malformed JSON", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    process.env.CHANGED_FILES_JSON = "{not valid json";

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/CHANGED_FILES_JSON is not valid JSON/);
  });

  it("reports a named violation when CHANGED_FILES_JSON is valid JSON but not an array of strings", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    process.env.CHANGED_FILES_JSON = JSON.stringify({ files: ["a.ts"] });

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/CHANGED_FILES_JSON must be a JSON array of strings/);
  });

  it("passes on a genuinely empty CHANGED_FILES_JSON array (empty diff is not indeterminate)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    process.env.CHANGED_FILES_JSON = "[]";

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
    });

    expect(violations).toEqual([]);
  });

  it("reports a named violation instead of an empty pass when git merge-base is indeterminate (no CHANGED_FILES_JSON, not a git repo)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root);
    delete process.env.CHANGED_FILES_JSON;

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toMatch(/merge-base/);
  });
});

describe("dynamic import reachability (regression for PR #6068 finding 4)", () => {
  it("treats a module-top-level dynamic import() as reachable (actually-evaluated import)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root, { testDb: ["features/widgets/read-model/queries.db.test.ts"] });
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.db.test.ts",
      `const queriesModule = await import("./queries");`,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([]);
  });

  it("does not treat a dynamic import() nested inside a never-called function as reachable (over-approximation regression)", async () => {
    const root = createRepo();
    writeWidgetsPackage(root, { testDb: ["features/widgets/read-model/queries.db.test.ts"] });
    writeSource(root, "bounded-contexts/widgets/features/widgets/read-model/queries.ts", queriesSource);
    writeSource(
      root,
      "bounded-contexts/widgets/features/widgets/read-model/queries.db.test.ts",
      `
        async function neverCalled() {
          return import("./queries");
        }
        describe("unrelated", () => { it("does nothing with neverCalled", () => {}); });
      `,
    );

    const violations = await findReadModelDbCoverageViolations({
      repoRoot: root,
      contextManifests: widgetsContext(),
      changedFilePaths: ["bounded-contexts/widgets/features/widgets/read-model/queries.ts"],
    });

    expect(violations).toEqual([
      expect.objectContaining({ file: "bounded-contexts/widgets/features/widgets/read-model/queries.ts" }),
    ]);
  });
});
