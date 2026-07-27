import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const sandbox = {
    composeProjectName: "chase-sets-fixture",
    envFilePath: ".env.sandbox.fixture",
  };
  const sandboxEnv = {
    CHASE_SETS_SANDBOX_ID: "fixture",
    COMPOSE_PROJECT_NAME: sandbox.composeProjectName,
  };

  return {
    sandbox,
    sandboxEnv,
    spawnSync: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  spawnSync: fixture.spawnSync,
}));

vi.mock("./lib/sandbox.mjs", () => ({
  applySandboxEnv: vi.fn(),
  buildDockerComposeArgs: (sandbox, subcommand = []) => [
    "compose",
    "--env-file",
    sandbox.envFilePath,
    "-f",
    "docker-compose.dev.yml",
    "-p",
    sandbox.composeProjectName,
    ...subcommand,
  ],
  buildSandboxEnv: vi.fn(() => fixture.sandboxEnv),
  ensureWorktreeSandboxEnvironment: vi.fn(() => ({
    sandbox: fixture.sandbox,
    env: fixture.sandboxEnv,
  })),
  resolveWorktreeSandbox: vi.fn(),
}));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

async function runSandboxCommand(command) {
  process.argv = [process.execPath, "scripts/sandbox.mjs", command];
  vi.resetModules();
  await import("./sandbox.mjs");
}

function dockerCalls() {
  return fixture.spawnSync.mock.calls.map(([command, args, options]) => ({ command, args, options }));
}

beforeEach(() => {
  fixture.spawnSync.mockReset();
  fixture.spawnSync.mockReturnValue({
    error: undefined,
    status: 0,
    stdout: "",
  });
  process.exitCode = originalExitCode;
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("sandbox Compose teardown commands", () => {
  it("orders CHECKPOINT before the retained-volume sandbox down", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runSandboxCommand("down");

    const calls = dockerCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        fixture.sandbox.envFilePath,
        "-f",
        "docker-compose.dev.yml",
        "-p",
        fixture.sandbox.composeProjectName,
        "exec",
        "-T",
        "postgres",
        "sh",
        "-ceu",
        'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command CHECKPOINT',
      ],
    });
    expect(calls[1]).toMatchObject({
      command: "docker",
      args: [
        "compose",
        "--env-file",
        fixture.sandbox.envFilePath,
        "-f",
        "docker-compose.dev.yml",
        "-p",
        fixture.sandbox.composeProjectName,
        "down",
      ],
    });
    expect(calls.every(({ args }) => args[0] === "compose")).toBe(true);
    expect(calls.every(({ options }) => options.env.CHASE_SETS_SANDBOX_ID === "fixture")).toBe(true);
    expect(calls.every(({ options }) => options.timeout === undefined && options.timeoutMs === undefined)).toBe(true);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "Flushing the sandbox PostgreSQL shutdown checkpoint...",
      "Sandbox PostgreSQL shutdown checkpoint completed.",
    ]);
  });

  it("keeps sandbox clean as one destructive down -v without a checkpoint", async () => {
    await runSandboxCommand("clean");

    expect(dockerCalls()).toEqual([
      expect.objectContaining({
        command: "docker",
        args: [
          "compose",
          "--env-file",
          fixture.sandbox.envFilePath,
          "-f",
          "docker-compose.dev.yml",
          "-p",
          fixture.sandbox.composeProjectName,
          "down",
          "-v",
        ],
      }),
    ]);
    expect(dockerCalls()[0].args.some((argument) => argument.includes("CHECKPOINT"))).toBe(false);
  });

  it("degrades a failed checkpoint to down without adding a timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fixture.spawnSync.mockImplementation((_command, args) => ({
      error: undefined,
      status: args.some((argument) => argument.includes("CHECKPOINT")) ? 1 : 0,
      stdout: "",
    }));

    await runSandboxCommand("down");

    const calls = dockerCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args.some((argument) => argument.includes("CHECKPOINT"))).toBe(true);
    expect(calls[1].args.at(-1)).toBe("down");
    expect(calls.every(({ options }) => options.timeout === undefined && options.timeoutMs === undefined)).toBe(true);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "Flushing the sandbox PostgreSQL shutdown checkpoint...",
      expect.stringContaining(
        "Sandbox PostgreSQL was unavailable for a shutdown checkpoint; continuing with Compose teardown:",
      ),
    ]);
    expect(process.exitCode).toBe(originalExitCode);
  });
});
