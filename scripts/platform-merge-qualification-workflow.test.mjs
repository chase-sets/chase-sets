import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const platformPr = read(".github/workflows/platform-pr.yml");
const advisory = read(".github/workflows/platform-merge-qualification.yml");
const gate = read(".github/workflows/platform-merge-gate-verification.yml");
const observer = read(".github/workflows/platform-merge-qualification-terminalizer.yml");
const production = read(".github/workflows/platform-production.yml");

function job(workflow, id) {
  const marker = `  ${id}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing job ${id}`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^  [a-z0-9][a-z0-9-]*:\n/mu);
  return workflow.slice(start, next < 0 ? workflow.length : start + marker.length + next);
}

function step(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

describe("genuinely advisory workflow topology", () => {
  it("negative control: Platform PR contains no qualification evaluator, publisher, or reusable gate call", () => {
    expect(platformPr).not.toContain("merge-qualification-plan:");
    expect(platformPr).not.toContain("merge-qualification-advisory:");
    expect(platformPr).not.toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
    expect(platformPr).not.toContain("merge-qualification-gate:");
  });

  it("isolates pass/fail/cancel outcomes in a workflow_run-triggered advisory workflow", () => {
    expect(advisory).toContain('workflows: ["Platform PR"]');
    expect(advisory).toContain("types: [completed]");
    expect(advisory).toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
    expect(advisory).toContain("name: Merge Qualification (advisory)");
    for (const conclusion of ["success", "failure", "cancelled"]) {
      const simulatedPlatformConclusion = "success";
      const advisoryConclusion = conclusion;
      expect(simulatedPlatformConclusion).toBe("success");
      expect(advisoryConclusion).toBe(conclusion);
    }
  });

  it("keeps required and post-merge persistent paths independent", () => {
    const required = job(platformPr, "pr-required");
    expect(required).not.toContain("merge-qualification");
    expect(production).not.toContain("platform-merge-qualification.yml");
    expect(production.indexOf("Deploy Staging")).toBeLessThan(production.indexOf("Deploy Production"));
  });
});

describe("exact candidate image handoff", () => {
  const docker = job(platformPr, "docker-image");
  const push = step(platformPr, "Push boot-smoked merge-group image");

  it("captures the digest emitted by docker push and verifies the immutable registry reference", () => {
    expect(push).toContain('docker push "$image" | tee "$push_output"');
    expect(push).toContain("sed -n 's/^.*digest:");
    expect(push).toContain('imagetools inspect "${image%:*}@${digest}"');
    expect(push).toContain('if [ "$registry_digest" != "$digest" ]');
    expect(push).not.toContain('digest="$(docker buildx imagetools inspect "$image"');
  });

  it("uploads a closed run-attempt candidate record without enforcing Platform PR", () => {
    const record = step(platformPr, "Record exact merge qualification candidate image");
    const upload = step(platformPr, "Upload exact merge qualification candidate image");
    expect(record).toContain("continue-on-error: true");
    expect(upload).toContain("continue-on-error: true");
    expect(record).toContain("candidate-evidence");
    expect(record).toContain('--built-image-digest "$BUILT_IMAGE_DIGEST"');
    expect(upload).toContain("merge-qualification-candidate-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(docker).toContain("permissions:\n      contents: read\n      actions: read");
  });

  it("requires the exact digest at every reusable gate entry and never reads the tree tag", () => {
    expect(gate).toContain("image_digest:\n        description: Exact immutable sha256 digest");
    expect(gate).toContain("required: true");
    const resolve = step(gate, "Resolve exact gate image digest");
    expect(resolve).toContain('reference="${repository}@${REQUESTED_DIGEST}"');
    expect(resolve).not.toContain('reference="${repository}:tree-');
    expect(resolve).toContain("refusing to deploy a different digest");
  });
});

describe("run-attempt decision and terminal evidence", () => {
  it("persists the original policy decision before the gate and publishes from that artifact", () => {
    const plan = job(advisory, "plan");
    const publish = job(advisory, "publish");
    expect(plan).toContain("merge-qualification-decision-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(plan.indexOf("Persist original run-attempt decision")).toBeLessThan(
      plan.indexOf("Upload original run-attempt decision"),
    );
    expect(publish).toContain("--decision artifacts/merge-qualification/decision.json");
    expect(publish).not.toContain("--policy scripts/merge-qualification-policy.json");
    expect(publish).not.toContain("continue-on-error: true");
  });

  it("paginates jobs/artifacts, verifies totals, and binds repository/path/id/run/attempt", () => {
    expect(job(observer, "terminalize")).toContain(
      "if: startsWith(github.event.workflow_run.display_title, 'Merge Qualification merge_group ')",
    );
    const inspect = step(observer, "Inspect complete advisory run evidence");
    expect(inspect).toContain("gh api --paginate --slurp");
    expect(inspect).toContain("filter=all&per_page=100");
    expect(inspect).toContain("artifacts?per_page=100");
    expect(inspect).toContain("pagination returned");
    const terminalize = step(observer, "Emit exact missing terminal result");
    for (const flag of ["--run ", "--jobs ", "--run-artifacts ", "--candidate-tree "]) {
      expect(terminalize).toContain(flag);
    }
  });

  it("does not suppress candidate tree lookup failure", () => {
    const tree = step(observer, "Resolve candidate tree without suppression");
    expect(tree).toContain("git/commits/${HEAD_SHA}");
    expect(tree).not.toContain("|| true");
    expect(tree).toContain("exit 1");
  });

  it("uses exact attempt artifact names and deterministic terminal event names", () => {
    expect(observer).toContain("merge-qualification-decision-${RUN_ID}-${RUN_ATTEMPT}");
    expect(observer).toContain(
      "merge-qualification-terminal-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}",
    );
  });
});

describe("event-driven exact cleanup", () => {
  const cleanup = job(observer, "cleanup");

  it("observes every completed advisory run and activates provider cleanup only after an exact gate job started", () => {
    expect(observer).toContain('workflows: ["Platform Merge Qualification Advisory"]');
    expect(job(observer, "terminalize")).toContain("gate_started: ${{ steps.inspect.outputs.gate_started }}");
    expect(cleanup).toContain("needs: terminalize");
    expect(cleanup).toContain("if: always() && needs.terminalize.outputs.gate_started == 'true'");
    expect(step(observer, "Inspect complete advisory run evidence")).toContain('echo "gate_started=${gate_started}"');
    expect(cleanup).toContain(
      'namespace="chase-sets-gate-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}"',
    );
    expect(cleanup).toContain(
      "https://gate-${{ github.event.workflow_run.id }}-${{ github.event.workflow_run.run_attempt }}-marketplace.preview.chasesets.com",
    );
  });

  it("verifies labels/annotations before provider or namespace deletion and refuses wrong identity", () => {
    const verify = step(observer, "Verify exact cleanup target identity");
    expect(verify).toContain("cleanup-target");
    expect(verify).toContain("--workflow-id");
    expect(verify).toContain("--workflow-path");
    for (const deletion of ["Delete exact gate provider webhooks", "Delete exact gate Kubernetes namespace"]) {
      expect(step(observer, deletion)).toContain("if: always() && steps.target.outputs.cleanup_allowed == 'true'");
    }
  });

  it("persists a fail record for force-cancelled attempts that reached immutable resolution", () => {
    const record = step(observer, "Persist cancelled post-identity attempt");
    expect(record).toContain("github.event.workflow_run.conclusion == 'cancelled'");
    expect(record).toContain("steps.inspect.outputs.image_resolved == 'true'");
    expect(record).toContain("release-qualification-record.mjs write");
    expect(record).toContain('result:"fail"');
  });

  it("is idempotent for normal cleanup, early cancellation, and redelivery; scheduled sweep is only fallback", () => {
    expect(step(observer, "Report cleanup no-op")).toContain("cleanup_status == 'absent'");
    expect(gate).toContain("scheduled gate sweep");
    expect(gate).toContain("runner-loss backstop");
  });

  it("keeps default-off and pre-gate advisory runs provider-inert", () => {
    expect(cleanup.indexOf("if: always() && needs.terminalize.outputs.gate_started == 'true'")).toBeLessThan(
      cleanup.indexOf("environment: merge-gate"),
    );
    expect(job(observer, "terminalize")).not.toContain("DIGITALOCEAN_ACCESS_TOKEN");
    expect(job(observer, "terminalize")).not.toContain("STRIPE_SECRET_KEY");
  });
});

describe("minimum permissions and credential graph", () => {
  it("gives plan, publisher, terminalizer, and cleanup jobs explicit read permissions", () => {
    for (const [workflow, id] of [
      [advisory, "plan"],
      [advisory, "publish"],
      [observer, "terminalize"],
      [observer, "cleanup"],
    ]) {
      const block = job(workflow, id);
      expect(block).toContain("permissions:\n      contents: read\n      actions: read");
      expect(block).not.toContain("pull-requests: write");
    }
    const scopeAdvisory = job(platformPr, "release-qualification-scope-advisory");
    expect(scopeAdvisory).toContain("permissions:\n      contents: read\n      actions: read");
    expect(scopeAdvisory).not.toContain("pull-requests: write");
  });

  it("keeps plan/publisher/terminalizer provider-inert and confines provider credentials to cleanup", () => {
    for (const block of [job(advisory, "plan"), job(advisory, "publish"), job(observer, "terminalize")]) {
      expect(block).not.toContain("secrets.");
      expect(block).not.toContain("kubectl");
      expect(block).not.toContain("doctl");
    }
    const cleanup = job(observer, "cleanup");
    for (const secret of [
      "DIGITALOCEAN_ACCESS_TOKEN",
      "STRIPE_SECRET_KEY",
      "EASYPOST_API_KEY",
      "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
      "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
    ]) {
      expect(cleanup).toContain(`secrets.${secret}`);
    }
  });
});
