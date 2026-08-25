import { describe, expect, it, vi } from "vitest";
import {
  BLOCKED_BY_QUERY,
  BLOCKING_QUERY,
  FAIL_CLOSED_GUARD_IDS,
  ISSUES_QUERY,
  LABELS_QUERY,
  DispatchDependencySnapshotError,
  collectStableDependencyFacts,
  githubGraphql,
  isLocalEpic,
  isLocalTrackingOnly,
  reduceOpenBlockerFacts,
  reduceUnlockCounts,
} from "./dispatch-unlock-count.mjs";

const OWNER = "synthetic";
const REPOSITORY = "local";
const NAME_WITH_OWNER = `${OWNER}/${REPOSITORY}`;

function connection(nodes = [], { totalCount = nodes.length, hasNextPage = false, endCursor = null } = {}) {
  return { totalCount, pageInfo: { hasNextPage, endCursor }, nodes };
}

function label(name, id = `label:${name}`) {
  return { id, name };
}

function edge({ id, number, state = "OPEN", repository = NAME_WITH_OWNER }) {
  return { id, number, state, repository: { nameWithOwner: repository } };
}

function issue({
  id,
  number,
  state = "OPEN",
  issueType = { name: "Slice" },
  milestone = { id: "wave-1", number: 1, title: "Wave 1", state: "OPEN" },
  labels = connection([]),
  blocking = connection([]),
  blockedBy = connection([]),
  issueDependenciesSummary = {
    blocking: blocking.nodes.filter((value) => value.state === "OPEN").length,
    totalBlocking: blocking.totalCount,
    blockedBy: blockedBy.nodes.filter((value) => value.state === "OPEN").length,
    totalBlockedBy: blockedBy.totalCount,
  },
} = {}) {
  return { id, number, state, issueType, milestone, labels, issueDependenciesSummary, blocking, blockedBy };
}

function snapshot(issues) {
  return {
    schemaVersion: "dispatch-dependency-snapshot/v1",
    repository: { nameWithOwner: NAME_WITH_OWNER, totalCount: issues.length, issues },
  };
}

function rootResponse(nodes, options = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: NAME_WITH_OWNER,
        issues: connection(nodes, options),
      },
    },
  };
}

function nestedResponse(issueId, name, nodes, options = {}) {
  return { data: { node: { id: issueId, [name]: connection(nodes, options) } } };
}

function rootCaptureRequest(captures) {
  let capture = -1;
  return vi.fn(async (query, variables) => {
    if (query !== ISSUES_QUERY || variables.after !== null) {
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    }
    capture += 1;
    return rootResponse(captures[capture]);
  });
}

function collectorErrorRequest(payload) {
  return vi.fn(async () => payload);
}

function expectFailure(error, reason) {
  expect(error).toBeInstanceOf(DispatchDependencySnapshotError);
  expect(error.reason).toBe(reason);
}

describe("dispatch dependency snapshot", () => {
  it("computes unique transitive unlock counts under every pinned graph boundary", () => {
    const a = issue({
      id: "A",
      number: 1,
      blocking: connection([edge({ id: "B", number: 2 }), edge({ id: "C", number: 3 })]),
    });
    const b = issue({
      id: "B",
      number: 2,
      blocking: connection([edge({ id: "D", number: 4 }), edge({ id: "E", number: 5 })]),
    });
    const c = issue({
      id: "C",
      number: 3,
      blocking: connection([
        edge({ id: "D", number: 4 }),
        edge({ id: "F", number: 6 }),
        edge({ id: "closed", number: 7, state: "CLOSED" }),
        edge({ id: "foreign", number: 8, repository: "synthetic/external" }),
      ]),
    });
    const d = issue({ id: "D", number: 4, blocking: connection([edge({ id: "A", number: 1 })]) });
    const e = issue({
      id: "E",
      number: 5,
      issueType: { name: "Epic" },
      blocking: connection([edge({ id: "G", number: 9 })]),
    });
    const f = issue({
      id: "F",
      number: 6,
      labels: connection([label("status:tracking-only")]),
      blocking: connection([edge({ id: "H", number: 10 })]),
    });
    const g = issue({
      id: "G",
      number: 9,
      milestone: { id: "operations", number: 2, title: "Operations", state: "OPEN" },
    });
    const h = issue({ id: "H", number: 10, milestone: null });
    const counts = reduceUnlockCounts(snapshot([a, b, c, d, e, f, g, h]));

    expect(counts).toEqual([
      { issueId: "A", issueNumber: 1, unlockCount: 4 },
      { issueId: "B", issueNumber: 2, unlockCount: 4 },
      { issueId: "C", issueNumber: 3, unlockCount: 4 },
      { issueId: "D", issueNumber: 4, unlockCount: 4 },
      { issueId: "F", issueNumber: 6, unlockCount: 1 },
      { issueId: "G", issueNumber: 9, unlockCount: 0 },
      { issueId: "H", issueNumber: 10, unlockCount: 0 },
    ]);
  });

  it("preserves foreign incoming blockers without local-root inversion", () => {
    const local = issue({
      id: "synthetic/local#2",
      number: 2,
      blockedBy: connection([
        edge({ id: "synthetic/external#1", number: 1, repository: "synthetic/external" }),
        edge({ id: "synthetic/closed#3", number: 3, state: "CLOSED", repository: "synthetic/external" }),
      ]),
    });
    expect(reduceOpenBlockerFacts(snapshot([local]))).toEqual([
      {
        issueId: "synthetic/local#2",
        issueNumber: 2,
        openBlockerCount: 1,
        openBlockers: [{ id: "synthetic/external#1", number: 1, repository: { nameWithOwner: "synthetic/external" } }],
      },
    ]);
    expect(reduceOpenBlockerFacts(snapshot([issue({ id: "synthetic/local#2", number: 2 })]))[0].openBlockerCount).toBe(
      0,
    );
  });

  it("requires consecutive identical complete graph digests before both projections", async () => {
    const first = issue({
      id: "local-2",
      number: 2,
      labels: connection([label("kind:ops", "b"), label("area:ops", "a")]),
      blocking: connection([edge({ id: "local-3", number: 3 }), edge({ id: "local-4", number: 4 })]),
      blockedBy: connection([edge({ id: "external-1", number: 1, repository: "synthetic/external" })]),
    });
    const target3 = issue({ id: "local-3", number: 3 });
    const target4 = issue({ id: "local-4", number: 4 });
    const request = rootCaptureRequest([
      [first, target4, target3],
      [
        target3,
        target4,
        {
          ...first,
          labels: connection([...first.labels.nodes].reverse()),
          blocking: connection([...first.blocking.nodes].reverse()),
        },
      ],
    ]);
    const unlockReducer = vi.fn(reduceUnlockCounts);
    const blockerReducer = vi.fn(reduceOpenBlockerFacts);
    const result = await collectStableDependencyFacts({
      request,
      owner: OWNER,
      repository: REPOSITORY,
      unlockReducer,
      blockerReducer,
    });

    expect(result.attempts).toBe(2);
    expect(result.requestCount).toBe(2);
    expect(unlockReducer).toHaveBeenCalledTimes(1);
    expect(blockerReducer).toHaveBeenCalledTimes(1);
    expect(result.blockerFacts.find((value) => value.issueId === "local-2")?.openBlockerCount).toBe(1);

    const target5 = issue({ id: "local-5", number: 5 });
    const replacement = rootCaptureRequest([
      [first, target3, target4],
      [
        target3,
        target4,
        target5,
        { ...first, blocking: connection([edge({ id: "local-3", number: 3 }), edge({ id: "local-5", number: 5 })]) },
      ],
      [first, target3, target4],
    ]);
    await expect(
      collectStableDependencyFacts({ request: replacement, owner: OWNER, repository: REPOSITORY }),
    ).rejects.toMatchObject({
      code: "unstable-authority",
    });

    const recovery = rootCaptureRequest([
      [first, target3, target4],
      [target3, target4, { ...first, issueDependenciesSummary: { ...first.issueDependenciesSummary, blockedBy: 99 } }],
      [target4, { ...first, issueDependenciesSummary: { ...first.issueDependenciesSummary, blockedBy: 99 } }, target3],
    ]);
    await expect(
      collectStableDependencyFacts({ request: recovery, owner: OWNER, repository: REPOSITORY }),
    ).resolves.toMatchObject({ attempts: 3 });
  });

  it("fails closed until every authoritative dependency connection is complete", async () => {
    const valid = issue({ id: "local-1", number: 1 });
    const cases = [
      {
        name: "root exhausted count",
        guard: "exact-exhausted-count",
        reason: "exhausted-count-mismatch",
        response: rootResponse([], { totalCount: 1 }),
      },
      {
        name: "root cursor proof",
        guard: "safe-new-cursor",
        reason: "unsafe-cursor",
        response: rootResponse([valid], { hasNextPage: true, endCursor: null }),
      },
      {
        name: "recursive label schema",
        guard: "closed-provider-object",
        reason: "invalid-provider-schema",
        response: rootResponse([
          {
            ...valid,
            labels: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [], extra: true },
          },
        ]),
      },
      {
        name: "incoming exhausted count",
        guard: "exact-exhausted-count",
        reason: "exhausted-count-mismatch",
        response: rootResponse([{ ...valid, blockedBy: connection([], { totalCount: 1 }) }]),
      },
      {
        name: "outgoing page size",
        guard: "page-size-bound",
        reason: "page-size-exceeded",
        response: rootResponse([
          {
            ...valid,
            blocking: connection(
              Array.from({ length: 101 }, (_, index) => edge({ id: `edge-${index}`, number: index + 2 })),
              { totalCount: 101 },
            ),
          },
        ]),
      },
      {
        name: "root total count changes after page one",
        guard: "stable-total-count",
        reason: "changed-total-count",
        scope: "repository.issues",
        request: vi.fn(async (query, variables) => {
          if (query !== ISSUES_QUERY) throw new Error("unexpected nested query");
          if (variables.after === null) {
            return rootResponse([], { totalCount: 1, hasNextPage: true, endCursor: "root-page-2" });
          }
          if (variables.after === "root-page-2") return rootResponse([], { totalCount: 2 });
          throw new Error(`unexpected root cursor ${variables.after}`);
        }),
      },
      {
        name: "nested total count changes after page one",
        guard: "stable-total-count",
        reason: "changed-total-count",
        scope: "labels for issue local-1",
        request: vi.fn(async (query, variables) => {
          if (query === ISSUES_QUERY && variables.after === null) {
            return rootResponse([
              {
                ...valid,
                labels: connection([label("kind:ops", "label-first")], {
                  totalCount: 2,
                  hasNextPage: true,
                  endCursor: "labels-page-2",
                }),
              },
            ]);
          }
          if (query === LABELS_QUERY && variables.issue === "local-1" && variables.after === "labels-page-2") {
            return nestedResponse("local-1", "labels", [label("area:ops", "label-second")], { totalCount: 3 });
          }
          throw new Error("unexpected request");
        }),
      },
      {
        name: "repeated label identity changes facts",
        guard: "consistent-repeated-label-facts",
        reason: "repeated-label-facts",
        scope: "labels for issue local-2",
        response: rootResponse([
          issue({ id: "local-1", number: 1, labels: connection([label("kind:ops", "shared-label")]) }),
          issue({ id: "local-2", number: 2, labels: connection([label("area:ops", "shared-label")]) }),
        ]),
      },
      {
        name: "repeated dependency identity changes facts",
        guard: "consistent-repeated-target-facts",
        reason: "repeated-target-facts",
        scope: "dependencies for issue local-2",
        response: rootResponse([
          issue({
            id: "local-1",
            number: 1,
            blocking: connection([edge({ id: "shared-target", number: 3, repository: "synthetic/external" })]),
          }),
          issue({
            id: "local-2",
            number: 2,
            blockedBy: connection([
              edge({ id: "shared-target", number: 3, state: "CLOSED", repository: "synthetic/external" }),
            ]),
          }),
        ]),
      },
      {
        name: "open local edge has no root",
        guard: "local-edge-root-closure",
        reason: "referential-closure",
        scope: "blocking for issue local-1",
        response: rootResponse([
          issue({ id: "local-1", number: 1, blocking: connection([edge({ id: "missing-local", number: 2 })]) }),
        ]),
      },
      {
        name: "nested page changes parent identity",
        guard: "nested-parent-identity",
        reason: "invalid-provider-schema",
        scope: "data.node.id",
        request: vi.fn(async (query, variables) => {
          if (query === ISSUES_QUERY && variables.after === null) {
            return rootResponse([
              {
                ...valid,
                labels: connection([], { totalCount: 1, hasNextPage: true, endCursor: "labels-page-2" }),
              },
            ]);
          }
          if (query === LABELS_QUERY && variables.issue === "local-1" && variables.after === "labels-page-2") {
            return nestedResponse("different-parent", "labels", [label("kind:ops")], { totalCount: 1 });
          }
          throw new Error("unexpected request");
        }),
      },
      {
        name: "root repository identity changes",
        guard: "root-repository-and-state",
        reason: "invalid-provider-schema",
        scope: "data.repository.nameWithOwner",
        response: {
          data: {
            repository: { nameWithOwner: "synthetic/external", issues: connection([valid]) },
          },
        },
      },
      {
        name: "root collection includes a closed issue",
        guard: "root-repository-and-state",
        reason: "invalid-provider-schema",
        scope: "repository.issues.nodes[0].state",
        response: rootResponse([{ ...valid, state: "CLOSED" }]),
      },
      {
        name: "issue number is outside the provider scalar domain",
        guard: "provider-scalar-domain",
        reason: "invalid-provider-schema",
        scope: "repository.issues.nodes[0].number",
        response: rootResponse([{ ...valid, number: 0 }]),
      },
      {
        name: "connection total is outside the provider scalar domain",
        guard: "provider-scalar-domain",
        reason: "invalid-provider-schema",
        scope: "repository.issues.totalCount",
        response: rootResponse([valid], { totalCount: -1 }),
      },
      {
        name: "issue id is outside the provider scalar domain",
        guard: "provider-scalar-domain",
        reason: "invalid-provider-schema",
        scope: "repository.issues.nodes[0].id",
        response: rootResponse([{ ...valid, id: "" }]),
      },
    ];
    for (const testCase of cases) {
      const unlockReducer = vi.fn();
      const blockerReducer = vi.fn();
      try {
        await collectStableDependencyFacts({
          request: testCase.request ?? collectorErrorRequest(testCase.response),
          owner: OWNER,
          repository: REPOSITORY,
          unlockReducer,
          blockerReducer,
        });
        throw new Error(`${testCase.name} unexpectedly accepted`);
      } catch (error) {
        expectFailure(error, testCase.reason);
        if (testCase.scope !== undefined) {
          expect(error.scope).toBe(testCase.scope);
          expect(error.message).toContain(`:${testCase.scope}]`);
        }
      }
      expect(unlockReducer).not.toHaveBeenCalled();
      expect(blockerReducer).not.toHaveBeenCalled();
    }

    // The inventory is deliberately stable. The table above discriminates every
    // connection-completeness, provider-scope, and scalar-domain guard it names;
    // companion tests pin the envelope, identity, stability, and reducer guards.
    expect(new Set(cases.map((testCase) => testCase.guard))).toEqual(
      new Set([
        "closed-provider-object",
        "provider-scalar-domain",
        "root-repository-and-state",
        "page-size-bound",
        "safe-new-cursor",
        "stable-total-count",
        "exact-exhausted-count",
        "nested-parent-identity",
        "consistent-repeated-label-facts",
        "consistent-repeated-target-facts",
        "local-edge-root-closure",
      ]),
    );
    expect(FAIL_CLOSED_GUARD_IDS).toEqual([
      "graphql-response-envelope",
      "closed-provider-object",
      "provider-scalar-domain",
      "root-repository-and-state",
      "page-size-bound",
      "safe-new-cursor",
      "stable-total-count",
      "unique-case-sensitive-identity",
      "exact-exhausted-count",
      "nested-parent-identity",
      "consistent-repeated-label-facts",
      "consistent-repeated-target-facts",
      "local-edge-root-closure",
      "consecutive-digest-stability",
      "accepted-snapshot-reducer-boundary",
    ]);
  });

  it("keeps case-sensitive identities and every consumed fact fail-closed", async () => {
    const duplicateLabelId = "synthetic-label";
    const duplicateIdentity = issue({
      id: "local-duplicate",
      number: 1,
      labels: connection([label("kind:ops", duplicateLabelId), label("kind:ops", duplicateLabelId)], {
        totalCount: 2,
      }),
    });
    const duplicateUnlockReducer = vi.fn();
    const duplicateBlockerReducer = vi.fn();

    await expect(
      collectStableDependencyFacts({
        request: collectorErrorRequest(rootResponse([duplicateIdentity])),
        owner: OWNER,
        repository: REPOSITORY,
        unlockReducer: duplicateUnlockReducer,
        blockerReducer: duplicateBlockerReducer,
      }),
    ).rejects.toMatchObject({ reason: "duplicate-node-identity" });
    expect(duplicateUnlockReducer).not.toHaveBeenCalled();
    expect(duplicateBlockerReducer).not.toHaveBeenCalled();

    const caseDistinctIdentity = issue({
      id: "local-case-distinct",
      number: 2,
      labels: connection([label("kind:ops", "Label-A"), label("area:ops", "label-a")], { totalCount: 2 }),
    });
    await expect(
      collectStableDependencyFacts({
        request: rootCaptureRequest([[caseDistinctIdentity], [caseDistinctIdentity]]),
        owner: OWNER,
        repository: REPOSITORY,
      }),
    ).resolves.toMatchObject({ attempts: 2 });

    const base = issue({ id: "local-retention", number: 3 });
    const changedSummary = {
      ...base,
      issueDependenciesSummary: { ...base.issueDependenciesSummary, blocking: 1 },
    };
    const changedAgain = {
      ...base,
      issueDependenciesSummary: { ...base.issueDependenciesSummary, blocking: 2 },
    };
    const retentionUnlockReducer = vi.fn();
    const retentionBlockerReducer = vi.fn();

    await expect(
      collectStableDependencyFacts({
        request: rootCaptureRequest([[base], [changedSummary], [changedAgain]]),
        owner: OWNER,
        repository: REPOSITORY,
        unlockReducer: retentionUnlockReducer,
        blockerReducer: retentionBlockerReducer,
      }),
    ).rejects.toMatchObject({ code: "unstable-authority" });
    expect(retentionUnlockReducer).not.toHaveBeenCalled();
    expect(retentionBlockerReducer).not.toHaveBeenCalled();

    // These controls deliberately freeze every other provider fact. A bypass
    // mutant that removes unique-case-sensitive-identity accepts the duplicate
    // label, while one that folds identity case rejects the distinct pair. A
    // canonical-retention mutant that drops this consumed summary scalar accepts
    // the first two captures. Every named mutant makes this test red.
  });

  it("binds summaries without treating them as bidirectional edge authority", async () => {
    const current = issue({
      id: "local-2",
      number: 2,
      blocking: connection([edge({ id: "local-3", number: 3 })]),
      blockedBy: connection([edge({ id: "external-1", number: 1, repository: "synthetic/external" })]),
      issueDependenciesSummary: { blocking: 0, totalBlocking: 0, blockedBy: 0, totalBlockedBy: 0 },
    });
    const target = issue({ id: "local-3", number: 3 });
    const result = await collectStableDependencyFacts({
      request: rootCaptureRequest([
        [current, target],
        [target, current],
      ]),
      owner: OWNER,
      repository: REPOSITORY,
    });
    expect(result.unlockCounts.find((value) => value.issueId === "local-2")?.unlockCount).toBe(1);
    expect(result.blockerFacts.find((value) => value.issueId === "local-2")?.openBlockerCount).toBe(1);
    expect(result.diagnostics.summaryMismatches).toHaveLength(1);
  });

  it("classifies query-shaped nodes with local native-type and tracking predicates", () => {
    expect(isLocalEpic({ issueTypeName: "Epic", labels: [] })).toBe(true);
    expect(isLocalEpic({ issueTypeName: "Slice", labels: ["kind:epic"] })).toBe(false);
    expect(isLocalEpic({ issueTypeName: null, labels: ["kind:epic"] })).toBe(true);
    expect(isLocalEpic({ issueTypeName: null, labels: [] })).toBe(false);
    expect(isLocalTrackingOnly({ labels: ["status:tracking-only"] })).toBe(true);
    expect(isLocalTrackingOnly({ labels: [] })).toBe(false);
    expect(() => isLocalEpic({ issueTypeName: null, labels: [], blockedByCount: 0 })).toThrow("unexpected field");
  });

  it("collects bounded complete passes plus actual overflow only", async () => {
    const firstPageIssue = issue({
      id: "local-1",
      number: 1,
      blockedBy: connection([edge({ id: "external-1", number: 1, repository: "synthetic/external" })], {
        totalCount: 2,
        hasNextPage: true,
        endCursor: "blockedBy-page-2",
      }),
    });
    let rootCalls = 0;
    const request = vi.fn(async (query, variables) => {
      if (query === ISSUES_QUERY) {
        rootCalls += 1;
        return rootResponse([firstPageIssue]);
      }
      if (query === BLOCKED_BY_QUERY && variables.issue === "local-1" && variables.after === "blockedBy-page-2") {
        return nestedResponse(
          "local-1",
          "blockedBy",
          [edge({ id: "external-2", number: 2, repository: "synthetic/external" })],
          { totalCount: 2 },
        );
      }
      throw new Error("unexpected overflow request");
    });
    const result = await collectStableDependencyFacts({ request, owner: OWNER, repository: REPOSITORY });
    expect(rootCalls).toBe(2);
    expect(result).toMatchObject({ attempts: 2, requestCount: 4, rootPageCount: 2, overflowRequestCount: 2 });
    expect(result.blockerFacts[0].openBlockerCount).toBe(2);
  });

  it("executes LABELS and BLOCKING overflow queries on both complete passes", async () => {
    const overflowTarget = issue({ id: "local-overflow-target", number: 3 });
    const firstPageIssue = issue({
      id: "local-overflow",
      number: 1,
      labels: connection([label("kind:ops", "label-first")], {
        totalCount: 2,
        hasNextPage: true,
        endCursor: "labels-page-2",
      }),
      blocking: connection([edge({ id: "external-first", number: 2, repository: "synthetic/external" })], {
        totalCount: 2,
        hasNextPage: true,
        endCursor: "blocking-page-2",
      }),
    });
    const callsByQuery = new Map([
      [ISSUES_QUERY, 0],
      [LABELS_QUERY, 0],
      [BLOCKING_QUERY, 0],
      [BLOCKED_BY_QUERY, 0],
    ]);
    const request = vi.fn(async (query, variables) => {
      callsByQuery.set(query, (callsByQuery.get(query) ?? 0) + 1);
      if (query === ISSUES_QUERY && variables.after === null) return rootResponse([firstPageIssue, overflowTarget]);
      if (query === LABELS_QUERY && variables.issue === "local-overflow" && variables.after === "labels-page-2") {
        return nestedResponse("local-overflow", "labels", [label("area:ops", "label-second")], { totalCount: 2 });
      }
      if (query === BLOCKING_QUERY && variables.issue === "local-overflow" && variables.after === "blocking-page-2") {
        return nestedResponse("local-overflow", "blocking", [edge({ id: "local-overflow-target", number: 3 })], {
          totalCount: 2,
        });
      }
      throw new Error(`unexpected query ${query.slice(0, 40)} after ${variables.after}`);
    });

    const result = await collectStableDependencyFacts({ request, owner: OWNER, repository: REPOSITORY });

    expect(result).toMatchObject({ attempts: 2, requestCount: 6, rootPageCount: 2, overflowRequestCount: 4 });
    expect(result.unlockCounts.find((value) => value.issueId === "local-overflow")?.unlockCount).toBe(1);
    expect(callsByQuery).toEqual(
      new Map([
        [ISSUES_QUERY, 2],
        [LABELS_QUERY, 2],
        [BLOCKING_QUERY, 2],
        [BLOCKED_BY_QUERY, 0],
      ]),
    );

    // Non-governing connections are empty and all pages otherwise agree. The
    // local outgoing target appears only on page 2, so a BLOCKING-overflow bypass
    // loses an unlock; a LABELS-overflow bypass leaves its total unexhausted.
  });

  it("contains the complete GraphQL surface and rejects GraphQL errors or invalid JSON", async () => {
    for (const query of [ISSUES_QUERY, LABELS_QUERY, BLOCKING_QUERY, BLOCKED_BY_QUERY]) {
      expect(query).toContain("totalCount");
      expect(query).toContain("pageInfo");
      expect(query).toContain("nodes");
    }
    expect(ISSUES_QUERY).toContain("issueDependenciesSummary { blocking totalBlocking blockedBy totalBlockedBy }");
    expect(ISSUES_QUERY).toContain("blockedBy(first:100");
    await expect(
      collectStableDependencyFacts({
        request: collectorErrorRequest({ errors: [{ message: "refused" }] }),
        owner: OWNER,
        repository: REPOSITORY,
      }),
    ).rejects.toMatchObject({ code: "graphql-error" });
    await expect(
      githubGraphql("query", {}, "token", async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("bad json");
        },
      })),
    ).rejects.toMatchObject({
      code: "graphql-error",
    });
  });
});
