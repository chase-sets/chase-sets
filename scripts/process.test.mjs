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
