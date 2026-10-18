import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyDependencyAudit,
  normalizeAuditAdvisories,
  renderDependencyAuditMarkdown,
  runReleaseHealthDependencyAudit,
} from "./release-health-dependency-audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "release-health-dependency-audit");
const checkedAt = "2026-10-17T12:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(root, name), "utf8"));
}

describe("release health dependency audit", () => {
  it("classifies a production high advisory as failure", async () => {
    const result = classifyDependencyAudit({ exitCode: 1, stdout: JSON.stringify(await fixture("high-production.json")), checkedAt });
    expect(result).toMatchObject({ result: "failure", alertStatus: "failure", summary: { alertingAdvisoryCount: 1 } });
    expect(result.advisories[0].findings[0].dev).toBe(false);
  });

  it("keeps moderate production and high dev-only advisories non-alerting", async () => {
    const result = classifyDependencyAudit({ exitCode: 1, stdout: JSON.stringify(await fixture("dev-only-high.json")), checkedAt });
    expect(result).toMatchObject({ result: "success", alertStatus: "success", summary: { alertingAdvisoryCount: 0 } });
  });

  it.each([
    ["registry error", { exitCode: 1, stdout: "", stderr: "" }, "registry-error"],
    ["malformed JSON", { exitCode: 1, stdout: "{not-json", stderr: "" }, "malformed-json"],
  ])("classifies %s as warning", (_name, input, errorClass) => {
    const result = classifyDependencyAudit({ ...input, checkedAt });
    expect(result).toMatchObject({ result: "warning", alertStatus: "warning", error: { class: errorClass } });
  });

  it("renders alerting advisories in severity then module order with required fields", async () => {
    const result = classifyDependencyAudit({ exitCode: 1, stdout: JSON.stringify(await fixture("high-production.json")), checkedAt });
    const markdown = renderDependencyAuditMarkdown(result);
    expect(markdown).toContain("| Module | Installed versions | GHSA ID | Severity | Patched range | Production finding |");
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
      expect(JSON.parse(await readFile(path.join(outputDirectory, "dependency-audit.json"), "utf8")).result).toBe("failure");
      expect(await readFile(path.join(outputDirectory, "dependency-audit.md"), "utf8")).toContain(
        "GHSA-35jh-r3h4-6jhm",
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects malformed advisory findings", () => {
    expect(() => normalizeAuditAdvisories({ advisories: { x: { findings: "bad" } } })).toThrow(/findings/);
  });
});
