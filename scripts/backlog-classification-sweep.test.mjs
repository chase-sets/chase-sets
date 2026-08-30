import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLabelNames, ENABLED_NATIVE_ISSUE_TYPES } from "./label-registry.mjs";
import {
  admitExpectedPrefix,
  applyClassificationPlan,
  assertPlanExecutionIdentity,
  AUTHORIZED_MILESTONE_NUMBER,
  AUTHORIZED_MILESTONE_TITLE,
  BacklogClassificationSweepError,
  bodySha256,
  buildClassificationPlan,
  canonicalJson,
  collectCompleteSweepAuthority,
  createJournalRecord,
  digestCanonical,
  extractReviewedDecisionAuthority,
  governedFingerprint,
  invokeCanonicalReviewReducer,
  journalRecordSha,
  main,
  PLAN_PATH,
  reconcileIssueIdentities,
  renderClassificationPlanningRoadmap,
  renderJournalComment,
  ROADMAP_PATH,
  serializePlan,
  sha256Utf8,
  validateClassificationPlan,
  validateJournalPrefix,
  verifyClassificationPlan,
} from "./backlog-classification-sweep.mjs";

const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const BRANCH = "codex/issue-7536-plan-review-20260830000000-aaaaaaaaaaaa-bbbbbbbb";
const CAPTURED_AT = "2026-08-30T00:00:00.000Z";
const DECISION_UPDATED_AT = "2026-08-29T23:00:00Z";
const TARGET_BODY = "### Context\nA synthetic target body with no inferred classification.\n";
const SYNTHETIC_ROOT = 9_000_000;
const SYNTHETIC_TARGET = 9_000_001;
const SYNTHETIC_TRACKING = 9_000_002;
const SYNTHETIC_EXTRA = 9_000_003;
const SYNTHETIC_MILESTONE = 9_000_000;
const SYNTHETIC_TITLE = "Wave 9000000 — Synthetic classification fixture";

function classificationLabels() {
  return ["priority", "area", "kind"]
    .flatMap((family) => canonicalLabelNames(family))
    .sort()
    .map((name, index) => ({ id: `LABEL_${String(index).padStart(3, "0")}`, name }));
}

function typeRegistry() {
  return ENABLED_NATIVE_ISSUE_TYPES.map((name, index) => ({
    nodeId: `TYPE_${String(index).padStart(2, "0")}`,
    name,
    isEnabled: true,
  }));
}

function decisionBody(entryOverrides = {}, entriesOverride = null, milestoneNumber = SYNTHETIC_MILESTONE) {
  const entry = {
    number: SYNTHETIC_TARGET,
    nodeId: "SYNTHETIC_ISSUE_TARGET",
    updatedAt: DECISION_UPDATED_AT,
    bodySha256: bodySha256(TARGET_BODY),
    addLabels: [],
    setType: "Bug",
    ...entryOverrides,
  };
  const decision = {
    schemaVersion: "issue-7536-classification-decisions/v1",
    repository: "chase-sets/chase-sets",
    milestoneNumber,
    entries: entriesOverride ?? [entry],
  };
  return `### Context\nSynthetic fixture; every fact is explicitly synthetic.\n\n\`\`\`json\n${JSON.stringify(decision, null, 2)}\n\`\`\`\n`;
}

function graphIssue({
  number,
  nodeId,
  issueType,
  labels,
  tracking = false,
  milestoneNumber = SYNTHETIC_MILESTONE,
  milestoneTitle = SYNTHETIC_TITLE,
}) {
  const effectiveLabels = tracking ? [...labels, { id: "LABEL_TRACKING", name: "status:tracking-only" }] : labels;
  return {
    id: nodeId,
    number,
    state: "OPEN",
    issueType,
    milestone: { id: "SYNTHETIC_MILESTONE", number: milestoneNumber, title: milestoneTitle, state: "OPEN" },
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
    labels: { totalCount: effectiveLabels.length, nodes: effectiveLabels },
    blockedBy: { totalCount: 0, nodes: [] },
  };
}

function stableIssue({
  number,
  nodeId,
  body,
  updatedAt,
  issueType,
  labels,
  milestoneNumber = SYNTHETIC_MILESTONE,
  milestoneTitle = SYNTHETIC_TITLE,
}) {
  return {
    complete: true,
    issue: {
      nodeId,
      number,
      state: "open",
      updatedAt,
      body,
      issueType,
      milestone: { number: milestoneNumber, title: milestoneTitle, state: "open" },
    },
    graph: {
      repositoryDatabaseId: 1,
      nodeId,
      number,
      state: "open",
      updatedAt,
      issueType,
      hasParent: false,
      parentNumber: null,
      labelsTotal: labels.length,
    },
    labels: labels.map((label) => ({ nodeId: label.id, name: label.name })),
  };
}

function fixture({
  after = false,
  decisionOverrides = {},
  permission = "ADMIN",
  extraGap = false,
  milestoneNumber = SYNTHETIC_MILESTONE,
  milestoneTitle = SYNTHETIC_TITLE,
} = {}) {
  const labels = classificationLabels();
  const byName = new Map(labels.map((label) => [label.name, label]));
  const types = typeRegistry();
  const byType = new Map(types.map((type) => [type.name, type]));
  const classifiedLabels = [byName.get("priority:p2"), byName.get("area:ops"), byName.get("kind:ops")];
  const targetType = after ? byType.get("Bug") : null;
  const issues = [
    graphIssue({
      number: SYNTHETIC_ROOT,
      nodeId: "SYNTHETIC_ISSUE_ROOT",
      issueType: byType.get("Slice"),
      labels: classifiedLabels,
      milestoneNumber,
      milestoneTitle,
    }),
    graphIssue({
      number: SYNTHETIC_TARGET,
      nodeId: "SYNTHETIC_ISSUE_TARGET",
      issueType: targetType,
      labels: classifiedLabels,
      milestoneNumber,
      milestoneTitle,
    }),
    graphIssue({
      number: SYNTHETIC_TRACKING,
      nodeId: "SYNTHETIC_ISSUE_TRACKING",
      issueType: byType.get("Slice"),
      labels: classifiedLabels,
      tracking: true,
      milestoneNumber,
      milestoneTitle,
    }),
  ];
  if (extraGap)
    issues.push(
      graphIssue({
        number: SYNTHETIC_EXTRA,
        nodeId: "SYNTHETIC_ISSUE_EXTRA",
        issueType: null,
        labels: classifiedLabels,
        milestoneNumber,
        milestoneTitle,
      }),
    );
  const windowAuthority = {
    version: "roadmap-dispatch-window-authority/v1",
    milestones: {
      totalCount: 1,
      nodes: [{ id: "SYNTHETIC_MILESTONE", number: milestoneNumber, title: milestoneTitle, state: "OPEN" }],
    },
    issues: { totalCount: issues.length, nodes: issues },
  };
  const rootBody = decisionBody(decisionOverrides, null, milestoneNumber);
  const issueAuthorities = [
    stableIssue({
      number: SYNTHETIC_ROOT,
      nodeId: "SYNTHETIC_ISSUE_ROOT",
      body: rootBody,
      updatedAt: "2026-08-30T07:16:27Z",
      issueType: byType.get("Slice"),
      labels: classifiedLabels,
      milestoneNumber,
      milestoneTitle,
    }),
    stableIssue({
      number: SYNTHETIC_TARGET,
      nodeId: "SYNTHETIC_ISSUE_TARGET",
      body: TARGET_BODY,
      updatedAt: after ? "2026-08-30T01:00:00Z" : DECISION_UPDATED_AT,
      issueType: targetType,
      labels: classifiedLabels,
      milestoneNumber,
      milestoneTitle,
    }),
  ];
  const window = {
    authority: windowAuthority,
    digest: digestCanonical(windowAuthority),
    restIssueNumbers: issues.map((issue) => issue.number),
    restPages: 2,
  };
  return {
    repository: "chase-sets/chase-sets",
    window,
    labelRegistry: labels,
    typeRegistry: types,
    permission: {
      repository: "chase-sets/chase-sets",
      viewerLogin: "synthetic-operator",
      viewerPermission: permission,
    },
    issueAuthorities,
    compositeDigest: digestCanonical({ window, issueAuthorities }),
  };
}

function buildPlan(options = {}) {
  const authority = fixture(options);
  const roadmapBytes = renderClassificationPlanningRoadmap(authority.window.authority);
  return buildClassificationPlan({
    authority,
    issueNumber: SYNTHETIC_ROOT,
    milestoneNumber: options.milestoneNumber ?? SYNTHETIC_MILESTONE,
    landedMainSha: options.landedMainSha ?? MAIN,
    planBranch: options.planBranch ?? BRANCH,
    capturedAt: CAPTURED_AT,
    roadmapBytes,
  });
}

function buildLabelPlan({ after = false } = {}) {
  const authority = fixture();
  const kind = authority.labelRegistry.find((label) => label.name === "kind:ops");
  const sliceType = authority.typeRegistry.find((type) => type.name === "Slice");
  const target = authority.window.authority.issues.nodes.find((issue) => issue.number === SYNTHETIC_TARGET);
  target.issueType = sliceType;
  if (!after) {
    target.labels.nodes = target.labels.nodes.filter((label) => label.id !== kind.id);
    target.labels.totalCount = target.labels.nodes.length;
  }
  const stable = authority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_TARGET);
  stable.issue.issueType = sliceType;
  stable.graph.issueType = sliceType;
  stable.labels = target.labels.nodes.map((label) => ({ nodeId: label.id, name: label.name }));
  stable.graph.labelsTotal = stable.labels.length;
  if (after) stable.issue.updatedAt = stable.graph.updatedAt = "2026-08-30T01:00:00Z";
  authority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_ROOT).issue.body = decisionBody({
    addLabels: ["kind:ops"],
    setType: null,
  });
  authority.window.digest = digestCanonical(authority.window.authority);
  const roadmapBytes = renderClassificationPlanningRoadmap(authority.window.authority);
  return buildClassificationPlan({
    authority,
    issueNumber: SYNTHETIC_ROOT,
    milestoneNumber: SYNTHETIC_MILESTONE,
    landedMainSha: MAIN,
    planBranch: BRANCH,
    capturedAt: CAPTURED_AT,
    roadmapBytes,
  });
}

function clone(value) {
  return structuredClone(value);
}

function expectCode(action, code) {
  let thrown = null;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BacklogClassificationSweepError);
  expect(thrown.code).toBe(code);
}

async function expectAsyncCode(action, code) {
  let thrown = null;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BacklogClassificationSweepError);
  expect(thrown.code).toBe(code);
}

// F3 production-guard harness: a bounded real temp git repo plus an injected in-memory
// GitHub client and reducer, so admission tests reach assertPlanExecutionIdentity /
// admitExpectedPrefix directly instead of a synthetic stand-in for them.
function gitExec(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createGitOriginFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-7536-admission-"));
  const originDir = path.join(root, "origin.git");
  const workDir = path.join(root, "work");
  gitExec(root, ["init", "--bare", "-q", originDir]);
  gitExec(root, ["init", "-q", workDir]);
  gitExec(workDir, ["config", "user.email", "sweep-fixture@example.invalid"]);
  gitExec(workDir, ["config", "user.name", "Sweep Fixture"]);
  gitExec(workDir, ["config", "commit.gpgsign", "false"]);
  gitExec(workDir, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(workDir, "README.md"), "placeholder\n", "utf8");
  gitExec(workDir, ["add", "README.md"]);
  gitExec(workDir, ["commit", "-q", "-m", "init"]);
  gitExec(workDir, ["branch", "-M", "main"]);
  gitExec(workDir, ["remote", "add", "origin", originDir]);
  gitExec(workDir, ["push", "-q", "origin", "main"]);
  const mainSha = gitExec(workDir, ["rev-parse", "main"]);
  return { root, workDir, mainSha };
}

async function commitPlanOnBranch({ workDir, plan, roadmapBytes }) {
  const branch = plan.implementation.planBranch;
  gitExec(workDir, ["switch", "-q", "-c", branch, "main"]);
  await mkdir(path.join(workDir, "planning-artifacts", "issue-7536"), { recursive: true });
  await writeFile(path.join(workDir, PLAN_PATH), serializePlan(plan), "utf8");
  await writeFile(path.join(workDir, ROADMAP_PATH), roadmapBytes, "utf8");
  gitExec(workDir, ["add", "--", PLAN_PATH, ROADMAP_PATH]);
  gitExec(workDir, ["commit", "-q", "-m", "plan"]);
  gitExec(workDir, ["push", "-q", "-u", "origin", branch]);
  return gitExec(workDir, ["rev-parse", "HEAD"]);
}

function planBranchName(mainSha, nonce = "aaaaaaaa") {
  return `codex/issue-7536-plan-review-20260830000000-${mainSha.slice(0, 12)}-${nonce}`;
}

async function createProdApplyFixture(options = {}) {
  const git = await createGitOriginFixture();
  const planBranch = planBranchName(git.mainSha);
  const beforeAuthority = fixture(options);
  const afterAuthorityValue = fixture({ ...options, after: true });
  const roadmapBytes = renderClassificationPlanningRoadmap(beforeAuthority.window.authority);
  let plan = buildClassificationPlan({
    authority: beforeAuthority,
    issueNumber: SYNTHETIC_ROOT,
    milestoneNumber: options.milestoneNumber ?? SYNTHETIC_MILESTONE,
    landedMainSha: git.mainSha,
    planBranch,
    capturedAt: CAPTURED_AT,
    roadmapBytes,
  });
  if (options.tamperPlan) plan = options.tamperPlan(plan);
  const headSha = await commitPlanOnBranch({ workDir: git.workDir, plan, roadmapBytes });
  return { ...git, planBranch, headSha, plan, beforeAuthority, afterAuthorityValue, roadmapBytes };
}

function recomputePlanDigest(plan) {
  plan.planDigest = digestCanonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planDigest")));
  return plan;
}

// A label-decision variant of createProdApplyFixture: the target gap is an add-labels step
// (missing kind:ops) rather than a set-type step, for F2's label-substitution controls.
async function createProdLabelApplyFixture({ tamperPlan } = {}) {
  const git = await createGitOriginFixture();
  const planBranch = planBranchName(git.mainSha);
  const beforeAuthority = fixture();
  const kind = beforeAuthority.labelRegistry.find((label) => label.name === "kind:ops");
  const sliceType = beforeAuthority.typeRegistry.find((type) => type.name === "Slice");
  const targetIssue = beforeAuthority.window.authority.issues.nodes.find((issue) => issue.number === SYNTHETIC_TARGET);
  targetIssue.issueType = sliceType;
  targetIssue.labels.nodes = targetIssue.labels.nodes.filter((label) => label.id !== kind.id);
  targetIssue.labels.totalCount = targetIssue.labels.nodes.length;
  const stable = beforeAuthority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_TARGET);
  stable.issue.issueType = sliceType;
  stable.graph.issueType = sliceType;
  stable.labels = targetIssue.labels.nodes.map((label) => ({ nodeId: label.id, name: label.name }));
  stable.graph.labelsTotal = stable.labels.length;
  beforeAuthority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_ROOT).issue.body = decisionBody({
    addLabels: ["kind:ops"],
    setType: null,
  });
  beforeAuthority.window.digest = digestCanonical(beforeAuthority.window.authority);
  const roadmapBytes = renderClassificationPlanningRoadmap(beforeAuthority.window.authority);
  let plan = buildClassificationPlan({
    authority: beforeAuthority,
    issueNumber: SYNTHETIC_ROOT,
    milestoneNumber: SYNTHETIC_MILESTONE,
    landedMainSha: git.mainSha,
    planBranch,
    capturedAt: CAPTURED_AT,
    roadmapBytes,
  });
  if (tamperPlan) plan = tamperPlan(plan);
  const headSha = await commitPlanOnBranch({ workDir: git.workDir, plan, roadmapBytes });
  return { ...git, planBranch, headSha, plan, beforeAuthority, roadmapBytes };
}

// A fake review-reducer honoring the same fail-closed contract as invokeCanonicalReviewReducer
// (bounded/injected per the PR review: production defaults still call the real one).
function fakeReducer({ planPr, planHead, state = "authorized" }) {
  return ({ planPr: gotPr, planHead: gotHead }) => {
    if (gotPr !== planPr || gotHead !== planHead || state !== "authorized") {
      throw new BacklogClassificationSweepError("REVIEW_NOT_AUTHORIZED", `Review reducer state: ${state}`);
    }
    return { schema: "exact-head-review-reducer/v1", pr: gotPr, currentHead: gotHead, state: "authorized" };
  };
}

function buildProdClient({
  authority,
  afterAuthority = null,
  mainSha,
  headSha,
  planBranch,
  planPr,
  prOverrides = {},
  fileList = [PLAN_PATH, ROADMAP_PATH],
  comments = [],
  executeMode = "success",
}) {
  const files = [...fileList].sort();
  let executeCalls = 0;
  let moved = false;
  const currentAuthority = () => (moved && afterAuthority ? afterAuthority : authority);
  const client = {
    authorityKind: "synthetic-test",
    async getRef(branch) {
      if (branch === "main") return mainSha;
      if (branch === planBranch) return headSha;
      throw new Error(`unexpected ref ${branch}`);
    },
    async getPlanPr(number) {
      if (number !== planPr) throw new Error("unexpected pr number");
      return {
        number: planPr,
        state: "OPEN",
        isDraft: true,
        merged: false,
        mergedAt: null,
        baseRefOid: mainSha,
        headRefOid: headSha,
        headRefName: planBranch,
        mergeQueueEntry: null,
        autoMergeRequest: null,
        files: { totalCount: files.length },
        ...prOverrides,
      };
    },
    async listPlanFiles(number) {
      if (number !== planPr) throw new Error("unexpected pr number");
      return [...files];
    },
    async collectWindow() {
      return clone(currentAuthority().window);
    },
    async collectStableIssue(number) {
      const entry = currentAuthority().issueAuthorities.find((item) => item.issue.number === number);
      if (!entry) throw new Error(`unexpected issue ${number}`);
      return clone(entry);
    },
    async collectRegistries() {
      const source = currentAuthority();
      return {
        labelRegistry: clone(source.labelRegistry),
        typeRegistry: clone(source.typeRegistry),
        permission: clone(source.permission),
      };
    },
    async listComments(issueNumber) {
      if (issueNumber !== SYNTHETIC_ROOT) throw new Error(`unexpected issue ${issueNumber}`);
      return clone(comments);
    },
    async createComment(issueNumber, body) {
      comments.push({ id: comments.length + 1, body });
      return { id: comments.length };
    },
    async executeStep() {
      executeCalls += 1;
      if (executeMode === "503-before") {
        const error = new Error("synthetic 503 before commit");
        error.status = 503;
        throw error;
      }
      moved = true;
      if (executeMode === "503-after") {
        const error = new Error("synthetic 503 after commit");
        error.status = 503;
        throw error;
      }
    },
  };
  return {
    client,
    comments,
    moveAfter: () => {
      moved = true;
    },
    get executeCalls() {
      return executeCalls;
    },
  };
}

async function expectIdentityBypassRejects(mutate, code) {
  const fx = await createProdApplyFixture();
  try {
    const planPr = 4200;
    const built = buildProdClient({
      authority: fx.beforeAuthority,
      mainSha: fx.mainSha,
      headSha: fx.headSha,
      planBranch: fx.planBranch,
      planPr,
    });
    const client = mutate({ fx, client: built.client, planPr }) ?? built.client;
    const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
    await expectAsyncCode(
      () => assertPlanExecutionIdentity({ client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
      code,
    );
    expect(built.executeCalls).toBe(0);
    expect(built.comments).toHaveLength(0);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
}

describe("backlog-classification-sweep/complete-authority-preflight", () => {
  it("rejects the #7550 page-one 100/101 control and preserves a decisive page-two negative", () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => index + 1);
    const complete = [...pageOne, 101];
    expectCode(() => reconcileIssueIdentities(pageOne, complete), "ISSUE_SOURCE_RECONCILIATION_INVALID");
    expect(reconcileIssueIdentities(complete, complete)).toHaveLength(101);
  });

  it("requires two consecutive complete identical captures", async () => {
    let calls = 0;
    const source = fixture();
    const client = {
      collectStableIssue: async (number) => source.issueAuthorities.find((entry) => entry.issue.number === number),
      collectWindow: async () => {
        calls += 1;
        const value = clone(source.window);
        if (calls === 1) value.digest = "f".repeat(64);
        return value;
      },
      collectRegistries: async () => ({
        labelRegistry: source.labelRegistry,
        typeRegistry: source.typeRegistry,
        permission: source.permission,
      }),
    };
    const accepted = await collectCompleteSweepAuthority({
      client,
      issueNumber: SYNTHETIC_ROOT,
      milestoneNumber: SYNTHETIC_MILESTONE,
    });
    expect(calls).toBe(3);
    expect(accepted.window.digest).toBe(source.window.digest);
  });

  it("fails before plan creation for disabled/remapped Bug and inadequate permission", () => {
    const disabled = fixture();
    disabled.typeRegistry.find((entry) => entry.name === "Bug").isEnabled = false;
    const roadmap = renderClassificationPlanningRoadmap(disabled.window.authority);
    expectCode(
      () =>
        buildClassificationPlan({
          authority: disabled,
          issueNumber: SYNTHETIC_ROOT,
          milestoneNumber: SYNTHETIC_MILESTONE,
          landedMainSha: MAIN,
          planBranch: BRANCH,
          capturedAt: CAPTURED_AT,
          roadmapBytes: roadmap,
        }),
      "TYPE_REGISTRY_REQUIRED_TYPE_INVALID",
    );
    expectCode(() => buildPlan({ permission: "WRITE" }), "PLAN_PERMISSION_INVALID");
  });

  it("binds the exact authorized milestone 136 identity to its exact title and rejects a title-only drift", () => {
    const authorized = fixture({
      milestoneNumber: AUTHORIZED_MILESTONE_NUMBER,
      milestoneTitle: AUTHORIZED_MILESTONE_TITLE,
    });
    const roadmap = renderClassificationPlanningRoadmap(authorized.window.authority);
    const plan = buildClassificationPlan({
      authority: authorized,
      issueNumber: SYNTHETIC_ROOT,
      milestoneNumber: AUTHORIZED_MILESTONE_NUMBER,
      landedMainSha: MAIN,
      planBranch: BRANCH,
      capturedAt: CAPTURED_AT,
      roadmapBytes: roadmap,
    });
    expect(plan.milestone).toEqual({
      id: "SYNTHETIC_MILESTONE",
      number: AUTHORIZED_MILESTONE_NUMBER,
      title: AUTHORIZED_MILESTONE_TITLE,
      state: "OPEN",
    });
    expect(validateClassificationPlan(plan)).toEqual(plan);

    const drifted = fixture({
      milestoneNumber: AUTHORIZED_MILESTONE_NUMBER,
      milestoneTitle: "Wave 1 — Renamed Milestone",
    });
    const driftedRoadmap = renderClassificationPlanningRoadmap(drifted.window.authority);
    expectCode(
      () =>
        buildClassificationPlan({
          authority: drifted,
          issueNumber: SYNTHETIC_ROOT,
          milestoneNumber: AUTHORIZED_MILESTONE_NUMBER,
          landedMainSha: MAIN,
          planBranch: BRANCH,
          capturedAt: CAPTURED_AT,
          roadmapBytes: driftedRoadmap,
        }),
      "PLAN_MILESTONE_INVALID",
    );

    const renamedAfterConstruction = clone(plan);
    renamedAfterConstruction.milestone.title = "Wave 1 — Renamed Milestone";
    renamedAfterConstruction.planDigest = digestCanonical(
      Object.fromEntries(Object.entries(renamedAfterConstruction).filter(([key]) => key !== "planDigest")),
    );
    expectCode(() => validateClassificationPlan(renamedAfterConstruction), "PLAN_MILESTONE_INVALID");

    expect(buildPlan().milestone.number).toBe(SYNTHETIC_MILESTONE);
  });

  it("requires an absolute injected fake client under tests and never falls through to live fetch", async () => {
    const fakeClient = path.resolve("scripts/fixtures/backlog-classification-sweep-client.mjs");
    await expect(
      main({
        argv: ["--mode", "apply", "--issue-number", "7536", "--milestone-number", "136", "--github-client", fakeClient],
        env: { GITHUB_REPOSITORY: "chase-sets/chase-sets", VITEST: "true" },
      }),
    ).rejects.toMatchObject({ code: "CLI_EXECUTION_ARGUMENTS_INVALID" });
    await expect(
      main({
        argv: ["--mode", "apply", "--issue-number", "7536", "--milestone-number", "136"],
        env: { GITHUB_REPOSITORY: "chase-sets/chase-sets", VITEST: "true" },
      }),
    ).rejects.toMatchObject({ code: "TEST_GITHUB_CLIENT_REQUIRED" });
  });
});

describe("backlog-classification-sweep/reviewed-decision-authority", () => {
  it("plans only the exact revision/body/node preimage", () => {
    const plan = buildPlan();
    expect(plan.gapNumbers).toEqual([SYNTHETIC_TARGET]);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].steps[0]).toMatchObject({
      kind: "set-type",
      request: { issueNodeId: "SYNTHETIC_ISSUE_TARGET" },
    });
  });

  it("accepts an exact after-image only with a later provider revision and emits no step", () => {
    const plan = buildPlan({ after: true });
    expect(plan.gapNumbers).toEqual([]);
    expect(plan.targets).toEqual([]);
  });

  it("preserves existing labels and groups the exact missing label IDs into one additive request", () => {
    const plan = buildLabelPlan();
    const target = plan.targets[0];
    expect(target.steps[0]).toMatchObject({ kind: "add-labels", request: { labelableId: "SYNTHETIC_ISSUE_TARGET" } });
    expect(target.steps[0].request.labelIds).toHaveLength(1);
    expect(target.after.labels).toHaveLength(target.before.labels.length + 1);
    expect(buildLabelPlan({ after: true }).targets).toEqual([]);
  });

  it.each([
    ["changed body", { decisionOverrides: { bodySha256: "0".repeat(64) } }, "DECISION_IDENTITY_DRIFT"],
    ["changed node", { decisionOverrides: { nodeId: "OTHER_NODE" } }, "DECISION_IDENTITY_DRIFT"],
    [
      "preimage revision drift",
      { decisionOverrides: { updatedAt: "2026-08-29T22:00:00Z" } },
      "DECISION_PREIMAGE_REVISION_DRIFT",
    ],
    ["new unmatched gap", { extraGap: true }, "PLAN_GAP_DECISION_MISMATCH"],
  ])("rejects %s", (_name, options, code) => {
    expectCode(() => buildPlan(options), code);
  });

  it("does not infer deltas from prose, keywords, or issue number alone", () => {
    const body = decisionBody({}, []);
    expect(extractReviewedDecisionAuthority(body).value.entries).toEqual([]);
    const authority = fixture();
    authority.issueAuthorities[0].issue.body = body;
    const roadmap = renderClassificationPlanningRoadmap(authority.window.authority);
    expectCode(
      () =>
        buildClassificationPlan({
          authority,
          issueNumber: SYNTHETIC_ROOT,
          milestoneNumber: SYNTHETIC_MILESTONE,
          landedMainSha: MAIN,
          planBranch: BRANCH,
          capturedAt: CAPTURED_AT,
          roadmapBytes: roadmap,
        }),
      "PLAN_GAP_DECISION_MISMATCH",
    );
  });

  it("refuses admission when a persisted after-image/step substitutes an unauthorized type despite self-consistent hashes (Bug→Slice)", async () => {
    const fx = await createProdApplyFixture({
      tamperPlan: (plan) => {
        const tampered = clone(plan);
        const target = tampered.targets[0];
        const sliceType = tampered.typeRegistry.value.find((entry) => entry.name === "Slice");
        target.after = governedFingerprint({ ...target.before, issueType: sliceType, labels: target.before.labels });
        target.steps[0].request.issueTypeId = sliceType.nodeId;
        target.steps[0].afterFingerprint = digestCanonical(target.after);
        return recomputePlanDigest(tampered);
      },
    });
    try {
      expect(validateClassificationPlan(fx.plan)).toEqual(fx.plan);
      const planPr = 4400;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      await expectAsyncCode(
        () => admitExpectedPrefix({ client: built.client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
        "EXPECTED_PREFIX_DECISION_BINDING_INVALID",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("refuses admission when a persisted label after-image/step substitutes another registry label the decision never authorized", async () => {
    const fx = await createProdLabelApplyFixture({
      tamperPlan: (plan) => {
        const tampered = clone(plan);
        const target = tampered.targets[0];
        const substitute = tampered.labelRegistry.value.find((label) => label.name === "kind:product");
        target.after = governedFingerprint({ ...target.before, labels: [...target.before.labels, substitute] });
        target.steps[0].request.labelIds = [substitute.id];
        target.steps[0].afterFingerprint = digestCanonical(target.after);
        return recomputePlanDigest(tampered);
      },
    });
    try {
      expect(validateClassificationPlan(fx.plan)).toEqual(fx.plan);
      const planPr = 4401;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      await expectAsyncCode(
        () => admitExpectedPrefix({ client: built.client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
        "EXPECTED_PREFIX_DECISION_BINDING_INVALID",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("refuses admission when a persisted label keeps the authorized name but carries a fabricated node identity", async () => {
    const fx = await createProdLabelApplyFixture({
      tamperPlan: (plan) => {
        const tampered = clone(plan);
        const target = tampered.targets[0];
        const bogusLabel = { id: "LABEL_BOGUS_SAME_NAME", name: "kind:ops" };
        target.after = governedFingerprint({ ...target.before, labels: [...target.before.labels, bogusLabel] });
        target.steps[0].request.labelIds = [bogusLabel.id];
        target.steps[0].afterFingerprint = digestCanonical(target.after);
        return recomputePlanDigest(tampered);
      },
    });
    try {
      expect(validateClassificationPlan(fx.plan)).toEqual(fx.plan);
      const planPr = 4402;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      await expectAsyncCode(
        () => admitExpectedPrefix({ client: built.client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
        "EXPECTED_PREFIX_DECISION_BINDING_INVALID",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("backlog-classification-sweep/closed-plan-and-hash-domains", () => {
  it("round-trips one canonical terminal-LF plan with disjoint semantic and artifact hashes", () => {
    const plan = buildPlan();
    const bytes = serializePlan(plan);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.endsWith("\n\n")).toBe(false);
    expect(sha256Utf8(bytes)).not.toBe(plan.planDigest);
    expect(validateClassificationPlan(JSON.parse(bytes))).toEqual(plan);
  });

  it.each([
    ["top-level extra key", (plan) => (plan.extra = true), "PLAN_KEYS_INVALID"],
    ["roadmap path", (plan) => (plan.roadmapRender.path = "other.md"), "PLAN_ROADMAP_PATH_INVALID"],
    ["main oid", (plan) => (plan.implementation.landedMainSha = "A".repeat(40)), "PLAN_MAIN_INVALID"],
    ["nested label key", (plan) => (plan.labelRegistry.value[0].extra = true), "PLAN_LABEL_REGISTRY_DIGEST_INVALID"],
    ["target order", (plan) => (plan.targets[0].number = 1), "PLAN_TARGET_STATE_INVALID"],
    [
      "request payload",
      (plan) => (plan.targets[0].steps[0].request.issueTypeId = "substituted"),
      "PLAN_STEP_TRANSITION_INVALID",
    ],
  ])("rejects mutant: %s", (_name, mutate, code) => {
    const plan = clone(buildPlan());
    mutate(plan);
    expectCode(() => validateClassificationPlan(plan), code);
  });
});

describe("backlog-classification-sweep/plan-pr-review-authority", () => {
  it("refuses a substituted reducer/history identity before execution", () => {
    expectCode(
      () =>
        invokeCanonicalReviewReducer({
          planPr: 1,
          planHead: HEAD,
          reducerPath: "C:\\synthetic\\reducer.ps1",
          historyPath: "C:\\synthetic\\history.jsonl",
        }),
      "REVIEW_REDUCER_IDENTITY_INVALID",
    );
  });

  it("keeps apply identity impossible without a closed reviewed plan", () => {
    const plan = clone(buildPlan());
    plan.implementation.planBranch = "codex/issue-7536-classification-phase-a";
    expectCode(() => validateClassificationPlan(plan), "PLAN_BRANCH_INVALID");
  });

  it("reaches real assertPlanExecutionIdentity and admitExpectedPrefix through a bounded temp git repo with an injected GitHub/reducer seam", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4200;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      const identity = await assertPlanExecutionIdentity({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        invokeReducer,
      });
      expect(identity.planHead).toBe(fx.headSha);
      expect(identity.localMain).toBe(fx.mainSha);
      expect(identity.reduction).toEqual({
        schema: "exact-head-review-reducer/v1",
        pr: planPr,
        currentHead: fx.headSha,
        state: "authorized",
      });

      const admission = await admitExpectedPrefix({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        invokeReducer,
      });
      expect(admission.prefix).toEqual({ records: [], attemptId: null, terminal: null, pendingIntent: null });
      expect(admission.authority.window.digest).toBe(fx.beforeAuthority.window.digest);
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("refuses a stale local main disagreeing with the injected GitHub main authority", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getRef: async (branch) => (branch === "main" ? "f".repeat(40) : client.getRef(branch)),
      }),
      "MAIN_AUTHORITY_MISMATCH",
    );
  });

  it("refuses a plan PR that is not draft (ready-for-review) at admission", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getPlanPr: async (number) => ({ ...(await client.getPlanPr(number)), isDraft: false }),
      }),
      "PLAN_PR_STATE_INVALID",
    );
  });

  it("refuses a merged plan PR at admission", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getPlanPr: async (number) => ({
          ...(await client.getPlanPr(number)),
          merged: true,
          mergedAt: "2026-08-30T00:00:00Z",
        }),
      }),
      "PLAN_PR_STATE_INVALID",
    );
  });

  it("refuses a plan PR carrying a merge-queue entry (queue state)", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getPlanPr: async (number) => ({ ...(await client.getPlanPr(number)), mergeQueueEntry: { id: "Q_1" } }),
      }),
      "PLAN_PR_STATE_INVALID",
    );
  });

  it("refuses a plan PR carrying an enabled auto-merge request (auto-merge state)", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getPlanPr: async (number) => ({
          ...(await client.getPlanPr(number)),
          autoMergeRequest: { enabledAt: "2026-08-30T00:00:00Z" },
        }),
      }),
      "PLAN_PR_STATE_INVALID",
    );
  });

  it("refuses a plan PR whose base moved off the exact landed main", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        getPlanPr: async (number) => ({ ...(await client.getPlanPr(number)), baseRefOid: "c".repeat(40) }),
      }),
      "PLAN_PR_STATE_INVALID",
    );
  });

  it("refuses an extra path beyond the two generated plan artifacts", async () => {
    await expectIdentityBypassRejects(
      ({ client }) => ({
        ...client,
        listPlanFiles: async () => [PLAN_PATH, ROADMAP_PATH, "extra/path.txt"].sort(),
      }),
      "PLAN_PR_PATH_SET_INVALID",
    );
  });

  it("refuses a dirty working tree before identity is trusted", async () => {
    const fx = await createProdApplyFixture();
    try {
      await writeFile(path.join(fx.workDir, "untracked.txt"), "stray\n", "utf8");
      const planPr = 4200;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      await expectAsyncCode(
        () =>
          assertPlanExecutionIdentity({ client: built.client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
        "PLAN_EXECUTION_IDENTITY_INVALID",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("refuses a stale (non-authorized) review-reducer state before genesis", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4200;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha, state: "stale" });
      await expectAsyncCode(
        () =>
          assertPlanExecutionIdentity({ client: built.client, plan: fx.plan, planPr, cwd: fx.workDir, invokeReducer }),
        "REVIEW_NOT_AUTHORIZED",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("refuses an equal-attempt reducer authorization bound to a head that no longer matches (stale reduction)", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4200;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const staleReducer = fakeReducer({ planPr, planHead: "d".repeat(40) });
      await expectAsyncCode(
        () =>
          assertPlanExecutionIdentity({
            client: built.client,
            plan: fx.plan,
            planPr,
            cwd: fx.workDir,
            invokeReducer: staleReducer,
          }),
        "REVIEW_NOT_AUTHORIZED",
      );
      expect(built.executeCalls).toBe(0);
      expect(built.comments).toHaveLength(0);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

function applyHarness({ executeMode = "success" } = {}) {
  const plan = buildPlan();
  const beforeAuthority = fixture();
  const afterAuthority = fixture({ after: true });
  let target = clone(beforeAuthority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_TARGET));
  const comments = [];
  let executeCalls = 0;
  let clock = Date.parse("2026-08-30T02:00:00.000Z");
  const moveAfter = () => {
    target = clone(afterAuthority.issueAuthorities.find((entry) => entry.issue.number === SYNTHETIC_TARGET));
  };
  const client = {
    authorityKind: "synthetic-test",
    listComments: async () => clone(comments),
    createComment: async (_number, body) => {
      comments.push({ id: comments.length + 1, body });
      return { id: comments.length };
    },
    collectStableIssue: async (number) => {
      if (number !== SYNTHETIC_TARGET) throw new Error(`unexpected issue ${number}`);
      return clone(target);
    },
    executeStep: async () => {
      executeCalls += 1;
      if (executeMode === "503-before") {
        const error = new Error("synthetic 503 before commit");
        error.status = 503;
        throw error;
      }
      moveAfter();
      if (executeMode === "503-after") {
        const error = new Error("synthetic 503 after commit");
        error.status = 503;
        throw error;
      }
    },
  };
  const admit = async () => {
    const prefix = validateJournalPrefix(comments, plan);
    return {
      identity: { planHead: HEAD },
      comments: clone(comments),
      prefix,
      authority: target.issue.issueType === null ? beforeAuthority : afterAuthority,
    };
  };
  const now = () => {
    const value = new Date(clock).toISOString();
    clock += 1;
    return value;
  };
  return {
    plan,
    client,
    admit,
    now,
    comments,
    moveAfter,
    get executeCalls() {
      return executeCalls;
    },
  };
}

describe("backlog-classification-sweep/bounded-apply-and-crash-recovery", () => {
  it("uses one exact additive payload and is idempotent after the apply receipt", async () => {
    const harness = applyHarness();
    const receipt = await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(receipt.kind).toBe("apply-receipt");
    expect(harness.executeCalls).toBe(1);
    expect(harness.comments).toHaveLength(4);
    const repeated = await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(repeated).toEqual(receipt);
    expect(harness.executeCalls).toBe(1);
  });

  it("records a committed 503 as observationally ambiguous without retrying", async () => {
    const harness = applyHarness({ executeMode: "503-after" });
    await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(harness.executeCalls).toBe(1);
    const prefix = validateJournalPrefix(harness.comments, harness.plan);
    expect(prefix.records.find(({ record }) => record.kind === "result").record.responseClass).toBe("ambiguous");
  });

  it("leaves one durable intent after a pre-commit 503 and resumes the exact payload once later", async () => {
    const harness = applyHarness({ executeMode: "503-before" });
    await expect(applyClassificationPlan({ ...harness, planPr: 42 })).rejects.toMatchObject({
      code: "TARGET_AFTER_NOT_OBSERVED",
    });
    expect(validateJournalPrefix(harness.comments, harness.plan).pendingIntent).not.toBeNull();
    expect(harness.executeCalls).toBe(1);
    harness.client.executeStep = async () => {
      harness.moveAfter();
    };
    await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(validateJournalPrefix(harness.comments, harness.plan).terminal).toBe("apply-receipt");
  });

  it("recovers a concurrent exact-after observation without claiming atomic CAS or issuing a request", async () => {
    const harness = applyHarness();
    await expect(
      applyClassificationPlan({
        ...harness,
        planPr: 42,
        onBoundary: async (name) => {
          if (name === "post-intent-pre-request") throw new Error("synthetic crash after intent");
        },
      }),
    ).rejects.toThrow("synthetic crash after intent");
    harness.moveAfter();
    await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(harness.executeCalls).toBe(0);
    const result = validateJournalPrefix(harness.comments, harness.plan).records.find(
      ({ record }) => record.kind === "result",
    ).record;
    expect(result).toMatchObject({ responseClass: "ambiguous", outcome: "after-observed" });
  });

  it("distinguishes the admitted candidate from a bypass that changes state in the residual read/write window", async () => {
    const harness = applyHarness();
    await applyClassificationPlan({
      ...harness,
      planPr: 42,
      onBoundary: async (name) => {
        if (name === "post-intent-pre-request") harness.moveAfter();
      },
    });
    expect(harness.executeCalls).toBe(0);
    const result = validateJournalPrefix(harness.comments, harness.plan).records.find(
      ({ record }) => record.kind === "result",
    ).record;
    expect(result.responseClass).toBe("ambiguous");
  });

  it("reaches the real admitExpectedPrefix/assertPlanExecutionIdentity chain for the full apply loop with exactly one provider write", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4300;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        afterAuthority: fx.afterAuthorityValue,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      const admit = (args) => admitExpectedPrefix({ ...args, invokeReducer });
      const receipt = await applyClassificationPlan({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        admit,
      });
      expect(receipt.kind).toBe("apply-receipt");
      expect(built.executeCalls).toBe(1);
      expect(built.comments).toHaveLength(4);
      const repeated = await applyClassificationPlan({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        admit,
      });
      expect(repeated).toEqual(receipt);
      expect(built.executeCalls).toBe(1);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reconciles a lost/ambiguous result-comment response through re-scan instead of a duplicate write (success-response-lost)", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4301;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        afterAuthority: fx.afterAuthorityValue,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const originalCreateComment = built.client.createComment;
      let createCalls = 0;
      built.client.createComment = async (issueNumber, body) => {
        createCalls += 1;
        if (createCalls === 3) {
          await originalCreateComment(issueNumber, body);
          const error = new Error("synthetic lost response for the result comment");
          error.status = 503;
          throw error;
        }
        return originalCreateComment(issueNumber, body);
      };
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      const admit = (args) => admitExpectedPrefix({ ...args, invokeReducer });
      const receipt = await applyClassificationPlan({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        admit,
      });
      expect(receipt.kind).toBe("apply-receipt");
      expect(built.comments).toHaveLength(4);
      expect(built.executeCalls).toBe(1);
      const result = validateJournalPrefix(built.comments, fx.plan).records.find(
        ({ record }) => record.kind === "result",
      ).record;
      expect(result.responseClass).toBe("success");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("crash-recovers across the post-read-pre-result boundary through real admission without a duplicate provider write", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4302;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        afterAuthority: fx.afterAuthorityValue,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      const admit = (args) => admitExpectedPrefix({ ...args, invokeReducer });
      await expect(
        applyClassificationPlan({
          client: built.client,
          plan: fx.plan,
          planPr,
          cwd: fx.workDir,
          admit,
          onBoundary: async (name) => {
            if (name === "post-read-pre-result") throw new Error("synthetic crash post-read-pre-result");
          },
        }),
      ).rejects.toThrow("synthetic crash post-read-pre-result");
      expect(built.executeCalls).toBe(1);
      expect(built.comments).toHaveLength(2);
      const receipt = await applyClassificationPlan({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        admit,
      });
      expect(receipt.kind).toBe("apply-receipt");
      expect(built.executeCalls).toBe(1);
      expect(built.comments).toHaveLength(4);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("crash-recovers across the post-result boundary through real admission without a duplicate provider write", async () => {
    const fx = await createProdApplyFixture();
    try {
      const planPr = 4303;
      const built = buildProdClient({
        authority: fx.beforeAuthority,
        afterAuthority: fx.afterAuthorityValue,
        mainSha: fx.mainSha,
        headSha: fx.headSha,
        planBranch: fx.planBranch,
        planPr,
      });
      const invokeReducer = fakeReducer({ planPr, planHead: fx.headSha });
      const admit = (args) => admitExpectedPrefix({ ...args, invokeReducer });
      await expect(
        applyClassificationPlan({
          client: built.client,
          plan: fx.plan,
          planPr,
          cwd: fx.workDir,
          admit,
          onBoundary: async (name) => {
            if (name === "post-result") throw new Error("synthetic crash post-result");
          },
        }),
      ).rejects.toThrow("synthetic crash post-result");
      expect(built.executeCalls).toBe(1);
      expect(built.comments).toHaveLength(3);
      const receipt = await applyClassificationPlan({
        client: built.client,
        plan: fx.plan,
        planPr,
        cwd: fx.workDir,
        admit,
      });
      expect(receipt.kind).toBe("apply-receipt");
      expect(built.executeCalls).toBe(1);
      expect(built.comments).toHaveLength(4);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("backlog-classification-sweep/plan-journal-integrity", () => {
  it("rejects duplicate logical keys, sequence gaps, substitution, and cross-plan poisoning", async () => {
    const harness = applyHarness();
    await applyClassificationPlan({ ...harness, planPr: 42 });
    expect(validateJournalPrefix(harness.comments, harness.plan).terminal).toBe("apply-receipt");
    expectCode(
      () => validateJournalPrefix([...harness.comments, clone(harness.comments[0])], harness.plan),
      "JOURNAL_LOGICAL_KEY_COLLISION",
    );
    const missing = harness.comments.filter((_comment, index) => index !== 1);
    expectCode(() => validateJournalPrefix(missing, harness.plan), "JOURNAL_SEQUENCE_GAP");
    const substituted = clone(harness.comments);
    substituted[1].body = substituted[1].body.replace(
      `"targetNumber":${SYNTHETIC_TARGET}`,
      `"targetNumber":${SYNTHETIC_EXTRA}`,
    );
    expectCode(() => validateJournalPrefix(substituted, harness.plan), "JOURNAL_MARKER_MISMATCH");

    const later = clone(harness.plan);
    later.capturedAt = "2026-08-30T03:00:00.000Z";
    later.planDigest = digestCanonical(
      Object.fromEntries(Object.entries(later).filter(([key]) => key !== "planDigest")),
    );
    expect(validateJournalPrefix(harness.comments, later).records).toEqual([]);
  });

  it("binds markers to canonical record bytes and exact predecessor hashes", () => {
    const plan = buildPlan();
    const context = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId: "11111111-1111-4111-8111-111111111111",
      sequence: 0,
      predecessorSha256: null,
      createdAt: "2026-08-30T02:00:00.000Z",
    };
    const genesis = createJournalRecord("genesis", context);
    const body = renderJournalComment(genesis);
    expect(body).toContain(`sha=${journalRecordSha(genesis)}`);
    expect(validateJournalPrefix([{ id: 1, body }], plan).terminal).toBe("genesis");
  });

  it("rejects a result record substituted for the required intent (result-without-intent)", () => {
    const plan = buildPlan();
    const target = plan.targets[0];
    const step = target.steps[0];
    const genesisContext = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId: "22222222-2222-4222-8222-222222222222",
      sequence: 0,
      predecessorSha256: null,
      createdAt: "2026-08-30T02:00:00.000Z",
    };
    const genesis = createJournalRecord("genesis", genesisContext);
    const bogusResultContext = {
      ...genesisContext,
      sequence: 1,
      predecessorSha256: journalRecordSha(genesis),
      createdAt: "2026-08-30T02:00:01.000Z",
    };
    const bogusResult = createJournalRecord("result", bogusResultContext, {
      targetNumber: target.number,
      stepIndex: step.index,
      requestDigest: digestCanonical(step.request),
      observedFingerprint: {
        governed: target.after,
        updatedAt: target.decisionUpdatedAt,
        bodySha256: target.bodySha256,
      },
      responseClass: "success",
      outcome: "after-observed",
    });
    const comments = [
      { id: 1, body: renderJournalComment(genesis) },
      { id: 2, body: renderJournalComment(bogusResult) },
    ];
    expectCode(() => validateJournalPrefix(comments, plan), "JOURNAL_TRANSITION_INVALID");
  });

  it("rejects a second genesis under a different attempt id (fork)", () => {
    const plan = buildPlan();
    const context1 = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId: "33333333-3333-4333-8333-333333333333",
      sequence: 0,
      predecessorSha256: null,
      createdAt: "2026-08-30T02:00:00.000Z",
    };
    const context2 = { ...context1, attemptId: "44444444-4444-4444-8444-444444444444" };
    const genesis1 = createJournalRecord("genesis", context1);
    const genesis2 = createJournalRecord("genesis", context2);
    const comments = [
      { id: 1, body: renderJournalComment(genesis1) },
      { id: 2, body: renderJournalComment(genesis2) },
    ];
    expectCode(() => validateJournalPrefix(comments, plan), "JOURNAL_MULTIPLE_ATTEMPTS");
  });

  it("rejects a record whose predecessor hash does not match its immediate predecessor (missing predecessor)", () => {
    const plan = buildPlan();
    const target = plan.targets[0];
    const step = target.steps[0];
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const genesisContext = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId,
      sequence: 0,
      predecessorSha256: null,
      createdAt: "2026-08-30T02:00:00.000Z",
    };
    const genesis = createJournalRecord("genesis", genesisContext);
    const intentContext = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId,
      sequence: 1,
      predecessorSha256: "0".repeat(64),
      createdAt: "2026-08-30T02:00:01.000Z",
    };
    const intent = createJournalRecord("intent", intentContext, {
      targetNumber: target.number,
      stepIndex: step.index,
      beforeFingerprint: step.beforeFingerprint,
      requestDigest: digestCanonical(step.request),
    });
    const comments = [
      { id: 1, body: renderJournalComment(genesis) },
      { id: 2, body: renderJournalComment(intent) },
    ];
    expectCode(() => validateJournalPrefix(comments, plan), "JOURNAL_LINEAGE_INVALID");
  });

  it("rejects two divergent successors of the same predecessor at the same sequence (journal fork)", () => {
    const plan = buildPlan();
    const target = plan.targets[0];
    const step = target.steps[0];
    const attemptId = "66666666-6666-4666-8666-666666666666";
    const genesisContext = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId,
      sequence: 0,
      predecessorSha256: null,
      createdAt: "2026-08-30T02:00:00.000Z",
    };
    const genesis = createJournalRecord("genesis", genesisContext);
    const baseIntentContext = {
      plan,
      planPr: 42,
      planHead: HEAD,
      attemptId,
      sequence: 1,
      predecessorSha256: journalRecordSha(genesis),
      createdAt: "2026-08-30T02:00:01.000Z",
    };
    const intentA = createJournalRecord("intent", baseIntentContext, {
      targetNumber: target.number,
      stepIndex: step.index,
      beforeFingerprint: step.beforeFingerprint,
      requestDigest: digestCanonical(step.request),
    });
    const intentB = createJournalRecord(
      "intent",
      { ...baseIntentContext, createdAt: "2026-08-30T02:00:02.000Z" },
      {
        targetNumber: target.number,
        stepIndex: step.index,
        beforeFingerprint: step.beforeFingerprint,
        requestDigest: digestCanonical(step.request),
      },
    );
    expect(journalRecordSha(intentA)).not.toBe(journalRecordSha(intentB));
    const comments = [
      { id: 1, body: renderJournalComment(genesis) },
      { id: 2, body: renderJournalComment(intentA) },
      { id: 3, body: renderJournalComment(intentB) },
    ];
    expectCode(() => validateJournalPrefix(comments, plan), "JOURNAL_LOGICAL_KEY_COLLISION");
  });

  it("rejects a duplicated terminal apply-receipt (second terminal)", async () => {
    const harness = applyHarness();
    await applyClassificationPlan({ ...harness, planPr: 42 });
    const duplicated = [...harness.comments, clone(harness.comments.at(-1))];
    expectCode(() => validateJournalPrefix(duplicated, harness.plan), "JOURNAL_LOGICAL_KEY_COLLISION");
  });
});

describe("backlog-classification-sweep/steady-state-verify", () => {
  it("persists same-capture zero-gap roadmap/empty-plan bytes before the terminal receipt", async () => {
    const harness = applyHarness();
    await applyClassificationPlan({ ...harness, planPr: 42 });
    const temp = await mkdtemp(path.join(os.tmpdir(), "issue-7536-verify-"));
    try {
      const receipt = await verifyClassificationPlan({
        ...harness,
        planPr: 42,
        roadmapOut: path.join(temp, "roadmap.md"),
        emptyPlanOut: path.join(temp, "empty-plan.json"),
        out: path.join(temp, "verify.json"),
      });
      expect(receipt).toMatchObject({ kind: "verify-receipt", zeroGapNumbers: [] });
      const empty = JSON.parse(await readFile(path.join(temp, "empty-plan.json"), "utf8"));
      expect(empty).toMatchObject({ gapNumbers: [], targets: [], logicalStepCount: 0 });
      expect(sha256Utf8(await readFile(path.join(temp, "roadmap.md"), "utf8"))).toBe(receipt.postRoadmapSha256);
      expect(validateJournalPrefix(harness.comments, harness.plan).terminal).toBe("verify-receipt");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
