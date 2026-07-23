import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/platform-postgres-slow-query-digest.yml"), "utf8");

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

describe("platform postgres slow query digest workflow result contract", () => {
  it("maps success/warning/failure exit codes to a distinct result output, failing the step on a genuine failure", () => {
    const build = step("Build Postgres slow query digest");
    expect(build).toContain('if [ "$status" -eq 0 ]; then');
    expect(build).toContain('echo "result=success" >> "$GITHUB_OUTPUT"');
    expect(build).toContain('elif [ "$status" -eq 2 ]; then');
    expect(build).toContain('echo "result=warning" >> "$GITHUB_OUTPUT"');
    expect(build).toContain('echo "result=failure" >> "$GITHUB_OUTPUT"');
    expect(build).toContain('exit "$status"');
  });

  it("reports the coverage counts that distinguish zero-coverage failure from observed-zero success", () => {
    const summary = step("Summarize Postgres slow query digest");
    expect(summary).toContain("summary.attemptedDatabaseCount");
    expect(summary).toContain("summary.collectedDatabaseCount");
    expect(summary).toContain("summary.extensionAbsentDatabaseCount");
    expect(summary).toContain("summary.extensionInstalledDatabaseCount");
    expect(summary).toContain("summary.collectionErrorCount");
  });

  it("only reports the advisory warning branch on a genuine partial-collection warning, never on failure", () => {
    const warning = step("Report Postgres slow query warning");
    expect(warning).toContain("if: ${{ !failure() && steps.digest.outputs.result == 'warning' }}");
  });

  it("reports the failure branch whenever the job fails, including a zero-coverage exit", () => {
    const failure = step("Report Postgres slow query failure");
    expect(failure).toContain("if: ${{ failure() }}");
  });

  it("only reports recovery when the job succeeded with a genuine success result", () => {
    const recovery = step("Report Postgres slow query recovery");
    expect(recovery).toContain("if: ${{ success() && steps.digest.outputs.result == 'success' }}");
  });
});
