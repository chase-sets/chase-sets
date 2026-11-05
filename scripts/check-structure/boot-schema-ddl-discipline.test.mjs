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
