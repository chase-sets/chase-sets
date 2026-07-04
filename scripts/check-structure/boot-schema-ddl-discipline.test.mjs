import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractExportedBootSchemaSqlTemplates,
  extractSchemaMigrationStatements,
  findBootSchemaDdlDisciplineViolations,
  findSchemaMigrationDdlSafetyViolationsInSource,
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

  it("flags changed migration DDL that can block hot tables", () => {
    const source = `
export const exampleSchemaMigrations = [
  {
    migrationId: "m1",
    description: "unsafe",
    statements: [
      \`ALTER TABLE example_pages ADD COLUMN IF NOT EXISTS risk text NOT NULL DEFAULT ''\`,
      \`CREATE INDEX IF NOT EXISTS example_pages_risk_idx ON example_pages (risk)\`,
      \`ALTER TABLE example_pages ALTER COLUMN risk SET NOT NULL\`,
      \`DROP INDEX IF EXISTS example_pages_old_idx\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("NOT NULL DEFAULT"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("CREATE INDEX without CONCURRENTLY"),
      }),
      expect.objectContaining({
        message: expect.stringContaining("sets NOT NULL without SET LOCAL lock_timeout"),
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
      \`ALTER TABLE example_pages ALTER COLUMN risk SET NOT NULL\`,
      \`CREATE INDEX CONCURRENTLY IF NOT EXISTS example_pages_risk_idx ON example_pages (risk)\`,
    ],
  },
];
`;

    expect(findSchemaMigrationDdlSafetyViolationsInSource(source)).toEqual([]);
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
});
