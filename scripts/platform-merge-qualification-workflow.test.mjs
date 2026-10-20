import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const platformPr = read(".github/workflows/platform-pr.yml");
const advisory = read(".github/workflows/platform-merge-qualification.yml");
const gate = read(".github/workflows/platform-merge-gate-verification.yml");
const observer = read(".github/workflows/platform-merge-qualification-observer.yml");
const production = read(".github/workflows/platform-production.yml");
const previewCleanup = read(".github/workflows/platform-preview-cleanup.yml");

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
    expect(platformPr).not.toContain("merge-qualification:");
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

  it("marks both new staging and production release records with explicit lineage eligibility", () => {
    // The producer is deliberately not wired into release conclusions. The
    // existing staging/production ordering remains the authority for release.
    expect(production).toContain("Deploy Staging");
    expect(production).toContain("Deploy Production");
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
    expect(record).toContain('--queue-base-sha "${{ github.event.merge_group.base_sha }}"');
    expect(record).toContain('gh api "repos/${{ github.repository }}/actions/runs/${{ github.run_id }}"');
    // Pull-request identity must come from the merge-queue entry association,
    // the only authority GitHub exposes while the candidate is still queued.
    expect(record).toContain("gh api graphql");
    expect(record).toContain("mergeQueue(branch: $branch)");
    expect(record).toContain("entries(first: 100)");
    expect(record).toContain("totalCount");
    expect(record).toContain("headCommit { oid }");
    expect(record).toContain("baseCommit { oid }");
    expect(record).toContain("pullRequest { number headRefOid }");
    expect(record).toContain('--run-metadata "$run_metadata"');
    expect(record).toContain('--merge-queue-snapshot "$merge_queue_snapshot"');
    // Post-merge-only association sources can never appear at the producer.
    expect(record).not.toContain("/pulls?");
    expect(record).not.toContain("commits/${candidate_sha}");
    expect(record).not.toContain("--associated-pull-pages");
    expect(record).not.toContain(".pull_requests");
    expect(record).not.toContain("head_branch");
    expect(record).toContain('--built-image-digest "$BUILT_IMAGE_DIGEST"');
    expect(upload).toContain("merge-qualification-candidate-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload).toContain("path: artifacts/merge-qualification-candidate/candidate.json");
    expect(step(platformPr, "Upload candidate capture diagnostics")).toContain(
      "artifacts/merge-qualification-candidate/diagnostics/",
    );
    expect(docker).toContain("permissions:\n      contents: read\n      actions: write\n      pull-requests: read");
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

describe("continuation acceptance boundaries", () => {
  it("AC2 gates producer discovery, publication, diagnostics and dispatch on trusted policy", () => {
    const producer = job(platformPr, "docker-image");
    const policy = step(platformPr, "Evaluate trusted merge qualification policy");
    expect(policy).toContain(".qualification-authority/scripts/merge-qualification.mjs policy");
    expect(policy).toContain("--policy .qualification-authority/scripts/merge-qualification-policy.json");
    expect(producer).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(producer.indexOf("Evaluate trusted merge qualification policy")).toBeLessThan(
      producer.indexOf("Record exact merge qualification candidate image"),
    );
    for (const name of [
      "Record exact merge qualification candidate image",
      "Upload exact merge qualification candidate image",
      "Upload candidate capture diagnostics",
      "Dispatch merge qualification producer",
    ]) {
      expect(step(platformPr, name)).toContain("steps.qualification_policy.outputs.enabled == 'true'");
    }
    expect(step(platformPr, "Record exact merge qualification candidate image")).toContain(
      "node ./.qualification-authority/scripts/merge-qualification.mjs candidate-evidence",
    );
    expect(step(platformPr, "Upload exact merge qualification candidate image")).toContain(
      "steps.candidate_record.outcome == 'success'",
    );
  });

  it("AC2 evaluates child policy before candidate discovery and writes no disabled decision", () => {
    const plan = job(advisory, "plan");
    expect(plan.indexOf("Evaluate original run-attempt policy decision")).toBeLessThan(
      plan.indexOf("Inspect exact parent run and candidate artifact"),
    );
    for (const name of [
      "Inspect exact parent run and candidate artifact",
      "Persist original run-attempt decision",
      "Upload original run-attempt decision",
    ]) {
      expect(step(advisory, name)).toContain("steps.policy.outputs.enabled == 'true'");
    }
  });

  it("AC3 confines the advisory caller and executable checkout to default-ref authority", () => {
    expect(job(advisory, "plan")).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(job(gate, "preflight")).toContain(
      "github.workflow_ref == format('{0}/.github/workflows/platform-merge-qualification.yml@refs/heads/{1}', github.repository, github.event.repository.default_branch)",
    );
    expect(job(gate, "verify")).toContain("inputs.qualification_parent_run_id != '' && github.workflow_sha");
  });

  it("AC4 uses recovered inspection decision even when the child decision upload was lost", () => {
    const inspect = step(observer, "Inspect complete cancelled-run identity");
    expect(inspect).toContain("cp artifacts/merge-qualification-cleanup/inspection/run.json");
    expect(step(observer, "Download exact cleanup ownership")).toContain(
      "merge-qualification-inspection-${{ matrix.run_id }}-${{ matrix.run_attempt }}",
    );
    expect(inspect).not.toContain('gh run download "$RUN_ID" --name "$decision_name"');
    expect(step(observer, "Persist cancelled post-identity attempt")).toContain(
      'decision="artifacts/merge-qualification-cleanup/inspection/decision/decision.json"',
    );
  });

  it("AC5 contains dispatch failure without changing the required parent graph", () => {
    const dispatch = step(platformPr, "Dispatch merge qualification producer");
    expect(dispatch).toContain("continue-on-error: true");
    expect(dispatch).toContain("GH_TOKEN: ${{ github.token }}");
    expect(dispatch).toContain('--ref "${{ github.event.repository.default_branch }}"');
    expect(dispatch).toContain("steps.candidate_record.outcome == 'success'");
    expect(job(platformPr, "pr-required")).not.toContain("qualification");
  });
});

describe("run-attempt decision and terminal evidence", () => {
  it("AC1 checks durable cross-delivery terminal payloads only after cleanup", () => {
    const terminal = job(observer, "terminalize");
    expect(terminal).toContain("needs: [reconcile, inspect, cleanup]");
    expect(terminal.indexOf("Read durable observer terminals after cleanup")).toBeLessThan(
      terminal.indexOf("Emit exact missing terminal result"),
    );
    expect(step(observer, "Read durable observer terminals after cleanup")).toContain("terminal-inventory");
    expect(step(observer, "Emit exact missing terminal result")).toContain(
      "--terminal-records artifacts/merge-qualification/terminal-records.json",
    );
    expect(step(observer, "Upload deterministic terminal event")).toContain(
      "steps.terminalize.outputs.event_written == 'true'",
    );
  });
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
    expect(job(observer, "inspect")).toContain("needs.reconcile.outputs.pending == 'true'");
    const inspect = step(observer, "Inspect complete advisory run evidence");
    expect(inspect).toContain("merge-qualification.mjs run-collection");
    expect(inspect).toContain('--run-attempt "$RUN_ATTEMPT"');
    expect(inspect).toContain("--collection artifacts");
    expect(inspect).toContain("pagination returned");
    const terminalize = step(observer, "Emit exact missing terminal result");
    for (const flag of ["--run ", "--parent-run ", "--jobs ", "--run-artifacts "]) {
      expect(terminalize).toContain(flag);
    }
    expect(terminalize).not.toContain("--candidate-tree");
  });

  it("never treats workflow_run.head_sha as the upstream candidate identity", () => {
    const inspect = step(observer, "Inspect complete advisory run evidence");
    expect(inspect).toContain("parent-run.json");
    expect(inspect).toContain("merge-gate-provisioning-${RUN_ID}-${RUN_ATTEMPT}");
    expect(inspect).toContain("recover-decision");
    expect(inspect).not.toContain('--candidate-sha "$revision"');
    expect(observer).not.toContain("git/commits/${HEAD_SHA}");
  });

  it("uses exact attempt artifact names and deterministic terminal event names", () => {
    expect(observer).toContain("merge-qualification-decision-${RUN_ID}-${RUN_ATTEMPT}");
    expect(observer).toContain("merge-qualification-terminal-${{ matrix.run_id }}-${{ matrix.run_attempt }}");
  });
});

describe("event-driven exact cleanup", () => {
  const cleanup = job(observer, "cleanup");

  it("observes every completed advisory run and activates cleanup only from a durable provisioning observation", () => {
    expect(observer).toContain('workflows: ["Platform PR", "Platform Merge Qualification Advisory"]');
    expect(job(observer, "inspect")).toContain("id: prepare");
    expect(cleanup).toContain("needs: [reconcile, inspect]");
    expect(cleanup).toContain("steps.ownership.outputs.provisioned == 'true'");
    expect(step(observer, "Recover exact cleanup ownership before terminalization")).toContain(
      "--cleanup-ownership-out",
    );
    expect(job(observer, "terminalize")).toContain("needs: [reconcile, inspect, cleanup]");
    expect(job(observer, "terminalize")).toContain(
      "needs.cleanup.result == 'success' || needs.cleanup.result == 'skipped'",
    );
    expect(job(observer, "inspect")).not.toContain("merge-qualification-terminal-");
    expect(advisory).not.toContain("merge-qualification-events-");
    expect(advisory).toContain("merge-qualification-observation-");
    expect(step(observer, "Upload exact cleanup ownership")).toContain(
      "merge-qualification-cleanup-ownership-${{ matrix.run_id }}-${{ matrix.run_attempt }}",
    );
    expect(step(observer, "Download exact cleanup ownership")).toContain("merge-qualification-inspection-");
    expect(cleanup).not.toContain("gate_started");
    expect(cleanup).toContain('namespace="chase-sets-gate-${{ matrix.run_id }}-${{ matrix.run_attempt }}"');
    expect(cleanup).toContain(
      "https://gate-${{ matrix.run_id }}-${{ matrix.run_attempt }}-marketplace.preview.chasesets.com",
    );
  });

  it("verifies labels/annotations before provider or namespace deletion and refuses wrong identity", () => {
    const verify = step(observer, "Verify exact cleanup target identity");
    expect(verify).toContain("cleanup-target");
    expect(verify).toContain("--workflow-id");
    expect(verify).toContain("--workflow-path");
    expect(step(observer, "Delete exact gate provider webhooks")).toContain(
      "if: always() && steps.target.outputs.provider_cleanup_allowed == 'true'",
    );
    expect(step(observer, "Delete exact gate Kubernetes namespace")).toContain(
      "if: always() && steps.target.outputs.namespace_cleanup_allowed == 'true'",
    );
  });

  it("persists a fail record for force-cancelled attempts that reached immutable resolution", () => {
    const record = step(observer, "Persist cancelled post-identity attempt");
    expect(record).toContain("matrix.conclusion == 'cancelled'");
    expect(record).toContain("steps.target.outputs.provider_cleanup_allowed == 'true'");
    expect(record).toContain("cleanup-ownership.json");
    expect(record).toContain("release-qualification-record.mjs write");
    expect(record).toContain("merge-qualification.mjs cancelled-record");
  });

  it("is idempotent for normal cleanup, early cancellation, and redelivery; scheduled sweep is only fallback", () => {
    expect(step(observer, "Report cleanup no-op")).toContain("cleanup_status == 'absent'");
    expect(gate).toContain("scheduled gate sweep");
    expect(gate).toContain("runner loss");
    expect(observer).toContain("provider-webhook-lifecycle.mjs delete");
    expect(previewCleanup).toContain("schedule:");
    expect(previewCleanup).toContain("provider-webhook-lifecycle.mjs delete");
  });

  it("keeps default-off and pre-gate advisory runs provider-inert", () => {
    expect(cleanup.indexOf("if: always() && needs.inspect.result == 'success'")).toBeGreaterThan(-1);
    expect(cleanup.indexOf("if: always() && needs.inspect.result == 'success'")).toBeLessThan(
      cleanup.indexOf("environment: merge-gate"),
    );
    expect(job(observer, "terminalize")).not.toContain("DIGITALOCEAN_ACCESS_TOKEN");
    expect(job(observer, "terminalize")).not.toContain("STRIPE_SECRET_KEY");
    for (const name of [
      "Validate observer cleanup credentials",
      "Configure observer Kubernetes context",
      "Verify exact cleanup target identity",
    ]) {
      expect(step(observer, name)).toContain("steps.ownership.outputs.provisioned == 'true'");
    }
  });

  it("AC1 schedules the same recovery graph within a 15-minute worker budget", () => {
    expect(observer).toContain('cron: "*/15 * * * *"');
    expect(job(observer, "reconcile")).not.toContain("if: github.event_name");
    expect(step(observer, "Inventory original enabled advisory attempts")).toContain(
      "merge-qualification.mjs inventory",
    );
    let minutes = 0;
    for (const id of ["reconcile", "inspect", "cleanup", "terminalize"]) {
      minutes += Number(job(observer, id).match(/timeout-minutes: (\d+)/)[1]);
      if (id !== "reconcile") expect(job(observer, id)).toContain("fromJSON(needs.reconcile.outputs.matrix)");
    }
    expect(minutes).toBeLessThanOrEqual(15);
  });
});

describe("queue and managed-registry boundaries", () => {
  it("checks current exact-head disposition before any namespace creation", () => {
    const recheck = step(gate, "Recheck exact advisory queue disposition before provisioning");
    expect(recheck).toContain("merge-qualification.mjs queue-disposition");
    expect(recheck).toContain('--candidate-sha "$CANDIDATE_SHA" --candidate-tree "$CANDIDATE_TREE"');
    expect(recheck).toContain('--built-image-digest "$IMAGE_DIGEST"');
    expect(gate.indexOf("Recheck exact advisory queue disposition")).toBeLessThan(
      gate.indexOf("- name: Create gate namespace"),
    );
    expect(step(observer, "Emit exact missing terminal result")).toContain("--candidate-record");
  });
  it("retains managed registry readiness and never generates pull credentials", () => {
    expect(step(gate, "Wait for managed registry authority")).toContain("managed-registry-readiness.mjs");
    expect(step(gate, "Deploy gate Kubernetes release")).toContain("--image-pull-secret chase-sets");
    expect(gate).not.toContain("doctl registry docker-config");
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
