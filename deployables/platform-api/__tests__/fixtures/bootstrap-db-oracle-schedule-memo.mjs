import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const oracleUrl = new URL("./bootstrap-db-schedule-before-subset-reuse.mjs", import.meta.url);
const memoUrl = new URL("./bootstrap-db-oracle-schedule-memo.json", import.meta.url);
const oracleSha256 = "d3b96de0c4051a7021f8f00869d19dd13314166b8dc81244c2bb554a2493847b";

export function createPinnedOracleModuleSource(source, instrumentation) {
  assert.equal(createHash("sha256").update(source).digest("hex"), oracleSha256);
  const compilerUrl = pathToFileURL(createRequire(import.meta.url).resolve("@chase-sets/typescript-compiler-api"));
  return `${source
    .replace('"@chase-sets/typescript-compiler-api"', JSON.stringify(compilerUrl.href))
    .replaceAll("import.meta.url", JSON.stringify(oracleUrl.href))}\n${instrumentation}`;
}

async function generateMemo() {
  const { bootstrapDbEnrollmentManifest, bootstrapDbExecutionUnitBootBearingCaseCeilings, bootstrapDbScheduleModel } =
    await import("../../scripts/check-bootstrap-db-enrollment.mjs");
  const moduleSource = createPinnedOracleModuleSource(
    readFileSync(oracleUrl, "utf8"),
    `
const rawListSchedule = worstCaseListScheduleMs;
export const entries = new Map();
worstCaseListScheduleMs = (durations, workers) => {
  const key = JSON.stringify([workers, durations]);
  const value = rawListSchedule(durations, workers);
  if (entries.has(key) && entries.get(key) !== value) {
    throw new Error("Pinned oracle returned inconsistent values for " + key);
  }
  entries.set(key, value);
  return value;
};
`,
  );
  const oracle = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);
  oracle.checkBootstrapDbEnrollment({
    platformApiRoot: resolve(fileURLToPath(new URL("../../", import.meta.url))),
    manifest: bootstrapDbEnrollmentManifest,
    executionUnitBootBearingCaseCeilings: bootstrapDbExecutionUnitBootBearingCaseCeilings,
    scheduleModel: bootstrapDbScheduleModel,
  });
  assert.equal(oracle.entries.size, 4095, "Repository oracle scheduler key set changed");
  const entries = Object.fromEntries(
    [...oracle.entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return `${JSON.stringify({ oracleSha256, entries }, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--check"),
    "Usage: node __tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs [--check]",
  );
  const started = performance.now();
  const bytes = Buffer.from(await generateMemo());
  if (process.argv[2] === "--check") {
    assert.ok(readFileSync(memoUrl).equals(bytes), "Oracle schedule memo differs from raw pinned recomputation");
  } else {
    writeFileSync(memoUrl, bytes);
  }
  console.log(
    JSON.stringify({
      mode: process.argv[2] === "--check" ? "check" : "write",
      entries: 4095,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      durationMs: performance.now() - started,
    }),
  );
}
