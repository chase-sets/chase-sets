import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
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
  collectIssueAuthority,
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

const PREDECESSOR_COMMIT = "3d20e23b7fdc66865e8459610a6601574960d566";
const PREDECESSOR_PRODUCT_BLOB = "da828b2286373bcbb1d951fb049b6f3b18abd6d9";
const GOLDEN_READINESS_METADATA = Object.freeze({
  repository: "chase-sets/chase-sets",
  number: 6749,
  state: "open",
  issueType: Object.freeze({ nodeId: "synthetic-slice-type", name: "Slice", isEnabled: true }),
  milestone: Object.freeze({ number: 136, title: MILESTONE.title, state: "open" }),
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

function bestElapsed(operation, input, samples, iterations = 1) {
  for (let iteration = 0; iteration < iterations; iteration += 1) operation(input);
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) operation(input);
    best = Math.min(best, performance.now() - startedAt);
  }
  return best;
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
    issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
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
              totalCount: scenario.commentsTotalOverride ?? commentState.length,
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
    if (url.includes(`/issues/${ISSUE_NUMBER}/comments?`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const payload = commentState.slice((page - 1) * 100, page * 100);
      const next =
        scenario.commentNextLinkOverride ??
        (page * 100 < commentState.length
          ? `<https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}/comments?per_page=100&page=${page + 1}>; rel="next"`
          : null);
      return response(payload, { link: next });
    }
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

  it("the scanner stays linear against a prefix-re-encoding mutant", () => {
    const fourThousandLines = scalingBody(4_000);
    const sixteenThousandLines = scalingBody(16_000);
    const candidateRatio =
      bestElapsed(parseIssueFormBody, sixteenThousandLines, 3, 3) /
      bestElapsed(parseIssueFormBody, fourThousandLines, 3, 3);
    const mutantRatio =
      bestElapsed(prefixReencodingParserMutant, sixteenThousandLines, 2) /
      bestElapsed(prefixReencodingParserMutant, fourThousandLines, 2);

    console.info(
      `structural scanner scaling candidate=${candidateRatio.toFixed(3)} prefix-re-encoding-mutant=${mutantRatio.toFixed(3)}`,
    );
    expect(candidateRatio).toBeLessThan(8);
    expect(mutantRatio).toBeGreaterThan(8);
  }, 60_000);
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
  it("collects decisive comments at positions 99, 100, and 101 through safe pagination", async () => {
    for (const count of [99, 100, 101]) {
      const comments = Array.from({ length: count }, (_, index) => botComment(index + 1, `comment-${index + 1}`));
      const harness = createHarness({ body: fixture.readyBody }, { comments });
      const authority = await collectIssueAuthority({
        repository: REPOSITORY,
        number: ISSUE_NUMBER,
        token: "test-token",
        client: harness.client,
      });

      expect(authority.complete).toBe(true);
      expect(authority.comments).toHaveLength(count);
      expect(authority.comments.at(-1)).toMatchObject({
        id: count,
        issueUrl: `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      });
      expect(authority.coverage.comments).toMatchObject({
        pages: count === 101 ? 2 : 1,
        collected: count,
        total: count,
        complete: true,
      });
    }
  });

  it("projectComment gaining issue_url changes no readiness rule outcome", async () => {
    const scenario = fixtureScenario("ready");
    const withoutComment = await runScenario(scenario);
    const withComment = await runScenario(scenario, { comments: [botComment(1, "ordinary comment")] });

    expect(withComment.result.receipt.checkedRules).toEqual(withoutComment.result.receipt.checkedRules);
    expect(withComment.result.receipt.status).toBe(withoutComment.result.receipt.status);
    expect(withComment.result.receipt.reasonCodes).toEqual(withoutComment.result.receipt.reasonCodes);
    expect(withComment.result.receipt.coverage.comments).toMatchObject({
      collected: 1,
      total: 1,
      complete: true,
    });
  });

  it("returns bounded unknown for comment caps and unsafe continuation links", async () => {
    const cappedComments = Array.from({ length: 10_001 }, (_, index) => botComment(index + 1, `comment-${index + 1}`));
    const cappedHarness = createHarness({ body: fixture.readyBody }, { comments: cappedComments });
    const capped = await collectIssueAuthority({
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      token: "test-token",
      client: cappedHarness.client,
    });
    expect(capped.complete).toBe(false);
    expect(capped.reasonCodes).toContain("COLLECTION_BOUNDED");
    expect(capped.coverage.comments).toMatchObject({ pages: 100, collected: 10_000, complete: false });

    const comments = Array.from({ length: 101 }, (_, index) => botComment(index + 1, `comment-${index + 1}`));
    const unsafeHarness = createHarness(
      {
        body: fixture.readyBody,
        commentNextLinkOverride:
          '<https://attacker.invalid/repos/chase-sets/chase-sets/issues/6680/comments?per_page=100&page=2>; rel="next"',
      },
      { comments },
    );
    const unsafe = await collectIssueAuthority({
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      token: "test-token",
      client: unsafeHarness.client,
    });
    expect(unsafe.complete).toBe(false);
    expect(unsafe.reasonCodes).toContain("PAGINATION_NEXT_UNSAFE");
    expect(unsafeHarness.requests.some(({ url }) => url.startsWith("https://attacker.invalid"))).toBe(false);
  });

  it("returns unknown for duplicate comments and REST-versus-GraphQL total mismatch", async () => {
    const duplicate = botComment(42, "duplicate");
    const duplicateHarness = createHarness({ body: fixture.readyBody }, { comments: [duplicate, { ...duplicate }] });
    const duplicateAuthority = await collectIssueAuthority({
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      token: "test-token",
      client: duplicateHarness.client,
    });
    expect(duplicateAuthority.complete).toBe(false);
    expect(duplicateAuthority.reasonCodes).toContain("COMMENT_DUPLICATE");

    const mismatchHarness = createHarness(
      { body: fixture.readyBody, commentsTotalOverride: 2 },
      { comments: [botComment(1, "only comment")] },
    );
    const mismatch = await collectIssueAuthority({
      repository: REPOSITORY,
      number: ISSUE_NUMBER,
      token: "test-token",
      client: mismatchHarness.client,
    });
    expect(mismatch.complete).toBe(false);
    expect(mismatch.reasonCodes).toContain("INDEPENDENT_TOTAL_MISMATCH");
    expect(mismatch.comments).toEqual([]);
  });

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
