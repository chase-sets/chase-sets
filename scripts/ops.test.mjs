import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SUBCOMMANDS, parseOpsArgs, renderHelp } from "./ops.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const opsPath = join(scriptsDir, "ops.mjs");

function runOps(args) {
  return spawnSync(process.execPath, [opsPath, ...args], { encoding: "utf8" });
}

describe("ops CLI subcommand table", () => {
  it("maps every subcommand to an existing script file", () => {
    for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
      expect(entry.script, `${name} must declare a script`).toBeTruthy();
      expect(existsSync(join(scriptsDir, entry.script)), `${name} -> ${entry.script} must exist`).toBe(true);
    }
  });

  it("gives every subcommand a description", () => {
    for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
      expect(typeof entry.description, `${name} must declare a description`).toBe("string");
      expect(entry.description.trim().length, `${name} description must not be empty`).toBeGreaterThan(0);
    }
  });

  it("lists every subcommand in help output", () => {
    const help = renderHelp();
    for (const name of Object.keys(SUBCOMMANDS)) {
      expect(help).toContain(name);
    }
  });
});

describe("ops CLI argument parsing", () => {
  it("passes arguments after the subcommand through unchanged", () => {
    expect(parseOpsArgs(["canary:evidence", "--out", "report.json"])).toEqual({
      subcommand: "canary:evidence",
      args: ["--out", "report.json"],
    });
  });

  it("tolerates npm-style -- separators around the subcommand", () => {
    expect(parseOpsArgs(["--", "wake:drills", "--", "reconciliation"])).toEqual({
      subcommand: "wake:drills",
      args: ["reconciliation"],
    });
  });
});

describe("ops CLI process behavior", () => {
  it("help exits 0 and lists all subcommands", () => {
    const result = runOps(["help"]);
    expect(result.status).toBe(0);
    for (const name of Object.keys(SUBCOMMANDS)) {
      expect(result.stdout).toContain(name);
    }
  });

  it("an unknown subcommand exits nonzero and names the offender", () => {
    const result = runOps(["not-a-real-subcommand"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown ops subcommand: not-a-real-subcommand");
  });

  it("no subcommand exits nonzero and prints usage", () => {
    const result = runOps([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: node ./scripts/ops.mjs");
  });
});
