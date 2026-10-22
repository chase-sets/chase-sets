import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  RELEASE_LOCK_COMMANDS_VERSION,
  buildReleaseLockCommands,
  parseReleaseLockCommandsArgs,
} from "./release-lock-commands.mjs";

const exitRoute = JSON.stringify({
  kind: "host-revert",
  reference: "https://github.com/chase-sets/chase-sets/issues/10391",
});
const futureDeadline = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("release lock GitHub Environment commands", () => {
  it("CLI refuses invalid authority with no commands and prints five ordered commands for valid offline authority", () => {
    const run = (extra) =>
      spawnSync(
        process.execPath,
        ["scripts/release-lock-commands.mjs", "--action", "lock", "--reason", "hold", ...extra],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: "", PRODUCTION_RELEASE_LOCK_DEADLINE: "" },
        },
      );
    const invalid = run([]);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    const valid = run(["--exit-route", exitRoute, "--deadline", futureDeadline()]);
    expect(valid.status).toBe(0);
    expect(valid.stdout.trim().split(/\r?\n/)).toHaveLength(5);
    expect(valid.stdout.trim().split(/\r?\n/).at(-1)).toContain("PRODUCTION_RELEASE_LOCKED");
  });

  it("uses effective CLI overrides for every field rather than stale environment defaults", () => {
    expect(
      parseReleaseLockCommandsArgs(
        ["--reason", "new", "--reference", "new-ref", "--exit-route", exitRoute, "--deadline", "new-deadline"],
        {
          PRODUCTION_RELEASE_LOCK_REASON: "old",
          PRODUCTION_RELEASE_LOCK_REFERENCE: "old",
          PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: "old",
          PRODUCTION_RELEASE_LOCK_DEADLINE: "old",
        },
      ),
    ).toMatchObject({ reason: "new", reference: "new-ref", exitRoute, deadline: "new-deadline" });
  });
  it.each([
    {},
    { exitRoute },
    { exitRoute, deadline: "2026-10-22" },
    { exitRoute, deadline: "2026-10-22T12:00:00" },
    { exitRoute, deadline: "2000-01-01T00:00:00Z" },
    { exitRoute, deadline: "2099-01-01T00:00:00Z" },
    {
      exitRoute: JSON.stringify({
        kind: "host-revert",
        reference: "https://github.com/chase-sets/chase-sets/pull/10391",
      }),
      deadline: futureDeadline(),
    },
  ])("produces no executable commands for invalid creation input %j", (values) => {
    const result = buildReleaseLockCommands({ action: "lock", reason: "hold", ...values });
    expect(result.passesReleaseLockCommandsGate).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.commandCount).toBe(0);
  });
  it("builds lock commands with a reason and reference", () => {
    const result = buildReleaseLockCommands({
      action: "lock",
      environmentName: "production",
      reason: "Payment provider incident",
      reference: "INC-2026-05-31-001",
      exitRoute,
      deadline: futureDeadline(),
    });

    expect(result.schemaVersion).toBe(RELEASE_LOCK_COMMANDS_VERSION);
    expect(result.passesReleaseLockCommandsGate).toBe(true);
    expect(result.commandCount).toBe(5);
    expect(result.commands.slice(0, 2)).toEqual([
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "production" --body "Payment provider incident"',
      'gh variable set PRODUCTION_RELEASE_LOCK_REFERENCE --env "production" --body "INC-2026-05-31-001"',
    ]);
    expect(result.commands.at(-1)).toBe('gh variable set PRODUCTION_RELEASE_LOCKED --env "production" --body "true"');
  });

  it("builds unlock commands that clear lock metadata", () => {
    const result = buildReleaseLockCommands({
      action: "unlock",
      environmentName: "production",
      reason: "",
      reference: "",
    });

    expect(result.passesReleaseLockCommandsGate).toBe(true);
    expect(result.commands).toEqual([
      'gh variable set PRODUCTION_RELEASE_LOCKED --env "production" --body "false"',
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "production" --body ""',
      'gh variable set PRODUCTION_RELEASE_LOCK_REFERENCE --env "production" --body ""',
      'gh variable set PRODUCTION_RELEASE_LOCK_EXIT_ROUTE --env "production" --body ""',
      'gh variable set PRODUCTION_RELEASE_LOCK_DEADLINE --env "production" --body ""',
    ]);
  });

  it("requires a reason when locking releases", () => {
    const result = buildReleaseLockCommands({
      action: "lock",
      environmentName: "production",
      reason: "",
      reference: "INC-1",
    });

    expect(result.passesReleaseLockCommandsGate).toBe(false);
    expect(result.errors).toContain("PRODUCTION_RELEASE_LOCK_REASON is required when locking production releases.");
  });

  it("parses arguments from flags or environment", () => {
    expect(
      parseReleaseLockCommandsArgs(
        ["--action", "lock", "--environment", "production", "--reason", "Maintenance", "--reference", "MAINT-1"],
        {},
      ),
    ).toMatchObject({
      action: "lock",
      environmentName: "production",
      reason: "Maintenance",
      reference: "MAINT-1",
    });

    expect(
      parseReleaseLockCommandsArgs([], {
        RELEASE_LOCK_ACTION: "unlock",
        GITHUB_ENVIRONMENT_NAME: "production",
      }),
    ).toMatchObject({
      action: "unlock",
      environmentName: "production",
    });
  });

  it("escapes PowerShell command values", () => {
    const result = buildReleaseLockCommands({
      action: "lock",
      environmentName: 'prod "blue"',
      reason: 'Incident "checkout"',
      reference: "INC`1",
      exitRoute,
      deadline: futureDeadline(),
    });

    expect(result.commands).toContain(
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "prod `"blue`"" --body "Incident `"checkout`""',
    );
    expect(result.commands).toContain(
      'gh variable set PRODUCTION_RELEASE_LOCK_REFERENCE --env "prod `"blue`"" --body "INC``1"',
    );
  });

  it("escapes PowerShell variable expansion instead of generating executable interpolation", () => {
    expect(
      buildReleaseLockCommands({
        action: "lock",
        reason: "hold $(Write-Output unsafe) $env:NAME",
        exitRoute,
        deadline: futureDeadline(),
      }).commands[0],
    ).toContain("hold `$(Write-Output unsafe) `$env:NAME");
  });
});
