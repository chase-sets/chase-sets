import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";
import {
  MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX,
  MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT,
} from "./merge-qualification.mjs";

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

  it("starts one advisory attempt per producer attempt, only from the enabled producer dispatch", () => {
    const triggers = advisory.slice(advisory.indexOf("\non:\n"), advisory.indexOf("\npermissions:\n"));
    expect(triggers.match(/^ {2}[a-z_]+:/gmu)).toEqual(["  workflow_dispatch:"]);
    expect(advisory).not.toContain("workflow_run");
    expect(advisory).toContain(
      "run-name: Merge Qualification producer ${{ inputs.producer_run_id }}-${{ inputs.producer_run_attempt }}",
    );
    expect(advisory).toContain(
      "group: platform-merge-qualification-${{ inputs.producer_run_id }}-${{ inputs.producer_run_attempt }}",
    );
    expect(platformPr.match(/gh workflow run platform-merge-qualification\.yml/gu)).toHaveLength(1);
    expect(step(platformPr, "Dispatch merge qualification producer")).toContain(
      "steps.qualification_policy.outputs.enabled == 'true'",
    );
    expect(advisory).toContain("uses: ./.github/workflows/platform-merge-gate-verification.yml");
    expect(advisory).toContain("name: Merge Qualification (advisory)");
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

describe("producer-loss authority pins", () => {
  it("does not publish the unused advisory self head output", () => {
    expect(advisory).not.toContain('echo "head_sha=$(jq -r');
  });
  it("inspects only image-eligible producers and uses the advisory run head for recovery", () => {
    const inspect = step(observer, "Inspect joined producer candidate and policy");
    expect(step(observer, "Inventory completed producer attempts missing advisory dispatch")).toContain(
      "producer-inventory",
    );
    expect(inspect).toContain(
      'git merge-base --is-ancestor "$policy_revision" "origin/${{ github.event.repository.default_branch }}"',
    );
    expect(inspect).toContain('--policy-authority-error "${{ matrix.historicalPolicyReason }}"');
    const recovery = step(observer, "Inspect complete advisory run evidence");
    expect(recovery).toContain("revision=\"$(jq -r '.head_sha' artifacts/merge-qualification/run.json)\"");
    const decision = step(advisory, "Persist original run-attempt decision");
    expect(decision).toContain('--policy-revision "${{ github.workflow_sha }}"');
  });

  it("keeps producer terminal publication pinned to cleanup ordering", () => {
    const inspect = step(observer, "Inspect joined producer candidate and policy");
    expect(inspect).toContain("--advisory-run artifacts/merge-qualification-producer/advisory.json");
    expect(inspect).toContain("--advisory-cleanup-complete");
    expect(inspect).toContain("cleanup_arg=(--advisory-cleanup-complete true)");
    expect(inspect).toContain("conflict_settled");
    expect(step(observer, "Upload producer dispatch-loss terminal")).toContain(
      "if: steps.inspect.outputs.event_written == 'true'",
    );
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
    expect(policy).toContain("working-directory: .qualification-authority");
    expect(policy).toContain("node ./scripts/merge-qualification.mjs policy");
    expect(policy).toContain("--policy ./scripts/merge-qualification-policy.json");
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
      "working-directory: .qualification-authority",
    );
    expect(step(platformPr, "Upload exact merge qualification candidate image")).toContain(
      "steps.candidate_record.outcome == 'success'",
    );
  });

  it("AC2 binds the candidate to the workspace checkout and writes it where the upload reads", () => {
    const record = step(platformPr, "Record exact merge qualification candidate image");
    const upload = step(platformPr, "Upload exact merge qualification candidate image");
    const candidatePath = "artifacts/merge-qualification-candidate/candidate.json";
    expect(record).toContain("working-directory: .qualification-authority");
    // Every git read must see the merge-group workspace, never the trusted default-ref checkout.
    const gitReads = record.match(/\bgit\b[^\n]*/gu);
    expect(gitReads).toEqual([
      'git rev-parse HEAD)"',
      'git -C "$GITHUB_WORKSPACE" rev-parse HEAD)"',
      'git -C "$GITHUB_WORKSPACE" rev-parse \'HEAD^{tree}\')"',
    ]);
    expect(record).toContain('test "$candidate_sha" = "$(git -C "$GITHUB_WORKSPACE" rev-parse HEAD)"');
    expect(record).toContain(`test "$candidate_tree" = "$(git -C "$GITHUB_WORKSPACE" rev-parse 'HEAD^{tree}')"`);
    expect(record.match(/--out [^\n]*/gu)).toEqual([`--out "$GITHUB_WORKSPACE/${candidatePath}"`]);
    expect(upload).toContain(`path: ${candidatePath}`);
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

  it("AC1 isolates every matrix attempt so one failing leg cannot skip another attempt's cleanup or terminal", () => {
    const pending = "if: always() && needs.reconcile.outputs.pending == 'true'";
    for (const id of ["reconcile", "inspect", "cleanup", "terminalize"]) {
      // A matrix job's aggregate result fails when any one leg fails.
      expect(job(observer, id)).not.toMatch(/needs\.(?:inspect|cleanup|terminalize)\.result/u);
    }
    expect(cleanup).toContain(pending);
    expect(cleanup.indexOf(pending)).toBeLessThan(cleanup.indexOf("environment: merge-gate"));
    const terminalize = job(observer, "terminalize");
    expect(terminalize).toContain(pending);

    const marker = "merge-qualification-cleanup-complete-${{ matrix.run_id }}-${{ matrix.run_attempt }}";
    const ownBlock = (name) => step(observer, name).split("\n\n")[0];
    const record = ownBlock("Record exact cleanup completion");
    expect(record).not.toContain("if:");
    expect(record).toContain('{runId: $runId, runAttempt: $runAttempt, cleanup: "complete"}');
    const upload = ownBlock("Upload exact cleanup completion");
    expect(upload).toContain(`name: ${marker}`);
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).not.toContain("if: ");
    // Completion is recorded only after every cleanup step, and only when none failed.
    for (const name of [
      "Delete exact gate provider webhooks",
      "Persist cancelled post-identity attempt",
      "Delete exact gate Kubernetes namespace",
      "Report cleanup no-op",
    ]) {
      expect(cleanup.indexOf(`- name: ${name}`)).toBeLessThan(
        cleanup.indexOf("- name: Record exact cleanup completion"),
      );
    }
    expect(cleanup.indexOf("- name: Record exact cleanup completion")).toBeLessThan(
      cleanup.indexOf("- name: Upload exact cleanup completion"),
    );

    const download = step(observer, "Download exact cleanup completion");
    expect(download).toContain(`name: ${marker}`);
    const verify = step(observer, "Verify exact cleanup completion");
    expect(verify).toContain('. == {runId: $runId, runAttempt: $runAttempt, cleanup: "complete"}');
    expect(verify).toContain("RUN_ID: ${{ matrix.run_id }}");
    expect(verify).toContain("RUN_ATTEMPT: ${{ matrix.run_attempt }}");
    expect(terminalize.indexOf("- name: Download exact cleanup completion")).toBeLessThan(
      terminalize.indexOf("- name: Verify exact cleanup completion"),
    );
    expect(terminalize.indexOf("- name: Verify exact cleanup completion")).toBeLessThan(
      terminalize.indexOf("- name: Read durable observer terminals after cleanup"),
    );
  });

  it("keeps default-off and pre-gate advisory runs provider-inert", () => {
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

describe("settled-attempt index wiring", () => {
  const reconcile = job(observer, "reconcile");
  const settle = job(observer, "settle");
  const before = (block, first, second) => {
    const firstAt = block.indexOf(`- name: ${first}\n`);
    expect(firstAt, first).toBeGreaterThanOrEqual(0);
    expect(firstAt, `${first} before ${second}`).toBeLessThan(block.indexOf(`- name: ${second}\n`));
  };

  it("AC1 reads one index before both inventories and admits only unsettled attempts to every leg", () => {
    expect(step(observer, "Read latest settled-attempt index")).toContain("merge-qualification.mjs settled-index-read");
    before(reconcile, "Read latest settled-attempt index", "Inventory original enabled advisory attempts");
    before(
      reconcile,
      "Inventory original enabled advisory attempts",
      "Inventory completed producer attempts missing advisory dispatch",
    );
    const advisory = step(observer, "Inventory original enabled advisory attempts");
    const producer = step(observer, "Inventory completed producer attempts missing advisory dispatch");
    for (const block of [advisory, producer]) {
      expect(block).toContain("--settled-index artifacts/merge-qualification-settled/prior/settled-index.json");
    }
    // One shared advisory listing and one inventory instant for both joins.
    expect(advisory).toContain("--advisory-runs-out artifacts/merge-qualification-settled/advisory-runs.json");
    expect(producer).toContain("--advisory-runs artifacts/merge-qualification-settled/advisory-runs.json");
    expect(advisory).toContain('--now "$inventory_now"');
    expect(producer).toContain('--now "$INVENTORY_NOW"');
    for (const id of ["inspect", "cleanup", "terminalize"]) {
      expect(job(observer, id)).toContain("matrix: ${{ fromJSON(needs.reconcile.outputs.matrix) }}");
    }
    expect(job(observer, "producer-inspect")).toContain(
      "matrix: ${{ fromJSON(needs.reconcile.outputs.producer_matrix) }}",
    );
  });

  it("AC1 derives an advisory entry only after its durable terminal and exact cleanup marker", () => {
    const terminalize = job(observer, "terminalize");
    before(terminalize, "Verify exact cleanup completion", "Upload deterministic terminal event");
    before(terminalize, "Upload deterministic terminal event", "Derive advisory settlement entry");
    before(terminalize, "Derive advisory settlement entry", "Upload advisory settlement entry");
    const derive = step(observer, "Derive advisory settlement entry");
    expect(derive).toContain("--variant advisory");
    expect(derive).toContain("--terminal-records artifacts/merge-qualification/terminal-records.json");
    expect(derive).toContain("--cleanup-marker artifacts/merge-qualification-cleanup-complete/cleanup-complete.json");
    const key = `${MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX}advisory-\${{ matrix.run_id }}-\${{ matrix.run_attempt }}`;
    expect(derive).toContain(`--out "artifacts/merge-qualification-settled/${key}.json"`);
    const upload = step(observer, "Upload advisory settlement entry");
    expect(upload).toContain("if: steps.settle.outputs.settled == 'true'");
    expect(upload).toContain(`name: ${key}\n`);
    // One key-named file per artifact, so the merged download binds name to content.
    expect(upload).toContain(`path: artifacts/merge-qualification-settled/${key}.json\n`);
    expect(upload).toContain("if-no-files-found: error");
  });

  it("AC1 derives a producer-loss entry from its terminal alone after publication", () => {
    const producer = job(observer, "producer-inspect");
    before(producer, "Upload producer dispatch-loss terminal", "Derive producer-loss settlement entry");
    before(producer, "Derive producer-loss settlement entry", "Upload producer-loss settlement entry");
    const derive = step(observer, "Derive producer-loss settlement entry");
    expect(derive).toContain("--variant producer_loss");
    expect(derive).toContain("--terminal-records artifacts/merge-qualification-producer/terminal/records.json");
    expect(derive).toContain("--advisory-run artifacts/merge-qualification-producer/advisory.json");
    expect(derive).not.toContain("--cleanup-marker");
    const key = `${MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX}producer_loss-\${{ matrix.run_id }}-\${{ matrix.run_attempt }}`;
    expect(derive).toContain(`--out "artifacts/merge-qualification-settled/${key}.json"`);
    const upload = step(observer, "Upload producer-loss settlement entry");
    expect(upload).toContain("if: steps.settle.outputs.settled == 'true'");
    expect(upload).toContain(`name: ${key}\n`);
    expect(upload).toContain(`path: artifacts/merge-qualification-settled/${key}.json\n`);
    expect(upload).toContain("if-no-files-found: error");
  });

  it("AC3 carries only a validated index and publishes one monotonic index per delivery", () => {
    expect(reconcile).toContain("settled_index_state: ${{ steps.settled_index.outputs.state }}");
    expect(step(observer, "Carry validated settled-attempt index to the writer")).toContain(
      "if: steps.settled_index.outputs.state == 'valid'",
    );
    expect(settle).toContain("needs: [reconcile, producer-inspect, terminalize]");
    expect(settle).toContain("if: ${{ !cancelled() && needs.reconcile.result == 'success' }}");
    // A failed leg fails the run, so the latest-successful lookup never reads its index.
    expect(settle).not.toMatch(/needs\.(?:inspect|cleanup|terminalize|producer-inspect)\.result/u);
    expect(step(observer, "Download validated prior settled-attempt index")).toContain(
      "if: needs.reconcile.outputs.settled_index_state == 'valid'",
    );
    // download-artifact unpacks a lone pattern match without its artifact-named
    // directory; merge-multiple gives zero, one or many entries one flat layout.
    const entries = step(observer, "Download this delivery's settlement entries");
    expect(entries).toContain(`pattern: ${MERGE_QUALIFICATION_SETTLED_ENTRY_ARTIFACT_PREFIX}*`);
    expect(entries).toContain("merge-multiple: true");
    const write = step(observer, "Write monotonic settled-attempt index");
    expect(write).toContain("merge-qualification.mjs settled-index-write");
    expect(write).toContain('--writer-run-id "${{ github.run_id }}"');
    expect(write).toContain('--writer-run-attempt "${{ github.run_attempt }}"');
    const upload = step(observer, "Upload settled-attempt index");
    expect(upload).toContain(`name: ${MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT}\n`);
    expect(upload).toContain("path: artifacts/merge-qualification-settled/settled-index.json");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).not.toContain("if: ");
    expect(observer.match(new RegExp(`name: ${MERGE_QUALIFICATION_SETTLED_INDEX_ARTIFACT}\\n`, "gu"))).toHaveLength(1);
  });

  it("AC2 keeps the index lookup and writer provider-inert with read-only permissions", () => {
    expect(settle).toContain("permissions:\n      contents: read\n      actions: read");
    for (const block of [reconcile, settle]) {
      expect(block).not.toContain("secrets.");
      expect(block).not.toContain("kubectl");
      expect(block).not.toContain("doctl");
    }
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
