import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { classified } from "./backlog-classify.mjs";
import {
  collectProjectItems,
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

function validEnv(overrides = {}) {
  return {
    GITHUB_TOKEN: "test-token",
    PROJECT_ID: "project-id",
    STATUS_FIELD_ID: "status-field-id",
    STATUS_OPTION_IDS: JSON.stringify({
      Backlog: "backlog-id",
      Refined: "refined-id",
      Blocked: "blocked-id",
    }),
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

  it("preserves Epic no-op behavior and native-type precedence", () => {
    expect(deriveStatus(issue({ labels: [{ name: "kind:epic" }] }))).toBeNull();
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

  it("does not rewrite a closed item's terminal snapshot", () => {
    expect(
      planStatusUpdates([{ itemId: "a", status: "Refined", issue: issue({ number: 6150, state: "closed" }) }]),
    ).toEqual([]);
  });

  it("skips tracking-only items instead of deriving Backlog", () => {
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
    expect(deriveStatus(trackingOnly)).toBeNull();
    expect(planStatusUpdates([{ itemId: "a", status: "Refined", issue: trackingOnly }])).toEqual([]);
  });

  it("derives truthful parent state through the board query path", () => {
    expect(ITEMS_QUERY).toContain("parent { number }");
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

  it("names every required status omitted from STATUS_OPTION_IDS before the first request", async () => {
    for (const missing of ["Backlog", "Refined", "Blocked"]) {
      const optionIds = { Backlog: "backlog", Refined: "refined", Blocked: "blocked" };
      delete optionIds[missing];
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
        message: expect.stringContaining(missing),
      });
      expect(request).not.toHaveBeenCalled();
    }
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
