import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";

describe("process helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs pnpm native executables directly on Windows", () => {
    const pnpmExe = "C:\\Users\\ToddS\\AppData\\Local\\pnpm\\pnpm.exe";
    const invocation = buildPackageManagerInvocation(["--version"], {
      env: { npm_execpath: pnpmExe },
      exists: (candidate) => candidate === pnpmExe,
      platform: "win32",
    });

    expect(invocation).toEqual({
      command: pnpmExe,
      args: ["--version"],
    });
  });

  it("skips Windows command shims when resolving pnpm child invocations", () => {
    const pnpmCmd = "C:\\Users\\ToddS\\.cache\\codex-runtimes\\dependencies\\bin\\pnpm.cmd";
    const appData = "C:\\Users\\ToddS\\AppData\\Roaming";
    const pnpmCli = path.join(appData, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs");
    const invocation = buildPackageManagerInvocation(["run", "verify:typecheck"], {
      env: { npm_execpath: pnpmCmd, APPDATA: appData },
      exists: (candidate) => candidate === pnpmCmd || candidate === pnpmCli,
      platform: "win32",
    });

    expect(invocation).toEqual({
      command: process.execPath,
      args: [pnpmCli, "run", "verify:typecheck"],
    });
  });

  it("runs pnpm JavaScript CLIs through node", () => {
    const pnpmCli = path.join("node_modules", "pnpm", "bin", "pnpm.cjs");
    const invocation = buildPackageManagerInvocation(["install"], {
      env: { npm_execpath: pnpmCli },
      exists: (candidate) => candidate === pnpmCli,
      platform: "linux",
    });

    expect(invocation).toEqual({
      command: process.execPath,
      args: [pnpmCli, "install"],
    });
  });

  it("runs pnpm ESM CLIs through node", () => {
    const pnpmCli = path.join("node_modules", "pnpm", "bin", "pnpm.mjs");
    const invocation = buildPackageManagerInvocation(["run", "verify:typecheck"], {
      env: { npm_execpath: pnpmCli },
      exists: (candidate) => candidate === pnpmCli,
      platform: "win32",
    });

    expect(invocation).toEqual({
      command: process.execPath,
      args: [pnpmCli, "run", "verify:typecheck"],
    });
  });

  it("waits for prefixed child output to flush before rejecting", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runCommand(
        process.execPath,
        ["--input-type=module", "--eval", "process.stdout.write('buffered failure'); process.exit(1);"],
        { prefix: "child" },
      ),
    ).rejects.toThrow("exited with code 1");

    expect(consoleLog).toHaveBeenCalledWith("[child] buffered failure");
  });
});
