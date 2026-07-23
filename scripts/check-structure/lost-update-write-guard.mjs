import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const guardedPredicate =
  /\b(?:generation|revision|version|(?:last_)?global_position|updated_at|state|status|lease(?:_id|_until)?|expires_at|fresh_until|display_identity_hash)\b/i;

export async function validateLostUpdateWriteGuard({
  repoRoot,
  allowlistPath = "scripts/check-structure/lost-update-write-guard-allowlist.json",
}) {
  const allowlist = JSON.parse(await readFile(path.join(repoRoot, allowlistPath), "utf8"));
  const allowed = new Map(allowlist.map((entry) => [entry.id, entry]));
  const rows = [];
  for (const file of await sourceFiles(path.join(repoRoot, "bounded-contexts"))) {
    const relativeFile = path.relative(repoRoot, file).replaceAll("\\", "/");
    if (!isReadModelOrProjectionFile(relativeFile)) continue;
    const source = await readFile(file, "utf8");
    for (const statement of sqlWrites(source)) {
      const where = statement.sql.match(/\bWHERE\s+([\s\S]*?)(?:\bRETURNING\b|;|$)/i)?.[1] ?? "";
      const id = `${relativeFile}:${statement.line}:${statement.kind}:${statement.table}`;
      const guarded = guardedPredicate.test(where);
      const allowlisted = allowed.has(id);
      rows.push({
        id,
        file: relativeFile,
        line: statement.line,
        kind: statement.kind,
        table: statement.table,
        classification: guarded ? "guarded" : allowlisted ? "key-only but safe" : "key-only lost-update risk",
      });
    }
  }
  const discovered = new Set(rows.map((row) => row.id));
  const violations = rows
    .filter((row) => row.classification === "key-only lost-update risk")
    .map(
      (row) =>
        `${row.id}: key-only ${row.kind} on a read-model/projection table; add a read-state concurrency predicate or a justified allowlist entry.`,
    );
  for (const entry of allowlist) {
    if (!discovered.has(entry.id)) violations.push(`${allowlistPath}: stale allowlist entry '${entry.id}'.`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
      violations.push(`${allowlistPath}: '${entry.id}' needs a one-line justification of at least 20 characters.`);
  }
  return { violations, rows };
}

function isReadModelOrProjectionFile(file) {
  return /\/(?:read-model)\//.test(file) || /(?:projection|queue)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file);
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

function sqlWrites(source) {
  const writes = [];
  for (const literal of source.matchAll(/`([\s\S]*?)`/g)) {
    const sql = literal[1];
    const literalStart = literal.index ?? 0;
    for (const match of sql.matchAll(/(?:^|;)\s*(UPDATE|DELETE\s+FROM)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b[\s\S]*/gm)) {
      const kind = match[1].toUpperCase().startsWith("DELETE") ? "DELETE" : "UPDATE";
      const start = literalStart + (match.index ?? 0);
      writes.push({ kind, table: match[2], sql: match[0], line: source.slice(0, start).split(/\r?\n/).length });
    }
  }
  return writes;
}

if (process.argv[1]?.endsWith("lost-update-write-guard.mjs")) {
  const repoRoot = process.cwd();
  const result = await validateLostUpdateWriteGuard({ repoRoot });
  if (process.argv.includes("--inventory")) console.log(JSON.stringify(result.rows, null, 2));
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
}
