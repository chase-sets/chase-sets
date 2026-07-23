import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMinimalProcessEnvironment,
  buildPackageManagerInvocation,
  runCommand,
  terminateProcessTree,
} from "./lib/process.mjs";

describe("process helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("terminates the complete Windows child tree through taskkill", () => {
    const calls = [];
    const child = { pid: 6034, exitCode: null, signalCode: null, kill: vi.fn() };

    expect(
      terminateProcessTree(child, "SIGTERM", {
        platform: "win32",
        spawnSyncImpl: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([
      {
        command: "taskkill.exe",
        args: ["/PID", "6034", "/T", "/F"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails a hung child with a clear timeout error", async () => {
    await expect(
      runCommand(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"], {
        timeoutMs: 50,
        timeoutKillGraceMs: 10,
      }),
    ).rejects.toThrow("timed out after 50ms");
  });

  it("starts an isolated sentinel child without ambient database selectors or Space credentials", async () => {
    vi.stubEnv("PGHOST", "localhost");
    vi.stubEnv("PGHOSTADDR", "203.0.113.41");
    vi.stubEnv("PGDATABASE", "hostile");
    vi.stubEnv("PGSERVICE", "hostile-service");
    vi.stubEnv("DATABASE_URL", "postgresql://remote.example/hostile");
    vi.stubEnv("POSTGRES_DEV_DATABASE_URL", "postgresql://remote.example/hostile");
    vi.stubEnv("RELEASE_EVIDENCE_SPACES_ACCESS_ID", "release-access");
    vi.stubEnv("RELEASE_EVIDENCE_SPACES_SECRET_KEY", "release-secret");
    vi.stubEnv("SEED_PACKS_SPACES_ACCESS_ID", "snapshot-access");
    vi.stubEnv("SEED_PACKS_SPACES_SECRET_KEY", "snapshot-secret");

    const env = buildMinimalProcessEnvironment(process.env, {
      DATABASE_URL: "postgresql://localhost:6543/canonical",
    });
    const sentinel = [
      "const forbidden = Object.keys(process.env).filter((name) =>",
      "  (name.startsWith('PG') || name.startsWith('POSTGRES_') || name.includes('SPACES_')) &&",
      "  name !== 'DATABASE_URL');",
      "if (forbidden.length > 0 || process.env.DATABASE_URL !== 'postgresql://localhost:6543/canonical')",
      "  process.exit(41);",
    ].join("\n");

    await expect(
      runCommand(process.execPath, ["--input-type=module", "--eval", sentinel], {
        env,
        inheritEnv: false,
      }),
    ).resolves.toBeUndefined();
    expect(env).not.toHaveProperty("PGHOSTADDR");
    expect(env).not.toHaveProperty("RELEASE_EVIDENCE_SPACES_SECRET_KEY");
    expect(env).not.toHaveProperty("SEED_PACKS_SPACES_SECRET_KEY");
  });
});
