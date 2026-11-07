// Pure source/event/planner fixtures only. Never execute the diagnostic or provider tools.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { classifyChanges } from "./change-scope.mjs";
import { createCiGatePlan } from "./ci-gate-plan.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { checkWorkflowCanonicalArtifacts } from "./workflow-canonical-artifacts.mjs";
import { checkWorkflowProviderCredentials } from "./workflow-provider-credentials.mjs";
import {
  classifyReleaseQualificationScope,
  releaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";
const main = "d507b7dd58bad88c929e10133443eb62ac39a3bf";
const h1 = "cbd4068778b1fed220e6d43d2138d41b55839da6";
const h1Main = "bc7d68fc5ce488996a5651a1bf678bd581d7eda2";
const branch = "host/10678-ingress-nosend-diagnostic";
const diagnosticPath = ".github/workflows/ingress-nosend-diagnostic.yml";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true });
const paths = (value) => value.split(/\r?\n/).filter(Boolean);
const workspaces = listWorkspacePackages();
const scope = (changedFiles) => classifyChanges({ changedFiles, workspaces });
const plan = (changedFiles, extra = {}) =>
  createCiGatePlan({
    mode: "pull-request",
    labels: [],
    provenance: "same-repository",
    scope: scope(changedFiles),
    ...extra,
  });
const preview = (p) => p.gates.find((g) => g.id === "preview-deploy-smoke");
const source = readFileSync(diagnosticPath, "utf8");
const workflow = parse(source);
const job = workflow.jobs["ingress-nosend-diagnostic"];

describe("10678 D4 publication and unchanged shared contracts", () => {
  it("passes the named canonical-artifact and provider-credential source guards for the exact diagnostic", () => {
    expect(checkWorkflowCanonicalArtifacts(source, { workflowFile: diagnosticPath }).passed).toBe(true);
    expect(checkWorkflowProviderCredentials(source, { workflowFile: diagnosticPath })).toMatchObject({
      passed: true,
      checkedSteps: [],
      violations: [],
    });
  });
  it("retains the original actual H1 diff as the F1 REQUIRED-preview failing control", () => {
    const changed = paths(git("diff", "--name-only", h1Main, h1));
    expect(changed).toContain(".github/workflows/platform-pr.yml");
    expect(preview(plan(changed))).toMatchObject({ selection: "REQUIRED", reason: "scope" });
  });
  it("classifies the actual repaired diagnostic delta as workflow lint without cluster or credential gates", () => {
    const changed = [
      ...new Set([
        ...paths(git("diff", "--name-only", main)),
        ...paths(
          git(
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            diagnosticPath,
            "scripts/test-support/10678-ingress-nosend",
            "scripts/ingress-nosend-publication.test.mjs",
          ),
        ),
      ]),
    ];
    expect(changed).toContain(diagnosticPath);
    expect(changed).not.toContain(".github/workflows/platform-pr.yml");
    const s = scope(changed);
    expect(s.workflowLintRequired).toBe(true);
    expect(s.clusterPreviewRequired).toBe(false);
    expect(preview(plan(changed))).toMatchObject({ selection: "NOT_REQUIRED", reason: "not-affected" });
    for (const gate of plan(changed).gates.filter((g) =>
      /^(?:terraform-|docker-image|compose-preview-smoke)/.test(g.id),
    ))
      expect(gate.selection, gate.id).toBe("NOT_REQUIRED");
    // Hypothetical PR planning is a regression control, NOT publication authority. Actual publication has no PR.
  });
  it("preserves ordinary deployment, preview labels, fork, missing provenance and merge-group selection", () => {
    const deployment = ["infrastructure/helm/platform/templates/ingress.yaml"];
    expect(preview(plan(deployment))).toMatchObject({ selection: "REQUIRED", reason: "scope" });
    expect(preview(plan(["docs/README.md"], { labels: ["preview"] }))).toMatchObject({
      selection: "REQUIRED",
      reason: "preview-label",
    });
    expect(preview(plan(deployment, { provenance: "fork" }))).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "fork",
    });
    expect(preview(plan(deployment, { provenance: undefined }))).toMatchObject({
      selection: "UNDECIDABLE",
      reason: "missing-provenance",
    });
    expect(preview(plan(deployment, { mode: "merge-group" }))).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "merge-group",
    });
  });
  it("registers only the exact disposable workflow as ci and keeps unknown workflows fail-closed", () => {
    const before = git("show", `${main}:scripts/release-qualification-scope.mjs`);
    expect(readFileSync("scripts/release-qualification-scope.mjs", "utf8")).toBe(
      before.replace(
        '    "ci-image-mirrors.yml": "release",',
        '    "ci-image-mirrors.yml": "release",\n    "ingress-nosend-diagnostic.yml": "ci",',
      ),
    );
    expect(releaseQualificationScopeRegistry.workflows["ingress-nosend-diagnostic.yml"]).toBe("ci");
    const classify = (file) =>
      classifyReleaseQualificationScope({
        base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
        candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
        changedFiles: [{ path: file, status: "added" }],
        readFileAt: () => source,
        releaseWorkflowScriptReferences: new Set(),
        workspaces: [],
        now: () => 1,
      });
    expect(classify(diagnosticPath)).toMatchObject({ class: "not_applicable", reasonCodes: ["ci_only_workflow"] });
    expect(classify(".github/workflows/SYNTHETIC-unknown.yml")).toMatchObject({
      class: "persistent_required",
      reasonCodes: ["unregistered_workflow"],
    });
  });
  it("keeps every existing workflow and shared classifier/planner byte-identical to admitted main", () => {
    const ordinary = paths(git("ls-tree", "-r", "--name-only", main, "--", ".github/workflows"));
    for (const file of [...ordinary, "scripts/change-scope.mjs", "scripts/ci-gate-plan.mjs"])
      expect(readFileSync(file), file).toEqual(execFileSync("git", ["show", `${main}:${file}`], { windowsHide: true }));
    expect(
      parse(readFileSync(".github/workflows/platform-preview-cleanup.yml", "utf8")).on.pull_request_target.types,
    ).toContain("closed");
  });
  it("admits exactly one diagnostic push job and no existing push or completion listener", () => {
    expect(workflow.name).toBe("Ingress No-Send Diagnostic");
    expect(workflow.on).toEqual({ push: { branches: [branch] } });
    expect(Object.keys(workflow.jobs)).toEqual(["ingress-nosend-diagnostic"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ingress-nosend-diagnostic-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(job.if).toContain("github.event_name == 'push'");
    expect(job.if).toContain("github.repository == 'chase-sets/chase-sets'");
    expect(job.if).toContain(`github.ref == 'refs/heads/${branch}'`);
    expect(job.if).toContain("github.event.deleted == false");
    const names = readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name));
    let matched = 0;
    for (const name of names) {
      const w = parse(readFileSync(`.github/workflows/${name}`, "utf8"));
      if (name === "ingress-nosend-diagnostic.yml") {
        matched++;
        continue;
      }
      expect(w.name, name).not.toBe(workflow.name);
      if (w.on?.push) {
        expect(w.on.push.branches, name).toBeInstanceOf(Array);
        for (const pattern of w.on.push.branches) expect(["main", "pilot/corten"], name).toContain(pattern);
        expect(w.on.push.tags, name).toBeUndefined();
      }
      expect(w.on?.create, name).toBeUndefined();
      expect(w.on?.delete, name).toBeUndefined();
      if (w.on?.workflow_run) {
        expect(w.on.workflow_run.workflows, name).toBeInstanceOf(Array);
        for (const subscription of w.on.workflow_run.workflows) {
          const regex = new RegExp(`^${subscription.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
          expect(regex.test(workflow.name), name).toBe(false);
        }
      }
    }
    expect(matched).toBe(1);
  });
  it("preserves immutable actions, least authority, exclusive phases, ceilings and exact uploads", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(job.secrets).toBeUndefined();
    expect(source).not.toMatch(/secrets\.|id-token|pull_request|workflow_dispatch/);
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.uses).toBe("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false });
    const names = [
      "Prepare reviewed public prerequisites",
      "Prepare isolated diagnostic",
      "Measure fixed serial protocol",
    ];
    for (const name of names)
      expect(job.steps.find((s) => s.name === name).if).toBe("steps.authority.outputs.phase == 'measurement'");
    expect(job.steps.find((s) => s.name === "Measure fixed serial protocol")["timeout-minutes"]).toBe(10);
    const inventory = job.steps.find((s) => s.id === "inventory");
    expect(inventory.if).toBe("steps.authority.outputs.phase == 'inventory'");
    expect(inventory.run).not.toContain("runner.mjs");
    const eventConsumers = job.steps.filter((s) => s.run?.includes("GITHUB_EVENT_PATH="));
    expect(eventConsumers).toHaveLength(5);
    for (const step of eventConsumers) {
      expect(step.run).toContain('GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME"');
      expect(step.run).toContain('GITHUB_REF="$GITHUB_REF"');
      expect(step.run).not.toContain("GITHUB_EVENT_NAME=push");
    }
    const seal = job.steps.find((s) => s.id === "seal");
    expect(seal.if).toBe(
      "always() && steps.authority.outcome == 'success' && steps.authority.outputs.phase == 'measurement'",
    );
    for (const upload of job.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"))) {
      expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
      expect(upload.if).toContain("outcome == 'success'");
      expect(upload.with["if-no-files-found"]).toBe("error");
      expect(upload.with.path).toMatch(/\/(?:diagnostic|inventory)$/);
      expect(upload.with["include-hidden-files"]).toBeUndefined();
      expect(upload.with.overwrite).toBeUndefined();
    }
  });
});
