import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import {
  COMMENT_MARKER,
  ISSUE_READINESS_RULES,
  ISSUE_READINESS_SCHEMA_VERSION,
  PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION,
  consumeIssueReadinessReceipt,
  evaluateProspectiveIssueReadiness,
  main,
  parseIssueFormBody,
  validateIssueReadinessReceipt,
} from "./issue-readiness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/issue-readiness-v1.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("./issue-readiness-v1.schema.json", import.meta.url), "utf8"));
const REPOSITORY = fixture.recordedFrom.repository;
const ISSUE_NUMBER = fixture.recordedFrom.issue;
const ISSUE_NODE_ID = fixture.recordedFrom.restNodeId;
const REPOSITORY_DATABASE_ID = fixture.recordedFrom.repositoryDatabaseId;
const TYPE = fixture.recordedFrom.issueType;
const UPDATED_AT = "2026-07-29T19:02:27.000Z";
const CHECKED_AT = new Date("2026-07-29T19:04:00.000Z");
const CHECKER_SHA = "a".repeat(40);
const LABELS = ["priority:p1", "area:ops", "kind:tech-debt"];
const MILESTONE = {
  number: 136,
  title: "Wave 1 — Platform Foundation & Representative Staging",
  state: "open",
};

function replaceField(body, label, value) {
  const heading = `### ${label}`;
  const start = body.indexOf(heading);
  if (start === -1) throw new Error(`Fixture field not found: ${label}`);
  const contentStart = start + heading.length;
  const next = body.indexOf("\n### ", contentStart);
  const end = next === -1 ? body.length : next;
  return `${body.slice(0, contentStart)}\n\n${value}\n${body.slice(end)}`;
}

function scenarioBody(scenario) {
  let body = scenario.body ?? fixture.readyBody;
  if (scenario.replaceField) {
    body = replaceField(body, scenario.replaceField.label, scenario.replaceField.value);
  }
  if (scenario.replaceField2) {
    body = replaceField(body, scenario.replaceField2.label, scenario.replaceField2.value);
  }
  if (scenario.appendBody) body += scenario.appendBody;
  return body;
}

function dependenciesFor(scenario) {
  const definitions = scenario.dependencyPages ?? [];
  let number = 7000;
  return definitions.map((page) =>
    Array.from({ length: page.count }, () => {
      number += 1;
      return {
        url: `https://api.github.com/repos/${REPOSITORY}/issues/${number}`,
        node_id: `dependency-${number}`,
        number,
        state: page.state,
        updated_at: UPDATED_AT,
        type: {
          id: TYPE.id,
          node_id: TYPE.nodeId,
          name: "Slice",
          is_enabled: true,
        },
      };
    }),
  );
}

function response(payload, { status = 200, link = null, url = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === "link" ? link : null;
      },
    },
    async json() {
      return payload;
    },
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

function botComment(id, body, updatedAt = UPDATED_AT) {
  return {
    id,
    node_id: `comment-${id}`,
    body,
    created_at: updatedAt,
    updated_at: updatedAt,
    user: { login: "github-actions[bot]", type: "Bot" },
  };
}

function createHarness(scenario, { comments = [] } = {}) {
  const requests = [];
  const logs = [];
  const errors = [];
  const dependencyPages = dependenciesFor(scenario);
  const dependencies = dependencyPages.flat();
  let issueReads = 0;
  let commentState = [...comments];
  let authorityUpdatedAt = scenario.initialUpdatedAt ?? UPDATED_AT;
  const issueTypeName = scenario.issueType ?? "Slice";
  const issueType =
    issueTypeName === null
      ? null
      : {
          id: TYPE.id,
          node_id: issueTypeName === "Slice" ? TYPE.nodeId : `type-${issueTypeName}`,
          name: issueTypeName,
          is_enabled: true,
        };

  function currentUpdatedAt() {
    return issueReads >= 2 && scenario.finalUpdatedAt ? scenario.finalUpdatedAt : authorityUpdatedAt;
  }

  function issuePayload() {
    return {
      node_id: ISSUE_NODE_ID,
      number: ISSUE_NUMBER,
      state: "open",
      updated_at: currentUpdatedAt(),
      body: scenarioBody(scenario),
      type: issueType,
      milestone: MILESTONE,
      comments: commentState.length,
      issue_dependencies_summary: {
        blocked_by: dependencies.filter((item) => item.state === "open").length,
        total_blocked_by: dependencies.length,
      },
      repository: scenario.repositoryOverride ? { full_name: scenario.repositoryOverride } : null,
    };
  }

  function graphPayload() {
    return {
      data: {
        repository: {
          databaseId: REPOSITORY_DATABASE_ID,
          issue: {
            id: ISSUE_NODE_ID,
            number: ISSUE_NUMBER,
            state: "OPEN",
            updatedAt: authorityUpdatedAt,
            issueType: issueType
              ? { id: issueType.node_id, name: issueType.name, isEnabled: issueType.is_enabled }
              : null,
            parent: scenario.noParent ? null : { number: 5496 },
            labels: {
              totalCount: scenario.labelsTotalOverride ?? LABELS.length,
              pageInfo: { hasNextPage: LABELS.length > 1, endCursor: "cursor" },
            },
            blockedBy: {
              totalCount: dependencies.length,
              pageInfo: { hasNextPage: dependencies.length > 1, endCursor: "cursor" },
            },
            comments: {
              totalCount: commentState.length,
              pageInfo: { hasNextPage: commentState.length > 1, endCursor: "cursor" },
            },
          },
        },
      },
    };
  }

  const logger = {
    log(message) {
      logs.push(message);
    },
    error(message) {
      errors.push(message);
    },
  };

  const client = async (url, init = {}) => {
    requests.push({ url, init });
    const method = init.method ?? "GET";
    if (url === "https://api.github.com/graphql") return response(graphPayload());
    if (url === `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
      issueReads += 1;
      return response(issuePayload(), {
        url: issueReads >= 2 && scenario.finalResponseUrlOverride ? scenario.finalResponseUrlOverride : url,
      });
    }
    if (url.includes(`/issues/${ISSUE_NUMBER}/labels?`)) return response(LABELS.map((name) => ({ name })));
    if (url.includes(`/issues/${ISSUE_NUMBER}/dependencies/blocked_by?`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const payload = dependencyPages[page - 1] ?? [];
      const next =
        page < dependencyPages.length
          ? `<https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/dependencies/blocked_by?per_page=100&page=${page + 1}>; rel="next"`
          : null;
      return response(payload, { link: next });
    }
    if (url.includes(`/issues/${ISSUE_NUMBER}/comments?`)) return response(commentState);
    if (method === "POST" && url.endsWith(`/issues/${ISSUE_NUMBER}/comments`)) {
      const raw = JSON.parse(init.body);
      const created = botComment(9001, raw.body, CHECKED_AT.toISOString());
      commentState.push(created);
      authorityUpdatedAt = CHECKED_AT.toISOString();
      return response(created, { status: 201 });
    }
    const patchMatch = url.match(/\/issues\/comments\/(\d+)$/);
    if (method === "PATCH" && patchMatch) {
      const raw = JSON.parse(init.body);
      const id = Number(patchMatch[1]);
      const existing = commentState.find((comment) => comment.id === id);
      existing.body = raw.body;
      existing.updated_at = CHECKED_AT.toISOString();
      authorityUpdatedAt = CHECKED_AT.toISOString();
      return response(existing);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    client,
    errors,
    logger,
    logs,
    requests,
    comments() {
      return commentState;
    },
  };
}

async function runScenario(scenario, options = {}) {
  const harness = createHarness(scenario, options);
  const result = await main({
    env: {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_TOKEN: "test-token",
      ISSUE_NUMBER: String(ISSUE_NUMBER),
      ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      ISSUE_READINESS_PUBLISH: options.publish ? "true" : "false",
    },
    client: harness.client,
    logger: harness.logger,
    now: () => CHECKED_AT,
  });
  return { harness, result };
}

function fixtureScenario(id) {
  const scenario = fixture.scenarios.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`Missing fixture ${id}`);
  return scenario;
}

function prospectiveMetadata(overrides = {}) {
  return {
    repository: REPOSITORY,
    number: ISSUE_NUMBER,
    nodeId: ISSUE_NODE_ID,
    updatedAt: UPDATED_AT,
    state: "open",
    issueType: { nodeId: TYPE.nodeId, name: "Slice", isEnabled: true },
    milestone: MILESTONE,
    labels: LABELS,
    parentNumber: 5496,
    dependencies: [],
    ...overrides,
  };
}

function prospectiveResult(body = fixture.readyBody, metadata = prospectiveMetadata()) {
  return evaluateProspectiveIssueReadiness({
    body,
    metadata,
    checkedAt: CHECKED_AT.toISOString(),
    checkerSha: CHECKER_SHA,
  });
}

function bodyWithAcceptanceCriteria(count) {
  return replaceField(
    fixture.readyBody,
    "Acceptance criteria",
    Array.from(
      { length: count },
      (_, index) => `- [ ] Criterion ${index + 1}. Evidence: \`criterion-${index + 1}\``,
    ).join("\n"),
  );
}

describe("issue-readiness/v1 receipt and rule contract", () => {
  it("emits a complete ready receipt through the real main entrypoint", async () => {
    const { result, harness } = await runScenario(fixtureScenario("ready"));

    expect(result.exitCode).toBe(0);
    expect(result.receipt.status).toBe("ready");
    expect(result.receipt.schemaVersion).toBe(ISSUE_READINESS_SCHEMA_VERSION);
    expect(result.receipt.claim).toBe("structural-only");
    expect(result.receipt.semanticPressureTest).toBe("not-evaluated");
    expect(result.receipt.subject).toEqual({
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: UPDATED_AT,
    });
    expect(result.receipt.facts).toMatchObject({
      state: "open",
      issueType: { nodeId: TYPE.nodeId, name: "Slice", isEnabled: true },
      milestone: MILESTONE,
      labels: LABELS.slice().sort(),
      hasParent: true,
      parentNumber: 5496,
      dependencies: [],
    });
    expect(result.receipt.checkedRules).toEqual(
      ISSUE_READINESS_RULES.map(({ id }) => ({ id, status: "pass", reasonCodes: [] })),
    );
    expect(result.receipt.coverage).toMatchObject({
      authorityComplete: true,
      issue: { initialRead: true, finalRead: true, revisionStable: true },
      labels: { collected: 3, total: 3, complete: true },
      dependencies: { collected: 0, total: 0, complete: true },
      comments: { collected: 0, total: 0, complete: true },
      form: { parsed: true, complete: true },
    });
    expect(validateIssueReadinessReceipt(result.receipt)).toEqual([]);
    expect(harness.errors).toEqual([]);
    expect(harness.requests.filter(({ url }) => url.endsWith(`/issues/${ISSUE_NUMBER}`))).toHaveLength(2);
  });

  it("keeps the JSON schema rule IDs exact and versioned", () => {
    expect(schema.properties.schemaVersion.const).toBe(ISSUE_READINESS_SCHEMA_VERSION);
    expect(schema.properties.claim.const).toBe("structural-only");
    expect(schema.properties.checkedRules.items.properties.id.enum).toEqual(ISSUE_READINESS_RULES.map(({ id }) => id));
    expect(schema.properties.checkedRules.minItems).toBe(ISSUE_READINESS_RULES.length);
    expect(schema.properties.checkedRules.maxItems).toBe(ISSUE_READINESS_RULES.length);
  });

  it("reports parent state without inventing a parent-or-standalone readiness rule", async () => {
    const { result } = await runScenario(fixtureScenario("ready-without-parent"));
    const source = readFileSync(new URL("./issue-readiness.mjs", import.meta.url), "utf8");

    expect(result.receipt.status).toBe("ready");
    expect(result.receipt.facts).toMatchObject({ hasParent: false, parentNumber: null });
    expect(source).not.toContain("status:standalone");
  });

  it.each([
    [
      "GITHUB_REPOSITORY",
      {
        GITHUB_REPOSITORY: "",
        GITHUB_TOKEN: "test-token",
        ISSUE_NUMBER: "6253",
        ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      },
      "REPOSITORY_INVALID",
    ],
    [
      "GITHUB_TOKEN",
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_TOKEN: "",
        ISSUE_NUMBER: "6253",
        ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      },
      "TOKEN_MISSING",
    ],
    [
      "ISSUE_NUMBER",
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_TOKEN: "test-token",
        ISSUE_NUMBER: "",
        ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      },
      "ISSUE_NUMBER_INVALID",
    ],
    [
      "ISSUE_READINESS_CHECKER_SHA",
      {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_TOKEN: "test-token",
        ISSUE_NUMBER: "6253",
        ISSUE_READINESS_CHECKER_SHA: "",
      },
      "CHECKER_SHA_INVALID",
    ],
  ])("fails closed for an explicitly cleared %s without reading ambient input", async (_name, env, code) => {
    const harness = createHarness(fixtureScenario("ready"));
    const result = await main({ env, client: harness.client, logger: harness.logger, now: () => CHECKED_AT });

    expect(result).toEqual({ exitCode: 2, receipt: null, commentAction: "not-attempted" });
    expect(harness.requests).toEqual([]);
    expect(harness.errors).toEqual([code]);
  });

  for (const id of [
    "repo-evidence-missing",
    "non-goal-missing",
    "acceptance-without-discriminating-evidence",
    "provider-contract-without-test-mode",
    "narrative-commands",
    "footprint-without-callers",
    "unresolved-decision",
    "glossary-impact-missing",
    "authority-probe-without-timing",
    "authority-declared-probe-none",
    "missing-full-path-review-packet",
    "unknown-issue-type",
  ]) {
    it(`fails only toward not-ready for omission fixture ${id}`, async () => {
      const scenario = fixtureScenario(id);
      const { result } = await runScenario(scenario);
      const namedRule = result.receipt.checkedRules.find((entry) => entry.id === scenario.expectedRule);

      expect(result.receipt.status).toBe(scenario.expectedStatus);
      expect(namedRule).toMatchObject({ status: "fail" });
      expect(result.receipt.status).not.toBe("ready");
    });
  }

  it("rejects headings-only prose instead of treating heading presence as readiness", async () => {
    const { result } = await runScenario(fixtureScenario("headings-only"));

    expect(result.receipt.status).toBe("not-ready");
    expect(result.receipt.checkedRules.filter((entry) => entry.status === "fail").length).toBeGreaterThanOrEqual(8);
  });

  it("treats duplicate form fields as malformed unknown, never ready", async () => {
    const { result } = await runScenario(fixtureScenario("malformed-form"));

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("FORM_FIELD_DUPLICATE:Context");
    expect(result.receipt.checkedRules.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("ignores form-shaped headings inside fenced evidence", () => {
    const parsed = parseIssueFormBody(`${fixture.readyBody}\n\`\`\`markdown\n### Context\nnot a duplicate\n\`\`\`\n`);

    expect(parsed.status).toBe("ok");
  });

  it("treats an unclosed form fence as malformed unknown through the real entrypoint", async () => {
    const { result } = await runScenario({ body: `${fixture.readyBody}\n\`\`\`text\n` });

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("FORM_FENCE_UNCLOSED");
  });
});

describe("bounded complete GitHub authority collection", () => {
  it("collects an open blocker that appears only on page two and returns not-ready", async () => {
    const { result, harness } = await runScenario(fixtureScenario("open-blocker-on-page-two"));
    const dependencyRequests = harness.requests.filter(({ url }) => url.includes("/dependencies/blocked_by?"));

    expect(dependencyRequests).toHaveLength(2);
    expect(result.receipt.coverage.dependencies).toMatchObject({
      pages: 2,
      collected: 101,
      total: 101,
      complete: true,
    });
    expect(result.receipt.status).toBe("not-ready");
    expect(result.receipt.checkedRules.find((entry) => entry.id === "ready-00-dependencies-resolved")).toMatchObject({
      status: "fail",
      reasonCodes: ["OPEN_NATIVE_DEPENDENCY"],
    });
  });

  it("returns unknown on independent count mismatch and never emits a positive rule", async () => {
    const { result } = await runScenario(fixtureScenario("count-mismatch"));

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("LABEL_COUNT_MISMATCH");
    expect(result.receipt.coverage.labels.complete).toBe(false);
    expect(result.receipt.checkedRules.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("binds the receipt across the final issue reread and returns unknown on mid-read mutation", async () => {
    const { result } = await runScenario(fixtureScenario("mid-read-mutation"));

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("ISSUE_REVISION_MOVED");
    expect(result.receipt.coverage.issue).toEqual({
      initialRead: true,
      finalRead: true,
      revisionStable: false,
    });
  });

  it("returns unknown when the selected issue authority has moved repositories", async () => {
    const { result } = await runScenario(fixtureScenario("issue-moved"));

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("ISSUE_MOVED");
    expect(result.receipt.subject.nodeId).toBe(ISSUE_NODE_ID);
    expect(result.receipt.coverage.issue).toEqual({
      initialRead: true,
      finalRead: false,
      revisionStable: false,
    });
  });

  it("refuses an unsafe next link before forwarding the token", async () => {
    const scenario = fixtureScenario("open-blocker-on-page-two");
    const harness = createHarness(scenario);
    let changed = false;
    const client = async (url, init) => {
      const result = await harness.client(url, init);
      if (!changed && url.includes("/dependencies/blocked_by?")) {
        changed = true;
        return response(await result.json(), {
          link: '<https://attacker.invalid/issues/6253/dependencies/blocked_by?per_page=100&page=2>; rel="next"',
        });
      }
      return result;
    };
    const result = await main({
      env: {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_TOKEN: "test-token",
        ISSUE_NUMBER: String(ISSUE_NUMBER),
        ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      },
      client,
      now: () => CHECKED_AT,
      logger: harness.logger,
    });

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("PAGINATION_NEXT_UNSAFE");
    expect(harness.requests.some(({ url }) => url.startsWith("https://attacker.invalid"))).toBe(false);
  });

  it("uses only read requests and GraphQL query calls when publication is disabled", async () => {
    const { harness } = await runScenario(fixtureScenario("ready"));

    expect(
      harness.requests.every(({ url, init }) => {
        const method = init.method ?? "GET";
        if (method === "GET") return true;
        if (url !== "https://api.github.com/graphql" || method !== "POST") return false;
        return JSON.parse(init.body).query.trimStart().startsWith("query ");
      }),
    ).toBe(true);
  });
});

describe("prospective issue readiness", () => {
  it("prospective CLI emits decomposition facts", async () => {
    const files = new Map([
      ["body.md", fixture.readyBody],
      ["metadata.json", JSON.stringify(prospectiveMetadata())],
    ]);
    const requests = [];
    const logs = [];
    const result = await main({
      argv: ["--prospective-body", "body.md", "--prospective-metadata", "metadata.json", "--checker-sha", CHECKER_SHA],
      client: async (...args) => {
        requests.push(args);
        throw new Error("prospective mode reached GitHub");
      },
      readTextFile: async (file) => files.get(file),
      logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
      now: () => CHECKED_AT,
    });

    expect(result.exitCode).toBe(0);
    expect(result.schemaVersion).toBe(PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION);
    expect(result.status).toBe("ready");
    expect(result.claim).toBe("structural-only-prospective");
    expect(result.provenance.source).toBe("explicit-input");
    expect(result).not.toHaveProperty("receipt");
    expect(requests).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]).decompositionFacts).toEqual(result.decompositionFacts);
  });

  it("malformed prospective CLI input exits two with its existing reason code", async () => {
    const files = new Map([
      ["body.md", fixture.readyBody],
      ["metadata.json", "{"],
    ]);
    const logs = [];
    const errors = [];
    const requests = [];
    const result = await main({
      argv: ["--prospective-body", "body.md", "--prospective-metadata", "metadata.json", "--checker-sha", CHECKER_SHA],
      client: async (...args) => {
        requests.push(args);
        throw new Error("malformed prospective mode reached GitHub");
      },
      readTextFile: async (file) => files.get(file),
      logger: { log: (value) => logs.push(value), error: (value) => errors.push(value) },
      now: () => CHECKED_AT,
    });

    expect(result).toEqual({ exitCode: 2, receipt: null, commentAction: "not-attempted" });
    expect(errors).toEqual(["PROSPECTIVE_METADATA_INVALID"]);
    expect(logs).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("prospective result reports advisory decomposition facts", () => {
    const result = prospectiveResult();

    expect(Object.keys(result.decompositionFacts)).toEqual(["acceptanceCriteriaCount", "verificationCommands"]);
    expect(result.decompositionFacts.acceptanceCriteriaCount).toBe(result.acceptanceDiagnostics.length);
    expect(result.decompositionFacts).toEqual({
      acceptanceCriteriaCount: 2,
      verificationCommands: ["pnpm vitest run --config ./vitest.scripts.config.mjs scripts/issue-readiness.test.mjs"],
    });
  });

  it("prospective and live readiness share one rule reducer", async () => {
    const live = (await runScenario(fixtureScenario("ready"))).result.receipt;
    const prospective = prospectiveResult();
    const projectRules = (receipt) =>
      receipt.checkedRules.map(({ id, status, reasonCodes }) => ({ id, status, reasonCodes }));

    expect(prospective.status).toBe(live.status);
    expect(prospective.semanticPressureTest).toBe(live.semanticPressureTest);
    expect(projectRules(prospective)).toEqual(projectRules(live));
    expect(prospective.reasonCodes).toEqual(live.reasonCodes);
  });

  it("advisory decomposition facts never change readiness status", () => {
    const threeCriteria = prospectiveResult(bodyWithAcceptanceCriteria(3));
    const twelveCriteria = prospectiveResult(bodyWithAcceptanceCriteria(12));

    expect(threeCriteria.decompositionFacts.acceptanceCriteriaCount).toBe(3);
    expect(twelveCriteria.decompositionFacts.acceptanceCriteriaCount).toBe(12);
    expect(threeCriteria.status).toBe("ready");
    expect({
      status: threeCriteria.status,
      reasonCodes: threeCriteria.reasonCodes,
      checkedRules: threeCriteria.checkedRules,
    }).toEqual({
      status: twelveCriteria.status,
      reasonCodes: twelveCriteria.reasonCodes,
      checkedRules: twelveCriteria.checkedRules,
    });
  });

  it("advisory facts stay off the consumed receipt", async () => {
    const { result, harness } = await runScenario(fixtureScenario("ready"));
    const retrospectiveRecord = JSON.parse(harness.logs.at(-1));
    const currentRevision = {
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: UPDATED_AT,
    };

    expect(retrospectiveRecord).not.toHaveProperty("decompositionFacts");
    expect(result.receipt).not.toHaveProperty("decompositionFacts");
    expect(validateIssueReadinessReceipt(result.receipt)).toEqual([]);
    expect(
      consumeIssueReadinessReceipt({
        receipt: result.receipt,
        currentRevision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "dispatch-implementation", reasonCode: "READY_RECEIPT_CURRENT" });
  });

  it("verification command inventory reuses the ready-04 parser", () => {
    const mixedCommands = replaceField(
      fixture.readyBody,
      "Verification plan",
      [
        "```powershell",
        "# comment",
        "pnpm run verify:first",
        "pnpm --filter <workspace> test",
        "node scripts/issue-readiness.mjs",
        "git diff ...",
        "pnpm run TODO",
        "powershell -File scripts/check.ps1",
        "echo ignored",
        "```",
        "`gh issue view 6353`",
        "`pnpm run TBD`",
      ].join("\n"),
    );
    const mixedResult = prospectiveResult(mixedCommands);
    const zeroCommands = replaceField(
      fixture.readyBody,
      "Verification plan",
      ["```powershell", "# comment", "pnpm --filter <workspace> test", "node scripts/...", "pnpm run TBD", "```"].join(
        "\n",
      ),
    );
    const zeroResult = prospectiveResult(zeroCommands);

    expect(mixedResult.decompositionFacts.verificationCommands).toEqual([
      "pnpm run verify:first",
      "node scripts/issue-readiness.mjs",
      "powershell -File scripts/check.ps1",
      "gh issue view 6353",
    ]);
    expect(mixedResult.checkedRules.find(({ id }) => id === "ready-04-runnable-verification")).toMatchObject({
      status: "pass",
    });
    expect(zeroResult.decompositionFacts).toEqual({
      acceptanceCriteriaCount: zeroResult.acceptanceDiagnostics.length,
      verificationCommands: [],
    });
    expect(zeroResult.checkedRules.find(({ id }) => id === "ready-04-runnable-verification")).toMatchObject({
      status: "fail",
    });
  });

  it("malformed prospective body keeps decomposition facts empty and advisory under unknown status", () => {
    const result = prospectiveResult(`${fixture.readyBody}\n\`\`\`text\n`);

    expect(result.status).toBe("unknown");
    expect(result.reasonCodes).toContain("FORM_FENCE_UNCLOSED");
    expect(result.checkedRules.every(({ status }) => status === "unknown")).toBe(true);
    expect(Object.keys(result.decompositionFacts)).toEqual(["acceptanceCriteriaCount", "verificationCommands"]);
    expect(result.decompositionFacts).toEqual({ acceptanceCriteriaCount: 0, verificationCommands: [] });
    expect(result.decompositionFacts.acceptanceCriteriaCount).toBe(result.acceptanceDiagnostics.length);
  });

  it("ready-03 reports per-criterion diagnostics", () => {
    const entries = [
      "criterion without a marker",
      "criterion. Evidence: tiny",
      "criterion. Evidence: some generic prose",
      "criterion. Evidence: `named-test`",
      "criterion. Evidence: scripts/issue-readiness.test.mjs",
      "criterion. Evidence: verifier output captured after dispatch",
      "criterion. Evidence: workflow run 30632195990",
      "criterion. Evidence: https://github.com/chase-sets/chase-sets/actions/runs/30632195990",
    ];
    const body = replaceField(
      fixture.readyBody,
      "Acceptance criteria",
      entries.map((entry) => `- [ ] ${entry}`).join("\n"),
    );
    const result = evaluateProspectiveIssueReadiness({
      body,
      metadata: prospectiveMetadata(),
      checkedAt: CHECKED_AT.toISOString(),
      checkerSha: CHECKER_SHA,
    });

    expect(result.status).toBe("not-ready");
    expect(result.checkedRules.find(({ id }) => id === "ready-03-acceptance-evidence")).toEqual({
      id: "ready-03-acceptance-evidence",
      status: "fail",
      reasonCodes: ["AC_EVIDENCE_NOT_DISCRIMINATING"],
    });
    expect(result.acceptanceDiagnostics).toEqual([
      { index: 1, status: "fail", reasonCode: "EVIDENCE_MARKER_MISSING" },
      { index: 2, status: "fail", reasonCode: "EVIDENCE_TOO_SHORT" },
      { index: 3, status: "fail", reasonCode: "EVIDENCE_POINTER_UNRECOGNIZED" },
      ...entries.slice(3).map((_, index) => ({ index: index + 4, status: "pass", reasonCode: null })),
    ]);
  });
});

describe("stable comment state machine", () => {
  it("published receipt rebinds after stable comment", async () => {
    const first = await runScenario(fixtureScenario("ready"), { publish: true });
    expect(first.result.commentAction).toBe("created");
    expect(first.harness.comments()).toHaveLength(1);
    expect(first.result.receipt.subject.updatedAt).toBe(CHECKED_AT.toISOString());
    expect(first.harness.comments()[0].body).toContain(`"updatedAt": "${UPDATED_AT}"`);
    expect(first.harness.comments()[0].body).toContain("not this historical comment");
    const existing = first.harness.comments()[0];

    const second = await runScenario(
      { ...fixtureScenario("ready"), initialUpdatedAt: existing.updated_at },
      {
        publish: true,
        comments: [existing],
      },
    );
    expect(second.result.commentAction).toBe("unchanged");
    expect(second.harness.comments()).toHaveLength(1);
    expect(
      second.harness.requests.some(
        ({ url, init }) => init.method === "POST" && url.endsWith(`/issues/${ISSUE_NUMBER}/comments`),
      ),
    ).toBe(false);
    expect(second.harness.requests.some(({ init }) => init.method === "PATCH")).toBe(false);
    expect(second.result.receipt.subject.updatedAt).toBe(existing.updated_at);
  });

  it("post-rebind movement remains stale", async () => {
    const published = await runScenario(fixtureScenario("ready"), { publish: true });
    const rebound = published.result.receipt;

    expect(
      consumeIssueReadinessReceipt({
        receipt: rebound,
        currentRevision: {
          repository: rebound.subject.repository,
          number: rebound.subject.number,
          nodeId: rebound.subject.nodeId,
          updatedAt: "2026-07-29T19:05:00.000Z",
        },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_STALE" });
  });

  it("preserves the last verified receipt as explicitly historical when a new read is unknown", async () => {
    const ready = await runScenario(fixtureScenario("ready"), { publish: true });
    const priorComment = ready.harness.comments()[0];
    const unknown = await runScenario(fixtureScenario("count-mismatch"), {
      publish: true,
      comments: [priorComment],
    });
    const body = unknown.harness.comments()[0].body;

    expect(unknown.result.receipt.status).toBe("unknown");
    expect(unknown.result.commentAction).toBe("updated");
    expect(body).toContain("Current structural evaluation: unknown");
    expect(body).toContain("No current `ready` claim is published");
    expect(body).toContain("Last verified receipt (historical evidence only; **not current**)");
    expect(body).toContain('"status": "ready"');
  });

  it("replaces an unknown display after authority recovers to the same verified structural claim", async () => {
    const ready = await runScenario(fixtureScenario("ready"), { publish: true });
    const unknown = await runScenario(fixtureScenario("count-mismatch"), {
      publish: true,
      comments: [ready.harness.comments()[0]],
    });
    const recovered = await runScenario(
      { ...fixtureScenario("ready"), initialUpdatedAt: unknown.harness.comments()[0].updated_at },
      {
        publish: true,
        comments: [unknown.harness.comments()[0]],
      },
    );

    expect(recovered.result.receipt.status).toBe("ready");
    expect(recovered.result.commentAction).toBe("updated");
    expect(recovered.harness.comments()[0].body).not.toContain("Current structural evaluation: unknown");
  });

  it("does not overwrite an unreadable prior receipt during an unknown read", async () => {
    const unreadable = botComment(42, `${COMMENT_MARKER}\nmalformed historical body`);
    const unknown = await runScenario(fixtureScenario("count-mismatch"), {
      publish: true,
      comments: [unreadable],
    });

    expect(unknown.result.commentAction).toBe("skipped-last-verified-unreadable");
    expect(unknown.harness.comments()[0].body).toBe(unreadable.body);
    expect(unknown.harness.requests.some(({ init }) => init.method === "PATCH")).toBe(false);
  });

  it("ignores a user-authored marker and creates the workflow bot's own stable comment", async () => {
    const spoof = {
      ...botComment(77, `${COMMENT_MARKER}\nuser-controlled body`),
      user: { login: "external-user", type: "User" },
    };
    const run = await runScenario(fixtureScenario("ready"), {
      publish: true,
      comments: [spoof],
    });

    expect(run.result.commentAction).toBe("created");
    expect(run.harness.comments()).toHaveLength(2);
    expect(run.harness.comments().find((comment) => comment.id === 77).body).toBe(spoof.body);
    expect(run.harness.comments().find((comment) => comment.id !== 77).user.login).toBe("github-actions[bot]");
  });
});

describe("runnable-set receipt consumer", () => {
  it("rejects missing, stale, and unknown receipts; routes current not-ready to planning repair", async () => {
    const ready = (await runScenario(fixtureScenario("ready"))).result.receipt;
    const notReady = (await runScenario(fixtureScenario("narrative-commands"))).result.receipt;
    const unknown = (await runScenario(fixtureScenario("count-mismatch"))).result.receipt;
    const revision = {
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: UPDATED_AT,
    };

    expect(
      consumeIssueReadinessReceipt({ receipt: null, currentRevision: revision, trustedCheckerSha: CHECKER_SHA }),
    ).toMatchObject({
      decision: "reject",
      reasonCode: "RECEIPT_MISSING",
    });
    expect(
      consumeIssueReadinessReceipt({
        receipt: { ...ready, checkedRules: [] },
        currentRevision: revision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_MALFORMED" });
    expect(
      consumeIssueReadinessReceipt({
        receipt: ready,
        currentRevision: revision,
        trustedCheckerSha: "b".repeat(40),
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "CHECKER_PROVENANCE_MISMATCH" });
    expect(
      consumeIssueReadinessReceipt({
        receipt: ready,
        currentRevision: { ...revision, updatedAt: "2026-07-29T19:05:00.000Z" },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_STALE" });
    expect(
      consumeIssueReadinessReceipt({
        receipt: unknown,
        currentRevision: revision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_UNKNOWN" });
    expect(
      consumeIssueReadinessReceipt({
        receipt: notReady,
        currentRevision: revision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "dispatch-planning-repair", reasonCode: "STRUCTURAL_NOT_READY" });
  });

  it("keeps semantic pressure-test rejection representable beside a structurally ready receipt", async () => {
    const receipt = (await runScenario(fixtureScenario("ready"))).result.receipt;
    const currentRevision = {
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: UPDATED_AT,
    };

    expect(receipt.status).toBe("ready");
    expect(
      consumeIssueReadinessReceipt({
        receipt,
        currentRevision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "fail",
      }),
    ).toEqual({
      decision: "dispatch-planning-repair",
      reasonCode: "SEMANTIC_PRESSURE_TEST_FAILED",
      structuralStatus: "ready",
    });
    expect(
      consumeIssueReadinessReceipt({
        receipt,
        currentRevision,
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "dispatch-implementation", reasonCode: "READY_RECEIPT_CURRENT" });
  });
});

describe("slice form and trusted-base workflow integration", () => {
  const formPath = path.join(repoRoot, ".github", "ISSUE_TEMPLATE", "slice.yml");
  const form = parseYaml(readFileSync(formPath, "utf8"));
  const workflowPath = path.join(repoRoot, ".github", "workflows", "issue-readiness.yml");
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = parseYaml(workflowSource);

  it("requires every operator, glossary, authority-timing, and review-packet field", () => {
    const fields = Object.fromEntries(
      form.body.filter((entry) => entry.id).map((entry) => [entry.attributes.label, entry]),
    );
    for (const label of [
      "Decisions already made",
      "Operator actions",
      "Glossary impact",
      "External authority probe & evidence timing",
      "Review packet seed",
    ]) {
      expect(fields[label].validations.required, `${label} must be required`).toBe(true);
    }
    expect(fields["Operator actions"].attributes.description).toContain("`none`");
    expect(fields["External authority probe & evidence timing"].attributes.description).toContain(
      "exact lifecycle moment",
    );
    expect(fields["Review packet seed"].attributes.description).toContain("omission-revealing");
  });

  it("runs only by bounded manual dispatch and executes sources from one exact trusted-base SHA", () => {
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          issue_number: {
            description: "Issue number to evaluate at dispatch time",
            required: true,
            type: "number",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.receipt.permissions).toEqual({ contents: "read", issues: "write" });
    expect(workflowSource).not.toContain("actions/checkout@");
    expect(workflowSource).toContain("process.env.GITHUB_REF !== `refs/heads/${defaultBranch}`");
    expect(workflowSource).toContain("const trustedSha = branch.data.commit.sha");
    expect(workflowSource).toContain("ref: trustedSha");
    expect(workflowSource).toContain("await import(pathToFileURL(checkerPath).href)");
    expect(workflowSource).toContain('ISSUE_READINESS_PUBLISH: "true"');
  });

  it("registers the new workflow as a non-release CI surface", () => {
    expect(releaseQualificationScopeRegistry.workflows["issue-readiness.yml"]).toBe("ci");
  });
});
