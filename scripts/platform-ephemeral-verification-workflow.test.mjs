import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const verification = readFileSync(path.join(repoRoot, ".github/workflows/platform-ephemeral-verification.yml"), "utf8");
const production = readFileSync(path.join(repoRoot, ".github/workflows/platform-production.yml"), "utf8");
const releaseCandidate = readFileSync(path.join(repoRoot, ".github/workflows/platform-release-candidate.yml"), "utf8");
const cleanup = readFileSync(path.join(repoRoot, ".github/workflows/platform-preview-cleanup.yml"), "utf8");

function step(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing step ${name}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function job(workflow, name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing job ${name}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z0-9][a-z0-9-]*:\n/mu);
  const end = nextJob < 0 ? workflow.length : start + marker.length + nextJob;
  return workflow.slice(start, end);
}

function expectStepBefore(workflow, earlier, later) {
  const earlierIndex = workflow.indexOf(`      - name: ${earlier}\n`);
  const laterIndex = workflow.indexOf(`      - name: ${later}\n`);
  if (earlierIndex < 0) throw new Error(`Missing step ${earlier}`);
  if (laterIndex < 0) throw new Error(`Missing step ${later}`);
  if (earlierIndex >= laterIndex) throw new Error(`${earlier} must precede ${later}`);
}

function expectAutomaticDispatchContract(workflow) {
  const dispatch = job(workflow, "dispatch-ephemeral-verification");
  expect(dispatch).toContain("needs: deploy-production");
  expect(dispatch).toContain("needs.deploy-production.result == 'success'");
  expect(dispatch).toContain("vars.PLATFORM_EPHEMERAL_VERIFICATION_ENABLED == 'true'");
  expect(dispatch).toContain("continue-on-error: true");
  expect(dispatch).not.toMatch(/^    environment:/mu);
  expect(dispatch).toContain("permissions:\n      actions: write\n      contents: read");
  const dispatchStep = step(dispatch, "Dispatch automatic ephemeral verification");
  expect(dispatchStep).toContain("gh workflow run platform-ephemeral-verification.yml");
  expect(dispatchStep).toContain('-f producer_run_id="${{ github.run_id }}"');
  expect(dispatchStep).toContain('-f producer_run_attempt="${{ github.run_attempt }}"');
  expect(dispatchStep).toContain("-f dispatch_source=automatic");
}

function producerDisposition({ deployProductionResult, handoff, dispatchResult = "success", enabled = true }) {
  const dispatches = enabled && deployProductionResult === "success";
  return {
    dispatches,
    handoff,
    verification: !dispatches
      ? "not-created"
      : dispatchResult === "failure"
        ? "dispatch-failed-release-unchanged"
        : handoff
          ? "resolvable"
          : "promoted-release-handoff-absent",
  };
}

function handoffDisposition({ artifactCount, producerStatus, waitExpired = false }) {
  if (artifactCount === 1) return "resolvable";
  if (artifactCount > 1) return "promoted-release-handoff-invalid";
  if (producerStatus === "completed") return "promoted-release-handoff-absent";
  if (waitExpired) return "promoted-release-handoff-pending-timeout";
  return "pending";
}

describe("platform ephemeral verification workflow", () => {
  it("dispatches only after the owning production job executed successfully", () => {
    expectAutomaticDispatchContract(production);
    expect(producerDisposition({ deployProductionResult: "skipped", handoff: false })).toEqual({
      dispatches: false,
      handoff: false,
      verification: "not-created",
    });

    const regressed = production.replace(
      "needs.deploy-production.result == 'success'",
      "needs.deploy-production.result != 'failure'",
    );
    expect(() => expectAutomaticDispatchContract(regressed)).toThrow();
  });

  it("keeps advisory dispatch outside the release conclusion and known-failure lanes", () => {
    expectAutomaticDispatchContract(production);
    const guard = step(releaseCandidate, "Known Failure Guard");
    expect(guard).toContain("--lane release-dispatch");
    expect(guard).toContain("--lane staging");
    expect(guard).toContain("--lane production");
    expect(guard).not.toContain("ephemeral-verification");
    expect(
      producerDisposition({ deployProductionResult: "success", handoff: true, dispatchResult: "failure" }),
    ).toMatchObject({ verification: "dispatch-failed-release-unchanged" });

    const dispatch = job(production, "dispatch-ephemeral-verification");
    const regressed = production.replace(
      dispatch,
      dispatch.replace("continue-on-error: true", "continue-on-error: false"),
    );
    expect(() => expectAutomaticDispatchContract(regressed)).toThrow();
  });

  it("enumerates every terminal producer state without treating skipped deployment as missing evidence", () => {
    const states = [
      ["deployment-not-required", "skipped", false, "not-created"],
      ["staging-deployed-production-skipped", "skipped", false, "not-created"],
      ["production-marker-mismatch", "failure", false, "not-created"],
      ["marker-push-failure", "failure", false, "not-created"],
      ["post-upload-step-failure", "failure", true, "not-created"],
      ["dispatch-step-failure", "success", true, "dispatch-failed-release-unchanged"],
      ["successful-production", "success", true, "resolvable"],
    ].map(([state, result, handoff, verificationResult]) => ({
      state,
      ...producerDisposition({
        deployProductionResult: result,
        handoff,
        dispatchResult: state === "dispatch-step-failure" ? "failure" : "success",
      }),
      expectedVerification: verificationResult,
    }));

    expect(states.every((entry) => entry.verification === entry.expectedVerification)).toBe(true);
    expect(states.filter((entry) => entry.dispatches).map((entry) => entry.state)).toEqual([
      "dispatch-step-failure",
      "successful-production",
    ]);
  });

  it("accepts producer inputs only as pointers and proves the exact run and attempt", () => {
    expect(verification).not.toContain("workflow_run:");
    expect(verification).not.toContain("github.event.workflow_run");
    for (const input of ["producer_run_id:", "producer_run_attempt:", "dispatch_source:"]) {
      expect(verification).toContain(input);
    }
    const download = step(verification, "Download promoted release handoff");
    const handoff = step(verification, "Validate promoted release handoff");
    expect(download).toContain("name: promoted-release");
    expect(download).toContain("run-id: ${{ inputs.producer_run_id }}");
    expect(download).toContain("continue-on-error: true");
    expect(handoff).toContain("promoted-release.mjs validate");
    expect(handoff).toContain('--expected-producer-run-id "${{ inputs.producer_run_id }}"');
    expect(handoff).toContain('--expected-producer-run-attempt "${{ inputs.producer_run_attempt }}"');
    expect(handoff).toContain("--expected-environment production");

    const regressed = verification.replace("run-id: ${{ inputs.producer_run_id }}", "merge-multiple: true");
    expect(step(regressed, "Download promoted release handoff")).not.toContain("run-id:");
  });

  it("distinguishes resolvable, terminal-absent, and still-running timeout handoffs", () => {
    expect(handoffDisposition({ artifactCount: 1, producerStatus: "in_progress" })).toBe("resolvable");
    expect(handoffDisposition({ artifactCount: 0, producerStatus: "completed" })).toBe(
      "promoted-release-handoff-absent",
    );
    expect(handoffDisposition({ artifactCount: 0, producerStatus: "in_progress", waitExpired: true })).toBe(
      "promoted-release-handoff-pending-timeout",
    );
    const wait = step(verification, "Wait for promoted release handoff");
    for (const disposition of [
      "promoted-release-handoff-pending-timeout",
      "promoted-release-handoff-absent",
      "promoted-release-handoff-invalid",
    ]) {
      expect(wait).toContain(disposition);
    }
    expect(wait).toContain("for attempt in $(seq 1 12)");
    expect(wait).toContain('producer_status" = "completed"');
    expectStepBefore(verification, "Wait for promoted release handoff", "Set up doctl");
    expectStepBefore(verification, "Validate promoted release handoff", "Reset verification namespace");

    const regressed = verification.replaceAll(
      "promoted-release-handoff-pending-timeout",
      "promoted-release-handoff-absent",
    );
    expect(new Set(regressed.match(/promoted-release-handoff-(?:pending-timeout|absent)/gu))).not.toContain(
      "promoted-release-handoff-pending-timeout",
    );
  });

  it("validates provenance before artifact-designated checkout and release code execution", () => {
    const checkout = step(verification, "Check out trusted workflow code");
    expect(checkout).toContain("github.event.repository.default_branch");
    expectStepBefore(verification, "Validate promoted release handoff", "Resolve release commit");
    expectStepBefore(verification, "Resolve release commit", "Install release workspace");
    const release = step(verification, "Resolve release commit");
    expect(release).toContain('git checkout --detach "$release_commit"');
    expect(release).toContain("git rev-parse HEAD");
    const validation = step(verification, "Validate promoted release handoff");
    const regressed = verification.replace(validation, "").replace(release, `${release}\n${validation}`);
    expect(() => expectStepBefore(regressed, "Validate promoted release handoff", "Resolve release commit")).toThrow(
      /must precede/,
    );
  });

  it("binds automatic concurrency to the conditional mutation job only", () => {
    const verify = job(verification, "verify-release");
    const select = job(verification, "select-promoted-release");
    const preamble = verification.slice(0, verification.indexOf("jobs:\n"));
    expect(verify).toContain("group: ${{ inputs.dispatch_source == 'automatic'");
    expect(verify).toContain("'platform-ephemeral-verification-automatic'");
    expect(verify).toContain("platform-ephemeral-verification-manual-{0}");
    expect(verify).toContain("cancel-in-progress: ${{ inputs.dispatch_source == 'automatic' }}");
    expect(select).not.toContain("concurrency:");
    expect(preamble).not.toContain("concurrency:");

    const concurrency = verify.slice(verify.indexOf("    concurrency:\n"), verify.indexOf("    env:\n"));
    const regressed = verification.replace(concurrency, "").replace("jobs:\n", `${concurrency}\njobs:\n`);
    expect(regressed.slice(0, regressed.indexOf("jobs:\n"))).toContain("concurrency:");
    expect(job(regressed, "verify-release")).not.toContain("platform-ephemeral-verification-automatic");
  });

  it("writes terminal evidence after teardown with immutable identity and truthful staging retention", () => {
    const evidence = step(verification, "Write ephemeral verification evidence");
    for (const field of [
      "imageRepository",
      "imageDigest",
      "producerRunId",
      "producerRunAttempt",
      "trigger",
      "teardownResult",
      "failurePhase",
      "persistentStagingRetained",
    ]) {
      expect(evidence).toContain(field);
    }
    expect(evidence).toContain("persistentStagingRetained: targetsDisposableNamespace");
    expect(evidence).not.toContain("persistentStagingRetained: false");
    expect(/^chase-sets-verify-[1-9][0-9]*-[1-9][0-9]*$/.test("chase-sets-verify-123-1")).toBe(true);
    expectStepBefore(verification, "Delete verification provider webhooks", "Write ephemeral verification evidence");
    expectStepBefore(verification, "Delete verification Kubernetes namespace", "Write ephemeral verification evidence");
    expectStepBefore(verification, "Write ephemeral verification evidence", "Upload ephemeral verification evidence");
    expect(step(verification, "Upload ephemeral verification evidence")).toContain("if-no-files-found: error");
  });

  it("reuses preview deployment and always tears down attempted mutations", () => {
    expect(step(verification, "Deploy verification Kubernetes release")).toContain(
      "platform:kubernetes-deployment -- deploy",
    );
    expect(step(verification, "Wait for verification ingress URLs")).toContain("platform-ingress-wait.mjs");
    expect(step(verification, "Smoke check")).toContain("pnpm run smoke:platform");
    expect(step(verification, "Run representative commerce state")).toContain(
      "representative-commerce-state:production",
    );
    const providers = step(verification, "Delete verification provider webhooks");
    const namespace = step(verification, "Delete verification Kubernetes namespace");
    expect(providers).toContain("if: always() && steps.provider_create.outcome != 'skipped'");
    expect(namespace).toContain("if: always() && steps.namespace.outcome != 'skipped'");
    expect(namespace).toContain("platform:kubernetes-deployment -- teardown");
    expect(namespace).not.toContain("|| true");
    expect(namespace).not.toContain("continue-on-error");
  });

  it("provides every optional UCP secret expected by the Helm runtime contract", () => {
    const runtimeSecrets = step(verification, "Apply verification Kubernetes runtime secrets");
    for (const environmentName of [
      "UCP_BUSINESS_SIGNING_KEY_ID",
      "UCP_BUSINESS_SIGNING_ALG",
      "UCP_BUSINESS_SIGNING_PRIVATE_JWK",
      "UCP_BUSINESS_SIGNING_PREVIOUS_PUBLIC_JWKS",
      "UCP_AP2_VERIFIER_URL",
      "UCP_AP2_VERIFIER_AUTH_TOKEN",
      "UCP_AP2_VERIFIER_TIMEOUT_MS",
    ]) {
      expect(runtimeSecrets).toContain(`${environmentName}:`);
    }
  });

  it("backstops verification namespaces and provider webhooks through independent authorities", () => {
    const namespaceDiscovery = job(cleanup, "discover-stale-verification");
    const namespaceDestroy = job(cleanup, "destroy-stale-verification");
    expect(namespaceDiscovery).toContain('VERIFICATION_NAMESPACE_MAX_AGE_HOURS: "24"');
    expect(namespaceDiscovery).toContain("ephemeral-verification-namespace.mjs");
    expect(namespaceDestroy).toContain("needs: discover-stale-verification");

    const webhookDiscovery = job(cleanup, "discover-stale-verification-webhooks");
    const webhookDelete = job(cleanup, "delete-stale-verification-webhooks");
    expect(webhookDiscovery).toContain("platform-ephemeral-verification.yml/runs?status=completed");
    expect(webhookDiscovery).not.toContain("kubectl");
    expect(webhookDiscovery).toContain("verify-");
    expect(webhookDelete).toContain("needs: discover-stale-verification-webhooks");
    expect(webhookDelete).toContain("provider-webhook-lifecycle.mjs delete");
    expect(webhookDelete).not.toContain("discover-stale-verification.outputs");

    const regressed = cleanup.replace(
      "needs: discover-stale-verification-webhooks",
      "needs: discover-stale-verification",
    );
    expect(job(regressed, "delete-stale-verification-webhooks")).not.toContain(
      "needs: discover-stale-verification-webhooks",
    );
  });
});
