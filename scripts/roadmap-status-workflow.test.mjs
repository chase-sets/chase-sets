import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(repoRoot, ".github", "workflows");

function workflowSources() {
  return readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => ({
      path: `.github/workflows/${entry.name}`,
      source: readFileSync(path.join(workflowDirectory, entry.name), "utf8"),
    }));
}

function executableRunSteps(sources) {
  const steps = [];
  for (const source of sources) {
    const workflow = parseYaml(source.source);
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        if (typeof step?.run !== "string") continue;
        steps.push({
          workflowPath: source.path,
          jobId,
          stepIndex,
          stepName: step.name ?? null,
          run: step.run.trim(),
        });
      }
    }
  }
  return steps;
}

function invokesRoadmapStatus(run) {
  return /(?:^|[\s;&|])node\s+\.\/scripts\/roadmap-status\.mjs(?:\s|$)/m.test(run);
}

function directModuleImporters() {
  return readdirSync(path.join(repoRoot, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .filter((entry) => {
      const source = readFileSync(path.join(repoRoot, "scripts", entry.name), "utf8");
      return /\bfrom\s+["']\.\/roadmap-status\.mjs["']/.test(source);
    })
    .map((entry) => `scripts/${entry.name}`)
    .sort();
}

describe("roadmap status production caller inventory", () => {
  it("derives the only production caller and preserves the enforcing workflow contract", () => {
    const sources = workflowSources();
    const runSteps = executableRunSteps(sources);
    const callers = runSteps.filter(({ run }) => invokesRoadmapStatus(run));
    expect(callers).toEqual([
      {
        workflowPath: ".github/workflows/backlog-roadmap-status.yml",
        jobId: "status",
        stepIndex: 2,
        stepName: "Generate roadmap status",
        run: "node ./scripts/roadmap-status.mjs",
      },
    ]);

    const pathVocabularyNegativeControl = executableRunSteps([
      {
        path: ".github/workflows/arbitrary-unrelated-name-8472.yaml",
        source: `name: Synthetic shape control
on: workflow_dispatch
jobs:
  arbitrary:
    runs-on: ubuntu-latest
    steps:
      - name: Invoke by executable shape
        run: node ./scripts/roadmap-status.mjs
`,
      },
    ]).filter(({ run }) => invokesRoadmapStatus(run));
    expect(pathVocabularyNegativeControl).toEqual([
      expect.objectContaining({
        workflowPath: ".github/workflows/arbitrary-unrelated-name-8472.yaml",
        jobId: "arbitrary",
        stepName: "Invoke by executable shape",
      }),
    ]);

    const roadmapRunReferences = runSteps.filter(({ run }) => run.includes("roadmap-status"));
    expect(roadmapRunReferences).toEqual(callers);
    expect(directModuleImporters()).toEqual(["scripts/roadmap-status.test.mjs"]);

    const workflowText = readFileSync(path.join(workflowDirectory, "backlog-roadmap-status.yml"), "utf8");
    const workflow = parseYaml(workflowText);
    const job = workflow.jobs.status;
    const checkout = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    const generate = job.steps.find((step) => step.name === "Generate roadmap status");

    expect(workflow.on.schedule).toEqual([{ cron: "0 13 * * *" }]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    expect(job["continue-on-error"]).toBeUndefined();
    expect(checkout.with?.ref).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.roadmap_issue.default).toBe("4129");
    expect(generate.env.ROADMAP_ISSUE).toBe("${{ inputs.roadmap_issue || '4129' }}");
    expect(generate.run.trim()).toBe("node ./scripts/roadmap-status.mjs");
    expect(generate["continue-on-error"]).toBeUndefined();
    expect(generate.run).not.toMatch(/(?:^|\n)\s*exit\s+0\s*$/m);
    expect(workflowText).toContain("Fail-safe: if the target issue has no roadmap-status markers");
    expect(workflowText).toContain("left untouched and the run reports a failure instead of guessing.");
    expect(releaseQualificationScopeRegistry.workflows["backlog-roadmap-status.yml"]).toBe("ci");
  });
});
