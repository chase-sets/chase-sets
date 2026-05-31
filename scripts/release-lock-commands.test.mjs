import { describe, expect, it } from "vitest";
import {
  RELEASE_LOCK_COMMANDS_VERSION,
  buildReleaseLockCommands,
  parseReleaseLockCommandsArgs,
} from "./release-lock-commands.mjs";

describe("release lock GitHub Environment commands", () => {
  it("builds lock commands with a reason and reference", () => {
    const result = buildReleaseLockCommands({
      action: "lock",
      environmentName: "production",
      reason: "Payment provider incident",
      reference: "INC-2026-05-31-001",
    });

    expect(result.schemaVersion).toBe(RELEASE_LOCK_COMMANDS_VERSION);
    expect(result.passesReleaseLockCommandsGate).toBe(true);
    expect(result.commands).toEqual([
      'gh variable set PRODUCTION_RELEASE_LOCKED --env "production" --body "true"',
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "production" --body "Payment provider incident"',
      'gh variable set PRODUCTION_RELEASE_LOCK_REFERENCE --env "production" --body "INC-2026-05-31-001"',
    ]);
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
    });

    expect(result.commands).toContain(
      'gh variable set PRODUCTION_RELEASE_LOCK_REASON --env "prod `"blue`"" --body "Incident `"checkout`""',
    );
    expect(result.commands).toContain(
      'gh variable set PRODUCTION_RELEASE_LOCK_REFERENCE --env "prod `"blue`"" --body "INC``1"',
    );
  });
});
