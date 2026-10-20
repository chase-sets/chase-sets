import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  CONTROLLER_TREE_PATHS,
  consumeIssueReadinessReceipt,
  controllerTreeFootprintPaths,
  evaluateProspectiveIssueReadiness,
  extractReceipt,
  main,
  parseIssueFormBody,
  renderIssueReadinessComment,
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
  id: "MI_kwDORKgVcc4AAAAABaseMilestone",
  number: 136,
  title: "Wave 1 — Platform Foundation & Representative Staging",
  description: '<!-- outcome: {"version":1,"track":"wave","order":1,"status":"committed"} -->',
  state: "open",
};

const PREDECESSOR_COMMIT = "3d20e23b7fdc66865e8459610a6601574960d566";
const PREDECESSOR_PRODUCT_BLOB = "da828b2286373bcbb1d951fb049b6f3b18abd6d9";
const GOLDEN_READINESS_METADATA = Object.freeze({
  repository: "chase-sets/chase-sets",
  number: 6749,
  state: "open",
  issueType: Object.freeze({ nodeId: "synthetic-slice-type", name: "Slice", isEnabled: true }),
  milestone: Object.freeze({ ...MILESTONE }),
  labels: Object.freeze(["priority:p1", "area:ops", "kind:tech-debt"]),
  parentNumber: null,
  dependencies: Object.freeze([]),
});
const REQUIRED_FIELD_NAMES = Object.freeze([
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
]);

function generatedCandidateBody(index) {
  const payload = Array.from({ length: index + 10 }, (_, lineIndex) =>
    lineIndex === 0 ? `candidate-${index}-payload` : "x",
  );
  return `## Context\n${payload.join("\n")}`;
}

const REQUIRED_STRUCTURAL_WITNESSES = Object.freeze([
  Object.freeze({ name: "empty body", body: "" }),
  Object.freeze({ name: "single newline", body: "\n" }),
  Object.freeze({ name: "mixed line endings", body: "## Context\r\nalpha\nbeta" }),
  Object.freeze({ name: "unclosed fence", body: "## Context\nalpha\n```text\ninside" }),
  Object.freeze({ name: "duplicate required heading", body: "## Context\nfirst\n## Context\nsecond" }),
  Object.freeze({ name: "non-required heading before", body: "## Other\nignored\n## Context\nfirst" }),
  Object.freeze({
    name: "non-required heading between",
    body: "## Context\nfirst\n## Other\nignored\n## Scope fence\nsecond",
  }),
]);
const GOLDEN_CORPUS = Object.freeze([
  ...REQUIRED_STRUCTURAL_WITNESSES,
  ...Array.from({ length: 400 }, (_, index) =>
    Object.freeze({ name: `generated candidate ${index}`, body: generatedCandidateBody(index) }),
  ),
]);

function structuralSignature(body, parsed, { includeScannerLineCount = true } = {}) {
  const presentFields = REQUIRED_FIELD_NAMES.filter((field) => parsed.fields[field] !== "");
  const fieldLineCounts = REQUIRED_FIELD_NAMES.map((field) => {
    const value = parsed.fields[field] ?? "";
    return value === "" ? 0 : value.split("\n").length;
  });
  const signature = [parsed.status, parsed.reasonCodes];
  if (includeScannerLineCount) signature.push(body.split(/\r?\n/).length);
  signature.push(presentFields, fieldLineCounts);
  return JSON.stringify(signature);
}

function structuralSignatures(corpus, options) {
  return corpus.map(({ body }) => structuralSignature(body, parseIssueFormBody(body), options));
}

function pairwiseDistinctStructuralSignatures(corpus, options) {
  const signatures = structuralSignatures(corpus, options);
  return new Set(signatures).size === signatures.length;
}

function fillerPaddedCorpus() {
  return Array.from({ length: 20 }, (_, seedIndex) =>
    Array.from({ length: 20 }, (_, variantIndex) => {
      const trailingLines = Array.from({ length: seedIndex }, (_, lineIndex) => `seed-${seedIndex}-line-${lineIndex}`);
      return Object.freeze({
        seedIndex,
        body: [`## Context`, `seed-${seedIndex}-filler-${variantIndex}`, ...trailingLines].join("\n"),
      });
    }),
  ).flat();
}

function readinessExpectation(body, evaluator = evaluateProspectiveIssueReadiness) {
  const result = evaluator({
    body,
    metadata: GOLDEN_READINESS_METADATA,
    checkedAt: CHECKED_AT.toISOString(),
    checkerSha: PREDECESSOR_COMMIT,
  });
  return {
    status: result.status,
    reasonCodes: result.reasonCodes,
    checkedRules: result.checkedRules,
  };
}

// PREDECESSOR_ORACLE_START
const PREDECESSOR_ORACLE_GZIP_BASE64 =
  "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";
// PREDECESSOR_ORACLE_END

function decodePredecessorOracle() {
  return JSON.parse(gunzipSync(Buffer.from(PREDECESSOR_ORACLE_GZIP_BASE64, "base64")).toString("utf8"));
}

function evaluatorComparison(evaluator) {
  const oracle = decodePredecessorOracle();
  const parserMatches = GOLDEN_CORPUS.every(({ body }, index) => {
    return JSON.stringify(evaluator.parser(body)) === JSON.stringify(oracle[index].parser);
  });
  const readinessMatches = GOLDEN_CORPUS.every(({ body }, index) => {
    return JSON.stringify(evaluator.readiness(body)) === JSON.stringify(oracle[index].readiness);
  });
  return { parserMatches, readinessMatches };
}

function currentEvaluator() {
  return {
    parser: parseIssueFormBody,
    readiness: (body) => readinessExpectation(body),
  };
}

function mutatedEvaluator() {
  return {
    parser(body) {
      const parsed = parseIssueFormBody(body);
      return { ...parsed, status: parsed.status === "ok" ? "malformed" : "ok" };
    },
    readiness(body) {
      const readiness = readinessExpectation(body);
      return { ...readiness, status: readiness.status === "ready" ? "not-ready" : "ready" };
    },
  };
}

function productBlobAt(revision) {
  try {
    return execFileSync("git", ["rev-parse", `${revision}:scripts/issue-readiness.mjs`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function provenanceMatches(revision, expectedBlob) {
  return productBlobAt(revision) === expectedBlob;
}

const RETIRED_VOCABULARY = Object.freeze([
  ["PART", "BOUNDARY", "STRADDLES", "LINE"].join("_"),
  ["PART", "FENCE", "UNBALANCED"].join("_"),
  ["SEGMENT", "PARSE", "DIVERGES"].join("_"),
]);
const FUTURE_MANIFEST_NEEDLE = `${["chase-sets", "dispatch-brief-manifest", "v2"].join(":")}:`;
const OWNED_SCANNER_PATHS = Object.freeze(["scripts/issue-readiness.mjs", "scripts/issue-readiness.test.mjs"]);

function trackedTreeEntries() {
  const trackedPaths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return trackedPaths.map((trackedPath) => ({
    path: trackedPath,
    bytes: readFileSync(path.join(repoRoot, trackedPath)),
  }));
}

function vocabularyViolations(trackedEntries, ownedEntries) {
  const violations = [];
  for (const needle of RETIRED_VOCABULARY) {
    const encodedNeedle = Buffer.from(needle);
    for (const entry of trackedEntries) {
      if (entry.bytes.indexOf(encodedNeedle) !== -1) violations.push({ kind: "retired", path: entry.path });
    }
  }
  const encodedManifestNeedle = Buffer.from(FUTURE_MANIFEST_NEEDLE);
  for (const entry of ownedEntries) {
    if (entry.bytes.indexOf(encodedManifestNeedle) !== -1)
      violations.push({ kind: "future-manifest", path: entry.path });
  }
  return violations;
}

function withInjectedBytes(entries, targetPath, injectedText) {
  return entries.map((entry) =>
    entry.path === targetPath
      ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from(`\n${injectedText}\n`)]) }
      : entry,
  );
}

function fencePayloads(record) {
  return [...record.lines.flatMap((line) => [line.enteringFence, line.leavingFence]), record.terminalFence].filter(
    Boolean,
  );
}

function scannerInvariantResult(scanner) {
  const payloadsDistinct = GOLDEN_CORPUS.every(({ body }) => {
    const payloads = fencePayloads(scanner(body));
    return new Set(payloads).size === payloads.length;
  });

  const terminalBody = REQUIRED_STRUCTURAL_WITNESSES.find(({ name }) => name === "unclosed fence").body;
  const terminalRecord = scanner(terminalBody);
  const terminalOpener = terminalRecord.lines.find((line) => line.enteringFence !== null).enteringFence;
  terminalOpener.length = 99;
  terminalOpener.mutated = true;
  const terminalIsolated =
    JSON.stringify(terminalRecord.terminalFence) === JSON.stringify({ marker: "`", length: 3 }) &&
    Object.keys(terminalRecord.terminalFence).join(",") === "marker,length";

  const freshBody = "```text\ninside\n```";
  const first = scanner(freshBody);
  const expectedFresh = scanner(freshBody);
  first.lines.push({ mutated: true });
  first.lines[0].enteringFence.length = 99;
  const freshCallIsolated = JSON.stringify(scanner(freshBody)) === JSON.stringify(expectedFresh);

  return { payloadsDistinct, terminalIsolated, freshCallIsolated };
}

function collapsedPayloadScanner(text) {
  const record = scanIssueFormStructure(text);
  const payloads = fencePayloads(record);
  if (payloads.length < 2) return record;
  const shared = payloads[0];
  for (const line of record.lines) {
    if (line.enteringFence !== null) line.enteringFence = shared;
    if (line.leavingFence !== null) line.leavingFence = shared;
  }
  if (record.terminalFence !== null) record.terminalFence = shared;
  return record;
}

function prefixReencodingParserMutant(body) {
  const lines = body.split(/\r?\n/);
  let codeUnitOffset = 0;
  const priorHeadings = [];
  for (const line of lines) {
    codeUnitOffset += line.length;
    Buffer.byteLength(body.slice(0, codeUnitOffset), "utf8");
    if (/^#{2,3}\s+/.test(line)) priorHeadings.push(line);
    priorHeadings.includes(line);
    codeUnitOffset += 1;
  }
  return parseIssueFormBody(body);
}

function scalingBody(lineCount) {
  return ["## Context", ...Array.from({ length: lineCount - 1 }, () => "payload-alpha")].join("\n");
}

function cumulativeEncodingInput(operation, input) {
  const actualByteLength = Buffer.byteLength;
  let inputUnits = 0;
  Buffer.byteLength = (value, ...arguments_) => {
    inputUnits += typeof value === "string" ? value.length : value.byteLength;
    return actualByteLength(value, ...arguments_);
  };
  try {
    operation(input);
    return inputUnits;
  } finally {
    Buffer.byteLength = actualByteLength;
  }
}

function hasLinearEncodingGrowth(operation, smallerInput, largerInput) {
  const smallerWork = cumulativeEncodingInput(operation, smallerInput);
  const largerWork = cumulativeEncodingInput(operation, largerInput);
  const growth = largerWork / smallerWork;

  return { smallerWork, largerWork, growth, isLinear: growth < 5 };
}

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

  function currentMilestone() {
    const milestone =
      issueReads >= 2 && scenario.finalMilestone ? { ...MILESTONE, ...scenario.finalMilestone } : MILESTONE;
    return {
      node_id: milestone.id,
      number: milestone.number,
      title: milestone.title,
      description: milestone.description,
      state: milestone.state,
    };
  }

  function issuePayload() {
    return {
      node_id: ISSUE_NODE_ID,
      number: ISSUE_NUMBER,
      state: "open",
      updated_at: currentUpdatedAt(),
      body: scenarioBody(scenario),
      type: issueType,
      milestone: currentMilestone(),
      comments: scenario.commentsRestTotalOverride ?? commentState.length,
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
            updatedAt:
              issueReads >= 2 && scenario.finalGraphUpdatedAt ? scenario.finalGraphUpdatedAt : authorityUpdatedAt,
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
              totalCount:
                issueReads >= 2 && scenario.finalGraphCommentsTotalOverride !== undefined
                  ? scenario.finalGraphCommentsTotalOverride
                  : (scenario.commentsGraphTotalOverride ?? commentState.length),
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

describe("predecessor-recorded structural scanner oracle", () => {
  it("the recorded predecessor oracle decodes to one entry per corpus body", () => {
    const oracle = decodePredecessorOracle();

    expect(oracle).toHaveLength(GOLDEN_CORPUS.length);
    expect(oracle.every((entry) => Object.keys(entry).join(",") === "parser,readiness")).toBe(true);
  });

  it("the predecessor oracle binds to the exact reviewed product object", () => {
    expect(provenanceMatches(PREDECESSOR_COMMIT, PREDECESSOR_PRODUCT_BLOB)).toBe(true);
    expect(provenanceMatches("0".repeat(40), PREDECESSOR_PRODUCT_BLOB)).toBe(false);
    expect(provenanceMatches(PREDECESSOR_COMMIT, "f".repeat(40))).toBe(false);
  });

  it("the golden corpus is deterministic and structurally distinct", () => {
    const regenerated = [
      ...REQUIRED_STRUCTURAL_WITNESSES,
      ...Array.from({ length: 400 }, (_, index) => ({
        name: `generated candidate ${index}`,
        body: generatedCandidateBody(index),
      })),
    ];
    const signatures = structuralSignatures(GOLDEN_CORPUS);

    expect(GOLDEN_CORPUS).toHaveLength(407);
    expect(regenerated).toEqual(GOLDEN_CORPUS);
    expect(new Set(GOLDEN_CORPUS.map(({ body }) => body)).size).toBe(GOLDEN_CORPUS.length);
    expect(new Set(signatures).size).toBe(407);
    expect(pairwiseDistinctStructuralSignatures(GOLDEN_CORPUS)).toBe(true);
  });

  it("the golden corpus covers every required structural state", () => {
    const witnesses = Object.fromEntries(REQUIRED_STRUCTURAL_WITNESSES.map((entry) => [entry.name, entry.body]));

    expect(witnesses["empty body"]).toBe("");
    expect(witnesses["single newline"]).toBe("\n");
    expect(witnesses["mixed line endings"]).toContain("\r\n");
    expect(witnesses["mixed line endings"].replace("\r\n", "")).toContain("\n");
    expect(parseIssueFormBody(witnesses["unclosed fence"]).reasonCodes).toEqual(["FORM_FENCE_UNCLOSED"]);
    expect(parseIssueFormBody(witnesses["duplicate required heading"]).reasonCodes).toEqual([
      "FORM_FIELD_DUPLICATE:Context",
    ]);
    expect(parseIssueFormBody(witnesses["non-required heading before"]).fields.Context).toBe("first");
    expect(parseIssueFormBody(witnesses["non-required heading between"]).fields).toMatchObject({
      Context: "first",
      "Scope fence": "second",
    });
  });

  it("a filler padded corpus fails the structural distinctness assertion", () => {
    const mutant = fillerPaddedCorpus();
    const signatures = structuralSignatures(mutant);

    expect(mutant).toHaveLength(400);
    expect(new Set(mutant.map(({ body }) => body)).size).toBe(400);
    expect(new Set(signatures).size).toBe(20);
    expect(pairwiseDistinctStructuralSignatures(mutant)).toBe(false);
    for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
      const variants = mutant.filter((entry) => entry.seedIndex === seedIndex);
      expect(new Set(variants.map(({ body }) => body.split(/\r?\n/).length)).size).toBe(1);
      expect(new Set(structuralSignatures(variants)).size).toBe(1);
    }
  });

  it("the structural signature separates an empty body from a single newline", () => {
    const empty = parseIssueFormBody("");
    const singleNewline = parseIssueFormBody("\n");

    expect(structuralSignature("", empty, { includeScannerLineCount: false })).toBe(
      structuralSignature("\n", singleNewline, { includeScannerLineCount: false }),
    );
    expect("".split(/\r?\n/)).toHaveLength(1);
    expect("\n".split(/\r?\n/)).toHaveLength(2);
    expect(structuralSignature("", empty)).not.toBe(structuralSignature("\n", singleNewline));
  });

  it("the predecessor oracle is indexed one to one with the corpus", () => {
    const oracle = decodePredecessorOracle();

    expect(oracle).toHaveLength(GOLDEN_CORPUS.length);
    for (const [index, { body }] of GOLDEN_CORPUS.entries()) {
      expect(parseIssueFormBody(body)).toEqual(oracle[index].parser);
      expect(readinessExpectation(body)).toEqual(oracle[index].readiness);
    }
  });

  it("the extraction matches predecessor recorded parser output", () => {
    expect(evaluatorComparison(currentEvaluator()).parserMatches).toBe(true);
  });

  it("the extraction matches predecessor recorded readiness outcomes", () => {
    expect(evaluatorComparison(currentEvaluator()).readinessMatches).toBe(true);
  });

  it("a mutated evaluator fails the predecessor recorded comparison", () => {
    expect(evaluatorComparison(currentEvaluator())).toEqual({ parserMatches: true, readinessMatches: true });
    expect(evaluatorComparison(mutatedEvaluator())).toEqual({ parserMatches: false, readinessMatches: false });
  });

  it("the extraction leaves no retired vocabulary or manifest marker", () => {
    const trackedEntries = trackedTreeEntries();
    const ownedEntries = trackedEntries.filter((entry) => OWNED_SCANNER_PATHS.includes(entry.path));

    expect(trackedEntries.length).toBeGreaterThan(0);
    expect(ownedEntries.map(({ path: ownedPath }) => ownedPath)).toEqual(OWNED_SCANNER_PATHS);
    expect(vocabularyViolations(trackedEntries, ownedEntries)).toEqual([]);
  }, 120_000);

  it("the retired vocabulary predicate rejects every injected marker", () => {
    const trackedEntries = trackedTreeEntries();
    const ownedEntries = trackedEntries.filter((entry) => OWNED_SCANNER_PATHS.includes(entry.path));
    const targetPath = OWNED_SCANNER_PATHS[0];

    for (const retiredNeedle of RETIRED_VOCABULARY) {
      const injectedTracked = withInjectedBytes(trackedEntries, targetPath, retiredNeedle);
      const injectedOwned = injectedTracked.filter((entry) => OWNED_SCANNER_PATHS.includes(entry.path));
      expect(vocabularyViolations(injectedTracked, injectedOwned)).toEqual([{ kind: "retired", path: targetPath }]);
    }
    for (const boundary of ["start", "end"]) {
      const injectedOwned = withInjectedBytes(ownedEntries, targetPath, `${FUTURE_MANIFEST_NEEDLE}${boundary}`);
      expect(vocabularyViolations(trackedEntries, injectedOwned)).toEqual([
        { kind: "future-manifest", path: targetPath },
      ]);
    }
    const acceptedOwned = withInjectedBytes(
      withInjectedBytes(ownedEntries, targetPath, "manifest"),
      targetPath,
      COMMENT_MARKER,
    );
    expect(vocabularyViolations(trackedEntries, acceptedOwned)).toEqual([]);
  }, 120_000);

  it("fence transitions report literal opener records", () => {
    const structure = scanIssueFormStructure(
      ["  ```js", "inside", "````", "~~~", "inside", "~~~~", " ````", "```", "~~~", "````", "~~~terminal"].join("\n"),
    );

    expect(structure.lines).toEqual([
      {
        index: 0,
        startOffset: 0,
        endOffset: 7,
        enteringFence: { marker: "`", length: 3 },
        leavingFence: null,
      },
      { index: 1, startOffset: 8, endOffset: 14, enteringFence: null, leavingFence: null },
      {
        index: 2,
        startOffset: 15,
        endOffset: 19,
        enteringFence: null,
        leavingFence: { marker: "`", length: 3 },
      },
      {
        index: 3,
        startOffset: 20,
        endOffset: 23,
        enteringFence: { marker: "~", length: 3 },
        leavingFence: null,
      },
      { index: 4, startOffset: 24, endOffset: 30, enteringFence: null, leavingFence: null },
      {
        index: 5,
        startOffset: 31,
        endOffset: 35,
        enteringFence: null,
        leavingFence: { marker: "~", length: 3 },
      },
      {
        index: 6,
        startOffset: 36,
        endOffset: 41,
        enteringFence: { marker: "`", length: 4 },
        leavingFence: null,
      },
      { index: 7, startOffset: 42, endOffset: 45, enteringFence: null, leavingFence: null },
      { index: 8, startOffset: 46, endOffset: 49, enteringFence: null, leavingFence: null },
      {
        index: 9,
        startOffset: 50,
        endOffset: 54,
        enteringFence: null,
        leavingFence: { marker: "`", length: 4 },
      },
      {
        index: 10,
        startOffset: 55,
        endOffset: 66,
        enteringFence: { marker: "~", length: 3 },
        leavingFence: null,
      },
    ]);
    expect(structure.headings).toEqual([]);
    expect(structure.terminalFence).toEqual({ marker: "~", length: 3 });
    expect(structure.reasonCodes).toEqual(["FORM_FENCE_UNCLOSED"]);
  });

  it("headings reports every recognized heading with its acceptance flag", () => {
    const body = [
      "## Other",
      "ignored",
      "## Context",
      "kept",
      "## Bogus",
      "ignored-again",
      "## Scope fence",
      "scope",
    ].join("\n");
    const structure = scanIssueFormStructure(body);

    expect(structure.lines).toEqual([
      { index: 0, startOffset: 0, endOffset: 8, enteringFence: null, leavingFence: null },
      { index: 1, startOffset: 9, endOffset: 16, enteringFence: null, leavingFence: null },
      { index: 2, startOffset: 17, endOffset: 27, enteringFence: null, leavingFence: null },
      { index: 3, startOffset: 28, endOffset: 32, enteringFence: null, leavingFence: null },
      { index: 4, startOffset: 33, endOffset: 41, enteringFence: null, leavingFence: null },
      { index: 5, startOffset: 42, endOffset: 55, enteringFence: null, leavingFence: null },
      { index: 6, startOffset: 56, endOffset: 70, enteringFence: null, leavingFence: null },
      { index: 7, startOffset: 71, endOffset: 76, enteringFence: null, leavingFence: null },
    ]);
    expect(structure.headings).toEqual([
      { label: "Other", lineIndex: 0, startOffset: 0, endOffset: 8, accepted: false },
      { label: "Context", lineIndex: 2, startOffset: 17, endOffset: 27, accepted: true },
      { label: "Bogus", lineIndex: 4, startOffset: 33, endOffset: 41, accepted: false },
      { label: "Scope fence", lineIndex: 6, startOffset: 56, endOffset: 70, accepted: true },
    ]);
    expect(parseIssueFormBody(body).fields).toMatchObject({ Context: "kept", "Scope fence": "scope" });
  });

  it.each(["###", "####"])("keeps Don't-rebuild pointers at heading level %s inside Context", (level) => {
    const body = [
      "## Context",
      "scripts/issue-readiness.mjs",
      `${level} Don't-rebuild pointers`,
      "corpus-r2.json",
      "## Scope fence",
      "bounded parser repair",
    ].join("\n");
    const parsed = parseIssueFormBody(body);

    expect(parsed.status).toBe("ok");
    expect(parsed.fields.Context).toContain("corpus-r2.json");
    expect(parsed.fields.Context).not.toContain("bounded parser repair");
    expect(parsed.fields["Scope fence"]).toBe("bounded parser repair");
  });

  it("ends Context at an unrelated level-3 heading", () => {
    const parsed = parseIssueFormBody(
      ["## Context", "bounded parser repair", "### Unrelated", "not Context", "## Scope fence", "scope"].join("\n"),
    );

    expect(parsed.fields.Context).toBe("bounded parser repair");
    expect(parsed.fields["Scope fence"]).toBe("scope");
  });

  it("the returned structure record uses exact UTF-8 offsets and key order", () => {
    const structure = scanIssueFormStructure("é\r\n## Context\n💩\n漢");

    expect(Object.keys(structure)).toEqual(["lines", "headings", "terminalFence", "reasonCodes"]);
    expect(structure.lines).toEqual([
      { index: 0, startOffset: 0, endOffset: 2, enteringFence: null, leavingFence: null },
      { index: 1, startOffset: 4, endOffset: 14, enteringFence: null, leavingFence: null },
      { index: 2, startOffset: 15, endOffset: 19, enteringFence: null, leavingFence: null },
      { index: 3, startOffset: 20, endOffset: 23, enteringFence: null, leavingFence: null },
    ]);
    expect(structure.headings).toEqual([
      { label: "Context", lineIndex: 1, startOffset: 4, endOffset: 14, accepted: true },
    ]);
    expect(Object.keys(structure.lines[0])).toEqual([
      "index",
      "startOffset",
      "endOffset",
      "enteringFence",
      "leavingFence",
    ]);
    expect(Object.keys(structure.headings[0])).toEqual(["label", "lineIndex", "startOffset", "endOffset", "accepted"]);
  });

  it("the returned structure record is not aliased", () => {
    expect(scannerInvariantResult(scanIssueFormStructure)).toEqual({
      payloadsDistinct: true,
      terminalIsolated: true,
      freshCallIsolated: true,
    });
  });

  it("the collapsed payload mutant fails both record invariants", () => {
    expect(scannerInvariantResult(scanIssueFormStructure)).toEqual({
      payloadsDistinct: true,
      terminalIsolated: true,
      freshCallIsolated: true,
    });
    expect(scannerInvariantResult(collapsedPayloadScanner)).toEqual({
      payloadsDistinct: false,
      terminalIsolated: false,
      freshCallIsolated: true,
    });
  });

  it("the scanner's encoding work stays linear and rejects a prefix-re-encoding mutant", () => {
    const fourThousandLines = scalingBody(4_000);
    const sixteenThousandLines = scalingBody(16_000);
    const candidate = hasLinearEncodingGrowth(parseIssueFormBody, fourThousandLines, sixteenThousandLines);
    const prefixReencodingMutant = hasLinearEncodingGrowth(
      prefixReencodingParserMutant,
      fourThousandLines,
      sixteenThousandLines,
    );

    console.info(
      `structural scanner encoding-work candidate=${candidate.growth.toFixed(3)} ` +
        `prefix-re-encoding-mutant=${prefixReencodingMutant.growth.toFixed(3)}`,
    );
    // Four times as many fixed-width lines produce four times the scanner's
    // encoding input. A bound below five admits that linear work, while the
    // mutant's cumulative growing-prefix input approaches sixteen times.
    expect(candidate.isLinear).toBe(true);
    expect(prefixReencodingMutant.isLinear).toBe(false);
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
    expect(schema.properties.facts.properties.milestone.oneOf[1].required).toEqual([
      "id",
      "number",
      "title",
      "description",
      "state",
    ]);
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

  it("keeps Terms: none. accepted for glossary impact", async () => {
    const { result } = await runScenario(fixtureScenario("glossary-terms-none"));

    expect(result.receipt.status).toBe("ready");
    expect(result.receipt.checkedRules).toContainEqual({
      id: "ready-07-terms-declared",
      status: "pass",
      reasonCodes: [],
    });
  });

  it("shared explicit-none forms pass both checkers", () => {
    const body = replaceField(
      replaceField(fixture.readyBody, "Glossary impact", fixture.explicitNone.glossary),
      "External authority probe & evidence timing",
      fixture.explicitNone.externalAuthority,
    );
    const result = prospectiveResult(body);

    expect(result.checkedRules).toContainEqual({ id: "ready-07-terms-declared", status: "pass", reasonCodes: [] });
    expect(result.checkedRules).toContainEqual({
      id: "ready-08-authority-probe-timed",
      status: "pass",
      reasonCodes: [],
    });
  });

  it.each(["corpus-r2.json", "`corpus-r2.json`"])(
    "accepts the same named authority artifact with formatting %s",
    (artifact) => {
      const body = replaceField(
        fixture.readyBody,
        "External authority probe & evidence timing",
        `${artifact} after acceptance.`,
      );
      const result = prospectiveResult(body);

      expect(result.checkedRules).toContainEqual({
        id: "ready-08-authority-probe-timed",
        status: "pass",
        reasonCodes: [],
      });
    },
  );

  it.each([
    "after acceptance.",
    "corpus-r2.json; no lifecycle moment is stated.",
    "Evidence `later` after acceptance.",
    "Evidence `TBD` after merge.",
    "Evidence after acceptance `not-a-reference`.",
  ])("does not accept authority evidence without artifact and lifecycle timing: %s", (field) => {
    const body = replaceField(fixture.readyBody, "External authority probe & evidence timing", field);
    const result = prospectiveResult(body);

    expect(result.checkedRules).toContainEqual({
      id: "ready-08-authority-probe-timed",
      status: "fail",
      reasonCodes: ["AUTHORITY_PROBE_OR_TIMING_MISSING"],
    });
  });

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

  it("reconciles a stale REST comment counter against the complete list and GraphQL total", async () => {
    const comments = [botComment(101, "comment 101"), botComment(102, "comment 102"), botComment(103, "comment 103")];
    const { result } = await runScenario({ ...fixtureScenario("ready"), commentsRestTotalOverride: 1 }, { comments });

    expect(result.receipt.status).toBe("ready");
    expect(result.receipt.coverage.comments).toEqual({
      pages: 1,
      collected: 3,
      total: 3,
      complete: true,
      reasonCode: null,
    });
  });

  it("returns unknown when the complete REST comment list differs from the GraphQL total", async () => {
    const comments = [botComment(201, "comment 201"), botComment(202, "comment 202")];
    const { result } = await runScenario(
      { ...fixtureScenario("ready"), commentsRestTotalOverride: 1, commentsGraphTotalOverride: 3 },
      { comments },
    );

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("COMMENT_COUNT_MISMATCH");
    expect(result.receipt.coverage.comments).toMatchObject({ collected: 2, total: 3, complete: false });
    expect(result.receipt.checkedRules.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("returns unknown when GraphQL comment totals and issue revision move while REST count stays unchanged", async () => {
    const comments = [botComment(301, "comment 301"), botComment(302, "comment 302")];
    const { result } = await runScenario(
      {
        ...fixtureScenario("ready"),
        finalUpdatedAt: "2026-07-29T19:03:27.000Z",
        finalGraphUpdatedAt: "2026-07-29T19:03:27.000Z",
        finalGraphCommentsTotalOverride: 3,
      },
      { comments },
    );

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("ISSUE_REVISION_MOVED");
    expect(result.receipt.coverage.issue).toEqual({
      initialRead: true,
      finalRead: true,
      revisionStable: false,
    });
    expect(result.receipt.checkedRules.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("fails closed when a decisive comment exists just beyond the collection cap", async () => {
    const comments = Array.from({ length: 10_001 }, (_, index) => botComment(400 + index, `comment ${index}`));
    const { result } = await runScenario({ ...fixtureScenario("ready") }, { comments });

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("COLLECTION_BOUNDED");
    expect(result.receipt.coverage.comments).toMatchObject({ collected: 10_000, total: 10_001, complete: false });
    expect(result.receipt.checkedRules.every((entry) => entry.status === "unknown")).toBe(true);
  });

  it("rejects duplicate comment identities after complete collection", async () => {
    const duplicate = botComment(501, "duplicate");
    const { result } = await runScenario({ ...fixtureScenario("ready") }, { comments: [duplicate, { ...duplicate }] });

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("COMMENT_DUPLICATE");
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

  it("returns unknown when milestone policy changes without moving issue updatedAt", async () => {
    const candidateDescription = '<!-- outcome: {"version":1,"track":"commerce","order":100,"status":"candidate"} -->';
    const { result } = await runScenario({
      ...fixtureScenario("ready"),
      finalMilestone: { description: candidateDescription },
    });

    expect(result.receipt.status).toBe("unknown");
    expect(result.receipt.reasonCodes).toContain("ISSUE_REVISION_MOVED");
    expect(result.receipt.subject.updatedAt).toBe(UPDATED_AT);
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
  it.each([
    ...["corpus-r2.json", "`corpus-r2.json`"].map((artifact) => ({
      ruleId: "ready-08-authority-probe-timed",
      body: replaceField(
        fixture.readyBody,
        "External authority probe & evidence timing",
        `${artifact} after acceptance.`,
      ),
    })),
    ...[
      "after acceptance.",
      "corpus-r2.json; no lifecycle moment is stated.",
      "Evidence `later` after acceptance.",
      "Evidence `TBD` after merge.",
      "Evidence after acceptance `not-a-reference`.",
    ].map((field) => ({
      ruleId: "ready-08-authority-probe-timed",
      body: replaceField(fixture.readyBody, "External authority probe & evidence timing", field),
    })),
    {
      ruleId: "ready-08-authority-probe-timed",
      secondaryRuleId: "ready-01-repo-evidence",
      body: replaceField(
        fixture.readyBody,
        "Context",
        "Context scope.\n### Don't-rebuild pointers\n- scripts/issue-readiness.mjs\n- bounded-contexts/catalog/README.md",
      ),
    },
  ])(
    "prospective CLI matches evaluator for readiness rule matrix ($ruleId)",
    async ({ ruleId, secondaryRuleId, body }) => {
      const files = new Map([
        ["body.md", body],
        ["metadata.json", JSON.stringify(prospectiveMetadata())],
      ]);
      const requests = [];
      const logs = [];
      const result = await main({
        argv: [
          "--prospective-body",
          "body.md",
          "--prospective-metadata",
          "metadata.json",
          "--checker-sha",
          CHECKER_SHA,
        ],
        client: async (...args) => {
          requests.push(args);
          throw new Error("prospective parity mode reached GitHub");
        },
        readTextFile: async (file) => files.get(file),
        logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) },
        now: () => CHECKED_AT,
      });
      const cliRecord = JSON.parse(logs[0]);
      const evaluator = prospectiveResult(body);
      const findRule = (record, id) => record.checkedRules.find((entry) => entry.id === id);

      expect(result.exitCode).toBe(0);
      expect(logs).toHaveLength(1);
      expect(findRule(cliRecord, ruleId)).toEqual(findRule(evaluator, ruleId));
      if (secondaryRuleId) expect(findRule(cliRecord, secondaryRuleId)).toEqual(findRule(evaluator, secondaryRuleId));
      expect(requests).toEqual([]);
    },
  );

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

  it.each(["Wave 9", "Mobile 4"])("rejects an untagged %s as MILESTONE_NOT_OUTCOME", (title) => {
    const result = prospectiveResult(
      fixture.readyBody,
      prospectiveMetadata({ milestone: { number: 200, title, state: "open" } }),
    );
    expect(result.status).toBe("not-ready");
    expect(result.reasonCodes).toContain("MILESTONE_NOT_OUTCOME");
  });

  it("accepts tagged Mobile and renamed outcomes while excluding candidates", () => {
    const mobile = prospectiveResult(
      fixture.readyBody,
      prospectiveMetadata({
        milestone: {
          number: 200,
          title: "Mobile 3 — App delivery",
          description: '<!-- outcome: {"version":1,"track":"mobile","order":3,"status":"committed"} -->',
          state: "open",
        },
      }),
    );
    expect(mobile.status).toBe("ready");

    const managedDescription = '<!-- outcome: {"version":1,"track":"commerce","order":100,"status":"committed"} -->';
    const managed = prospectiveResult(
      fixture.readyBody,
      prospectiveMetadata({
        milestone: { number: 900, title: "Renamed checkout outcome", description: managedDescription, state: "open" },
      }),
    );
    expect(managed.status).toBe("ready");

    const candidate = prospectiveResult(
      fixture.readyBody,
      prospectiveMetadata({
        milestone: {
          number: 901,
          title: "Candidate checkout idea",
          description: managedDescription.replace('"committed"', '"candidate"'),
          state: "open",
        },
      }),
    );
    expect(candidate.status).toBe("not-ready");
    expect(candidate.reasonCodes).toEqual(expect.arrayContaining(["MILESTONE_CANDIDATE", "MILESTONE_NOT_EXECUTABLE"]));
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
      milestone: MILESTONE,
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
          milestone: rebound.facts.milestone,
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

const PRE_WRITE_AT = "2026-07-29T19:02:27Z";
const WRITE_AT = "2026-07-29T19:04:00Z";
const THIRD_PARTY_AT = "2026-07-29T19:04:01Z";
const AFTER_UPLOAD_AT = "2026-07-29T19:05:00Z";
const DAY_AFTER_AT = "2026-07-30T09:00:00Z";
const DAY_AFTER_WRITE_AT = "2026-07-30T09:00:06Z";
const PRIOR_REVISION_AT = "2026-07-28T07:59:58Z";
const PRIOR_COMMENT_AT = "2026-07-28T08:00:00Z";
const SILENT_LOGGER = Object.freeze({ log() {}, error() {} });

function memberComment(id, body, at) {
  return { ...botComment(id, body, at), user: { login: "synthetic-member", type: "User" } };
}

function syntheticDependency(number, at) {
  return {
    url: `https://api.github.com/repos/${REPOSITORY}/issues/${number}`,
    node_id: `I_synthetic_dependency_${number}`,
    number,
    state: "closed",
    updated_at: at,
    type: { id: TYPE.id, node_id: TYPE.nodeId, name: "Slice", is_enabled: true },
  };
}

// Production-shaped GitHub fake for the publication path: whole-second
// timestamps, the full comment object in every write response, and
// read-after-write lag. Each committed revision becomes visible from a chosen
// issue read; GraphQL and collection reads see what the latest issue read saw,
// as one replica would.
function createIssueRevisionFake({ comments = [] } = {}) {
  const revisions = [
    {
      updatedAt: PRE_WRITE_AT,
      body: fixture.readyBody,
      labels: [...LABELS],
      milestone: { ...MILESTONE },
      dependencies: [],
      comments: structuredClone(comments),
      visibleFrom: 0,
    },
  ];
  const writes = [];
  const afterPostWriteRead = new Map();
  const pinnedPostWriteReads = new Map();
  const hooks = { issuePayload: null, graphPayload: null, page: null, writeFailure: null, writeResponse: null };
  let nextWrite = { at: WRITE_AT, lag: 0 };
  let issueReads = 0;
  let readsBeforeWrite = null;
  let sleeps = 0;
  let clockMs = 0;
  let sleepAdvanceMs = null;
  let nextCommentId = 9001;

  const latest = () => revisions.at(-1);
  const postWriteRead = () => (readsBeforeWrite === null ? null : issueReads - readsBeforeWrite);
  const visible = () =>
    pinnedPostWriteReads.has(postWriteRead())
      ? revisions[pinnedPostWriteReads.get(postWriteRead())]
      : revisions.filter((revision) => revision.visibleFrom <= issueReads).at(-1);

  function commit(change, { updatedAt, lag = 0 }) {
    const current = structuredClone(latest());
    revisions.push({ ...current, ...change(current), updatedAt, visibleFrom: issueReads + lag + 1 });
  }

  function issuePayload(revision) {
    return {
      node_id: ISSUE_NODE_ID,
      number: ISSUE_NUMBER,
      state: "open",
      updated_at: revision.updatedAt,
      body: revision.body,
      type: { id: TYPE.id, node_id: TYPE.nodeId, name: "Slice", is_enabled: true },
      milestone: {
        node_id: revision.milestone.id,
        number: revision.milestone.number,
        title: revision.milestone.title,
        description: revision.milestone.description,
        state: revision.milestone.state,
      },
      comments: revision.comments.length,
      issue_dependencies_summary: {
        blocked_by: revision.dependencies.filter((dependency) => dependency.state === "open").length,
        total_blocked_by: revision.dependencies.length,
      },
    };
  }

  function graphPayload(revision) {
    const connection = (totalCount) => ({ totalCount, pageInfo: { hasNextPage: false, endCursor: null } });
    return {
      data: {
        repository: {
          databaseId: REPOSITORY_DATABASE_ID,
          issue: {
            id: ISSUE_NODE_ID,
            number: ISSUE_NUMBER,
            state: "OPEN",
            updatedAt: revision.updatedAt,
            issueType: { id: TYPE.nodeId, name: "Slice", isEnabled: true },
            parent: { number: 5496 },
            labels: connection(revision.labels.length),
            blockedBy: connection(revision.dependencies.length),
            comments: connection(revision.comments.length),
          },
        },
      },
    };
  }

  function writeComment(id, text) {
    writes.push(id === null ? "POST" : "PATCH");
    const failure = hooks.writeFailure?.();
    if (failure) return failure;
    const { at, lag } = nextWrite;
    let written;
    commit(
      (current) => {
        if (id === null) {
          written = botComment(nextCommentId, text, at);
          nextCommentId += 1;
          return { comments: [...current.comments, written] };
        }
        written = current.comments.find((comment) => comment.id === id);
        Object.assign(written, { body: text, updated_at: at });
        return { comments: current.comments };
      },
      { updatedAt: at, lag },
    );
    readsBeforeWrite = issueReads;
    const payload = structuredClone(written);
    return response(hooks.writeResponse ? hooks.writeResponse(payload) : payload, { status: id === null ? 201 : 200 });
  }

  async function client(url, init = {}) {
    const method = init.method ?? "GET";
    if (url === "https://api.github.com/graphql") {
      const payload = graphPayload(visible());
      return hooks.graphPayload?.(payload) ?? response(payload);
    }
    if (url === `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
      issueReads += 1;
      const payload = issuePayload(visible());
      afterPostWriteRead.get(postWriteRead())?.();
      return hooks.issuePayload?.(payload, postWriteRead()) ?? response(payload, { url });
    }
    const collection = url.match(/\/issues\/\d+\/(labels|dependencies\/blocked_by|comments)\?/)?.[1];
    if (collection) {
      const revision = visible();
      const items = structuredClone(
        collection === "labels"
          ? revision.labels.map((name) => ({ name }))
          : collection === "comments"
            ? revision.comments
            : revision.dependencies,
      );
      return hooks.page?.(collection, items) ?? response(items);
    }
    if (method === "POST" && url === `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments`) {
      return writeComment(null, JSON.parse(init.body).body);
    }
    const patch = method === "PATCH" ? url.match(/\/issues\/comments\/(\d+)$/) : null;
    if (patch) return writeComment(Number(patch[1]), JSON.parse(init.body).body);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  return {
    client,
    hooks,
    commit,
    async sleep(milliseconds) {
      sleeps += 1;
      clockMs += sleepAdvanceMs ?? milliseconds;
    },
    monotonicNow: () => clockMs,
    afterPostWriteRead: (read, action) => afterPostWriteRead.set(read, action),
    pinPostWriteRead: (read, revisionIndex) => pinnedPostWriteReads.set(read, revisionIndex),
    nextWrite(write) {
      nextWrite = { ...nextWrite, ...write };
    },
    slowSleeps(milliseconds) {
      sleepAdvanceMs = milliseconds;
    },
    live: () => latest(),
    stableCommentBody: () =>
      latest().comments.findLast((comment) => comment.user.type === "Bot" && comment.body.includes(COMMENT_MARKER))
        ?.body,
    counters: () => ({ issueReads, sleeps, writes: [...writes] }),
  };
}

async function publishWith(fake, { publish = true, output = null } = {}) {
  const before = fake.counters();
  const result = await main({
    env: {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_TOKEN: "test-token",
      ISSUE_NUMBER: String(ISSUE_NUMBER),
      ISSUE_READINESS_CHECKER_SHA: CHECKER_SHA,
      ISSUE_READINESS_PUBLISH: publish ? "true" : "false",
      ...(output ? { ISSUE_READINESS_OUTPUT: output } : {}),
    },
    client: fake.client,
    logger: SILENT_LOGGER,
    now: () => CHECKED_AT,
    sleep: fake.sleep,
    monotonicNow: fake.monotonicNow,
  });
  const after = fake.counters();
  return {
    result,
    issueReads: after.issueReads - before.issueReads,
    sleeps: after.sleeps - before.sleeps,
    writes: after.writes.slice(before.writes.length),
  };
}

function consumeLive(fake, receipt) {
  const live = fake.live();
  return consumeIssueReadinessReceipt({
    receipt,
    currentRevision: {
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: live.updatedAt,
      milestone: live.milestone,
    },
    trustedCheckerSha: CHECKER_SHA,
    semanticPressureTest: "pass",
  }).reasonCode;
}

function publicationOutcome(fake, run) {
  return {
    commentAction: run.result.commentAction,
    writes: run.writes,
    sleeps: run.sleeps,
    issueReads: run.issueReads,
    status: run.result.receipt.status,
    reasonCodes: run.result.receipt.reasonCodes,
    boundRevision: run.result.receipt.subject.updatedAt,
    consumer: consumeLive(fake, run.result.receipt),
  };
}

async function priorReadyCommentBody() {
  const earlier = await runScenario({ ...fixtureScenario("ready"), initialUpdatedAt: PRIOR_REVISION_AT });
  return renderIssueReadinessComment(earlier.result.receipt);
}

describe("historical comment publication convergence", () => {
  // Issue reads per publishing run: two before the write, the convergence
  // reads, then the complete collection's initial and final reads.
  const convergedOutcome = (commentAction, writes, lag, boundRevision = WRITE_AT) => ({
    commentAction,
    writes,
    sleeps: lag,
    issueReads: 2 + (lag + 1) + 2,
    status: "ready",
    reasonCodes: [],
    boundRevision,
    consumer: "READY_RECEIPT_CURRENT",
  });

  it("created comment converges before artifact binding", async () => {
    const outcomes = [];
    for (const lag of [1, 10]) {
      const fake = createIssueRevisionFake();
      fake.nextWrite({ lag });
      outcomes.push({ lag, ...publicationOutcome(fake, await publishWith(fake)) });
    }

    expect(outcomes).toEqual([1, 10].map((lag) => ({ lag, ...convergedOutcome("created", ["POST"], lag) })));
  });

  it("updated comment converges before artifact binding", async () => {
    const priorBody = await priorReadyCommentBody();
    const outcomes = [];
    for (const lag of [1, 10]) {
      const fake = createIssueRevisionFake({ comments: [botComment(42, priorBody, PRIOR_COMMENT_AT)] });
      fake.nextWrite({ lag });
      outcomes.push({ lag, ...publicationOutcome(fake, await publishWith(fake)) });
    }

    expect(outcomes).toEqual([1, 10].map((lag) => ({ lag, ...convergedOutcome("updated", ["PATCH"], lag) })));
  });

  it("later movement past the comment instant converges by greater-or-equal", async () => {
    const fake = createIssueRevisionFake();
    fake.nextWrite({ lag: 3 });
    // A member comments one second after the write. The first read that shows
    // the write shows that later revision, so equality would never converge.
    fake.afterPostWriteRead(1, () =>
      fake.commit(
        (current) => ({ comments: [...current.comments, memberComment(501, "Looks good.", THIRD_PARTY_AT)] }),
        { updatedAt: THIRD_PARTY_AT },
      ),
    );

    expect(publicationOutcome(fake, await publishWith(fake))).toEqual({
      ...convergedOutcome("created", ["POST"], 1, THIRD_PARTY_AT),
    });
  });

  it("comment revision non-convergence is bounded unknown", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "issue-readiness-artifact-"));
    try {
      const outcomes = [];
      for (const [bound, lag, sleepAdvanceMs] of [
        ["eleven stale reads", 11, 1_000],
        ["ten-second bound", 7, 1_500],
      ]) {
        const fake = createIssueRevisionFake();
        fake.nextWrite({ lag });
        fake.slowSleeps(sleepAdvanceMs);
        const output = path.join(directory, `${lag}.json`);
        const run = await publishWith(fake, { output });
        const { receipt } = JSON.parse(readFileSync(output, "utf8"));
        outcomes.push({
          bound,
          ...publicationOutcome(fake, run),
          artifact: {
            status: receipt.status,
            reasonCodes: receipt.reasonCodes,
            ruleStatuses: [...new Set(receipt.checkedRules.map((entry) => entry.status))],
            validationErrors: validateIssueReadinessReceipt(receipt),
          },
        });
      }

      const notConverged = { status: "unknown", reasonCodes: ["COMMENT_REVISION_NOT_CONVERGED"] };
      const withheld = {
        commentAction: "created",
        writes: ["POST"],
        ...notConverged,
        boundRevision: PRE_WRITE_AT,
        consumer: "RECEIPT_STALE",
        artifact: { ...notConverged, ruleStatuses: ["unknown"], validationErrors: [] },
      };
      expect(outcomes).toEqual([
        { bound: "eleven stale reads", ...withheld, sleeps: 10, issueReads: 2 + 11 },
        { bound: "ten-second bound", ...withheld, sleeps: 7, issueReads: 2 + 7 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("convergence failures stay unknown", async () => {
    const failOnRead = (target, respond) => (payload, read) => (read === target ? respond(payload) : null);
    const rows = [
      [
        "convergence read HTTP failure",
        (fake) => {
          fake.hooks.issuePayload = failOnRead(1, () => response({ message: "Bad Gateway" }, { status: 502 }));
        },
      ],
      [
        "convergence read network failure",
        (fake) => {
          fake.hooks.issuePayload = failOnRead(2, () => {
            throw new TypeError("fetch failed");
          });
        },
      ],
      [
        "convergence read without updated_at",
        (fake) => {
          fake.hooks.issuePayload = failOnRead(1, (payload) => response({ ...payload, updated_at: null }));
        },
      ],
      [
        "convergence read with malformed updated_at",
        (fake) => {
          fake.hooks.issuePayload = failOnRead(2, (payload) => response({ ...payload, updated_at: "yesterday" }));
        },
      ],
      [
        "write response without updated_at",
        (fake) => {
          fake.hooks.writeResponse = (payload) => ({ ...payload, updated_at: null });
        },
      ],
      [
        "collection pagination failure after convergence",
        (fake) => {
          // Only the post-write comments page holds the new comment.
          fake.hooks.page = (collection, items) =>
            collection === "comments" && items.length > 0
              ? response(items, {
                  link: '<https://attacker.invalid/repos/chase-sets/chase-sets/issues/6253/comments?per_page=100&page=2>; rel="next"',
                })
              : null;
        },
      ],
      [
        "collection regresses below the write",
        (fake) => {
          fake.pinPostWriteRead(4, 0);
          fake.pinPostWriteRead(5, 0);
        },
      ],
    ];
    const outcomes = {};
    for (const [failure, arrange] of rows) {
      const fake = createIssueRevisionFake();
      fake.nextWrite({ lag: 2 });
      arrange(fake);
      const run = await publishWith(fake);
      outcomes[failure] = {
        ...publicationOutcome(fake, run),
        validationErrors: validateIssueReadinessReceipt(run.result.receipt),
      };
    }

    const unknown = (reasonCode, overrides) => ({
      commentAction: "created",
      writes: ["POST"],
      status: "unknown",
      reasonCodes: [reasonCode],
      boundRevision: PRE_WRITE_AT,
      consumer: "RECEIPT_STALE",
      validationErrors: [],
      ...overrides,
    });
    expect(outcomes).toEqual({
      "convergence read HTTP failure": unknown("ISSUE_READ_FAILED", { sleeps: 0, issueReads: 3 }),
      "convergence read network failure": unknown("INTERNAL_FAILURE", { sleeps: 1, issueReads: 4 }),
      "convergence read without updated_at": unknown("ISSUE_SHAPE_INVALID", { sleeps: 0, issueReads: 3 }),
      "convergence read with malformed updated_at": unknown("ISSUE_SHAPE_INVALID", { sleeps: 1, issueReads: 4 }),
      "write response without updated_at": unknown("COMMENT_SHAPE_INVALID", {
        commentAction: "write-unconfirmed",
        sleeps: 0,
        issueReads: 2,
      }),
      "collection pagination failure after convergence": unknown("PAGINATION_NEXT_UNSAFE", {
        sleeps: 2,
        issueReads: 7,
        boundRevision: WRITE_AT,
        consumer: "RECEIPT_UNKNOWN",
      }),
      "collection regresses below the write": unknown("COMMENT_REVISION_NOT_CONVERGED", { sleeps: 2, issueReads: 7 }),
    });
  });

  it("publication convergence and external movement remain distinct", async () => {
    const outcomes = {};

    // Lifecycle of one issue: create, immediate rerun, an unrelated member
    // comment the next day, that day's refresh, then its rerun.
    const lifecycle = createIssueRevisionFake();
    lifecycle.nextWrite({ lag: 2 });
    outcomes.create = publicationOutcome(lifecycle, await publishWith(lifecycle));
    outcomes.rerun = publicationOutcome(lifecycle, await publishWith(lifecycle));
    lifecycle.commit(
      (current) => ({ comments: [...current.comments, memberComment(502, "Picking this up.", DAY_AFTER_AT)] }),
      { updatedAt: DAY_AFTER_AT },
    );
    lifecycle.nextWrite({ at: DAY_AFTER_WRITE_AT, lag: 3 });
    outcomes["day after"] = publicationOutcome(lifecycle, await publishWith(lifecycle));
    outcomes["day-after rerun"] = publicationOutcome(lifecycle, await publishWith(lifecycle));

    const unknownEarlier = await runScenario({
      ...fixtureScenario("count-mismatch"),
      initialUpdatedAt: PRIOR_REVISION_AT,
    });
    const update = createIssueRevisionFake({
      comments: [botComment(42, renderIssueReadinessComment(unknownEarlier.result.receipt), PRIOR_COMMENT_AT)],
    });
    update.nextWrite({ lag: 1 });
    outcomes.update = publicationOutcome(update, await publishWith(update));

    const steady = (await publishWith(createIssueRevisionFake(), { publish: false })).result.receipt;
    const unchanged = createIssueRevisionFake({
      comments: [botComment(42, renderIssueReadinessComment(steady), PRE_WRITE_AT)],
    });
    outcomes.unchanged = publicationOutcome(unchanged, await publishWith(unchanged));

    const movements = {
      body: { change: (current) => ({ body: `${current.body}\n\nThird-party clarification.` }), moves: true },
      label: { change: (current) => ({ labels: [...current.labels, "status:needs-replan"] }), moves: true },
      milestone: {
        change: (current) => ({
          milestone: {
            ...current.milestone,
            description: '<!-- outcome: {"version":1,"track":"commerce","order":100,"status":"candidate"} -->',
          },
        }),
        moves: false,
      },
      dependency: {
        change: (current) => ({ dependencies: [...current.dependencies, syntheticDependency(7001, THIRD_PARTY_AT)] }),
        moves: true,
      },
    };
    for (const [kind, { change, moves }] of Object.entries(movements)) {
      // Lands while the run converges and first shows at the final stability read.
      const during = createIssueRevisionFake();
      during.nextWrite({ lag: 2 });
      during.afterPostWriteRead(4, () => during.commit(change, { updatedAt: moves ? THIRD_PARTY_AT : WRITE_AT }));
      outcomes[`${kind} during convergence`] = publicationOutcome(during, await publishWith(during));

      const after = createIssueRevisionFake();
      after.nextWrite({ lag: 2 });
      const run = await publishWith(after);
      after.commit(change, { updatedAt: moves ? AFTER_UPLOAD_AT : WRITE_AT });
      outcomes[`${kind} after upload`] = publicationOutcome(after, run);
    }

    // Accepted-residual control, not a detection claim: an edit in the write's
    // own whole second carries the write's revision, so convergence cannot tell
    // it apart. Only the mandatory final stability read can still catch it.
    const sameSecond = createIssueRevisionFake();
    sameSecond.nextWrite({ lag: 2 });
    sameSecond.afterPostWriteRead(4, () => sameSecond.commit(movements.body.change, { updatedAt: WRITE_AT }));
    outcomes["same-second body edit"] = publicationOutcome(sameSecond, await publishWith(sameSecond));

    const noWrite = (boundRevision) => ({
      commentAction: "unchanged",
      writes: [],
      sleeps: 0,
      issueReads: 2,
      status: "ready",
      reasonCodes: [],
      boundRevision,
      consumer: "READY_RECEIPT_CURRENT",
    });
    const moved = (consumer) => ({
      ...convergedOutcome("created", ["POST"], 2),
      status: "unknown",
      reasonCodes: ["ISSUE_REVISION_MOVED"],
      consumer,
    });
    const staleAtConsumer = { ...convergedOutcome("created", ["POST"], 2), consumer: "RECEIPT_STALE" };
    expect(outcomes).toEqual({
      create: convergedOutcome("created", ["POST"], 2),
      rerun: noWrite(WRITE_AT),
      "day after": convergedOutcome("updated", ["PATCH"], 3, DAY_AFTER_WRITE_AT),
      "day-after rerun": noWrite(DAY_AFTER_WRITE_AT),
      update: convergedOutcome("updated", ["PATCH"], 1),
      unchanged: noWrite(PRE_WRITE_AT),
      "body during convergence": moved("RECEIPT_STALE"),
      "body after upload": staleAtConsumer,
      "label during convergence": moved("RECEIPT_STALE"),
      "label after upload": staleAtConsumer,
      "milestone during convergence": moved("RECEIPT_STALE"),
      "milestone after upload": staleAtConsumer,
      "dependency during convergence": moved("RECEIPT_STALE"),
      "dependency after upload": staleAtConsumer,
      "same-second body edit": moved("RECEIPT_UNKNOWN"),
    });
  });

  it("historical publication failures remain unknown and non-authoritative", async () => {
    const priorBody = await priorReadyCommentBody();
    const unsafeNext =
      '<https://attacker.invalid/repos/chase-sets/chase-sets/issues/6253/dependencies/blocked_by?per_page=100&page=2>; rel="next"';
    const rows = {
      "successful create": { comments: [], arrange() {} },
      "comment write failure": {
        arrange(fake) {
          fake.hooks.writeFailure = () => response({ message: "Server Error" }, { status: 500 });
        },
      },
      "unsafe pagination": {
        arrange(fake) {
          fake.hooks.page = (collection, items) =>
            collection === "dependencies/blocked_by" ? response(items, { link: unsafeNext }) : null;
        },
      },
      "incomplete pagination": {
        arrange(fake) {
          fake.hooks.page = (collection, items) => (collection === "labels" ? response(items.slice(1)) : null);
        },
      },
      "independent-total mismatch": {
        arrange(fake) {
          fake.hooks.graphPayload = (payload) =>
            response({
              ...payload,
              data: {
                ...payload.data,
                repository: {
                  ...payload.data.repository,
                  issue: {
                    ...payload.data.repository.issue,
                    comments: { ...payload.data.repository.issue.comments, totalCount: 2 },
                  },
                },
              },
            });
        },
      },
      "malformed provider output": {
        arrange(fake) {
          fake.hooks.page = (collection, items) =>
            collection === "labels" ? response([...items, { name: "" }]) : null;
        },
      },
    };
    const outcomes = {};
    for (const [name, { comments = [botComment(42, priorBody, PRIOR_COMMENT_AT)], arrange }] of Object.entries(rows)) {
      const fake = createIssueRevisionFake({ comments });
      fake.nextWrite({ lag: 1 });
      arrange(fake);
      const { result } = await publishWith(fake);
      const body = fake.stableCommentBody();
      outcomes[name] = {
        commentAction: result.commentAction,
        status: result.receipt.status,
        reasonCodes: result.receipt.reasonCodes,
        boundRevision: result.receipt.subject.updatedAt,
        consumer: consumeLive(fake, result.receipt),
        comment: {
          historyNotice: body.includes(
            "Dispatch authority is the exact workflow artifact, not this historical comment.",
          ),
          unknownDisplay: body.includes("No current `ready` claim is published."),
          priorMarkedNotCurrent: body.includes("Last verified receipt (historical evidence only; **not current**)"),
          receiptRevision: extractReceipt(body)?.subject.updatedAt ?? null,
        },
      };
    }

    const priorUntouched = {
      historyNotice: true,
      unknownDisplay: false,
      priorMarkedNotCurrent: false,
      receiptRevision: PRIOR_REVISION_AT,
    };
    const unknownDisplay = {
      historyNotice: true,
      unknownDisplay: true,
      priorMarkedNotCurrent: true,
      receiptRevision: PRIOR_REVISION_AT,
    };
    const rewritten = (reasonCode) => ({
      commentAction: "updated",
      status: "unknown",
      reasonCodes: [reasonCode],
      boundRevision: WRITE_AT,
      consumer: "RECEIPT_UNKNOWN",
      comment: unknownDisplay,
    });
    expect(outcomes).toEqual({
      "successful create": {
        commentAction: "created",
        status: "ready",
        reasonCodes: [],
        boundRevision: WRITE_AT,
        consumer: "READY_RECEIPT_CURRENT",
        comment: { ...priorUntouched, receiptRevision: PRE_WRITE_AT },
      },
      "comment write failure": {
        commentAction: "write-unconfirmed",
        status: "unknown",
        reasonCodes: ["COMMENT_WRITE_FAILED"],
        boundRevision: PRE_WRITE_AT,
        consumer: "RECEIPT_UNKNOWN",
        comment: priorUntouched,
      },
      "unsafe pagination": rewritten("PAGINATION_NEXT_UNSAFE"),
      "incomplete pagination": rewritten("LABEL_COUNT_MISMATCH"),
      "independent-total mismatch": {
        commentAction: "skipped-comment-authority-unknown",
        status: "unknown",
        reasonCodes: ["COMMENT_COUNT_MISMATCH"],
        boundRevision: PRE_WRITE_AT,
        consumer: "RECEIPT_UNKNOWN",
        comment: priorUntouched,
      },
      "malformed provider output": rewritten("LABEL_SHAPE_INVALID"),
    });
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
      milestone: MILESTONE,
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

  it("rejects legacy receipts that do not bind milestone identity and description", async () => {
    const receipt = (await runScenario(fixtureScenario("ready"))).result.receipt;
    const legacyReceipt = {
      ...receipt,
      facts: {
        ...receipt.facts,
        milestone: {
          number: receipt.facts.milestone.number,
          title: receipt.facts.milestone.title,
          state: receipt.facts.milestone.state,
        },
      },
    };

    expect(validateIssueReadinessReceipt(legacyReceipt)).toContain("facts");
    expect(
      consumeIssueReadinessReceipt({
        receipt: legacyReceipt,
        currentRevision: {
          repository: REPOSITORY,
          number: ISSUE_NUMBER,
          nodeId: ISSUE_NODE_ID,
          updatedAt: UPDATED_AT,
          milestone: MILESTONE,
        },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toMatchObject({ decision: "reject", reasonCode: "RECEIPT_MALFORMED" });
  });

  it.each([
    ["identity", { ...MILESTONE, id: "MI_changed" }],
    [
      "description",
      {
        ...MILESTONE,
        description: '<!-- outcome: {"version":1,"track":"commerce","order":100,"status":"candidate"} -->',
      },
    ],
    ["state", { ...MILESTONE, state: "closed" }],
  ])("rejects a ready receipt after milestone %s changes with stable issue updatedAt", async (_field, milestone) => {
    const receipt = (await runScenario(fixtureScenario("ready"))).result.receipt;

    expect(
      consumeIssueReadinessReceipt({
        receipt,
        currentRevision: {
          repository: REPOSITORY,
          number: ISSUE_NUMBER,
          nodeId: ISSUE_NODE_ID,
          updatedAt: UPDATED_AT,
          milestone,
        },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toEqual({ decision: "reject", reasonCode: "RECEIPT_STALE", structuralStatus: "ready" });
  });

  it("rejects a caller that omits current milestone authority", async () => {
    const receipt = (await runScenario(fixtureScenario("ready"))).result.receipt;

    expect(
      consumeIssueReadinessReceipt({
        receipt,
        currentRevision: {
          repository: REPOSITORY,
          number: ISSUE_NUMBER,
          nodeId: ISSUE_NODE_ID,
          updatedAt: UPDATED_AT,
        },
        trustedCheckerSha: CHECKER_SHA,
        semanticPressureTest: "pass",
      }),
    ).toEqual({ decision: "reject", reasonCode: "RECEIPT_STALE", structuralStatus: "ready" });
  });

  it("keeps semantic pressure-test rejection representable beside a structurally ready receipt", async () => {
    const receipt = (await runScenario(fixtureScenario("ready"))).result.receipt;
    const currentRevision = {
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      nodeId: ISSUE_NODE_ID,
      updatedAt: UPDATED_AT,
      milestone: MILESTONE,
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
    expect(fields["Operator actions"].attributes.description).toContain("Residual human steps only");
    expect(fields["Operator actions"].attributes.description).toContain("environment");
    expect(fields["Operator actions"].attributes.description).toContain("reason a human is needed");
    expect(fields["Operator actions"].attributes.description).toContain("exact step");
    expect(fields["Operator actions"].attributes.description).toContain("agent resumption point");
    expect(fields["Operator actions"].attributes.description).toContain(
      "production-credential or real-money authorization/supervision",
    );
    expect(fields["Operator actions"].attributes.description).toContain(
      "private entry for credentials agents may not hold",
    );
    expect(fields["Operator actions"].attributes.description).toContain("a protected permission prompt");
    expect(fields["Operator actions"].attributes.description).toContain(
      "an actual policy/external-authority step agents cannot lawfully perform",
    );
    expect(fields["Operator actions"].attributes.description).toContain(
      "agent-owned sign-ins, probe execution, and watch windows are not operator actions",
    );
    expect(fields["Operator actions"].attributes.description).toContain("Enter `none` when there are none.");
    expect(fields["Operator actions"].attributes.description).not.toContain("live watch windows");
    expect(fields["External authority probe & evidence timing"].attributes.description).toContain(
      "exact lifecycle moment",
    );
    expect(fields["Review packet seed"].attributes.description).toContain("omission-revealing");
  });

  it("freezes slice-form fields except acceptance/operator-actions descriptions and area options", () => {
    const predecessorForm = parseYaml(
      execFileSync("git", ["show", "05afe2b107e922ee05c12be3bacecae108d01845:.github/ISSUE_TEMPLATE/slice.yml"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
    );
    const differences = fieldDifferences(fieldProjection(predecessorForm), fieldProjection(form)).filter(
      (key) => key !== "acceptance.description" && key !== "operator-actions.description" && key !== "area.options",
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

describe("repository routing of the footprint", () => {
  function footprintRule(footprint) {
    const result = prospectiveResult(replaceField(fixture.readyBody, "Footprint & chain", footprint));
    return result.checkedRules.find((entry) => entry.id === "ready-05-footprint-operators");
  }

  // Real footprint lines from issues that moved to chase-sets/chase-sets-controller.
  const controllerFootprints = [
    "`.orchestrator/dispatch-gate-intent-v1.schema.json`, `.orchestrator/dispatch-lane.ps1`. Callers: the dispatch gate.",
    "`.orchestrator/controller-skills/milestone-orchestrator/SKILL.md` section 5. Callers: the orchestrator host.",
    "`.orchestrator/contracts/review-v2.md` and its consumer. Callers: review lanes.",
  ];

  it("refuses a footprint that changes controller-tree files", () => {
    for (const footprint of controllerFootprints) {
      expect(footprintRule(footprint)).toEqual({
        id: "ready-05-footprint-operators",
        status: "fail",
        reasonCodes: ["FOOTPRINT_IN_CONTROLLER_REPOSITORY"],
      });
    }
  });

  it("allows machine-local paths and callers in the other repository", () => {
    const allowed = [
      // #9452 and #9975 name machine-local evidence and operator package paths.
      "- `.orchestrator/logs/operator-s1-20261011/lib/receiver.mjs`\n- `.orchestrator/logs/operator-s1-20261011/runners/issue-9295.mjs`\nNo repo changes. Callers: #9296.",
      "`.orchestrator/operator-7334-staged-import/controls.mjs`, `scripts/catalog/import.mjs`. Callers: the staged import.",
      "`scripts/milestone-policy.mjs`, `.orchestrator/platform-handoff.md`, `.orchestrator/orchestration-log.jsonl`, `.orchestrator/with-secrets.ps1`. Callers: next-work.",
      "`scripts/next-work.mjs`. Callers: `.orchestrator/dispatch-lane.ps1` reads the ranked list.",
    ];
    for (const footprint of allowed) {
      expect(footprintRule(footprint)).toEqual({ id: "ready-05-footprint-operators", status: "pass", reasonCodes: [] });
    }
  });

  it("reports both reason codes, sorted, when both conditions fail", () => {
    // A root controller file is not an evidence pointer, so a footprint naming only
    // root controller files also lacks the declaration.
    expect(footprintRule("`bootstrap-container.ps1` (constructed). Callers: container setup.").reasonCodes).toEqual([
      "FOOTPRINT_IN_CONTROLLER_REPOSITORY",
      "FOOTPRINT_OR_OPERATOR_DECLARATION_MISSING",
    ]);
    expect(footprintRule("`.orchestrator/dispatch-lane.ps1` only").reasonCodes).toEqual([
      "FOOTPRINT_IN_CONTROLLER_REPOSITORY",
      "FOOTPRINT_OR_OPERATOR_DECLARATION_MISSING",
    ]);
  });

  it("matches only exact controller roots", () => {
    expect(controllerTreeFootprintPaths("x.orchestrator/dispatch-lane.ps1 `./.orchestrator/lease.ps1`")).toEqual([
      "./.orchestrator/lease.ps1",
    ]);
    expect(CONTROLLER_TREE_PATHS.topLevelExclusions).toContain("with-secrets.ps1");
  });
});
