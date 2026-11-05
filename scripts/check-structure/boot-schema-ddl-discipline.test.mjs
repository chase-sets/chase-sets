import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractExportedBootSchemaSqlTemplates,
  extractBootSchemaTableColumns,
  extractSchemaMigrationStatements,
  findBootSchemaMigrationAddedIndexViolationsInSource,
  findBootSchemaDdlDisciplineViolations,
  findBootSchemaLedgerConvergenceViolations,
  findBootSchemaRetainedUpgradeViolations,
  findSchemaMigrationDdlSafetyViolationsInSource,
  isFastDefaultSafeExpression,
} from "./boot-schema-ddl-discipline.mjs";

function findInlineViolations(source) {
  const templates = extractExportedBootSchemaSqlTemplates(source);
  return templates.flatMap((template) => {
    const violations = [];
    if (/\bDROP\s+(?:INDEX|TABLE|COLUMN|CONSTRAINT)\b/i.test(template.sql)) {
      violations.push("DROP");
    }
    if (/\bALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\s+NOT\s+NULL\b/i.test(template.sql)) {
      violations.push("SET NOT NULL");
    }
    if (/\bUPDATE\s+(?!SET\b)[A-Za-z_][A-Za-z0-9_.]*/i.test(template.sql)) {
      violations.push("UPDATE");
    }
    return violations;
  });
}

function bootSchemaSource(sql) {
  return `export const exampleSchemaSql = \`${sql}\`;`;
}

function retainedUpgradeKeys({ baseSource, currentSource }) {
  return findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource }).map(
    ({ tableName, columnName }) => `${tableName}.${columnName}`,
  );
}

function orderedRevisionSources() {
  const normalizers = [
    "UPDATE settlement_account_risk_sources SET trusted_seller = false WHERE trusted_seller IS NULL",
    "UPDATE settlement_account_risk_sources SET review_count = 0 WHERE review_count IS NULL",
  ];
  const schema = `CREATE TABLE IF NOT EXISTS settlement_account_risk_sources (
    account_id text PRIMARY KEY, trusted_seller boolean, review_count integer
  );`;
  const ledger = `export const exampleSchemaMigrations = [
    { migrationId: "normalize_flags", statements: [\`${normalizers[0]}\`] },
    { migrationId: "normalize_counts", statements: [\`SET LOCAL lock_timeout = '2s'; ${normalizers[1]};\`] },
  ];`;
  const baseSource = `${bootSchemaSource(schema)}\n${ledger}`;
  const expansion =
    "ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0";
  const currentSource = baseSource
    .replace("account_id text PRIMARY KEY,", "account_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0,")
    .replace(/\];$/, `{ migrationId: "add_revision", statements: [\`${expansion}\`] },\n];`);
  return { baseSource, currentSource, normalizers, expansion };
}

function orderedTransitionSources({
  createDefinition = "bigint DEFAULT 0",
  addDefinition = createDefinition,
  before = [],
  after = [],
  addTail = "",
  later = [],
  sibling = [],
  createTail = "",
  extraColumns = "",
  addTarget = "synthetic_ordered_rows",
  addColumn = "revision",
  named = false,
  bootAfter = "",
} = {}) {
  const table = "synthetic_ordered_rows";
  const boot = (extra) =>
    bootSchemaSource(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, value bigint${extra})${createTail};`);
  const entry = (id, statements) =>
    `{ migrationId: "${id}", statements: [${statements.map((sql) => `\`${sql}\``).join(", ")}] }`;
  const normalizer = entry("normalize", [`UPDATE ${table} SET value = 0 WHERE value IS NULL`]);
  const ledger = (entries) => `export const exampleSchemaMigrations = [${entries.join(", ")}];`;
  const add = `ALTER TABLE ${addTarget} ADD COLUMN IF NOT EXISTS ${addColumn} ${addDefinition}${addTail}`;
  let currentSource = `${boot(`, revision ${createDefinition}${extraColumns}`)}${bootAfter}\n${ledger([
    normalizer,
    entry("add_revision", ["SET LOCAL lock_timeout = '2s'", ...before, add, ...after]),
    ...(later.length ? [entry("later", later)] : []),
  ])}`;
  if (sibling.length) {
    currentSource += `\nexport const otherSchemaMigrations = [${entry("sibling", sibling)}];`;
  }
  if (named) {
    const sql = after[0];
    currentSource = `const laterSql = \`${sql}\`;\n${currentSource.replace(`\`${sql}\``, "laterSql")}`;
  }
  return { baseSource: `${boot("")}\n${ledger([normalizer])}`, currentSource };
}

function orderedTransitionNegatives() {
  const table = "synthetic_ordered_rows";
  const writer = `UPDATE ${table} SET revision = revision + 1`;
  return [
    ["wrong type", { addDefinition: "text DEFAULT 0" }],
    ["missing default", { addDefinition: "bigint" }],
    ["extra default", { createDefinition: "bigint", addDefinition: "bigint DEFAULT 0" }],
    ["different default", { addDefinition: "bigint DEFAULT 1" }],
    ["missing NOT NULL", { createDefinition: "bigint NOT NULL DEFAULT 0", addDefinition: "bigint DEFAULT 0" }],
    ["extra NOT NULL", { addDefinition: "bigint NOT NULL DEFAULT 0" }],
    ["missing explicit NULL", { createDefinition: "bigint NULL DEFAULT 0", addDefinition: "bigint DEFAULT 0" }],
    ["different equal-length strings", { createDefinition: "text DEFAULT 'ab'", addDefinition: "text DEFAULT 'cd'" }],
    ["different literal case", { createDefinition: "text DEFAULT 'Ab'", addDefinition: "text DEFAULT 'ab'" }],
    ["different raw spacing", { addDefinition: "bigint  DEFAULT 0" }],
    ["unknown matching type", { createDefinition: "custom_scalar" }],
    ["domain matching type", { createDefinition: "public.custom_domain" }],
    ["matching precision", { createDefinition: "numeric(10, 2) DEFAULT 0" }],
    ["differing precision", { createDefinition: "numeric(10, 2)", addDefinition: "numeric(12, 2)" }],
    ["matching array", { createDefinition: "bigint[]" }],
    ["differing array", { addDefinition: "bigint[] DEFAULT 0" }],
    ["matching cast", { createDefinition: "bigint DEFAULT 0::bigint" }],
    ["differing cast", { addDefinition: "bigint DEFAULT 0::integer" }],
    ["matching collate", { createDefinition: 'text COLLATE "C"' }],
    ["matching generated", { createDefinition: "bigint GENERATED ALWAYS AS (1) STORED" }],
    ["matching identity", { createDefinition: "bigint GENERATED ALWAYS AS IDENTITY" }],
    ["matching CHECK", { createDefinition: "bigint CHECK (revision >= 0)" }],
    ["matching REFERENCES", { createDefinition: "bigint REFERENCES other_rows(id)" }],
    ["matching storage", { createDefinition: "text STORAGE PLAIN" }],
    ["matching unresolved default", { createDefinition: "bigint DEFAULT hidden_value()" }],
    ["duplicate target declaration", { extraColumns: ", revision bigint DEFAULT 0" }],
    ["target table CHECK", { extraColumns: ", CHECK (revision >= 0)" }],
    ["target table constraint", { extraColumns: ", CONSTRAINT valid_revision CHECK (revision >= 0)" }],
    ["target-dependent other column", { extraColumns: ", computed bigint GENERATED ALWAYS AS (revision) STORED" }],
    ["LIKE clause", { extraColumns: ", LIKE other_rows" }],
    ["INHERITS tail", { createTail: " INHERITS (other_rows)" }],
    ["partition tail", { createTail: " PARTITION BY HASH (revision)" }],
    ["unresolved CREATE tail", { createTail: " WITH (fillfactor = 90)" }],
    [
      "ambiguous CREATE ownership",
      { bootAfter: "\nexport const otherSchemaSql = `CREATE TABLE IF NOT EXISTS synthetic_ordered_rows (id text);`;" },
    ],
    ["same ALTER DROP", { createDefinition: "bigint", addTail: ", DROP COLUMN revision" }],
    ["same ALTER ALTER", { createDefinition: "bigint", addTail: ", ALTER COLUMN revision TYPE text" }],
    ["extra ADD tail tokens", { addTail: " unexpected" }],
    ["duplicate ADD", { after: [`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS revision bigint DEFAULT 0`] }],
    ["quoted target table", { addTarget: '"synthetic_ordered_rows"' }],
    ["qualified target table", { addTarget: "public.synthetic_ordered_rows" }],
    ["ONLY target table", { addTarget: `ONLY ${table}` }],
    ["quoted target column", { addColumn: '"revision"' }],
    ...[
      ["DROP column", `ALTER TABLE ${table} DROP COLUMN revision`],
      ["RENAME column", `ALTER TABLE ${table} RENAME COLUMN revision TO removed_revision`],
      ["TYPE", `ALTER TABLE ${table} ALTER COLUMN revision TYPE text`],
      ["SET DATA TYPE", `ALTER TABLE ${table} ALTER COLUMN revision SET DATA TYPE text`],
      ["SET DEFAULT", `ALTER TABLE ${table} ALTER COLUMN revision SET DEFAULT 1`],
      ["DROP DEFAULT", `ALTER TABLE ${table} ALTER COLUMN revision DROP DEFAULT`],
      ["SET NOT NULL", `ALTER TABLE ${table} ALTER COLUMN revision SET NOT NULL`],
      ["DROP NOT NULL", `ALTER TABLE ${table} ALTER COLUMN revision DROP NOT NULL`],
      ["DROP table", `DROP TABLE ${table}`],
      ["RENAME table", `ALTER TABLE ${table} RENAME TO removed_rows`],
      ["SET SCHEMA", `ALTER TABLE ${table} SET SCHEMA elsewhere`],
      ["other column DDL", `ALTER TABLE ${table} ADD COLUMN harmless bigint`],
      ["identity suffix", `ALTER TABLE ${table} ALTER COLUMN revision ADD GENERATED ALWAYS AS IDENTITY`],
      ["constraint suffix", `ALTER TABLE ${table} ADD CONSTRAINT valid CHECK (value >= 0)`],
      ["opaque DO", "DO $$ BEGIN PERFORM hidden_mutator(); END $$"],
      ["opaque CALL", "CALL hidden_mutator()"],
      ["opaque EXECUTE", "EXECUTE 'SELECT 1'"],
      ["SELECT call", "SELECT hidden_mutator()"],
      ["writable CTE", `WITH changed AS (DELETE FROM ${table} RETURNING *) SELECT 1`],
      ["unresolved UPDATE", `UPDATE ${table} SET value = hidden_mutator()`],
      ["unresolved UPDATE default", `UPDATE ${table} SET value = DEFAULT`],
      ["unresolved INSERT", "INSERT INTO other_rows VALUES (1)"],
      ["harmless unknown statement", "VALUES (1)"],
      ["unresolved setting", "SET search_path = elsewhere"],
      ["extra statement tail", "SELECT 1 unexpected"],
    ].map(([name, sql]) => [name, { after: [sql, writer] }]),
    ["same literal suffix", { addTail: `; ALTER TABLE ${table} DROP COLUMN revision; ${writer}` }],
    ["named literal suffix", { after: [`ALTER TABLE ${table} DROP COLUMN revision`, writer], named: true }],
    ["later migration", { later: ["SET LOCAL lock_timeout = '2s'", `DROP TABLE ${table}`, writer] }],
    ["appended pre-ADD DROP table", { before: [`DROP TABLE ${table}`] }],
    ["appended pre-ADD RENAME table", { before: [`ALTER TABLE ${table} RENAME TO gone`] }],
    ["appended pre-ADD SET SCHEMA", { before: [`ALTER TABLE ${table} SET SCHEMA elsewhere`] }],
    ["appended pre-ADD unknown", { before: ["VALUES (1)"] }],
    ["sibling table DROP", { sibling: [`DROP TABLE ${table}`] }],
    ["sibling table RENAME", { sibling: [`ALTER TABLE ${table} RENAME TO gone`] }],
    ["sibling table SET SCHEMA", { sibling: [`ALTER TABLE ${table} SET SCHEMA elsewhere`] }],
    ["sibling unknown after inert SQL", { sibling: ["SELECT 1", "VALUES (1)"] }],
    ["comment hides only a fake ADD", { before: ["/*"], addTail: " */" }],
    ["unclosed comment", { after: ["/* unfinished"] }],
    ["unclosed literal", { after: ["SELECT 'unfinished"] }],
    ["unbalanced delimiter", { addTail: ")" }],
    ["dollar-quoted boundary", { after: ["SELECT $$safe; hidden$$"] }],
    ["escaped SQL literal", { after: [String.raw`SELECT E'line\\n'`] }],
    ["unresolved quoted boundary", { after: ['SELECT "unfinished'] }],
  ];
}

describe("boot schema DDL discipline", () => {
  it("extracts all five Pricing Product Line migration statements without opaque transformations", async () => {
    const source = await readFile(
      new URL(
        "../../bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const migration = extractSchemaMigrationStatements(source)[0];
    expect(migration.statements).toHaveLength(5);
    expect(migration.statements[0].sql).toContain("CREATE TABLE IF NOT EXISTS pricing_catalog_reference_inputs");
    expect(migration.statements[0].sql).not.toMatch(/CREATE INDEX/i);
    expect(migration.statements[1].sql).toMatch(/CREATE INDEX CONCURRENTLY/i);
    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
  });

  it("extracts exported boot schema SQL templates only", () => {
    const source = `
const migrationBackfillSql = \`UPDATE example_pages SET value = 'x';\`;
export const exampleSchemaMigrations = [
  { migrationId: "m1", description: "ok", statements: [migrationBackfillSql] },
];

export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);
\`;
`;

    expect(extractExportedBootSchemaSqlTemplates(source)).toEqual([
      expect.objectContaining({
        name: "exampleSchemaSql",
        sql: expect.stringContaining("CREATE TABLE IF NOT EXISTS example_pages"),
      }),
    ]);
    expect(findInlineViolations(source)).toEqual([]);
  });

  it("flags destructive or backfill DDL inside boot schema SQL", () => {
    const source = `
export const exampleSchemaSql = \`
ALTER TABLE example_pages ALTER COLUMN value SET NOT NULL;
DROP INDEX IF EXISTS example_pages_value_idx;
UPDATE example_pages SET value = '';
\`;
`;

    expect(findInlineViolations(source)).toEqual(["DROP", "SET NOT NULL", "UPDATE"]);
  });

  it("extracts inline and named statements from exported schema migration ledgers", () => {
    const source = `
const exampleLookupIndexSql = \`CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_lookup_idx
  ON example_pages (lookup_key);\`;

export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "ok",
    statements: [
      \`SET LOCAL lock_timeout = '2s'\`,
      exampleLookupIndexSql,
    ],
  },
];
`;

    expect(extractSchemaMigrationStatements(source)).toEqual([
      expect.objectContaining({
        ledgerName: "exampleSchemaMigrations",
        statements: [
          expect.objectContaining({ sql: "SET LOCAL lock_timeout = '2s'" }),
          expect.objectContaining({ sql: expect.stringContaining("CREATE INDEX CONCURRENTLY") }),
        ],
      }),
    ]);
  });

  it("extracts fresh-boot columns without mistaking table constraints or type commas for columns", () => {
    const source = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY,
  amount numeric(12, 2) NOT NULL DEFAULT 0,
  state text NOT NULL,
  CONSTRAINT example_pages_state_check CHECK (state IN ('open', 'closed')),
  UNIQUE (state, id)
);
\`;
`;

    expect([...(extractBootSchemaTableColumns(source).get("example_pages") ?? [])]).toEqual(["id", "amount", "state"]);
  });

  it("rejects the #4834 pattern when a fresh-boot column has no existing-database migration", () => {
    const baseSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY
);
\`;
`;
    const currentSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY,
  authenticity_fee_amount numeric(12, 2) NOT NULL DEFAULT 0
);
\`;
`;

    expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource })).toEqual([
      expect.objectContaining({
        tableName: "example_pages",
        columnName: "authenticity_fee_amount",
        message: expect.stringContaining("#4834"),
      }),
    ]);
  });

  it("accepts a fresh-boot column reachable through an exported migration ledger", () => {
    const baseSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);
\`;
`;
    const currentSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY,
  authenticity_fee_amount numeric(12, 2) NOT NULL DEFAULT 0
);
\`;
export const exampleSchemaMigrations = [{
  migrationId: "m1",
  description: "converge existing rows",
  statements: [
    \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS authenticity_fee_amount numeric(12, 2) NOT NULL DEFAULT 0\`,
  ],
}];
`;

    expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource })).toEqual([]);
  });

  it("flags the exact 6feb1454 Pricing source without retained-schema boot expansions", () => {
    const failedSource = execFileSync(
      "git",
      [
        "show",
        "6feb1454cecb4a73a90845103a9a0de2a336eaad:bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts",
      ],
      { encoding: "utf8" },
    );
    const retainedSource = execFileSync(
      "git",
      [
        "show",
        "3edef8e981847f1aa16c97e13efcdeda7063608e:bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts",
      ],
      { encoding: "utf8" },
    );

    expect(
      findBootSchemaRetainedUpgradeViolations({ baseSource: retainedSource, currentSource: failedSource }),
    ).toEqual([
      expect.objectContaining({
        tableName: "pricing_market_listing_inputs",
        columnName: "price_currency_code",
      }),
      expect.objectContaining({
        tableName: "pricing_buyer_offer_inputs",
        columnName: "price_currency_code",
      }),
    ]);
  });

  it("accepts the repaired Pricing source with retained-schema boot expansions", async () => {
    const repairedSource = await readFile(
      new URL(
        "../../bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const retainedSource = execFileSync(
      "git",
      [
        "show",
        "3edef8e981847f1aa16c97e13efcdeda7063608e:bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts",
      ],
      { encoding: "utf8" },
    );

    expect(
      findBootSchemaRetainedUpgradeViolations({ baseSource: retainedSource, currentSource: repairedSource }),
    ).toEqual([]);
  });

  describe("ordered source validation", () => {
    describe("whole definition and transition admission", () => {
      it.each(orderedTransitionNegatives())("refuses %s", (_name, options) => {
        expect(
          findBootSchemaRetainedUpgradeViolations(orderedTransitionSources(options)).map(
            ({ columnName }) => columnName,
          ),
        ).toContain("revision");
      });

      it.each([
        {},
        { createDefinition: "bigint NOT NULL DEFAULT 0" },
        { createDefinition: "bigint DEFAULT 0 NOT NULL" },
        { createDefinition: "text DEFAULT 'a;b,c'" },
        { createDefinition: "text DEFAULT 'can''t'" },
        { after: ["UPDATE synthetic_ordered_rows SET revision = revision + 1"] },
        { before: ["UPDATE synthetic_ordered_rows SET value = 0 WHERE value IS NULL"] },
        { after: ["SELECT 'literal; comma, DROP TABLE synthetic_ordered_rows'", "SELECT 1"] },
        { addTail: "; -- comment; comma,\n SELECT 1" },
        { after: ["/* nested /* ; */ comment */ SELECT 1"] },
        { after: ["SELECT 1"], named: true },
        { later: ["UPDATE synthetic_ordered_rows SET revision = revision + 1"] },
        { sibling: ["SELECT 1", "UPDATE other_rows SET value = 0 WHERE value IS NULL"] },
      ])("preserves the supported complete sequence: %j", (options) => {
        expect(findBootSchemaRetainedUpgradeViolations(orderedTransitionSources(options))).toEqual([]);
      });

      it.each([
        { addDefinition: "text DEFAULT 0" },
        { after: ["ALTER TABLE synthetic_ordered_rows DROP COLUMN revision"] },
        { after: ["ALTER TABLE synthetic_ordered_rows RENAME COLUMN revision TO gone"] },
      ])("does not substitute another public guard for the ordered proof: %j", (options) => {
        const sources = orderedTransitionSources(options);
        expect(findBootSchemaLedgerConvergenceViolations(sources)).toEqual([]);
        expect(findSchemaMigrationDdlSafetyViolationsInSource(sources.currentSource, sources)).toEqual([]);
        expect(findBootSchemaRetainedUpgradeViolations(sources).map(({ columnName }) => columnName)).toEqual([
          "revision",
        ]);
      });

      it("reaches definition and suffix refusal through changed schema scanner discovery", async () => {
        const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-ddl-discipline-"));
        const relativeFilePath =
          "bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts";
        const filePath = path.join(repoRoot, relativeFilePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, orderedTransitionSources().baseSource, "utf8");
        try {
          const git = (args) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
          git(["init"]);
          git(["add", relativeFilePath]);
          git([
            "-c",
            "user.name=Schema Test",
            "-c",
            "user.email=schema@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "test: base schema",
          ]);
          git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
          for (const options of [
            { addDefinition: "text DEFAULT 0" },
            { after: ["ALTER TABLE synthetic_ordered_rows DROP COLUMN revision"] },
          ]) {
            await writeFile(filePath, orderedTransitionSources(options).currentSource, "utf8");
            expect(
              await findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths: [relativeFilePath] }),
            ).toEqual([
              expect.objectContaining({
                file: relativeFilePath,
                message: expect.stringContaining("has no idempotent boot ADD COLUMN expansion"),
              }),
            ]);
          }
          expect(await findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths: [] })).toEqual([]);
        } finally {
          await rm(repoRoot, { recursive: true, force: true });
        }
      });
    });

    it("accepts the ordered account-risk revision without a boot ADD", () => {
      const { baseSource, currentSource, normalizers, expansion } = orderedRevisionSources();
      const boot = extractExportedBootSchemaSqlTemplates(currentSource);
      expect(boot).toHaveLength(1);
      expect(boot[0].name).toBe("exampleSchemaSql");
      expect(boot[0].sql).toContain("revision bigint NOT NULL DEFAULT 0");
      expect(boot[0].sql).not.toContain("ADD COLUMN");
      const migrations = extractSchemaMigrationStatements(currentSource);
      expect(migrations.map((migration) => migration.ledgerName)).toEqual(Array(3).fill("exampleSchemaMigrations"));
      expect(migrations.slice(0, 2)).toEqual(extractSchemaMigrationStatements(baseSource));
      normalizers.forEach((sql, index) => {
        expect(migrations[index].statements[0].sql).toContain(sql);
        expect(migrations[index].statements[0].sql).not.toContain("revision");
      });
      expect(migrations[2].statements[0].sql).toBe(expansion);
      expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource })).toEqual([]);
      expect(findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource })).toEqual([]);
      expect(findSchemaMigrationDdlSafetyViolationsInSource(currentSource, { baseSource })).toEqual([]);
      expect(findBootSchemaRetainedUpgradeViolations({ baseSource: currentSource, currentSource })).toEqual([]);
    });

    it.each([
      ["missing ledger", (source) => source.slice(0, source.indexOf("export const exampleSchemaMigrations"))],
      ["wrong ledger", (source) => source.replace("exampleSchemaMigrations", "otherSchemaMigrations")],
      [
        "wrong table",
        (source) => source.replace("ALTER TABLE settlement_account_risk_sources", "ALTER TABLE other_sources"),
      ],
      ["wrong column", (source) => source.replace("EXISTS revision", "EXISTS other_revision")],
      ["non-idempotent ADD", (source) => source.replace("ADD COLUMN IF NOT EXISTS revision", "ADD COLUMN revision")],
      ["missing type", (source) => source.replace("EXISTS revision bigint NOT NULL DEFAULT 0", "EXISTS revision")],
      [
        "duplicate migration id",
        (source) => source.replace('migrationId: "add_revision"', 'migrationId: "normalize_flags"'),
      ],
      ["missing migration id", (source) => source.replace('migrationId: "add_revision",', "")],
      [
        "duplicate ADD",
        (source) =>
          source.replace(
            "EXISTS revision bigint NOT NULL DEFAULT 0",
            "EXISTS revision bigint; ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS revision bigint",
          ),
      ],
      [
        "changed immutable normalizer",
        (source) => source.replace("SET trusted_seller = false", "SET trusted_seller = true"),
      ],
      [
        "unresolved statement",
        (source) => source.replace("statements: [`ALTER TABLE", "statements: [missingSql, `ALTER TABLE"),
      ],
      [
        "opaque statement expression",
        (source) =>
          source
            .replace("statements: [`ALTER TABLE", "statements: [wrap(`ALTER TABLE")
            .replace("DEFAULT 0`]", "DEFAULT 0`)]"),
      ],
      ["interpolated SQL", (source) => source.replace("EXISTS revision bigint", "EXISTS ${column} bigint")],
      [
        "interpolated boot SQL",
        (source) => source.replace("review_count integer\n  );", "review_count integer\n  ); ${consumer}"),
      ],
      [
        "duplicate exported ledger",
        (source) => `${source}\n${source.slice(source.indexOf("export const exampleSchemaMigrations"))}`,
      ],
      [
        "duplicate boot column",
        (source) => source.replace("account_id text PRIMARY KEY,", "account_id text PRIMARY KEY, revision bigint,"),
      ],
      [
        "duplicate boot export",
        (source) =>
          `${source}\nexport const exampleSchemaSql = \`CREATE TABLE IF NOT EXISTS other_sources (id text);\`;`,
      ],
      [
        "commented ledger",
        (source) => source.replace("export const exampleSchemaMigrations", "// export const exampleSchemaMigrations"),
      ],
      [
        "string ledger",
        (source) =>
          `${source.slice(0, source.indexOf("export const exampleSchemaMigrations"))}\nconst fake = ${JSON.stringify(source.slice(source.indexOf("export const exampleSchemaMigrations")))};`,
      ],
      ["commented ADD", (source) => source.replace("`ALTER TABLE", "`-- ALTER TABLE")],
      [
        "quoted ADD",
        (source) => source.replace("`ALTER TABLE", "`SELECT 'ALTER TABLE").replace("DEFAULT 0`]", "DEFAULT 0'`]"),
      ],
      [
        "dollar-quoted ADD",
        (source) => source.replace("`ALTER TABLE", "`DO $$ ALTER TABLE").replace("DEFAULT 0`]", "DEFAULT 0 $$`]"),
      ],
      [
        "boot consumer",
        (source) =>
          source.replace(
            "review_count integer\n  );",
            "review_count integer\n  ); CREATE INDEX IF NOT EXISTS risk_revision_idx ON settlement_account_risk_sources (revision);",
          ),
      ],
      [
        "later boot template consumer",
        (source) =>
          `${source}\nexport const otherSchemaSql = \`CREATE INDEX IF NOT EXISTS risk_revision_idx ON settlement_account_risk_sources (revision);\`;`,
      ],
      [
        "implicit boot consumer",
        (source) => `${source}\nexport const otherSchemaSql = \`SELECT * FROM settlement_account_risk_sources;\`;`,
      ],
      [
        "opaque earlier ledger consumer",
        (source) => source.replace("`ALTER TABLE", "`DO $$ BEGIN PERFORM hidden_writer(); END $$; ALTER TABLE"),
      ],
      [
        "sibling ledger consumer",
        (source) =>
          `${source}\nexport const otherSchemaMigrations = [{ migrationId: "other_writer", statements: [\`UPDATE settlement_account_risk_sources SET revision = 1\`] }];`,
      ],
      [
        "duplicate non-idempotent ADD",
        (source) =>
          source.replace(
            "DEFAULT 0`]",
            "DEFAULT 0; ALTER TABLE settlement_account_risk_sources ADD COLUMN revision bigint`]",
          ),
      ],
      [
        "writer before ADD in the same statement",
        (source) =>
          source.replace("`ALTER TABLE", "`UPDATE settlement_account_risk_sources SET revision = 1; ALTER TABLE"),
      ],
    ])("rejects %s evidence", (_label, change) => {
      const { baseSource, currentSource } = orderedRevisionSources();
      expect(retainedUpgradeKeys({ baseSource, currentSource: change(currentSource) })).toEqual([
        "settlement_account_risk_sources.revision",
      ]);
    });

    it("rejects an ADD moved ahead of either immutable normalizer", () => {
      const { baseSource, currentSource, expansion } = orderedRevisionSources();
      const addition = `{ migrationId: "add_revision", statements: [\`${expansion}\`] },`;
      const withoutAddition = currentSource.replace(addition, "");
      for (const id of ["normalize_flags", "normalize_counts"]) {
        const outOfOrder = withoutAddition.replace(`{ migrationId: "${id}"`, `${addition}\n{ migrationId: "${id}"`);
        expect(retainedUpgradeKeys({ baseSource, currentSource: outOfOrder })).toEqual([
          "settlement_account_risk_sources.revision",
        ]);
      }
    });

    it("accepts a later writer but checks every earlier statement", () => {
      const { baseSource, currentSource } = orderedRevisionSources();
      const writer = "UPDATE settlement_account_risk_sources SET revision = revision + 1";
      const laterWriter = currentSource.replace("DEFAULT 0`]", `DEFAULT 0; ${writer}\`]`);
      expect(retainedUpgradeKeys({ baseSource, currentSource: laterWriter })).toEqual([]);
      const earlierWriter = currentSource.replace(
        'migrationId: "add_revision", statements: [',
        `migrationId: "add_revision", statements: [\`${writer}\`, `,
      );
      expect(retainedUpgradeKeys({ baseSource, currentSource: earlierWriter })).toEqual([
        "settlement_account_risk_sources.revision",
      ]);
    });

    it("accepts named literal statements and independent idempotent boot expansions", () => {
      const { baseSource, currentSource, expansion } = orderedRevisionSources();
      const named = `const addRevisionSql = \`${expansion}\`;\n${currentSource.replace(`\`${expansion}\``, "addRevisionSql")}`;
      const withBootExpansion = named.replace(
        "review_count integer\n  );",
        "review_count integer\n  ); ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS review_count integer;",
      );
      expect(retainedUpgradeKeys({ baseSource, currentSource: withBootExpansion })).toEqual([]);
    });

    it.each(["inline template", "inline single quote", "inline double quote", "named template", "boot template"])(
      "fails closed on an escaped early reader in an %s",
      (shape) => {
        const normalizer = "UPDATE synthetic_review_rows SET value = 0 WHERE value IS NULL";
        const add = "ALTER TABLE synthetic_review_rows ADD COLUMN IF NOT EXISTS revision bigint DEFAULT 0";
        const boot = (column = "") =>
          `export const exampleSchemaSql = \`CREATE TABLE IF NOT EXISTS synthetic_review_rows (id text PRIMARY KEY, value bigint${column});\`;`;
        const ledger = (extra = "") => `export const exampleSchemaMigrations = [
          { migrationId: "normalize", statements: [\`${normalizer}\`] },
          ${extra}
        ];`;
        const baseSource = `${boot()}\n${ledger()}`;
        const reader = String.raw`UPDATE synthetic_review_rows SET value = \u0072evision`;
        const quote = shape === "inline single quote" ? "'" : shape === "inline double quote" ? '"' : "`";
        const literal = `${quote}${reader}; ${add}${quote}`;
        const statement = shape === "named template" ? "earlyReaderSql" : literal;
        const currentSource =
          shape === "boot template"
            ? `${boot(", revision bigint DEFAULT 0")}\n${ledger(`{ migrationId: "add_revision", statements: [\`${add}\`] },`)}\nexport const otherSchemaSql = \`${reader}\`;`
            : `${shape === "named template" ? `const earlyReaderSql = ${literal};\n` : ""}${boot(", revision bigint DEFAULT 0")}\n${ledger(`{ migrationId: "add_revision", statements: [${statement}] },`)}`;

        expect(retainedUpgradeKeys({ baseSource, currentSource })).toEqual(["synthetic_review_rows.revision"]);
      },
    );

    it.each([
      "DO $$ BEGIN PERFORM revision FROM synthetic_review_rows; END $$;",
      "CALL hidden_reader()",
      "EXECUTE 'SELECT revision FROM synthetic_review_rows'",
    ])("rejects an opaque sibling ledger statement: %s", (statement) => {
      const { baseSource, currentSource } = orderedRevisionSources();
      const source = currentSource.replaceAll("settlement_account_risk_sources", "synthetic_review_rows");
      const base = baseSource.replaceAll("settlement_account_risk_sources", "synthetic_review_rows");
      const sibling = `\nexport const otherSchemaMigrations = [{ migrationId: "early_reader", statements: [\`${statement}\`] }];
        export const executionOrder = [...otherSchemaMigrations, ...exampleSchemaMigrations];`;
      expect(retainedUpgradeKeys({ baseSource: base, currentSource: `${source}${sibling}` })).toEqual([
        "synthetic_review_rows.revision",
      ]);
      const afterSafeStatement = sibling.replace("statements: [", "statements: [`SELECT 1`, ");
      expect(retainedUpgradeKeys({ baseSource: base, currentSource: `${source}${afterSafeStatement}` })).toEqual([
        "synthetic_review_rows.revision",
      ]);
    });

    it("accepts independent safe sibling statements", () => {
      const { baseSource, currentSource } = orderedRevisionSources();
      const sibling = `export const otherSchemaMigrations = [{ migrationId: "independent", statements: [
        \`SELECT 1\`, \`UPDATE other_sources SET value = 0 WHERE value IS NULL\`
      ] }];`;
      expect(retainedUpgradeKeys({ baseSource, currentSource: `${currentSource}\n${sibling}` })).toEqual([]);
    });

    describe("complete ordered proof admission", () => {
      it.each([
        ["double string", '"SELECT revision FROM settlement_account_risk_sources"'],
        ["single string", "'SELECT revision FROM settlement_account_risk_sources'"],
        ["named template", "earlySql"],
        ["opaque call", "wrap(`SELECT revision FROM settlement_account_risk_sources`)"],
        ["concatenation", "'SELECT revision ' + 'FROM settlement_account_risk_sources'"],
        ["conditional", "condition ? `SELECT revision FROM settlement_account_risk_sources` : ''"],
        ["tagged template", "sql`SELECT revision FROM settlement_account_risk_sources`"],
        ["property access", "sqlParts.reader"],
        ["element access", "sqlParts['reader']"],
        ["non-null wrapper", "(`SELECT revision FROM settlement_account_risk_sources`)!"],
        ["type assertion wrapper", "<string>`SELECT revision FROM settlement_account_risk_sources`"],
        ["inert unsupported initializer", '"SELECT 1"'],
      ])("refuses an unproved boot initializer: %s", (_label, initializer) => {
        const { baseSource, currentSource } = orderedRevisionSources();
        const sibling = `const earlySql = \`SELECT revision FROM settlement_account_risk_sources\`;
          export const otherSchemaSql = ${initializer};`;
        expect(retainedUpgradeKeys({ baseSource, currentSource: `${currentSource}\n${sibling}` })).toEqual([
          "settlement_account_risk_sources.revision",
        ]);
      });

      it.each([
        ["export let", "export let otherSchemaSql = `SELECT 1`;"],
        ["export var", "export var otherSchemaSql = `SELECT 1`;"],
        ["local export alias", "const earlySql = `SELECT 1`; export { earlySql as otherSchemaSql };"],
        ["same-name local export", "const otherSchemaSql = `SELECT 1`; export { otherSchemaSql };"],
        ["re-export", "export { earlySql as otherSchemaSql } from './other.js';"],
        ["export star", "export * from './other.js';"],
        ["namespace re-export", "export * as other from './other.js';"],
        ["object binding", "export const { otherSchemaSql } = { otherSchemaSql: `SELECT 1` };"],
        ["renamed object binding", "export const { reader: otherSchemaSql } = parts;"],
        ["array binding", "export const [otherSchemaSql] = parts;"],
        ["multiple declarators", "export const safeSchemaSql = `SELECT 1`, otherSchemaSql = wrap(`SELECT 1`);"],
        ["missing initializer", "export const otherSchemaSql: string;"],
        ["duplicate local name", "const earlySql = `SELECT 1`; const earlySql = `SELECT 1`;"],
        ["duplicate ledger", "export const exampleSchemaMigrations = [];"],
        ["missing ledger initializer", "export const otherSchemaMigrations: readonly unknown[];"],
        ["let ledger", "export let otherSchemaMigrations = [];"],
        ["ledger alias", "const otherSchemaMigrations = []; export { otherSchemaMigrations };"],
        ["opaque ledger", "export const otherSchemaMigrations = loadMigrations();"],
        [
          "cross-ledger duplicate migration id",
          'export const otherSchemaMigrations = [{ migrationId: "add_revision", statements: ["SELECT 1"] }];',
        ],
        ["ledger composition", "export const executionOrder = [...exampleSchemaMigrations];"],
        ["boot composition", "export const executionSql = exampleSchemaSql + `SELECT 1`;"],
        ["ledger mutation", "exampleSchemaMigrations.push({ migrationId: 'hidden', statements: ['SELECT 1'] });"],
        ["nested mutation", "exampleSchemaMigrations[0].statements[0] = 'SELECT revision';"],
        ["unresolved execution", "runBoot(exampleSchemaSql);"],
        ["runtime import", "import './mutation.js';"],
        ["ambient runtime declaration", "export declare const otherSchemaSql = `SELECT 1`;"],
        ["resource-management declaration", "await using disposable = `SELECT 1`;"],
        ["function export", "export function otherSchemaSql() { return 'SELECT 1'; }"],
        ["parse diagnostics", "export const unfinished = ;"],
      ])("refuses incomplete declaration or execution evidence: %s", (_label, sibling) => {
        const { baseSource, currentSource } = orderedRevisionSources();
        expect(retainedUpgradeKeys({ baseSource, currentSource: `${currentSource}\n${sibling}` })).toEqual([
          "settlement_account_risk_sources.revision",
        ]);
      });

      it.each([
        [
          "reader dataStep",
          'dataStep: async (db) => { await db.query("SELECT revision FROM settlement_account_risk_sources"); }',
        ],
        ["inert dataStep", "dataStep: async () => {}"],
        ["undefined dataStep", "dataStep: undefined"],
        ["unknown member", "execute: async () => {}"],
        ["inert unknown member", "futureOption: false"],
        ["executable description", "description: describeMigration()"],
        ["description getter", "get description() { return 'inert'; }"],
        ["spread", "...extraMembers"],
      ])("refuses every unresolved migration member: %s", (_label, member) => {
        const { baseSource, currentSource } = orderedRevisionSources();
        const paired = currentSource.replace('migrationId: "add_revision",', `migrationId: "add_revision", ${member},`);
        const sibling = `export const otherSchemaMigrations = [{ migrationId: "independent", ${member}, statements: [\`SELECT 1\`] }];`;
        for (const source of [paired, `${sibling}\n${currentSource}`, `${currentSource}\n${sibling}`]) {
          expect(retainedUpgradeKeys({ baseSource, currentSource: source })).toEqual([
            "settlement_account_risk_sources.revision",
          ]);
        }
      });

      it("does not turn dataStep or unknown members into a global DDL error", () => {
        for (const member of ["dataStep: async () => {}", "futureOption: false"]) {
          const source = `export const exampleSchemaMigrations = [{ migrationId: "data", ${member}, statements: [\`SELECT 1\`] }];`;
          expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
        }
        const { baseSource, currentSource } = orderedRevisionSources();
        const ordinary = currentSource.replace(
          "review_count integer\n  );",
          "review_count integer\n  ); ALTER TABLE settlement_account_risk_sources ADD COLUMN IF NOT EXISTS revision bigint;",
        );
        expect(retainedUpgradeKeys({ baseSource, currentSource: `${ordinary}\nrunBoot();` })).toEqual([]);
      });

      it("admits supported wrappers, multiple declarations, literal metadata and type-only exports", () => {
        const { baseSource, currentSource } = orderedRevisionSources();
        const inert = `import type { BcSchemaMigration } from './contracts.js';
          export type { OtherSchemaSql } from './types.js';
          export type * from './types.js';
          export { type OtherSchemaMigrations } from './types.js';
          interface SchemaShape { sql: string }
          type Shape = SchemaShape;
          export const safeSchemaSql = (\`SELECT 1\` as string), anotherSchemaSql = (\`SELECT 2\` satisfies string);`;
        const supported = `${inert}\n${currentSource.replace('migrationId: "add_revision",', 'migrationId: "add_revision", description: ("Add revision" as const),')}`;
        expect(retainedUpgradeKeys({ baseSource, currentSource: supported })).toEqual([]);
      });

      it("refuses incomplete baseline evidence without changing the immutable SQL bytes", () => {
        const { baseSource, currentSource } = orderedRevisionSources();
        const unresolved = "\nexport const otherSchemaSql = wrap(`SELECT 1`);";
        expect(retainedUpgradeKeys({ baseSource: `${baseSource}${unresolved}`, currentSource })).toEqual([
          "settlement_account_risk_sources.revision",
        ]);
      });

      it("reaches completeness refusal through changed schema scanner discovery", async () => {
        const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-ddl-discipline-"));
        const relativeFilePath =
          "bounded-contexts/pricing/features/recommendations/integrations/source/source-schema.ts";
        const filePath = path.join(repoRoot, relativeFilePath);
        const { baseSource, currentSource } = orderedRevisionSources();
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, baseSource, "utf8");
        try {
          const git = (args) => execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
          git(["init"]);
          git(["add", relativeFilePath]);
          git([
            "-c",
            "user.name=Schema Test",
            "-c",
            "user.email=schema@example.invalid",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "test: base schema",
          ]);
          git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
          await writeFile(filePath, `${currentSource}\nexport const otherSchemaSql = "SELECT 1";`, "utf8");
          expect(
            await findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths: [relativeFilePath] }),
          ).toEqual([
            expect.objectContaining({
              file: relativeFilePath,
              message: expect.stringContaining("has no idempotent boot ADD COLUMN expansion"),
            }),
          ]);
          expect(await findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths: [] })).toEqual([]);
        } finally {
          await rm(repoRoot, { recursive: true, force: true });
        }
      });
    });

    it.each([
      [
        "another table's normalizers",
        (source) => source.replaceAll("UPDATE settlement_account_risk_sources", "UPDATE other_sources"),
      ],
      ["ordinary writers", (source) => source.replaceAll(/ WHERE [a-z_]+ IS NULL/g, "")],
      [
        "commented normalizers",
        (source) =>
          source.replaceAll("UPDATE settlement_account_risk_sources", "-- UPDATE settlement_account_risk_sources"),
      ],
    ])("does not infer immutable normalization from %s", (_label, change) => {
      const { baseSource, currentSource } = orderedRevisionSources();
      expect(retainedUpgradeKeys({ baseSource: change(baseSource), currentSource: change(currentSource) })).toEqual([
        "settlement_account_risk_sources.revision",
      ]);
    });
  });

  it("ordinary unprotected retained column fails", () => {
    const baseSource = bootSchemaSource("CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);");
    const currentBoot = bootSchemaSource(
      "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY, status text NULL);",
    );
    for (const statement of [
      "SELECT 1",
      "ALTER TABLE other_pages ADD COLUMN IF NOT EXISTS status text NULL",
      "ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS status text NULL",
      "UPDATE other_pages SET status = NULL; ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS status text NULL",
    ]) {
      const currentSource = `${currentBoot}\nexport const exampleSchemaMigrations = [
        { migrationId: "add_status", statements: [\`${statement}\`] }
      ];`;
      expect(findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource })).toEqual([
        expect.objectContaining({
          tableName: "example_pages",
          columnName: "status",
          message: expect.stringContaining("has no idempotent boot ADD COLUMN expansion"),
        }),
      ]);
    }
  });

  it("fails migration safety closed on opaque statement expressions", () => {
    const source = `export const exampleSchemaMigrations = [
      { migrationId: "opaque", statements: [transform(\`DROP TABLE example_pages\`)] }
    ];`;
    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("cannot prove DDL safety") }),
    ]);
  });

  it("retains destructive boot DDL detection in an interpolated template", () => {
    const source =
      "export const exampleSchemaSql = `${extraSql} UPDATE example_pages SET value = 1; DROP TABLE example_pages;`;";
    expect(findInlineViolations(source)).toEqual(["DROP", "UPDATE"]);
  });

  describe("retained-schema boot expansion SQL recognition", () => {
    const baseSource = bootSchemaSource("CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);");
    const createWithStatus = "CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY, status text NULL);";
    const expansion = "ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS status text NULL;";

    it.each([
      ["line comments", `${createWithStatus} -- ${expansion}`],
      ["block comments", `${createWithStatus} /* ${expansion} */`],
      [
        "single-quoted strings with escaped quotes and comment delimiters",
        `${createWithStatus} SELECT 'ignored ''quoted'' -- /* ${expansion} */';`,
      ],
      ["PostgreSQL escape strings", `${createWithStatus} SELECT E'ignored \\'quoted\\' ${expansion}';`],
      ["untagged dollar-quoted strings", `${createWithStatus} SELECT $$-- /* ${expansion} */$$;`],
      ["tagged dollar-quoted strings", `${createWithStatus} SELECT $body$-- /* ${expansion} */$body$;`],
      ["nested block comments", `${createWithStatus} /* outer /* inner */ ${expansion} */`],
    ])("does not accept fake expansions inside %s", (_label, sql) => {
      expect(retainedUpgradeKeys({ baseSource, currentSource: bootSchemaSource(sql) })).toEqual([
        "example_pages.status",
      ]);
    });

    it.each([
      ["ordinary ALTER TABLE", expansion],
      ["ALTER TABLE ONLY", "ALTER TABLE ONLY example_pages ADD COLUMN IF NOT EXISTS status text NULL;"],
      ["ALTER TABLE after a quoted comment delimiter", `SELECT '-- not a comment /* or block */'; ${expansion}`],
      [
        "ALTER TABLE after a dollar-quoted comment delimiter",
        `SELECT $tag$-- not a comment /* or block */$tag$; ${expansion}`,
      ],
    ])("accepts executable expansion via %s", (_label, ddl) => {
      const currentSource = bootSchemaSource(`${createWithStatus} ${ddl}`);

      expect(retainedUpgradeKeys({ baseSource, currentSource })).toEqual([]);
    });

    it.each([
      ["missing expansion", createWithStatus],
      [
        "same-named expansion on the wrong table",
        `${createWithStatus} ALTER TABLE other_pages ADD COLUMN IF NOT EXISTS status text NULL;`,
      ],
    ])("retains the violation for %s", (_label, sql) => {
      expect(retainedUpgradeKeys({ baseSource, currentSource: bootSchemaSource(sql) })).toEqual([
        "example_pages.status",
      ]);
    });
  });

  it("does not treat a same-named column migration on another table as reachable", () => {
    const baseSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);
\`;
`;
    const currentSource = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY, status text NULL);
\`;
export const exampleSchemaMigrations = [{
  migrationId: "m1",
  description: "wrong table",
  statements: [
    \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS unrelated text NULL\`,
    \`ALTER TABLE other_pages ADD COLUMN IF NOT EXISTS status text NULL\`,
  ],
}];
`;

    expect(findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource })).toEqual([
      expect.objectContaining({ tableName: "example_pages", columnName: "status" }),
    ]);
  });

  it("flags changed migration DDL that can block hot tables", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "unsafe",
    statements: [
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS risk_token text NOT NULL DEFAULT gen_random_uuid()\`,
      \`CREATE INDEX IF NOT EXISTS example_pages_risk_idx ON example_pages (risk)\`,
      \`ALTER TABLE example_pages ALTER COLUMN risk SET NOT NULL\`,
      \`DROP INDEX IF EXISTS example_pages_old_idx\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("volatile or non-constant DEFAULT"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("CREATE INDEX without CONCURRENTLY"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("tightens an existing column with SET NOT NULL"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("lock-hazardous DROP DDL without SET LOCAL lock_timeout"),
      }),
    ]);
  });

  it("allows guarded migration DDL and concurrent index creation", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "guarded",
    statements: [
      \`SET LOCAL lock_timeout = '2s'\`,
      \`ALTER TABLE example_pages ADD CONSTRAINT example_pages_risk_not_null CHECK (risk IS NOT NULL) NOT VALID\`,
      \`ALTER TABLE example_pages VALIDATE CONSTRAINT example_pages_risk_not_null\`,
      \`ALTER TABLE example_pages ALTER COLUMN risk SET NOT NULL\`,
      \`CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_risk_idx ON example_pages (risk)\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
  });

  it("allows metadata-only ADD COLUMN NOT NULL with constant or stable defaults (PG 11+ fast default)", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "fast defaults",
    statements: [
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS reservations jsonb NOT NULL DEFAULT '[]'::jsonb\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS extension_count integer NOT NULL DEFAULT 0\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT FALSE\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS amount numeric(12, 2) NOT NULL DEFAULT 0\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}'::text[]\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now()\`,
      \`ALTER TABLE example_pages
  ADD COLUMN IF NOT EXISTS first_flag boolean NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS second_kind text NOT NULL DEFAULT 'manual'\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
  });

  it("flags volatile NOT NULL defaults even when the migration sets lock_timeout", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "volatile default",
    statements: [
      \`SET LOCAL lock_timeout = '2s'\`,
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS token uuid NOT NULL DEFAULT gen_random_uuid()\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("volatile or non-constant DEFAULT"),
      }),
    ]);
  });

  it("flags SET NOT NULL behind lock_timeout without a validated constraint (#4638 livelock)", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "outage pattern",
    statements: [
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS reservations jsonb NULL\`,
      \`UPDATE example_pages SET reservations = '[]'::jsonb WHERE reservations IS NULL\`,
      \`ALTER TABLE example_pages ALTER COLUMN reservations SET DEFAULT '[]'::jsonb\`,
      \`SET lock_timeout = '5s'\`,
      \`ALTER TABLE example_pages ALTER COLUMN reservations SET NOT NULL\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("tightens an existing column with SET NOT NULL"),
      }),
    ]);
  });

  it("classifies fast-default-safe expressions", () => {
    expect(isFastDefaultSafeExpression(`'[]'::jsonb`)).toBe(true);
    expect(isFastDefaultSafeExpression(`0`)).toBe(true);
    expect(isFastDefaultSafeExpression(`-1.5`)).toBe(true);
    expect(isFastDefaultSafeExpression(`TRUE`)).toBe(true);
    expect(isFastDefaultSafeExpression(`'manual'`)).toBe(true);
    expect(isFastDefaultSafeExpression(`'{}'::text[]`)).toBe(true);
    expect(isFastDefaultSafeExpression(`now()`)).toBe(true);
    expect(isFastDefaultSafeExpression(`CURRENT_TIMESTAMP`)).toBe(true);
    expect(isFastDefaultSafeExpression(`gen_random_uuid()`)).toBe(false);
    expect(isFastDefaultSafeExpression(`random()`)).toBe(false);
    expect(isFastDefaultSafeExpression(`clock_timestamp()`)).toBe(false);
    expect(isFastDefaultSafeExpression(`lower('X')`)).toBe(false);
  });

  it("flags boot-time indexes over columns added to existing tables in boot SQL", () => {
    const source = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY,
  due_at timestamptz NULL
);

ALTER TABLE example_pages
  ADD COLUMN IF NOT EXISTS due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS policy text NULL;

CREATE INDEX IF NOT EXISTS example_pages_due_idx
  ON example_pages (due_at, id)
  WHERE due_at IS NOT NULL;
\`;
`;

    expect(findBootSchemaMigrationAddedIndexViolationsInSource(source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("example_pages_due_idx"),
      }),
    ]);
  });

  it("checks migration DDL only for changed schema files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-ddl-discipline-"));
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "unsafe",
    statements: [
      \`CREATE INDEX IF NOT EXISTS example_pages_risk_idx ON example_pages (risk)\`,
    ],
  },
];
`;
    const readModelPath = path.join(repoRoot, "bounded-contexts/example/features/pages/read-model");
    await mkdir(readModelPath, { recursive: true });
    await writeFile(path.join(readModelPath, "schema.ts"), source, "utf8");

    try {
      await expect(
        findBootSchemaDdlDisciplineViolations({
          repoRoot,
          changedFilePaths: [],
        }),
      ).resolves.toEqual([]);
      await expect(
        findBootSchemaDdlDisciplineViolations({
          repoRoot,
          changedFilePaths: ["bounded-contexts/example/features/pages/read-model/schema.ts"],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          file: "bounded-contexts/example/features/pages/read-model/schema.ts",
          message: expect.stringContaining("CREATE INDEX without CONCURRENTLY"),
        }),
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("scans hyphenated schema-like files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-ddl-discipline-"));
    const source = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (id text PRIMARY KEY);
UPDATE example_pages SET id = id;
\`;
`;
    const integrationPath = path.join(repoRoot, "bounded-contexts/example/features/pages/integrations/source");
    await mkdir(integrationPath, { recursive: true });
    await writeFile(path.join(integrationPath, "source-schema.ts"), source, "utf8");

    try {
      await expect(findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths: [] })).resolves.toEqual([
        expect.objectContaining({
          file: "bounded-contexts/example/features/pages/integrations/source/source-schema.ts",
          message: expect.stringContaining("boot-time UPDATE"),
        }),
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("checks boot-time indexes over migration-added columns only for changed schema files", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "chase-sets-ddl-discipline-"));
    const source = `
export const exampleSchemaSql = \`
CREATE TABLE IF NOT EXISTS example_pages (
  id text PRIMARY KEY,
  due_at timestamptz NULL
);

ALTER TABLE example_pages
  ADD COLUMN IF NOT EXISTS due_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS example_pages_due_idx
  ON example_pages (due_at, id);
\`;
`;
    const readModelPath = path.join(repoRoot, "bounded-contexts/example/features/pages/read-model");
    await mkdir(readModelPath, { recursive: true });
    await writeFile(path.join(readModelPath, "schema.ts"), source, "utf8");

    try {
      await expect(
        findBootSchemaDdlDisciplineViolations({
          repoRoot,
          changedFilePaths: [],
        }),
      ).resolves.toEqual([]);
      await expect(
        findBootSchemaDdlDisciplineViolations({
          repoRoot,
          changedFilePaths: ["bounded-contexts/example/features/pages/read-model/schema.ts"],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          file: "bounded-contexts/example/features/pages/read-model/schema.ts",
          message: expect.stringContaining("example_pages_due_idx"),
        }),
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
