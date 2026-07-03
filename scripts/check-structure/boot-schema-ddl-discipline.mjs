import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const riskyBootDdlPatterns = [
  {
    label: "DROP",
    pattern: /\bDROP\s+(?:INDEX|TABLE|COLUMN|CONSTRAINT)\b/gi,
  },
  {
    label: "SET NOT NULL",
    pattern: /\bALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\s+NOT\s+NULL\b/gi,
  },
  {
    label: "UPDATE",
    pattern: /\bUPDATE\s+(?!SET\b)[A-Za-z_][A-Za-z0-9_.]*/gi,
  },
];

export function extractExportedBootSchemaSqlTemplates(source) {
  const templates = [];
  const exportPattern = /export\s+const\s+([A-Za-z0-9_]*SchemaSql)\s*=\s*`/g;

  for (const match of source.matchAll(exportPattern)) {
    const templateStart = match.index + match[0].length;
    let templateEnd = templateStart;
    while (templateEnd < source.length) {
      if (source[templateEnd] === "`" && source[templateEnd - 1] !== "\\") {
        break;
      }
      templateEnd += 1;
    }

    templates.push({
      name: match[1],
      sql: source.slice(templateStart, templateEnd),
      startLine: lineNumberAt(source.slice(0, templateStart)),
    });
  }

  return templates;
}

export async function findBootSchemaDdlDisciplineViolations({ repoRoot }) {
  const schemaFiles = await listSchemaFiles(path.join(repoRoot, "bounded-contexts"));
  const violations = [];

  for (const filePath of schemaFiles) {
    const source = await readFile(filePath, "utf8");
    for (const template of extractExportedBootSchemaSqlTemplates(source)) {
      for (const rule of riskyBootDdlPatterns) {
        rule.pattern.lastIndex = 0;
        for (const match of template.sql.matchAll(rule.pattern)) {
          const line = template.startLine + countNewlines(template.sql.slice(0, match.index));
          violations.push({
            file: normalizeRelative(repoRoot, filePath),
            line,
            message: `${template.name} contains boot-time ${rule.label}; move one-time reshapes into an exported schemaMigrations ledger.`,
          });
        }
      }
    }
  }

  return violations;
}

async function listSchemaFiles(root) {
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSchemaFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name === "schema.ts") {
      files.push(entryPath);
    }
  }
  return files;
}

function lineNumberAt(value) {
  return value.split("\n").length;
}

function countNewlines(value) {
  return value.split("\n").length - 1;
}

function normalizeRelative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}
