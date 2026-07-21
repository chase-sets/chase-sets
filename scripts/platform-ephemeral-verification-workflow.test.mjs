import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./lib/repo.mjs";

const verification = readFileSync(path.join(repoRoot, ".github/workflows/platform-ephemeral-verification.yml"), "utf8");
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

describe("platform ephemeral verification workflow", () => {
  it("downloads and validates the exact triggering deploy's promoted release artifact", () => {
    const download = step(verification, "Download promoted release handoff");
    const image = step(verification, "Resolve promoted release image");
    expect(verification).toContain("workflows: [Platform Deploy]");
    expect(step(verification, "Check triggering deploy promotion")).toContain(
      '.name == "Deploy Production" and .conclusion == "success"',
    );
    expect(verification).toContain("needs.select-promoted-release.outputs.eligible == 'true'");
    expect(download).toContain("name: promoted-release");
    expect(download).toContain("run-id: ${{ github.event.workflow_run.id }}");
    expect(image).toContain("promoted-release.mjs validate");
    expect(image).toContain('--expected-producer-run-id "${{ github.event.workflow_run.id }}"');
    expect(image).toContain('--expected-producer-run-attempt "${{ github.event.workflow_run.run_attempt }}"');
    expect(step(verification, "Deploy verification Kubernetes release")).toContain(
      "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}",
    );
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
    for (const terminalPath of ["success", "failure", "cancelled", "skipped"]) {
      expect(namespace, `${terminalPath} must reach namespace cleanup`).toContain("if: always()");
    }
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
