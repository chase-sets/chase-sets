import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { releaseQualificationScopeRegistry } from "./release-qualification-scope.mjs";
import {
  COMMENT_MARKER,
  ISSUE_READINESS_RULES,
  ISSUE_READINESS_SCHEMA_VERSION,
  PROSPECTIVE_ISSUE_READINESS_RUN_SCHEMA_VERSION,
  RECEIPT_END_MARKER,
  RECEIPT_START_MARKER,
  consumeIssueReadinessReceipt,
  evaluateProspectiveIssueReadiness,
  main,
  parseIssueFormBody,
  scanIssueFormStructure,
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

function generatedStructuralCorpus() {
  return Array.from({ length: 400 }, (_, index) => {
    const newline = ["\n", "\r\n", "\n", "\r\n"][index % 4];
    const level = index % 2 === 0 ? "##" : "###";
    const marker = index % 3 === 0 ? "`" : "~";
    const fence = marker.repeat(3 + (index % 5));
    const required = ["Context", "Scope fence", "Decisions already made", "Acceptance criteria"][index % 4];
    const alternate = ["Scope fence", "Context", "Verification plan", "Footprint & chain"][index % 4];
    const unknown = `Not required ${index}`;
    const lines = [
      index % 7 === 0 ? `\uFEFF${level} ${unknown}` : `${level} ${unknown}`,
      `before-${index}-😀é中`,
      index % 5 === 0 ? `  ${fence}text-${index}` : `${fence}text-${index}`,
      `${level} ${required}`,
      `inside-${index}`,
      fence,
      `${level} ${required}`,
      `value-${index}`,
      `${level} ${alternate}`,
      `after-${index}`,
    ];
    const body = lines.join(newline);
    return index % 3 === 0 ? body : `${body}${newline}`;
  });
}

const LEGACY_PRE_EXTRACTION_STRUCTURAL_GOLDENS = JSON.parse(
  gunzipSync(
    Buffer.from(
      "H4sIAAAAAAAACu3XwWrbQBAG4FcZNpBL/QS6BVkuATcuSdyLbezJamQPlmaX3ZUTE2z6GL313EPvvfdV+gB5hBLLpk1CoE1dF8peZyW0fPwz2h3cKh8w1F4lysxVSxVMZe5VcqtSI4FugkqUaqkLbSxBQaKpKbRJs2cjHrB0hPkSKsy3aydakw0omkA7DuQYm4V35LhgjYGNgC1RmnLHmGAdS4Bj0DPkbblnyWEwDlDfv+Cb6uvSeI9uCVxZ1NvtZTeBnGAJWIeZcRyWYJ25IjgGWnB+v20IXLFMm+fPacF0DRb1nAJ4orypXzI5eAXO1IFlCjOWzQdWLeUIvZHU5ORVMhitWhHuL8JhaWcY9faqd0UBo2AUPJBgEcjFDt5r/qZYVTGADwkrLAvjKsqfkTRCMYWPCVWnd/5m3DnNuu1xu/+2e5qeXGbJDu0XM2rq4DmPui/t8ei3lwaPfs90d3aWZuP+WdrtXWTt2NT/6Mb3AzT6xfwdaihuzo9DWa/XQzk6gp8sh8IShfc9Nl92X9yd5/9/23jtPpDg3ccP779++vbl8xPFBZZ1/A39ThCHMplMJpsB2pe5mGvZDc9mJQb1D4S3Vg8Bcyqj4GC0Gn0HIdkR3pcZAAA=",
      "base64",
    ),
  ).toString("utf8"),
);

const PRE_EXTRACTION_STRUCTURAL_GOLDENS = JSON.parse(
  gunzipSync(
    Buffer.from(
      "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",
      "base64",
    ),
  ).toString("utf8"),
);

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

describe("issue-form structural scanner goldens", () => {
  it("the byte identity corpus generator is deterministic", () => {
    expect(generatedStructuralCorpus()).toEqual(generatedStructuralCorpus());
    expect(generatedStructuralCorpus()).toHaveLength(400);
    expect(new Set(generatedStructuralCorpus()).size).toBe(400);
    expect(PRE_EXTRACTION_STRUCTURAL_GOLDENS).toHaveLength(400);
  });

  it("extracted scanner leaves parseIssueFormBody byte identical", () => {
    expect(generatedStructuralCorpus().map(parseIssueFormBody)).toEqual(PRE_EXTRACTION_STRUCTURAL_GOLDENS);
  });

  it("scanner extraction changes no readiness rule outcome", () => {
    const outcomes = generatedStructuralCorpus().map((body) => {
      const result = prospectiveResult(body);
      return { status: result.status, reasonCodes: result.reasonCodes, checkedRules: result.checkedRules };
    });
    expect(outcomes).toEqual(
      generatedStructuralCorpus().map((body) => {
        const result = prospectiveResult(body);
        return { status: result.status, reasonCodes: result.reasonCodes, checkedRules: result.checkedRules };
      }),
    );
  });

  it("the scanner extraction leaves no retired vocabulary", () => {
    const source = readFileSync(new URL("./issue-readiness.mjs", import.meta.url), "utf8");
    const scanner = source.slice(
      source.indexOf("export function scanIssueFormStructure"),
      source.indexOf("export function parseIssueFormBody"),
    );
    expect(scanner).not.toContain("Buffer.byteLength(text.slice");
    expect(scanner).not.toContain("headings.some");
  });

  it("uses exact receipt marker vocabulary and rejects injected start/end lookalikes", () => {
    expect(RECEIPT_START_MARKER).toBe("<!-- chase-sets:issue-readiness-receipt:start -->");
    expect(RECEIPT_END_MARKER).toBe("<!-- chase-sets:issue-readiness-receipt:end -->");
    const source = readFileSync(new URL("./issue-readiness.mjs", import.meta.url), "utf8");
    expect(source).toContain("RECEIPT_START_MARKER");
    expect(source).toContain("RECEIPT_END_MARKER");
    expect(source).not.toContain("issue-readiness-receipt:begin");
    expect(source).not.toContain("issue-readiness-receipt:finish");
  });

  it("scanIssueFormStructure returns exactly the declared shape", () => {
    const result = scanIssueFormStructure("## Context\nvalue");
    expect(Object.keys(result)).toEqual(["lines", "headings", "terminalFence", "reasonCodes"]);
    expect(result.lines.map(Object.keys)).toEqual([
      ["index", "startOffset", "endOffset", "enteringFence", "leavingFence"],
      ["index", "startOffset", "endOffset", "enteringFence", "leavingFence"],
    ]);
    expect(result.headings.map(Object.keys)).toEqual([["label", "lineIndex", "startOffset", "endOffset", "accepted"]]);
  });

  it("headings reports every recognized heading with its acceptance flag", () => {
    const body = "## Context\nalpha\n## Unknown\nbeta\n## Scope fence\ngamma\n## Context\nduplicate";
    const scan = scanIssueFormStructure(body);
    expect(scan.headings.map(({ label, accepted }) => [label, accepted])).toEqual([
      ["Context", true],
      ["Unknown", false],
      ["Scope fence", true],
      ["Context", true],
    ]);
    expect(parseIssueFormBody(body)).toMatchObject({
      fields: { Context: "alpha", "Scope fence": "gamma" },
      reasonCodes: ["FORM_FIELD_DUPLICATE:Context"],
    });
  });

  it("a fenced heading is not a recognized heading", () => {
    expect(scanIssueFormStructure("```\n## Context\n```\n## Context").headings).toHaveLength(1);
  });

  it("the structure record alone reconstructs parseIssueFormBody", () => {
    for (const body of generatedStructuralCorpus()) {
      const scan = scanIssueFormStructure(body);
      const fields = {};
      const bytes = Buffer.from(body, "utf8");
      const headings = new Map(scan.headings.map((heading) => [heading.lineIndex, heading]));
      let current = null;
      for (const line of scan.lines) {
        const heading = headings.get(line.index);
        if (heading) {
          current = heading.accepted && !Object.hasOwn(fields, heading.label) ? heading.label : null;
          if (current) fields[current] = [];
        } else if (current) {
          fields[current].push(bytes.subarray(line.startOffset, line.endOffset).toString("utf8"));
        }
      }
      const reconstructed = {
        status: scan.reasonCodes.length ? "malformed" : "ok",
        fields: Object.fromEntries(
          [
            "Context",
            "Scope fence",
            "Decisions already made",
            "Acceptance criteria",
            "Verification plan",
            "Footprint & chain",
            "Operator actions",
            "Glossary impact",
            "External authority probe & evidence timing",
            "Review packet seed",
            "Tier + routing hint",
          ].map((field) => [field, String(fields[field]?.join("\n") ?? "").trim()]),
        ),
        reasonCodes: scan.reasonCodes,
      };
      expect(reconstructed).toEqual(parseIssueFormBody(body));
    }
  });

  it("heading offsets are utf-8 byte offsets", () => {
    const body = "😀é中\n## Context\nvalue";
    const heading = scanIssueFormStructure(body).headings[0];
    expect(heading.startOffset).toBe(Buffer.byteLength("😀é中\n"));
    expect(heading.endOffset - heading.startOffset).toBe(Buffer.byteLength("## Context"));
  });

  it("fence transitions report literal opener records", () => {
    const scan = scanIssueFormStructure("```\na\n````\n````\nb\n```\n~~~\nc\n~~~");
    expect(scan.lines.map(({ enteringFence, leavingFence }) => [enteringFence, leavingFence])).toEqual([
      [{ marker: "`", length: 3 }, null],
      [null, null],
      [null, { marker: "`", length: 3 }],
      [{ marker: "`", length: 4 }, null],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(scan.terminalFence).toEqual({ marker: "`", length: 4 });
  });

  it("recognizes literal tilde and indented fence transitions", () => {
    const scan = scanIssueFormStructure("  ~~~\n## Context\ninside\n~~~~\n## Context\noutside");
    expect(scan.lines.map(({ enteringFence, leavingFence }) => [enteringFence, leavingFence])).toEqual([
      [{ marker: "~", length: 3 }, null],
      [null, null],
      [null, null],
      [null, { marker: "~", length: 3 }],
      [null, null],
      [null, null],
    ]);
    expect(parseIssueFormBody("  ~~~\n## Context\ninside\n~~~~\n## Context\noutside").fields.Context).toBe("outside");
  });

  it("keeps non-required headings at both field boundaries out of the preceding payload", () => {
    const before = parseIssueFormBody("## Unknown\nignored\n## Context\nkept");
    const after = parseIssueFormBody("## Context\nkept\n## Unknown\nignored");
    expect(before.fields.Context).toBe("kept");
    expect(after.fields.Context).toBe("kept");
  });

  it("terminal fence and reason codes are the parser's own", () => {
    const scan = scanIssueFormStructure("## Context\none\n## Context\ntwo\n```");
    expect(scan.terminalFence).toEqual({ marker: "`", length: 3 });
    expect(scan.reasonCodes).toEqual(["FORM_FIELD_DUPLICATE:Context", "FORM_FENCE_UNCLOSED"]);
  });

  it("the returned structure record is not aliased", () => {
    const body = "```\n````\n```";
    const scan = scanIssueFormStructure(body);
    const payloads = scan.lines.flatMap((line) => [line.enteringFence, line.leavingFence]).filter(Boolean);
    expect(new Set([...payloads, scan.terminalFence]).size).toBe(payloads.length + 1);
    scan.lines[0].enteringFence.length = 99;
    expect(scan.lines[1].leavingFence).toEqual({ marker: "`", length: 3 });
    expect(scanIssueFormStructure(body).lines[0].enteringFence).toEqual({ marker: "`", length: 3 });
  });

  it("rejects a collapsed-payload scanner mutant and proves whole-corpus reference isolation", () => {
    const shared = { marker: "`", length: 3 };
    const collapsedPayloadMutant = (body) => {
      const actual = scanIssueFormStructure(body);
      return {
        ...actual,
        lines: actual.lines.map((line) => ({
          ...line,
          enteringFence: line.enteringFence ? shared : null,
          leavingFence: line.leavingFence ? shared : null,
        })),
      };
    };
    const actual = generatedStructuralCorpus().map(scanIssueFormStructure);
    const mutant = generatedStructuralCorpus().map(collapsedPayloadMutant);
    expect(
      new Set(
        actual.flatMap((scan) => scan.lines.flatMap((line) => [line.enteringFence, line.leavingFence]).filter(Boolean)),
      ).size,
    ).toBeGreaterThan(400);
    expect(
      new Set(
        mutant.flatMap((scan) => scan.lines.flatMap((line) => [line.enteringFence, line.leavingFence]).filter(Boolean)),
      ).size,
    ).toBe(1);
  });

  it("isolates opener-to-terminal payload mutations", () => {
    const scan = scanIssueFormStructure("```\nvalue\n```");
    scan.lines[0].enteringFence.marker = "~";
    expect(scan.lines[2].leavingFence).toEqual({ marker: "`", length: 3 });
  });

  it("keeps 16,000-line scanner cost below eight times the 4,000-line probe", () => {
    const probe = (count) => {
      const body = `## Context\n${Array.from({ length: count }, () => "abcdefghij").join("\n")}`;
      const start = performance.now();
      const result = scanIssueFormStructure(body);
      const elapsedMs = performance.now() - start;
      expect(result.status).toBeUndefined();
      expect(result.lines).toHaveLength(count + 1);
      return elapsedMs;
    };
    probe(1_000);
    const fourThousand = probe(4_000);
    const sixteenThousand = probe(16_000);
    expect(sixteenThousand / Math.max(fourThousand, 0.1)).toBeLessThan(8);
    expect(sixteenThousand).toBeLessThan(1_000);
  });
});

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
  const requiredFieldMap = {
    priority: true,
    area: true,
    kind: true,
    context: true,
    scope: true,
    decisions: true,
    acceptance: true,
    verification: true,
    footprint: true,
    "operator-actions": true,
    "glossary-impact": true,
    "authority-probe": true,
    "review-packet": true,
    tier: true,
  };
  const fieldRequiredMap = (sliceForm) =>
    Object.fromEntries(
      sliceForm.body.filter((entry) => entry.id).map((entry) => [entry.id, entry.validations.required]),
    );
  const assertRequiredFieldMap = (sliceForm) => {
    const actual = fieldRequiredMap(sliceForm);
    const changed = [...new Set([...Object.keys(requiredFieldMap), ...Object.keys(actual)])]
      .filter((id) => actual[id] !== requiredFieldMap[id])
      .sort();
    if (changed.length > 0) throw new Error(`Slice form required fields changed: ${changed.join(", ")}`);
    expect(actual).toEqual(requiredFieldMap);
  };
  const fieldProjection = (sliceForm) =>
    Object.fromEntries(
      sliceForm.body
        .filter((entry) => entry.id)
        .flatMap((entry) => [
          [`${entry.id}.id`, entry.id],
          [`${entry.id}.type`, entry.type],
          [`${entry.id}.label`, entry.attributes.label],
          [`${entry.id}.options`, JSON.stringify(entry.attributes.options ?? null)],
          [`${entry.id}.validations`, JSON.stringify(entry.validations ?? null)],
          [`${entry.id}.description`, entry.attributes.description ?? null],
        ]),
    );
  const fieldDifferences = (left, right) =>
    [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => left[key] !== right[key]).sort();
  const workflowPath = path.join(repoRoot, ".github", "workflows", "issue-readiness.yml");
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = parseYaml(workflowSource);

  it("acceptance field guides authors to a bounded criteria target", () => {
    const fields = Object.fromEntries(
      form.body.filter((entry) => entry.id).map((entry) => [entry.attributes.label, entry]),
    );
    expect(fields["Acceptance criteria"].attributes.description).toContain("Aim for four to six acceptance criteria");
    expect(fields["Acceptance criteria"].attributes.description).toContain("split the slice");
    expect(fields["Acceptance criteria"].attributes.description).toContain(
      "no check here rejects a brief for its criterion count",
    );
  });

  it("pins the complete slice-form required-field map", () => {
    assertRequiredFieldMap(form);
  });

  it("required-field map fails when the acceptance field stops being required", () => {
    const mutatedForm = structuredClone(form);
    mutatedForm.body.find((entry) => entry.id === "acceptance").validations.required = false;

    expect(() => assertRequiredFieldMap(mutatedForm)).toThrowError(
      new Error("Slice form required fields changed: acceptance"),
    );
  });

  it("asserts the operator, authority-timing, and review-packet field descriptions", () => {
    const fields = Object.fromEntries(
      form.body.filter((entry) => entry.id).map((entry) => [entry.attributes.label, entry]),
    );
    expect(fields["Operator actions"].attributes.description).toContain("`none`");
    expect(fields["External authority probe & evidence timing"].attributes.description).toContain(
      "exact lifecycle moment",
    );
    expect(fields["Review packet seed"].attributes.description).toContain("omission-revealing");
  });

  it("slice-form fields other than the acceptance description are unchanged", () => {
    const predecessorForm = parseYaml(
      execFileSync("git", ["show", "05afe2b107e922ee05c12be3bacecae108d01845:.github/ISSUE_TEMPLATE/slice.yml"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    );
    const differences = fieldDifferences(fieldProjection(predecessorForm), fieldProjection(form)).filter(
      (key) => key !== "acceptance.description",
    );

    expect(differences).toEqual([]);
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
