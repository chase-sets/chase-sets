import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const censusModulePath = fileURLToPath(import.meta.url);

function temporaryEnvironmentKeys() {
  return ["TEMP", "TMP", "TMPDIR"];
}

export async function setupScriptBatteryTempCensus() {
  const previous = new Map(temporaryEnvironmentKeys().map((key) => [key, process.env[key]]));
  const privateDirectory = await mkdtemp(path.join(os.tmpdir(), "chase-sets-script-battery-"));
  for (const key of temporaryEnvironmentKeys()) process.env[key] = privateDirectory;

  return async function teardownScriptBatteryTempCensus() {
    let survivors = [];
    try {
      survivors = await readdir(privateDirectory);
      if (survivors.length > 0) {
        throw new Error(`script battery temporary census found surviving entries: ${survivors.join(", ")}`);
      }
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

export const scriptBatteryTempCensusGlobalSetupPath = censusModulePath;

export default async function setupScriptBatteryTempCensusGlobalSetup() {
  return setupScriptBatteryTempCensus();
}
