import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptBatteryTempCensusGlobalSetupPath, setupScriptBatteryTempCensus } from "./script-battery-temp-census.mjs";
import { heavySlotScriptBatteryGlobalSetupPath } from "./heavy-slot-script-battery.mjs";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "script-battery-census-controls-"));
const controls = {};
const temporaryDirectories = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
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
  const tsxFixturePath = path.join(fixtureRoot, "tsx-fixture.ts");
  const tsxTestPath = path.join(fixtureRoot, "tsx.test.mjs");
  await writeFile(
    tsxFixturePath,
    'enum Fixture {\n  Transformed = "transformed",\n}\nconsole.log(Fixture.Transformed);\n',
  );
  await writeFile(
    tsxTestPath,
    `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(tsxFixturePath)}], {
  env: process.env,
  encoding: "utf8",
});
test("transforms one TypeScript module through tsx", () => {
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== "transformed") {
    throw new Error(result.stderr || "tsx child printed " + result.stdout);
  }
});`,
  );
  const tsxEnv = { ...process.env };
  delete tsxEnv.TSX_DISABLE_CACHE;
  controls.tsx = spawnSync(process.execPath, [cli, "run", "--config", configPath, tsxTestPath], {
    env: tsxEnv,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

function censusEnvironment() {
  return ["TEMP", "TMP", "TMPDIR", "NODE_COMPILE_CACHE", "TSX_DISABLE_CACHE"].map((key) => process.env[key]);
}

async function runCompileCacheControl() {
  const controlRoot = await mkdtemp(path.join(os.tmpdir(), "script-battery-compile-cache-control-"));
  temporaryDirectories.push(controlRoot);
  const configPath = path.join(controlRoot, "vitest.config.mjs");
  const fixturePath = path.join(controlRoot, "compile-cache-fixture.cjs");
  const testPath = path.join(controlRoot, "compile-cache.test.mjs");
  await writeFile(fixturePath, "module.exports = { loaded: true };\n");
  const childCode = `require("node:module").enableCompileCache(); require(${JSON.stringify(fixturePath)});`;
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      root: controlRoot,
      test: {
        globals: true,
        globalSetup: [heavySlotScriptBatteryGlobalSetupPath, scriptBatteryTempCensusGlobalSetupPath],
      },
    })};`,
  );
  await writeFile(
    testPath,
    `import { spawnSync } from "node:child_process";
test("loads one module through Node's compile cache", () => {
  const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(childCode)}], {
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "compile-cache child exited with " + result.status);
});`,
  );
  const env = { ...process.env, TEMP: controlRoot, TMP: controlRoot, TMPDIR: controlRoot };
  delete env.NODE_COMPILE_CACHE;
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
  return {
    controlRoot,
    result: spawnSync(process.execPath, [cli, "run", "--config", configPath, testPath], {
      env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }),
  };
}

describe("script battery temporary census", () => {
  it("uses one fresh private directory for every temporary environment", async () => {
    const previous = censusEnvironment();
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    try {
      expect(privateDirectory).toBeTruthy();
      expect(process.env.TMP).toBe(privateDirectory);
      expect(process.env.TMPDIR).toBe(privateDirectory);
      expect(os.tmpdir()).toBe(privateDirectory);
      expect(process.env.NODE_COMPILE_CACHE).toBe(
        previous[3] ?? path.join(path.dirname(privateDirectory), "node-compile-cache"),
      );
      expect(process.env.TSX_DISABLE_CACHE).toBe("1");
      expect(await readdir(privateDirectory)).toEqual([]);
      const cleanedDirectory = await mkdtemp(path.join(os.tmpdir(), "inert-clean-"));
      await rm(cleanedDirectory, { recursive: true, force: true });
    } finally {
      await teardown();
    }
    expect(censusEnvironment()).toEqual(previous);
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

  it("keeps tsx's transform cache out of the private temp directory", () => {
    expect(controls.tsx.error).toBeUndefined();
    expect(controls.tsx.status, `${controls.tsx.stdout}\n${controls.tsx.stderr}`).toBe(0);
    expect(controls.tsx.stdout).toContain("1 passed");
    expect(controls.tsx.stderr).not.toContain("script battery temporary census found surviving entries");
  });

  it("names every surviving entry and restores the environment after failure", async () => {
    const previous = censusEnvironment();
    const teardown = await setupScriptBatteryTempCensus();
    const privateDirectory = process.env.TEMP;
    const leakedDirectory = await mkdtemp(path.join(privateDirectory, "inert-leak-"));
    await writeFile(path.join(privateDirectory, "inert-leak.txt"), "inert fixture");
    await expect(teardown()).rejects.toThrow(
      `script battery temporary census found surviving entries: ${[path.basename(leakedDirectory), "inert-leak.txt"].sort().join(", ")}`,
    );
    expect(censusEnvironment()).toEqual(previous);
    await expect(access(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Node's module compile cache out of the private temp directory", async () => {
    const { controlRoot, result } = await runCompileCacheControl();
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("script battery temporary census found surviving entries");
    await expect(access(path.join(controlRoot, "node-compile-cache"))).resolves.toBeUndefined();
    const entries = await readdir(controlRoot);
    expect(entries.filter((entry) => entry.startsWith("chase-sets-script-battery-"))).toEqual([]);
  });
});
