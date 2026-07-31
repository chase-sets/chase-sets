import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const runFile = fileURLToPath(new URL("./run.mts", import.meta.url));

async function invoke(args) {
  try {
    const result = await execute(process.execPath, [runFile, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("closed public CLI", () => {
  it("documents exactly parity and validate", async () => {
    const result = await invoke(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("run.mts parity --base-root");
    expect(result.stdout).toContain("run.mts validate --artifact");
  });

  it.each([
    ["unknown command", ["capture"]],
    ["unknown option", ["validate", "--unknown", "x"]],
    ["duplicate option", ["validate", "--artifact", "a", "--artifact", "b"]],
    [
      "malformed head",
      [
        "validate",
        "--artifact",
        "a",
        "--expect-base-head",
        "no",
        "--expect-candidate-head",
        "0".repeat(40),
        "--expect-harness-head",
        "0".repeat(40),
      ],
    ],
  ])("fails closed for %s", async (_name, args) => {
    const result = await invoke(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("E_USAGE");
  });
});
