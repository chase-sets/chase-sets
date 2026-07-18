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

// ALTER COLUMN ... SET NOT NULL on an existing column holds ACCESS EXCLUSIVE across a
// full-table validation scan. Under rolling-deploy reads it repeatedly hits lock_timeout and
// the bootstrap retry loop livelocks silently (#4638), so lock_timeout alone is NOT a defense.
// The only allowed pattern is the scan-free one: add CHECK (col IS NOT NULL) NOT VALID, then
// VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE only), then SET NOT NULL guarded by lock_timeout
// in the same migration so PostgreSQL 12+ proves NOT NULL from the validated constraint.
const setNotNullPattern = /\bALTER\s+COLUMN\s+[A-Za-z_][A-Za-z0-9_]*\s+SET\s+NOT\s+NULL\b/i;
const validateConstraintPattern = /\bVALIDATE\s+CONSTRAINT\b/i;
const setNotNullMessage =
  "schema migration statement tightens an existing column with SET NOT NULL, which holds ACCESS EXCLUSIVE across a full-table validation scan and livelocks against rolling-deploy reads even behind lock_timeout (#4638); for new columns use ADD COLUMN ... NOT NULL DEFAULT <constant> (metadata-only fast default on PostgreSQL 11+), for existing columns add CHECK (column IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, and only then SET NOT NULL behind lock_timeout in the same migration.";

// ADD COLUMN ... NOT NULL DEFAULT <non-volatile expression> is metadata-only on PostgreSQL 11+
// (fast default: no rewrite, no validation scan, only a brief ACCESS EXCLUSIVE). Volatile
// defaults (gen_random_uuid(), random(), clock_timestamp(), unknown functions) still force a
// full table rewrite, so those stay flagged regardless of lock_timeout.
const addColumnNotNullDefaultPattern =
  /\bALTER\s+TABLE\b[\s\S]*?\bADD\s+COLUMN\b[\s\S]*?\bNOT\s+NULL\b[\s\S]*?\bDEFAULT\b|\bALTER\s+TABLE\b[\s\S]*?\bADD\s+COLUMN\b[\s\S]*?\bDEFAULT\b[\s\S]*?\bNOT\s+NULL\b/i;
const volatileNotNullDefaultMessage =
  "schema migration statement adds a NOT NULL column with a volatile or non-constant DEFAULT, which rewrites hot tables under ACCESS EXCLUSIVE; use a constant (or stable, e.g. now()) default so PostgreSQL 11+ applies it as a metadata-only fast default, or add the column nullable, backfill in batches, and tighten via CHECK ... NOT VALID plus VALIDATE CONSTRAINT.";

const sqlCastSuffixPattern =
  "(?:\\s*::\\s*[A-Za-z_][A-Za-z0-9_ ]*(?:\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?(?:\\[\\])?)?";
const constantDefaultPattern = new RegExp(
  `^(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|TRUE|FALSE|NULL)${sqlCastSuffixPattern}$`,
  "i",
);
const stableDefaultPattern = new RegExp(
  `^(?:now\\(\\)|statement_timestamp\\(\\)|transaction_timestamp\\(\\)|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME)${sqlCastSuffixPattern}$`,
  "i",
);

export function isFastDefaultSafeExpression(defaultExpression) {
  const expression = defaultExpression.trim().replace(/;$/, "").trim();
  return constantDefaultPattern.test(expression) || stableDefaultPattern.test(expression);
}

export function findVolatileNotNullDefaultClauses(sql) {
  if (!addColumnNotNullDefaultPattern.test(sql)) {
    return [];
  }

  // Split multi-add ALTER TABLE statements on commas that introduce the next ADD COLUMN so
  // per-clause DEFAULT expressions can be inspected (commas inside numeric(12, 2) or quoted
  // defaults stay within their clause).
  return sql
    .split(/,(?=\s*ADD\s+COLUMN\b)/i)
    .filter(
      (clause) => /\bADD\s+COLUMN\b/i.test(clause) && /\bNOT\s+NULL\b/i.test(clause) && /\bDEFAULT\b/i.test(clause),
    )
    .flatMap((clause) => {
      const defaultMatch = /\bDEFAULT\s+([\s\S]+)$/i.exec(clause);
      if (!defaultMatch) {
        return [];
      }

      const defaultExpression = defaultMatch[1].replace(/\s+NOT\s+NULL\b[\s\S]*$/i, "").trim();
      return isFastDefaultSafeExpression(defaultExpression) ? [] : [defaultExpression];
    });
}

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

export function extractBootSchemaTableColumns(source) {
  const tables = new Map();
  const createTablePattern = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/gi;
  const tableConstraintKeywords = new Set(["check", "constraint", "exclude", "foreign", "primary", "unique"]);

  for (const template of extractExportedBootSchemaSqlTemplates(source)) {
    for (const match of template.sql.matchAll(createTablePattern)) {
      const tableName = match[1].toLowerCase();
      const columnsStart = match.index + match[0].length - 1;
      const columnsEnd = findBalancedEnd(template.sql, columnsStart, "(", ")");
      if (columnsEnd === -1) {
        continue;
      }

      const columns = tables.get(tableName) ?? new Set();
      const definition = template.sql.slice(columnsStart + 1, columnsEnd);
      for (const clause of splitTopLevelCommaClauses(definition)) {
        const columnMatch = /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s+/i.exec(clause);
        if (!columnMatch || tableConstraintKeywords.has(columnMatch[1].toLowerCase())) {
          continue;
        }
        columns.add(columnMatch[1].toLowerCase());
      }
      tables.set(tableName, columns);
    }
  }

  return tables;
}

export function findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource }) {
  const baseTables = extractBootSchemaTableColumns(baseSource);
  const currentTables = extractBootSchemaTableColumns(currentSource);
  const migrationStatements = extractSchemaMigrationStatements(currentSource)
    .flatMap((migration) => migration.statements)
    .map((statement) => statement.sql);
  const violations = [];

  for (const [tableName, currentColumns] of currentTables) {
    const baseColumns = baseTables.get(tableName);
    if (!baseColumns) {
      continue;
    }

    for (const columnName of currentColumns) {
      if (baseColumns.has(columnName)) {
        continue;
      }

      const reachableColumnPattern = new RegExp(
        `\\bALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?\\s+${escapeRegExp(tableName)}\\b[\\s\\S]*?\\bADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${escapeRegExp(columnName)}\\b`,
        "i",
      );
      if (!migrationStatements.some((statement) => reachableColumnPattern.test(statement))) {
        violations.push({
          tableName,
          columnName,
          message: `fresh-boot column ${tableName}.${columnName} was added to an existing table without a reachable exported schemaMigrations ADD COLUMN ledger entry; existing databases would retain the old shape (#4834).`,
        });
      }
    }
  }

  return violations;
}

export function findSchemaMigrationDdlSafetyViolationsInSource(source, { baseSource } = {}) {
  const baseStatementSql = new Set(
    baseSource
      ? extractSchemaMigrationStatements(baseSource)
          .flatMap((migration) => migration.statements)
          .map((statement) => statement.sql.trim())
      : [],
  );

  return extractSchemaMigrationStatements(source).flatMap((migration) => {
    const migrationHasLockTimeout = migration.statements.some((statement) => lockTimeoutPattern.test(statement.sql));
    const migrationHasValidatedConstraint = migration.statements.some((statement) =>
      validateConstraintPattern.test(statement.sql),
    );
    const violations = [];

    for (const statement of migration.statements) {
      if (baseStatementSql.has(statement.sql.trim())) {
        continue;
      }
      if (migrationCreateIndexPattern.test(statement.sql)) {
        violations.push({
          line: statement.startLine,
          message:
            "schema migration statement contains CREATE INDEX without CONCURRENTLY; use CREATE INDEX CONCURRENTLY for non-empty tables or document an empty-table exception outside the migration ledger.",
        });
      }

      // SET NOT NULL is flagged even when the migration sets lock_timeout: the retry loop
      // around lock_timeout is exactly what turned the #4638 scan into a silent livelock.
      // Only the validated-constraint pattern (NOT VALID CHECK + VALIDATE CONSTRAINT +
      // lock_timeout) proves NOT NULL without the full-table scan.
      if (setNotNullPattern.test(statement.sql) && !(migrationHasLockTimeout && migrationHasValidatedConstraint)) {
        violations.push({
          line: statement.startLine,
          message: setNotNullMessage,
        });
      }

      // Volatile NOT NULL DEFAULT columns rewrite the table regardless of lock_timeout;
      // constant/stable defaults are metadata-only fast defaults on PostgreSQL 11+ and pass.
      if (findVolatileNotNullDefaultClauses(statement.sql).length > 0) {
        violations.push({
          line: statement.startLine,
          message: volatileNotNullDefaultMessage,
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

export function findBootSchemaMigrationAddedIndexViolationsInSource(source) {
  return extractExportedBootSchemaSqlTemplates(source).flatMap((template) => {
    const addedColumnsByTable = new Map();
    for (const statement of splitSqlStatements(template.sql)) {
      const tableMatch = /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_.]*)/i.exec(statement.sql);
      if (!tableMatch) {
        continue;
      }

      const tableName = tableMatch[1];
      const addedColumns = addedColumnsByTable.get(tableName) ?? new Set();
      for (const columnMatch of statement.sql.matchAll(
        /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi,
      )) {
        addedColumns.add(columnMatch[1]);
      }
      if (addedColumns.size > 0) {
        addedColumnsByTable.set(tableName, addedColumns);
      }
    }

    const violations = [];
    const createIndexPattern =
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(([\s\S]*?)\)/gi;

    for (const match of template.sql.matchAll(createIndexPattern)) {
      const [, indexName, tableName, indexedColumnsSql] = match;
      const addedColumns = addedColumnsByTable.get(tableName);
      if (!addedColumns) {
        continue;
      }

      const migrationAddedColumns = [...addedColumns].filter((columnName) =>
        new RegExp(`\\b${escapeRegExp(columnName)}\\b`, "i").test(indexedColumnsSql),
      );
      if (migrationAddedColumns.length === 0) {
        continue;
      }

      violations.push({
        line: template.startLine + countNewlines(template.sql.slice(0, match.index)),
        message: `${template.name} creates boot-time index ${indexName} on migration-added ${tableName} column(s): ${migrationAddedColumns.join(", ")}; move the index into an exported schemaMigrations ledger.`,
      });
    }

    return violations;
  });
}

export async function findBootSchemaDdlDisciplineViolations({ repoRoot, changedFilePaths } = {}) {
  const schemaFiles = await listSchemaFiles(path.join(repoRoot, "bounded-contexts"));
  const mergeBase = readMergeBase({ repoRoot });
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

    const relativeFilePath = normalizeRelative(repoRoot, filePath);
    const baseSource = readFileAtRevision({ repoRoot, revision: mergeBase, relativeFilePath });
    if (baseSource !== null) {
      for (const violation of findBootSchemaLedgerConvergenceViolations({ baseSource, currentSource: source })) {
        violations.push({
          file: relativeFilePath,
          line: 1,
          message: violation.message,
        });
      }
    }

    for (const violation of findBootSchemaMigrationAddedIndexViolationsInSource(source)) {
      violations.push({
        file: normalizeRelative(repoRoot, filePath),
        line: violation.line,
        message: violation.message,
      });
    }

    for (const violation of findSchemaMigrationDdlSafetyViolationsInSource(source, {
      baseSource: baseSource ?? undefined,
    })) {
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

function splitSqlStatements(sql) {
  const statements = [];
  let statementStart = 0;
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote && sql[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === "`" || character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ";") {
      continue;
    }

    statements.push({
      sql: sql.slice(statementStart, index + 1),
      startIndex: statementStart,
    });
    statementStart = index + 1;
  }

  if (statementStart < sql.length) {
    statements.push({
      sql: sql.slice(statementStart),
      startIndex: statementStart,
    });
  }

  return statements.filter((statement) => statement.sql.trim().length > 0);
}

function splitTopLevelCommaClauses(sql) {
  const clauses = [];
  let clauseStart = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if (quote === "'" && sql[index + 1] === "'") {
          index += 1;
          continue;
        }
        if (sql[index - 1] !== "\\") {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 0) {
      clauses.push(sql.slice(clauseStart, index));
      clauseStart = index + 1;
    }
  }

  clauses.push(sql.slice(clauseStart));
  return clauses;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const output = execFileSync("git", ["diff", "--name-only", `${mergeBase}...HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readMergeBase({ repoRoot }) {
  try {
    return execFileSync("git", ["merge-base", "origin/main", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readFileAtRevision({ repoRoot, revision, relativeFilePath }) {
  if (!revision) {
    return null;
  }
  try {
    return execFileSync("git", ["show", `${revision}:${relativeFilePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
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
    if (entry.isFile() && /schema.*\.ts$/i.test(entry.name) && !/\.(?:test|spec)\.ts$/i.test(entry.name)) {
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
