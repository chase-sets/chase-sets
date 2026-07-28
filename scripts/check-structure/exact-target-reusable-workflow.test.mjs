import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { repoRoot } from "../lib/repo.mjs";

const workflowsRoot = path.join(repoRoot, ".github", "workflows");

function workflowDocuments() {
  return readdirSync(workflowsRoot)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => {
      const relativePath = `.github/workflows/${file}`;
      const text = readFileSync(path.join(repoRoot, relativePath), "utf8");
      return { relativePath, text, workflow: parseYaml(text) };
    });
}

function exactTargetInput(trigger, name) {
  return trigger?.inputs?.[name];
}

function isExactTargetReceiver({ workflow }) {
  const called = workflow.on?.workflow_call;
  const dispatched = workflow.on?.workflow_dispatch;
  return [called, dispatched].every(
    (trigger) =>
      exactTargetInput(trigger, "target_sha")?.required === true &&
      exactTargetInput(trigger, "target_sha")?.type === "string" &&
      exactTargetInput(trigger, "expected_base_sha")?.required === true &&
      exactTargetInput(trigger, "expected_base_sha")?.type === "string",
  );
}

const documents = workflowDocuments();
const receivers = documents.filter(isExactTargetReceiver);
const receiver = receivers[0];
const receiverJobs = Object.entries(receiver?.workflow.jobs ?? {});
const receiverJobEntry = receiverJobs.find(([, job]) =>
  job.steps?.some(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@") &&
      step.with?.ref === "${{ inputs.target_sha }}",
  ),
);
const receiverJob = receiverJobEntry?.[1];
const receiverSteps = receiverJob?.steps ?? [];

function findStepByShape(predicate) {
  const step = receiverSteps.find(predicate);
  if (!step) throw new Error("Expected exact-target workflow step was not found by code shape.");
  return step;
}

function callersOf(receiverPath) {
  const expectedUse = `./${receiverPath}`;
  return documents.flatMap(({ relativePath, workflow }) =>
    Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => job.uses === expectedUse)
      .map(([jobId, job]) => ({ relativePath, workflow, jobId, job })),
  );
}

function stepDigest(step) {
  return createHash("sha256").update(JSON.stringify(step)).digest("hex");
}

function normalizeMovedStep(step) {
  const normalized = structuredClone(step);
  if (typeof normalized.uses === "string" && normalized.uses.startsWith("actions/checkout@")) {
    delete normalized.with;
  }
  if (
    normalized.env?.SMOKE_REQUIRE_ADMIN === "true" &&
    normalized.env?.SMOKE_REQUIRE_LANDING === "true" &&
    normalized.env?.SMOKE_REQUIRE_MARKETPLACE === "true"
  ) {
    normalized.env.SMOKE_WAITLIST_EMAIL = "ops+compose-smoke-pr-${{ github.event.pull_request.number }}@chasesets.test";
    normalized.env.SMOKE_UTM_CAMPAIGN = "pr-${{ github.event.pull_request.number }}";
  }
  return normalized;
}

// SHA-256 of each parsed step object at origin/main
// 0d1efeefc0b007e0465b4f05dd484bd0a6673634 before extraction. Storing
// digests instead of a second runnable copy makes body drift executable while
// retaining one implementation.
const movedStepDigests = [
  "821e2707372b2e0955fb3114f3211c3251da71e5e6690af5a4704d32b9126385",
  "8cb009aa651f1c171e7b62b299b14eddbb54ca04d50b2da369ec8a9330133297",
  "61efddf3e27bb67abd7d4ffcaec081beb94427d67b87fcddf5783ff8324a740d",
  "d60a543648e19b29291831b72b2b8f4bc5767e27fcb192199d551414a8041560",
  "b33578b86942ee651be4ea3fe99debf3bf3b77bf37fc69c936d27e7f11a3c7c1",
  "b070316712e6c36b39175f064f7c78f4b6b2f0a3c9ac15d088919808b227ec9d",
  "b70b5c91979e7a2a0cf20418b9e3a9dd50225d6ba8236bbb52a8e8ff037c70b5",
  "73efa45c685443c83de6bca09f427903ac6374f9ddfe246a873de7125a01c505",
  "0141c9c994f2e39419b6b7bf3bbc1c71cfd05c5d9ff32f37cd5743c1627eefa1",
  "dc80318c9b536c02e27b99f37c275864b2c0cb0bcd707b78a9894a463dcfd87c",
  "5cfc82190b29e121d924a068d1ba120b8fa86e3c1a75c9c798730af11a47efef",
  "75dbc499e3b45ced66e36556586825fcecb53409fa651699fa0cc72882fe9f84",
  "f87870a4987de87b2131cea0b256c347dffc8d53cb4895612413138e8ae54483",
];

function bashExecutable() {
  if (process.platform !== "win32") return "bash";
  const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  return path.resolve(gitExecPath, "../../../bin/bash.exe");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "exact-target-workflow-"));
const fixtureOrigin = path.join(fixtureRoot, "origin");
let baseSha;
let targetSha;
let unrelatedSha;
let provenanceScript;

beforeAll(() => {
  mkdirSync(fixtureOrigin);
  git(fixtureOrigin, "init", "--initial-branch=main");
  git(fixtureOrigin, "config", "user.email", "exact-target-control@chasesets.test");
  git(fixtureOrigin, "config", "user.name", "Exact Target Control");
  git(fixtureOrigin, "config", "core.autocrlf", "false");

  writeFileSync(path.join(fixtureOrigin, "proof.txt"), "base\n");
  git(fixtureOrigin, "add", "proof.txt");
  git(fixtureOrigin, "commit", "-m", "base");
  baseSha = git(fixtureOrigin, "rev-parse", "HEAD");

  writeFileSync(path.join(fixtureOrigin, "proof.txt"), "target\n");
  git(fixtureOrigin, "add", "proof.txt");
  git(fixtureOrigin, "commit", "-m", "target");
  targetSha = git(fixtureOrigin, "rev-parse", "HEAD");

  git(fixtureOrigin, "switch", "--orphan=unrelated");
  writeFileSync(path.join(fixtureOrigin, "unrelated.txt"), "unrelated\n");
  git(fixtureOrigin, "add", "unrelated.txt");
  git(fixtureOrigin, "commit", "-m", "unrelated");
  unrelatedSha = git(fixtureOrigin, "rev-parse", "HEAD");

  provenanceScript = findStepByShape(
    (step) =>
      step.env?.TARGET_SHA === "${{ inputs.target_sha }}" &&
      step.env?.EXPECTED_BASE_SHA === "${{ inputs.expected_base_sha }}",
  ).run;
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function runProvenance({ target = targetSha, base = baseSha } = {}) {
  const workdir = path.join(fixtureRoot, `run-${randomUUID()}`);
  mkdirSync(workdir);
  const result = spawnSync(bashExecutable(), ["-euo", "pipefail", "-c", provenanceScript], {
    cwd: workdir,
    encoding: "utf8",
    env: {
      ...process.env,
      TARGET_SHA: target,
      EXPECTED_BASE_SHA: base,
      REPOSITORY_URL: pathToFileURL(fixtureOrigin).href,
      TRIGGER_EVENT: "workflow_dispatch",
      TRIGGER_REF: "refs/heads/main",
      TRIGGER_SHA: "1".repeat(40),
      GITHUB_STEP_SUMMARY: "summary.md",
    },
  });
  return {
    ...result,
    output: `${result.stdout}${result.stderr}`,
    summary: result.status === 0 ? readFileSync(path.join(workdir, "summary.md"), "utf8") : "",
  };
}

describe("exact-target provenance assertions execute from the real workflow block", () => {
  it("accepts two existing immutable commits only when the expected base is an ancestor", () => {
    const result = runProvenance();
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("Invalid Compose target provenance");
    expect(result.summary).toContain(`| target_sha | \`${targetSha}\` |`);
    expect(result.summary).toContain(`| expected_base_sha | \`${baseSha}\` |`);
    expect(result.summary).toContain("The trigger ref and `github.sha` are attribution only");
  });

  it.each([
    ["missing target_sha", { target: "" }, "target_sha is required and cannot be empty."],
    ["malformed target_sha", { target: "A".repeat(40) }, "target_sha must be a lowercase 40-character"],
    ["missing expected_base_sha", { base: "" }, "expected_base_sha is required and cannot be empty."],
    [
      "malformed expected_base_sha",
      { base: "not-an-immutable-commit" },
      "expected_base_sha must be a lowercase 40-character",
    ],
    ["nonexistent target_sha object", { target: "e".repeat(40) }, "target_sha object does not exist in the repository"],
    [
      "nonexistent expected_base_sha object",
      { base: "d".repeat(40) },
      "expected_base_sha object does not exist in the repository",
    ],
    [
      "non-ancestor expected_base_sha",
      { base: () => unrelatedSha },
      "expected_base_sha is not an ancestor of target_sha",
    ],
  ])("negative control: %s reaches its named refusal", (_name, inputs, expectedError) => {
    const resolvedInputs = Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [name, typeof value === "function" ? value() : value]),
    );
    const result = runProvenance(resolvedInputs);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(expectedError);
  });
});

describe("exact-target extraction and trigger/caller structure", () => {
  it("discovers exactly one receiver by input and checkout shape across the complete workflow surface", () => {
    const totalJobs = documents.reduce(
      (total, document) => total + Object.keys(document.workflow.jobs ?? {}).length,
      0,
    );
    const implementationJobs = documents.flatMap(({ relativePath, workflow }) =>
      Object.entries(workflow.jobs ?? {})
        .map(([jobId, job]) => {
          const digests = (job.steps ?? []).map((step) => stepDigest(normalizeMovedStep(step)));
          return {
            relativePath,
            jobId,
            matched: movedStepDigests.filter((digest) => digests.includes(digest)).length,
          };
        })
        .filter(({ matched }) => matched === movedStepDigests.length),
    );

    console.info(
      `exact-target workflow surface: scanned=${totalJobs}/total=${totalJobs}; receivers=${receivers.length}; implementations=${implementationJobs.length}`,
    );
    expect(receivers).toHaveLength(1);
    expect(receiverJobEntry).toBeDefined();
    expect(implementationJobs).toEqual([
      {
        relativePath: receiver.relativePath,
        jobId: receiverJobEntry[0],
        matched: movedStepDigests.length,
      },
    ]);
  });

  it("keeps every moved step body equal to the pinned base except the two run-attribution values", () => {
    const actualDigests = receiverSteps.map((step) => stepDigest(normalizeMovedStep(step)));
    for (const digest of movedStepDigests) {
      expect(
        actualDigests.filter((actual) => actual === digest),
        digest,
      ).toHaveLength(1);
    }
    expect(receiverSteps).toHaveLength(movedStepDigests.length + 3);
  });

  it("negative control: provenance validates before the sole checkout, which can materialize only target_sha", () => {
    const provenance = findStepByShape(
      (step) =>
        step.env?.TARGET_SHA === "${{ inputs.target_sha }}" &&
        step.run?.includes('git cat-file -e "${TARGET_SHA}^{commit}"') &&
        step.run?.includes('git cat-file -e "${EXPECTED_BASE_SHA}^{commit}"') &&
        step.run?.includes('git merge-base --is-ancestor "$EXPECTED_BASE_SHA" "$TARGET_SHA"'),
    );
    const checkouts = receiverSteps.filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );

    expect(checkouts).toHaveLength(1);
    expect(receiverSteps.indexOf(provenance)).toBeLessThan(receiverSteps.indexOf(checkouts[0]));
    expect(checkouts[0].with).toEqual({
      ref: "${{ inputs.target_sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(receiver.text).not.toContain("inputs.target_sha ||");
    expect(receiver.text).not.toContain("inputs.expected_base_sha ||");
  });

  it("has the complete trigger/caller matrix with one scoped PR caller and no merge-group widening", () => {
    const callers = callersOf(receiver.relativePath);
    expect(callers).toHaveLength(1);
    const [{ workflow, jobId, job }] = callers;
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(true);
    expect(Object.hasOwn(workflow.on, "merge_group")).toBe(true);
    expect(jobId).toBe("compose-preview-smoke");
    expect(job.if).toBe(
      "always() && github.event_name == 'pull_request' && needs['change-scope'].result == 'success' && needs['change-scope'].outputs.compose_smoke == 'true' && !contains(github.event.pull_request.labels.*.name, 'preview') && (needs['change-scope'].outputs.local_checks != 'true' || needs.static.result == 'success') && needs.typecheck.result == 'success' && (needs['change-scope'].outputs.unit_tests != 'true' || needs['unit-tests'].result == 'success')\n",
    );
    expect(job.needs).toEqual(["change-scope", "static", "typecheck", "unit-tests"]);
    expect(job.with).toEqual({
      target_sha: "${{ github.sha }}",
      expected_base_sha: "${{ github.event.pull_request.base.sha }}",
    });
    expect(receiver.workflow.on.workflow_call.inputs.drill).toEqual({
      description: "Terminal-path drill. Callers use none.",
      required: false,
      default: "none",
      type: "string",
    });
    expect(receiver.workflow.on.workflow_dispatch.inputs.drill).toEqual({
      description: "Terminal-path drill for post-merge cancellation evidence.",
      required: false,
      default: "none",
      type: "choice",
      options: ["none", "await-cancellation"],
    });

    const matrix = [
      {
        entry: "pull_request",
        runs: "only when the unchanged caller if-expression is true",
        tree: "github.sha",
        terminalRecord: "caller result + reusable job/run conclusion + exact-target summary",
      },
      {
        entry: "merge_group",
        runs: "no (unchanged caller if-expression rejects it)",
        tree: "none",
        terminalRecord: "skipped caller job",
      },
      {
        entry: "workflow_call",
        runs: "yes, with both required immutable inputs",
        tree: "inputs.target_sha",
        terminalRecord: "reusable job/run conclusion + exact-target summary",
      },
      {
        entry: "workflow_dispatch",
        runs: "yes, with both required immutable inputs",
        tree: "inputs.target_sha",
        terminalRecord: "reusable job/run conclusion + exact-target summary",
      },
    ];
    console.info(`exact-target trigger matrix: ${JSON.stringify(matrix)}`);
    expect(matrix.map(({ entry }) => entry)).toEqual([
      "pull_request",
      "merge_group",
      "workflow_call",
      "workflow_dispatch",
    ]);
  });
});

describe("exact-target terminal behavior and isolation", () => {
  it("prepares every derived env/log diagnostic before image build and keeps diagnostics plus teardown reachable", () => {
    const prepare = findStepByShape(
      (step) => typeof step.run === "string" && step.run.includes("mkdir -p artifacts/compose-smoke/env"),
    );
    const render = findStepByShape(
      (step) => typeof step.run === "string" && step.run.includes("render-env-all --out-dir"),
    );
    const build = findStepByShape((step) => typeof step.run === "string" && step.run.includes("docker buildx build"));
    const serviceStatus = findStepByShape(
      (step) => step.if === "always()" && typeof step.run === "string" && step.run.endsWith(" ps"),
    );
    const teardown = findStepByShape(
      (step) =>
        step.if === "always()" && typeof step.run === "string" && step.run.includes("down --volumes --remove-orphans"),
    );

    const stack = readFileSync(path.join(repoRoot, "docker-compose.pr-smoke.yml"), "utf8");
    const envFiles = [...stack.matchAll(/env_file: [^\n]*\/([a-z-]+\.env)/gu)].map((match) => match[1]);
    expect(envFiles.length).toBeGreaterThan(0);
    for (const envFile of envFiles) {
      expect(prepare.run).toContain(`artifacts/compose-smoke/env/${envFile}`);
    }

    const ingress = findStepByShape(
      (step) => typeof step.run === "string" && step.run.includes("nohup node") && step.run.includes("2>&1 &"),
    );
    const ingressLogs = [...ingress.run.matchAll(/> (artifacts\/[^ ]+\.log) 2>&1/gu)].map((match) => match[1]);
    expect(ingressLogs).toHaveLength(3);
    for (const log of ingressLogs) {
      expect(prepare.run).toContain(log);
    }

    const order = [prepare, render, build].map((step) => receiverSteps.indexOf(step));
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(serviceStatus.if).toBe("always()");
    expect(teardown.if).toBe("always()");
    expect(receiverJob["timeout-minutes"]).toBe(30);
  });

  it("negative control: the cancellation drill arms only after boot and before always-run diagnostics and teardown", () => {
    const boot = findStepByShape(
      (step) => typeof step.run === "string" && step.run.includes("up --detach --wait --wait-timeout"),
    );
    const cancellation = findStepByShape((step) => step.if === "inputs.drill == 'await-cancellation'");
    const serviceStatus = findStepByShape(
      (step) => step.if === "always()" && typeof step.run === "string" && step.run.endsWith(" ps"),
    );
    const teardown = findStepByShape(
      (step) =>
        step.if === "always()" && typeof step.run === "string" && step.run.includes("down --volumes --remove-orphans"),
    );
    const order = [boot, cancellation, serviceStatus, teardown].map((step) => receiverSteps.indexOf(step));

    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(cancellation.run).toContain("force-cancel this run now");
    expect(cancellation.run).toContain("sleep 5");
  });

  it("negative control: a known-bad image build remains an enforcing red caller and rollup result", () => {
    const callers = callersOf(receiver.relativePath);
    const caller = callers[0].job;
    const imageBuild = findStepByShape(
      (step) => typeof step.run === "string" && step.run.includes("docker buildx build"),
    );
    const toleratedSteps = receiverSteps.filter((step) => step["continue-on-error"] === true);
    const rollup = callers[0].workflow.jobs["pr-required"];
    const rollupScript = rollup.steps.find((step) => step.name === "Verify required jobs")?.run;

    expect(receiverJob["continue-on-error"]).toBeUndefined();
    expect(caller["continue-on-error"]).toBeUndefined();
    expect(imageBuild["continue-on-error"]).toBeUndefined();
    expect(toleratedSteps).toHaveLength(1);
    expect(toleratedSteps[0].id).toBe("buildx");
    expect(rollup.needs).toContain("compose-preview-smoke");
    expect(rollupScript).toContain(`compose_result="\${{ needs['compose-preview-smoke'].result }}"`);
    expect(rollupScript).toContain(`if [ "$compose_required" = "true" ] && [ "$compose_result" != "success" ]; then`);
  });

  it("is credential-free and has no environment, provider, cluster, or inherited-secret surface", () => {
    expect(receiver.text).not.toContain("secrets.");
    expect(receiver.text).not.toContain("secrets: inherit");
    expect(receiver.text).not.toMatch(/^\s+environment:/mu);
    expect(receiver.text).not.toMatch(/\b(?:doctl|kubectl|terraform)\b/u);
    expect(receiver.workflow.permissions).toEqual({ contents: "read" });
    expect(callersOf(receiver.relativePath)[0].job.secrets).toBeUndefined();
  });

  it("records both immutable inputs and all trigger attribution in the job name and summary", () => {
    for (const expression of [
      "${{ inputs.target_sha }}",
      "${{ inputs.expected_base_sha }}",
      "${{ github.event_name }}",
      "${{ github.ref }}",
      "${{ github.sha }}",
    ]) {
      expect(receiverJob.name).toContain(expression);
    }
    const provenance = findStepByShape((step) => step.env?.TARGET_SHA === "${{ inputs.target_sha }}");
    for (const field of ["target_sha", "expected_base_sha", "github.event_name", "github.ref", "github.sha"]) {
      expect(provenance.run).toContain(`| ${field} |`);
    }
    expect(provenance.run).toContain("they are not silently substituted for the tree under test");
  });
});
