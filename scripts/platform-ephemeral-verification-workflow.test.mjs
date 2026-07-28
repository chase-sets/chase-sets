import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const verification = readFileSync(path.join(repoRoot, ".github/workflows/platform-ephemeral-verification.yml"), "utf8");
const production = readFileSync(path.join(repoRoot, ".github/workflows/platform-production.yml"), "utf8");
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
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function expectStepBefore(workflow, earlier, later) {
  const earlierIndex = workflow.indexOf(`      - name: ${earlier}\n`);
  const laterIndex = workflow.indexOf(`      - name: ${later}\n`);
  if (earlierIndex < 0) throw new Error(`Missing step ${earlier}`);
  if (laterIndex < 0) throw new Error(`Missing step ${later}`);
  if (earlierIndex >= laterIndex) throw new Error(`${earlier} must precede ${later}`);
}

function expectProducerHandoffCoupling(workflow) {
  const deployProduction = job(workflow, "deploy-production");
  if (!deployProduction.includes("name: Deploy Production")) throw new Error("Deploy Production job name changed");
  for (const name of ["Write promoted release handoff", "Upload promoted release handoff"]) {
    if (!step(workflow, name).includes("if: steps.production_marker.outputs.marker_updated == 'true'")) {
      throw new Error(`${name} is not coupled to the production marker`);
    }
  }
  if (!step(workflow, "Upload promoted release handoff").includes("if-no-files-found: error")) {
    throw new Error("Promoted release upload does not fail closed");
  }
}

describe("platform ephemeral verification workflow", () => {
  it("downloads and validates the exact triggering deploy's promoted release artifact", () => {
    const download = step(verification, "Download promoted release handoff");
    const handoff = step(verification, "Validate promoted release handoff");
    expect(verification).toContain("workflows: [Platform Deploy]");
    expect(step(verification, "Check triggering deploy promotion")).toContain(
      '.name == "Deploy Production" and .conclusion == "success"',
    );
    expect(verification).toContain("needs.select-promoted-release.outputs.eligible == 'true'");
    expect(download).toContain("name: promoted-release");
    expect(download).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(download).toContain("continue-on-error: true");
    expect(handoff).toContain("promoted-release-handoff-absent");
    expect(handoff).toContain("artifacts/promoted-release/promoted-release.json");
    expect(handoff).toContain("promoted-release.mjs validate");
    expect(handoff).not.toContain("continue-on-error");
    expect(handoff).toContain('--expected-producer-run-id "${{ github.event.workflow_run.id }}"');
    expect(handoff).toContain('--expected-producer-run-attempt "${{ github.event.workflow_run.run_attempt }}"');
    expectStepBefore(verification, "Validate promoted release handoff", "Resolve promoted release image");
    expectStepBefore(verification, "Validate promoted release handoff", "Reset verification namespace");
    expectStepBefore(verification, "Validate promoted release handoff", "Register verification provider webhooks");
    expect(step(verification, "Deploy verification Kubernetes release")).toContain(
      "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}",
    );
  });

  it("validates provenance before the artifact-designated checkout and install", () => {
    const checkout = verification.slice(
      verification.indexOf("      - name: Check out trusted workflow code"),
      verification.indexOf("\n      - ", verification.indexOf("      - name: Check out trusted workflow code") + 1),
    );
    expect(checkout).toContain("github.event.repository.default_branch");
    expectStepBefore(verification, "Validate promoted release handoff", "Resolve release commit");
    expectStepBefore(verification, "Resolve release commit", "Install release workspace");
    expect(step(verification, "Resolve release commit")).toContain('git checkout --detach "$release_commit"');
    expect(step(verification, "Resolve release commit")).toContain("git rev-parse HEAD");

    const validation = step(verification, "Validate promoted release handoff");
    const release = step(verification, "Resolve release commit");
    const regressed = verification.replace(validation, "").replace(release, `${release}\n${validation}`);
    expect(() => expectStepBefore(regressed, "Validate promoted release handoff", "Resolve release commit")).toThrow(
      /must precede/,
    );
  });

  it("keeps a successful production deploy coupled to a fail-closed handoff upload", () => {
    expectProducerHandoffCoupling(production);
    const regressed = production.replace(
      "if: steps.production_marker.outputs.marker_updated == 'true'",
      "if: success()",
    );
    expect(() => expectProducerHandoffCoupling(regressed)).toThrow(/not coupled/);
  });

  it("bounds automatic fan-out while keeping manual proofs independent", () => {
    expect(verification).toContain("'platform-ephemeral-verification-automatic'");
    expect(verification).toContain("cancel-in-progress: ${{ github.event_name == 'workflow_run' }}");
    expect(verification).toContain("platform-ephemeral-verification-manual");
  });

  it("writes terminal evidence after teardown with immutable identity and failure phase", () => {
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
    expect(evidence).not.toContain("persistentStagingRetained: true");
    expectStepBefore(verification, "Delete verification provider webhooks", "Write ephemeral verification evidence");
    expectStepBefore(verification, "Delete verification Kubernetes namespace", "Write ephemeral verification evidence");
    expectStepBefore(verification, "Write ephemeral verification evidence", "Upload ephemeral verification evidence");
    expect(step(verification, "Upload ephemeral verification evidence")).toContain("if-no-files-found: error");
  });

  it("reuses the preview deploy and smoke machinery around representative commerce state", () => {
    expect(step(verification, "Deploy verification Kubernetes release")).toContain(
      "platform:kubernetes-deployment -- deploy",
    );
    expect(step(verification, "Wait for verification ingress URLs")).toContain("platform-ingress-wait.mjs");
    expect(step(verification, "Smoke check")).toContain("pnpm run smoke:platform");
    expect(step(verification, "Run representative commerce state")).toContain(
      "representative-commerce-state:production",
    );
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

  it("always removes provider registrations and fails on a surviving namespace", () => {
    const verifyJob = job(verification, "verify-release");
    const providers = step(verification, "Delete verification provider webhooks");
    const namespace = step(verification, "Delete verification Kubernetes namespace");
    expect(verifyJob).toContain("always() &&");
    expect(providers).toContain("if: always()");
    expect(providers).toContain("steps.provider_create.outcome != 'skipped'");
    for (const terminalPath of ["success", "failure", "cancelled", "skipped"]) {
      expect(namespace, `${terminalPath} must reach namespace cleanup`).toContain("if: always()");
    }
    expect(namespace).toContain("steps.namespace.outcome != 'skipped'");
    expect(namespace).toContain("platform:kubernetes-deployment -- teardown");
    expect(namespace).not.toContain("|| true");
    expect(namespace).not.toContain("continue-on-error");
  });

  it("backstops 24-hour verification namespaces independently from preview discovery", () => {
    const discovery = job(cleanup, "discover-stale-verification");
    const destroy = job(cleanup, "destroy-stale-verification");
    expect(discovery).toContain('VERIFICATION_NAMESPACE_MAX_AGE_HOURS: "24"');
    expect(discovery).toContain("ephemeral-verification-namespace.mjs");
    for (const kubernetesJob of [discovery, destroy]) {
      expect(kubernetesJob).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
      expect(kubernetesJob).toContain("token: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
    }
    expect(destroy).toContain("needs: discover-stale-verification");
    const namespace = step(cleanup, "Delete stale verification Kubernetes namespace");
    expect(namespace).toContain("if: always()");
    expect(namespace).toContain("platform:kubernetes-deployment -- teardown");
    expect(namespace).not.toContain("|| true");
  });
});
