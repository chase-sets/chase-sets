import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { repoRoot } from "./lib/repo.mjs";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import { stagingRefreshOverlapWorkflowFiles } from "./staging-refresh-preflight-config.mjs";
import {
  checkWorkflowProviderCredentials,
  checkWorkflowSpacesEvidenceCredentials,
} from "./workflow-provider-credentials.mjs";

const workflowFile = ".github/workflows/platform-staging-cluster-addons.yml";
const authorityFile = ".github/authority/platform-staging-cluster-addons/apply-staging-cluster-addons.json";
const runbookFile = "docs/runbooks/doks-platform-operations.md";
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const source = read(workflowFile);

const CONFIRM = "apply staging cluster addons";
const REFUSE_JOB = "refuse-invalid-dispatch";
const APPLY_JOB = "apply-staging-cluster-addons";
const PLANNER = "node ./scripts/doks-cluster-addons.mjs";
const TOKEN = "DIGITALOCEAN_ACCESS_TOKEN";
const STEP = Object.freeze({
  resolve: "Resolve release commit",
  context: "Configure staging Kubernetes context",
  before: "Capture Helm releases before apply",
  probe: "Probe DigitalOcean token presence",
  apply: "Apply staging cluster add-ons",
  after: "Capture Helm releases after apply",
  evidence: "Write staging cluster add-on evidence",
  scan: "Scan evidence for the DigitalOcean token",
  upload: "Upload staging cluster add-on evidence",
});
const TOKEN_STEPS = [STEP.context, STEP.probe, STEP.apply, STEP.scan];
const MUTATING_COMMAND = /\bhelm\s+(?:upgrade|install)\b|\bkubectl\s+apply\b/;

const applySteps = (workflow) => workflow.jobs[APPLY_JOB].steps;
const stepIndex = (workflow, name) => {
  const index = applySteps(workflow).findIndex((step) => step.name === name);
  if (index < 0) throw new Error(`missing step ${name}`);
  return index;
};
const stepNamed = (workflow, name) => applySteps(workflow)[stepIndex(workflow, name)];
const allSteps = (workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const referencesSecrets = (value) => JSON.stringify(value ?? {}).includes("secrets.");
const asList = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

function replaceOnce(raw, from, to) {
  if (!raw.includes(from)) throw new Error(`negative control anchor not found: ${from}`);
  return raw.replace(from, to);
}

function mutate(raw, change) {
  const workflow = parseYaml(raw);
  change(workflow);
  return stringifyYaml(workflow, { lineWidth: 0 });
}

function assertDispatchBoundary(raw) {
  const workflow = parseYaml(raw);
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(Object.keys(inputs).sort()).toEqual(["confirm", "preflight_only", "release_ref"]);
  expect(inputs.confirm).toMatchObject({ required: true, type: "string" });
  expect(inputs.release_ref).toMatchObject({ required: true, type: "string" });
  expect(inputs.preflight_only).toMatchObject({ type: "boolean", default: false });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({ group: "platform-staging-mutating-operations", "cancel-in-progress": false });
  expect(Object.keys(workflow.jobs).sort()).toEqual([APPLY_JOB, REFUSE_JOB].sort());

  const refuse = workflow.jobs[REFUSE_JOB];
  expect(refuse.environment).toBeUndefined();
  expect(refuse.if).toBeUndefined();
  expect(refuse.steps).toHaveLength(1);
  const [refusal] = refuse.steps;
  expect(refusal.env).toEqual({ CONFIRM: "${{ inputs.confirm }}", RELEASE_REF: "${{ inputs.release_ref }}" });
  expect(refusal.run).toContain(`if [ "$CONFIRM" != "${CONFIRM}" ]; then`);
  expect(refusal.run).toContain('if ! [[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]; then');
  expect(refusal.run).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then');
  expect(refusal.run.match(/^\s+exit 1$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3);

  const apply = workflow.jobs[APPLY_JOB];
  expect(asList(apply.needs)).toEqual([REFUSE_JOB]);
  expect(apply.if).toBeUndefined();
  expect(apply.environment).toBe("staging");
  expect(Object.entries(workflow.jobs).filter(([, job]) => job.environment !== undefined)).toEqual([
    [APPLY_JOB, apply],
  ]);
  expect(apply.concurrency).toEqual({ group: "platform-deploy-staging", "cancel-in-progress": false });
  expect(apply["timeout-minutes"]).toBeGreaterThan(0);
  expect(apply["timeout-minutes"]).toBeLessThanOrEqual(60);
  expect(apply.env).toMatchObject({
    RELEASE_REF: "${{ inputs.release_ref }}",
    PREFLIGHT_ONLY: "${{ inputs.preflight_only }}",
  });

  for (const step of allSteps(workflow).filter((candidate) => candidate.run !== undefined)) {
    expect(step.run, `${step.name ?? "unnamed step"} interpolates an expression inside run`).not.toContain("${{");
  }

  const steps = applySteps(workflow);
  const checkout = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  const resolve = stepIndex(workflow, STEP.resolve);
  const firstSecret = steps.findIndex((step) => referencesSecrets(step));
  expect(checkout).toBeGreaterThanOrEqual(0);
  expect(steps[checkout].with?.["fetch-depth"]).toBe(0);
  expect(checkout).toBeLessThan(resolve);
  expect(firstSecret).toBeGreaterThan(resolve);
  expect(steps[resolve].run).toContain(`node ./scripts/resolve-release-commit.mjs`);
  expect(steps[resolve].run).toContain('--release-ref "$RELEASE_REF"');
  expect(steps[resolve].run).toContain("--checkout true");
  expect(steps[resolve].run).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_REF"');
}

function assertStepLocalSecrets(raw) {
  const workflow = parseYaml(raw);
  expect(referencesSecrets(workflow.env)).toBe(false);
  for (const job of Object.values(workflow.jobs)) {
    expect(referencesSecrets(job.env)).toBe(false);
    for (const step of job.steps ?? []) {
      const { env: _env, ...rest } = step;
      expect(referencesSecrets(rest), `${step.name ?? step.uses} reads a secret outside step env`).toBe(false);
    }
  }
  const stepsWith = (secret) =>
    allSteps(workflow)
      .filter((step) => JSON.stringify(step.env ?? {}).includes(`secrets.${secret} `))
      .map((step) => step.name);
  expect(stepsWith(TOKEN)).toEqual(TOKEN_STEPS);
  expect(stepsWith("SPACES_ACCESS_ID")).toEqual([STEP.context]);
  expect(stepsWith("SPACES_SECRET_KEY")).toEqual([STEP.context]);
  expect(JSON.stringify(workflow).match(/secrets\.[A-Z_]+/g)?.every((ref) =>
    ["secrets.DIGITALOCEAN_ACCESS_TOKEN", "secrets.SPACES_ACCESS_ID", "secrets.SPACES_SECRET_KEY"].includes(ref),
  )).toBe(true);
  const doctl = applySteps(workflow).find((step) => String(step.uses ?? "").startsWith("digitalocean/action-doctl@"));
  expect(doctl?.with).toEqual({ no_auth: "true" });
}

function assertStagingOnlyContext(raw) {
  const workflow = parseYaml(raw);
  const context = stepNamed(workflow, STEP.context);
  expect(context.run).toContain("-backend-config=key=doks/staging.tfstate");
  expect(context.run).toContain('kubeconfig="${RUNNER_TEMP}/chase-sets-staging.kubeconfig"');
  expect(context.run).toContain('doctl kubernetes cluster kubeconfig show "$cluster_id" > "$kubeconfig"');
  expect(context.run).toContain('doctl kubernetes cluster kubeconfig show "$cluster_name" > "$kubeconfig"');
  const guard = context.run.indexOf('case "$current_context" in');
  const production = context.run.indexOf("*production*)", guard);
  const staging = context.run.indexOf("*chase-sets-staging*)", guard);
  const fallthrough = context.run.indexOf("*)", staging + "*chase-sets-staging*)".length);
  const exported = context.run.indexOf('echo "KUBECONFIG=${kubeconfig}" >> "$GITHUB_ENV"');
  expect(guard).toBeGreaterThan(0);
  expect(production).toBeGreaterThan(guard);
  expect(staging).toBeGreaterThan(production);
  expect(fallthrough).toBeGreaterThan(staging);
  expect(exported).toBeGreaterThan(fallthrough);
  expect(context.run.slice(production, staging)).toMatch(/\n\s+exit 1\n/);
  expect(context.run.slice(fallthrough, exported)).toMatch(/\n\s+exit 1\n/);

  const steps = applySteps(workflow);
  const contextIndex = stepIndex(workflow, STEP.context);
  for (const step of steps.slice(0, contextIndex)) {
    expect(String(step.run ?? "")).not.toMatch(/\bhelm\b|\bkubectl\b/);
  }
  const probe = stepNamed(workflow, STEP.probe);
  expect(stepIndex(workflow, STEP.probe) + 1).toBe(stepIndex(workflow, STEP.apply));
  expect(probe.if).toBeUndefined();
  expect(probe.run).toContain('if [ -n "${DIGITALOCEAN_ACCESS_TOKEN:-}" ]; then');
  expect(probe.run).toContain('echo "DIGITALOCEAN_ACCESS_TOKEN presence count: ${token_presence_count}"');
  for (const step of steps.filter((candidate) => candidate.run !== undefined)) {
    expect(step.run).not.toMatch(/(?:echo|printf)[^\n]*\$\{?DIGITALOCEAN_ACCESS_TOKEN\}?"?\s*(?:$|[;|>])/m);
    expect(step.run).not.toMatch(/\bset\s+-[a-z]*x/);
  }

  expect(raw).not.toMatch(/environment:\s*["']?production/);
  expect(raw).not.toMatch(/production\.tfstate/);
  expect(raw).not.toMatch(/--environment\s+production/);
  expect(raw).not.toMatch(/chase-sets-production/);
}

function assertRealFullApply(raw) {
  const workflow = parseYaml(raw);
  const apply = stepNamed(workflow, STEP.apply);
  expect(apply.id).toBe("apply");
  expect(apply.if).toBe("inputs.preflight_only == false");
  expect(apply.run).toMatch(/^set -euo pipefail$/m);
  const invocations = [...apply.run.matchAll(/node \.\/scripts\/doks-cluster-addons\.mjs([^|\n]*)/g)];
  expect(invocations.map((match) => match[1].trim())).toEqual(["--environment staging 2>&1"]);
  expect(apply.run).toContain(`${PLANNER} --environment staging 2>&1 | tee "$EVIDENCE_DIR/planner-transcript.log"`);

  for (const step of allSteps(workflow)) {
    expect(step["continue-on-error"], `${step.name ?? step.uses} masks a failure`).toBeUndefined();
    if (step.run === undefined) continue;
    if (step.run.includes("\n")) expect(step.run, `${step.name} is not fail-closed`).toMatch(/^set -euo pipefail$/m);
    if (step.name === STEP.apply) continue;
    expect(step.run, `${step.name} invokes the planner`).not.toContain("doks-cluster-addons.mjs");
    expect(step.run, `${step.name} mutates the cluster`).not.toMatch(MUTATING_COMMAND);
  }
}

function assertBoundedEvidence(raw) {
  const workflow = parseYaml(raw);
  const apply = workflow.jobs[APPLY_JOB];
  expect(apply.env.EVIDENCE_DIR).toBe("${{ github.workspace }}/artifacts/staging-cluster-addons");
  const order = [STEP.before, STEP.probe, STEP.apply, STEP.after, STEP.evidence, STEP.scan, STEP.upload].map(
    (name) => stepIndex(workflow, name),
  );
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(applySteps(workflow)[0].run).toContain('echo "JOB_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_ENV"');

  const before = stepNamed(workflow, STEP.before);
  expect(before.if).toBeUndefined();
  expect(before.run).toContain('helm list -A --all --output json');
  expect(before.run).toContain('> "$EVIDENCE_DIR/helm-releases-before.json"');
  const after = stepNamed(workflow, STEP.after);
  expect(after.if).toBe("always() && (steps.apply.outcome == 'success' || steps.apply.outcome == 'failure')");
  expect(after.run).toContain('helm list -A --all --output json');
  expect(after.run).toContain('> "$EVIDENCE_DIR/helm-releases-after.json"');
  for (const step of [before, after]) {
    expect(step.run).toContain("{name, namespace, chart, app_version, revision, status}");
  }
  expect(stepNamed(workflow, STEP.apply).run).toContain(
    'echo "PLANNER_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_ENV"',
  );

  const evidence = stepNamed(workflow, STEP.evidence);
  expect(evidence.id).toBe("evidence");
  expect(evidence.if).toBe("always()");
  for (const field of [
    "checkedOutSha",
    "preflightOnly",
    "jobStartedAt",
    "plannerStartedAt",
    "endedAt",
    "plannerStep",
    '"apply-staging-cluster-addons"',
    '"preflight-only"',
  ]) {
    expect(evidence.run).toContain(field);
  }
  expect(evidence.run).toContain('> "$EVIDENCE_DIR/staging-cluster-addons-evidence.json"');
  expect(evidence.env).toEqual({ APPLY_OUTCOME: "${{ steps.apply.outcome }}" });

  const scan = stepNamed(workflow, STEP.scan);
  expect(scan.id).toBe("scan");
  expect(scan.if).toBe("always() && steps.evidence.outcome == 'success'");
  expect(scan.env).toEqual({ [TOKEN]: `\${{ secrets.${TOKEN} }}` });
  expect(scan.run).toContain(`grep -rFoh -f <(printf '%s\\n' "$DIGITALOCEAN_ACCESS_TOKEN") -- "$EVIDENCE_DIR"`);
  expect(scan.run).toContain("| wc -l");
  expect(scan.run).toContain('if [ "$token_count" -ne 0 ]; then');
  expect(scan.run).toContain("certificate-authority-data");
  expect(scan.run).not.toMatch(/grep[^\n]*-e\s+"?\$\{?DIGITALOCEAN_ACCESS_TOKEN/);

  const uploads = allSteps(workflow).filter((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"));
  expect(uploads).toHaveLength(1);
  const [upload] = uploads;
  expect(upload.name).toBe(STEP.upload);
  expect(upload.if).toBe("always() && steps.scan.outcome == 'success'");
  expect(upload.with).toMatchObject({
    name: "staging-cluster-addons-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "${{ env.EVIDENCE_DIR }}",
    "if-no-files-found": "error",
  });
  expect(upload.with["retention-days"]).toBeGreaterThan(0);
  expect(raw).not.toMatch(/path:[^\n]*(?:RUNNER_TEMP|runner\.temp|kubeconfig)/i);
}

const assertions = {
  "dispatch boundary": assertDispatchBoundary,
  "step-local secrets": assertStepLocalSecrets,
  "staging-only context": assertStagingOnlyContext,
  "real full apply": assertRealFullApply,
  "bounded evidence": assertBoundedEvidence,
};

describe("Platform Staging Cluster Add-ons workflow contract (#10045)", () => {
  it("is named for the dispatch route the #9951 rollout calls", () => {
    expect(parseYaml(source).name).toBe("Platform Staging Cluster Add-ons");
  });

  it.each(Object.entries(assertions))("holds the %s contract", (_label, assertion) => {
    assertion(source);
  });

  it("threads provider credentials step-locally under the shared credential guards", () => {
    const provider = checkWorkflowProviderCredentials(source, { workflowFile });
    expect(provider.violations).toEqual([]);
    expect(provider.checkedSteps.map((step) => step.name)).toContain(STEP.context);
    expect(checkWorkflowSpacesEvidenceCredentials(source, { workflowFile }).violations).toEqual([]);
  });

  it("is registered with every repository guard that inventories staging mutators", () => {
    expect(releaseQualificationScopeRegistry.workflows["platform-staging-cluster-addons.yml"]).toBe("release");
    expect(stagingRefreshOverlapWorkflowFiles).toContain(workflowFile);
    const workflow = parseYaml(source);
    const expectedGrants = applySteps(workflow).flatMap((step, index) =>
      Object.values(step.env ?? {})
        .map((value) => String(value).match(/^\$\{\{ secrets\.([A-Z_]+) \}\}$/)?.[1])
        .filter(Boolean)
        .map((secretName) => `name:${step.name}#${index + 1}|${secretName}`),
    );
    const grants = JSON.parse(read(authorityFile)).grants;
    expect(grants.every((grant) => grant.file === workflowFile && grant.jobId === APPLY_JOB)).toBe(true);
    expect(grants.map((grant) => `${grant.stepAnchor}|${grant.secretName}`).sort()).toEqual(expectedGrants.sort());
  });

  it("documents the dispatch command beside the planner dry-run", () => {
    const lines = read(runbookFile).split(/\r?\n/);
    const dryRun = lines.indexOf("node scripts/doks-cluster-addons.mjs --environment staging --dry-run");
    expect(dryRun).toBeGreaterThan(0);
    expect(lines[dryRun + 1]).toMatch(
      /^gh workflow run platform-staging-cluster-addons\.yml --ref main -f confirm="apply staging cluster addons" -f release_ref=<main-sha> -f preflight_only=true\b/,
    );
  });

  describe("negative controls", () => {
    const cases = [
      ["dispatch boundary", "a push trigger", (raw) => mutate(raw, (wf) => (wf.on.push = { branches: ["main"] }))],
      ["dispatch boundary", "write permissions", (raw) => mutate(raw, (wf) => (wf.permissions.contents = "write"))],
      [
        "dispatch boundary",
        "a cancelling workflow group",
        (raw) => mutate(raw, (wf) => (wf.concurrency["cancel-in-progress"] = true)),
      ],
      ["dispatch boundary", "no job group", (raw) => mutate(raw, (wf) => delete wf.jobs[APPLY_JOB].concurrency)],
      ["dispatch boundary", "a 90-minute job", (raw) => mutate(raw, (wf) => (wf.jobs[APPLY_JOB]["timeout-minutes"] = 90))],
      ["dispatch boundary", "a production binding", (raw) => mutate(raw, (wf) => (wf.jobs[APPLY_JOB].environment = "production"))],
      ["dispatch boundary", "a second binding", (raw) => mutate(raw, (wf) => (wf.jobs[REFUSE_JOB].environment = "staging"))],
      ["dispatch boundary", "a bypassed refusal", (raw) => mutate(raw, (wf) => delete wf.jobs[APPLY_JOB].needs)],
      ["dispatch boundary", "an always() apply", (raw) => mutate(raw, (wf) => (wf.jobs[APPLY_JOB].if = "always()"))],
      [
        "dispatch boundary",
        "no hex refusal",
        (raw) => replaceOnce(raw, 'if ! [[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]; then', 'if [ -z "$RELEASE_REF" ]; then'),
      ],
      [
        "dispatch boundary",
        "a non-main workflow ref",
        (raw) => replaceOnce(raw, '"$GITHUB_REF" != "refs/heads/main"', '-z "$GITHUB_REF"'),
      ],
      [
        "dispatch boundary",
        "an interpolated release ref",
        (raw) => replaceOnce(raw, '--release-ref "$RELEASE_REF"', '--release-ref "${{ inputs.release_ref }}"'),
      ],
      [
        "dispatch boundary",
        "resolution after the first secret",
        (raw) =>
          mutate(raw, (wf) => {
            const steps = wf.jobs[APPLY_JOB].steps;
            const [resolve] = steps.splice(stepIndex(wf, STEP.resolve), 1);
            steps.splice(stepIndex(wf, STEP.context) + 1, 0, resolve);
          }),
      ],
      ["step-local secrets", "a job-level token", (raw) => mutate(raw, (wf) => (wf.jobs[APPLY_JOB].env[TOKEN] = `\${{ secrets.${TOKEN} }}`))],
      [
        "step-local secrets",
        "a token on the inventory step",
        (raw) => mutate(raw, (wf) => (stepNamed(wf, STEP.before).env = { [TOKEN]: `\${{ secrets.${TOKEN} }}` })),
      ],
      ["step-local secrets", "an authenticating doctl install", (raw) => replaceOnce(raw, 'no_auth: "true"', 'no_auth: "false"')],
      ["staging-only context", "no context guard", (raw) => replaceOnce(raw, "*chase-sets-staging*)", "*)")],
      ["staging-only context", "a production state key", (raw) => replaceOnce(raw, "key=doks/staging.tfstate", "key=doks/production.tfstate")],
      [
        "staging-only context",
        "a probe away from the planner",
        (raw) =>
          mutate(raw, (wf) => {
            const steps = wf.jobs[APPLY_JOB].steps;
            const [probe] = steps.splice(stepIndex(wf, STEP.probe), 1);
            steps.splice(stepIndex(wf, STEP.before), 0, probe);
          }),
      ],
      [
        "staging-only context",
        "a printed token",
        (raw) =>
          replaceOnce(
            raw,
            'echo "DIGITALOCEAN_ACCESS_TOKEN presence count: ${token_presence_count}"',
            'echo "DIGITALOCEAN_ACCESS_TOKEN presence count: ${token_presence_count}"\n          echo "$DIGITALOCEAN_ACCESS_TOKEN"',
          ),
      ],
      ["real full apply", "a dry-run apply", (raw) => replaceOnce(raw, `${PLANNER} --environment staging 2>&1`, `${PLANNER} --environment staging --dry-run 2>&1`)],
      ["real full apply", "an apply in preflight runs", (raw) => mutate(raw, (wf) => delete stepNamed(wf, STEP.apply).if)],
      [
        "real full apply",
        "a mutation outside the planner",
        (raw) =>
          mutate(raw, (wf) => {
            const before = stepNamed(wf, STEP.before);
            before.run = `${before.run}helm upgrade --install extra ./chart\n`;
          }),
      ],
      ["real full apply", "a masked failure", (raw) => mutate(raw, (wf) => (stepNamed(wf, STEP.apply)["continue-on-error"] = true))],
      ["bounded evidence", "an ungated upload", (raw) => replaceOnce(raw, "if: always() && steps.scan.outcome == 'success'", "if: always()")],
      [
        "bounded evidence",
        "a token in grep argv",
        (raw) =>
          replaceOnce(raw, `-f <(printf '%s\\n' "$DIGITALOCEAN_ACCESS_TOKEN")`, '-e "$DIGITALOCEAN_ACCESS_TOKEN"'),
      ],
      ["bounded evidence", "a lenient upload", (raw) => replaceOnce(raw, "if-no-files-found: error", "if-no-files-found: warn")],
      ["bounded evidence", "no after inventory", (raw) => replaceOnce(raw, '> "$EVIDENCE_DIR/helm-releases-after.json"', "> /dev/null")],
    ];

    it.each(cases)("%s rejects %s", (label, _description, change) => {
      const mutated = change(source);
      expect(mutated).not.toBe(source);
      expect(() => assertions[label](mutated)).toThrow();
    });
  });
});
