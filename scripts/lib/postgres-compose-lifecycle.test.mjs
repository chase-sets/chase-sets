import { describe, expect, it } from "vitest";
import { stopComposePostgresCleanly } from "./postgres-compose-lifecycle.mjs";

const invocation = {
  command: "docker",
  args: ["compose", "--env-file", ".env.sandbox.local", "-f", "docker-compose.dev.yml", "-p", "chase-sets-fixture"],
};

function createForcedShutdownFixture() {
  const observations = [];
  const calls = [];
  const state = {
    checkpointed: false,
    containerExitCode: null,
    pgControl: "in production",
    postmasterPid: "ready",
  };

  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.some((argument) => argument.includes("CHECKPOINT"))) {
      state.checkpointed = true;
      return;
    }
    if (args.at(-1) !== "down") {
      throw new Error(`Unexpected fixture command: ${command} ${args.join(" ")}`);
    }
    if (!state.checkpointed) {
      state.containerExitCode = 137;
      state.pgControl = "shutting down";
      state.postmasterPid = "stopping";
      throw new Error("fixture: Compose sent SIGKILL after 10 seconds while PostgreSQL was checkpointing");
    }
    state.containerExitCode = 0;
    state.pgControl = "shut down";
    state.postmasterPid = "absent";
  };

  return {
    calls,
    observations,
    run,
    state,
  };
}

describe("sandbox PostgreSQL Compose lifecycle", () => {
  it("reproduces the predecessor teardown poisoning a retained PostgreSQL volume", async () => {
    const fixture = createForcedShutdownFixture();

    await expect(fixture.run(invocation.command, [...invocation.args, "down"])).rejects.toThrow(
      "Compose sent SIGKILL after 10 seconds while PostgreSQL was checkpointing",
    );

    expect(fixture.state).toEqual({
      checkpointed: false,
      containerExitCode: 137,
      pgControl: "shutting down",
      postmasterPid: "stopping",
    });
  });

  it("checkpoints through the sandbox Compose identity before stopping PostgreSQL", async () => {
    const fixture = createForcedShutdownFixture();

    const result = await stopComposePostgresCleanly({
      invocation,
      env: { CHASE_SETS_SANDBOX_ID: "fixture" },
      run: fixture.run,
      observe: (observation) => fixture.observations.push(observation),
    });

    expect(result).toEqual({ checkpointed: true });
    expect(fixture.state).toEqual({
      checkpointed: true,
      containerExitCode: 0,
      pgControl: "shut down",
      postmasterPid: "absent",
    });
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[0]).toMatchObject({
      command: "docker",
      args: [
        ...invocation.args,
        "exec",
        "-T",
        "postgres",
        "sh",
        "-ceu",
        'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command CHECKPOINT',
      ],
      options: {
        env: { CHASE_SETS_SANDBOX_ID: "fixture" },
        prefix: "postgres",
      },
    });
    expect(fixture.calls[1]).toMatchObject({
      command: "docker",
      args: [...invocation.args, "down"],
      options: {
        env: { CHASE_SETS_SANDBOX_ID: "fixture" },
        prefix: "docker",
      },
    });
    expect(fixture.calls.every(({ options }) => options.timeoutMs === undefined)).toBe(true);
    expect(fixture.observations).toEqual([
      "Flushing the sandbox PostgreSQL shutdown checkpoint...",
      "Sandbox PostgreSQL shutdown checkpoint completed.",
    ]);
  });

  it("keeps teardown idempotent when PostgreSQL is already unavailable", async () => {
    const calls = [];
    const observations = [];

    const result = await stopComposePostgresCleanly({
      invocation,
      env: {},
      run: async (_command, args) => {
        calls.push(args);
        if (args.some((argument) => argument.includes("CHECKPOINT"))) {
          throw new Error("service postgres is not running");
        }
      },
      observe: (observation) => observations.push(observation),
    });

    expect(result).toEqual({ checkpointed: false });
    expect(calls).toEqual([
      [
        ...invocation.args,
        "exec",
        "-T",
        "postgres",
        "sh",
        "-ceu",
        'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command CHECKPOINT',
      ],
      [...invocation.args, "down"],
    ]);
    expect(observations.at(-1)).toContain("PostgreSQL was unavailable for a shutdown checkpoint");
  });
});
