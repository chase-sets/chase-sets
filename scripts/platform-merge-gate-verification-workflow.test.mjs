import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkWorkflowProviderCredentials,
  checkWorkflowSpacesEvidenceCredentials,
} from "./workflow-provider-credentials.mjs";
import { repoRoot } from "./lib/repo.mjs";

// Contract pins for the cancellation-safe merge-gate verification environment
// (issue #5838). The gate deploys one exact digest to a uniquely labeled
// chase-sets-gate-<run>-<attempt> namespace, and EVERY terminal path —
// success, failure, cancellation, timeout, runner loss, skip — must reach a
// deleter: always() finalizers in the workflow for the first four, the
// scheduled label-scoped gate sweep for runner loss, and fail-before-mutation
// preflight for skip.

const gateWorkflowFile = ".github/workflows/platform-merge-gate-verification.yml";
const gate = readFileSync(path.join(repoRoot, gateWorkflowFile), "utf8");
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

// Every environment-scoped secret the gate consumes, exactly as the workflow
// references it. The operator checklist in the delivering PR must enumerate
// this same list (credentials-not-threaded is a five-bite failure class).
const mergeGateSecretNames = [
  "DIGITALOCEAN_ACCESS_TOKEN",
  "SPACES_ACCESS_ID",
  "SPACES_SECRET_KEY",
  "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
  "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "EASYPOST_API_KEY",
  "PLATFORM_INTERNAL_AUTH_SECRET",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
  "CHASE_SETS_DISCORD_INVITE_URL",
];

describe("merge-gate workflow identity and isolation", () => {
  it("is reusable, runs every job in the dedicated merge-gate environment, and never borrows another environment", () => {
    expect(gate).toContain("workflow_call:");
    expect(gate).toContain("workflow_dispatch:");
    const environmentLines = gate.match(/^    environment: .+$/gm) ?? [];
    expect(environmentLines.length).toBeGreaterThanOrEqual(3);
    for (const line of environmentLines) {
      expect(line.trim()).toBe("environment: merge-gate");
    }
  });

  it("keeps merge-gate concurrency separate from preview, staging, and production groups", () => {
    expect(gate).toMatch(/concurrency:\n\s+group: platform-merge-gate-/);
    expect(gate).toContain("cancel-in-progress: false");
    for (const foreignGroup of ["platform-preview-pr-", "platform-staging", "platform-production"]) {
      expect(gate).not.toContain(`group: ${foreignGroup}`);
    }
  });

  it("has no required-reviewer wait step: environment protection stays branch/secret scoped", () => {
    expect(gate).not.toContain("wait-timer");
    expect(gate).not.toContain("required_reviewers");
  });
});

describe("merge-gate fail-before-mutation preflight", () => {
  const preflight = job(gate, "preflight");

  it("validates the full credential matrix, naming every environment secret exactly once, before any provider tool runs", () => {
    const matrixStep = step(gate, "Validate merge-gate credential matrix");
    for (const name of mergeGateSecretNames) {
      expect(matrixStep, `credential matrix must require ${name}`).toContain(name);
    }
    expect(matrixStep).toContain("--stripe-test-mode-var STRIPE_SECRET_KEY");
    // The matrix step runs before doctl/kubectl ever execute in the job.
    expect(preflight.indexOf("Validate merge-gate credential matrix")).toBeLessThan(preflight.indexOf("action-doctl"));
    expect(preflight.indexOf("Validate merge-gate credential matrix")).toBeLessThan(preflight.indexOf("kubectl"));
  });

  it("withholds the Stripe secret in the withheld-credential drill so the refusal path is provable", () => {
    expect(gate).toContain("inputs.drill == 'withheld-credential' && '' || secrets.STRIPE_SECRET_KEY");
  });

  it("runs the cost-wager and capacity preflight read-only: no namespace creation, helm, or deploy in the preflight job", () => {
    expect(preflight).toContain("merge-gate-verification.mjs preflight");
    expect(preflight).toContain("--config scripts/merge-gate-verification-config.json");
    expect(preflight).not.toContain("kubectl create");
    expect(preflight).not.toContain("kubectl apply");
    expect(preflight).not.toContain("platform:kubernetes-deployment");
  });

  it("gates the verify job on preflight success while keeping it alive through cancellation", () => {
    const verify = job(gate, "verify");
    expect(verify).toContain("always() &&");
    expect(verify).toContain("needs.preflight.result == 'success'");
    expect(verify).toContain("needs: preflight");
  });
});

describe("merge-gate exact-digest deployment", () => {
  it("deploys only the pinned immutable digest and proves the running pod digest", () => {
    const image = step(gate, "Resolve exact gate image digest");
    expect(image).toContain("^sha256:[0-9a-f]{64}$");
    expect(image).toContain("refusing to deploy a different digest");
    expect(step(gate, "Deploy gate Kubernetes release")).toContain(
      "PLATFORM_IMAGE_REF: ${{ steps.image.outputs.repository }}@${{ steps.image.outputs.digest }}",
    );
    const proof = step(gate, "Prove running pod digest");
    expect(proof).toContain("imageID");
    expect(proof).toContain("exit 1");
  });

  it("creates the gate namespace atomically with labels and annotations, never create-then-label", () => {
    const create = step(gate, "Create gate namespace");
    expect(create).toContain("merge-gate-verification.mjs namespace-manifest");
    expect(create).toContain("kubectl create -f -");
    expect(gate).not.toContain("kubectl label namespace");
    expect(gate).not.toContain("kubectl annotate namespace");
    const upload = step(gate, "Upload gate namespace creation observation");
    expect(create).toContain("merge-gate-verification.mjs provisioning-observation");
    expect(create).toContain("trap cleanup_unhanded_namespace EXIT");
    expect(create).toContain("created=true");
    expect(create).toContain('echo "provisioned=true" >> "$GITHUB_OUTPUT"');
    expect(create).toContain("handed_off=true");
    expect(upload).toContain("merge-gate-provisioning-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(upload).toContain("id: provisioning-upload");
    expect(step(gate, "Confirm durable gate namespace creation observation")).toContain(
      "if: always() && steps.provisioning-upload.outcome == 'success'",
    );
    expect(gate.indexOf("- name: Create gate namespace")).toBeLessThan(
      gate.indexOf("- name: Upload gate namespace creation observation"),
    );
    expect(gate.indexOf("- name: Upload gate namespace creation observation")).toBeLessThan(
      gate.indexOf("- name: Induced failure drill"),
    );
  });

  it("requires delivered Stripe test-mode webhooks in the money smoke", () => {
    expect(step(gate, "Stripe money smoke")).toContain('STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS: "true"');
  });

  it("persists the durable qualification record for pass AND fail with the dedicated evidence credentials threaded", () => {
    const record = step(gate, "Persist release qualification record");
    expect(record).toContain("if: ${{ !cancelled() }}");
    expect(record).toContain("release-qualification-record.mjs write");
    expect(record).toContain("RELEASE_EVIDENCE_SPACES_ACCESS_ID: ${{ secrets.RELEASE_EVIDENCE_SPACES_ACCESS_ID }}");
    expect(record).toContain("RELEASE_EVIDENCE_SPACES_SECRET_KEY: ${{ secrets.RELEASE_EVIDENCE_SPACES_SECRET_KEY }}");
    expect(record).toContain('qualificationLane: "merge-gate"');
    expect(record).toContain("${{ job.status == 'success' && 'pass' || 'fail' }}");
  });
});

describe("merge-gate teardown finalizers (every terminal path has a deleter)", () => {
  it("always deletes provider webhooks, tears the namespace down without best-effort escapes, and probes absence", () => {
    const webhooks = step(gate, "Delete gate provider webhooks");
    const teardown = step(gate, "Delete gate Kubernetes namespace");
    const probe = step(gate, "Probe gate namespace absence");
    const record = step(gate, "Write merge-gate run record");
    for (const finalizer of [webhooks, teardown, probe, record]) {
      expect(finalizer).toContain("if: always()");
    }
    for (const credentialedFinalizer of [webhooks, teardown, probe]) {
      expect(credentialedFinalizer).toContain("steps.namespace.outcome == 'success'");
    }
    expect(teardown).toContain("platform:kubernetes-deployment -- teardown");
    expect(teardown).not.toContain("|| true");
    expect(teardown).not.toContain("continue-on-error");
    expect(teardown).not.toContain("2>/dev/null");
    expect(teardown).not.toMatch(/\bset\s+\+e\b/);
    expect(probe).toContain("--ignore-not-found");
    // Ordering: webhooks -> teardown -> absence probe -> run record -> upload.
    const order = [
      gate.indexOf("- name: Delete gate provider webhooks"),
      gate.indexOf("- name: Delete gate Kubernetes namespace"),
      gate.indexOf("- name: Probe gate namespace absence"),
      gate.indexOf("- name: Write merge-gate run record"),
      gate.indexOf("- name: Upload merge-gate evidence"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[0]).toBeGreaterThan(-1);
  });

  it("stages the induced-failure drill after namespace creation so failure-path cleanup is provable", () => {
    const drill = step(gate, "Induced failure drill");
    expect(drill).toContain("if: inputs.drill == 'induced-failure'");
    expect(drill).toContain("exit 1");
    expect(gate.indexOf("- name: Create gate namespace")).toBeLessThan(gate.indexOf("- name: Induced failure drill"));
  });

  it("strands a labeled, past-deadline fixture only in the dedicated drill job that skips verification", () => {
    const fixture = job(gate, "stranded-fixture-drill");
    expect(fixture).toContain("inputs.drill == 'stranded-fixture'");
    expect(fixture).toContain("--cleanup-deadline-hours 0");
    const verify = job(gate, "verify");
    expect(verify).toContain("inputs.drill != 'stranded-fixture'");
    expect(verify).toContain("inputs.drill != 'withheld-credential'");
  });
});

describe("merge-gate credential guards", () => {
  it("threads provider credentials into every terraform/doctl/aws-invoking step of the gate workflow", () => {
    const result = checkWorkflowProviderCredentials(gate, { workflowFile: gateWorkflowFile });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checkedSteps.length).toBeGreaterThanOrEqual(5);
  });

  it("threads the dedicated Spaces evidence credentials on exactly the steps that touch them", () => {
    const result = checkWorkflowSpacesEvidenceCredentials(gate, { workflowFile: gateWorkflowFile });
    expect(result.violations).toEqual([]);
    expect(result.checkedSteps.map((checked) => checked.name)).toEqual([
      "Validate merge-gate credential matrix",
      "Persist release qualification record",
    ]);
  });

  it("negative control: dropping the doctl token from the image-resolve step is caught", () => {
    const stripped = gate.replace(
      /^ {10}DIGITALOCEAN_ACCESS_TOKEN: \$\{\{ secrets\.DIGITALOCEAN_ACCESS_TOKEN \}\}\n(?= {10}REQUESTED_DIGEST)/m,
      "",
    );
    expect(stripped).not.toBe(gate);
    const result = checkWorkflowProviderCredentials(stripped, { workflowFile: gateWorkflowFile });
    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      expect.stringContaining("'Resolve exact gate image digest' invokes doctl but does not declare step env"),
    ]);
  });
});

describe("scheduled gate sweep backstop (platform-preview-cleanup.yml)", () => {
  it("discovers stale gate namespaces with the shared parser in gate kind on every schedule tick", () => {
    const discovery = job(cleanup, "discover-stale-gate");
    expect(discovery).toContain("if: github.event_name == 'schedule'");
    expect(discovery).toContain("ephemeral-verification-namespace.mjs --kind gate");
    expect(discovery).toContain("--report artifacts/release-health/merge-gate-stale-sweep.json");
    // 3-hourly cron holds the 6-hour orphan SLO; the daily-only jobs stay
    // pinned to the original cron string.
    expect(cleanup).toContain('- cron: "47 */3 * * *"');
    expect(job(cleanup, "discover-preview-cleanup")).toContain("github.event.schedule == '17 10 * * *'");
    expect(job(cleanup, "discover-stale-verification")).toContain("github.event.schedule == '17 10 * * *'");
  });

  it("destroys eligible gate namespaces with the same non-best-effort teardown contract", () => {
    const destroy = job(cleanup, "destroy-stale-gate");
    expect(destroy).toContain("needs: discover-stale-gate");
    const teardown = step(cleanup, "Delete stale gate Kubernetes namespace");
    expect(teardown).toContain("if: always()");
    expect(teardown).toContain("platform:kubernetes-deployment -- teardown");
    expect(teardown).not.toContain("|| true");
    expect(teardown).not.toContain("continue-on-error");
  });

  it("reports scanned/eligible/refused/deleted/failed totals for every scheduled sweep", () => {
    const report = job(cleanup, "report-stale-gate-sweep");
    expect(report).toContain("needs: [discover-stale-gate, destroy-stale-gate]");
    for (const total of ["Scanned namespaces", "Eligible", "Refused", "Deleted", "Failed deletions"]) {
      expect(report).toContain(total);
    }
  });
});
