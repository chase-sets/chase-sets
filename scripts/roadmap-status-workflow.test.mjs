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

function invokesRoadmapWriter(run) {
  return run.trim() === "node ./scripts/roadmap-status.mjs";
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
  it("derives the scheduled writer by executable shape and preserves the pinned mutation contract", () => {
    const sources = workflowSources();
    const runSteps = executableRunSteps(sources);
    const callers = runSteps.filter(({ run }) => invokesRoadmapWriter(run));
    expect(callers).toEqual([
      {
        workflowPath: ".github/workflows/backlog-roadmap-status.yml",
        jobId: "write-roadmap-status",
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
    ]).filter(({ run }) => invokesRoadmapWriter(run));
    expect(pathVocabularyNegativeControl).toEqual([
      expect.objectContaining({
        workflowPath: ".github/workflows/arbitrary-unrelated-name-8472.yaml",
        jobId: "arbitrary",
        stepName: "Invoke by executable shape",
      }),
    ]);

    expect(directModuleImporters()).toEqual([
      "scripts/roadmap-authority-probe.mjs",
      "scripts/roadmap-authority-probe.test.mjs",
      "scripts/roadmap-status.test.mjs",
    ]);

    const workflowText = readFileSync(path.join(workflowDirectory, "backlog-roadmap-status.yml"), "utf8");
    const workflow = parseYaml(workflowText);
    const job = workflow.jobs["write-roadmap-status"];
    const checkout = job.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    const generate = job.steps.find((step) => step.name === "Generate roadmap status");

    expect(workflow.on.schedule).toEqual([{ cron: "0 13 * * *" }]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.if).toBe("github.event_name == 'schedule'");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", issues: "write" });
    expect(job["continue-on-error"]).toBeUndefined();
    expect(checkout.with?.ref).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      authority_nonce: {
        description: "Lowercase 32-hex nonce binding this exact authority probe.",
        required: true,
        type: "string",
      },
    });
    expect(generate.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", ROADMAP_ISSUE: "4129" });
    expect(generate.run.trim()).toBe("node ./scripts/roadmap-status.mjs");
    expect(generate["continue-on-error"]).toBeUndefined();
    expect(generate.run).not.toMatch(/(?:^|\n)\s*exit\s+0\s*$/m);
    expect(workflowText).toContain("invalid or incomplete roadmap/cap authority leaves #4129");
    expect(workflowText).toContain("byte-identical and reports a failure instead of guessing.");
    expect(releaseQualificationScopeRegistry.workflows["backlog-roadmap-status.yml"]).toBe("ci");
  });

  it("keeps the manual probe event-exclusive, least-authority, token-threaded, and canonical", () => {
    const workflowPath = path.join(workflowDirectory, "backlog-roadmap-status.yml");
    const source = readFileSync(workflowPath, "utf8");
    const workflow = parseYaml(source);
    const writer = workflow.jobs["write-roadmap-status"];
    const probe = workflow.jobs["probe-authority"];
    const resolveJob = probe.steps.find((step) => step.name === "Resolve exact probe-authority job");
    const produce = probe.steps.find((step) => step.name === "Produce refined inventory authority probe");
    const validate = probe.steps.find((step) => step.name === "Validate refined inventory authority probe");
    const upload = probe.steps.find((step) => step.name === "Upload refined inventory authority probe");

    expect(writer.if).toBe("github.event_name == 'schedule'");
    expect(probe.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(probe.name).toBe("probe-authority");
    expect(probe.permissions).toEqual({ actions: "read", contents: "read", "pull-requests": "read" });
    expect(probe.permissions.issues).toBeUndefined();
    expect(resolveJob.env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(produce.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      ROADMAP_WORKFLOW: "backlog-roadmap-status.yml",
      ROADMAP_AUTHORITY_NONCE: "${{ inputs.authority_nonce }}",
      ROADMAP_PROBE_JOB_ID: "${{ steps.probe-job.outputs.job_id }}",
    });
    expect(produce.run).toBe(
      "node ./scripts/roadmap-status.mjs --probe-authority --out artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json",
    );
    expect(validate.run).toBe(
      "node ./scripts/roadmap-status.mjs --validate-probe-authority --input artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json",
    );
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toEqual({
      name: "roadmap-refined-inventory-authority-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "artifacts/roadmap-refined-inventory-authority/roadmap-refined-inventory-authority-probe.json",
      "if-no-files-found": "error",
    });
    expect(probe.steps.indexOf(produce)).toBeLessThan(probe.steps.indexOf(validate));
    expect(probe.steps.indexOf(validate)).toBeLessThan(probe.steps.indexOf(upload));
    expect(source).not.toContain("roadmap_issue:");
    expect(workflow["run-name"]).toContain("inputs.authority_nonce");
  });
});
