import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { runDsRegen } from "./ds-regen.mjs";

const temporaryRoots = [];
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function stubScriptsDir() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ds-regen-stub-"));
  temporaryRoots.push(root);
  return root;
}

function writeRecordingStub(scriptsDir, filename, logPath, { exitCode = 0 } = {}) {
  const source = [
    'import { appendFileSync } from "node:fs";',
    "const argv = process.argv.slice(2);",
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ script: ${JSON.stringify(filename)}, argv }) + "\\n");`,
    `process.exitCode = ${exitCode};`,
    "",
  ].join("\n");
  writeFileSync(path.join(scriptsDir, filename), source);
}

function readLog(logPath) {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("ds:regen composition", () => {
  it("spawns the four generators in the fixed order with independently pinned argv", async () => {
    const scriptsDir = stubScriptsDir();
    const logPath = path.join(scriptsDir, "invocations.log");
    writeRecordingStub(scriptsDir, "generate-design-system-component-index.mjs", logPath);
    writeRecordingStub(scriptsDir, "design-system-hoc-budget.mjs", logPath);
    writeRecordingStub(scriptsDir, "design-system-raw-ui-budget.mjs", logPath);
    writeRecordingStub(scriptsDir, "check-responsive-safety.mjs", logPath);

    const result = await runDsRegen({ scriptsDir });

    expect(result).toEqual({ code: 0, failedStep: null });
    expect(readLog(logPath)).toEqual([
      { script: "generate-design-system-component-index.mjs", argv: [] },
      { script: "design-system-hoc-budget.mjs", argv: ["--write"] },
      { script: "design-system-raw-ui-budget.mjs", argv: ["--write"] },
      { script: "check-responsive-safety.mjs", argv: ["--write"] },
    ]);
  });

  it("fails fast and relays the exact exit code, naming the failing child, without running later steps", async () => {
    const scriptsDir = stubScriptsDir();
    const logPath = path.join(scriptsDir, "invocations.log");
    writeRecordingStub(scriptsDir, "generate-design-system-component-index.mjs", logPath);
    writeRecordingStub(scriptsDir, "design-system-hoc-budget.mjs", logPath, { exitCode: 7 });
    writeRecordingStub(scriptsDir, "design-system-raw-ui-budget.mjs", logPath);
    writeRecordingStub(scriptsDir, "check-responsive-safety.mjs", logPath);

    const result = await runDsRegen({ scriptsDir });

    expect(result.code).toBe(7);
    expect(result.failedStep).toMatchObject({
      name: "design-system-hoc-budget",
      script: "design-system-hoc-budget.mjs",
    });
    expect(readLog(logPath)).toEqual([
      { script: "generate-design-system-component-index.mjs", argv: [] },
      { script: "design-system-hoc-budget.mjs", argv: ["--write"] },
    ]);
  });

  it("routes design-system:regen through ds-regen.mjs from the ops CLI", async () => {
    const { SUBCOMMANDS } = await import("./ops.mjs");
    expect(SUBCOMMANDS["design-system:regen"]).toMatchObject({ script: "ds-regen.mjs" });
    expect(SUBCOMMANDS["design-system:regen"].description.trim().length).toBeGreaterThan(0);
  });
});
