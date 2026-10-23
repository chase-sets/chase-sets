import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scriptBatteryTempCensusGlobalSetupPath, setupScriptBatteryTempCensus } from "./script-battery-temp-census.mjs";
import { heavySlotScriptBatteryGlobalSetupPath } from "./heavy-slot-script-battery.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "script-battery-census-controls-"));
const controls = {};
try {
  const configPath = path.join(fixtureRoot, "vitest.config.mjs");
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      root: fixtureRoot,
      test: {
        globals: true,
        globalSetup: [heavySlotScriptBatteryGlobalSetupPath, scriptBatteryTempCensusGlobalSetupPath],
      },
    })};`,
  );
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
  for (const [name, cleanup] of [
    ["leak", false],
    ["clean", true],
  ]) {
    const fixturePath = path.join(fixtureRoot, `${name}.test.mjs`);
    await writeFile(
      fixturePath,
      `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("inert ${name} fixture", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "inert-leak-"));
  ${cleanup ? "rmSync(directory, { recursive: true, force: true });" : ""}
});`,
    );
    controls[name] = spawnSync(process.execPath, [cli, "run", "--config", configPath, fixturePath], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

describe("script battery temporary census", () => {
  it("uses one fresh private directory for every temporary environment", async () => {
    const previous = [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    try {
      expect(privateDirectory).toBeTruthy();
      expect(process.env.TMP).toBe(privateDirectory);
      expect(process.env.TMPDIR).toBe(privateDirectory);
      expect(os.tmpdir()).toBe(privateDirectory);
      expect(await readdir(privateDirectory)).toEqual([]);
      const cleanedDirectory = await mkdtemp(path.join(os.tmpdir(), "inert-clean-"));
      await rm(cleanedDirectory, { recursive: true, force: true });
    } finally {
      await teardown();
    }
    expect([process.env.TEMP, process.env.TMP, process.env.TMPDIR]).toEqual(previous);
    await expect(access(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails the script battery when a test leaves a temporary entry", async () => {
    expect(controls.leak.error).toBeUndefined();
    expect(controls.leak.status).toBe(1);
    expect(controls.leak.stdout).toContain("1 passed");
    expect(controls.leak.stderr).toContain("script battery temporary census found surviving entries: inert-leak-");
    expect(controls.clean.error).toBeUndefined();
    expect(controls.clean.status).toBe(0);
    expect(controls.clean.stdout).toContain("1 passed");
    expect(controls.clean.stderr).not.toContain("surviving entries");
  });

  it("names every surviving entry and restores the environment after failure", async () => {
    const previous = [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    const leakedDirectory = await mkdtemp(path.join(privateDirectory, "inert-leak-"));
    await writeFile(path.join(privateDirectory, "inert-leak.txt"), "inert fixture");
    await expect(teardown()).rejects.toThrow(
      `script battery temporary census found surviving entries: ${[path.basename(leakedDirectory), "inert-leak.txt"].sort().join(", ")}`,
    );
    expect([process.env.TEMP, process.env.TMP, process.env.TMPDIR]).toEqual(previous);
    await expect(access(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
