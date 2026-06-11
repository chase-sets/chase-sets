import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Shared output writer for the evidence/readiness/canary generators: ensures
// the parent directory exists and writes a pretty-printed JSON record with a
// trailing newline (the format every generator already used).

export async function writeJsonRecord(outPath, record) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
}
