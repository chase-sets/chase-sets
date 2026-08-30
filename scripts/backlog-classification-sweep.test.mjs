import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLabelNames, ENABLED_NATIVE_ISSUE_TYPES } from "./label-registry.mjs";
import {
  applyClassificationPlan,
  BacklogClassificationSweepError,
  bodySha256,
  buildClassificationPlan,
  canonicalJson,
  collectCompleteSweepAuthority,
  createJournalRecord,
  digestCanonical,
  extractReviewedDecisionAuthority,
  invokeCanonicalReviewReducer,
  journalRecordSha,
  main,
  reconcileIssueIdentities,
  renderClassificationPlanningRoadmap,
  renderJournalComment,
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

function decisionBody(entryOverrides = {}, entriesOverride = null) {
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
    milestoneNumber: SYNTHETIC_MILESTONE,
    entries: entriesOverride ?? [entry],
  };
  return `### Context\nSynthetic fixture; every fact is explicitly synthetic.\n\n\`\`\`json\n${JSON.stringify(decision, null, 2)}\n\`\`\`\n`;
}

function graphIssue({ number, nodeId, issueType, labels, tracking = false }) {
  const effectiveLabels = tracking ? [...labels, { id: "LABEL_TRACKING", name: "status:tracking-only" }] : labels;
  return {
    id: nodeId,
    number,
    state: "OPEN",
    issueType,
    milestone: { id: "SYNTHETIC_MILESTONE", number: SYNTHETIC_MILESTONE, title: SYNTHETIC_TITLE, state: "OPEN" },
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0 },
    labels: { totalCount: effectiveLabels.length, nodes: effectiveLabels },
    blockedBy: { totalCount: 0, nodes: [] },
  };
}

function stableIssue({ number, nodeId, body, updatedAt, issueType, labels }) {
  return {
    complete: true,
    issue: {
      nodeId,
      number,
      state: "open",
      updatedAt,
      body,
      issueType,
      milestone: { number: SYNTHETIC_MILESTONE, title: SYNTHETIC_TITLE, state: "open" },
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

function fixture({ after = false, decisionOverrides = {}, permission = "ADMIN", extraGap = false } = {}) {
  const labels = classificationLabels();
  const byName = new Map(labels.map((label) => [label.name, label]));
  const types = typeRegistry();
  const byType = new Map(types.map((type) => [type.name, type]));
  const classifiedLabels = [byName.get("priority:p2"), byName.get("area:ops"), byName.get("kind:ops")];
  const targetType = after ? byType.get("Bug") : null;
  const issues = [
    graphIssue({ number: SYNTHETIC_ROOT, nodeId: "SYNTHETIC_ISSUE_ROOT", issueType: byType.get("Slice"), labels: classifiedLabels }),
    graphIssue({ number: SYNTHETIC_TARGET, nodeId: "SYNTHETIC_ISSUE_TARGET", issueType: targetType, labels: classifiedLabels }),
    graphIssue({ number: SYNTHETIC_TRACKING, nodeId: "SYNTHETIC_ISSUE_TRACKING", issueType: byType.get("Slice"), labels: classifiedLabels, tracking: true }),
  ];
  if (extraGap) issues.push(graphIssue({ number: SYNTHETIC_EXTRA, nodeId: "SYNTHETIC_ISSUE_EXTRA", issueType: null, labels: classifiedLabels }));
  const windowAuthority = {
    version: "roadmap-dispatch-window-authority/v1",
    milestones: {
      totalCount: 1,
      nodes: [{ id: "SYNTHETIC_MILESTONE", number: SYNTHETIC_MILESTONE, title: SYNTHETIC_TITLE, state: "OPEN" }],
    },
    issues: { totalCount: issues.length, nodes: issues },
  };
  const rootBody = decisionBody(decisionOverrides);
  const issueAuthorities = [
    stableIssue({
      number: SYNTHETIC_ROOT,
      nodeId: "SYNTHETIC_ISSUE_ROOT",
      body: rootBody,
      updatedAt: "2026-08-30T07:16:27Z",
      issueType: byType.get("Slice"),
      labels: classifiedLabels,
    }),
    stableIssue({
      number: SYNTHETIC_TARGET,
      nodeId: "SYNTHETIC_ISSUE_TARGET",
      body: TARGET_BODY,
      updatedAt: after ? "2026-08-30T01:00:00Z" : DECISION_UPDATED_AT,
      issueType: targetType,
      labels: classifiedLabels,
    }),
  ];
  const window = { authority: windowAuthority, digest: digestCanonical(windowAuthority), restIssueNumbers: issues.map((issue) => issue.number), restPages: 2 };
  return {
    repository: "chase-sets/chase-sets",
    window,
    labelRegistry: labels,
    typeRegistry: types,
    permission: { repository: "chase-sets/chase-sets", viewerLogin: "synthetic-operator", viewerPermission: permission },
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
    milestoneNumber: SYNTHETIC_MILESTONE,
    landedMainSha: MAIN,
    planBranch: BRANCH,
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
      collectRegistries: async () => ({ labelRegistry: source.labelRegistry, typeRegistry: source.typeRegistry, permission: source.permission }),
    };
    const accepted = await collectCompleteSweepAuthority({ client, issueNumber: SYNTHETIC_ROOT, milestoneNumber: SYNTHETIC_MILESTONE });
    expect(calls).toBe(3);
    expect(accepted.window.digest).toBe(source.window.digest);
  });

  it("fails before plan creation for disabled/remapped Bug and inadequate permission", () => {
    const disabled = fixture();
    disabled.typeRegistry.find((entry) => entry.name === "Bug").isEnabled = false;
    const roadmap = renderClassificationPlanningRoadmap(disabled.window.authority);
    expectCode(
      () => buildClassificationPlan({ authority: disabled, issueNumber: SYNTHETIC_ROOT, milestoneNumber: SYNTHETIC_MILESTONE, landedMainSha: MAIN, planBranch: BRANCH, capturedAt: CAPTURED_AT, roadmapBytes: roadmap }),
      "TYPE_REGISTRY_REQUIRED_TYPE_INVALID",
    );
    expectCode(() => buildPlan({ permission: "WRITE" }), "PLAN_PERMISSION_INVALID");
  });

  it("requires an absolute injected fake client under tests and never falls through to live fetch", async () => {
    const fakeClient = path.resolve("scripts/fixtures/backlog-classification-sweep-client.mjs");
    await expect(
      main({
        argv: [
          "--mode",
          "apply",
          "--issue-number",
          "7536",
          "--milestone-number",
          "136",
          "--github-client",
          fakeClient,
        ],
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
    expect(plan.targets[0].steps[0]).toMatchObject({ kind: "set-type", request: { issueNodeId: "SYNTHETIC_ISSUE_TARGET" } });
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
    ["preimage revision drift", { decisionOverrides: { updatedAt: "2026-08-29T22:00:00Z" } }, "DECISION_PREIMAGE_REVISION_DRIFT"],
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
      () => buildClassificationPlan({ authority, issueNumber: SYNTHETIC_ROOT, milestoneNumber: SYNTHETIC_MILESTONE, landedMainSha: MAIN, planBranch: BRANCH, capturedAt: CAPTURED_AT, roadmapBytes: roadmap }),
      "PLAN_GAP_DECISION_MISMATCH",
    );
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
    ["request payload", (plan) => (plan.targets[0].steps[0].request.issueTypeId = "substituted"), "PLAN_STEP_TRANSITION_INVALID"],
  ])("rejects mutant: %s", (_name, mutate, code) => {
    const plan = clone(buildPlan());
    mutate(plan);
    expectCode(() => validateClassificationPlan(plan), code);
  });
});

describe("backlog-classification-sweep/plan-pr-review-authority", () => {
  it("refuses a substituted reducer/history identity before execution", () => {
    expectCode(
      () => invokeCanonicalReviewReducer({ planPr: 1, planHead: HEAD, reducerPath: "C:\\synthetic\\reducer.ps1", historyPath: "C:\\synthetic\\history.jsonl" }),
      "REVIEW_REDUCER_IDENTITY_INVALID",
    );
  });

  it("keeps apply identity impossible without a closed reviewed plan", () => {
    const plan = clone(buildPlan());
    plan.implementation.planBranch = "codex/issue-7536-classification-phase-a";
    expectCode(() => validateClassificationPlan(plan), "PLAN_BRANCH_INVALID");
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
    await expect(applyClassificationPlan({ ...harness, planPr: 42 })).rejects.toMatchObject({ code: "TARGET_AFTER_NOT_OBSERVED" });
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
    const result = validateJournalPrefix(harness.comments, harness.plan).records.find(({ record }) => record.kind === "result").record;
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
    const result = validateJournalPrefix(harness.comments, harness.plan).records.find(({ record }) => record.kind === "result").record;
    expect(result.responseClass).toBe("ambiguous");
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
    substituted[1].body = substituted[1].body.replace(`"targetNumber":${SYNTHETIC_TARGET}`, `"targetNumber":${SYNTHETIC_EXTRA}`);
    expectCode(() => validateJournalPrefix(substituted, harness.plan), "JOURNAL_MARKER_MISMATCH");

    const later = clone(harness.plan);
    later.capturedAt = "2026-08-30T03:00:00.000Z";
    later.planDigest = digestCanonical(Object.fromEntries(Object.entries(later).filter(([key]) => key !== "planDigest")));
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
