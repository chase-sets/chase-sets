import { describe, expect, it } from "vitest";
import { extractExportedBootSchemaSqlTemplates } from "./boot-schema-ddl-discipline.mjs";

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
});
