import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classifySqlExecutionSurface, listNonTestTypeScriptModules } from "./sql-execution-surface.mjs";

export function generateSqlExecutionSurfacePartition(repoRoot, { execGit = undefined } = {}) {
  const files = listNonTestTypeScriptModules(repoRoot, execGit === undefined ? {} : { execGit });
  const result = classifySqlExecutionSurface({ repoRoot, files });
  return {
    sqlExecuting: result.modules.filter((module) => module.outcome === "sql-executing").map((module) => module.file),
    unprovableForm: result.modules
      .filter((module) => module.outcome === "unprovable-form")
      .map((module) => module.file),
    notSql: result.modules.filter((module) => module.outcome === "not-sql").map((module) => module.file),
    unresolvedMemberRoots: result.unresolvedMemberRoots,
  };
}

export function writeSqlExecutionSurfacePartition({
  repoRoot = path.resolve(import.meta.dirname, "../.."),
  outputPath = path.join(import.meta.dirname, "sql-execution-surface-partition.json"),
  execGit = undefined,
} = {}) {
  const partition = generateSqlExecutionSurfacePartition(repoRoot, { execGit });
  writeFileSync(outputPath, `${JSON.stringify(partition, null, 2)}\n`, "utf8");
  return { outputPath, partition };
}

function main() {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const { outputPath, partition } = writeSqlExecutionSurfacePartition({ repoRoot });
  console.log(
    `Wrote ${path.relative(repoRoot, outputPath).replaceAll("\\", "/")}: ` +
      `${partition.sqlExecuting.length} SQL-executing, ${partition.unprovableForm.length} unprovable-form, ` +
      `${partition.notSql.length} not-SQL; ${partition.unresolvedMemberRoots.count} unresolved member roots.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
