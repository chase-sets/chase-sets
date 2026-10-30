import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyDependencyAudit,
  normalizeAuditAdvisories,
  parseReleaseHealthDependencyAuditArgs,
  renderDependencyAuditMarkdown,
  runReleaseHealthDependencyAudit,
  runPnpmAudit,
} from "./release-health-dependency-audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "release-health-dependency-audit");
const checkedAt = "2026-10-17T12:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(root, name), "utf8"));
}

describe("release health dependency audit", () => {
  it("classifies a production high advisory as failure", async () => {
    const result = classifyDependencyAudit({
      exitCode: 1,
      stdout: JSON.stringify(await fixture("high-production.json")),
      checkedAt,
    });
    expect(result).toMatchObject({ result: "failure", alertStatus: "failure", summary: { alertingAdvisoryCount: 1 } });
    expect(result.advisories[0].findings[0].dev).toBe(false);
  });

  it("keeps moderate production and high dev-only advisories non-alerting", async () => {
    const result = classifyDependencyAudit({
      exitCode: 1,
      stdout: JSON.stringify(await fixture("dev-only-high.json")),
      checkedAt,
    });
    expect(result).toMatchObject({ result: "success", alertStatus: "success", summary: { alertingAdvisoryCount: 0 } });
  });

  it.each([
    ["registry error", { exitCode: 1, stdout: "", stderr: "" }, "registry-error"],
    ["malformed JSON", { exitCode: 1, stdout: "{not-json", stderr: "" }, "malformed-json"],
  ])("classifies %s as warning", (_name, input, errorClass) => {
    const result = classifyDependencyAudit({ ...input, checkedAt });
    expect(result).toMatchObject({ result: "warning", alertStatus: "warning", error: { class: errorClass } });
  });

  it("rejects an advisories array as an invalid audit shape", () => {
    const result = classifyDependencyAudit({
      exitCode: 1,
      stdout: '{"advisories":[]}',
      checkedAt,
    });
    expect(result).toMatchObject({ result: "warning", alertStatus: "warning", error: { class: "invalid-shape" } });
  });

  it("does not fall back to alternate advisory field names", () => {
    const result = classifyDependencyAudit({
      exitCode: 1,
      stdout: JSON.stringify({
        advisories: {
          lodash: {
            module: "lodash",
            ghsa: "GHSA-alternate",
            patchedRange: ">=4.17.21",
            severity: "moderate",
            findings: [{ version: "4.17.15", dev: false }],
          },
        },
      }),
      checkedAt,
    });
    expect(result).toMatchObject({ result: "warning", alertStatus: "warning", error: { class: "invalid-shape" } });
  });

  it("renders alerting advisories in severity then module order with required fields", async () => {
    const result = classifyDependencyAudit({
      exitCode: 1,
      stdout: JSON.stringify(await fixture("high-production.json")),
      checkedAt,
    });
    const markdown = renderDependencyAuditMarkdown(result);
    expect(markdown).toContain(
      "| Module | Installed versions | GHSA ID | Severity | Patched range | Production finding |",
    );
    expect(markdown).toContain("| lodash | 4.17.15 | GHSA-35jh-r3h4-6jhm | high | >=4.17.21 | yes |");
  });

  it("writes JSON and Markdown outputs and invokes the audit exactly once", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "dependency-audit-test-"));
    let calls = 0;
    try {
      const result = await runReleaseHealthDependencyAudit({
        checkedAt,
        outPath: path.join(outputDirectory, "dependency-audit.json"),
        markdownOutPath: path.join(outputDirectory, "dependency-audit.md"),
        runAudit: async () => {
          calls += 1;
          return { exitCode: 1, stdout: JSON.stringify(await fixture("high-production.json")), stderr: "" };
        },
      });
      expect(calls).toBe(1);
      expect(result.record.result).toBe("failure");
      expect(JSON.parse(await readFile(path.join(outputDirectory, "dependency-audit.json"), "utf8")).result).toBe(
        "failure",
      );
      expect(await readFile(path.join(outputDirectory, "dependency-audit.md"), "utf8")).toContain(
        "GHSA-35jh-r3h4-6jhm",
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("parses audit output paths and checked-at from command arguments", () => {
    expect(
      parseReleaseHealthDependencyAuditArgs([
        "--out",
        "audit.json",
        "--markdown-out",
        "audit.md",
        "--github-output",
        "github-output.txt",
        "--checked-at",
        checkedAt,
      ]),
    ).toMatchObject({
      outPath: "audit.json",
      markdownOutPath: "audit.md",
      githubOutputPath: "github-output.txt",
      checkedAt,
    });
  });

  it("spawns the supplied package-manager invocation and maps its result", () => {
    const calls = [];
    const result = runPnpmAudit({
      invocation: { command: "node", args: ["pnpm.cjs", "audit", "--json"] },
      spawnImpl: (...args) => {
        calls.push(args);
        return { status: 1, stdout: '{"advisories":{}}', stderr: "" };
      },
    });
    expect(calls[0][0]).toBe("node");
    expect(calls[0][1]).toEqual(["pnpm.cjs", "audit", "--json"]);
    expect(result).toMatchObject({ exitCode: 1, stdout: '{"advisories":{}}', stderr: "", error: null });
  });

  it("reports command errors and writes a warning alert status", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "dependency-audit-command-error-"));
    try {
      const result = await runReleaseHealthDependencyAudit({
        checkedAt,
        githubOutputPath: path.join(outputDirectory, "github-output.txt"),
        runAudit: async () => ({ exitCode: null, stdout: "", stderr: "", error: new Error("spawn failed") }),
      });
      expect(result.record).toMatchObject({
        result: "warning",
        alertStatus: "warning",
        error: { class: "command-error" },
      });
      expect(await readFile(path.join(outputDirectory, "github-output.txt"), "utf8")).toBe("alert_status=warning\n");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("writes the failure alert status for alerting advisories", async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), "dependency-audit-github-output-"));
    try {
      await runReleaseHealthDependencyAudit({
        checkedAt,
        githubOutputPath: path.join(outputDirectory, "github-output.txt"),
        runAudit: async () => ({
          exitCode: 1,
          stdout: JSON.stringify(await fixture("high-production.json")),
          stderr: "",
        }),
      });
      expect(await readFile(path.join(outputDirectory, "github-output.txt"), "utf8")).toBe("alert_status=failure\n");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects malformed advisory findings", () => {
    expect(() => normalizeAuditAdvisories({ advisories: { x: { findings: "bad" } } })).toThrow(/findings/);
  });
});
