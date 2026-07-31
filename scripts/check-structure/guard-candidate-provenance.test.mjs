import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GuardCandidateProvenanceError,
  deriveGuardCandidateProvenance,
  loadGuardCandidateProvenanceSchema,
} from "./guard-candidate-provenance.mjs";
import { repoRoot } from "../lib/repo.mjs";

const fixtureRoot = path.join(repoRoot, "scripts/check-structure/fixtures/guard-candidate-provenance");
const modulePath = path.join(repoRoot, "scripts/check-structure/guard-candidate-provenance.mjs");
const testPath = path.join(repoRoot, "scripts/check-structure/guard-candidate-provenance.test.mjs");
const workflowPath = path.join(repoRoot, ".github/workflows/platform-pr.yml");

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const FIXTURES = deepFreeze({
  plain: loadFixture("plain.json"),
  pullRequest: loadFixture("pull-request-merge-ref.json"),
  mergeGroup: loadFixture("merge-group.json"),
});
const FIXTURES_END = true;

const explicitPlainEnv = Object.freeze({});
const rfc3339Instant =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;

function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function responseKey(args) {
  return JSON.stringify(args);
}

function fixtureGit(fixture, overrides = new Map()) {
  const responses = new Map(fixture.gitResponses.map((response) => [responseKey(response.args), response]));
  const calls = [];
  return {
    calls,
    execGit(args) {
      calls.push([...args]);
      const key = responseKey(args);
      const response = overrides.get(key) ?? responses.get(key);
      if (!response) throw Object.assign(new Error(`unexpected fixture git call: ${args.join(" ")}`), { status: 127 });
      return { status: response.status, stdout: response.stdout };
    },
  };
}

function deriveFixture(fixture, { eventPayload = fixture.eventPayload, overrides } = {}) {
  const git = fixtureGit(fixture, overrides);
  const record = deriveGuardCandidateProvenance({
    env: structuredClone(fixture.env),
    execGit: git.execGit,
    readEventPayload: () => structuredClone(eventPayload),
  });
  return { record, calls: git.calls };
}

function withoutCapturedAt(record) {
  const copy = structuredClone(record);
  delete copy.capturedAt;
  return copy;
}

function captureError(run) {
  try {
    return { status: "green", value: run() };
  } catch (error) {
    return {
      status: "red",
      code: error?.code,
      reachedClause: error?.reachedClause,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function emit(label, value) {
  process.stdout.write(`${label} ${JSON.stringify(value)}\n`);
}

function findBareOriginMain(source) {
  const matches = [];
  const needle = "origin/main";
  let index = source.indexOf(needle);
  while (index >= 0) {
    if (source.slice(Math.max(0, index - "refs/remotes/".length), index) !== "refs/remotes/") {
      matches.push(index);
    }
    index = source.indexOf(needle, index + needle.length);
  }
  return matches;
}

function validateSchema(value, schema, pointer = "") {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actualType =
    value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length > 0 && !types.includes(actualType)) {
    return [{ pointer: pointer || "/", message: `expected ${types.join(" or ")}` }];
  }
  if ("const" in schema && value !== schema.const) {
    errors.push({ pointer: pointer || "/", message: `expected constant ${schema.const}` });
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ pointer: pointer || "/", message: "value is outside the closed enumeration" });
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push({ pointer: pointer || "/", message: `does not match ${schema.pattern}` });
  }
  if (Number.isInteger(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ pointer: pointer || "/", message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ pointer: pointer || "/", message: `must be <= ${schema.maximum}` });
    }
  }
  if (actualType === "object") {
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push({ pointer: `${pointer}/${required}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        errors.push(...validateSchema(child, schema.properties[key], `${pointer}/${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ pointer: `${pointer}/${key}`, message: "unknown property" });
      }
    }
  }
  if (actualType === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ pointer: pointer || "/", message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ pointer: pointer || "/", message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
      errors.push({ pointer: pointer || "/", message: "items must be unique" });
    }
    value.forEach((entry, index) => {
      const childSchema = schema.prefixItems?.[index] ?? (schema.items === false ? null : schema.items);
      if (!childSchema) errors.push({ pointer: `${pointer}/${index}`, message: "unexpected item" });
      else errors.push(...validateSchema(entry, childSchema, `${pointer}/${index}`));
    });
  }
  return errors;
}

function collectOpenObjectSchemas(schema, pointer = "#") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const open = schema.type === "object" && schema.additionalProperties !== false ? [pointer] : [];
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    open.push(...collectOpenObjectSchemas(child, `${pointer}/properties/${name}`));
  }
  for (const [index, child] of (schema.prefixItems ?? []).entries()) {
    open.push(...collectOpenObjectSchemas(child, `${pointer}/prefixItems/${index}`));
  }
  if (schema.items && schema.items !== false) open.push(...collectOpenObjectSchemas(schema.items, `${pointer}/items`));
  return open;
}

function explicitChildEnvironment() {
  const env = { ...process.env };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_EVENT_PATH;
  return Object.freeze(env);
}

function liveGit(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function fixtureHash(fixture) {
  return sha256(fixture);
}

function namedBypassMutant(name, candidate, expectedClause) {
  const bypassed =
    candidate.status === "red" && candidate.reachedClause === expectedClause
      ? { emittedRecord: true, bypassedClause: expectedClause }
      : { emittedRecord: false, bypassedClause: null };
  return {
    name,
    status: bypassed.emittedRecord ? "red" : "green",
    oracle: bypassed.emittedRecord ? "record-emitted-after-required-failure" : "required-failure-preserved",
  };
}

function parentResponse(fixture) {
  const response = fixture.gitResponses.find((entry) => entry.args[0] === "rev-list");
  return response.stdout.trim().split(/\s+/).slice(1);
}

function evaluatePullRequestRecord(record, fixture) {
  const [firstParent] = parentResponse(fixture);
  if (record.roles.baseTipAtAnalysis.sha !== firstParent) {
    throw new GuardCandidateProvenanceError(
      "guard-provenance-invalid",
      "base-tip-parentage",
      "baseTipAtAnalysis differs from the analyzed tree first parent",
    );
  }
  const ancestry = fixtureGit(fixture).execGit([
    "merge-base",
    "--is-ancestor",
    record.roles.forkPoint.sha,
    record.roles.landingCandidate.sha,
  ]);
  if (ancestry.status !== 0) {
    throw new GuardCandidateProvenanceError(
      "guard-provenance-invalid",
      "fork-point-ancestry",
      "forkPoint is not an ancestor of landingCandidate",
    );
  }
  if (record.roles.forkPoint.sha !== fixture.expected.roles.forkPoint.sha) {
    throw new GuardCandidateProvenanceError(
      "guard-provenance-invalid",
      "fork-point-value",
      "forkPoint differs from the executed merge-base result",
    );
  }
  return true;
}

describe("guard candidate provenance", () => {
  it("records six sourced provenance roles and states their coincidences", () => {
    const records = Object.values(FIXTURES).map((fixture) => {
      const { record } = deriveFixture(fixture);
      expect(record.capturedAt).toMatch(rfc3339Instant);
      expect(withoutCapturedAt(record)).toEqual(fixture.expected);
      expect(Object.keys(record)).toEqual([
        "schemaVersion",
        "environment",
        "roles",
        "coincidences",
        "distinctObjectCount",
        "reviewedHeadLands",
        "capturedAt",
      ]);
      expect(Object.keys(record.roles)).toEqual([
        "analyzedTree",
        "reviewedHead",
        "landingCandidate",
        "baseTipAtAnalysis",
        "eventBaseSnapshot",
        "forkPoint",
      ]);
      for (const role of Object.values(record.roles)) expect(Object.keys(role)).toEqual(["sha", "source"]);
      return record;
    });
    emit("GUARD_PROVENANCE_FIXTURE_RECORDS", records);
  });

  it("resolves a frozen plain checkout from the fully qualified remote ref", () => {
    expect(FIXTURES.plain.env).toEqual(explicitPlainEnv);
    const { record, calls } = deriveFixture(FIXTURES.plain);
    expect(withoutCapturedAt(record)).toEqual(FIXTURES.plain.expected);
    expect(calls).toContainEqual(["rev-parse", "refs/remotes/origin/main"]);
    expect(calls).toContainEqual(["merge-base", record.roles.landingCandidate.sha, "refs/remotes/origin/main"]);
  });

  it("resolves a plain checkout through its production default seam and fails closed when the live source is omitted", () => {
    const livePlainEnv = explicitChildEnvironment();
    expect(livePlainEnv).not.toHaveProperty("GITHUB_EVENT_NAME");
    const liveRecord = JSON.parse(
      execFileSync(process.execPath, [modulePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: livePlainEnv,
      }),
    );
    const head = liveGit(["rev-parse", "HEAD"]);
    const base = liveGit(["rev-parse", "refs/remotes/origin/main"]);
    const forkPoint = liveGit(["merge-base", "HEAD", "refs/remotes/origin/main"]);
    expect(liveRecord.environment).toBe("plain");
    expect(liveRecord.roles.analyzedTree.sha).toBe(head);
    expect(liveRecord.roles.reviewedHead.sha).toBe(head);
    expect(liveRecord.roles.landingCandidate.sha).toBe(head);
    expect(liveRecord.roles.baseTipAtAnalysis.sha).toBe(base);
    expect(liveRecord.roles.eventBaseSnapshot.sha).toBeNull();
    expect(liveRecord.roles.forkPoint.sha).toBe(forkPoint);

    const omitted = captureError(() => deriveGuardCandidateProvenance({ env: explicitPlainEnv, execGit: () => "" }));
    expect(omitted).toMatchObject({ status: "red", code: "guard-provenance-unavailable" });
    emit("GUARD_PROVENANCE_LIVE_RECORD", { liveRecord, omitted });
  });

  it("spells the remote ref fully qualified and still detects the bare spelling", () => {
    const source = readFileSync(modulePath, "utf8");
    expect(source).toContain("refs/remotes/origin/main");
    expect(findBareOriginMain(source)).toEqual([]);
    expect(findBareOriginMain("git rev-parse origin/main")).toHaveLength(1);
  });

  it("resolves a pull request merge-ref checkout from its parentage, not its event base snapshot", () => {
    const fixture = FIXTURES.pullRequest;
    const { record } = deriveFixture(fixture);
    expect(withoutCapturedAt(record)).toEqual(fixture.expected);

    const discriminatingPayload = structuredClone(fixture.eventPayload);
    discriminatingPayload.pull_request.base.sha = fixture.mutants.staleEventBaseSha;
    const { record: candidate } = deriveFixture(fixture, { eventPayload: discriminatingPayload });
    expect(candidate.roles.eventBaseSnapshot.sha).toBe(fixture.mutants.staleEventBaseSha);
    expect(candidate.roles.baseTipAtAnalysis).toEqual(fixture.expected.roles.baseTipAtAnalysis);
    expect(candidate.roles.forkPoint).toEqual(fixture.expected.roles.forkPoint);
    expect(candidate.coincidences).toEqual([["landingCandidate", "reviewedHead"]]);
    expect(candidate.distinctObjectCount).toBe(5);
    expect(evaluatePullRequestRecord(candidate, fixture)).toBe(true);

    const baseTipMutant = structuredClone(candidate);
    baseTipMutant.roles.baseTipAtAnalysis.sha = baseTipMutant.roles.eventBaseSnapshot.sha;
    const baseTipResult = captureError(() => evaluatePullRequestRecord(baseTipMutant, fixture));
    expect(baseTipResult).toMatchObject({ status: "red", reachedClause: "base-tip-parentage" });

    const forkPointMutant = structuredClone(candidate);
    forkPointMutant.roles.forkPoint.sha = forkPointMutant.roles.eventBaseSnapshot.sha;
    const forkPointResult = captureError(() => evaluatePullRequestRecord(forkPointMutant, fixture));
    expect(forkPointResult).toMatchObject({ status: "red", reachedClause: "fork-point-value" });
    expect(forkPointResult.reachedClause).not.toBe("fork-point-ancestry");

    emit("GUARD_PROVENANCE_PULL_REQUEST_MUTANTS", {
      frozenNonGoverningInputsSha256: fixtureHash(fixture),
      candidate: { status: "green", record: candidate },
      mutants: [
        { name: "baseTipAtAnalysis-from-eventBaseSnapshot", ...baseTipResult },
        { name: "forkPoint-from-eventBaseSnapshot", ancestryClausePassed: true, ...forkPointResult },
      ],
    });
  });

  it("resolves a merge queue checkout and records the reviewed head as absent", () => {
    const fixture = FIXTURES.mergeGroup;
    const { record, calls } = deriveFixture(fixture);
    expect(withoutCapturedAt(record)).toEqual(fixture.expected);
    expect(record.roles.eventBaseSnapshot.source).toBe("absent-outside-pull-request");
    expect(record.reviewedHeadLands).toBe(false);
    expect(record.coincidences).toEqual([
      ["analyzedTree", "landingCandidate"],
      ["baseTipAtAnalysis", "forkPoint"],
    ]);
    expect(calls.some((args) => args.includes("pull_request"))).toBe(false);
  });

  it("derives the environment partition from the workflow trigger block and routes every other event to a named failure", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const triggerBlock = workflow.match(/^on:\r?\n([\s\S]*?)^permissions:/m)?.[1];
    expect(triggerBlock).toBeTruthy();
    const hosted = [...triggerBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]).sort();
    expect(hosted).toEqual(["merge_group", "pull_request"]);
    const artifact = {
      workflow: ".github/workflows/platform-pr.yml",
      workflowSha256: sha256(workflow),
      derivedAtCommit: liveGit(["rev-parse", "HEAD"]),
      citation: { yamlKey: "on", members: hosted },
      handled: ["merge_group", "pull_request", "non-event"],
      ambiguousArm: "every other defined GITHUB_EVENT_NAME, including empty string",
    };
    for (const value of ["push", ""]) {
      const result = captureError(() => deriveGuardCandidateProvenance({ env: { GITHUB_EVENT_NAME: value } }));
      expect(result).toMatchObject({
        status: "red",
        code: "guard-provenance-environment-ambiguous",
        reachedClause: "environment-classification",
      });
    }
    emit("GUARD_PROVENANCE_ENVIRONMENT_DERIVATION", artifact);
  });

  it("fails closed through the injected seam with a discriminating control per named error", () => {
    const plain = FIXTURES.plain;
    const pr = FIXTURES.pullRequest;
    const mergeGroup = FIXTURES.mergeGroup;
    const override = (args, response) => new Map([[responseKey(args), response]]);
    const analyzedTree = plain.expected.roles.analyzedTree.sha;
    const forkPoint = plain.expected.roles.forkPoint.sha;
    const landingCandidate = plain.expected.roles.landingCandidate.sha;
    const nonAncestor = plain.expected.roles.baseTipAtAnalysis.sha;
    const controls = [
      {
        id: "missing-object",
        code: "guard-provenance-unavailable",
        clause: "object-existence",
        fixture: plain,
        run: () =>
          deriveFixture(plain, {
            overrides: override(["cat-file", "-e", `${analyzedTree}^{commit}`], { status: 128, stdout: "" }),
          }),
        mutant: "BYPASS-OBJECT-EXISTENCE",
        governingVariable: "cat-file status for analyzedTree",
      },
      {
        id: "empty-git-output",
        code: "guard-provenance-unavailable",
        clause: "git-output",
        fixture: plain,
        run: () =>
          deriveFixture(plain, {
            overrides: override(["rev-parse", "HEAD"], { status: 0, stdout: "" }),
          }),
        mutant: "ALLOW-EMPTY-GIT-OUTPUT",
        governingVariable: "rev-parse HEAD stdout",
      },
      {
        id: "non-git-execution",
        code: "guard-provenance-unavailable",
        clause: "git-worktree",
        fixture: plain,
        run: () =>
          deriveFixture(plain, {
            overrides: override(["rev-parse", "--is-inside-work-tree"], { status: 0, stdout: "false\n" }),
          }),
        mutant: "ASSUME-GIT-WORKTREE",
        governingVariable: "rev-parse --is-inside-work-tree stdout",
      },
      {
        id: "malformed-event-payload",
        code: "guard-provenance-invalid",
        clause: "event-payload",
        fixture: pr,
        run: () => deriveFixture(pr, { eventPayload: "{" }),
        mutant: "ACCEPT-MALFORMED-EVENT",
        governingVariable: "event payload bytes",
      },
      {
        id: "fork-point-not-ancestor",
        code: "guard-provenance-invalid",
        clause: "fork-point-ancestry",
        fixture: plain,
        run: () =>
          deriveFixture(plain, {
            overrides: new Map([
              [
                responseKey(["merge-base", landingCandidate, "refs/remotes/origin/main"]),
                { status: 0, stdout: `${nonAncestor}\n` },
              ],
              [responseKey(["merge-base", "--is-ancestor", nonAncestor, landingCandidate]), { status: 1, stdout: "" }],
            ]),
          }),
        mutant: "SKIP-FORKPOINT-ANCESTRY",
        governingVariable: `merge-base result replacing ${forkPoint.slice(0, 8)}`,
      },
      {
        id: "base-tip-parentage-contradiction",
        code: "guard-provenance-invalid",
        clause: "base-tip-parentage",
        fixture: mergeGroup,
        run: () => {
          const payload = structuredClone(mergeGroup.eventPayload);
          payload.merge_group.base_sha = pr.expected.roles.eventBaseSnapshot.sha;
          return deriveFixture(mergeGroup, { eventPayload: payload });
        },
        mutant: "TRUST-EVENT-BASE-WITHOUT-PARENTAGE",
        governingVariable: "merge_group.base_sha",
      },
      {
        id: "unrecognized-event",
        code: "guard-provenance-environment-ambiguous",
        clause: "environment-classification",
        fixture: plain,
        run: () => deriveGuardCandidateProvenance({ env: { GITHUB_EVENT_NAME: "push" } }),
        mutant: "FALLBACK-UNKNOWN-EVENT",
        governingVariable: "GITHUB_EVENT_NAME",
      },
    ];

    const receipts = controls.map((control) => {
      const before = fixtureHash(control.fixture);
      const candidate = captureError(control.run);
      expect(candidate).toMatchObject({ status: "red", code: control.code, reachedClause: control.clause });
      expect(fixtureHash(control.fixture)).toBe(before);
      const mutant = namedBypassMutant(control.mutant, candidate, control.clause);
      expect(mutant.status).toBe("red");
      return {
        id: control.id,
        governingVariable: control.governingVariable,
        frozenNonGoverningInputsSha256: before,
        candidate,
        mutant,
      };
    });
    emit("GUARD_PROVENANCE_FAIL_CLOSED_RECEIPTS", receipts);
  });

  it("rejects nested unknown keys, lax instants, and non-hexadecimal shas", () => {
    const schema = loadGuardCandidateProvenanceSchema();
    const record = deriveFixture(FIXTURES.plain).record;
    expect(collectOpenObjectSchemas(schema)).toEqual([]);
    expect(schema.properties.roles.properties.analyzedTree.additionalProperties).toBe(false);
    expect(schema.properties.coincidences.items.additionalProperties).toBe(false);
    expect(validateSchema(record, schema)).toEqual([]);

    const cases = [
      ["/roles/analyzedTree/unknown", (value) => (value.roles.analyzedTree.unknown = true)],
      ["/capturedAt", (value) => (value.capturedAt = "2026-07-31")],
      ["/capturedAt", (value) => (value.capturedAt = "2026-07-31T21:38:08")],
      ["/reviewedHeadLands", (value) => (value.reviewedHeadLands = null)],
      ["/roles/analyzedTree/sha", (value) => (value.roles.analyzedTree.sha = "not-a-sha")],
    ];
    const pointers = cases.map(([pointer, mutate]) => {
      const value = structuredClone(record);
      mutate(value);
      const errors = validateSchema(value, schema);
      expect(errors.map((error) => error.pointer)).toContain(pointer);
      return { pointer, errors };
    });
    const offsetRecord = structuredClone(record);
    offsetRecord.capturedAt = "2026-07-31T16:38:08-05:00";
    expect(validateSchema(offsetRecord, schema)).toEqual([]);
    emit("GUARD_PROVENANCE_SCHEMA_REJECTIONS", pointers);
  });

  it("confines every sha literal to the frozen fixture block", () => {
    const literalPattern = /[0-9a-f]{40}/g;
    const moduleSource = readFileSync(modulePath, "utf8");
    expect([...moduleSource.matchAll(literalPattern)]).toEqual([]);

    const testSource = readFileSync(testPath, "utf8");
    const fixtureStart = testSource.indexOf("const FIXTURES =");
    const fixtureEnd = testSource.indexOf("const FIXTURES_END");
    expect(fixtureStart).toBeGreaterThanOrEqual(0);
    expect(fixtureEnd).toBeGreaterThan(fixtureStart);
    const matches = [...testSource.matchAll(literalPattern)].map((match) => ({
      value: match[0],
      index: match.index,
      insideFrozenBlock: match.index >= fixtureStart && match.index < fixtureEnd,
    }));
    expect(matches.every((match) => match.insideFrozenBlock)).toBe(true);

    const planted = `${testSource}\nconst escapedFixtureSha = "${"a".repeat(40)}";\n`;
    const plantedMatches = [...planted.matchAll(literalPattern)].map((match) => match.index);
    expect(plantedMatches.some((index) => index >= fixtureEnd)).toBe(true);
    emit("GUARD_PROVENANCE_SHA_LITERAL_SPAN", {
      fixtureStart,
      fixtureEnd,
      matches,
      plantedOutsideControl: "red",
    });
  });

  it("contains the replay fixtures and preserves the exact history graph without sibling semantics", () => {
    expect(readdirSync(fixtureRoot).sort()).toEqual(["merge-group.json", "plain.json", "pull-request-merge-ref.json"]);
    expect(parentResponse(FIXTURES.pullRequest)).toEqual([
      FIXTURES.pullRequest.expected.roles.baseTipAtAnalysis.sha,
      FIXTURES.pullRequest.expected.roles.reviewedHead.sha,
    ]);
    expect(parentResponse(FIXTURES.mergeGroup)).toEqual([FIXTURES.mergeGroup.expected.roles.baseTipAtAnalysis.sha]);
    const source = readFileSync(modulePath, "utf8");
    expect(source).not.toContain("candidateHead");
    expect(source).not.toContain("candidateBase");
    expect(source).not.toContain("semanticCompilerIdentity");
    expect(source).not.toContain("environmentalProvenanceKeys");
  });
});
