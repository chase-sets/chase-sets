import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  classifySqlExecutionSurface,
  exceptionalSqlPartition,
  listNonTestTypeScriptModules,
} from "./sql-execution-surface.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const files = listNonTestTypeScriptModules(repoRoot);
const result = classifySqlExecutionSurface({ repoRoot, files });
const partition = exceptionalSqlPartition(files, result);
const outputPath = path.join(import.meta.dirname, "sql-execution-surface-partition.json");
writeFileSync(outputPath, `${JSON.stringify(partition, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${path.relative(repoRoot, outputPath).replaceAll("\\", "/")}: ` +
    `${partition.sqlExecuting.length} SQL-executing, ${partition.unprovableForm.length} unprovable-form, ` +
    `${result.modules.length - partition.sqlExecuting.length - partition.unprovableForm.length} not-SQL; ` +
    `${partition.unresolvedMemberRoots.count} unresolved member roots.`,
);
