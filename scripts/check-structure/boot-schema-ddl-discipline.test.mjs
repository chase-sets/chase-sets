import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

describe("boot schema DDL discipline", () => {
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
