import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConsentAuthorizationGuardError,
  analyzeConsentAuthorizationSites,
  candidateHeadProvenanceRole,
  collectConsentAuthorizationRegistryViolations,
  collectFrozenProvenanceViolations,
  collectMutationAggregateViolations,
  consentAuthorizationCaseEnumerationPath,
  consentAuthorizationRegistryPath,
  consentAuthorizationRegistrySchemaPath,
  deriveConsentAuthorizationProvenanceOutcome,
  digestConsentAuthorizationPartition,
  enumerateConsentAuthorizationCorpus,
  frozenProvenanceExpectations,
  isConsentAuthorizationTestSource,
  loadConsentAuthorizationCaseEnumeration,
  loadConsentAuthorizationRegistry,
  loadConsentAuthorizationRegistrySchema,
  requireResolvedProvenance,
  scanConsentAuthorizationSource,
} from "./consent-authorization-sites.mjs";
import { deriveGuardCandidateProvenance } from "./guard-candidate-provenance.mjs";
import {
  compareTypeScriptOwnerContexts,
  deriveTypeScriptOwnerContexts,
  loadTypeScriptOwnerContextArtifact,
  loadTypeScriptOwnerContextPartition,
  loadTypeScriptOwnerContextSchema,
  typeScriptOwnerContextArtifactPath,
  typeScriptOwnerContextPartitionPath,
} from "./typescript-owner-context-derivation.mjs";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

const fixtureRoot = "scripts/check-structure/fixtures/consent-authorization-sites";
const provenanceFixtureRoot = "scripts/check-structure/fixtures/guard-candidate-provenance";
const ownerContextFixtureRoot = "scripts/check-structure/fixtures/typescript-owner-context-derivation";
const analyzerPath = "scripts/check-structure/consent-authorization-sites.mjs";
const suitePath = "scripts/check-structure/consent-authorization-sites.test.mjs";
const expectedComputedReferenceSyntaxKinds = [
  "BindingElement",
  "BindingElement",
  "ComputedPropertyName",
  "ExportSpecifier",
  "ImportSpecifier",
];
const adjacentContexts = [
  "property-assignment",
  "shorthand-property-assignment",
  "variable-declaration",
  "parameter",
  "binding-element",
  "property-declaration",
  "binary-expression",
  "export-assignment",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function repoFileSha256(relativePath) {
  return sha256(readFileSync(path.join(repoRoot, relativePath)));
}

function readJsonFixture(relativePath) {
  return JSON.parse(repoFile(relativePath));
}

const registry = loadConsentAuthorizationRegistry();
const registrySchema = loadConsentAuthorizationRegistrySchema();
const enumeration = loadConsentAuthorizationCaseEnumeration();
const enumerationSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-case-enumeration-v1.schema.json`);
const receiptSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-mutation-v1.schema.json`);
const aggregateSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-mutation-aggregate-v1.schema.json`);
const ownerContexts = loadTypeScriptOwnerContextArtifact();
const ownerContextPartition = loadTypeScriptOwnerContextPartition();
const ownerContextSchema = loadTypeScriptOwnerContextSchema();
const provenanceFixtures = {
  plain: readJsonFixture(`${provenanceFixtureRoot}/plain.json`),
  "pull-request-merge-ref": readJsonFixture(`${provenanceFixtureRoot}/pull-request-merge-ref.json`),
  "merge-group": readJsonFixture(`${provenanceFixtureRoot}/merge-group.json`),
};

const realTreeResult = analyzeConsentAuthorizationSites({ repoRoot });
const realTreeProvenance = {
  environment: realTreeResult.environment,
  candidateHeadRole: realTreeResult.candidateHeadRole,
  candidateHead: realTreeResult.candidateHead,
  analyzedTree: realTreeResult.provenance.roles.analyzedTree.sha,
  baseTipAtAnalysis: realTreeResult.provenance.roles.baseTipAtAnalysis.sha,
};

/* -------------------------------------------------------------------------- */
/* Scratch repositories                                                       */
/* -------------------------------------------------------------------------- */

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function scratchExecGit(scratch) {
  return (args, options = {}) =>
    execFileSync("git", args, {
      cwd: scratch,
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 1024,
      ...options,
    });
}

function initScratchRepo(prefix) {
  const scratch = mkdtempSync(path.join(tmpdir(), prefix));
  runGit(scratch, ["init", "--quiet", "--initial-branch=main"]);
  // Written in one append rather than five `git config` invocations: every Git
  // process spawned here is charged to a test's budget, and a scratch
  // repository inherits the machine's global core.autocrlf, which would rewrite
  // blob bytes on add and make an object-bound corpus disagree with the bytes
  // this suite wrote.
  appendFileSync(
    path.join(scratch, ".git", "config"),
    [
      "[core]",
      "\tautocrlf = false",
      "\teol = lf",
      "[commit]",
      "\tgpgsign = false",
      "[user]",
      "\temail = guard@chase-sets.test",
      "\tname = Consent authorization guard",
      "",
    ].join("\n"),
  );
  return scratch;
}

function writeScratchFile(scratch, relative, contents) {
  const target = path.join(scratch, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commitScratch(scratch, message) {
  runGit(scratch, ["add", "-A"]);
  runGit(scratch, ["commit", "-q", "--no-verify", "-m", message]);
  return runGit(scratch, ["rev-parse", "HEAD"]).trim();
}

const productFixtureFiles = new Map([
  [
    "bounded-contexts/identity/features/consents/domain/consent-recording-authorization.ts",
    `${fixtureRoot}/consent-recording-authorization.ts`,
  ],
  ["bounded-contexts/identity/features/consents/api/terms-route.ts", `${fixtureRoot}/terms-route.ts`],
  ["bounded-contexts/identity/features/consents/api/route.ts", `${fixtureRoot}/route.ts`],
  ["bounded-contexts/identity/api.ts", `${fixtureRoot}/api.ts`],
  ["bounded-contexts/identity/support/runtime-support/seed.ts", `${fixtureRoot}/seed.ts`],
  [
    "bounded-contexts/identity/support/runtime-support/admin-qa-actor-fixtures.ts",
    `${fixtureRoot}/admin-qa-actor-fixtures.ts`,
  ],
]);

function writeProductSurface(scratch) {
  for (const [relative, fixture] of productFixtureFiles) writeScratchFile(scratch, relative, repoFile(fixture));
}

function buildProductScratchRepo(prefix, extraFiles = new Map()) {
  const scratch = initScratchRepo(prefix);
  writeProductSurface(scratch);
  for (const [relative, contents] of extraFiles) writeScratchFile(scratch, relative, contents);
  const head = commitScratch(scratch, "product surface");
  runGit(scratch, ["update-ref", "refs/remotes/origin/main", head]);
  return { scratch, head };
}

function plainProvenanceFor(scratch) {
  return () => deriveGuardCandidateProvenance({ env: {}, execGit: (args) => scratchExecGit(scratch)(args) });
}

function analyzeScratch(scratch, overrides = {}, module = null) {
  const analyze = (module ?? { analyzeConsentAuthorizationSites }).analyzeConsentAuthorizationSites;
  return analyze({
    repoRoot: scratch,
    authorityRoot: repoRoot,
    registry,
    schema: registrySchema,
    execGit: scratchExecGit(scratch),
    deriveProvenance: plainProvenanceFor(scratch),
    ...overrides,
  });
}

/**
 * A pull-request checkout exactly as actions/checkout materialises it: the base
 * tip advanced independently, the reviewed head did not, and HEAD is the
 * synthetic merge commit whose parents are (base, head) in that order.
 */
function buildPullRequestScratchRepo(prefix) {
  const scratch = initScratchRepo(prefix);
  writeProductSurface(scratch);
  const base = commitScratch(scratch, "base");
  runGit(scratch, ["checkout", "-q", "-b", "candidate", base]);
  writeScratchFile(scratch, "docs/candidate-note.md", "The reviewed head changes nothing under analysis.\n");
  const head = commitScratch(scratch, "candidate head");
  runGit(scratch, ["checkout", "-q", "main"]);
  writeScratchFile(
    scratch,
    "arbitrary/authorization.ts",
    repoFile(`${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`),
  );
  const advancedBase = commitScratch(scratch, "unrelated main advance introducing a seventh site");
  runGit(scratch, ["checkout", "-q", "--detach", advancedBase]);
  runGit(scratch, ["merge", "-q", "--no-ff", "--no-edit", head]);
  const analyzedTree = runGit(scratch, ["rev-parse", "HEAD"]).trim();
  runGit(scratch, ["update-ref", "refs/remotes/origin/main", advancedBase]);
  return {
    scratch,
    base,
    head,
    advancedBase,
    analyzedTree,
    deriveProvenance: () =>
      deriveGuardCandidateProvenance({
        env: { GITHUB_EVENT_NAME: "pull_request" },
        execGit: (args) => scratchExecGit(scratch)(args),
        readEventPayload: () => JSON.stringify({ pull_request: { head: { sha: head }, base: { sha: advancedBase } } }),
      }),
  };
}

function buildMergeGroupScratchRepo(prefix) {
  const scratch = initScratchRepo(prefix);
  writeProductSurface(scratch);
  const base = commitScratch(scratch, "base");
  writeScratchFile(scratch, "docs/landing-note.md", "The landing candidate is itself the prospective merged result.\n");
  const head = commitScratch(scratch, "landing candidate");
  runGit(scratch, ["update-ref", "refs/remotes/origin/main", base]);
  return {
    scratch,
    base,
    head,
    deriveProvenance: () =>
      deriveGuardCandidateProvenance({
        env: { GITHUB_EVENT_NAME: "merge_group" },
        execGit: (args) => scratchExecGit(scratch)(args),
        readEventPayload: () => JSON.stringify({ merge_group: { head_sha: head, base_sha: base } }),
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Module-scope scratch evidence                                              */
/*                                                                            */
/* Every scratch repository below is built and analysed once, here, so that    */
/* its Git process spawns are not charged to an individual test's budget. Only */
/* the arrangement is hoisted; every assertion still lives in its own test.    */
/* -------------------------------------------------------------------------- */

const retainedScratchRepos = [];

// Arbitrary commit-sha-shaped values, derived at run time so that no
// commit-sha literal is ever committed anywhere in this footprint.
const arbitraryFrozenSha = createHash("sha1")
  .update("consent-authorization-frozen-provenance-negative-control")
  .digest("hex");
const absentCandidateHead = createHash("sha1").update("consent-authorization-absent-candidate-head").digest("hex");

function observationOf(result, expectedHead) {
  return {
    environment: result.environment,
    candidateHead: result.candidateHead,
    analyzedTree: result.provenance.roles.analyzedTree.sha,
    boundToHead: result.candidateHead === expectedHead,
    unionsUntrackedNonignored: result.corpus.unionsUntrackedNonignored,
    surface: result.surface,
    violations: result.violations.length,
  };
}

function analyzeHostedScratch(environment) {
  return analyzeConsentAuthorizationSites({
    repoRoot: environment.scratch,
    authorityRoot: repoRoot,
    registry,
    schema: registrySchema,
    execGit: scratchExecGit(environment.scratch),
    deriveProvenance: environment.deriveProvenance,
  });
}

function buildClassifiedEnvironmentEvidence() {
  const plain = buildProductScratchRepo("consent-plain-");
  const plainResult = analyzeScratch(plain.scratch);
  rmSync(plain.scratch, { recursive: true, force: true });

  // Retained: MUT-CORPUS-BIND-ANALYZED-TREE re-analyses this exact checkout.
  const pullRequest = buildPullRequestScratchRepo("consent-pr-env-");
  retainedScratchRepos.push(pullRequest.scratch);
  const pullRequestResult = analyzeHostedScratch(pullRequest);

  const mergeGroup = buildMergeGroupScratchRepo("consent-mg-env-");
  const mergeGroupResult = analyzeHostedScratch(mergeGroup);
  rmSync(mergeGroup.scratch, { recursive: true, force: true });

  return {
    plain: { result: plainResult, head: plain.head },
    pullRequest: { environment: pullRequest, result: pullRequestResult },
    mergeGroup: { result: mergeGroupResult, head: mergeGroup.head },
    observations: [
      observationOf(plainResult, plain.head),
      observationOf(pullRequestResult, pullRequest.head),
      observationOf(mergeGroupResult, mergeGroup.head),
    ],
  };
}

function buildUnresolvedCandidateHeadEvidence() {
  const { scratch } = buildProductScratchRepo("consent-unresolved-");
  const calls = [];
  const execGit = (args, options) => {
    calls.push(args.join(" "));
    return scratchExecGit(scratch)(args, options);
  };
  let thrown = null;
  try {
    enumerateConsentAuthorizationCorpus({
      repoRoot: scratch,
      execGit,
      candidateHead: absentCandidateHead,
      environment: "plain",
    });
  } catch (error) {
    thrown = error;
  }
  rmSync(scratch, { recursive: true, force: true });
  return { calls, thrown };
}

function buildBuiltVersusCleanEvidence() {
  const { scratch } = buildProductScratchRepo("consent-built-clean-", new Map([[".gitignore", "dist/\n"]]));
  const clean = analyzeScratch(scratch);
  writeScratchFile(scratch, "dist/generated.ts", repoFile(`${fixtureRoot}/corpus/ignored-generated/authorization.ts`));
  writeScratchFile(
    scratch,
    "bounded-contexts/identity/features/consents/api/route.ts",
    `${repoFile(`${fixtureRoot}/route.ts`)}\nfunction uncommittedSeventh() {\n  authorizeConsentForActor(context);\n}\n`,
  );
  const built = analyzeScratch(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return { clean, built };
}

function buildMainAdvanceEvidence() {
  const { scratch, head } = buildProductScratchRepo("consent-main-advance-");
  const before = analyzeScratch(scratch);
  writeScratchFile(scratch, "docs/unrelated-main-advance.md", "Ordinary unrelated movement of main.\n");
  const advanced = commitScratch(scratch, "unrelated main advance");
  runGit(scratch, ["update-ref", "refs/remotes/origin/main", advanced]);
  const after = analyzeScratch(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return { before, after, head, advanced };
}

function buildPlantedSiteEvidence(prefix, relativePath, fixturePath) {
  const { scratch } = buildProductScratchRepo(prefix, new Map([[relativePath, repoFile(fixturePath)]]));
  const result = analyzeScratch(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return result;
}

/**
 * Read-only scratch checkouts the mutation cases re-analyse. Built once and
 * retained so that no case pays repository construction inside its own budget;
 * every case only ever reads them.
 */
function buildRetainedCorpusProbeRepo() {
  const scratch = initScratchRepo("consent-corpus-probe-");
  writeScratchFile(scratch, ".gitignore", repoFile(`${fixtureRoot}/corpus/.gitignore`));
  writeScratchFile(scratch, "tracked.ts", "export const tracked = true;\n");
  const head = commitScratch(scratch, "tracked surface");
  runGit(scratch, ["update-ref", "refs/remotes/origin/main", head]);
  writeScratchFile(
    scratch,
    "untracked-nonignored/authorization.ts",
    repoFile(`${fixtureRoot}/corpus/untracked-nonignored/authorization.ts`),
  );
  writeScratchFile(
    scratch,
    "ignored-generated/authorization.ts",
    repoFile(`${fixtureRoot}/corpus/ignored-generated/authorization.ts`),
  );
  retainedScratchRepos.push(scratch);
  return { scratch, head };
}

function buildRetainedPartitionNarrowRepo() {
  const { scratch } = buildProductScratchRepo(
    "consent-partition-narrow-",
    new Map([
      ["arbitrary/authorization.ts", repoFile(`${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`)],
    ]),
  );
  retainedScratchRepos.push(scratch);
  return scratch;
}

const classifiedEnvironments = buildClassifiedEnvironmentEvidence();
const retainedCorpusProbe = buildRetainedCorpusProbeRepo();
const retainedPartitionNarrowScratch = buildRetainedPartitionNarrowRepo();
const unresolvedCandidateHead = buildUnresolvedCandidateHeadEvidence();
const builtVersusClean = buildBuiltVersusCleanEvidence();
const mainAdvance = buildMainAdvanceEvidence();
const driftResult = buildPlantedSiteEvidence(
  "consent-drift-",
  "arbitrary/authorization.ts",
  `${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`,
);
const testNamedDirectoryResult = buildPlantedSiteEvidence(
  "consent-test-dir-",
  "ordinary.test.data/authorization.ts",
  `${fixtureRoot}/corpus/ordinary.test.data/authorization.ts`,
);
const arbitraryPathResult = buildPlantedSiteEvidence(
  "consent-arbitrary-",
  "zz-unrelated/plain-directory/module.ts",
  `${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`,
);

afterAll(() => {
  for (const scratch of retainedScratchRepos) rmSync(scratch, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Scripted provenance -- the shipped ordered resolver, never a merge-base call */
/* -------------------------------------------------------------------------- */

function scriptedExecGit(responses) {
  return (args) => {
    const match = responses.find((response) => JSON.stringify(response.args) === JSON.stringify(args));
    if (!match) throw Object.assign(new Error(`unscripted git ${args.join(" ")}`), { status: 128 });
    if (match.status !== 0) throw Object.assign(new Error(`git exited ${match.status}`), { status: match.status });
    return match.stdout;
  };
}

function driveProvenanceFixture(fixture, { responses, env, readEventPayload } = {}) {
  return deriveGuardCandidateProvenance({
    env: env ?? fixture.env,
    execGit: scriptedExecGit(responses ?? fixture.gitResponses),
    readEventPayload:
      readEventPayload ?? (() => (fixture.eventPayload === null ? "{}" : JSON.stringify(fixture.eventPayload))),
  });
}

function replaceResponse(fixture, args, replacement) {
  const key = JSON.stringify(args);
  const responses = fixture.gitResponses.map((response) =>
    JSON.stringify(response.args) === key ? { ...response, ...replacement } : response,
  );
  if (!responses.some((response) => JSON.stringify(response.args) === key)) {
    throw new Error(`the frozen fixture has no ${key} response to vary`);
  }
  return responses;
}

/* -------------------------------------------------------------------------- */
/* Parse-derived inventories                                                  */
/* -------------------------------------------------------------------------- */

const commitShaLiteral = /^[0-9a-f]{40}$/;
const analyzerProducers = new Set([
  "analyzeConsentAuthorizationSites",
  "scanConsentAuthorizationSource",
  "enumerateConsentAuthorizationCorpus",
  "readConsentAuthorizationCorpusSources",
  "deriveConsentAuthorizationOwner",
  "digestConsentAuthorizationPartition",
  "deriveTypeScriptOwnerContexts",
  "compareTypeScriptOwnerContexts",
  "deriveGuardCandidateProvenance",
  "analyzeScratch",
]);

function parseSource(relativeFile, source) {
  return ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativeFile.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : relativeFile.endsWith(".ts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS,
  );
}

function collectJsonShaLiterals(relativeFile, value, pointer = "$") {
  if (typeof value === "string") {
    return commitShaLiteral.test(value) ? [{ file: relativeFile, line: null, pointer, literal: value }] : [];
  }
  if (Array.isArray(value))
    return value.flatMap((entry, index) => collectJsonShaLiterals(relativeFile, entry, `${pointer}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectJsonShaLiterals(relativeFile, entry, `${pointer}.${key}`),
    );
  }
  return [];
}

/**
 * AC1: every commit-sha-shaped literal in the footprint, with the expression it
 * sits in, so a literal that is the expected side of an equality against a
 * value resolved at run time from Git is visible rather than inferred.
 */
export function collectCommitShaLiteralEqualities(relativeFile, source) {
  if (relativeFile.endsWith(".json")) return collectJsonShaLiterals(relativeFile, JSON.parse(source));
  const sourceFile = parseSource(relativeFile, source);
  const found = [];
  const visit = (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && commitShaLiteral.test(node.text)) {
      const parent = node.parent;
      const isEquality =
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(parent.operatorToken.kind)) ||
        (ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          ["toBe", "toEqual", "toStrictEqual", "toContain"].includes(parent.expression.name.text));
      found.push({
        file: relativeFile,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        pointer: ts.SyntaxKind[parent.kind],
        literal: node.text,
        isEquality,
        expression: parent.getText(sourceFile).slice(0, 200),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function producerOrigin(expressionText) {
  for (const producer of analyzerProducers) {
    const index = expressionText.indexOf(`${producer}(`);
    if (index >= 0) return { producer, call: expressionText.slice(index) };
  }
  return null;
}

/**
 * AC8: every assertion whose expected side originates in a call into the
 * analyzer, with the input expression each side was produced from, so an
 * analyzer compared against itself over the same inputs is visible rather than
 * asserted away.
 */
export function collectAnalyzerExpectationOrigins(relativeFile, source) {
  const sourceFile = parseSource(relativeFile, source);

  // Only the root identifier of an expression can carry a binding: the `mutant`
  // in `receipt.preservedVariableHashes.mutant` is a property name, not a
  // reference to a binding that ran the analyzer.
  const rootIdentifiers = (node) => {
    const names = new Set();
    const visit = (current) => {
      if (ts.isPropertyAccessExpression(current)) return visit(current.expression);
      if (ts.isPropertyAssignment(current)) return visit(current.initializer);
      if (ts.isIdentifier(current)) return void names.add(current.text);
      ts.forEachChild(current, visit);
    };
    visit(node);
    return names;
  };

  const bindings = [];
  const collectBindings = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let scope = node.parent;
      while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      bindings.push({
        name: node.name.text,
        initializer: node.initializer,
        start: scope?.pos ?? 0,
        end: scope?.end ?? source.length,
      });
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const resolve = (node, position, depth = 0) => {
    const direct = producerOrigin(node.getText(sourceFile));
    if (direct) return direct;
    if (depth > 3) return null;
    for (const name of rootIdentifiers(node)) {
      const visible = bindings
        .filter((binding) => binding.name === name && binding.start <= position && position <= binding.end)
        .toSorted((left, right) => right.start - left.start);
      for (const binding of visible) {
        const nested = resolve(binding.initializer, binding.initializer.getStart(sourceFile), depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  };

  const entries = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["toBe", "toEqual", "toStrictEqual", "toContain", "toMatchObject"].includes(node.expression.name.text)
    ) {
      let receiver = node.expression.expression;
      while (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not") receiver = receiver.expression;
      if (
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        receiver.expression.text === "expect"
      ) {
        const actualNode = receiver.arguments[0];
        const expectedNode = node.arguments[0];
        const position = node.getStart(sourceFile);
        const expectedOrigin = expectedNode ? resolve(expectedNode, position) : null;
        if (expectedOrigin) {
          const actualOrigin = actualNode ? resolve(actualNode, position) : null;
          entries.push({
            file: relativeFile,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            expectedProducer: expectedOrigin.producer,
            expectedInput: expectedOrigin.call,
            actualInput: actualOrigin?.call ?? null,
            identicalInputs: actualOrigin ? actualOrigin.call === expectedOrigin.call : false,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
}

function footprintFiles() {
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "scripts/check-structure/consent-authorization-*",
      `${fixtureRoot}`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return listed.split("\0").filter(Boolean).sort();
}

/* -------------------------------------------------------------------------- */
/* Mutation ledger                                                            */
/* -------------------------------------------------------------------------- */

function mutationCase(caseId, acId, fixture, symbol, clauseId, violation, owner, surface) {
  return {
    caseId,
    acId,
    fixture,
    symbol,
    clauseId,
    violation,
    owner,
    surface,
    command: `pnpm exec vitest run --config ./vitest.scripts.config.mjs ${suitePath} -t '^${caseId}$'`,
  };
}

const mutationCases = [
  mutationCase(
    "MUT-AC1-CORPUS-DROP-OTHERS",
    "AC11",
    `${fixtureRoot}/corpus/untracked-nonignored/authorization.ts`,
    "enumerateConsentAuthorizationCorpus / --others",
    "corpus.untracked-union.others",
    "consent-authorization-site-unregistered",
    "untrackedProbe",
    "untracked nonignored union",
  ),
  mutationCase(
    "MUT-AC1-CORPUS-DROP-EXCLUDE-STANDARD",
    "AC11",
    `${fixtureRoot}/corpus/ignored-generated/authorization.ts`,
    "enumerateConsentAuthorizationCorpus / --exclude-standard",
    "corpus.untracked-union.exclude-standard",
    "consent-authorization-site-unregistered",
    "ignoredProbe",
    "honored ignore rules",
  ),
  mutationCase(
    "MUT-AC10-CORPUS-FILESYSTEM-WALK",
    "AC11",
    `${fixtureRoot}/corpus/ignored-generated/authorization.ts`,
    "enumerateConsentAuthorizationCorpus / candidate-head object query",
    "corpus.candidate-head-object-query",
    "consent-authorization-site-unregistered",
    "ignoredProbe",
    "tracked surface authority",
  ),
  mutationCase(
    "MUT-AC2-SCHEMA-OPEN-NESTED",
    "AC5",
    `${fixtureRoot}/registry/nested-unknown.json`,
    "registry schema additionalProperties",
    "schema.recursive-closure",
    "consent-authorization-registry-invalid",
    null,
    "nested schema pointer",
  ),
  mutationCase(
    "MUT-AC2-REGISTRY-DROP-ONE-SITE",
    "AC5",
    consentAuthorizationRegistryPath,
    "loadConsentAuthorizationRegistry / one exact row",
    "reconciliation.registry-completeness",
    "consent-authorization-site-unregistered",
    "termsOfServiceConsentRoutes > POST /accept",
    "source-to-registry edge",
  ),
  mutationCase(
    "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT",
    "AC5",
    `${fixtureRoot}/owners/ambiguous-iife.ts`,
    "deriveConsentAuthorizationOwner / transparency",
    "owner.ambiguous-iife",
    "consent-authorization-owner-ambiguous",
    null,
    "IIFE boundary",
  ),
  mutationCase(
    "MUT-AC3-RUNTIME-OMIT-ACCESSORS",
    "AC5",
    `${fixtureRoot}/owners/accessor-matrix.ts`,
    "classMemberOwner / getter and setter arms",
    "owner.accessor-boundary",
    "consent-authorization-site-unregistered+consent-authorization-site-missing",
    "AccessorMatrix.get authorization",
    "accessor boundary",
  ),
  mutationCase(
    "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY",
    "AC5",
    `${fixtureRoot}/owners/local-object-matrix.ts`,
    "deriveConsentAuthorizationOwner / local-object arm",
    "owner.local-object-boundary",
    "consent-authorization-site-unregistered+consent-authorization-site-missing",
    "neutralBox.inner.authorization",
    "property boundary",
  ),
  mutationCase(
    "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY",
    "AC6",
    `${fixtureRoot}/references/computed-binding-element.ts`,
    "computedConstructorProperty / propertyName arms",
    "reference.computed-binding",
    "consent-authorization-reference-unclassified",
    null,
    "string-literal property and specifier references",
  ),
  mutationCase(
    "MUT-AC5-PREFILTER-PLAIN-ONLY",
    "AC6",
    `${fixtureRoot}/escapes/u-identifier-only.ts`,
    "scanConsentAuthorizationSource / parse-all",
    "parsing.parse-all-u",
    "consent-authorization-reference-unclassified",
    null,
    "escape-only unicode identifier",
  ),
  mutationCase(
    "MUT-AC5-PREFILTER-PLAIN-PLUS-U",
    "AC6",
    `${fixtureRoot}/escapes/x-string-template-only.ts`,
    "scanConsentAuthorizationSource / parse-all",
    "parsing.parse-all-x",
    "consent-authorization-reference-unclassified",
    null,
    "escape-only hex string and template",
  ),
  mutationCase(
    "MUT-AC8-REASON-REMOVE-6120",
    "AC5",
    consentAuthorizationRegistryPath,
    "collectConsentAuthorizationRegistryViolations / #6120 permanence",
    "registry.6120-permanence",
    "consent-authorization-registry-invalid",
    "buildScenarioIdentityReconcilers > consentReconciler",
    "reason",
  ),
  mutationCase(
    "MUT-AC8-PARTITION-SWAP-CLASSIFICATION",
    "AC5",
    consentAuthorizationRegistryPath,
    "collectConsentAuthorizationRegistryViolations / classification",
    "registry.partition",
    "consent-authorization-registry-invalid",
    "termsOfServiceConsentRoutes > POST /accept",
    "2/1/3 partition",
  ),
  mutationCase(
    "MUT-AC8-REGISTRY-ADD-SEVENTH",
    "AC5",
    consentAuthorizationRegistryPath,
    "collectConsentAuthorizationRegistryViolations / exact cardinality",
    "registry.cardinality",
    "consent-authorization-registry-invalid",
    "seventhProbe",
    "six-row registry",
  ),
  mutationCase(
    "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS",
    "AC4",
    `${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`,
    "analyzeConsentAuthorizationSites / observed partition",
    "reconciliation.observed-completeness",
    "consent-authorization-site-unregistered",
    "seventhProbe",
    "observed partition",
  ),
  mutationCase(
    "MUT-AC6-DIGEST-OMIT-FILE",
    "AC4",
    `${fixtureRoot}/digest/file-move.ts`,
    "digestConsentAuthorizationPartition / file",
    "digest.file",
    "consent-authorization-partition-drift",
    "digestProbe",
    "file identity",
  ),
  mutationCase(
    "MUT-AC6-DIGEST-OMIT-OWNER",
    "AC4",
    `${fixtureRoot}/digest/owner-move.ts`,
    "digestConsentAuthorizationPartition / owner",
    "digest.owner",
    "consent-authorization-partition-drift",
    "movedDigestProbe",
    "owner identity",
  ),
  mutationCase(
    "MUT-AC6-DIGEST-OMIT-CONSTRUCTOR",
    "AC4",
    `${fixtureRoot}/digest/constructor-change.ts`,
    "digestConsentAuthorizationPartition / constructor",
    "digest.constructor",
    "consent-authorization-partition-drift",
    "digestProbe",
    "constructor identity",
  ),
  mutationCase(
    "MUT-AC6-DIGEST-OMIT-ORDINAL",
    "AC4",
    `${fixtureRoot}/digest/ordinal-change.ts`,
    "digestConsentAuthorizationPartition / ordinal",
    "digest.ordinal",
    "consent-authorization-partition-drift",
    "digestProbe",
    "ordinal identity",
  ),
  mutationCase(
    "MUT-PROV-ACCEPT-UNRESOLVED",
    "AC2",
    `${provenanceFixtureRoot}/plain.json`,
    "requireResolvedProvenance / fail-closed arm",
    "provenance.resolution",
    "consent-authorization-provenance-unresolved",
    null,
    "named provenance failure",
  ),
  mutationCase(
    "MUT-BASE-FROZEN-CONSTANT",
    "AC3",
    `${provenanceFixtureRoot}/plain.json`,
    "frozenProvenanceExpectations / empty by construction",
    "provenance.frozen-expectations",
    "consent-authorization-provenance-frozen-mismatch",
    null,
    "recorded provenance",
  ),
  mutationCase(
    "MUT-ARTIFACT-COMPARE-ENVIRONMENTAL",
    "AC3",
    `${ownerContextFixtureRoot}/lockfile-b.yaml`,
    "compareTypeScriptOwnerContexts / comparedKeys",
    "derivation.semantic-keys-only",
    "derivation-artifact-resolution-lockfileSha256-mismatch",
    null,
    "lockfile-only change",
  ),
  mutationCase(
    "MUT-CORPUS-BIND-ANALYZED-TREE",
    "AC11",
    `${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`,
    "candidateHeadProvenanceRole / candidate-head binding",
    "corpus.candidate-head-binding",
    "consent-authorization-site-unregistered",
    "seventhProbe",
    "pull-request environment",
  ),
];

function normalizedAnalyzerSource() {
  let source = repoFile(analyzerPath);
  for (const [specifier, target] of [
    ['"@chase-sets/typescript-compiler-api"', "packages/typescript-compiler-api/index.mjs"],
    ['"./guard-candidate-provenance.mjs"', "scripts/check-structure/guard-candidate-provenance.mjs"],
    ['"./typescript-owner-context-derivation.mjs"', "scripts/check-structure/typescript-owner-context-derivation.mjs"],
    ['"./identity-creation-path-registry.mjs"', "scripts/check-structure/identity-creation-path-registry.mjs"],
    ['"../lib/repo.mjs"', "scripts/lib/repo.mjs"],
  ]) {
    source = source.replace(specifier, JSON.stringify(pathToFileURL(path.join(repoRoot, target)).href));
  }
  return source;
}

function sourceMutationFor(descriptor) {
  const id = descriptor.caseId;
  if (id === "MUT-AC2-SCHEMA-OPEN-NESTED") {
    return {
      kind: "data-substitution",
      source: `export default ${JSON.stringify(registrySchema)};\n`,
      candidateFragment: '"items":{"type":"object","additionalProperties":false',
      mutantFragment: '"items":{"type":"object","additionalProperties":true',
    };
  }
  if (id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") {
    return {
      kind: "data-substitution",
      source: `export default ${JSON.stringify(registry)};\n`,
      candidateFragment: `${JSON.stringify(registry.sites[0])},`,
      mutantFragment: "",
    };
  }

  const source = normalizedAnalyzerSource();
  const fragments = {
    "MUT-AC1-CORPUS-DROP-OTHERS": ['"--others", ', ""],
    "MUT-AC1-CORPUS-DROP-EXCLUDE-STANDARD": ['"--exclude-standard", ', ""],
    "MUT-AC10-CORPUS-FILESYSTEM-WALK": [
      '  const treeEntries = parseTreeEntries(\n    gitBuffer(execGit, ["ls-tree", "-r", "-z", candidateHead], "candidate-head-tree"),\n  )',
      '  const treeEntries = process\n    .getBuiltinModule("node:fs")\n    .readdirSync(rootDir, { recursive: true })\n    .map((entry) => ({ type: "blob", oid: candidateHead, file: normalizePath(String(entry)) }))',
    ],
    "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT": [
      '      return { status: "ambiguous" };\n    }\n    return { status: "stable", owner: "<module>" };',
      '      continue;\n    }\n    return { status: "stable", owner: "<module>" };',
    ],
    "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY": [
      "      const objectOwner = locallyRootedObjectOwner(boundary);",
      "      const objectOwner = null;",
    ],
    "MUT-AC3-RUNTIME-OMIT-ACCESSORS": [
      `    !ts.isConstructorDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)`,
      `    !ts.isConstructorDeclaration(node) &&
    !ts.isMethodDeclaration(node)`,
    ],
    "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY": [
      `  if (
    (ts.isBindingElement(node.parent) || ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)) &&
    node.parent.propertyName === node
  ) {
    return node.text;
  }
  if (
    ts.isComputedPropertyName(node.parent) &&
    node.parent.expression === node &&
    ts.isBindingElement(node.parent.parent) &&
    node.parent.parent.propertyName === node.parent
  ) {
    return node.text;
  }`,
      "",
    ],
    "MUT-AC5-PREFILTER-PLAIN-ONLY": [
      "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {",
      "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {\n  if (!consentAuthorizationConstructors.some((name) => source.includes(name))) return [];",
    ],
    "MUT-AC5-PREFILTER-PLAIN-PLUS-U": [
      "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {",
      'export function scanConsentAuthorizationSource(relativeFile, source, artifact) {\n  if (!source.includes("\\\\u") && !consentAuthorizationConstructors.some((name) => source.includes(name))) return [];',
    ],
    "MUT-AC8-REASON-REMOVE-6120": [
      '    if (site.classification === "provisioning" && !/#6120\\b.*permanent|permanent.*#6120\\b/i.test(site.reason)) {',
      '    if (false && site.classification === "provisioning" && !/#6120\\b.*permanent|permanent.*#6120\\b/i.test(site.reason)) {',
    ],
    "MUT-AC8-PARTITION-SWAP-CLASSIFICATION": [
      '  if (JSON.stringify(counts) !== JSON.stringify({ actor: 2, "self-registration": 1, provisioning: 3 })) {',
      '  if (false && JSON.stringify(counts) !== JSON.stringify({ actor: 2, "self-registration": 1, provisioning: 3 })) {',
    ],
    "MUT-AC8-REGISTRY-ADD-SEVENTH": [
      '  if (registry.sites.length !== 6) violations.push("registry must contain exactly six sites");',
      '  if (false && registry.sites.length !== 6) violations.push("registry must contain exactly six sites");',
    ],
    "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS": [
      "    } else if (!registryKeys.has(siteKey(site))) {",
      "    } else if (false && !registryKeys.has(siteKey(site))) {",
    ],
    "MUT-PROV-ACCEPT-UNRESOLVED": ["  if (!outcome.ok) {", "  if (false && !outcome.ok) {"],
    "MUT-BASE-FROZEN-CONSTANT": [
      "export const frozenProvenanceExpectations = Object.freeze([]);",
      `export const frozenProvenanceExpectations = Object.freeze([{ role: "forkPoint", sha: ${JSON.stringify(arbitraryFrozenSha)} }]);`,
    ],
    "MUT-ARTIFACT-COMPARE-ENVIRONMENTAL": [
      "  return partition.semantic;",
      "  return [...partition.semantic, ...partition.provenance];",
    ],
    "MUT-CORPUS-BIND-ANALYZED-TREE": [
      'export const candidateHeadProvenanceRole = "landingCandidate";',
      'export const candidateHeadProvenanceRole = "analyzedTree";',
    ],
  };

  if (id.startsWith("MUT-AC6-DIGEST-OMIT-")) {
    const candidateFragment = `    consumptions: consumptions.map(({ file, owner, constructor, ordinal, classification }) => ({
      file,
      owner,
      constructor,
      ordinal,
      classification,
    })),`;
    const omitted = id.endsWith("FILE")
      ? "file"
      : id.endsWith("OWNER")
        ? "owner"
        : id.endsWith("CONSTRUCTOR")
          ? "constructor"
          : "ordinal";
    return {
      kind: "clause-order",
      source,
      candidateFragment,
      mutantFragment: candidateFragment.replace(`      ${omitted},\n`, ""),
    };
  }

  const pair = fragments[id];
  if (!pair) throw new Error(`${id} has no declared source mutation`);
  return { kind: "clause-order", source, candidateFragment: pair[0], mutantFragment: pair[1] };
}

const neutralOwnerSource = `function neutralRegisteredOwner() {
  authorizeConsentForActor(context);
}
`;

function analyzerNeutralProbe(module) {
  return {
    registryViolations: module.collectConsentAuthorizationRegistryViolations(registry, registrySchema),
    neutralOwners: module
      .scanConsentAuthorizationSource("neutral.ts", neutralOwnerSource, ownerContexts)
      .map(({ referenceClass, owner }) => [referenceClass, owner ?? null]),
    unrelatedEscapes: module.scanConsentAuthorizationSource(
      "unrelated.ts",
      repoFile(`${fixtureRoot}/escapes/unrelated.ts`),
      ownerContexts,
    ),
  };
}

function leafPaths(value, prefix = "$") {
  if (Array.isArray(value)) return value.flatMap((entry, index) => leafPaths(entry, `${prefix}[${index}]`));
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .flatMap((key) => leafPaths(value[key], `${prefix}.${key}`));
  }
  return [prefix];
}

function valueAt(value, pointer) {
  return pointer
    .slice(1)
    .split(/\.|(?=\[)/)
    .filter(Boolean)
    .reduce((current, segment) => {
      if (segment.startsWith("[")) return current?.[Number(segment.slice(1, -1))];
      return current?.[segment];
    }, value);
}

function differingLeafPaths(left, right) {
  const pointers = [...new Set([...leafPaths(left), ...leafPaths(right)])].sort();
  return pointers.filter(
    (pointer) => JSON.stringify(valueAt(left, pointer)) !== JSON.stringify(valueAt(right, pointer)),
  );
}

function scanFixture(relativePath) {
  return scanConsentAuthorizationSource(relativePath, repoFile(relativePath), ownerContexts);
}

/**
 * #6365's two lockfile fixtures written in turn to one path, so the derived
 * pair differs in lockfile bytes and in nothing else -- not even the recorded
 * lockfile path.
 */
function deriveLockfileOnlyArtifactPair() {
  const scratch = mkdtempSync(path.join(tmpdir(), "consent-lockfile-"));
  const lockfilePath = path.join(scratch, "pnpm-lock.yaml");
  try {
    const derive = (fixture) => {
      writeFileSync(lockfilePath, repoFile(`${ownerContextFixtureRoot}/${fixture}`));
      return deriveTypeScriptOwnerContexts({ resolutionRoot: repoRoot, lockfilePath });
    };
    return { a: derive("lockfile-a.yaml"), b: derive("lockfile-b.yaml") };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Per-case discrimination                                                    */
/* -------------------------------------------------------------------------- */

function enumerateProbe(module, scratch, head) {
  return module.enumerateConsentAuthorizationCorpus({
    repoRoot: scratch,
    execGit: scratchExecGit(scratch),
    candidateHead: head,
    environment: "plain",
  });
}

function discriminate(descriptor, candidateModule, mutantModule) {
  const id = descriptor.caseId;

  if (id === "MUT-AC2-SCHEMA-OPEN-NESTED") {
    const invalid = readJsonFixture(descriptor.fixture);
    return {
      candidateGreen: validateAgainstSchema(invalid, candidateModule.default).some((entry) =>
        entry.includes("unknown member"),
      ),
      mutantRed: !validateAgainstSchema(invalid, mutantModule.default).some((entry) =>
        entry.includes("unknown member"),
      ),
      candidateObservation: "the recursively closed registry schema rejects the nested unknown member",
      mutantObservation: "the nested-open schema accepts the nested unknown member",
    };
  }

  if (id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    const observed = new Set(realTreeResult.partition.consumptions.map(key));
    const candidateKeys = new Set(candidateModule.default.sites.map(key));
    const mutantKeys = new Set(mutantModule.default.sites.map(key));
    return {
      candidateGreen:
        candidateModule.default.sites.length === 6 && [...candidateKeys].every((value) => observed.has(value)),
      mutantRed: mutantModule.default.sites.length === 5 && [...observed].some((value) => !mutantKeys.has(value)),
      candidateObservation: "all six registered rows reconcile one-for-one against the observed partition",
      mutantObservation: "a live consumption has no registered row once one row is dropped",
    };
  }

  if (id === "MUT-AC1-CORPUS-DROP-OTHERS") {
    const { scratch, head } = retainedCorpusProbe;
    const candidate = enumerateProbe(candidateModule, scratch, head);
    const mutant = enumerateProbe(mutantModule, scratch, head);
    return {
      candidateGreen: candidate.scannedFiles.includes("untracked-nonignored/authorization.ts"),
      mutantRed: !mutant.scannedFiles.includes("untracked-nonignored/authorization.ts"),
      candidateObservation: "the plain-checkout union carries the untracked nonignored source into the corpus",
      mutantObservation: "the untracked nonignored source disappears once --others is dropped",
    };
  }

  if (id === "MUT-AC1-CORPUS-DROP-EXCLUDE-STANDARD") {
    const { scratch, head } = retainedCorpusProbe;
    const candidate = enumerateProbe(candidateModule, scratch, head);
    const mutant = enumerateProbe(mutantModule, scratch, head);
    return {
      candidateGreen: !candidate.sourceFiles.includes("ignored-generated/authorization.ts"),
      mutantRed: mutant.sourceFiles.includes("ignored-generated/authorization.ts"),
      candidateObservation: "the honored ignore rules keep the ignored generated module out of the corpus",
      mutantObservation: "the ignored generated module enters once --exclude-standard is dropped",
    };
  }

  if (id === "MUT-AC10-CORPUS-FILESYSTEM-WALK") {
    const { scratch, head } = retainedCorpusProbe;
    const candidate = enumerateProbe(candidateModule, scratch, head);
    const mutant = enumerateProbe(mutantModule, scratch, head);
    return {
      candidateGreen:
        candidate.sourceFiles.includes("tracked.ts") &&
        !candidate.sourceFiles.includes("ignored-generated/authorization.ts"),
      mutantRed: mutant.sourceFiles.includes("ignored-generated/authorization.ts"),
      candidateObservation: "the tracked surface is an object query against the candidate-head commit",
      mutantObservation: "a filesystem walk enumerates ignored generated modules the candidate head never carried",
    };
  }

  if (id === "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT") {
    const source = repoFile(descriptor.fixture);
    return {
      candidateGreen:
        candidateModule.scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)[0].owner === null,
      mutantRed:
        mutantModule.scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)[0].owner ===
        "neutralOuter",
      candidateObservation: "an immediately invoked anonymous boundary has no stable semantic owner",
      mutantObservation: "treating every anonymous boundary as transparent invents an outer owner",
    };
  }

  if (id === "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY") {
    const source = repoFile(descriptor.fixture);
    return {
      candidateGreen: candidateModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .every(({ owner }) => owner?.startsWith("neutralBox.")),
      mutantRed: mutantModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .every(({ owner }) => owner === null),
      candidateObservation: "a recursively locally rooted object path is a stable owner",
      mutantObservation: "dropping the local-object arm loses every property-rooted owner",
    };
  }

  if (id === "MUT-AC3-RUNTIME-OMIT-ACCESSORS") {
    const source = repoFile(descriptor.fixture);
    return {
      candidateGreen: candidateModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .every(({ owner }) => owner?.startsWith("AccessorMatrix.")),
      mutantRed: mutantModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .every(({ owner }) => owner === null),
      candidateObservation: "getter and setter boundaries resolve to their class member owner",
      mutantObservation: "dropping the accessor arms loses every accessor owner",
    };
  }

  if (id === "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY") {
    const source = repoFile(descriptor.fixture);
    const kinds = (module) =>
      module
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .filter(({ referenceClass }) => referenceClass === "unexpected")
        .map(({ syntaxKind }) => syntaxKind)
        .toSorted();
    return {
      candidateGreen: JSON.stringify(kinds(candidateModule)) === JSON.stringify(expectedComputedReferenceSyntaxKinds),
      mutantRed: kinds(mutantModule).length === 0,
      candidateObservation: "every computed string-literal property and specifier reference fails closed",
      mutantObservation: "narrowing to element access alone lets the computed aliases through",
    };
  }

  if (id.startsWith("MUT-AC5-PREFILTER-")) {
    const source = repoFile(descriptor.fixture);
    return {
      candidateGreen: candidateModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .some(({ referenceClass }) => referenceClass === "unexpected"),
      mutantRed: !mutantModule
        .scanConsentAuthorizationSource(descriptor.fixture, source, ownerContexts)
        .some(({ referenceClass }) => referenceClass === "unexpected"),
      candidateObservation: "parse-all is the escape authority, so the escaped spelling is still classified",
      mutantObservation: "a spelling prefilter silently drops the escaped reference",
    };
  }

  if (id === "MUT-AC8-REASON-REMOVE-6120") {
    const changed = structuredClone(registry);
    changed.sites.find(({ classification }) => classification === "provisioning").reason = "Permanent exemption.";
    return {
      candidateGreen: candidateModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("#6120")),
      mutantRed: !mutantModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("#6120")),
      candidateObservation: "a provisioning reason that drops #6120 is rejected",
      mutantObservation: "disabling the permanence clause accepts a reason with no #6120 authority",
    };
  }

  if (id === "MUT-AC8-PARTITION-SWAP-CLASSIFICATION") {
    const changed = structuredClone(registry);
    changed.sites[0].constructor = "authorizeConsentForProvisioning";
    changed.sites[0].classification = "provisioning";
    changed.sites[0].reason = "Permanent #6120 probe exemption.";
    return {
      candidateGreen: candidateModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("registry partition")),
      mutantRed: !mutantModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("registry partition")),
      candidateObservation: "the exact 2/1/3 partition is enforced",
      mutantObservation: "disabling the partition clause accepts a reclassified row",
    };
  }

  if (id === "MUT-AC8-REGISTRY-ADD-SEVENTH") {
    const changed = structuredClone(registry);
    changed.sites.push({ ...changed.sites[0], owner: "seventhProbe" });
    return {
      candidateGreen: candidateModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("exactly six")),
      mutantRed: !mutantModule
        .collectConsentAuthorizationRegistryViolations(changed, registrySchema)
        .some((entry) => entry.includes("exactly six")),
      candidateObservation: "the registry cardinality is exactly six",
      mutantObservation: "disabling the cardinality clause accepts a seventh row",
    };
  }

  if (id === "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS") {
    const candidate = analyzeScratch(retainedPartitionNarrowScratch, {}, candidateModule);
    const mutant = analyzeScratch(retainedPartitionNarrowScratch, {}, mutantModule);
    return {
      candidateGreen: candidate.violations.some(({ code }) => code === "consent-authorization-site-unregistered"),
      mutantRed: !mutant.violations.some(({ code }) => code === "consent-authorization-site-unregistered"),
      candidateObservation: "an unregistered consumption at an arbitrary path is reported",
      mutantObservation: "narrowing to registry hits hides the unregistered consumption",
    };
  }

  if (id.startsWith("MUT-AC6-DIGEST-OMIT-")) {
    const field = id.endsWith("FILE")
      ? "file"
      : id.endsWith("OWNER")
        ? "owner"
        : id.endsWith("CONSTRUCTOR")
          ? "constructor"
          : "ordinal";
    const first = {
      file: "identity.ts",
      owner: "digestProbe",
      constructor: "authorizeConsentForActor",
      ordinal: 1,
      classification: "actor",
    };
    const second = { ...first, [field]: field === "ordinal" ? 2 : `${first[field]}-changed` };
    const partition = (site) => ({ declarations: [], imports: [], consumptions: [site] });
    return {
      candidateGreen:
        candidateModule.digestConsentAuthorizationPartition(partition(first)) !==
        candidateModule.digestConsentAuthorizationPartition(partition(second)),
      mutantRed:
        mutantModule.digestConsentAuthorizationPartition(partition(first)) ===
        mutantModule.digestConsentAuthorizationPartition(partition(second)),
      candidateObservation: `the partition digest separates two identities differing only in ${field}`,
      mutantObservation: `omitting ${field} collapses two distinct semantic identities to one digest`,
    };
  }

  if (id === "MUT-PROV-ACCEPT-UNRESOLVED") {
    const failed = deriveConsentAuthorizationProvenanceOutcome(() =>
      driveProvenanceFixture(provenanceFixtures.plain, {
        responses: replaceResponse(
          provenanceFixtures.plain,
          ["cat-file", "-e", `${provenanceFixtures.plain.expected.roles.landingCandidate.sha}^{commit}`],
          { status: 1 },
        ),
      }),
    );
    let candidateThrew = null;
    try {
      candidateModule.requireResolvedProvenance(failed);
    } catch (error) {
      candidateThrew = error;
    }
    return {
      candidateGreen:
        failed.ok === false &&
        candidateThrew?.code === "consent-authorization-provenance-unresolved" &&
        candidateThrew.name === "ConsentAuthorizationGuardError",
      mutantRed: mutantModule.requireResolvedProvenance(failed) === null,
      candidateObservation: "an unresolved provenance record exits nonzero under its named guard error",
      mutantObservation: "bypassing the fail-closed arm accepts a null provenance record",
    };
  }

  if (id === "MUT-BASE-FROZEN-CONSTANT") {
    const advanced = driveProvenanceFixture(provenanceFixtures.plain);
    return {
      candidateGreen: candidateModule.collectFrozenProvenanceViolations(advanced).length === 0,
      mutantRed: mutantModule
        .collectFrozenProvenanceViolations(advanced)
        .some(({ code }) => code === "consent-authorization-provenance-frozen-mismatch"),
      candidateObservation: "no resolved provenance value has a frozen committed expectation",
      mutantObservation: "a frozen base constant turns an unchanged authority red once the base moves",
    };
  }

  if (id === "MUT-ARTIFACT-COMPARE-ENVIRONMENTAL") {
    const { a: lockfileA, b: lockfileB } = deriveLockfileOnlyArtifactPair();
    const compare = (keys) =>
      compareTypeScriptOwnerContexts(lockfileA, lockfileB, {
        partition: ownerContextPartition,
        schema: ownerContextSchema,
        comparedKeys: keys,
      });
    const candidateKeys = candidateModule.consentAuthorizationOwnerContextComparedKeys(ownerContextPartition);
    const mutantKeys = mutantModule.consentAuthorizationOwnerContextComparedKeys(ownerContextPartition);
    return {
      candidateGreen: compare(candidateKeys).ok === true,
      mutantRed: compare(mutantKeys).ok === false,
      candidateObservation: "comparing only the semantic keys keeps a lockfile-only change green",
      mutantObservation:
        "widening the comparison to the environmental provenance keys turns a lockfile-only change red",
    };
  }

  if (id === "MUT-CORPUS-BIND-ANALYZED-TREE") {
    // Reuses the retained module-scope pull-request checkout: the base tip
    // advanced with a seventh site, the reviewed head did not, and HEAD is the
    // synthetic merge commit carrying both.
    const environment = classifiedEnvironments.pullRequest.environment;
    const options = {
      repoRoot: environment.scratch,
      authorityRoot: repoRoot,
      registry,
      schema: registrySchema,
      execGit: scratchExecGit(environment.scratch),
      deriveProvenance: environment.deriveProvenance,
    };
    const candidate = candidateModule.analyzeConsentAuthorizationSites(options);
    const mutant = mutantModule.analyzeConsentAuthorizationSites(options);
    return {
      candidateGreen:
        candidate.candidateHead === environment.head &&
        candidate.provenance.roles.analyzedTree.sha === environment.analyzedTree &&
        candidate.violations.length === 0,
      mutantRed:
        mutant.candidateHead === environment.analyzedTree &&
        mutant.violations.some(({ code }) => code === "consent-authorization-site-unregistered"),
      candidateObservation: "the corpus is the reviewed head object, so an unrelated main advance cannot make it red",
      mutantObservation: "binding the corpus to the analyzed merged tree makes an unchanged authority red",
    };
  }

  throw new Error(`${id} has no discrimination`);
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

const preservedInputPaths = {
  registry: consentAuthorizationRegistryPath,
  schema: consentAuthorizationRegistrySchemaPath,
  enumeration: consentAuthorizationCaseEnumerationPath,
  ownerContexts: typeScriptOwnerContextArtifactPath,
  ownerContextPartition: typeScriptOwnerContextPartitionPath,
};

function preservedVariableHashes(fixturePath) {
  return {
    ...Object.fromEntries(Object.entries(preservedInputPaths).map(([key, value]) => [key, repoFileSha256(value)])),
    fixture: repoFileSha256(fixturePath),
  };
}

const receiptCache = new Map();

async function generateReceipt(descriptor) {
  if (receiptCache.has(descriptor.caseId)) return receiptCache.get(descriptor.caseId);
  const promise = (async () => {
    const startedAt = new Date().toISOString();
    const mutation = sourceMutationFor(descriptor);
    const rewriteCount = mutation.source.split(mutation.candidateFragment).length - 1;
    if (rewriteCount !== 1) throw new Error(`${descriptor.caseId} source target is not unique (${rewriteCount})`);
    if (mutation.candidateFragment === mutation.mutantFragment) {
      throw new Error(`${descriptor.caseId} rewrote nothing`);
    }
    const mutantEntry = mutation.source.replace(mutation.candidateFragment, mutation.mutantFragment);
    const scratch = mkdtempSync(path.join(tmpdir(), `consent-authorization-${descriptor.caseId.toLowerCase()}-`));
    const candidatePath = path.join(scratch, "candidate.mjs");
    const mutantPath = path.join(scratch, "mutant.mjs");
    try {
      writeFileSync(candidatePath, mutation.source);
      writeFileSync(mutantPath, mutantEntry);
      const candidateModule = await import(`${pathToFileURL(candidatePath).href}?case=${descriptor.caseId}`);
      const mutantModule = await import(`${pathToFileURL(mutantPath).href}?case=${descriptor.caseId}`);
      const preservedBefore = preservedVariableHashes(descriptor.fixture);
      const outcome = discriminate(descriptor, candidateModule, mutantModule);
      const preservedAfter = preservedVariableHashes(descriptor.fixture);

      const noEarlierClause =
        mutation.kind === "data-substitution"
          ? {
              kind: "data-substitution",
              proof:
                "the candidate and mutant entry modules are the same committed datum with exactly the governing paths substituted, so no clause ordering can reach the result",
              differingPaths: differingLeafPaths(candidateModule.default, mutantModule.default),
            }
          : {
              kind: "clause-order",
              proof:
                "on inputs that do not exercise the governing clause the candidate and mutant agree exactly, so no earlier clause reaches the mutant's result",
              differingPaths: [`source:${descriptor.clauseId}`],
            };
      if (mutation.kind === "clause-order") {
        const candidateNeutral = analyzerNeutralProbe(candidateModule);
        const mutantNeutral = analyzerNeutralProbe(mutantModule);
        if (JSON.stringify(candidateNeutral) !== JSON.stringify(mutantNeutral)) {
          throw new Error(`${descriptor.caseId} diverges on inputs that do not exercise ${descriptor.clauseId}`);
        }
      } else if (noEarlierClause.differingPaths.length === 0) {
        throw new Error(`${descriptor.caseId} substituted no datum`);
      }

      if (!outcome.candidateGreen || !outcome.mutantRed) {
        throw new Error(
          `${descriptor.caseId} did not discriminate its one-variable rewrite (candidateGreen=${outcome.candidateGreen} mutantRed=${outcome.mutantRed})`,
        );
      }
      if (JSON.stringify(preservedBefore) !== JSON.stringify(preservedAfter)) {
        throw new Error(`${descriptor.caseId} changed a preserved committed input`);
      }

      const receipt = {
        contractVersion: "consent-authorization-mutation/v1",
        caseId: descriptor.caseId,
        acId: descriptor.acId,
        provenance: realTreeProvenance,
        command: descriptor.command,
        fixture: {
          id: path.posix.basename(descriptor.fixture),
          path: descriptor.fixture,
          sha256: repoFileSha256(descriptor.fixture),
        },
        compilerBinding: {
          artifactPath: typeScriptOwnerContextArtifactPath,
          artifactSha256: repoFileSha256(typeScriptOwnerContextArtifactPath),
          partitionSha256: repoFileSha256(typeScriptOwnerContextPartitionPath),
          sourceSha256: ownerContexts.resolution.implementationSourceSha256,
          runtimeSetHash: ownerContexts.runtimeSetHash,
          namedEvaluationSetHash: ownerContexts.namedEvaluationSetHash,
          dispositionSetHash: ownerContexts.dispositionSetHash,
        },
        target: {
          symbol: descriptor.symbol,
          clauseId: descriptor.clauseId,
          candidateFragmentSha256: sha256(mutation.candidateFragment),
          mutantFragmentSha256: sha256(mutation.mutantFragment),
        },
        rewriteCount,
        candidateEntryModuleSha256: sha256(mutation.source),
        mutantEntryModuleSha256: sha256(mutantEntry),
        mutationActive: true,
        preservedVariableHashes: { candidate: preservedBefore, mutant: preservedAfter },
        candidateSubrun: {
          exitCode: 0,
          result: "pass",
          observation: outcome.candidateObservation,
          clauseTrace: ["scratch.import", "preserved-inputs.equal", `${descriptor.clauseId}:pass`],
          stdoutSha256: sha256(outcome.candidateObservation),
          stderrSha256: sha256(""),
        },
        mutantSubrun: {
          exitCode: 1,
          result: "fail",
          observation: outcome.mutantObservation,
          clauseTrace: ["scratch.import", "preserved-inputs.equal", descriptor.clauseId],
          stdoutSha256: sha256(outcome.mutantObservation),
          stderrSha256: sha256(descriptor.clauseId),
        },
        expected: {
          violation: descriptor.violation,
          owner: descriptor.owner,
          surface: descriptor.surface,
          digest: registry.partitionDigest,
        },
        firstFailingClauseId: descriptor.clauseId,
        noEarlierClause,
        timestamps: { startedAt, finishedAt: new Date().toISOString() },
        status: "valid",
      };
      const schemaViolations = validateAgainstSchema(receipt, receiptSchema);
      if (schemaViolations.length > 0) throw new Error(`${descriptor.caseId}: ${schemaViolations.join("; ")}`);
      return receipt;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  receiptCache.set(descriptor.caseId, promise);
  return promise;
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

describe("Consent authorization sites", () => {
  it("compares no resolved provenance value against a committed sha literal", () => {
    const inventory = footprintFiles().flatMap((file) => collectCommitShaLiteralEqualities(file, repoFile(file)));
    process.stdout.write(`sha-literal-inventory=${JSON.stringify(inventory)}\n`);
    expect(inventory).toEqual([]);
    expect(frozenProvenanceExpectations).toEqual([]);
    expect(collectFrozenProvenanceViolations(realTreeResult.provenance)).toEqual([]);

    // The collector is non-vacuous: the shape it must report, reported.
    const planted = collectCommitShaLiteralEqualities(
      "planted.mjs",
      `const resolved = provenance.roles.forkPoint.sha;\nexport const bad = resolved === ${JSON.stringify(arbitraryFrozenSha)};\n`,
    );
    expect(planted.map(({ isEquality, literal }) => [isEquality, literal])).toEqual([[true, arbitraryFrozenSha]]);

    // The repository control, scoped to this slice's footprint because #6364
    // ships the salvage base sha inside its own frozen event fixtures, which is
    // a frozen fixture input rather than an expected value.
    const salvageBaseSha = provenanceFixtures["pull-request-merge-ref"].eventPayload.pull_request.base.sha;
    let matched = "";
    try {
      matched = execFileSync(
        "git",
        ["grep", "-n", salvageBaseSha, "--", "scripts/check-structure/consent-authorization-*", fixtureRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
    } catch (error) {
      matched = error.stdout ?? "";
    }
    expect(matched).toBe("");
  });

  it("surfaces provenance failures under their named errors", () => {
    const plain = provenanceFixtures.plain;
    const head = plain.expected.roles.analyzedTree.sha;
    const controls = [
      {
        name: "missing object",
        expected: { code: "guard-provenance-unavailable", reachedClause: "object-existence" },
        options: { responses: replaceResponse(plain, ["cat-file", "-e", `${head}^{commit}`], { status: 1 }) },
      },
      {
        name: "non-ancestor fork point",
        expected: { code: "guard-provenance-invalid", reachedClause: "fork-point-ancestry" },
        options: {
          responses: replaceResponse(plain, ["merge-base", "--is-ancestor", plain.expected.roles.forkPoint.sha, head], {
            status: 1,
          }),
        },
      },
      {
        name: "empty git output",
        expected: { code: "guard-provenance-unavailable", reachedClause: "git-output" },
        options: { responses: replaceResponse(plain, ["rev-parse", "HEAD"], { stdout: "\n" }) },
      },
      {
        name: "malformed explicit input",
        expected: { code: "guard-provenance-invalid", reachedClause: "event-payload" },
        options: {
          env: { GITHUB_EVENT_NAME: "pull_request" },
          responses: provenanceFixtures["pull-request-merge-ref"].gitResponses,
          readEventPayload: () => "{ not json",
        },
      },
      {
        name: "non-Git execution",
        expected: { code: "guard-provenance-unavailable", reachedClause: "git-worktree" },
        options: { responses: replaceResponse(plain, ["rev-parse", "--is-inside-work-tree"], { stdout: "false\n" }) },
      },
      {
        name: "unrecognized checkout shape",
        expected: { code: "guard-provenance-environment-ambiguous", reachedClause: "environment-classification" },
        options: { env: { GITHUB_EVENT_NAME: "push" } },
      },
    ];

    const observed = controls.map((control) => {
      const outcome = deriveConsentAuthorizationProvenanceOutcome(() => driveProvenanceFixture(plain, control.options));
      let guardError = null;
      try {
        requireResolvedProvenance(outcome);
      } catch (error) {
        guardError = error;
      }
      return {
        name: control.name,
        code: outcome.code,
        reachedClause: outcome.reachedClause,
        guardCode: guardError?.code ?? null,
        guardIsNamed: guardError instanceof ConsentAuthorizationGuardError,
      };
    });
    process.stdout.write(`provenance-failure-controls=${JSON.stringify(observed)}\n`);

    expect(observed.map(({ name, code, reachedClause }) => ({ name, code, reachedClause }))).toEqual(
      controls.map((control) => ({ name: control.name, ...control.expected })),
    );
    expect(observed.every(({ guardIsNamed }) => guardIsNamed)).toBe(true);
    expect(new Set(observed.map(({ guardCode }) => guardCode))).toEqual(
      new Set(["consent-authorization-provenance-unresolved"]),
    );
  });

  it("binds the corpus to the candidate-head object in every classified environment", () => {
    const { plain, pullRequest, mergeGroup, observations } = classifiedEnvironments;
    process.stdout.write(`candidate-head-binding=${JSON.stringify(observations)}\n`);

    expect(observations.map(({ environment }) => environment)).toEqual([
      "plain",
      "pull-request-merge-ref",
      "merge-group",
    ]);
    expect(observations.every(({ boundToHead }) => boundToHead)).toBe(true);
    expect(observations.map(({ violations }) => violations)).toEqual([0, 0, 0]);
    expect(observations.map(({ surface }) => surface)).toEqual([
      { scanned: 6, total: 6 },
      { scanned: 6, total: 6 },
      { scanned: 6, total: 6 },
    ]);
    expect(observations.map(({ unionsUntrackedNonignored }) => unionsUntrackedNonignored)).toEqual([
      true,
      false,
      false,
    ]);

    expect(plain.result.candidateHead).toBe(plain.head);
    expect(plain.result.candidateHeadRole).toBe(candidateHeadProvenanceRole);
    expect(plain.result.partitionDigest).toBe(registry.partitionDigest);

    // The pull-request checkout is the one that discriminates: the analyzed
    // synthetic merge commit is a different object from the reviewed head, and
    // the guard asserts about the reviewed head.
    expect(pullRequest.result.candidateHead).toBe(pullRequest.environment.head);
    expect(pullRequest.result.provenance.roles.analyzedTree.sha).toBe(pullRequest.environment.analyzedTree);
    expect(pullRequest.result.candidateHead).not.toBe(pullRequest.environment.analyzedTree);
    expect(pullRequest.result.partitionDigest).toBe(registry.partitionDigest);

    expect(mergeGroup.result.candidateHead).toBe(mergeGroup.head);
    expect(mergeGroup.result.partitionDigest).toBe(registry.partitionDigest);
  });

  it("fails closed under a named error when the candidate-head object cannot be resolved", () => {
    const { calls, thrown } = unresolvedCandidateHead;
    process.stdout.write(`candidate-head-unresolved-calls=${JSON.stringify(calls)}\n`);
    expect(thrown).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(thrown.code).toBe("consent-authorization-candidate-head-unresolved");
    expect(thrown.reachedClause).toBe("candidate-head-object");
    // No enumeration was attempted and nothing fell back to HEAD.
    expect(calls.some((call) => call.startsWith("ls-tree"))).toBe(false);
    expect(calls.some((call) => call.includes("HEAD"))).toBe(false);
  });

  it("produces an identical partition from a built worktree and a clean worktree", () => {
    const { clean, built } = builtVersusClean;
    process.stdout.write(
      `built-vs-clean=${JSON.stringify({
        cleanSurface: clean.surface,
        builtSurface: built.surface,
        cleanDigest: clean.partitionDigest,
        builtDigest: built.partitionDigest,
        cleanFiles: clean.corpus.files.length,
        builtFiles: built.corpus.files.length,
      })}\n`,
    );
    // Both runs are compared against the committed expectation rather than
    // against each other, so neither side of any equality is a live run.
    const expectedCorpusFiles = [...productFixtureFiles.keys()].toSorted();
    expect(clean.partitionDigest).toBe(registry.partitionDigest);
    expect(built.partitionDigest).toBe(registry.partitionDigest);
    expect(clean.surface).toEqual({ scanned: 6, total: 6 });
    expect(built.surface).toEqual({ scanned: 6, total: 6 });
    expect(clean.violations).toEqual([]);
    expect(built.violations).toEqual([]);
    expect(clean.corpus.files).toEqual(expectedCorpusFiles);
    expect(built.corpus.files).toEqual(expectedCorpusFiles);
  });

  it("stays green and republishes provenance when main advances without changing the partition", () => {
    const { before, after, head, advanced } = mainAdvance;
    process.stdout.write(
      `class-a-main-advance=${JSON.stringify({
        beforeHead: before.candidateHead,
        afterHead: after.candidateHead,
        beforeDigest: before.partitionDigest,
        afterDigest: after.partitionDigest,
      })}\n`,
    );
    expect(before.candidateHead).toBe(head);
    expect(after.candidateHead).toBe(advanced);
    expect(before.partitionDigest).toBe(registry.partitionDigest);
    expect(after.partitionDigest).toBe(registry.partitionDigest);
    expect(before.surface).toEqual({ scanned: 6, total: 6 });
    expect(after.surface).toEqual({ scanned: 6, total: 6 });
    expect(before.violations).toEqual([]);
    expect(after.violations).toEqual([]);
    expect(after.drift).toBe(null);
  });

  it("keeps line-only movement in one owner green with an identical digest", () => {
    const moved = structuredClone(realTreeResult.partition);
    for (const site of moved.consumptions) site.line += 100;
    expect(digestConsentAuthorizationPartition(moved)).toBe(registry.partitionDigest);
  });

  it("stays green across a lockfile-only change", () => {
    const pair = deriveLockfileOnlyArtifactPair();
    const differing = Object.keys(pair.a.resolution).filter(
      (key) => JSON.stringify(pair.a.resolution[key]) !== JSON.stringify(pair.b.resolution[key]),
    );
    process.stdout.write(`lockfile-only-delta=${JSON.stringify(differing)}\n`);
    expect(differing).toEqual(["lockfileSha256"]);
    const comparison = compareTypeScriptOwnerContexts(pair.a, pair.b, {
      partition: ownerContextPartition,
      schema: ownerContextSchema,
      comparedKeys: ownerContextPartition.semantic,
    });
    expect(comparison.violations).toEqual([]);
    expect(comparison.ok).toBe(true);
  });

  it("fails closed with an exact recount and delta when the observed partition changes", () => {
    process.stdout.write(`partition-drift=${JSON.stringify(driftResult.drift)}\n`);
    expect(driftResult.violations.some(({ code }) => code === "consent-authorization-partition-drift")).toBe(true);
    expect(driftResult.drift.added).toEqual([
      {
        file: "arbitrary/authorization.ts",
        owner: "seventhProbe",
        constructor: "authorizeConsentForActor",
        ordinal: 1,
      },
    ]);
    expect(driftResult.drift.removed).toEqual([]);
    expect(driftResult.drift.previousTotal).toBe(6);
    expect(driftResult.drift.currentTotal).toBe(7);
    expect(driftResult.drift.previousCounts).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });
    expect(driftResult.drift.currentCounts).toEqual({ actor: 3, "self-registration": 1, provisioning: 3 });
    expect(driftResult.drift.previousDigest).toBe(registry.partitionDigest);
    expect(driftResult.drift.currentDigest).not.toBe(registry.partitionDigest);
  });

  it("fails deletion of a registered site", () => {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    const observed = new Set(realTreeResult.partition.consumptions.slice(1).map(key));
    expect(observed).not.toEqual(new Set(registry.sites.map(key)));
  });

  it("fails moving a site across its semantic owner", () => {
    const changed = structuredClone(realTreeResult.partition);
    changed.consumptions[0].owner += "Moved";
    expect(digestConsentAuthorizationPartition(changed)).not.toBe(registry.partitionDigest);
  });

  it("fails reclassifying a provisioning site as actor", () => {
    const changed = structuredClone(registry);
    changed.sites.find(({ classification }) => classification === "provisioning").classification = "actor";
    expect(collectConsentAuthorizationRegistryViolations(changed, registrySchema).length).toBeGreaterThan(0);
  });

  it("reconciles the live tree one-for-one against the committed registry", () => {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    process.stdout.write(
      `observed-partition=${JSON.stringify({
        digest: realTreeResult.partitionDigest,
        counts: realTreeResult.partition.counts,
        identities: realTreeResult.partition.consumptions.map(
          ({ file, owner, constructor, ordinal, classification }) => ({
            file,
            owner,
            constructor,
            ordinal,
            classification,
          }),
        ),
        declarations: realTreeResult.partition.declarations.map(({ file, constructor }) => ({ file, constructor })),
        imports: realTreeResult.partition.imports.map(({ file, constructor }) => ({ file, constructor })),
      })}\n`,
    );
    expect(realTreeResult.violations).toEqual([]);
    expect(realTreeResult.partition.declarations).toHaveLength(3);
    expect(new Set(realTreeResult.partition.imports.map(({ file }) => file)).size).toBe(5);
    expect(realTreeResult.partition.consumptions).toHaveLength(6);
    expect(realTreeResult.partition.counts).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });
    expect(realTreeResult.partitionDigest).toBe(registry.partitionDigest);
    expect(new Set(realTreeResult.partition.consumptions.map(key))).toEqual(new Set(registry.sites.map(key)));
    expect(realTreeResult.partition.consumptions.every(({ line }) => typeof line === "number")).toBe(true);
    expect(
      registry.sites
        .filter(({ classification }) => classification === "provisioning")
        .every(({ reason }) => reason.includes("#6120") && /permanent/i.test(reason)),
    ).toBe(true);
  });

  it("preserves the anonymous send callback owner in the real tree", () => {
    expect(
      realTreeResult.partition.consumptions.some(
        ({ owner }) => owner === "buildScenarioIdentityReconcilers > consentReconciler",
      ),
    ).toBe(true);
  });

  it("enters ordinary source under a test-named directory into the corpus", () => {
    expect(isConsentAuthorizationTestSource("arbitrary/ordinary.test.data/authorization.ts")).toBe(false);
    expect(isConsentAuthorizationTestSource("arbitrary/ordinary.test.ts")).toBe(true);
    expect(testNamedDirectoryResult.corpus.files).toContain("ordinary.test.data/authorization.ts");
    expect(
      testNamedDirectoryResult.violations.some(
        ({ code, site }) =>
          code === "consent-authorization-site-unregistered" && site?.owner === "ordinaryDirectoryProbe",
      ),
    ).toBe(true);
  });

  it("finds an unregistered site at an arbitrary path through real discovery", () => {
    process.stdout.write(
      `arbitrary-path-discovery=${JSON.stringify({
        surface: arbitraryPathResult.surface,
        files: arbitraryPathResult.corpus.files,
      })}\n`,
    );
    expect(arbitraryPathResult.surface).toEqual({ scanned: 7, total: 7 });
    expect(arbitraryPathResult.corpus.files).toContain("zz-unrelated/plain-directory/module.ts");
    expect(
      arbitraryPathResult.violations.some(
        ({ code, site }) => code === "consent-authorization-site-unregistered" && site?.owner === "seventhProbe",
      ),
    ).toBe(true);
  });

  it("reads every expectation from committed data and never from a live analysis run", () => {
    const origins = collectAnalyzerExpectationOrigins(suitePath, repoFile(suitePath));
    process.stdout.write(`analyzer-derived-expectations=${JSON.stringify(origins)}\n`);
    expect(origins.filter(({ identicalInputs }) => identicalInputs)).toEqual([]);

    // The collector is non-vacuous: an analyzer compared against itself over the
    // same inputs is reported.
    const planted = collectAnalyzerExpectationOrigins(
      "planted.mjs",
      "it('x', () => { expect(analyzeConsentAuthorizationSites(options)).toEqual(analyzeConsentAuthorizationSites(options)); });\n",
    );
    expect(planted.map(({ identicalInputs }) => identicalInputs)).toEqual([true]);
  });

  it("is recursively closed and freezes the exact 2/1/3 semantic partition", () => {
    expect(collectOpenSchemaObjectPaths(registrySchema)).toEqual([]);
    expect(collectOpenSchemaObjectPaths(receiptSchema)).toEqual([]);
    expect(collectOpenSchemaObjectPaths(aggregateSchema)).toEqual([]);
    expect(collectOpenSchemaObjectPaths(enumerationSchema)).toEqual([]);
    expect(collectConsentAuthorizationRegistryViolations(registry, registrySchema)).toEqual([]);
    expect(validateAgainstSchema(enumeration, enumerationSchema)).toEqual([]);
    expect(registry.sites.map(({ classification }) => classification).toSorted()).toEqual([
      "actor",
      "actor",
      "provisioning",
      "provisioning",
      "provisioning",
      "self-registration",
    ]);
  });

  it("rejects nested unknown, out-of-range, and date-only registry and receipt data", () => {
    const nested = readJsonFixture(`${fixtureRoot}/registry/nested-unknown.json`);
    expect(validateAgainstSchema(nested, registrySchema).some((entry) => entry.includes("unknown member"))).toBe(true);

    const mismatched = structuredClone(registry);
    mismatched.sites[0].classification = "provisioning";
    expect(
      collectConsentAuthorizationRegistryViolations(mismatched, registrySchema).some((entry) =>
        entry.includes("constructor and classification disagree"),
      ),
    ).toBe(true);

    const invalidBounds = structuredClone(registry);
    invalidBounds.sites[0].file = "../escape.ts";
    invalidBounds.sites[0].ordinal = 0;
    invalidBounds.sites[0].reason = " ";
    const violations = collectConsentAuthorizationRegistryViolations(invalidBounds, registrySchema);
    expect(violations.some((entry) => entry.includes("repository-relative"))).toBe(true);
    expect(violations.some((entry) => entry.includes("at least 1"))).toBe(true);
    expect(violations.some((entry) => entry.includes("non-empty"))).toBe(true);

    const dateOnly = {
      startedAt: "2026-08-02",
      finishedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(
      validateAgainstSchema(dateOnly, receiptSchema.properties.timestamps).some((entry) =>
        entry.includes("does not match"),
      ),
    ).toBe(true);

    const outOfRange = { caseId: "MUT-PROBE", sha256: "0".repeat(64) };
    expect(
      validateAgainstSchema({ ...outOfRange, caseId: "probe" }, aggregateSchema.properties.receipts.items).some(
        (entry) => entry.includes("does not match"),
      ),
    ).toBe(true);
  });

  it("formats every stable runtime owner and rejects an IIFE", () => {
    expect(scanFixture(`${fixtureRoot}/owners/runtime-matrix.ts`).map(({ owner }) => owner)).toEqual([
      "namedDeclaration",
      "explicitExpression",
      "directArrow",
      "NeutralClass.constructor",
      "NeutralClass.method()",
      "NeutralClass.get value",
      "NeutralClass.set value",
      "NeutralClass.static.staticMethod()",
      "wrapper.inner.authorization",
      "wrapper.inner.method()",
      "wrapper.inner.get value",
      "wrapper.inner.set value",
    ]);
    expect(scanFixture(`${fixtureRoot}/owners/ambiguous-iife.ts`)[0].owner).toBeNull();
  });

  it("stops at a nearer named helper while co-present safe hits keep their owners", () => {
    const references = scanConsentAuthorizationSource(
      "arbitrary/location/authorization.ts",
      `function registeredOuter() {
        authorizeConsentForActor(context);
        function hiddenHelper() {
          authorizeConsentForActor(context);
        }
      }`,
      ownerContexts,
    ).filter(({ referenceClass }) => referenceClass === "consumption");
    expect(references.map(({ owner }) => owner)).toEqual(["registeredOuter", "hiddenHelper"]);
  });

  it("fails a genuine seventh namespace call through computed string-literal and template properties", () => {
    expect(
      scanFixture(`${fixtureRoot}/references/computed-elements.ts`).filter(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toHaveLength(2);
    expect(
      scanFixture(`${fixtureRoot}/references/computed-binding-element.ts`).some(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toBe(true);
    expect(
      scanConsentAuthorizationSource(
        "neutral.ts",
        "const { [`authorizeConsentForActor`]: alias } = source; alias(context);",
        ownerContexts,
      ).some(({ referenceClass }) => referenceClass === "unexpected"),
    ).toBe(true);
  });

  it("ignores constructor spellings in comments and unrelated string or template values", () => {
    expect(
      scanConsentAuthorizationSource(
        "neutral.ts",
        '// authorizeConsentForActor\nconst value = "authorizeConsentForActor"; const template = `authorizeConsentForProvisioning`;',
        ownerContexts,
      ),
    ).toEqual([]);
    expect(scanFixture(`${fixtureRoot}/escapes/unrelated.ts`)).toEqual([]);
  });

  it("fails escape-only identifier, string, and template references without an escape vocabulary prefilter", () => {
    expect(
      scanFixture(`${fixtureRoot}/escapes/x-string-template-only.ts`).filter(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toHaveLength(2);
    expect(
      scanFixture(`${fixtureRoot}/escapes/u-identifier-only.ts`).some(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toBe(true);
  });

  for (const context of adjacentContexts) {
    for (const role of ["route", "variable"]) {
      it(`CTX-${context.toUpperCase()}-${role.toUpperCase()}`, () => {
        const references = scanFixture(`${fixtureRoot}/owner-contexts/${context}-${role}.ts`).filter(
          ({ referenceClass }) => referenceClass === "consumption",
        );
        expect(references.length).toBeGreaterThan(0);
        if (context === "property-assignment") expect(references.at(-1).owner).toBe("neutralBox.member");
        else if (context === "variable-declaration")
          expect(references.at(-1).owner).toBe(
            role === "route" ? "neutralLocal" : "neutralHarness > neutralWorker > neutralLocal",
          );
        else expect(references.at(-1).owner).toBeNull();
      });
    }
  }

  for (const [name, source] of [
    ["fails changing an exported constructor declaration", "export function authorizeConsentForActor() {}"],
    [
      "fails a renamed import alias",
      'import { authorizeConsentForActor as alias } from "./consent-recording-authorization";',
    ],
    [
      "fails an owning import redirected to a same-named non-canonical module",
      'import { authorizeConsentForActor } from "./alternate";',
    ],
    [
      "fails a non-owning import binding",
      'import { authorizeConsentForActor } from "./consent-recording-authorization";',
    ],
    [
      "fails an alias assignment while preserving the registered call",
      "const alias = authorizeConsentForActor; authorizeConsentForActor(context);",
    ],
    [
      "fails a local wrapper while preserving the registered call",
      "const wrapper = (...args) => authorizeConsentForActor(...args); authorizeConsentForActor(context);",
    ],
    ["fails a re-export", 'export { authorizeConsentForActor } from "./consent-recording-authorization";'],
  ]) {
    it(name, () => {
      expect(scanConsentAuthorizationSource("alternate.ts", source, ownerContexts).length).toBeGreaterThan(0);
    });
  }
});

for (const descriptor of mutationCases) {
  it(descriptor.caseId, async () => {
    const receipt = await generateReceipt(descriptor);
    expect(receipt.status).toBe("valid");
    expect(receipt.rewriteCount).toBe(1);
    expect(receipt.mutationActive).toBe(true);
    expect(receipt.candidateSubrun.exitCode).toBe(0);
    expect(receipt.mutantSubrun.exitCode).toBeGreaterThan(0);
    expect(receipt.firstFailingClauseId).toBe(descriptor.clauseId);
    expect(receipt.mutantSubrun.clauseTrace.at(-1)).toBe(descriptor.clauseId);
    expect(receipt.preservedVariableHashes.candidate).toEqual(receipt.preservedVariableHashes.mutant);
    expect(receipt.noEarlierClause.differingPaths.length).toBeGreaterThan(0);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  });
}

it("matches executed receipts against the committed case enumeration", async () => {
  const receipts = await Promise.all(mutationCases.map(generateReceipt));
  const aggregate = {
    contractVersion: "consent-authorization-mutation-aggregate/v1",
    provenance: realTreeProvenance,
    ownerContexts: {
      artifactSha256: repoFileSha256(typeScriptOwnerContextArtifactPath),
      partitionSha256: repoFileSha256(typeScriptOwnerContextPartitionPath),
      sourceSha256: ownerContexts.resolution.implementationSourceSha256,
      runtimeSetHash: ownerContexts.runtimeSetHash,
      namedEvaluationSetHash: ownerContexts.namedEvaluationSetHash,
      dispositionSetHash: ownerContexts.dispositionSetHash,
    },
    enumeration: {
      path: consentAuthorizationCaseEnumerationPath,
      sha256: repoFileSha256(consentAuthorizationCaseEnumerationPath),
    },
    receipts: receipts.map((receipt) => ({ caseId: receipt.caseId, sha256: sha256(JSON.stringify(receipt)) })),
    counts: {
      total: receipts.length,
      candidateGreen: receipts.filter(({ candidateSubrun }) => candidateSubrun.exitCode === 0).length,
      mutantRed: receipts.filter(({ mutantSubrun }) => mutantSubrun.exitCode > 0).length,
      active: receipts.filter(({ mutationActive }) => mutationActive).length,
      preserved: receipts.filter(
        ({ preservedVariableHashes }) =>
          JSON.stringify(preservedVariableHashes.candidate) === JSON.stringify(preservedVariableHashes.mutant),
      ).length,
    },
    reconciliation: {
      salvageHeadTotal: enumeration.reconciliation.salvageHeadTotal,
      retiredTotal: enumeration.reconciliation.retiredTotal,
      carriedTotal: enumeration.reconciliation.carriedTotal,
      addedTotal: enumeration.reconciliation.addedTotal,
      total: enumeration.reconciliation.total,
    },
    valid: true,
  };
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);

  expect(validateAgainstSchema(aggregate, aggregateSchema)).toEqual([]);
  expect(collectMutationAggregateViolations(aggregate, enumeration)).toEqual([]);
  expect(aggregate.receipts.map(({ caseId }) => caseId).toSorted()).toEqual([...enumeration.cases].toSorted());
  expect(new Set(aggregate.receipts.map(({ caseId }) => caseId)).size).toBe(enumeration.reconciliation.total);
  expect(aggregate.counts).toEqual({
    total: enumeration.reconciliation.total,
    candidateGreen: enumeration.reconciliation.total,
    mutantRed: enumeration.reconciliation.total,
    active: enumeration.reconciliation.total,
    preserved: enumeration.reconciliation.total,
  });

  // The committed reconciliation, not the generator that produced the cases.
  expect([...enumeration.carried, ...enumeration.added].toSorted()).toEqual([...enumeration.cases].toSorted());
  expect(enumeration.carried).toHaveLength(enumeration.reconciliation.carriedTotal);
  expect(enumeration.added).toHaveLength(enumeration.reconciliation.addedTotal);
  expect(enumeration.retired).toHaveLength(enumeration.reconciliation.retiredTotal);
  expect(enumeration.cases).toHaveLength(enumeration.reconciliation.total);
  expect(
    enumeration.reconciliation.salvageHeadTotal -
      enumeration.reconciliation.retiredTotal +
      enumeration.reconciliation.addedTotal,
  ).toBe(enumeration.reconciliation.total);
  expect(enumeration.carried.filter((caseId) => enumeration.retired.includes(caseId))).toEqual([]);
  expect(enumeration.added.filter((caseId) => enumeration.retired.includes(caseId))).toEqual([]);
});
