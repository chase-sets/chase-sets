import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

const migrationAccessExclusivePatterns = [
  {
    label: "DROP",
    pattern: /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)\b/i,
    message:
      "schema migration statement contains lock-hazardous DROP DDL without SET LOCAL lock_timeout in the same migration; set a short lock_timeout and keep the reshape idempotent.",
  },
  {
    label: "ADD CONSTRAINT",
    pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+CONSTRAINT\b(?![\s\S]*?\bNOT\s+VALID\b)/i,
    message:
      "schema migration statement adds a validated constraint without SET LOCAL lock_timeout; add NOT VALID plus a separate validation step, or set an explicit lock_timeout.",
  },
  {
    label: "SET NOT NULL",
    pattern: /\bALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\s+NOT\s+NULL\b/i,
    message:
      "schema migration statement sets NOT NULL without SET LOCAL lock_timeout; validate existing rows first and guard the DDL with a short lock_timeout.",
  },
  {
    label: "NOT NULL DEFAULT",
    pattern: /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+COLUMN\b[\s\S]*?\bNOT\s+NULL\b[\s\S]*?\bDEFAULT\b/i,
    message:
      "schema migration statement adds a NOT NULL DEFAULT column, which can rewrite hot tables; split the nullable add, backfill, validation, and constraint tightening behind an explicit lock_timeout.",
  },
  {
    label: "ALTER COLUMN TYPE",
    pattern: /\bALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+TYPE\b/i,
    message:
      "schema migration statement changes a column type, which can rewrite hot tables; use an expand/backfill/contract migration or guard the DDL with a short lock_timeout.",
  },
  {
    label: "TRUNCATE",
    pattern: /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_][A-Za-z0-9_.]*/i,
    message:
      "schema migration statement truncates a table without SET LOCAL lock_timeout; use an explicit bounded maintenance path or guard the DDL with a short lock_timeout.",
  },
  {
    label: "RENAME",
    pattern: /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i,
    message:
      "schema migration statement renames schema objects without SET LOCAL lock_timeout; prefer expand/contract compatibility or guard the DDL with a short lock_timeout.",
  },
];

const migrationCreateIndexPattern = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY\b)/i;
const lockTimeoutPattern = /\bSET\s+(?:LOCAL\s+)?lock_timeout\s*=/i;

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

export function extractSchemaMigrationLedgers(source) {
  const ledgers = [];
  const exportPattern = /export\s+const\s+([A-Za-z0-9_]*SchemaMigrations)(?::[^=]+)?\s*=\s*\[/g;

  for (const match of source.matchAll(exportPattern)) {
    const ledgerStart = match.index + match[0].length - 1;
    const ledgerEnd = findBalancedEnd(source, ledgerStart, "[", "]");
    if (ledgerEnd === -1) {
      continue;
    }

    ledgers.push({
      name: match[1],
      body: source.slice(ledgerStart + 1, ledgerEnd),
      startLine: lineNumberAt(source.slice(0, ledgerStart + 1)),
    });
  }

  return ledgers;
}

export function extractSchemaMigrationStatements(source) {
  const constants = extractTopLevelSqlConstants(source);
  const statements = [];

  for (const ledger of extractSchemaMigrationLedgers(source)) {
    const migrationBlocks = extractMigrationBlocks(ledger);
    for (const block of migrationBlocks) {
      const statementsArray = extractStatementsArray(block);
      if (!statementsArray) {
        continue;
      }

      const migrationStatements = extractStatementsFromArray(statementsArray, constants);
      statements.push({
        ledgerName: ledger.name,
        startLine: statementsArray.startLine,
        statements: migrationStatements,
      });
    }
  }

  return statements;
}

export function findSchemaMigrationDdlSafetyViolationsInSource(source) {
  return extractSchemaMigrationStatements(source).flatMap((migration) => {
    const migrationHasLockTimeout = migration.statements.some((statement) => lockTimeoutPattern.test(statement.sql));
    const violations = [];

    for (const statement of migration.statements) {
      if (migrationCreateIndexPattern.test(statement.sql)) {
        violations.push({
          line: statement.startLine,
          message:
            "schema migration statement contains CREATE INDEX without CONCURRENTLY; use CREATE INDEX CONCURRENTLY for non-empty tables or document an empty-table exception outside the migration ledger.",
        });
      }

      if (!migrationHasLockTimeout) {
        for (const rule of migrationAccessExclusivePatterns) {
          if (rule.pattern.test(statement.sql)) {
            violations.push({
              line: statement.startLine,
              message: rule.message,
            });
          }
        }
      }
    }

    return violations;
  });
}

export async function findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths } = {}) {
  const schemaFiles = await listSchemaFiles(path.join(repoRoot, "bounded-contexts"));
  const changedSchemaFiles = new Set(
    resolveChangedSchemaFiles({
      repoRoot,
      schemaFiles,
      changedFilePaths: changedFilePaths ?? readChangedFilePaths({ repoRoot }),
    }),
  );
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

    if (!changedSchemaFiles.has(filePath)) {
      continue;
    }

    for (const violation of findSchemaMigrationDdlSafetyViolationsInSource(source)) {
      violations.push({
        file: normalizeRelative(repoRoot, filePath),
        line: violation.line,
        message: violation.message,
      });
    }
  }

  return violations;
}

function extractTopLevelSqlConstants(source) {
  const constants = new Map();
  const constPattern = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:`|"|')/g;

  for (const match of source.matchAll(constPattern)) {
    const quote = match[0][match[0].length - 1];
    const valueStart = match.index + match[0].length;
    const valueEnd = findStringEnd(source, valueStart, quote);
    if (valueEnd === -1) {
      continue;
    }

    constants.set(match[1], {
      sql: source.slice(valueStart, valueEnd),
      startLine: lineNumberAt(source.slice(0, valueStart)),
    });
  }

  return constants;
}

function extractMigrationBlocks(ledger) {
  const blocks = [];
  let index = 0;
  while (index < ledger.body.length) {
    if (ledger.body[index] !== "{") {
      index += 1;
      continue;
    }

    const end = findBalancedEnd(ledger.body, index, "{", "}");
    if (end === -1) {
      break;
    }

    const body = ledger.body.slice(index + 1, end);
    if (/\bstatements\s*:/.test(body)) {
      blocks.push({
        body,
        startLine: ledger.startLine + countNewlines(ledger.body.slice(0, index + 1)),
      });
    }
    index = end + 1;
  }
  return blocks;
}

function extractStatementsArray(block) {
  const statementsMatch = /\bstatements\s*:\s*\[/.exec(block.body);
  if (!statementsMatch) {
    return null;
  }

  const arrayStart = statementsMatch.index + statementsMatch[0].length - 1;
  const arrayEnd = findBalancedEnd(block.body, arrayStart, "[", "]");
  if (arrayEnd === -1) {
    return null;
  }

  return {
    body: block.body.slice(arrayStart + 1, arrayEnd),
    startLine: block.startLine + countNewlines(block.body.slice(0, arrayStart + 1)),
  };
}

function extractStatementsFromArray(statementsArray, constants) {
  const statements = [];
  const tokenPattern = /(?:`(?:\\.|[^`])*`)|(?:"(?:\\.|[^"])*")|(?:'(?:\\.|[^'])*')|[A-Za-z_][A-Za-z0-9_]*/g;

  for (const match of statementsArray.body.matchAll(tokenPattern)) {
    const token = match[0];
    const tokenLine = statementsArray.startLine + countNewlines(statementsArray.body.slice(0, match.index));
    if (token.startsWith("`") || token.startsWith('"') || token.startsWith("'")) {
      statements.push({
        sql: token.slice(1, -1),
        startLine: tokenLine,
      });
      continue;
    }

    const constant = constants.get(token);
    if (constant) {
      statements.push(constant);
    }
  }

  return statements;
}

function findBalancedEnd(source, startIndex, open, close) {
  let depth = 0;
  let quote = null;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === "`" || character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) {
      depth += 1;
      continue;
    }
    if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findStringEnd(source, startIndex, quote) {
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === quote && source[index - 1] !== "\\") {
      return index;
    }
  }
  return -1;
}

function readChangedFilePaths({ repoRoot }) {
  const envValue = process.env.CHANGED_FILES_JSON;
  if (envValue) {
    try {
      const parsed = JSON.parse(envValue);
      return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
    } catch {
      return [];
    }
  }

  try {
    const mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const output = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveChangedSchemaFiles({ repoRoot, schemaFiles, changedFilePaths }) {
  const normalizedChangedPaths = new Set(changedFilePaths.map((filePath) => filePath.replaceAll("\\", "/")));
  return schemaFiles.filter((filePath) => normalizedChangedPaths.has(normalizeRelative(repoRoot, filePath)));
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
