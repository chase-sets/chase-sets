import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const censusModulePath = fileURLToPath(import.meta.url);

function temporaryEnvironmentKeys() {
  return ["TEMP", "TMP", "TMPDIR", "NODE_COMPILE_CACHE", "TSX_DISABLE_CACHE"];
}

export async function setupScriptBatteryTempCensus() {
  const originalTmpdir = os.tmpdir();
  const previous = new Map(temporaryEnvironmentKeys().map((key) => [key, process.env[key]]));
  const privateDirectory = await mkdtemp(path.join(originalTmpdir, "chase-sets-script-battery-"));
  if (process.env.NODE_COMPILE_CACHE === undefined) {
    process.env.NODE_COMPILE_CACHE = path.join(originalTmpdir, "node-compile-cache");
  }
  process.env.TSX_DISABLE_CACHE = "1";
  for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = privateDirectory;

  return async function teardownScriptBatteryTempCensus() {
    let survivors = [];
    try {
      survivors = (await readdir(privateDirectory)).sort();
      if (survivors.length > 0) {
        throw new Error(`script battery temporary census found surviving entries: ${survivors.join(", ")}`);
      }
    } finally {
      try {
        await rm(privateDirectory, { recursive: true, force: true });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  };
}

export const scriptBatteryTempCensusGlobalSetupPath = censusModulePath;

export default async function setupScriptBatteryTempCensusGlobalSetup() {
  const teardown = await setupScriptBatteryTempCensus();
  return async () => {
    try {
      await teardown();
    } catch (error) {
      process.exitCode = 1;
      throw error;
    }
  };
}
