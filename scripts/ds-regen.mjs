#!/usr/bin/env node
// Composition entrypoint that refreshes every generated design-system ledger in one
// command. Each step spawns an existing generator script unchanged, in the fixed order
// below, and stops at the first failing child so the offending script is unambiguous.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultScriptsDir = dirname(fileURLToPath(import.meta.url));

export const DS_REGEN_STEPS = Object.freeze([
  Object.freeze({
    name: "design-system-component-index",
    script: "generate-design-system-component-index.mjs",
    args: Object.freeze([]),
  }),
  Object.freeze({
    name: "design-system-hoc-budget",
    script: "design-system-hoc-budget.mjs",
    args: Object.freeze(["--write"]),
  }),
  Object.freeze({
    name: "design-system-raw-ui-budget",
    script: "design-system-raw-ui-budget.mjs",
    args: Object.freeze(["--write"]),
  }),
  Object.freeze({
    name: "responsive-safety",
    script: "check-responsive-safety.mjs",
    args: Object.freeze(["--write"]),
  }),
]);

function runStep(step, scriptsDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptsDir, step.script), ...step.args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

export async function runDsRegen({ scriptsDir = defaultScriptsDir } = {}) {
  for (const step of DS_REGEN_STEPS) {
    const code = await runStep(step, scriptsDir);
    if (code !== 0) {
      return { code, failedStep: step };
    }
  }
  return { code: 0, failedStep: null };
}

async function main() {
  const { code, failedStep } = await runDsRegen();
  if (failedStep) {
    console.error(`ds:regen failed: ${failedStep.name} (${failedStep.script}) exited with code ${code}`);
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
