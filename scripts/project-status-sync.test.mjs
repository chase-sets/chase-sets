import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { classified } from "./backlog-classify.mjs";
import {
  collectProjectItems,
  DERIVED_STATUSES,
  deriveStatus,
  deriveTargetDate,
  isEpic,
  ITEMS_QUERY,
  LABELS_QUERY,
  main,
  planDateUpdates,
  planStatusUpdates,
  projectItemFromNode,
  readConfiguration,
  REQUIRED_STATUS_OPTIONS,
  TERMINAL_STATUSES,
  toBacklogInput,
} from "./project-status-sync.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function issue(overrides = {}) {
  return {
    number: 1,
    state: "open",
    milestone: { title: "Wave 2" },
    labels: [{ name: "priority:p1" }, { name: "area:catalog" }, { name: "kind:product" }],
    blockedBy: 0,
    hasParent: false,
    ...overrides,
  };
}

function labelConnection(names, { totalCount = names.length, hasNextPage = false, endCursor = null } = {}) {
  return {
    totalCount,
    pageInfo: { hasNextPage, endCursor },
    nodes: names.map((name, index) => ({ id: `label-${name}-${index}`, name })),
  };
}

function boardNode({
  id = "item-1",
  number = 1,
  state = "OPEN",
  stateReason = null,
  status = "Refined",
  targetDate = null,
  milestone = { title: "Wave 2", dueOn: "2026-08-12T00:00:00Z" },
  labels = labelConnection(["priority:p1", "area:catalog", "kind:product"]),
  blockedBy = 0,
  parent = null,
  issueType = { name: "Slice" },
} = {}) {
  return {
    id,
    status: status === null ? null : { name: status },
    targetDate: targetDate === null ? null : { date: targetDate },
    content: {
      id: `issue-${number}`,
      number,
      state,
      stateReason,
      issueType,
      parent,
      milestone,
      labels,
      issueDependenciesSummary: { blockedBy },
    },
  };
}

function itemPage(nodes, { totalCount = nodes.length, hasNextPage = false, endCursor = null } = {}) {
  return {
    node: {
      items: {
        totalCount,
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  };
}

function optionIdFixture(overrides = {}) {
  return {
    Backlog: "backlog-id",
    Refined: "refined-id",
    Blocked: "blocked-id",
    Epic: "epic-id",
    Tracking: "tracking-id",
    Landed: "landed-id",
    Canceled: "canceled-id",
    ...overrides,
  };
}

// The exact live `DELIVERY_STATUS_OPTION_IDS` shape after the pre-merge
// operator window: the seven repository-derived/terminal keys the script
// requires plus the two lane-owned options it must tolerate but never write.
const LIVE_EXPANDED_OPTION_IDS = Object.freeze({
  Backlog: "f8e865e3",
  Refined: "c436f1b6",
  Blocked: "efd58962",
  Epic: "170de2b0",
  "In lane": "06f2b950",
  "In review": "b4ffa6bc",
  Landed: "7a091234",
  Tracking: "339aa61a",
  Canceled: "5c5ab919",
});

function validEnv(overrides = {}) {
  return {
    GITHUB_TOKEN: "test-token",
    PROJECT_ID: "project-id",
    STATUS_FIELD_ID: "status-field-id",
    STATUS_OPTION_IDS: JSON.stringify(optionIdFixture()),
    TARGET_DATE_FIELD_ID: "date-field-id",
    ...overrides,
  };
}

function scriptedRequest(responder) {
  const requests = [];
  const request = vi.fn(async (query, variables, token) => {
    const entry = { query, variables, token };
    requests.push(entry);
    return responder(entry, requests.length - 1);
  });
  return { request, requests };
}

function mutationRequests(requests) {
  return requests.filter(({ query }) => /\bmutation\b/.test(query));
}

describe("project status derivation", () => {
  it("derives Refined when placed and fully classified", () => {
    expect(deriveStatus(issue())).toBe("Refined");
  });

  it("derives Backlog when any classification input is missing", () => {
    expect(deriveStatus(issue({ labels: [{ name: "area:catalog" }, { name: "kind:product" }] }))).toBe("Backlog");
    expect(deriveStatus(issue({ labels: [{ name: "priority:p1" }, { name: "kind:product" }] }))).toBe("Backlog");
    expect(deriveStatus(issue({ milestone: null }))).toBe("Backlog");
  });

  it("treats parked and operational milestones as Backlog even when classified", () => {
    expect(deriveStatus(issue({ milestone: { title: "Deferred / Incubation" } }))).toBe("Backlog");
    expect(deriveStatus(issue({ milestone: { title: "Operations" } }))).toBe("Backlog");
  });

  it("preserves Blocked precedence over a fully classified issue", () => {
    expect(deriveStatus(issue({ blockedBy: 1 }))).toBe("Blocked");
    expect(deriveStatus(issue({ blockedBy: 2, milestone: null }))).toBe("Blocked");
  });

  it("keeps #6169 native-type precedence as the only Epic authority", () => {
    expect(isEpic(issue({ issueType: { name: "Epic" }, labels: [] }))).toBe(true);
    expect(isEpic(issue({ issueType: { name: "Slice" }, labels: [{ name: "kind:epic" }] }))).toBe(false);
    expect(isEpic(issue({ labels: [{ name: "kind:epic" }] }))).toBe(true);
  });

  it("plans only real status transitions", () => {
    const items = [
      { itemId: "a", status: "Backlog", issue: issue({ number: 10 }) },
      { itemId: "b", status: "Refined", issue: issue({ number: 11 }) },
    ];
    expect(planStatusUpdates(items)).toEqual([{ itemId: "a", number: 10, from: "Backlog", to: "Refined" }]);
  });

  it("never clobbers lane-owned state", () => {
    for (const status of ["In lane", "In review", "Landed"]) {
      expect(planStatusUpdates([{ itemId: "a", status, issue: issue({ blockedBy: 5 }) }])).toEqual([]);
    }
  });

  it("maps every completed closed item to Landed regardless of its prior status", () => {
    const completed = issue({ number: 6150, state: "closed", stateReason: "completed" });
    expect(
      planStatusUpdates([
        { itemId: "a", status: "Refined", issue: completed },
        { itemId: "b", status: "In review", issue: { ...completed, number: 6276 } },
        { itemId: "c", status: null, issue: { ...completed, number: 6307 } },
        { itemId: "d", status: "Landed", issue: { ...completed, number: 6308 } },
      ]),
    ).toEqual([
      { itemId: "a", number: 6150, from: "Refined", to: "Landed" },
      { itemId: "b", number: 6276, from: "In review", to: "Landed" },
      { itemId: "c", number: 6307, from: null, to: "Landed" },
    ]);
  });

  it.each(["not_planned", "duplicate"])("maps a %s closure to Canceled", (stateReason) => {
    expect(
      planStatusUpdates([
        {
          itemId: "a",
          status: "Backlog",
          issue: issue({ number: 6160, state: "closed", stateReason }),
        },
      ]),
    ).toEqual([{ itemId: "a", number: 6160, from: "Backlog", to: "Canceled" }]);
  });

  it("fails closed when a closed issue has no supported state reason", () => {
    expect(() =>
      planStatusUpdates([
        { itemId: "a", status: "Refined", issue: issue({ number: 6150, state: "closed", stateReason: null }) },
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "ProjectStatusSyncIssueError",
        number: 6150,
        message: expect.stringContaining("unsupported state reason"),
      }),
    );
  });

  it.each(["Landed", "Canceled"])("returns an explicitly reopened %s item to derived ownership", (status) => {
    expect(
      planStatusUpdates([
        {
          itemId: "a",
          status,
          issue: issue({ number: 6150, state: "open", stateReason: "reopened" }),
        },
      ]),
    ).toEqual([{ itemId: "a", number: 6150, from: status, to: "Refined" }]);
  });

  it.each([
    ["COMPLETED", "Landed", "landed-id"],
    ["NOT_PLANNED", "Canceled", "canceled-id"],
    ["DUPLICATE", "Canceled", "canceled-id"],
  ])("writes a %s closure through main with the %s option", async (stateReason, expectedStatus, optionId) => {
    const node = boardNode({
      state: "CLOSED",
      stateReason,
      status: "Refined",
      targetDate: "2026-08-12",
    });
    const { request, requests } = scriptedRequest(({ query }) => {
      if (query === ITEMS_QUERY) return itemPage([node]);
      return { mutation: { ok: true } };
    });

    const result = await main({ env: validEnv(), request, logger: { log: vi.fn() } });

    expect(result.statusUpdates).toEqual([{ itemId: "item-1", number: 1, from: "Refined", to: expectedStatus }]);
    expect(mutationRequests(requests)).toEqual([
      expect.objectContaining({
        query: expect.stringContaining("singleSelectOptionId: $o"),
        variables: {
          p: "project-id",
          i: "item-1",
          f: "status-field-id",
          o: optionId,
        },
      }),
    ]);
  });

  it("projects a tracking-only continuity record to Tracking, never Refined or Blocked", () => {
    // Live counterexample #6058 is fully classified, parentless, and tracking-only.
    const trackingOnly = issue({
      number: 6058,
      blockedBy: 1,
      labels: [
        { name: "priority:p1" },
        { name: "area:identity" },
        { name: "kind:test" },
        { name: "status:tracking-only" },
      ],
    });
    expect(deriveStatus(trackingOnly)).toBe("Tracking");
    expect(planStatusUpdates([{ itemId: "a", status: "Refined", issue: trackingOnly }])).toEqual([
      { itemId: "a", number: 6058, from: "Refined", to: "Tracking" },
    ]);
  });

  it("derives truthful parent state through the board query path", () => {
    expect(ITEMS_QUERY).toContain("parent { number }");
    expect(ITEMS_QUERY).toContain("stateReason");
    const item = projectItemFromNode(
      boardNode({
        number: 6169,
        parent: { number: 6100 },
        milestone: { title: "Wave 1" },
      }),
      ["priority:p1", "area:ops", "kind:tech-debt"],
    );
    expect(item.issue.hasParent).toBe(true);
    expect(classified(toBacklogInput(item.issue))).toBe(true);
  });

  it("fails closed when the board path omits parent or native issue type state", () => {
    const withoutParent = boardNode();
    delete withoutParent.content.parent;
    const withoutType = boardNode();
    delete withoutType.content.issueType;

    expect(() => classified(toBacklogInput(projectItemFromNode(withoutParent).issue))).toThrowError(
      expect.objectContaining({ name: "BacklogClassificationInputError", field: "hasParent" }),
    );
    expect(() => classified(toBacklogInput(projectItemFromNode(withoutType).issue))).toThrowError(
      expect.objectContaining({ name: "BacklogClassificationInputError", field: "issueTypeName" }),
    );
  });
});

// The complete open-state contract published in docs/contributing/backlog-model.md.
// Precedence is first match wins: Epic -> Tracking -> Blocked -> Refined -> Backlog.
const OPEN_STATE_DECISION_TABLE = [
  {
    name: "native Epic",
    subject: issue({ number: 5496, issueType: { name: "Epic" }, labels: [], milestone: null }),
    expected: "Epic",
  },
  {
    name: "native Epic that is fully labelled and milestoned",
    subject: issue({ number: 5497, issueType: { name: "Epic" } }),
    expected: "Epic",
  },
  {
    name: "untyped legacy kind:epic issue",
    subject: issue({ number: 4001, labels: [{ name: "kind:epic" }] }),
    expected: "Epic",
  },
  {
    name: "native Epic carrying an open blocking dependency",
    subject: issue({ number: 5498, issueType: { name: "Epic" }, labels: [], blockedBy: 4 }),
    expected: "Epic",
  },
  {
    name: "native Epic that also carries status:tracking-only",
    subject: issue({
      number: 5499,
      issueType: { name: "Epic" },
      labels: [{ name: "status:tracking-only" }],
    }),
    expected: "Epic",
  },
  {
    name: "pathological untyped legacy epic that also carries status:tracking-only",
    subject: issue({ number: 4002, labels: [{ name: "kind:epic" }, { name: "status:tracking-only" }] }),
    expected: "Epic",
  },
  {
    name: "native Slice carrying the legacy kind:epic label but otherwise classified",
    subject: issue({
      number: 6001,
      issueType: { name: "Slice" },
      labels: [{ name: "priority:p1" }, { name: "area:catalog" }, { name: "kind:product" }, { name: "kind:epic" }],
    }),
    expected: "Refined",
  },
  {
    name: "native Slice carrying the legacy kind:epic label and nothing else",
    subject: issue({ number: 6002, issueType: { name: "Slice" }, labels: [{ name: "kind:epic" }] }),
    expected: "Backlog",
  },
  {
    name: "tracking-only non-Epic that is otherwise fully classified",
    subject: issue({
      number: 6058,
      issueType: { name: "Slice" },
      labels: [
        { name: "priority:p1" },
        { name: "area:identity" },
        { name: "kind:test" },
        { name: "status:tracking-only" },
      ],
    }),
    expected: "Tracking",
  },
  {
    name: "tracking-only non-Epic carrying an open blocking dependency",
    subject: issue({
      number: 6059,
      issueType: { name: "Slice" },
      labels: [{ name: "status:tracking-only" }],
      blockedBy: 2,
    }),
    expected: "Tracking",
  },
  {
    name: "open Slice with a blocking dependency",
    subject: issue({ number: 6573, issueType: { name: "Slice" }, blockedBy: 1 }),
    expected: "Blocked",
  },
  {
    name: "classified open Slice",
    subject: issue({ number: 6574, issueType: { name: "Slice" } }),
    expected: "Refined",
  },
  {
    name: "unclassified open Slice with no milestone",
    subject: issue({ number: 6575, issueType: { name: "Slice" }, milestone: null }),
    expected: "Backlog",
  },
  {
    name: "open Slice in a non-executable milestone",
    subject: issue({ number: 6576, issueType: { name: "Slice" }, milestone: { title: "Operations" } }),
    expected: "Backlog",
  },
  {
    name: "open Slice missing a kind:* label",
    subject: issue({
      number: 6577,
      issueType: { name: "Slice" },
      labels: [{ name: "priority:p1" }, { name: "area:catalog" }],
    }),
    expected: "Backlog",
  },
];

const TERMINAL_DECISION_TABLE = [
  {
    name: "completed native Epic",
    subject: issue({
      number: 5496,
      state: "closed",
      stateReason: "completed",
      issueType: { name: "Epic" },
      labels: [],
    }),
    expected: "Landed",
  },
  {
    name: "not-planned native Epic",
    subject: issue({
      number: 5497,
      state: "closed",
      stateReason: "not_planned",
      issueType: { name: "Epic" },
      labels: [],
    }),
    expected: "Canceled",
  },
  {
    name: "duplicate untyped legacy epic",
    subject: issue({ number: 4001, state: "closed", stateReason: "DUPLICATE", labels: [{ name: "kind:epic" }] }),
    expected: "Canceled",
  },
  {
    name: "completed tracking-only continuity record",
    subject: issue({
      number: 6058,
      state: "closed",
      stateReason: "completed",
      issueType: { name: "Slice" },
      labels: [{ name: "status:tracking-only" }],
    }),
    expected: "Landed",
  },
  {
    name: "not-planned tracking-only continuity record",
    subject: issue({
      number: 6059,
      state: "closed",
      stateReason: "not-planned",
      issueType: { name: "Slice" },
      labels: [{ name: "status:tracking-only" }],
    }),
    expected: "Canceled",
  },
  {
    name: "duplicate tracking-only continuity record",
    subject: issue({
      number: 6060,
      state: "closed",
      stateReason: "duplicate",
      issueType: { name: "Slice" },
      labels: [{ name: "status:tracking-only" }],
    }),
    expected: "Canceled",
  },
];

describe("Epic and Tracking derivation contract", () => {
  it.each(OPEN_STATE_DECISION_TABLE)("derives $expected for an open $name", ({ subject, expected }) => {
    expect(deriveStatus(subject)).toBe(expected);
  });

  it.each(TERMINAL_DECISION_TABLE)("derives $expected for a $name", ({ subject, expected }) => {
    expect(deriveStatus(subject)).toBe(expected);
  });

  it.each([
    { name: "native Epic", overrides: { issueType: { name: "Epic" }, labels: [] } },
    { name: "tracking-only record", overrides: { labels: [{ name: "status:tracking-only" }] } },
  ])("still fails closed on a closed $name with an unsupported state reason", ({ overrides }) => {
    for (const stateReason of [null, "", "   ", "stale", "reopened"]) {
      expect(() => deriveStatus(issue({ number: 7000, state: "closed", stateReason, ...overrides }))).toThrowError(
        expect.objectContaining({ name: "ProjectStatusSyncIssueError", number: 7000 }),
      );
    }
  });

  it("derives a status for every open row — there is no untouched arm left", () => {
    for (const { name, subject } of OPEN_STATE_DECISION_TABLE) {
      expect(deriveStatus(subject), `${name} derived no status`).not.toBeNull();
    }
  });

  // Derived, not hand-listed: the option set the configuration demands must be
  // exactly the set the derivation can emit. Adding a status to
  // REQUIRED_STATUS_OPTIONS without deriving it — or deriving one without
  // requiring its option id — fails here.
  it("requires an option id for exactly the statuses the derivation emits", () => {
    const emitted = new Set([...OPEN_STATE_DECISION_TABLE, ...TERMINAL_DECISION_TABLE].map((row) => row.expected));
    expect([...emitted].sort()).toEqual([...REQUIRED_STATUS_OPTIONS].sort());
  });

  it("treats Epic and Tracking as repository-derived and correctable, never terminal", () => {
    expect(DERIVED_STATUSES).toEqual(expect.arrayContaining(["Epic", "Tracking"]));
    expect(TERMINAL_STATUSES).not.toContain("Epic");
    expect(TERMINAL_STATUSES).not.toContain("Tracking");
  });
});

describe("planner correction and lane ownership", () => {
  const LANE_OWNED_STATUSES = ["In lane", "In review"];
  const CURRENT_STATUSES = [null, "Backlog", "Refined", "Blocked", "Epic", "Tracking", ...LANE_OWNED_STATUSES];
  const PLANNER_SUBJECTS = [
    {
      name: "native Epic",
      subject: issue({ number: 5496, issueType: { name: "Epic" }, labels: [], milestone: null }),
      derived: "Epic",
    },
    {
      name: "tracking-only continuity record",
      subject: issue({
        number: 6058,
        issueType: { name: "Slice" },
        labels: [
          { name: "priority:p1" },
          { name: "area:identity" },
          { name: "kind:test" },
          { name: "status:tracking-only" },
        ],
      }),
      derived: "Tracking",
    },
    {
      name: "ordinary classified Slice wrongly parked in a non-executable status",
      subject: issue({ number: 6574, issueType: { name: "Slice" } }),
      derived: "Refined",
    },
  ];

  it.each(PLANNER_SUBJECTS)(
    "corrects every wrong repository-derived status and preserves lane ownership for a $name",
    ({ subject, derived }) => {
      const items = CURRENT_STATUSES.map((status, index) => ({ itemId: `item-${index}`, status, issue: subject }));
      const expected = CURRENT_STATUSES.map((status, index) => ({ status, index }))
        .filter(({ status }) => !LANE_OWNED_STATUSES.includes(status) && status !== derived)
        .map(({ status, index }) => ({
          itemId: `item-${index}`,
          number: subject.number,
          from: status,
          to: derived,
        }));

      expect(planStatusUpdates(items)).toEqual(expected);
    },
  );

  it.each([
    {
      name: "Epic",
      node: boardNode({ number: 5496, issueType: { name: "Epic" }, status: null, labels: labelConnection([]) }),
      optionId: "epic-id",
    },
    {
      name: "Tracking",
      node: boardNode({
        number: 6058,
        issueType: { name: "Slice" },
        status: null,
        labels: labelConnection(["priority:p1", "area:identity", "kind:test", "status:tracking-only"]),
      }),
      optionId: "tracking-id",
    },
  ])("writes the $name option id through the real main composition", async ({ name, node, optionId }) => {
    const unassigned = { ...node, content: { ...node.content, milestone: null } };
    const { request, requests } = scriptedRequest(({ query }) => {
      if (query === ITEMS_QUERY) return itemPage([unassigned]);
      if (query === LABELS_QUERY) throw new Error("labels were already complete");
      return { mutation: { ok: true } };
    });

    const result = await main({ env: validEnv(), request, logger: { log: vi.fn() } });

    expect(result.statusUpdates).toEqual([
      { itemId: "item-1", number: unassigned.content.number, from: null, to: name },
    ]);
    expect(mutationRequests(requests)).toEqual([
      expect.objectContaining({
        query: expect.stringContaining("singleSelectOptionId: $o"),
        variables: { p: "project-id", i: "item-1", f: "status-field-id", o: optionId },
      }),
    ]);
  });
});

describe("typed target-date operations", () => {
  it("derives dates only from milestone due dates", () => {
    expect(
      deriveTargetDate(issue({ milestone: { title: "Wave 2", dueOn: "2026-08-12T00:00:00Z" }, dueOn: "2099-01-01" })),
    ).toBe("2026-08-12");
    expect(deriveTargetDate(issue({ milestone: { title: "Wave 2", due_on: "2026-08-12T00:00:00Z" } }))).toBe(
      "2026-08-12",
    );
  });

  it("clears the review probe's stale 2026-08-12 date after milestone removal", () => {
    expect(
      planDateUpdates([{ itemId: "a", targetDate: "2026-08-12", issue: issue({ number: 1, milestone: null }) }]),
    ).toEqual([{ type: "clear", itemId: "a", number: 1, from: "2026-08-12", to: null }]);
  });

  it("clears a stale date when the replacement milestone is undated", () => {
    expect(
      planDateUpdates([
        {
          itemId: "a",
          targetDate: "2026-08-12",
          issue: issue({ number: 2, milestone: { title: "Operations", dueOn: null } }),
        },
      ]),
    ).toEqual([{ type: "clear", itemId: "a", number: 2, from: "2026-08-12", to: null }]);
  });

  it("does not set an unchanged date", () => {
    expect(
      planDateUpdates([
        {
          itemId: "a",
          targetDate: "2026-08-12",
          issue: issue({ milestone: { title: "Wave 2", dueOn: "2026-08-12T00:00:00Z" } }),
        },
      ]),
    ).toEqual([]);
  });

  it("does not redundantly clear an already-empty date", () => {
    expect(planDateUpdates([{ itemId: "a", targetDate: null, issue: issue({ milestone: null }) }])).toEqual([]);
  });

  it("sets a changed milestone due date", () => {
    expect(
      planDateUpdates([
        {
          itemId: "a",
          targetDate: "2026-08-12",
          issue: issue({ number: 3, milestone: { dueOn: "2026-08-19" } }),
        },
      ]),
    ).toEqual([{ type: "set", itemId: "a", number: 3, from: "2026-08-12", to: "2026-08-19" }]);
  });

  it("drives clearProjectV2ItemFieldValue through the real main composition", async () => {
    const node = boardNode({ milestone: null, status: "Backlog", targetDate: "2026-08-12" });
    const { request, requests } = scriptedRequest(({ query }) => {
      if (query === ITEMS_QUERY) return itemPage([node]);
      return { mutation: { ok: true } };
    });

    await main({ env: validEnv(), request, logger: { log: vi.fn() } });

    expect(mutationRequests(requests)).toEqual([
      expect.objectContaining({
        query: expect.stringContaining("clearProjectV2ItemFieldValue"),
        variables: { p: "project-id", i: "item-1", f: "date-field-id" },
      }),
    ]);
  });

  it("drives updateProjectV2ItemFieldValue for a target-date set through main", async () => {
    const node = boardNode({ targetDate: "2026-08-01", milestone: { title: "Wave 2", dueOn: "2026-08-12" } });
    const { request, requests } = scriptedRequest(({ query }) => {
      if (query === ITEMS_QUERY) return itemPage([node]);
      return { mutation: { ok: true } };
    });

    await main({ env: validEnv(), request, logger: { log: vi.fn() } });

    expect(mutationRequests(requests)).toEqual([
      expect.objectContaining({
        query: expect.stringContaining("value: { date: $d }"),
        variables: { p: "project-id", i: "item-1", f: "date-field-id", d: "2026-08-12" },
      }),
    ]);
  });
});

describe("fail-closed configuration", () => {
  it.each(["GITHUB_TOKEN", "PROJECT_ID", "STATUS_FIELD_ID", "STATUS_OPTION_IDS", "TARGET_DATE_FIELD_ID"])(
    "names %s when it is missing or whitespace and makes zero requests",
    async (variable) => {
      for (const mode of ["missing", "whitespace"]) {
        const env = validEnv({ [variable]: "   " });
        if (mode === "missing") delete env[variable];
        const request = vi.fn();
        await expect(main({ env, request, logger: { log: vi.fn() } })).rejects.toMatchObject({
          name: "ProjectStatusSyncConfigurationError",
          variable,
          message: expect.stringContaining(`[configuration:${variable}]`),
        });
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("names unparseable STATUS_OPTION_IDS and makes zero requests", async () => {
    const request = vi.fn();
    await expect(
      main({ env: validEnv({ STATUS_OPTION_IDS: "not-json" }), request, logger: { log: vi.fn() } }),
    ).rejects.toMatchObject({
      name: "ProjectStatusSyncConfigurationError",
      variable: "STATUS_OPTION_IDS",
      message: expect.stringContaining("must be valid JSON"),
    });
    expect(request).not.toHaveBeenCalled();
  });

  // Derived from REQUIRED_STATUS_OPTIONS so a newly derived status cannot be
  // added without its fail-closed configuration case.
  it.each([...REQUIRED_STATUS_OPTIONS])(
    "names an omitted or blank %s option id before the first request",
    async (missing) => {
      for (const mode of ["missing", "empty", "whitespace"]) {
        const optionIds = optionIdFixture();
        if (mode === "missing") delete optionIds[missing];
        else optionIds[missing] = mode === "empty" ? "" : "   ";
        const request = vi.fn();
        await expect(
          main({
            env: validEnv({ STATUS_OPTION_IDS: JSON.stringify(optionIds) }),
            request,
            logger: { log: vi.fn() },
          }),
        ).rejects.toMatchObject({
          name: "ProjectStatusSyncConfigurationError",
          variable: "STATUS_OPTION_IDS",
          message: expect.stringContaining(`must contain a non-empty option id for ${missing}`),
        });
        expect(request, `${mode} ${missing} reached the network`).not.toHaveBeenCalled();
      }
    },
  );

  it("accepts the expanded live variable and tolerates its lane-owned extras", () => {
    const { optionIds } = readConfiguration(validEnv({ STATUS_OPTION_IDS: JSON.stringify(LIVE_EXPANDED_OPTION_IDS) }));

    for (const status of REQUIRED_STATUS_OPTIONS) {
      expect(optionIds[status], `the live variable carries no option id for ${status}`).toBe(
        LIVE_EXPANDED_OPTION_IDS[status],
      );
    }
    expect(Object.keys(optionIds).filter((key) => !REQUIRED_STATUS_OPTIONS.includes(key))).toEqual([
      "In lane",
      "In review",
    ]);
  });

  // The exact variable value read live on 2026-08-08, before the pre-merge
  // operator window. Landing the derivation without expanding the variable
  // must redden the very first scheduled run rather than sync partially.
  it("rejects the pre-expansion variable that omits Epic and Tracking, with zero requests", async () => {
    const preExpansion = { ...LIVE_EXPANDED_OPTION_IDS };
    delete preExpansion.Epic;
    delete preExpansion.Tracking;
    const request = vi.fn();

    await expect(
      main({ env: validEnv({ STATUS_OPTION_IDS: JSON.stringify(preExpansion) }), request, logger: { log: vi.fn() } }),
    ).rejects.toMatchObject({
      name: "ProjectStatusSyncConfigurationError",
      variable: "STATUS_OPTION_IDS",
      message: expect.stringContaining("must contain a non-empty option id for Epic"),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects syntactically valid but wrong-shaped STATUS_OPTION_IDS", () => {
    expect(() => readConfiguration(validEnv({ STATUS_OPTION_IDS: "[]" }))).toThrowError(
      expect.objectContaining({
        name: "ProjectStatusSyncConfigurationError",
        variable: "STATUS_OPTION_IDS",
        message: expect.stringContaining("JSON object"),
      }),
    );
  });
});

describe("authoritative collection completeness", () => {
  it("follows the project item cursor through page two and reconciles totalCount", async () => {
    const first = boardNode({ id: "item-1", number: 1 });
    const second = boardNode({ id: "item-2", number: 2 });
    const { request, requests } = scriptedRequest(({ query, variables }) => {
      expect(query).toBe(ITEMS_QUERY);
      return variables.after === null
        ? itemPage([first], { totalCount: 2, hasNextPage: true, endCursor: "item-page-2" })
        : itemPage([second], { totalCount: 2 });
    });

    const result = await collectProjectItems({ request, project: "project-id", token: "token" });

    expect(result.totalCount).toBe(2);
    expect(result.items.map(({ issue: itemIssue }) => itemIssue.number)).toEqual([1, 2]);
    expect(requests.map(({ variables }) => variables.after)).toEqual([null, "item-page-2"]);
  });

  it("uses a decisive kind:* label from page two before classifying", async () => {
    const node = boardNode({
      status: "Backlog",
      labels: labelConnection(["priority:p1", "area:catalog"], {
        totalCount: 3,
        hasNextPage: true,
        endCursor: "label-page-2",
      }),
    });
    const { request } = scriptedRequest(({ query, variables }) => {
      if (query === ITEMS_QUERY) return itemPage([node]);
      expect(query).toBe(LABELS_QUERY);
      expect(variables).toEqual({ issue: "issue-1", after: "label-page-2" });
      return { node: { labels: labelConnection(["kind:product"], { totalCount: 3 }) } };
    });

    const { items } = await collectProjectItems({ request, project: "project-id", token: "token" });

    expect(items[0].issue.labels).toEqual(["priority:p1", "area:catalog", "kind:product"]);
    expect(planStatusUpdates(items)).toEqual([{ itemId: "item-1", number: 1, from: "Backlog", to: "Refined" }]);
  });

  it("aborts an item totalCount mismatch with zero mutations", async () => {
    const { request, requests } = scriptedRequest(() => itemPage([boardNode()], { totalCount: 2 }));

    await expect(main({ env: validEnv(), request, logger: { log: vi.fn() } })).rejects.toMatchObject({
      name: "ProjectStatusSyncCollectionError",
      scope: "project items",
      message: expect.stringContaining("aborted: collected 1 of totalCount 2"),
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("aborts a label totalCount mismatch after page two with zero mutations", async () => {
    const node = boardNode({
      labels: labelConnection(["priority:p1", "area:catalog"], {
        totalCount: 3,
        hasNextPage: true,
        endCursor: "label-page-2",
      }),
    });
    const { request, requests } = scriptedRequest(({ query }) => {
      if (query === ITEMS_QUERY) return itemPage([node]);
      return { node: { labels: labelConnection([], { totalCount: 3 }) } };
    });

    await expect(main({ env: validEnv(), request, logger: { log: vi.fn() } })).rejects.toMatchObject({
      name: "ProjectStatusSyncCollectionError",
      scope: "labels for issue #1",
      message: expect.stringContaining("aborted: collected 2 of totalCount 3"),
    });
    expect(mutationRequests(requests)).toEqual([]);
    expect(requests.map(({ query }) => (query.includes("mutation") ? "mutation" : "read"))).toEqual(["read", "read"]);
  });

  it("finishes every item's label proof before the first write", async () => {
    const complete = boardNode({ id: "item-1", number: 1, status: "Backlog" });
    const incomplete = boardNode({
      id: "item-2",
      number: 2,
      labels: labelConnection(["priority:p1"], { totalCount: 2 }),
    });
    const { request, requests } = scriptedRequest(() => itemPage([complete, incomplete]));

    await expect(main({ env: validEnv(), request, logger: { log: vi.fn() } })).rejects.toMatchObject({
      name: "ProjectStatusSyncCollectionError",
      scope: "labels for issue #2",
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("aborts an unsafe project-item cursor with zero mutations", async () => {
    const { request, requests } = scriptedRequest(() =>
      itemPage([boardNode()], { totalCount: 2, hasNextPage: true, endCursor: null }),
    );
    await expect(main({ env: validEnv(), request, logger: { log: vi.fn() } })).rejects.toMatchObject({
      name: "ProjectStatusSyncCollectionError",
      message: expect.stringContaining("without a new safe cursor"),
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("aborts an unsafe label cursor with zero mutations", async () => {
    const node = boardNode({
      labels: labelConnection(["priority:p1"], { totalCount: 2, hasNextPage: true, endCursor: "" }),
    });
    const { request, requests } = scriptedRequest(() => itemPage([node]));
    await expect(main({ env: validEnv(), request, logger: { log: vi.fn() } })).rejects.toMatchObject({
      name: "ProjectStatusSyncCollectionError",
      scope: "labels for issue #1",
      message: expect.stringContaining("without a new safe cursor"),
    });
    expect(mutationRequests(requests)).toEqual([]);
  });

  it("makes dry-run mutation-impossible while returning the exact planned operation set", async () => {
    const node = boardNode({ milestone: null, status: "Refined", targetDate: "2026-08-12" });
    const { request, requests } = scriptedRequest(() => itemPage([node]));
    const logger = { log: vi.fn() };

    const result = await main({ env: validEnv(), request, logger, dryRun: true });

    expect(result.statusUpdates).toEqual([{ itemId: "item-1", number: 1, from: "Refined", to: "Backlog" }]);
    expect(result.dateUpdates).toEqual([{ type: "clear", itemId: "item-1", number: 1, from: "2026-08-12", to: null }]);
    expect(mutationRequests(requests)).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("DRY RUN: 1 project items verified"));
  });
});

// scripts/check-structure/skill-mirror.test.mjs proves .agents and .claude stay
// byte-identical; this proves the sentence they must both carry actually says
// the ownership rule, in the repository contract and in both mirrored trees.
describe("derived board-status ownership contract", () => {
  const backlogModelPath = path.join(repoRoot, "docs", "contributing", "backlog-model.md");
  const skillContractFiles = [".agents", ".claude"].flatMap((root) =>
    ["skills/planning/SKILL.md", "skills/planning/references/issue-standard.md", "skills/delivery/SKILL.md"].map(
      (file) => `${root}/${file}`,
    ),
  );
  const contractFiles = ["docs/contributing/backlog-model.md", ...skillContractFiles];
  const probes = [
    { name: "native Epic projects to Epic", pattern: /a native \*\*Epic\*\* projects to `Epic`/i },
    { name: "tracking-only projects to Tracking", pattern: /`status:tracking-only` projects to `Tracking`/ },
    { name: "Status is never hand-written", pattern: /never hand-written/ },
  ];

  it.each(contractFiles)("%s states every status/authority pair", (file) => {
    const text = readFileSync(path.join(repoRoot, ...file.split("/")), "utf8").replace(/\s+/g, " ");
    for (const { name, pattern } of probes) {
      expect(pattern.test(text), `${file} does not state: ${name}`).toBe(true);
    }
  });

  it("documents a precedence row for exactly the statuses the derivation emits", () => {
    const lines = readFileSync(backlogModelPath, "utf8").split("\n");
    const start = lines.findIndex((line) => line.startsWith("## Delivery-board Status is derived"));
    expect(start, "the derived-status section is missing from the backlog model").toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    const section = lines.slice(start, end === -1 ? lines.length : end);
    const documented = section
      .filter((line) => /^\| \d+ \|/.test(line))
      .map((line) => line.split("|")[3].trim().replaceAll("`", ""));

    expect(documented).toEqual(["Landed", "Canceled", "Epic", "Tracking", "Blocked", "Refined", "Backlog"]);
    expect([...documented].sort()).toEqual([...REQUIRED_STATUS_OPTIONS].sort());
  });

  it("keeps the board's option ids out of the repository contract and both skill trees", () => {
    for (const file of contractFiles) {
      const text = readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
      for (const optionId of Object.values(LIVE_EXPANDED_OPTION_IDS)) {
        expect(text.includes(optionId), `${file} embeds board option id ${optionId}`).toBe(false);
      }
    }
  });
});

describe("enforcing workflow contract", () => {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "project-status-sync.yml");
  const workflow = parse(readFileSync(workflowPath, "utf8"));
  const boardVariables = [
    "DELIVERY_PROJECT_ID",
    "DELIVERY_STATUS_FIELD_ID",
    "DELIVERY_STATUS_OPTION_IDS",
    "DELIVERY_TARGET_DATE_FIELD_ID",
  ];
  const enforcingJobs = Object.values(workflow.jobs).filter((job) =>
    job.steps?.some(
      (step) =>
        typeof step.run === "string" &&
        step.env &&
        ["PROJECT_ID", "STATUS_FIELD_ID", "STATUS_OPTION_IDS", "TARGET_DATE_FIELD_ID"].every((name) =>
          Object.hasOwn(step.env, name),
        ),
    ),
  );

  it("selects exactly one real enforcement path by workflow shape", () => {
    expect(enforcingJobs).toHaveLength(1);
    const enforcingSteps = enforcingJobs[0].steps.filter((step) => typeof step.run === "string");
    expect(enforcingSteps).toHaveLength(1);
    expect(enforcingSteps[0].run).toBe("node ./scripts/project-status-sync.mjs");
  });

  it("skips only a wholly unconfigured repository and runs every partial configuration", () => {
    const expected = `\${{ ${boardVariables.map((name) => `vars.${name} != ''`).join(" || ")} }}`;
    expect(enforcingJobs[0].if).toBe(expected);
    const wouldRun = (variables) => boardVariables.some((name) => (variables[name] ?? "") !== "");
    expect(wouldRun({})).toBe(false);
    for (const variable of boardVariables) expect(wouldRun({ [variable]: "configured" })).toBe(true);
    expect(wouldRun(Object.fromEntries(boardVariables.map((name) => [name, "configured"])))).toBe(true);
  });

  it("has no advisory escape hatch on the enforcing job or its steps", () => {
    expect(enforcingJobs[0]["continue-on-error"]).toBeUndefined();
    for (const step of enforcingJobs[0].steps) {
      expect(step["continue-on-error"]).toBeUndefined();
      if (typeof step.run === "string") expect(step.run.trim()).not.toMatch(/(?:^|\n)\s*exit\s+0\s*$/);
    }
  });

  it("propagates a named script failure as exit 1", () => {
    const result = spawnSync(process.execPath, ["./scripts/project-status-sync.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      env: validEnv({ TARGET_DATE_FIELD_ID: "" }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ProjectStatusSyncConfigurationError");
    expect(result.stderr).toContain("[configuration:TARGET_DATE_FIELD_ID]");
    expect(result.stdout).not.toContain("items verified");
  });
});
