import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { readTrackedSidecarPaths } from "../lib/git-listing.mjs";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const guardedPredicate =
  /\b(?:generation|revision|version|token_generation|envelope_revision|(?:last_)?global_position|updated_at|state|status|lease(?:_id|_until)?|expires_at|fresh_until|display_identity_hash)\b/i;
const sidecarSuffix = ".lost-update-exceptions.json";
const templateLiteralPattern = /`([\s\S]*?)`/g;
const writeStatementPattern = /(?:^|;)\s*(UPDATE|DELETE\s+FROM)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b[\s\S]*/gm;

export async function validateLostUpdateWriteGuard({ repoRoot, runGit } = {}) {
  const rows = [];
  const sources = await sourceFiles(path.join(repoRoot, "bounded-contexts"));
  for (const file of sources) {
    const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
    if (!isReadModelOrProjectionFile(relativeFile)) continue;
    rows.push(...discoverWrites({ source: await readFile(file, "utf8"), relativeFile }));
  }

  const violations = [];
  const sidecarEntries = [];
  const sidecars = await sidecarFiles(path.join(repoRoot, "bounded-contexts"));
  const trackedSidecars = existsSync(path.join(repoRoot, ".git"))
    ? new Set(
        readTrackedSidecarPaths({
          cwd: repoRoot,
          runGit,
        })
          .split("\0")
          .filter(Boolean),
      )
    : null;
  const sourceByRelative = new Map(sources.map((file) => [path.relative(repoRoot, file).replaceAll("\\", "/"), file]));
  const bindingOwners = new Map();
  for (const sidecar of sidecars) {
    const sidecarErrorsBefore = violations.length;
    const relativeSidecar = path.relative(repoRoot, sidecar).replaceAll("\\", "/");
    if (trackedSidecars && !trackedSidecars.has(relativeSidecar))
      violations.push(`${relativeSidecar}: untracked sidecar cannot authorize a write.`);
    const sourceRelative = relativeSidecar.slice(0, -sidecarSuffix.length);
    if (!sourceByRelative.has(sourceRelative) || !isReadModelOrProjectionFile(sourceRelative)) {
      violations.push(`${relativeSidecar}: sidecar owner source is missing or ambiguous.`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(sidecar, "utf8"));
    } catch (error) {
      violations.push(`${relativeSidecar}: malformed sidecar (${error.message}).`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      violations.push(`${relativeSidecar}: sidecar must contain an array.`);
      continue;
    }
    const ids = new Set();
    for (const entry of parsed) {
      const errorsBefore = violations.length;
      const prefix = `${relativeSidecar}:`;
      if (!entry || typeof entry !== "object") {
        violations.push(`${prefix} entry must be an object.`);
        continue;
      }
      if (typeof entry.id !== "string" || entry.id.length < 8 || ids.has(entry.id))
        violations.push(`${prefix} entry id is missing or duplicated.`);
      ids.add(entry.id);
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 20 || /[\r\n]/.test(entry.reason))
        violations.push(
          `${prefix}${entry.id ?? "<unknown>"} needs a one-line justification of at least 20 characters.`,
        );
      if (entry.classification !== "key-only but safe")
        violations.push(`${prefix}${entry.id ?? "<unknown>"}: classification must be 'key-only but safe'.`);
      if (Object.keys(entry).sort().join(",") !== "binding,classification,id,reason")
        violations.push(`${prefix}${entry.id ?? "<unknown>"}: unexpected entry fields.`);
      const binding = normalizeBinding(entry.binding);
      if (!binding) {
        violations.push(`${prefix}${entry.id ?? "<unknown>"}: invalid statement binding.`);
        continue;
      }
      if (binding.module !== sourceRelative) violations.push(`${prefix}${entry.id}: cross-module statement binding.`);
      const identity = JSON.stringify({ source: sourceRelative, binding });
      if (bindingOwners.has(identity)) violations.push(`${prefix}${entry.id}: duplicate statement binding.`);
      bindingOwners.set(identity, entry.id);
      sidecarEntries.push({
        ...entry,
        binding,
        valid: errorsBefore === violations.length,
        sidecar: relativeSidecar,
        source: sourceRelative,
      });
    }
    if (violations.length !== sidecarErrorsBefore)
      for (const entry of sidecarEntries.filter((entry) => entry.sidecar === relativeSidecar)) entry.valid = false;
  }

  const rowBindingCounts = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row.binding);
    rowBindingCounts.set(key, (rowBindingCounts.get(key) ?? 0) + 1);
  }
  const sidecarEntriesByBinding = new Map();
  for (const entry of sidecarEntries) {
    const key = `${entry.source}\u0000${JSON.stringify(entry.binding)}`;
    const entries = sidecarEntriesByBinding.get(key) ?? [];
    entries.push(entry);
    sidecarEntriesByBinding.set(key, entries);
  }
  for (const row of rows) {
    if (!row.binding) {
      violations.push(`${row.id}: cannot enrich discovered write with a template binding.`);
      row.classification = row.guarded ? "guarded" : "key-only lost-update risk";
      continue;
    }
    const matches = sidecarEntriesByBinding.get(`${row.file}\u0000${JSON.stringify(row.binding)}`) ?? [];
    const resolvedRowCount = rowBindingCounts.get(JSON.stringify(row.binding)) ?? 0;
    if (matches.length && resolvedRowCount !== 1) violations.push(`${row.id}: ambiguous sidecar binding.`);
    if (matches.length > 1) violations.push(`${row.id}: duplicate sidecar binding.`);
    const credential = row.table === "channels_connection_credentials";
    if (credential && matches.length)
      violations.push(`${row.id}: credential predicates cannot be waived by a sidecar.`);
    const allowlisted = !credential && matches.length === 1 && matches[0].valid && resolvedRowCount === 1;
    row.classification = row.guarded ? "guarded" : allowlisted ? "key-only but safe" : "key-only lost-update risk";
    if (allowlisted && row.guarded)
      violations.push(`${row.id}: sidecar entry binds a guarded write and is not an exception.`);
    if (row.classification === "key-only lost-update risk") {
      violations.push(
        `${row.id}: key-only ${row.kind} on a read-model/projection table; add a read-state concurrency predicate or a justified local sidecar entry at ${row.file}${sidecarSuffix}: ${JSON.stringify(row.binding)}.`,
      );
    }
  }

  const rowIdentities = new Set(rows.map((row) => JSON.stringify({ file: row.file, binding: row.binding })));
  for (const entry of sidecarEntries) {
    if (!rowIdentities.has(JSON.stringify({ file: entry.source, binding: entry.binding })))
      violations.push(`${entry.sidecar}: stale sidecar entry '${entry.id}'.`);
  }
  return { violations, rows };
}

export function discoverWrites({ source, relativeFile }) {
  const literals = [...source.matchAll(templateLiteralPattern)];
  if (!literals.some((literal) => [...literal[1].matchAll(writeStatementPattern)].length)) return [];
  const sourceFile = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, scriptKind(relativeFile));
  const templates = new Map();
  const stack = [];
  const visit = (node) => {
    stack.push(node);
    if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral || node.kind === ts.SyntaxKind.TemplateExpression) {
      templates.set(node.getStart(sourceFile), { node, boundary: nearestNamedBoundary(stack, sourceFile) });
    }
    ts.forEachChild(node, visit);
    stack.pop();
  };
  visit(sourceFile);
  const rows = [];
  for (const literal of literals) {
    const sqlText = literal[1];
    const literalStart = literal.index ?? 0;
    for (const match of sqlText.matchAll(writeStatementPattern)) {
      const keywordOffset = literalStart + 1 + (match.index ?? 0) + match[0].search(/\b(?:UPDATE|DELETE\s+FROM)\b/i);
      const template = [...templates.entries()].findLast(
        ([start, { node }]) => start <= keywordOffset && keywordOffset < node.end,
      )?.[1];
      const kind = match[1].toUpperCase().startsWith("DELETE") ? "DELETE" : "UPDATE";
      // Preserve the original scanner's previous-line attribution exactly.
      const relativeOffset = literalStart + (match.index ?? 0);
      const sql = match[0];
      const where = sql.match(/\bWHERE\s+([\s\S]*?)(?:\bRETURNING\b|;|$)/i)?.[1] ?? "";
      const binding = template
        ? {
            module: relativeFile,
            kind,
            table: match[2],
            digest: templateDigest(template.node, sourceFile),
          }
        : null;
      const guarded =
        match[2] === "channels_connection_credentials"
          ? [
              "row_id",
              "token_generation",
              "envelope_revision",
              "version",
              "kind",
              "provider_key",
              "environment",
              "account_id",
              "connection_id",
              "payload_format",
              "created_at",
            ].every((column) => new RegExp(`\\b${column}\\s*=\\s*\\$\\d+\\b`, "i").test(where))
          : guardedPredicate.test(where);
      rows.push({
        id: `${relativeFile}:${source.slice(0, relativeOffset).split(/\r?\n/).length}:${kind}:${match[2]}`,
        file: relativeFile,
        line: source.slice(0, relativeOffset).split(/\r?\n/).length,
        kind,
        table: match[2],
        binding,
        boundary: template?.boundary ?? null,
        guarded,
      });
    }
  }
  const bindingCounts = new Map();
  for (const row of rows) {
    const identity = JSON.stringify(row.binding);
    bindingCounts.set(identity, (bindingCounts.get(identity) ?? 0) + 1);
  }
  for (const row of rows) {
    if (row.binding && bindingCounts.get(JSON.stringify(row.binding)) > 1)
      row.binding = { ...row.binding, boundary: row.boundary };
  }
  return rows;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return null;
  if (
    typeof binding.module !== "string" ||
    typeof binding.kind !== "string" ||
    !["UPDATE", "DELETE"].includes(binding.kind) ||
    typeof binding.table !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(binding.table) ||
    typeof binding.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.digest)
  )
    return null;
  if (binding.boundary !== undefined && (typeof binding.boundary !== "string" || !binding.boundary.length)) return null;
  if (Object.keys(binding).some((key) => !["module", "kind", "table", "digest", "boundary"].includes(key))) return null;
  return {
    module: binding.module,
    kind: binding.kind,
    table: binding.table,
    digest: binding.digest,
    ...(binding.boundary ? { boundary: binding.boundary } : {}),
  };
}

function nearestNamedBoundary(stack, sourceFile) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const node = stack[index];
    let name = null;
    if (
      node.kind === ts.SyntaxKind.FunctionDeclaration ||
      node.kind === ts.SyntaxKind.MethodDeclaration ||
      node.kind === ts.SyntaxKind.GetAccessor ||
      node.kind === ts.SyntaxKind.SetAccessor ||
      node.kind === ts.SyntaxKind.Constructor
    ) {
      name = node.name?.getText(sourceFile) ?? null;
    } else if (node.kind === ts.SyntaxKind.FunctionExpression || node.kind === ts.SyntaxKind.ArrowFunction) {
      name = node.name?.getText(sourceFile) ?? null;
      const parent = stack[index - 1];
      if (!name && parent?.kind === ts.SyntaxKind.PropertyAssignment && parent.initializer === node)
        name = parent.name?.getText(sourceFile) ?? null;
    }
    if (name) return name;
  }
  return null;
}

function templateDigest(node, sourceFile) {
  const source = sourceFile.text;
  if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
    return createHash("sha256")
      .update(JSON.stringify([source.slice(node.getStart(sourceFile) + 1, node.end - 1)]), "utf8")
      .digest("hex");
  const pieces = [source.slice(node.getStart(sourceFile) + 1, node.head.end - 2)];
  for (const span of node.templateSpans) {
    pieces.push(expressionTokens(span.expression, sourceFile));
    const literalStart = span.literal.getStart(sourceFile) + 1;
    const literalEnd = span.literal.end - (span.literal.kind === ts.SyntaxKind.LastTemplateToken ? 1 : 2);
    pieces.push(source.slice(literalStart, literalEnd));
  }
  return createHash("sha256").update(JSON.stringify(pieces), "utf8").digest("hex");
}

function expressionTokens(node, sourceFile) {
  const children = node.getChildren(sourceFile);
  return children.length
    ? children.flatMap((child) => expressionTokens(child, sourceFile))
    : [[node.kind, node.getText(sourceFile)]];
}

function scriptKind(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.ts$/.test(file)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isReadModelOrProjectionFile(file) {
  return (
    /\/(?:read-model)\//.test(file) ||
    /(?:projection|queue)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) ||
    file === "bounded-contexts/channels/features/credentials/api/runtime.ts"
  );
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "tests", "__tests__"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(entryPath)));
    else if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
    )
      files.push(entryPath);
  }
  return files;
}

async function sidecarFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "tests", "__tests__"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sidecarFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(sidecarSuffix)) files.push(entryPath);
  }
  return files;
}

if (process.argv[1]?.endsWith("lost-update-write-guard.mjs")) {
  const result = await validateLostUpdateWriteGuard({ repoRoot: process.cwd() });
  if (process.argv.includes("--inventory")) console.log(JSON.stringify(result.rows, null, 2));
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
}
