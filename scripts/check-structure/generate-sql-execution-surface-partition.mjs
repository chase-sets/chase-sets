import { writeFileSync } from "node:fs";
import path from "node:path";
import { formatSqlPartition, sqlPartitionPath } from "./sql-execution-surface-partition-format.mjs";
import {
  classifySqlExecutionSurface,
  exceptionalSqlPartition,
  listNonTestTypeScriptModules,
} from "./sql-execution-surface.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const files = listNonTestTypeScriptModules(repoRoot);
const result = classifySqlExecutionSurface({ repoRoot, files });
const partition = exceptionalSqlPartition(files, result);
writeFileSync(sqlPartitionPath, await formatSqlPartition(partition), "utf8");
console.log(
  `Wrote ${path.relative(repoRoot, sqlPartitionPath).replaceAll("\\", "/")}: ` +
    `${partition.sqlExecuting.length} SQL-executing, ${partition.unprovableForm.length} unprovable-form, ` +
    `${result.modules.length - partition.sqlExecuting.length - partition.unprovableForm.length} not-SQL; ` +
    `${partition.unresolvedMemberRoots.count} unresolved member roots.`,
);
