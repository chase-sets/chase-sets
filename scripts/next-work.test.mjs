import { describe, expect, it } from "vitest";
import { BLOCKED_BY_QUERY, reduceUnlockCounts } from "./dispatch-unlock-count.mjs";
import {
  ISSUE_READINESS_RULES,
  renderIssueReadinessComment,
  validateIssueReadinessReceipt,
} from "./issue-readiness.mjs";
import {
  attachReadiness,
  buildDependencySnapshot,
  collectNextWorkFacts,
  EXCLUSION_REASONS,
  ISSUES_QUERY,
  main,
  parseArguments,
  rankNextWork,
} from "./next-work.mjs";

const REPOSITORY = "chase-sets/chase-sets";
const CLASSIFIED = ["priority:p1", "area:delivery", "kind:product"];

const marker = (track, order, status = "committed") =>
  `<!-- outcome: ${JSON.stringify({ version: 1, track, order, status })} -->`;
const steeringMarker = (until = "until Todd answers the priority question") =>
  `<!-- steering: ${JSON.stringify({ version: 1, source: "https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123", until })} -->`;

function outcome(number, track, order, { status = "committed", state = "open", description } = {}) {
  return {
    id: `MI_${number}`,
    number,
    title: `Outcome ${number}`,
    description: description === undefined ? marker(track, order, status) : description,
    state,
  };
}

function issue(number, { labels = CLASSIFIED, milestone = 10, ...overrides } = {}) {
  return {
    id: `I_${number}`,
    number,
    state: "OPEN",
    title: `Issue ${number}`,
    updatedAt: "2026-10-18T00:00:00Z",
    lastEditedAt: null,
    issueType: "Slice",
    milestone: milestone === null ? null : { id: `MI_${milestone}`, number: milestone, title: `Outcome ${milestone}` },
    parentNumber: null,
    labels: labels.map((name) => ({ id: `L_${name}`, name })),
    blockedBy: [],
    blocking: [],
    openPrs: [],
    dispatchRank: null,
    boardStatus: "Refined",
    unlockCount: 0,
    ...overrides,
  };
}

function facts(milestones, issues) {
  return {
    repository: REPOSITORY,
    collectedAt: "2026-10-18T00:00:00.000Z",
    collection: { requests: 1, wallSeconds: 0 },
    milestones,
    issues,
  };
}

const edge = (number, state = "OPEN", nameWithOwner = REPOSITORY) => ({
  id: `I_${number}`,
  number,
  state,
  repository: { nameWithOwner },
});

const issueNumbers = (entries) => entries.map((entry) => entry.issue);

// All readiness identities below are synthetic, not modified live authority.
function readinessReceipt(item, milestone, { status = "ready", dependencyOnly = false } = {}) {
  const coverage = (total) => ({
    pages: total === 0 ? 0 : 1,
    collected: total,
    total,
    complete: true,
    reasonCode: null,
  });
  const failedRule = dependencyOnly ? "ready-00-dependencies-resolved" : "ready-01-repo-evidence";
  const reasonCodes = status === "not-ready" ? ["SYNTHETIC_NOT_READY"] : [];
  const receipt = {
    schemaVersion: "issue-readiness/v1",
    claim: "structural-only",
    status,
    subject: { repository: REPOSITORY, number: item.number, nodeId: item.id, updatedAt: "2026-10-17T00:00:00Z" },
    facts: {
      state: "open",
      issueType: { nodeId: "synthetic-slice-type", name: "Slice", isEnabled: true },
      milestone: { ...milestone },
      labels: item.labels.map(({ name }) => name),
      hasParent: false,
      parentNumber: null,
      dependencies: dependencyOnly
        ? [{ nodeId: "I_900", number: 900, state: "open", updatedAt: "2026-10-16T00:00:00Z", issueTypeName: "Slice" }]
        : [],
    },
    checkedRules: ISSUE_READINESS_RULES.map(({ id }) => ({
      id,
      status: status === "not-ready" && id === failedRule ? "fail" : "pass",
      reasonCodes: status === "not-ready" && id === failedRule ? [...reasonCodes] : [],
    })),
    reasonCodes,
    coverage: {
      authorityComplete: true,
      issue: { initialRead: true, finalRead: true, revisionStable: true },
      labels: coverage(item.labels.length),
      dependencies: coverage(dependencyOnly ? 1 : 0),
      comments: coverage(0),
      form: { parsed: true, complete: true },
    },
    provenance: {
      checkedAt: "2026-10-18T00:00:00Z",
      checkerSha: "a".repeat(40),
      apiVersion: "2022-11-28",
      collector: "github-rest-plus-graphql",
    },
    semanticPressureTest: "not-evaluated",
  };
  expect(validateIssueReadinessReceipt(receipt)).toEqual([]);
  return receipt;
}

function readinessComment(receipt, overrides = {}) {
  return {
    id: 700,
    node_id: "synthetic-comment-node",
    body: renderIssueReadinessComment(receipt),
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    user: { login: "github-actions[bot]", type: "Bot" },
    ...overrides,
  };
}

function readinessHarness(respond) {
  const calls = [];
  return {
    calls,
    options: {
      token: "synthetic-test-token",
      pageIntervalMs: 0,
      fetchImplementation: async (url, init) => {
        calls.push(url);
        expect(init.method).toBe("GET");
        const response = await respond(url);
        if (response instanceof Error) throw response;
        if (typeof response?.json === "function") return response;
        return { status: 200, ok: true, headers: new Map(), json: async () => response };
      },
    },
  };
}

describe("next-work frontier readiness", () => {
  it("classifies frontier readiness from the stable receipt comment", async () => {
    const milestone = outcome(10, "delivery", 100);
    for (const value of ["ready", "not-ready", "stale", "missing", "unknown", "not-evaluated"]) {
      const item = issue(1, value === "not-evaluated" ? { openPrs: [123] } : {});
      const receipt = readinessReceipt(item, milestone, { status: value === "not-ready" ? "not-ready" : "ready" });
      if (value === "stale") receipt.subject.nodeId = "synthetic-older-issue-node";
      const comment = readinessComment(
        receipt,
        value === "unknown" ? { body: "<!-- chase-sets:issue-readiness:v1 --> invalid receipt" } : {},
      );
      const harness = readinessHarness(() => (value === "missing" ? [] : [comment]));
      const input = facts([milestone], [item]);
      const document = await attachReadiness(rankNextWork(input), input, harness.options);
      expect(document.classes.product[0].readiness, value).toBe(value);
      expect(document.classes.product[0].readinessSource, value).toBe(
        ["missing", "not-evaluated"].includes(value)
          ? null
          : `https://github.com/${REPOSITORY}/issues/1#issuecomment-700`,
      );
      expect(harness.calls.length, value).toBe(value === "not-evaluated" ? 0 : 1);
    }
  });

  it("treats a receipt as current only when the bound facts are unchanged", async () => {
    const cases = [
      {
        name: "later comment moves updatedAt only",
        expected: "ready",
        mutate: (input) => {
          input.issues[0].updatedAt = "2026-10-19T00:00:00Z";
        },
      },
      {
        name: "edit at bound revision",
        expected: "ready",
        mutate: (input) => {
          input.issues[0].lastEditedAt = "2026-10-17T00:00:00Z";
        },
      },
      {
        name: "body edit after subject but before checkedAt",
        expected: "stale",
        mutate: (input) => {
          input.issues[0].lastEditedAt = "2026-10-17T12:00:00Z";
        },
      },
      {
        name: "milestone description",
        expected: "stale",
        mutate: (input) => {
          input.milestones[0].description += "\nChanged description";
        },
      },
      { name: "milestone lowercase state", expected: "ready", mutate: () => {} },
      {
        name: "labels",
        expected: "stale",
        mutate: (input) => {
          input.issues[0].labels.push({ id: "synthetic-label", name: "synthetic-extra-label" });
        },
      },
      {
        name: "label order",
        expected: "ready",
        mutate: (input) => {
          input.issues[0].labels.reverse();
        },
      },
      {
        name: "issue type",
        expected: "stale",
        mutate: (input) => {
          input.issues[0].issueType = null;
        },
      },
      {
        name: "node identity",
        expected: "stale",
        mutate: (_input, receipt) => {
          receipt.subject.nodeId = "synthetic-other-node";
        },
      },
      {
        name: "closed blockers",
        expected: "stale",
        dependencyOnly: true,
        mutate: (input) => {
          input.issues[0].blockedBy = [edge(900, "CLOSED")];
        },
      },
      { name: "blocker closure unavailable", expected: "not-ready", dependencyOnly: true, mutate: () => {} },
      { name: "unknown state with historical ready", expected: "unknown", unknown: true, mutate: () => {} },
      { name: "two stable comments", expected: "unknown", duplicate: true, mutate: () => {} },
      { name: "non-bot marker", expected: "missing", human: true, mutate: () => {} },
      { name: "bot login with user type", expected: "missing", humanType: true, mutate: () => {} },
    ];
    for (const testCase of cases) {
      const milestone = outcome(10, "delivery", 100);
      const item = issue(1);
      const receipt = readinessReceipt(item, milestone, {
        status: testCase.dependencyOnly ? "not-ready" : "ready",
        dependencyOnly: testCase.dependencyOnly,
      });
      const input = facts([milestone], [item]);
      testCase.mutate(input, receipt);
      let comment = readinessComment(receipt);
      if (testCase.unknown) comment.body = `Current structural evaluation: unknown\n${comment.body}`;
      if (testCase.human) comment.user = { login: "synthetic-human", type: "User" };
      if (testCase.humanType) comment.user.type = "User";
      const harness = readinessHarness(() => (testCase.duplicate ? [comment, { ...comment, id: 701 }] : [comment]));
      const document = await attachReadiness(rankNextWork(input), input, harness.options);
      expect(document.classes.product[0].readiness, testCase.name).toBe(testCase.expected);
    }
  });

  it("refines implement actions from readiness without reordering", async () => {
    const milestone = outcome(10, "delivery", 100);
    const items = [
      issue(1, { issueType: "Decision" }),
      ...Array.from({ length: 6 }, (_, index) => issue(index + 2)),
      issue(20, { labels: ["priority:p1", "area:delivery", "kind:ops"] }),
      issue(30, { labels: ["priority:p1", "area:delivery", "kind:tooling"] }),
      issue(31, { labels: [...CLASSIFIED, "status:needs-replan"] }),
      issue(32, { labels: ["kind:product"] }),
      issue(33, { openPrs: [123] }),
      issue(34, { labels: [...CLASSIFIED, "status:needs-operator"] }),
    ];
    const input = facts([milestone], items);
    const original = rankNextWork(input);
    const harness = readinessHarness((url) => {
      const number = Number(/issues\/(\d+)\/comments/.exec(url)[1]);
      const item = items.find((candidate) => candidate.number === number);
      if (number === 4) return [];
      const receipt = readinessReceipt(item, milestone, { status: number === 3 ? "not-ready" : "ready" });
      if (number === 5) receipt.subject.nodeId = "synthetic-older-node";
      return [
        readinessComment(receipt, number === 6 ? { body: "<!-- chase-sets:issue-readiness:v1 --> invalid" } : {}),
      ];
    });
    const document = await attachReadiness(original, input, { ...harness.options, depth: 6 });
    expect(document.classes.product.slice(0, 7).map(({ action, readiness }) => [action, readiness])).toEqual([
      ["decide", "not-evaluated"],
      ["implement", "ready"],
      ["planning-repair", "not-ready"],
      ["readiness-check", "missing"],
      ["readiness-check", "stale"],
      ["readiness-check", "unknown"],
      ["implement", "not-evaluated"],
    ]);
    expect(document.classes.product[2].reasons).toEqual(["STRUCTURAL_NOT_READY"]);
    for (const name of ["product", "ops", "other"]) {
      expect(document.classes[name].map(({ issue: number, rank }) => [number, rank])).toEqual(
        original.classes[name].map(({ issue: number, rank }) => [number, rank]),
      );
    }
    expect(document.classes.ops[0].readiness).toBe("ready");
    expect(document.classes.other[0].readiness).toBe("ready");
    expect(harness.calls).toHaveLength(7);
    expect(original.classes.product.every(({ readiness }) => readiness === "not-evaluated")).toBe(true);
    expect(parseArguments([]).readinessDepth).toBe(15);
    expect(parseArguments(["--readiness-depth", "2"]).readinessDepth).toBe(2);
    for (const value of ["0", "-1", "2.5", "no", "9007199254740992"]) {
      expect(() => parseArguments(["--readiness-depth", value])).toThrow("NEXT_WORK_USAGE");
    }
  });

  it("keeps ranking when a readiness comment read fails", async () => {
    const milestone = outcome(10, "delivery", 100);
    const items = [issue(1), issue(2)];
    const input = facts([milestone], items);
    for (const failure of ["request", "partial", "malformed", "http", "json", "non-list"]) {
      const valid = readinessComment(readinessReceipt(items[0], milestone));
      const harness = readinessHarness((url) => {
        if (url.includes("/issues/2/")) return [];
        if (failure === "request") return new Error("synthetic request failed");
        if (failure === "http") return { ok: false, status: 500, headers: new Map(), json: async () => ({}) };
        if (failure === "json")
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            json: async () => {
              throw new Error("synthetic invalid JSON");
            },
          };
        if (failure === "non-list") return { synthetic: "not a comments list" };
        if (failure === "malformed") return [{ ...valid, user: null }];
        if (url.endsWith("page=1")) return Array.from({ length: 100 }, (_, index) => ({ ...valid, id: index + 700 }));
        return new Error("synthetic second-page failure");
      });
      let document;
      const output = [];
      const exitCode = await main({
        argv: ["--json", "synthetic.json"],
        env: { GITHUB_TOKEN: "synthetic-test-token" },
        collect: async () => input,
        readiness: async (ranked, collected, options) => {
          document = await attachReadiness(ranked, collected, { ...options, ...harness.options });
          return document;
        },
        writeFile: () => {},
        stdout: (text) => output.push(text),
        stderr: (text) => {
          throw new Error(text);
        },
      });
      expect(exitCode, failure).toBe(0);
      expect(
        document.classes.product.map(({ issue: number, rank, readiness }) => [number, rank, readiness]),
        failure,
      ).toEqual([
        [1, 1, "unknown"],
        [2, 2, "missing"],
      ]);
      expect(document.classes.product[0].readinessSource).toBeNull();
      expect(output.join("")).toContain("readiness unknown");
    }
  });

  it("reads every comments page before accepting the stable receipt", async () => {
    const milestone = outcome(10, "delivery", 100);
    const item = issue(1);
    const comment = readinessComment(readinessReceipt(item, milestone));
    const ordinary = {
      ...comment,
      body: "ordinary synthetic comment",
      user: { login: "synthetic-user", type: "User" },
    };
    const input = facts([milestone], [item]);
    const harness = readinessHarness((url) =>
      url.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, index) => ({ ...ordinary, id: index + 1000 }))
        : [comment],
    );
    const document = await attachReadiness(rankNextWork(input), input, harness.options);
    expect(harness.calls).toEqual(
      [1, 2].map((page) => `https://api.github.com/repos/${REPOSITORY}/issues/1/comments?per_page=100&page=${page}`),
    );
    expect(document.classes.product[0].readiness).toBe("ready");
  });

  it("does not accept the first stable comment before reading a duplicate on a later page", async () => {
    const milestone = outcome(10, "delivery", 100);
    const item = issue(1);
    const comment = readinessComment(readinessReceipt(item, milestone));
    const ordinary = { ...comment, body: "ordinary synthetic comment" };
    const input = facts([milestone], [item]);
    const harness = readinessHarness((url) =>
      url.endsWith("page=1")
        ? [comment, ...Array.from({ length: 99 }, (_, index) => ({ ...ordinary, id: index + 1000 }))]
        : [{ ...comment, id: 701 }],
    );
    const document = await attachReadiness(rankNextWork(input), input, harness.options);
    expect(document.classes.product[0]).toMatchObject({ readiness: "unknown", readinessSource: null });
    expect(harness.calls).toHaveLength(2);
  });

  it("requires every historical blocker to be closed and every failure to be dependency-only", async () => {
    const milestone = outcome(10, "delivery", 100);
    for (const anotherFailure of [false, true]) {
      const item = issue(1, { blockedBy: [edge(900, "CLOSED")] });
      const receipt = readinessReceipt(item, milestone, { status: "not-ready", dependencyOnly: true });
      if (anotherFailure) {
        receipt.checkedRules.find(({ id }) => id === "ready-01-repo-evidence").status = "fail";
        receipt.checkedRules.find(({ id }) => id === "ready-01-repo-evidence").reasonCodes = [
          "SYNTHETIC_OTHER_FAILURE",
        ];
        receipt.reasonCodes.push("SYNTHETIC_OTHER_FAILURE");
      } else {
        receipt.facts.dependencies.push({ ...receipt.facts.dependencies[0], nodeId: "I_901", number: 901 });
        receipt.coverage.dependencies.collected = 2;
        receipt.coverage.dependencies.total = 2;
      }
      expect(validateIssueReadinessReceipt(receipt)).toEqual([]);
      const input = facts([milestone], [item]);
      const harness = readinessHarness(() => [readinessComment(receipt)]);
      const document = await attachReadiness(rankNextWork(input), input, harness.options);
      expect(document.classes.product[0].readiness).toBe("not-ready");
    }
  });

  it("does not read readiness for non-implement actions within the frontier", async () => {
    const milestone = outcome(10, "delivery", 100);
    const items = [
      issue(1, { issueType: "Decision" }),
      issue(2, { labels: [...CLASSIFIED, "status:needs-replan"] }),
      issue(3, { labels: ["kind:product"] }),
      issue(4, { openPrs: [123] }),
      issue(5, { labels: [...CLASSIFIED, "status:needs-operator"] }),
      issue(6),
    ];
    const input = facts([milestone], items);
    const original = rankNextWork(input);
    const harness = readinessHarness(() => [readinessComment(readinessReceipt(items[5], milestone))]);
    const document = await attachReadiness(original, input, harness.options);
    expect(harness.calls).toEqual([`https://api.github.com/repos/${REPOSITORY}/issues/6/comments?per_page=100&page=1`]);
    for (const entry of document.classes.product.filter(({ issue: number }) => number !== 6)) {
      expect(entry).toEqual(original.classes.product.find(({ issue: number }) => number === entry.issue));
      expect(entry.readiness).toBe("not-evaluated");
    }
  });
});

describe("next-work ranking", () => {
  it("ranks each lane class by the ED3 key", () => {
    const milestones = [outcome(10, "delivery", 100), outcome(11, "delivery", 100), outcome(20, "delivery", 200)];
    const priorityLabels = (level) => [`priority:p${level}`, "area:delivery", "kind:product"];
    const document = rankNextWork(
      facts(milestones, [
        issue(1, { milestone: 20, dispatchRank: 1, labels: priorityLabels(0), unlockCount: 9 }),
        issue(2, { dispatchRank: 2 }),
        issue(3, { dispatchRank: 1 }),
        issue(4, { labels: priorityLabels(0) }),
        issue(5, { unlockCount: 3 }),
        issue(6, { unlockCount: 5 }),
        issue(7, { unlockCount: 5 }),
        issue(8, { labels: ["area:delivery", "kind:product"], unlockCount: 9 }),
        issue(9, { milestone: 11, dispatchRank: 0, labels: priorityLabels(0) }),
        issue(20, { labels: ["priority:p1", "area:delivery", "kind:ops"] }),
        issue(21, { title: "[controller] Log selections", labels: ["priority:p1", "area:delivery", "kind:tooling"] }),
        issue(22, { labels: ["priority:p1", "area:delivery", "kind:tooling"] }),
      ]),
    );

    // Order then milestone number, Dispatch rank (missing last), priority
    // (missing last), unlock count descending, issue number.
    expect(issueNumbers(document.classes.product)).toEqual([3, 2, 4, 6, 7, 5, 8, 9, 1]);
    expect(issueNumbers(document.classes.ops)).toEqual([20, 21]);
    expect(issueNumbers(document.classes.other)).toEqual([22]);
    for (const name of ["product", "ops", "other"]) {
      expect(document.classes[name].map((entry) => entry.rank)).toEqual(
        document.classes[name].map((_, index) => index + 1),
      );
      expect(document.classes[name].every((entry) => entry.laneClass === name)).toBe(true);
    }
    const all = Object.values(document.classes)
      .flat()
      .map((entry) => entry.issue);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(12);
    expect(document.classes.product[0]).toEqual({
      rank: 1,
      issue: 3,
      nodeId: "I_3",
      title: "Issue 3",
      type: "Slice",
      laneClass: "product",
      action: "implement",
      reasons: [],
      steered: false,
      milestone: { number: 10, title: "Outcome 10", track: "delivery", order: 100 },
      priority: 1,
      dispatchRank: 1,
      unlockCount: 0,
      boardStatus: "Refined",
      openPrs: [],
      readiness: "not-evaluated",
      readinessSource: null,
    });
    expect(document).toMatchObject({
      schemaVersion: "next-work/v1",
      generatedAt: "2026-10-18T00:00:00.000Z",
      repository: REPOSITORY,
      excludedMilestones: [],
      collection: { requests: 1, wallSeconds: 0 },
      steering: [],
      // Outcomes 10 and 11 share order 100 to exercise the milestone-number
      // tiebreak, so the ranking still reports them as an ED4 tie.
      defects: [{ code: "OUTCOME_ORDER_TIE", order: 100, milestones: [10, 11] }],
    });
  });

  it("compares outcome order across tracks", () => {
    const commerce = outcome(50, "commerce", 300);
    const delivery = outcome(250, "delivery", 100);
    const catalog = outcome(5, "catalog", 200);
    const document = rankNextWork(
      facts(
        [commerce, delivery, catalog],
        [issue(1, { milestone: 50, dispatchRank: 1 }), issue(2, { milestone: 250 }), issue(3, { milestone: 5 })],
      ),
    );
    expect(document.classes.product.map(({ issue: number, milestone }) => [number, milestone.track])).toEqual([
      [2, "delivery"],
      [3, "catalog"],
      [1, "commerce"],
    ]);
  });

  it("ranks steered outcomes before every unsteered outcome", () => {
    const steered = outcome(500, "delivery", 500, { description: `${marker("delivery", 500)}\n${steeringMarker()}` });
    const unsteered = outcome(100, "delivery", 100);
    const document = rankNextWork(
      facts([steered, unsteered], [issue(1, { milestone: 500 }), issue(2, { milestone: 100 })]),
    );
    expect(document.classes.product.map(({ issue: number, steered: value }) => [number, value])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("lists current steering and reports steering on a non-executable milestone", () => {
    const current = outcome(10, "delivery", 100, { description: `${marker("delivery", 100)}\n${steeringMarker()}` });
    const candidate = outcome(11, "delivery", 200, {
      status: "candidate",
      description: `${marker("delivery", 200, "candidate")}\n${steeringMarker()}`,
    });
    const document = rankNextWork(facts([current, candidate], [issue(1, { milestone: 10 })]));
    expect(document.steering).toEqual([
      {
        milestone: 10,
        title: "Outcome 10",
        order: 100,
        source: "https://github.com/chase-sets/chase-sets/issues/9943#issuecomment-123",
        until: "until Todd answers the priority question",
      },
    ]);
    expect(document.defects).toContainEqual({ code: "STEERING_ON_NON_EXECUTABLE", milestones: [11] });
  });

  it("reports one cross-track tie group and ignores excluded milestones", () => {
    const tied = [
      outcome(189, "commerce", 90),
      outcome(218, "delivery", 90),
      outcome(219, "catalog", 90),
      outcome(230, "ops", 90),
      outcome(232, "trust", 90),
    ];
    const document = rankNextWork(
      facts(
        [
          ...tied,
          outcome(240, "delivery", 90),
          outcome(250, "delivery", 90, { status: "candidate" }),
          outcome(270, "catalog", 120),
          outcome(271, "commerce", 120),
          outcome(280, "commerce", 130),
        ],
        [issue(1, { milestone: 232 }), issue(2, { milestone: 189 }), issue(3, { milestone: 240 })],
      ),
      { excludeMilestones: [271, 240, 271] },
    );
    expect(document.defects).toEqual([{ code: "OUTCOME_ORDER_TIE", order: 90, milestones: [189, 218, 219, 230, 232] }]);
    expect(document.excludedMilestones).toEqual([240, 271]);
    expect(issueNumbers(document.classes.product)).toEqual([2, 1]);
    expect(document.excluded.EXCLUDED_MILESTONE).toBe(1);
  });

  it("assigns one action per eligible issue and counts every exclusion", () => {
    const milestones = [
      outcome(10, "delivery", 100),
      outcome(11, "delivery", 110, { status: "candidate" }),
      outcome(12, "delivery", 0, { description: "Exit gates: #1" }),
      outcome(13, "delivery", 130),
    ];
    const unclassified = ["priority:p1", "kind:product"];
    const issues = [
      issue(1, { issueType: "Epic", milestone: null, labels: ["status:tracking-only"] }),
      issue(2, { milestone: null, labels: ["status:tracking-only"] }),
      issue(3, { milestone: null }),
      issue(4, { milestone: 11 }),
      issue(5, { milestone: 99 }),
      issue(6, { milestone: 12 }),
      issue(7, { milestone: 13, blockedBy: [edge(500)] }),
      issue(8, { blockedBy: [edge(500), edge(501, "CLOSED")] }),
      issue(9, {
        blockedBy: [edge(501, "CLOSED")],
        labels: [...CLASSIFIED, "status:needs-operator", "status:needs-replan"],
      }),
      issue(10, { labels: [...unclassified, "status:needs-replan"] }),
      issue(11, { issueType: "Decision", labels: unclassified }),
      issue(12, { issueType: "Decision", openPrs: [700] }),
      issue(13, { openPrs: [701] }),
      issue(14),
      issue(15, { issueType: null }),
      issue(16, { issueType: null, labels: [...CLASSIFIED, "kind:epic"] }),
      issue(17, { issueType: "Task" }),
    ];
    const document = rankNextWork(facts(milestones, issues), { excludeMilestones: [13] });

    expect(document.excluded).toEqual({
      EPIC: 1,
      TRACKING_ONLY: 1,
      NO_MILESTONE: 1,
      NOT_COMMITTED_OUTCOME: 3,
      EXCLUDED_MILESTONE: 1,
      BLOCKED: 1,
    });
    expect(Object.keys(document.excluded)).toEqual([...EXCLUSION_REASONS]);
    const actions = Object.fromEntries(
      Object.values(document.classes)
        .flat()
        .map((entry) => [entry.issue, [entry.action, entry.reasons]]),
    );
    expect(actions).toEqual({
      9: ["operator-wait", []],
      10: ["replan", []],
      11: ["planning-repair", ["UNCLASSIFIED"]],
      12: ["decide", []],
      13: ["pr-open", []],
      14: ["implement", []],
      15: ["implement", []],
      16: ["planning-repair", ["UNCLASSIFIED"]],
      17: ["planning-repair", ["UNCLASSIFIED"]],
    });
    const excludedTotal = Object.values(document.excluded).reduce((sum, count) => sum + count, 0);
    expect(excludedTotal + Object.keys(actions).length).toBe(issues.length);

    // An issue is never ranked or counted twice, or without its unlock count.
    expect(() => rankNextWork(facts(milestones, [issue(14), issue(14)]))).toThrow("NEXT_WORK_FACTS_INCOMPLETE");
    expect(() => rankNextWork(facts(milestones, [issue(14, { unlockCount: undefined })]))).toThrow(
      "NEXT_WORK_FACTS_INCOMPLETE",
    );
  });
});

describe("next-work CLI", () => {
  function run(argv, collected) {
    const output = { stdout: "", stderr: "", files: new Map() };
    return main({
      argv,
      env: { GITHUB_TOKEN: "test-token" },
      getToken: () => {
        throw new Error("gh must not be called when GITHUB_TOKEN is set");
      },
      collect: async ({ token, repository }) => {
        expect(token).toBe("test-token");
        expect(repository).toBe(REPOSITORY);
        if (collected instanceof Error) throw collected;
        return collected;
      },
      readiness: async (document) => document,
      writeFile: (path, content) => output.files.set(path, content),
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
    }).then((code) => ({ code, ...output }));
  }

  it("check mode exits nonzero only on defects", async () => {
    const tied = facts([outcome(189, "commerce", 90), outcome(218, "delivery", 90)], [issue(1, { milestone: 189 })]);
    const unique = facts([outcome(189, "commerce", 90), outcome(218, "delivery", 91)], [issue(1, { milestone: 189 })]);

    const defective = await run(["--check", "--top", "5", "--json", "out.json"], tied);
    expect(defective.code).toBe(1);
    expect(defective.stdout).toContain("defects: 1\n  OUTCOME_ORDER_TIE order 90: m189 m218");
    expect(JSON.parse(defective.files.get("out.json")).defects).toHaveLength(1);

    expect((await run(["--check"], unique)).code).toBe(0);
    expect((await run([], tied)).code).toBe(0);
    expect((await run(["--check", "--exclude-milestone", "218"], tied)).code).toBe(0);

    const steeredCandidate = outcome(218, "delivery", 91, {
      status: "candidate",
      description: `${marker("delivery", 91, "candidate")}\n${steeringMarker()}`,
    });
    const steeringDefect = await run(
      ["--check"],
      facts([outcome(189, "commerce", 90), steeredCandidate], [issue(1, { milestone: 189 })]),
    );
    expect(steeringDefect.code).toBe(1);
    expect(steeringDefect.stdout).toContain("STEERING_ON_NON_EXECUTABLE: m218");
    expect(steeringDefect.stdout).not.toContain("undefined");

    const failed = await run(["--check", "--json", "out.json"], new Error("NEXT_WORK_FACTS_INCOMPLETE: short"));
    expect(failed).toMatchObject({ code: 2, stdout: "", stderr: "NEXT_WORK_FACTS_INCOMPLETE: short\n" });
    expect(failed.files.size).toBe(0);
    expect((await run(["--top", "0"], unique)).code).toBe(2);
    expect((await run(["--exclude-milestone", "x"], unique)).code).toBe(2);
  });

  it("fails closed on a malformed steering marker", async () => {
    const malformed = facts(
      [outcome(189, "commerce", 90, { description: `${marker("commerce", 90)}\n<!-- steering: {"version":1 ` })],
      [issue(1, { milestone: 189 })],
    );
    const output = await run(["--json", "out.json"], malformed);
    expect(output.code).toBe(2);
    expect(output.files.size).toBe(0);
    expect(output.stderr).toContain("STEERING_METADATA_MALFORMED");
  });
});

// ---------------------------------------------------------------------------
// Collection against a scripted GitHub
// ---------------------------------------------------------------------------

const connection = (nodes, { hasNextPage = false, endCursor = null, totalCount = nodes.length } = {}) => ({
  totalCount,
  pageInfo: { hasNextPage, endCursor },
  nodes,
});

function rawIssue(number, overrides = {}) {
  return {
    id: `I_${number}`,
    number,
    state: "OPEN",
    title: `Issue ${number}`,
    updatedAt: "2026-10-18T00:00:00Z",
    lastEditedAt: null,
    issueType: { name: "Slice" },
    milestone: { id: "MI_235", number: 235, title: "Outcome 235" },
    parent: null,
    labels: connection(CLASSIFIED.map((name) => ({ id: `L_${name}`, name }))),
    blockedBy: connection([]),
    blocking: connection([]),
    closedByPullRequestsReferences: connection([]),
    projectItems: connection([
      { project: { number: 1, owner: { login: "someone-else" } }, dispatchRank: { number: 1 }, status: null },
      {
        project: { number: 1, owner: { login: "chase-sets" } },
        dispatchRank: { number: number * 10 },
        status: { name: "Refined" },
      },
    ]),
    ...overrides,
  };
}

const issuesPage = (nodes, { totalCount = nodes.length, endCursor = null } = {}) => ({
  data: {
    repository: {
      issues: connection(nodes, { hasNextPage: endCursor !== null, endCursor, totalCount }),
    },
  },
});

// Each attempt reads the milestones once, then pages issues by cursor.
function scriptedGitHub(respond) {
  const clock = { now: 0 };
  const requests = [];
  const sleeps = [];
  const fetchImplementation = async (url, init) => {
    const body = init.body === undefined ? null : JSON.parse(init.body);
    const request = { url, method: init.method, body, at: clock.now };
    requests.push(request);
    clock.now += 10;
    const { status = 200, headers = {}, json } = respond(request, requests.length - 1);
    return new Response(JSON.stringify(json ?? {}), { status, headers });
  };
  return {
    requests,
    sleeps,
    options: {
      token: "test-token",
      repository: REPOSITORY,
      fetchImplementation,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
    },
  };
}

const MILESTONES = [
  {
    node_id: "MI_235",
    number: 235,
    title: "Outcome 235",
    description: marker("delivery", 100),
    state: "open",
  },
];

function graphqlRouter(pagesByCursor, extra = () => undefined, milestonePages = [MILESTONES]) {
  return (request) => {
    if (request.method === "GET") {
      const page = Number(new URL(request.url).searchParams.get("page"));
      return { json: milestonePages[page - 1] ?? [] };
    }
    const routed = extra(request);
    if (routed !== undefined) return routed;
    expect(request.body.query).toBe(ISSUES_QUERY);
    return pagesByCursor(request.body.variables.after);
  };
}

describe("next-work collection", () => {
  it("paces, retries and fails closed on incomplete facts", async () => {
    // Paced pass: a blockedBy overflow paged by BLOCKED_BY_QUERY, a 403 with
    // retry-after on page two, and a duplicated node across pages.
    const closedBlockers = Array.from({ length: 20 }, (_, index) => edge(600 + index, "CLOSED"));
    const first = rawIssue(1, {
      blockedBy: connection(closedBlockers, { hasNextPage: true, endCursor: "blocked-1", totalCount: 21 }),
    });
    const second = rawIssue(2, { blocking: connection([edge(3)]) });
    const third = rawIssue(3, {
      blockedBy: connection([edge(2)]),
      closedByPullRequestsReferences: connection([
        { number: 801, state: "OPEN" },
        { number: 800, state: "MERGED" },
      ]),
    });
    let rateLimited = false;
    const paced = scriptedGitHub(
      graphqlRouter(
        (after) => {
          if (after === null) return { json: issuesPage([first, second], { totalCount: 3, endCursor: "page-1" }) };
          if (!rateLimited) {
            rateLimited = true;
            return { status: 403, headers: { "retry-after": "7" } };
          }
          return { json: issuesPage([second, third], { totalCount: 3 }) };
        },
        ({ body }) =>
          body.query === BLOCKED_BY_QUERY
            ? {
                json: {
                  data: {
                    node: { id: body.variables.issue, blockedBy: connection([edge(99)], { totalCount: 21 }) },
                  },
                },
              }
            : undefined,
      ),
    );
    const collected = await collectNextWorkFacts(paced.options);

    expect(
      paced.requests.map(({ method, body }) => (method === "GET" ? "milestones" : (body.variables.after ?? "page"))),
    ).toEqual(["milestones", "page", "blocked-1", "page-1", "page-1"]);
    expect(paced.requests.every(({ method, body }) => method === "GET" || !/\bmutation\b/.test(body.query))).toBe(true);
    const starts = paced.requests.map(({ at }) => at);
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 1000)).toBe(true);
    expect(paced.sleeps).toContain(7000);
    expect(collected.collection).toEqual({ requests: 5, wallSeconds: expect.any(Number) });
    expect(collected.issues.map(({ number }) => number)).toEqual([1, 2, 3]);
    expect(collected.issues[0].blockedBy).toHaveLength(21);
    expect(collected.issues[2]).toMatchObject({ openPrs: [801], dispatchRank: 30, boardStatus: "Refined" });
    expect(collected.milestones).toEqual([
      { id: "MI_235", number: 235, title: "Outcome 235", description: marker("delivery", 100), state: "open" },
    ]);

    const document = rankNextWork(collected);
    expect(document.excluded.BLOCKED).toBe(2);
    expect(issueNumbers(document.classes.product)).toEqual([2]);

    // Unlock counts from the built snapshot match a direct reducer fixture.
    const fixtureIssue = (number, blocking) => ({
      id: `I_${number}`,
      number,
      state: "OPEN",
      issueType: { name: "Slice" },
      milestone: { id: "MI_235", number: 235, title: "Outcome 235" },
      labels: { totalCount: 1, nodes: [{ id: "L_kind:product", name: "kind:product" }] },
      blocking: { totalCount: blocking.length, nodes: blocking },
      blockedBy: { totalCount: 0, nodes: [] },
    });
    const direct = reduceUnlockCounts({
      schemaVersion: "dispatch-dependency-snapshot/v1",
      repository: {
        nameWithOwner: REPOSITORY,
        totalCount: 3,
        issues: [fixtureIssue(1, []), fixtureIssue(2, [edge(3)]), fixtureIssue(3, [])],
      },
    });
    expect(direct.map(({ issueNumber, unlockCount }) => [issueNumber, unlockCount])).toEqual([
      [1, 0],
      [2, 1],
      [3, 0],
    ]);
    expect(collected.issues.map(({ number, unlockCount }) => [number, unlockCount])).toEqual(
      direct.map(({ issueNumber, unlockCount }) => [issueNumber, unlockCount]),
    );
    expect(
      buildDependencySnapshot(collected.issues, REPOSITORY).repository.issues.every(({ state }) => state === "OPEN"),
    ).toBe(true);

    // A short first pass is retried once and then accepted.
    let pass = 0;
    const recovered = scriptedGitHub(
      graphqlRouter(() => {
        pass += 1;
        return { json: issuesPage(pass === 1 ? [third] : [second, third], { totalCount: 2 }) };
      }),
    );
    expect((await collectNextWorkFacts(recovered.options)).issues).toHaveLength(2);
    expect(recovered.requests).toHaveLength(4);

    // Open milestones are paged until a short REST page.
    const filler = Array.from({ length: 100 }, (_, index) => ({
      node_id: `MI_${1000 + index}`,
      number: 1000 + index,
      title: `Filler ${index}`,
      description: null,
      state: "open",
    }));
    const paged = scriptedGitHub(
      graphqlRouter(() => ({ json: issuesPage([rawIssue(2)]) }), undefined, [filler, MILESTONES]),
    );
    expect((await collectNextWorkFacts(paged.options)).milestones).toHaveLength(101);
    expect(paged.requests.filter(({ method }) => method === "GET")).toHaveLength(2);

    // Each incomplete shape fails closed after exactly one retry.
    const overflowFrom =
      (id, totalCount = 2) =>
      ({ body }) =>
        body.query === BLOCKED_BY_QUERY
          ? { json: { data: { node: { id, blockedBy: connection([edge(602, "CLOSED")], { totalCount }) } } } }
          : undefined;
    const overflowing = issuesPage([
      rawIssue(8, {
        blockedBy: connection([edge(601, "CLOSED")], { hasNextPage: true, endCursor: "b-8", totalCount: 2 }),
      }),
    ]);
    const incompleteShapes = {
      "short page count": [issuesPage([rawIssue(9)], { totalCount: 2 })],
      "closedByPullRequestsReferences overflow": [
        issuesPage([
          rawIssue(4, {
            closedByPullRequestsReferences: connection(Array(10).fill({ number: 9, state: "OPEN" }), {
              hasNextPage: true,
              endCursor: "pr-10",
              totalCount: 11,
            }),
          }),
        ]),
      ],
      "projectItems overflow": [
        issuesPage([
          rawIssue(5, { projectItems: connection([], { hasNextPage: true, endCursor: "item-10", totalCount: 11 }) }),
        ]),
      ],
      "reducer join failure": [issuesPage([rawIssue(6, { blocking: connection([edge(404)]) })])],
      "non-open root issue": [issuesPage([rawIssue(7, { state: "CLOSED" })])],
      "overflow page for another issue": [overflowing, overflowFrom("I_999"), 6],
      "overflow pages short of totalCount": [overflowing, overflowFrom("I_8", 3), 6],
    };
    for (const [shape, [page, extra, requestCount = 4]] of Object.entries(incompleteShapes)) {
      const failing = scriptedGitHub(graphqlRouter(() => ({ json: page }), extra));
      await expect(collectNextWorkFacts(failing.options), shape).rejects.toMatchObject({
        code: "NEXT_WORK_FACTS_INCOMPLETE",
      });
      expect(failing.requests, shape).toHaveLength(requestCount);
    }

    // Provider errors fail closed at once, without a whole-pass retry, even
    // when the body would otherwise parse as a complete page.
    for (const response of [
      { json: { errors: [{ message: "denied" }], data: issuesPage([rawIssue(2)]).data } },
      { status: 502, json: issuesPage([rawIssue(2)]) },
    ]) {
      const failing = scriptedGitHub(graphqlRouter(() => response));
      await expect(collectNextWorkFacts(failing.options)).rejects.toMatchObject({ code: "NEXT_WORK_REQUEST_FAILED" });
      expect(failing.requests).toHaveLength(2);
    }

    // Rate limiting waits at most three times (default 60 s) for one page.
    const limited = scriptedGitHub(graphqlRouter(() => ({ status: 429 })));
    await expect(collectNextWorkFacts(limited.options)).rejects.toMatchObject({ code: "NEXT_WORK_RATE_LIMITED" });
    expect(limited.sleeps.filter((ms) => ms === 60_000)).toHaveLength(3);
    expect(limited.requests).toHaveLength(5);
  });
});
