import path from "node:path";
import { format, resolveConfig } from "prettier";

export const sqlPartitionPath = path.join(import.meta.dirname, "sql-execution-surface-partition.json");

export async function formatSqlPartition(partition) {
  const config = await resolveConfig(sqlPartitionPath, { editorconfig: true });
  return format(JSON.stringify(partition, null, 2), { ...config, filepath: sqlPartitionPath });
}
