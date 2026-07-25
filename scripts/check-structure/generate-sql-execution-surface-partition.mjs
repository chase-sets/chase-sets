import { writeFileSync } from "node:fs";
import path from "node:path";
import { classifySqlExecutionSurface, listNonTestTypeScriptModules } from "./sql-execution-surface.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const files = listNonTestTypeScriptModules(repoRoot);
const result = classifySqlExecutionSurface({ repoRoot, files });
const partition = {
  sqlExecuting: result.modules.filter((module) => module.outcome === "sql-executing").map((module) => module.file),
  unprovableForm: result.modules.filter((module) => module.outcome === "unprovable-form").map((module) => module.file),
  notSql: result.modules.filter((module) => module.outcome === "not-sql").map((module) => module.file),
  unresolvedMemberRoots: result.unresolvedMemberRoots,
};
const outputPath = path.join(import.meta.dirname, "sql-execution-surface-partition.json");
writeFileSync(outputPath, `${JSON.stringify(partition, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${path.relative(repoRoot, outputPath).replaceAll("\\", "/")}: ` +
    `${partition.sqlExecuting.length} SQL-executing, ${partition.unprovableForm.length} unprovable-form, ` +
    `${partition.notSql.length} not-SQL; ${partition.unresolvedMemberRoots.count} unresolved member roots.`,
);
