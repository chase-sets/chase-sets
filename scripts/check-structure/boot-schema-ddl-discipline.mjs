import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

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
  return exportedSchemaDeclarations(source, "SchemaSql").flatMap(({ declaration, sourceFile }) => {
    const initializer = unwrapExpression(declaration.initializer);
    if (!initializer || !(ts.isNoSubstitutionTemplateLiteral(initializer) || ts.isTemplateExpression(initializer))) {
      return [];
    }
    const sql = source.slice(initializer.getStart(sourceFile) + 1, initializer.end - 1);
    return [
      {
        name: declaration.name.text,
        sql,
        startLine: lineNumberAt(source.slice(0, initializer.getStart(sourceFile) + 1)),
        ...(ts.isTemplateExpression(initializer) || sql !== initializer.text ? { valid: false } : {}),
      },
    ];
  });
}

export function extractSchemaMigrationLedgers(source) {
  return exportedSchemaDeclarations(source, "SchemaMigrations").flatMap(({ declaration, sourceFile }) => {
    const initializer = unwrapExpression(declaration.initializer);
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
      return [];
    }
    const start = initializer.getStart(sourceFile) + 1;
    return [
      {
        name: declaration.name.text,
        body: source.slice(start, initializer.end - 1),
        startLine: lineNumberAt(source.slice(0, start)),
      },
    ];
  });
}

export function extractSchemaMigrationStatements(source) {
  const statements = [];
  for (const { declaration, sourceFile } of exportedSchemaDeclarations(source, "SchemaMigrations")) {
    const constants = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const constant of statement.declarationList.declarations) {
        if (!ts.isIdentifier(constant.name)) continue;
        const value = unwrapExpression(constant.initializer);
        constants.set(constant.name.text, constants.has(constant.name.text) ? null : value);
      }
    }
    const ledger = unwrapExpression(declaration.initializer);
    const blocks = ledger && ts.isArrayLiteralExpression(ledger) ? ledger.elements : [declaration];
    const ids = new Set();
    const migrations = blocks.map((block) => {
      const properties = new Map();
      let valid = sourceFile.parseDiagnostics.length === 0 && ts.isObjectLiteralExpression(block);
      for (const property of ts.isObjectLiteralExpression(block) ? block.properties : []) {
        if (!ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name)) {
          valid = false;
          continue;
        }
        if (properties.has(property.name.text)) valid = false;
        properties.set(property.name.text, unwrapExpression(property.initializer));
      }
      const id = properties.get("migrationId");
      const migrationId = id && ts.isStringLiteral(id) ? id.text : null;
      if (!migrationId || ids.has(migrationId)) valid = false;
      ids.add(migrationId);
      const array = properties.get("statements");
      if (!array || !ts.isArrayLiteralExpression(array) || array.elements.length === 0) valid = false;
      const sqlStatements = [];
      for (const element of array && ts.isArrayLiteralExpression(array) ? array.elements : []) {
        const expression = unwrapExpression(element);
        const value = ts.isIdentifier(expression) ? constants.get(expression.text) : expression;
        if (!value || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          valid = false;
          continue;
        }
        const sql = source.slice(value.getStart(sourceFile) + 1, value.end - 1);
        if (sql !== value.text) valid = false;
        sqlStatements.push({
          sql,
          startLine: lineNumberAt(source.slice(0, value.getStart(sourceFile))),
        });
      }
      return {
        ledgerName: declaration.name.text,
        migrationId,
        startLine: lineNumberAt(source.slice(0, (array ?? block).getStart(sourceFile))),
        statements: sqlStatements,
        valid,
        orderedProofEligible: [...properties].every(
          ([name, value]) =>
            name === "migrationId" ||
            name === "statements" ||
            (name === "description" && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))),
        ),
      };
    });
    if (migrations.some((migration) => !migration.valid)) {
      for (const migration of migrations) migration.valid = false;
    }
    statements.push(...migrations);
  }
  return statements;
}

function exportedSchemaDeclarations(source, suffix) {
  const sourceFile = ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return [];
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text.endsWith(suffix))
      .map((declaration) => ({ declaration, sourceFile }));
  });
}

function unwrapExpression(expression) {
  while (
    expression &&
    (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression))
  ) {
    expression = expression.expression;
  }
  return expression;
}

function hasCompleteOrderedProofSource(source) {
  const sourceFile = ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length !== 0) return false;
  const templates = extractExportedBootSchemaSqlTemplates(source);
  const ledgers = extractSchemaMigrationLedgers(source);
  const migrations = extractSchemaMigrationStatements(source);
  if (new Set(migrations.map(({ migrationId }) => migrationId)).size !== migrations.length) return false;
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement))
      continue;
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    if (
      ts.isExportDeclaration(statement) &&
      (statement.isTypeOnly ||
        (statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((element) => element.isTypeOnly)))
    )
      continue;
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const ||
      statement.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword)
    )
      return false;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || bindings.has(declaration.name.text)) return false;
      const name = declaration.name.text;
      bindings.add(name);
      const initializer = unwrapExpression(declaration.initializer);
      if (!initializer) return false;
      if (exported && name.endsWith("SchemaSql")) {
        const records = templates.filter((template) => template.name === name);
        if (records.length !== 1 || records[0].valid === false) return false;
      } else if (exported && name.endsWith("SchemaMigrations")) {
        if (ledgers.filter((ledger) => ledger.name === name).length !== 1) return false;
        if (
          migrations.some(
            (migration) => migration.ledgerName === name && (!migration.valid || !migration.orderedProofEligible),
          )
        )
          return false;
      } else if (
        !ts.isStringLiteral(initializer) &&
        !ts.isNoSubstitutionTemplateLiteral(initializer) &&
        !ts.isNumericLiteral(initializer) &&
        initializer.kind !== ts.SyntaxKind.TrueKeyword &&
        initializer.kind !== ts.SyntaxKind.FalseKeyword &&
        initializer.kind !== ts.SyntaxKind.NullKeyword
      ) {
        return false;
      }
    }
  }
  return true;
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

export function findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource }) {
  const baseTables = extractBootSchemaTableColumns(baseSource);
  const currentTables = extractBootSchemaTableColumns(currentSource);
  const bootExpansionColumns = extractBootSchemaIdempotentExpansionColumns(currentSource);
  const violations = [];

  for (const [tableName, currentColumns] of currentTables) {
    const baseColumns = baseTables.get(tableName);
    if (!baseColumns) {
      continue;
    }

    const expandedColumns = bootExpansionColumns.get(tableName) ?? new Set();
    for (const columnName of currentColumns) {
      if (
        baseColumns.has(columnName) ||
        expandedColumns.has(columnName) ||
        hasOrderedRetainedColumnProof({ baseSource, currentSource, tableName, columnName })
      ) {
        continue;
      }

      violations.push({
        tableName,
        columnName,
        message: `fresh-boot column ${tableName}.${columnName} has no idempotent boot ADD COLUMN expansion; retained databases can reach a dependent boot consumer before ledger migrations (#7751).`,
      });
    }
  }

  return violations;
}

function hasOrderedRetainedColumnProof({ baseSource, currentSource, tableName, columnName }) {
  if (!hasCompleteOrderedProofSource(baseSource) || !hasCompleteOrderedProofSource(currentSource)) return false;
  const templates = extractExportedBootSchemaSqlTemplates(currentSource);
  if (
    templates.some((template) => template.valid === false) ||
    new Set(templates.map(({ name }) => name)).size !== templates.length
  )
    return false;
  const tablePattern = new RegExp(
    `^CREATE\\s+(?:UNLOGGED\\s+)?TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${escapeRegExp(tableName)}\\s*\\(`,
    "i",
  );
  const columnPattern = new RegExp(`\\b${escapeRegExp(columnName)}\\b`, "i");
  const tableReferencePattern = new RegExp(`\\b${escapeRegExp(tableName)}\\b`, "i");
  const bootAlterPattern = new RegExp(
    `^ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?(?:\\s+ONLY)?\\s+${escapeRegExp(tableName)}\\s+([\\s\\S]+)$`,
    "i",
  );
  const bootStatements = templates.flatMap((template) =>
    maskSqlNonExecutableText(template.sql)
      .split(";")
      .filter((sql) => sql.trim())
      .map((sql) => ({ template, sql: sql.trim() })),
  );
  const creates = bootStatements.filter(({ sql }) => tablePattern.test(sql));
  if (
    creates.length !== 1 ||
    bootStatements.some(({ sql }) => {
      if (tablePattern.test(sql)) return false;
      if (columnPattern.test(sql) || /^(?:DO|CALL|EXECUTE)\b/i.test(sql)) return true;
      if (!tableReferencePattern.test(sql)) return false;
      const alter = bootAlterPattern.exec(sql);
      return (
        !alter ||
        splitTopLevelCommaClauses(alter[1]).some(
          (clause) => !/^\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_]/i.test(clause),
        )
      );
    })
  )
    return false;
  const createSql = creates[0].sql;
  const columnsStart = tablePattern.exec(createSql)[0].length - 1;
  const columnsEnd = findBalancedEnd(createSql, columnsStart, "(", ")");
  const declarationPattern = new RegExp(`^\\s*"?${escapeRegExp(columnName)}"?\\s+[A-Za-z_]`, "i");
  if (
    columnsEnd === -1 ||
    splitTopLevelCommaClauses(createSql.slice(columnsStart + 1, columnsEnd)).filter((clause) =>
      declarationPattern.test(clause),
    ).length !== 1
  )
    return false;
  const ledgerName = creates[0].template.name.replace(/SchemaSql$/, "SchemaMigrations");
  const currentLedgers = extractSchemaMigrationLedgers(currentSource).filter((ledger) => ledger.name === ledgerName);
  const baseLedgers = extractSchemaMigrationLedgers(baseSource).filter((ledger) => ledger.name === ledgerName);
  if (currentLedgers.length !== 1 || baseLedgers.length !== 1) return false;
  const current = extractSchemaMigrationStatements(currentSource).filter(
    (migration) => migration.ledgerName === ledgerName,
  );
  const base = extractSchemaMigrationStatements(baseSource).filter((migration) => migration.ledgerName === ledgerName);
  if (
    extractSchemaMigrationStatements(currentSource).some(
      (migration) =>
        migration.ledgerName !== ledgerName &&
        (!migration.valid ||
          migration.statements.some(({ sql }) =>
            maskSqlNonExecutableText(sql)
              .split(";")
              .some((statement) => columnPattern.test(statement) || /^\s*(?:DO|CALL|EXECUTE)\b/i.test(statement)),
          )),
    )
  )
    return false;
  if (base.length === 0 || current.length <= base.length || [...base, ...current].some((migration) => !migration.valid))
    return false;
  for (let index = 0; index < base.length; index += 1) {
    if (
      base[index].migrationId !== current[index].migrationId ||
      JSON.stringify(base[index].statements.map(({ sql }) => sql)) !==
        JSON.stringify(current[index].statements.map(({ sql }) => sql))
    )
      return false;
  }
  const ordered = current.flatMap((migration, index) =>
    migration.statements.flatMap(({ sql }) =>
      maskSqlNonExecutableText(sql)
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => ({ migrationIndex: index, sql: statement.trim() })),
    ),
  );
  const alterPattern = new RegExp(`^ALTER\\s+TABLE(?:\\s+ONLY)?\\s+${escapeRegExp(tableName)}\\s+([\\s\\S]+)$`, "i");
  const addPattern = new RegExp(
    `^ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${escapeRegExp(columnName)}\\s+[A-Za-z_][A-Za-z0-9_]*(?:\\b|\\[)`,
    "i",
  );
  const anyAddPattern = new RegExp(
    `^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${escapeRegExp(columnName)}\\b`,
    "i",
  );
  const additions = ordered.flatMap((statement, index) => {
    const alter = alterPattern.exec(statement.sql);
    return alter
      ? splitTopLevelCommaClauses(alter[1])
          .filter((clause) => anyAddPattern.test(clause.trim()))
          .map((clause) => ({ index, valid: addPattern.test(clause.trim()) }))
      : [];
  });
  if (additions.length !== 1 || !additions[0].valid) return false;
  const addition = additions[0].index;
  if (ordered[addition].migrationIndex < base.length) return false;
  const before = ordered.slice(0, addition);
  const normalizerPattern = new RegExp(
    `^UPDATE\\s+${escapeRegExp(tableName)}\\s+SET\\b[\\s\\S]*\\bWHERE\\b[\\s\\S]*\\bIS\\s+NULL\\b`,
    "i",
  );
  return (
    before.some(({ migrationIndex, sql }) => migrationIndex < base.length && normalizerPattern.test(sql)) &&
    before.every(({ sql }) => !columnPattern.test(sql) && !/^(?:DO|CALL|EXECUTE|SELECT|INSERT)\b/i.test(sql))
  );
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
    if (!migration.valid) {
      return [
        {
          line: migration.startLine,
          message:
            "schema migration ledger cannot be fully resolved from unique migration IDs and literal statements; opaque or malformed source cannot prove DDL safety.",
        },
      ];
    }
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
      for (const violation of findBootSchemaRetainedUpgradeViolations({ baseSource, currentSource: source })) {
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

function extractBootSchemaIdempotentExpansionColumns(source) {
  const columnsByTable = new Map();
  const alterTablePattern =
    /\bALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?\s+([A-Za-z_][A-Za-z0-9_.]*)\s+([\s\S]*?);/gi;
  const addColumnPattern = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

  for (const template of extractExportedBootSchemaSqlTemplates(source)) {
    const executableSql = maskSqlNonExecutableText(template.sql);
    for (const alterMatch of executableSql.matchAll(alterTablePattern)) {
      const tableName = alterMatch[1].toLowerCase();
      const columns = columnsByTable.get(tableName) ?? new Set();
      for (const columnMatch of alterMatch[2].matchAll(addColumnPattern)) {
        columns.add(columnMatch[1].toLowerCase());
      }
      columnsByTable.set(tableName, columns);
    }
  }

  return columnsByTable;
}

function maskSqlNonExecutableText(sql) {
  const masked = sql.split("");
  const mask = (index) => {
    if (sql[index] !== "\n" && sql[index] !== "\r") {
      masked[index] = " ";
    }
  };
  let index = 0;

  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        mask(index);
        index += 1;
      }
      continue;
    }

    if (sql.startsWith("/*", index)) {
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith("/*", index)) {
          mask(index);
          mask(index + 1);
          depth += 1;
          index += 2;
          continue;
        }
        if (sql.startsWith("*/", index)) {
          mask(index);
          mask(index + 1);
          depth -= 1;
          index += 2;
          if (depth === 0) {
            break;
          }
          continue;
        }
        mask(index);
        index += 1;
      }
      continue;
    }

    if (sql[index] === "'") {
      const backslashEscapes =
        /[eE]/.test(sql[index - 1] ?? "") && (index < 2 || !/[A-Za-z0-9_$]/.test(sql[index - 2]));
      mask(index);
      index += 1;
      while (index < sql.length) {
        mask(index);
        if (backslashEscapes && sql[index] === "\\" && index + 1 < sql.length) {
          mask(index + 1);
          index += 2;
          continue;
        }
        if (sql[index] !== "'") {
          index += 1;
          continue;
        }
        if (sql[index + 1] === "'") {
          mask(index + 1);
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }

    if (sql[index] === "$" && (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1]))) {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        const maskedEnd = end === -1 ? sql.length : end + delimiter.length;
        while (index < maskedEnd) {
          mask(index);
          index += 1;
        }
        continue;
      }
    }

    index += 1;
  }

  return masked.join("");
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
