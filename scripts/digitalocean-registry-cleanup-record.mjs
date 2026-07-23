import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateDigitalOceanRegistryCleanupRecord } from "./digitalocean-registry-cleanup.mjs";

function readRecordPath(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--record=")) return value.slice("--record=".length);
    if (value === "--record") return argv[index + 1] ?? null;
  }
  return null;
}

async function main(argv) {
  const recordPath = readRecordPath(argv);
  if (!recordPath) {
    console.error("Registry cleanup canonical record path is required.");
    return 1;
  }

  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch {
    console.error("Registry cleanup canonical record is missing or is not valid JSON.");
    return 1;
  }

  const errors = validateDigitalOceanRegistryCleanupRecord(record);
  if (errors.length > 0) {
    console.error(`Registry cleanup canonical record failed validation (${errors.length} field error(s)).`);
    return 1;
  }
  console.log("Registry cleanup canonical record validated.");
  return 0;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
