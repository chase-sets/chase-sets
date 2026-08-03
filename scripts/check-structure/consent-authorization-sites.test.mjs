import { execFileSync, spawnSync } from "node:child_process";
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
  assertConsentAuthorizationCensusArmPartition,
  assertConsentAuthorizationCoveragePartition,
  assertConsentAuthorizationExtensionDisposition,
  assertConsentAuthorizationKeyCoverageIdentities,
  assertConsentAuthorizationSpecifierShapeDispositions,
  candidateHeadProvenanceRole,
  collectConsentAuthorizationCoverageViolations,
  collectConsentAuthorizationRegistryViolations,
  collectFrozenProvenanceViolations,
  collectMutationAggregateViolations,
  collectMutationProvenanceViolations,
  consentAuthorizationAcquisitionArms,
  consentAuthorizationCaseEnumerationPath,
  consentAuthorizationCensusCoveragePath,
  consentAuthorizationCensusCoverageSchemaPath,
  consentAuthorizationCensusFixtureRoot,
  consentAuthorizationClauseByCode,
  consentAuthorizationCommittedCensusArms,
  consentAuthorizationConstantKeyOutcome,
  consentAuthorizationConstantKeyOutcomes,
  consentAuthorizationCoverageAxisAuthorities,
  consentAuthorizationCoverageAxisKinds,
  consentAuthorizationCoverageCounts,
  consentAuthorizationDeclaredOpenOwner,
  consentAuthorizationExtensionDispositions,
  consentAuthorizationKeyCoverageIdentities,
  consentAuthorizationKeyRuntimeUnknownArm,
  consentAuthorizationKeySyntaxRoles,
  consentAuthorizationReceiptProvenanceFields,
  consentAuthorizationRegistryPath,
  consentAuthorizationRegistrySchemaPath,
  consentAuthorizationSpecifierShapeDispositions,
  deriveConsentAuthorizationCensusArms,
  deriveConsentAuthorizationCoverageAxes,
  deriveConsentAuthorizationKeyCoverageIdentity,
  deriveConsentAuthorizationProvenanceOutcome,
  deriveConsentAuthorizationReceiptProvenance,
  digestConsentAuthorizationPartition,
  enumerateConsentAuthorizationCorpus,
  expectedConsentAuthorizationImportIdentity,
  frozenProvenanceExpectations,
  isConsentAuthorizationTestSource,
  listConsentAuthorizationCensusFixtures,
  loadConsentAuthorizationCaseEnumeration,
  loadConsentAuthorizationCensusCoverage,
  loadConsentAuthorizationCensusCoverageSchema,
  loadConsentAuthorizationRegistry,
  loadConsentAuthorizationRegistrySchema,
  observeConsentAuthorizationCoverageRow,
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
const censusCoverage = loadConsentAuthorizationCensusCoverage();
const censusCoverageSchema = loadConsentAuthorizationCensusCoverageSchema();
const censusFixtureFiles = listConsentAuthorizationCensusFixtures();
const derivedCoverageAxes = deriveConsentAuthorizationCoverageAxes();
const derivedCensusArms = deriveConsentAuthorizationCensusArms();
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
// Well-formed, forty lowercase hexadecimal characters, and not any value the
// live analysis produced: exactly the shape a stale receipt carries.
const staleProvenanceSha = createHash("sha1").update("consent-authorization-stale-receipt-provenance").digest("hex");

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

/**
 * One owning import redirected onto a same-named module the declaration does
 * not live in, with all six registered calls preserved. The consumption
 * partition is byte-for-byte what the registry carries; only the owning-import
 * edge moved.
 */
const redirectedImportSpecifier = "../domain/consent-recording-authorization-alternate";

function buildRedirectedImportEvidence() {
  const { scratch } = buildProductScratchRepo(
    "consent-import-redirect-",
    new Map([
      [
        "bounded-contexts/identity/features/consents/api/terms-route.ts",
        repoFile(`${fixtureRoot}/terms-route.ts`).replace(
          '"../domain/consent-recording-authorization"',
          `"${redirectedImportSpecifier}"`,
        ),
      ],
    ]),
  );
  const result = analyzeScratch(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return result;
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

/**
 * The arbitrary paths the repaired surface is decided at. None of them carries
 * fixture vocabulary: each is an ordinary directory two levels below the root,
 * so the guard reaches them by code shape rather than by recognising a friendly
 * name, and the namespace-binding module's relative specifier resolves onto the
 * real declaration module only because the path is exactly this deep.
 */
const arbitraryControlPlantings = new Map([
  [
    "zz-unrelated/plain-directory/module.mts",
    `${fixtureRoot}/reconciliation/unregistered-seventh-module-typescript.mts`,
  ],
  ["zz-unrelated/plain-directory/constant-key.ts", `${fixtureRoot}/references/constant-key.ts`],
  ["zz-unrelated/plain-directory/template-key.ts", `${fixtureRoot}/references/template-key.ts`],
  ["zz-unrelated/plain-directory/namespace-binding.ts", `${fixtureRoot}/references/namespace-binding-dynamic-key.ts`],
]);

function buildRetainedArbitraryControlRepo() {
  const { scratch } = buildProductScratchRepo(
    "consent-arbitrary-controls-",
    new Map([...arbitraryControlPlantings].map(([relative, fixture]) => [relative, repoFile(fixture)])),
  );
  retainedScratchRepos.push(scratch);
  return scratch;
}

/**
 * A clean registered product surface with nothing planted in it, retained so
 * the two coverage-clause guard controls below observe the coverage authority
 * alone: under the legacy identity mutant the whole guard must come back green,
 * which it cannot do in a repository that already carries an unregistered site.
 */
function buildRetainedCleanProductRepo() {
  const { scratch } = buildProductScratchRepo("consent-clean-product-");
  retainedScratchRepos.push(scratch);
  return scratch;
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
const retainedCleanProductScratch = buildRetainedCleanProductRepo();
const retainedArbitraryControlScratch = buildRetainedArbitraryControlRepo();
const arbitraryControlResult = analyzeScratch(retainedArbitraryControlScratch);
const unresolvedCandidateHead = buildUnresolvedCandidateHeadEvidence();
const builtVersusClean = buildBuiltVersusCleanEvidence();
const mainAdvance = buildMainAdvanceEvidence();
const redirectedImportResult = buildRedirectedImportEvidence();

/**
 * The coordinated row-plus-fixture omission the census arm authority exists to
 * catch, run through the whole guard once here so no individual test pays for a
 * repository analysis.
 */
const omittedCoverageRowId = "specifier-no-substitution-template-dynamic-import";
const coverageWithoutOmittedRow = {
  ...censusCoverage,
  rows: censusCoverage.rows.filter(({ rowId }) => rowId !== omittedCoverageRowId),
};
const censusFixturesWithoutOmittedRow = censusFixtureFiles.filter(
  (file) => !file.endsWith(`/${omittedCoverageRowId}.ts`),
);
const coordinatedOmissionGuardFailure = (() => {
  try {
    analyzeScratch(retainedPartitionNarrowScratch, {
      censusCoverage: coverageWithoutOmittedRow,
      censusFixtureFiles: censusFixturesWithoutOmittedRow,
    });
  } catch (error) {
    return error;
  }
  return null;
})();
/* -------------------------------------------------------------------------- */
/* Exhaustive coordinated row-plus-fixture deletion sweep                     */
/* -------------------------------------------------------------------------- */

/**
 * The immutable pre-mutation inventory every trial below is enumerated from.
 * Frozen and hashed before the first trial runs, so a sweep whose inventory
 * shrinks with the matrix it is mutating cannot report a complete pass: no
 * trial can add, drop, or rename an entry, and the published digest binds the
 * enumeration the receipts were produced from.
 */
const censusDeletionInventory = Object.freeze(
  censusCoverage.rows.map((row) => Object.freeze({ rowId: row.rowId, fixture: row.fixture })),
);
const censusDeletionInventoryDigest = sha256(JSON.stringify(censusDeletionInventory));

/**
 * The candidate-local legacy identity mutant. It maps the five source-derived
 * coverage identities back to the exact three arm names the parked head
 * published, and changes nothing else. It is test-only and has no production
 * entrypoint, performs no Git, GitHub, or network access, copies no parked
 * source, and is outside the thirty-case mutation ledger: its only job is to
 * reproduce the parked arm sharing so the repair can be shown to be what
 * removes the survivors.
 */
const legacyF5CoverageIdentityMutant = Object.freeze({
  "key:element-access:written-string-literal": "computed-property:element-access",
  "key:element-access:shadowed-lexical-constant:identifier": "element-access-key",
  "key:element-access:shadowed-lexical-constant:template-expression": "element-access-key",
  "key:binding-element:lexical-constant:identifier": "binding-element-key",
  "key:binding-element:lexical-constant:template-expression": "binding-element-key",
});

const analyzerSourceText = repoFile(analyzerPath);

/**
 * The mutant is applied to the analyzer's own text and to the committed rows
 * through the same map, because one coverage identity is written in both
 * places. Rewriting only the source would leave every row underived, and
 * rewriting only the rows would leave every row unwitnessed; either would fail
 * the whole matrix and prove nothing about the survivors.
 */
function applyLegacyF5CoverageIdentityMutant(source) {
  let mutated = source;
  let rewrites = 0;
  for (const [identity, legacyArm] of Object.entries(legacyF5CoverageIdentityMutant)) {
    const written = JSON.stringify(identity);
    rewrites += mutated.split(written).length - 1;
    mutated = mutated.split(written).join(JSON.stringify(legacyArm));
  }
  return { source: mutated, rewrites };
}

const legacyMutantSource = applyLegacyF5CoverageIdentityMutant(analyzerSourceText);
const legacyMutantCensusArms = deriveConsentAuthorizationCensusArms({ analyzerSource: legacyMutantSource.source });
const legacyMutantCoverage = {
  ...censusCoverage,
  rows: censusCoverage.rows.map((row) =>
    typeof row.arm === "string" && legacyF5CoverageIdentityMutant[row.arm] !== undefined
      ? { ...row, arm: legacyF5CoverageIdentityMutant[row.arm] }
      : row,
  ),
};

/**
 * One coordinated row-plus-fixture deletion trial, executed through the real
 * exported coverage authorities in the exact order the guard entrypoint
 * consults them: the row-granular arm authority, then the coarser
 * expression-kind authority, then the row/fixture bijection. The observed code
 * and first clause are read off the executed failure rather than asserted
 * about it, and a trial that reaches the end of all three is a survivor.
 */
function runCoverageDeletionTrial({ rowId, fixture }, coverage, arms) {
  const withoutRow = { ...coverage, rows: coverage.rows.filter((row) => row.rowId !== rowId) };
  const withoutFixture = censusFixtureFiles.filter((file) => file !== fixture);
  const reach = (run) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return null;
  };
  const armFailure = reach(() => assertConsentAuthorizationCensusArmPartition(withoutRow, arms));
  const kindFailure = armFailure
    ? null
    : reach(() => assertConsentAuthorizationCoveragePartition(withoutRow, derivedCoverageAxes));
  const rowViolations =
    armFailure || kindFailure
      ? []
      : collectConsentAuthorizationCoverageViolations(withoutRow, censusCoverageSchema, {
          censusFixtureFiles: withoutFixture,
        });
  const failure = armFailure ?? kindFailure;
  return {
    rowId,
    fixture,
    remainingRows: withoutRow.rows.length,
    remainingFixtures: withoutFixture.length,
    code: failure?.code ?? (rowViolations.length > 0 ? "consent-authorization-coverage-invalid" : null),
    firstClause: failure?.reachedClause ?? (rowViolations.length > 0 ? "coverage.committed-rows" : null),
    survived: failure === null && rowViolations.length === 0,
  };
}

function sweepCoverageDeletions(coverage, arms) {
  const trials = censusDeletionInventory.map((entry) => runCoverageDeletionTrial(entry, coverage, arms));
  const survivors = trials.filter(({ survived }) => survived).map(({ rowId }) => rowId);
  return {
    inventoryDigest: censusDeletionInventoryDigest,
    trialCount: trials.length,
    rowIds: trials.map(({ rowId }) => rowId),
    trials,
    survivors,
    survivorCount: survivors.length,
  };
}

const candidateDeletionReceipt = sweepCoverageDeletions(censusCoverage, derivedCensusArms);
const legacyDeletionReceipt = sweepCoverageDeletions(legacyMutantCoverage, legacyMutantCensusArms);

/**
 * The two executed guard-entrypoint controls that bind the sweep to the real
 * entrypoint. One repaired coordinated omission is run through the whole guard
 * under the candidate identities and again under the legacy identity mutant:
 * red at the named clause under the candidate, green under the mutant. Freezing
 * every other input and varying only the coverage identities is what makes the
 * repair, rather than any co-present clause, the discriminator.
 */
const repairedOmissionRowId = "key-string-literal-element-access";
const repairedOmissionGuardOutcomes = (() => {
  const row = censusCoverage.rows.find(({ rowId }) => rowId === repairedOmissionRowId);
  const censusFixturesWithoutRepairedRow = censusFixtureFiles.filter((file) => file !== row.fixture);
  const run = (coverage, arms) => {
    try {
      return {
        failure: null,
        result: analyzeScratch(retainedCleanProductScratch, {
          censusCoverage: {
            ...coverage,
            rows: coverage.rows.filter(({ rowId }) => rowId !== repairedOmissionRowId),
          },
          censusFixtureFiles: censusFixturesWithoutRepairedRow,
          coverageArms: arms,
        }),
      };
    } catch (error) {
      return { failure: error, result: null };
    }
  };
  return {
    candidate: run(censusCoverage, derivedCensusArms),
    legacy: run(legacyMutantCoverage, legacyMutantCensusArms),
  };
})();

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
  "deriveConsentAuthorizationCoverageAxes",
  "observeConsentAuthorizationCoverageRow",
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
    "MUT-AC10-CORPUS-EXTENSION-OMIT-MTS",
    "AC11",
    `${fixtureRoot}/reconciliation/unregistered-seventh-module-typescript.mts`,
    "consentAuthorizationExtensionDispositions / module TypeScript arm",
    "corpus.extension-disposition.mts",
    "consent-authorization-site-unregistered",
    "seventhModuleProbe",
    "module TypeScript candidate source",
  ),
  mutationCase(
    "MUT-AC10-EXTENSION-DISPOSITION-OPEN",
    "AC11",
    `${fixtureRoot}/reconciliation/unregistered-seventh-module-typescript.mts`,
    "assertConsentAuthorizationExtensionDisposition / fail-closed arm",
    "corpus.extension-disposition.totality",
    "consent-authorization-extension-disposition-partial",
    null,
    "compiler-enumerated extension set",
  ),
  mutationCase(
    "MUT-AC4-CONSTANT-KEY-UNRESOLVED",
    "AC6",
    `${fixtureRoot}/references/constant-key.ts`,
    "resolveConsentAuthorizationConstantKey / identifier arm",
    "reference.constant-key",
    "consent-authorization-reference-unclassified",
    null,
    "constant-bound element access key",
  ),
  mutationCase(
    "MUT-AC4-TEMPLATE-KEY-UNRESOLVED",
    "AC6",
    `${fixtureRoot}/references/template-key.ts`,
    "resolveConsentAuthorizationConstantKey / template arm",
    "reference.template-key",
    "consent-authorization-reference-unclassified",
    null,
    "template-derived element access key",
  ),
  mutationCase(
    "MUT-AC4-NAMESPACE-BINDING-UNTRACKED",
    "AC6",
    `${fixtureRoot}/references/namespace-binding-dynamic-key.ts`,
    "collectCanonicalModuleBinding / canonical binding collection",
    "reference.canonical-module-binding",
    "consent-authorization-noncanonical-module-access",
    "namespaceBindingProbe",
    "canonical namespace binding reached by a dynamic key",
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
    "MUT-AC12-COVERAGE-MATRIX-DROP-ROW",
    "AC12",
    consentAuthorizationCensusCoveragePath,
    "loadConsentAuthorizationCensusCoverage / one arbitrary committed row",
    "coverage.fixture-bijection",
    "consent-authorization-coverage-invalid",
    null,
    "committed census coverage row set",
  ),
  mutationCase(
    "MUT-AC12-COVERAGE-DISPOSITION-FLIP",
    "AC12",
    consentAuthorizationCensusCoveragePath,
    "loadConsentAuthorizationCensusCoverage / one arbitrary committed row disposition",
    "coverage.row-disposition",
    "consent-authorization-coverage-invalid",
    null,
    "committed census coverage disposition",
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
  // Both coverage cases govern an arbitrary committed row -- the first one --
  // and neither is worded against the declared-open disposition, so both stay
  // executable once the sibling slice flips every declared-open row.
  if (id === "MUT-AC12-COVERAGE-MATRIX-DROP-ROW") {
    return {
      kind: "data-substitution",
      source: `export default ${JSON.stringify(censusCoverage)};\n`,
      candidateFragment: `${JSON.stringify(censusCoverage.rows[0])},`,
      mutantFragment: "",
    };
  }
  if (id === "MUT-AC12-COVERAGE-DISPOSITION-FLIP") {
    return {
      kind: "data-substitution",
      source: `export default ${JSON.stringify(censusCoverage)};\n`,
      candidateFragment: JSON.stringify(censusCoverage.rows[0]),
      mutantFragment: JSON.stringify({ ...censusCoverage.rows[0], disposition: "silent-by-design" }),
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
    return { constructor: node.text, axis: "key", arm: "computed-property:binding-element-property-name" };
  }
  if (
    ts.isComputedPropertyName(node.parent) &&
    node.parent.expression === node &&
    ts.isBindingElement(node.parent.parent) &&
    node.parent.parent.propertyName === node.parent
  ) {
    return { constructor: node.text, axis: "key", arm: "computed-property:binding-element-computed-name" };
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
    // The governing variable is the observed partition itself, not one clause
    // that reads it. Narrowing the observed consumptions to the rows the
    // registry already carries is the historical defect in one rewrite, and it
    // bypasses every consumer at once -- the unregistered-site clause, the
    // added/removed delta, the counts and the digest -- so the mutant guard is
    // green rather than red at a later clause.
    "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS": [
      `  const consumptions = addOrdinals(references.filter((reference) => reference.referenceClass === "consumption")).map(
    (site) => ({ ...site, classification: constructorClassifications.get(site.constructor) }),
  );`,
      `  const consumptions = addOrdinals(references.filter((reference) => reference.referenceClass === "consumption"))
    .map((site) => ({ ...site, classification: constructorClassifications.get(site.constructor) }))
    .filter((site) => (Array.isArray(registry?.sites) ? registry.sites : []).some((row) => siteKey(row) === siteKey(site)));`,
    ],
    "MUT-AC10-CORPUS-EXTENSION-OMIT-MTS": [
      '    { extension: ts.Extension.Mts, scriptKind: "TS", reason: "TypeScript ECMAScript module" },',
      '    { extension: ts.Extension.Mts, scriptKind: null, reason: "TypeScript ECMAScript module" },',
    ],
    "MUT-AC10-EXTENSION-DISPOSITION-OPEN": [
      "  if (undispositioned.length > 0 || unenumerated.length > 0) {",
      "  if (false && (undispositioned.length > 0 || unenumerated.length > 0)) {",
    ],
    "MUT-AC4-CONSTANT-KEY-UNRESOLVED": [
      "  if (ts.isIdentifier(node)) {\n    const bound = bindings.get(node.text);",
      "  if (false && ts.isIdentifier(node)) {\n    const bound = bindings.get(node.text);",
    ],
    "MUT-AC4-TEMPLATE-KEY-UNRESOLVED": [
      "  if (ts.isTemplateExpression(node)) {\n    let text = node.head.text;",
      "  if (false && ts.isTemplateExpression(node)) {\n    let text = node.head.text;",
    ],
    "MUT-AC4-NAMESPACE-BINDING-UNTRACKED": [
      "    collectCanonicalModuleBinding(relativeFile, sourceFile, node, canonicalBindings, canonicalAccesses, unknowns);\n",
      "",
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

/* -------------------------------------------------------------------------- */
/* Executed guard -- real processes, read-back exit codes and clauses          */
/* -------------------------------------------------------------------------- */

const partitionNarrowCaseId = "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS";

/**
 * The rewrite this case carried before the observed-partition repair. It
 * disables one clause that reads the observed partition and leaves every other
 * consumer of it intact, so the guard it produces is still nonzero -- at the
 * later partition-drift clause, not at the clause the receipt claimed. It is
 * retained as the meta-test's negative control: the harness must reject it.
 */
const priorPartitionNarrowMutant = Object.freeze([
  "    } else if (!registryKeys.has(siteKey(site))) {",
  "    } else if (false && !registryKeys.has(siteKey(site))) {",
]);

/**
 * A standalone entrypoint that runs the analyzer over a checkout and applies
 * the shipped entrypoint's own exit rule, then applies the unchanged acceptance
 * assertion for the governing AC -- the unregistered seventh consumption at an
 * arbitrary path is reported -- and exits with its result. Everything the
 * receipt records about this case is read back off a finished process.
 */
function guardRunnerSource() {
  const provenanceModule = pathToFileURL(
    path.join(repoRoot, "scripts/check-structure/guard-candidate-provenance.mjs"),
  ).href;
  return `import { execFileSync } from "node:child_process";

const [moduleUrl, scratch, authorityRoot] = process.argv.slice(2);
const guard = await import(moduleUrl);
const { deriveGuardCandidateProvenance } = await import(${JSON.stringify(provenanceModule)});
const execGit = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: scratch,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });

const result = guard.analyzeConsentAuthorizationSites({
  repoRoot: scratch,
  authorityRoot,
  registry: guard.loadConsentAuthorizationRegistry({ repoRoot: authorityRoot }),
  schema: guard.loadConsentAuthorizationRegistrySchema({ repoRoot: authorityRoot }),
  execGit,
  deriveProvenance: () => deriveGuardCandidateProvenance({ env: {}, execGit: (args) => execGit(args) }),
});

const guardExitCode = result.violations.length > 0 ? 1 : 0;
const acceptanceClauseId = guard.consentAuthorizationClauseByCode["consent-authorization-site-unregistered"];
const reported = result.violations.filter(
  (violation) =>
    violation.code === "consent-authorization-site-unregistered" && violation.site?.owner === "seventhProbe",
);
const acceptancePassed = reported.length === 1;
process.stdout.write(
  JSON.stringify({
    guardExitCode,
    guardViolationCodes: result.violations.map((violation) => violation.code),
    guardFirstFailingClauseId: result.violations[0]?.clause ?? "",
    acceptanceClauseId,
    acceptancePassed,
  }) + "\\n",
);
process.stdout.write(guard.formatConsentAuthorizationCensus(result) + "\\n");
if (!acceptancePassed) {
  process.stderr.write("acceptance failed at " + acceptanceClauseId + "\\n");
}
process.exitCode = acceptancePassed ? 0 : 1;
`;
}

function runGuardProbe(runnerPath, modulePath, scratchRepo) {
  const outcome = spawnSync(process.execPath, [runnerPath, pathToFileURL(modulePath).href, scratchRepo, repoRoot], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64,
  });
  const stdout = outcome.stdout ?? "";
  const stderr = outcome.stderr ?? "";
  if (!stdout.startsWith("{")) {
    throw new Error(
      `${path.basename(modulePath)} produced no executed-guard report (status=${outcome.status}): ${stderr.slice(0, 800)}`,
    );
  }
  const report = JSON.parse(stdout.slice(0, stdout.indexOf("\n")));
  const acceptanceExitCode = outcome.status ?? 1;
  return {
    acceptanceClauseId: report.acceptanceClauseId,
    run: {
      guardExitCode: report.guardExitCode,
      guardViolationCodes: report.guardViolationCodes,
      guardFirstFailingClauseId: report.guardFirstFailingClauseId,
      acceptanceExitCode,
      acceptanceResult: acceptanceExitCode === 0 ? "pass" : "fail",
      acceptanceFirstFailingClauseId: acceptanceExitCode === 0 ? "" : report.acceptanceClauseId,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
    },
  };
}

/**
 * A mutant whose own guard is still nonzero has not bypassed the property the
 * case claims; whatever clause it fails at is not the clause the rewrite
 * targeted, so any first-failing clause written from it would be manufactured.
 */
function assertExecutedMutantBypasses(caseId, run) {
  if (run.guardExitCode !== 0) {
    throw new Error(
      `${caseId} mutant guard still exits ${run.guardExitCode} at ${run.guardFirstFailingClauseId}, so the rewrite does not bypass every consumer of the governing input`,
    );
  }
  return run;
}

function buildExecutedPartitionNarrowEvidence() {
  const descriptor = mutationCases.find(({ caseId }) => caseId === partitionNarrowCaseId);
  const mutation = sourceMutationFor(descriptor);
  const scratch = mkdtempSync(path.join(tmpdir(), "consent-executed-guard-"));
  retainedScratchRepos.push(scratch);
  const runnerPath = path.join(scratch, "guard-runner.mjs");
  writeFileSync(runnerPath, guardRunnerSource());
  const write = (name, source) => {
    const target = path.join(scratch, name);
    writeFileSync(target, source);
    return target;
  };
  const mutantSource = mutation.source.replace(mutation.candidateFragment, mutation.mutantFragment);
  const priorSource = mutation.source.replace(priorPartitionNarrowMutant[0], priorPartitionNarrowMutant[1]);
  const probe = (name, source) => runGuardProbe(runnerPath, write(name, source), retainedPartitionNarrowScratch);
  const candidate = probe("executed-candidate.mjs", mutation.source);
  const mutant = probe("executed-mutant.mjs", mutantSource);
  const prior = probe("executed-prior-mutant.mjs", priorSource);
  return {
    descriptor,
    command: "node <runner> <analyzer-module-url> <checkout> <authority-root>",
    runner: `${suitePath}#guardRunnerSource`,
    acceptanceClauseId: candidate.acceptanceClauseId,
    candidate: candidate.run,
    mutant: mutant.run,
    priorMutant: prior.run,
    priorRewrote: priorSource !== mutation.source,
    mutantRewrote: mutantSource !== mutation.source,
  };
}

const executedPartitionNarrow = buildExecutedPartitionNarrowEvidence();

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

  if (id.startsWith("MUT-AC12-COVERAGE-")) {
    const collect = (module) =>
      collectConsentAuthorizationCoverageViolations(module.default, censusCoverageSchema, { censusFixtureFiles });
    const marker =
      id === "MUT-AC12-COVERAGE-MATRIX-DROP-ROW"
        ? "census fixture has no committed coverage row"
        : "disposition and recorded census outcome disagree";
    return {
      candidateGreen: collect(candidateModule).length === 0,
      mutantRed: collect(mutantModule).some((entry) => entry.includes(marker)),
      candidateObservation:
        id === "MUT-AC12-COVERAGE-MATRIX-DROP-ROW"
          ? "every committed census fixture carries exactly one coverage row"
          : "every committed row's disposition agrees with the census outcome the analyzer produces for it",
      mutantObservation:
        id === "MUT-AC12-COVERAGE-MATRIX-DROP-ROW"
          ? "dropping an arbitrary committed row leaves a census fixture no row accounts for"
          : "rewriting an arbitrary committed row's disposition to another recorded value is rejected",
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

  if (id === "MUT-AC10-CORPUS-EXTENSION-OMIT-MTS") {
    const seventh = (result) =>
      result.violations.some(
        ({ code, site }) => code === "consent-authorization-site-unregistered" && site?.owner === "seventhModuleProbe",
      );
    return {
      candidateGreen: seventh(analyzeScratch(retainedArbitraryControlScratch, {}, candidateModule)),
      mutantRed: !seventh(analyzeScratch(retainedArbitraryControlScratch, {}, mutantModule)),
      candidateObservation:
        "a committed module TypeScript source at an arbitrary path enters the corpus and its unregistered consumption is reported",
      mutantObservation: "excluding the module TypeScript extension hides the whole file and the site with it",
    };
  }

  if (id === "MUT-AC10-EXTENSION-DISPOSITION-OPEN") {
    // An arbitrary extension the committed disposition does not name, so the
    // enumeration and the table disagree in exactly one member.
    const enumerated = [...Object.values(ts.Extension), ".zz-unenumerated"];
    let candidateThrew = null;
    try {
      candidateModule.assertConsentAuthorizationExtensionDisposition(enumerated);
    } catch (error) {
      candidateThrew = error;
    }
    return {
      candidateGreen:
        candidateThrew?.code === "consent-authorization-extension-disposition-partial" &&
        candidateThrew.name === "ConsentAuthorizationGuardError" &&
        candidateModule.assertConsentAuthorizationExtensionDisposition().length ===
          consentAuthorizationExtensionDispositions.length,
      mutantRed:
        mutantModule.assertConsentAuthorizationExtensionDisposition(enumerated).length ===
        consentAuthorizationExtensionDispositions.length,
      candidateObservation:
        "an extension the compiler enumerates but the committed disposition does not name fails closed under its named guard error",
      mutantObservation: "bypassing the totality arm accepts an undispositioned compiler extension",
    };
  }

  if (id === "MUT-AC4-CONSTANT-KEY-UNRESOLVED" || id === "MUT-AC4-TEMPLATE-KEY-UNRESOLVED") {
    const source = repoFile(descriptor.fixture);
    const at = id.endsWith("CONSTANT-KEY-UNRESOLVED")
      ? "zz-unrelated/plain-directory/constant-key.ts"
      : "zz-unrelated/plain-directory/template-key.ts";
    const unclassified = (module) =>
      module
        .scanConsentAuthorizationSource(at, source, ownerContexts)
        .filter(({ referenceClass }) => referenceClass === "unexpected");
    const candidate = unclassified(candidateModule);
    return {
      candidateGreen:
        candidate.length === 1 &&
        candidate[0].constructor === "authorizeConsentForActor" &&
        candidate[0].syntaxKind === "ElementAccessExpression",
      mutantRed: unclassified(mutantModule).length === 0,
      candidateObservation: "an element access key that is constant only after resolution still fails closed",
      mutantObservation: "dropping the resolution arm lets the constant key through unclassified",
    };
  }

  if (id === "MUT-AC4-NAMESPACE-BINDING-UNTRACKED") {
    const source = repoFile(descriptor.fixture);
    const at = "zz-unrelated/plain-directory/namespace-binding.ts";
    const forms = (module) =>
      module
        .scanConsentAuthorizationSource(at, source, ownerContexts)
        .filter(({ referenceClass }) => referenceClass === "noncanonical-module-access")
        .map(({ form }) => form)
        .toSorted();
    return {
      candidateGreen: JSON.stringify(forms(candidateModule)) === JSON.stringify(["dynamic-key", "namespace-import"]),
      mutantRed: forms(mutantModule).length === 0,
      candidateObservation: "a canonical namespace binding and the dynamic key taken through it both fail closed",
      mutantObservation: "untracked canonical bindings let a dynamically keyed namespace call disappear",
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

  if (id === partitionNarrowCaseId) {
    // Both sides are read back off finished processes: the candidate's guard is
    // nonzero and first fails at the governing clause, and the mutant's guard is
    // green outright, which is what proves the one rewrite bypassed every
    // consumer of the observed partition rather than only the clause it names.
    const { candidate, mutant } = executedPartitionNarrow;
    return {
      candidateGreen:
        candidate.acceptanceExitCode === 0 &&
        candidate.acceptanceResult === "pass" &&
        candidate.guardExitCode === 1 &&
        candidate.guardFirstFailingClauseId === descriptor.clauseId,
      mutantRed:
        mutant.acceptanceExitCode > 0 &&
        mutant.acceptanceResult === "fail" &&
        mutant.acceptanceFirstFailingClauseId === descriptor.clauseId &&
        mutant.guardExitCode === 0 &&
        mutant.guardViolationCodes.length === 0,
      candidateObservation:
        "the executed guard exits nonzero for the unregistered consumption at an arbitrary path and first fails at the observed-completeness clause",
      mutantObservation:
        "narrowing the observed partition to registry hits exits the executed guard green, so the acceptance test fails at the observed-completeness clause",
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
  censusCoverage: consentAuthorizationCensusCoveragePath,
  censusCoverageSchema: consentAuthorizationCensusCoverageSchemaPath,
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

      // The executed cases record what two real processes did. A mutant whose
      // own guard is still nonzero has not bypassed the property it claims to,
      // so its "first failing clause" would be manufactured; the harness
      // rejects it here rather than writing it into a receipt.
      const executed = descriptor.caseId === partitionNarrowCaseId ? executedPartitionNarrow : null;
      if (executed) assertExecutedMutantBypasses(descriptor.caseId, executed.mutant);
      const candidateExitCode = executed ? executed.candidate.acceptanceExitCode : outcome.candidateGreen ? 0 : 1;
      const mutantExitCode = executed ? executed.mutant.acceptanceExitCode : outcome.mutantRed ? 1 : 0;
      const firstFailingClauseId = executed ? executed.mutant.acceptanceFirstFailingClauseId : descriptor.clauseId;

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
          exitCode: candidateExitCode,
          result: candidateExitCode === 0 ? "pass" : "fail",
          observation: outcome.candidateObservation,
          clauseTrace: executed
            ? ["scratch.import", "preserved-inputs.equal", "guard.executed", `${descriptor.clauseId}:pass`]
            : ["scratch.import", "preserved-inputs.equal", `${descriptor.clauseId}:pass`],
          stdoutSha256: executed ? executed.candidate.stdoutSha256 : sha256(outcome.candidateObservation),
          stderrSha256: executed ? executed.candidate.stderrSha256 : sha256(""),
        },
        mutantSubrun: {
          exitCode: mutantExitCode,
          result: mutantExitCode === 0 ? "pass" : "fail",
          observation: outcome.mutantObservation,
          clauseTrace: executed
            ? ["scratch.import", "preserved-inputs.equal", "guard.executed", firstFailingClauseId]
            : ["scratch.import", "preserved-inputs.equal", descriptor.clauseId],
          stdoutSha256: executed ? executed.mutant.stdoutSha256 : sha256(outcome.mutantObservation),
          stderrSha256: executed ? executed.mutant.stderrSha256 : sha256(descriptor.clauseId),
        },
        ...(executed
          ? {
              executedGuard: {
                command: executed.command,
                runner: executed.runner,
                acceptanceClauseId: executed.acceptanceClauseId,
                candidate: executed.candidate,
                mutant: executed.mutant,
              },
            }
          : {}),
        expected: {
          violation: descriptor.violation,
          owner: descriptor.owner,
          surface: descriptor.surface,
          digest: registry.partitionDigest,
        },
        firstFailingClauseId,
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
    // a frozen fixture input rather than an expected value. The sha is read out
    // of that frozen payload rather than spelled here.
    const salvageBaseSha = provenanceFixtures["pull-request-merge-ref"].eventPayload.pull_request.base.sha;
    const grep = (paths) => {
      try {
        return execFileSync("git", ["grep", "-n", salvageBaseSha, "--", ...paths], {
          cwd: repoRoot,
          encoding: "utf8",
        });
      } catch (error) {
        return error.stdout ?? "";
      }
    };
    expect(grep([analyzerPath, suitePath])).toBe("");
    expect(grep(["scripts/check-structure/consent-authorization-*", fixtureRoot])).toBe("");

    // The two authorized frozen inputs are excluded from the inventory because
    // they are byte-unchanged against the base ref, not because the control was
    // scoped down to nothing: the exclusion is asserted rather than assumed.
    const excludedFixtures = [
      `${provenanceFixtureRoot}/plain.json`,
      `${provenanceFixtureRoot}/pull-request-merge-ref.json`,
    ];
    const gitOut = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    const byteIdentity = excludedFixtures.map((file) => ({
      file,
      worktree: gitOut(["hash-object", "--", file]),
      baseRef: gitOut(["rev-parse", `refs/remotes/origin/main:${file}`]),
      carriesFrozenInput: grep([file]) !== "",
    }));
    process.stdout.write(`authorized-fixture-byte-identity=${JSON.stringify(byteIdentity)}\n`);
    expect(byteIdentity.map(({ worktree }) => worktree)).toEqual(byteIdentity.map(({ baseRef }) => baseRef));
    expect(byteIdentity.map(({ carriesFrozenInput }) => carriesFrozenInput)).toEqual([true, true]);
    expect(gitOut(["diff", "--name-only", "refs/remotes/origin/main", "--", ...excludedFixtures])).toBe("");
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

  it("fails an owning import redirected onto another module while every registered call is preserved", () => {
    process.stdout.write(
      `owning-import-redirect=${JSON.stringify({
        drift: redirectedImportResult.drift,
        codes: redirectedImportResult.violations.map(({ code }) => code).toSorted(),
      })}\n`,
    );

    // The consumption partition did not move: six registered calls, nothing
    // added, nothing removed. Only the owning-import edge changed.
    expect(redirectedImportResult.partition.consumptions).toHaveLength(6);
    expect(redirectedImportResult.drift.added).toEqual([]);
    expect(redirectedImportResult.drift.removed).toEqual([]);
    expect(redirectedImportResult.drift.previousTotal).toBe(6);
    expect(redirectedImportResult.drift.currentTotal).toBe(6);
    expect(redirectedImportResult.drift.currentCounts).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });

    // The digest separates the two owning-import identities, so drift is
    // reported rather than the redirect passing as an unchanged partition.
    expect(redirectedImportResult.violations.some(({ code }) => code === "consent-authorization-partition-drift")).toBe(
      true,
    );
    expect(redirectedImportResult.drift.previousDigest).toBe(registry.partitionDigest);
    expect(redirectedImportResult.drift.currentDigest).not.toBe(registry.partitionDigest);

    // And the delta names the expected and observed import identities, so the
    // report is readable without recomputing the digest.
    const redirectedFile = "bounded-contexts/identity/features/consents/api/terms-route.ts";
    expect(redirectedImportResult.drift.addedImports).toEqual([
      {
        file: redirectedFile,
        constructor: "authorizeConsentForActor",
        source: redirectedImportSpecifier,
        localName: "authorizeConsentForActor",
        importedName: "authorizeConsentForActor",
        aliased: false,
        typeOnly: false,
      },
    ]);
    expect(redirectedImportResult.drift.removedImports).toEqual([
      expectedConsentAuthorizationImportIdentity(registry.sites.find(({ file }) => file === redirectedFile)),
    ]);
    expect(redirectedImportResult.drift.previousImportTotal).toBe(5);
    expect(redirectedImportResult.drift.currentImportTotal).toBe(5);
    expect(redirectedImportResult.violations.some(({ code }) => code === "consent-authorization-import-invalid")).toBe(
      true,
    );

    // The real tree is the control: identical owning-import identities on both
    // sides, so no delta and no drift.
    expect(realTreeResult.drift).toBe(null);
    expect(registry.sites.map((site) => expectedConsentAuthorizationImportIdentity(site).source).every(Boolean)).toBe(
      true,
    );
  });

  it("carries one witnessed census arm identity per committed coverage row", () => {
    const committedArms = consentAuthorizationCommittedCensusArms(censusCoverage);
    process.stdout.write(
      `census-arms=${JSON.stringify({
        derived: derivedCensusArms,
        committed: committedArms,
        specifierShapes: consentAuthorizationSpecifierShapeDispositions,
        acquisitions: consentAuthorizationAcquisitionArms,
      })}\n`,
    );
    expect(assertConsentAuthorizationSpecifierShapeDispositions()).toHaveLength(4);
    expect(assertConsentAuthorizationKeyCoverageIdentities()).toHaveLength(5);

    // Every derived arm but the generic residual one is witnessed by exactly one
    // committed row, and no committed arm is underived. The residual arms are
    // the two open defaults: the specifier axis carries a census row for its
    // residual, the key axis carries none, and both facts are declared in the
    // matrix rather than inferred from the row list.
    expect(derivedCensusArms.residual).toEqual({ key: "key:runtime-unknown", specifier: "specifier:runtime-unknown" });
    expect(censusCoverage.residualArms).toEqual({
      key: { arm: "key:runtime-unknown" },
      specifier: { arm: "specifier:runtime-unknown", witnessRow: "specifier-runtime-unknown" },
    });
    expect(derivedCensusArms.key.filter((arm) => arm !== derivedCensusArms.residual.key)).toEqual(committedArms.key);
    expect(derivedCensusArms.specifier).toEqual(committedArms.specifier);
    expect(committedArms.key).not.toContain(derivedCensusArms.residual.key);
    for (const axis of ["key", "specifier"]) {
      const witnesses = censusCoverage.rows.filter((row) => row.axis === axis && row.census !== "silent");
      const arms = witnesses.map(({ arm }) => arm);
      expect(arms.filter((arm, index) => arms.indexOf(arm) !== index)).toEqual([]);
    }

    // Sixteen specifier shapes, sixteen identities -- not four parent kinds.
    expect(derivedCensusArms.specifier).toHaveLength(16);
    expect(censusCoverage.rows.filter(({ axis }) => axis === "specifier")).toHaveLength(16);
    expect(consentAuthorizationCoverageAxisKinds(censusCoverage).specifier).toHaveLength(4);
    for (const acquisition of consentAuthorizationAcquisitionArms) {
      for (const { shape } of consentAuthorizationSpecifierShapeDispositions) {
        expect(derivedCensusArms.specifier).toContain(`${acquisition}:${shape}`);
      }
    }

    // Every non-silent row's arm is one the live analyzer actually reached over
    // that row's own fixture, and the silent row reaches none.
    const observed = censusCoverage.rows.map((row) => ({
      rowId: row.rowId,
      arm: row.arm ?? null,
      observedArms: observeConsentAuthorizationCoverageRow(row, repoFile(row.fixture), ownerContexts).observedArms,
    }));
    process.stdout.write(`census-arm-observations=${JSON.stringify(observed)}\n`);
    expect(
      observed.filter(({ arm, observedArms }) =>
        arm === null ? observedArms.length > 0 : !observedArms.includes(arm),
      ),
    ).toEqual([]);
    expect(observed.filter(({ arm }) => arm === null)).toHaveLength(1);
    expect(assertConsentAuthorizationCensusArmPartition(censusCoverage, derivedCensusArms)).toEqual(committedArms);
  });

  it("fails closed when a census coverage row and its fixture are removed together", () => {
    const removedRowId = omittedCoverageRowId;
    const withoutRow = coverageWithoutOmittedRow;
    const withoutFixture = censusFixturesWithoutOmittedRow;
    expect(withoutRow.rows).toHaveLength(censusCoverage.rows.length - 1);
    expect(withoutFixture).toHaveLength(censusFixtureFiles.length - 1);

    const capture = (run) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return null;
    };

    // The row-level and kind-level authorities are both blind to this omission:
    // the fixture bijection shrinks with the row, and sixteen specifier shapes
    // share four parent node kinds. Recorded rather than assumed.
    const survivors = {
      fixtureBijection: collectConsentAuthorizationCoverageViolations(withoutRow, censusCoverageSchema, {
        censusFixtureFiles: withoutFixture,
      }),
      kindPartition: capture(() => assertConsentAuthorizationCoveragePartition(withoutRow, derivedCoverageAxes)),
    };
    process.stdout.write(`coordinated-omission-survivors=${JSON.stringify(survivors)}\n`);
    expect(survivors.fixtureBijection).toEqual([]);
    expect(survivors.kindPartition).toBe(null);

    // The arm authority is not.
    const omitted = capture(() => assertConsentAuthorizationCensusArmPartition(withoutRow, derivedCensusArms));
    expect(omitted).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(omitted.code).toBe("consent-authorization-coverage-partition-partial");
    expect(omitted.details.differences).toEqual([
      { axis: "specifier", unwitnessed: ["dynamic-import:no-substitution-template"], underived: [] },
    ]);

    // And the guard consults it, so the omission is red at the entrypoint too.
    expect(coordinatedOmissionGuardFailure).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(coordinatedOmissionGuardFailure.code).toBe("consent-authorization-coverage-partition-partial");
    expect(coordinatedOmissionGuardFailure.reachedClause).toBe("coverage.arm-partition");

    // The other direction: a committed row naming an arm the analyzer cannot
    // reach, and a duplicated row identity.
    const underived = capture(() =>
      assertConsentAuthorizationCensusArmPartition(
        {
          ...censusCoverage,
          rows: censusCoverage.rows.map((row) =>
            row.rowId === removedRowId ? { ...row, arm: "dynamic-import:unreachable-shape" } : row,
          ),
        },
        derivedCensusArms,
      ),
    );
    expect(underived).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(underived.details.differences).toEqual([
      {
        axis: "specifier",
        unwitnessed: ["dynamic-import:no-substitution-template"],
        underived: ["dynamic-import:unreachable-shape"],
      },
    ]);

    const silentRow = censusCoverage.rows.find(({ census }) => census === "silent");
    const withoutSilence = capture(() =>
      assertConsentAuthorizationCensusArmPartition(
        { ...censusCoverage, rows: censusCoverage.rows.filter((row) => row !== silentRow) },
        derivedCensusArms,
      ),
    );
    expect(withoutSilence).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(withoutSilence.details.differences).toEqual([
      { axis: "census-outcome", unwitnessed: ["silent"], underived: [] },
    ]);

    // A row that carries an arm where it must carry none, and one that carries
    // none where it must carry an arm, are both rejected by the row validator.
    expect(
      collectConsentAuthorizationCoverageViolations(
        {
          ...censusCoverage,
          rows: censusCoverage.rows.map((row) =>
            row === silentRow ? { ...row, arm: "consumption:direct-identifier" } : row,
          ),
        },
        censusCoverageSchema,
        { censusFixtureFiles },
      ).some((entry) => entry.includes("analyzer census arm")),
    ).toBe(true);
  });

  it("derives the five canonical F5 identities from analyzer source with coverage data unavailable", () => {
    // The derivation is handed one string -- the analyzer's own text -- and
    // reads nothing else: no coverage JSON, no fixture index, no row
    // identifier. The identities it returns are compared against literals
    // written here, never against the committed matrix.
    const derived = deriveConsentAuthorizationCensusArms({ analyzerSource: analyzerSourceText });
    const canonical = [
      "key:element-access:written-string-literal",
      "key:element-access:shadowed-lexical-constant:identifier",
      "key:element-access:shadowed-lexical-constant:template-expression",
      "key:binding-element:lexical-constant:identifier",
      "key:binding-element:lexical-constant:template-expression",
    ];
    process.stdout.write(
      `census-arm-derivation=${JSON.stringify({
        typeScriptVersion: ts.version,
        analyzerPath,
        analyzerSourceSha256: repoFileSha256(analyzerPath),
        identityTable: consentAuthorizationKeyCoverageIdentities,
        residual: derived.residual,
        derivedKeyArms: derived.key,
      })}\n`,
    );

    expect(new Set(canonical).size).toBe(5);
    for (const identity of canonical) expect(derived.key).toContain(identity);
    expect(derived.key).toContain(consentAuthorizationKeyRuntimeUnknownArm);
    expect(consentAuthorizationKeyCoverageIdentities.map(({ identity }) => identity)).toEqual(canonical);

    // No fixture and no row identifier creates an identity: the analyzer's own
    // text carries none of them, and each identity is written exactly once, in
    // the table the derivation reads.
    for (const row of censusCoverage.rows) {
      expect(analyzerSourceText).not.toContain(row.rowId);
      expect(analyzerSourceText).not.toContain(path.posix.basename(row.fixture));
    }
    for (const identity of canonical) {
      expect(analyzerSourceText.split(JSON.stringify(identity))).toHaveLength(2);
    }

    // And the identities genuinely come from that table and that constant: a
    // source in which either is no longer readable fails closed at the named
    // arm-authority clause rather than deriving a narrower set.
    const capture = (source) => {
      try {
        deriveConsentAuthorizationCensusArms({ analyzerSource: source });
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const declaration of [
      "export const consentAuthorizationKeyCoverageIdentities = Object.freeze(",
      'export const consentAuthorizationKeyRuntimeUnknownArm = "key:runtime-unknown";',
    ]) {
      expect(analyzerSourceText.split(declaration)).toHaveLength(2);
      const underived = capture(
        analyzerSourceText.replace(
          declaration,
          declaration.replace("consentAuthorization", "renamedConsentAuthorization"),
        ),
      );
      expect(underived).toBeInstanceOf(ConsentAuthorizationGuardError);
      expect(underived.code).toBe("consent-authorization-coverage-arm-underived");
      expect(underived.reachedClause).toBe("coverage.arm-authority");
    }
  });

  it("proves the coverage identity seam cannot change reference classification", () => {
    // The seam's whole surface: three primitives in, one arm name out. It is
    // handed no node, no source text, and no bindings map, so there is nothing
    // in it that could resolve a name, reach a constructor, fold a key, or
    // decide a reference's class. Read off the parsed declaration rather than
    // asserted about.
    const sourceFile = ts.createSourceFile(
      analyzerPath,
      analyzerSourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    let seam = null;
    const findSeam = (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "deriveConsentAuthorizationKeyCoverageIdentity" &&
        node.body
      ) {
        seam = node;
        return;
      }
      ts.forEachChild(node, findSeam);
    };
    findSeam(sourceFile);
    expect(seam).not.toBe(null);
    expect(seam.parameters.map((parameter) => parameter.name.getText(sourceFile))).toEqual([
      "syntaxRole",
      "expressionKind",
      "constantKeyOutcome",
    ]);

    const referenced = new Set();
    const collect = (node) => {
      if (ts.isIdentifier(node)) referenced.add(node.text);
      ts.forEachChild(node, collect);
    };
    collect(seam.body);
    process.stdout.write(`coverage-identity-seam-references=${JSON.stringify([...referenced].sort())}\n`);
    expect([...referenced].sort()).toEqual([
      "SyntaxKind",
      "candidate",
      "consentAuthorizationKeyCoverageIdentities",
      "consentAuthorizationKeyRuntimeUnknownArm",
      "constantKeyOutcome",
      "entry",
      "expressionKind",
      "find",
      "identity",
      "syntaxRole",
      "ts",
    ]);

    // Total by construction, and total into a closed set: every role, every
    // outcome, and every compiler syntax kind together reach either one exact
    // identity or the one residual arm, and never anything else.
    const closed = new Set([
      ...consentAuthorizationKeyCoverageIdentities.map(({ identity }) => identity),
      consentAuthorizationKeyRuntimeUnknownArm,
    ]);
    const kinds = [...new Set(Object.values(ts.SyntaxKind).filter((kind) => typeof kind === "number"))];
    let answered = 0;
    for (const syntaxRole of [...consentAuthorizationKeySyntaxRoles, "an-unnamed-role"]) {
      for (const outcome of [...consentAuthorizationConstantKeyOutcomes, "an-unnamed-outcome"]) {
        for (const kind of kinds) {
          expect(closed.has(deriveConsentAuthorizationKeyCoverageIdentity(syntaxRole, kind, outcome))).toBe(true);
          answered += 1;
        }
      }
    }
    expect(consentAuthorizationKeySyntaxRoles).toHaveLength(2);
    expect(consentAuthorizationConstantKeyOutcomes).toHaveLength(4);
    expect(answered).toBe(
      (consentAuthorizationKeySyntaxRoles.length + 1) *
        (consentAuthorizationConstantKeyOutcomes.length + 1) *
        kinds.length,
    );

    // Executed: every committed row's classification is exactly what the
    // committed signature says, with the repaired arms in place. The seam moved
    // which census arm counts a reference; it moved no reference's class,
    // constructor, axis, or syntax kind.
    const classifications = censusCoverage.rows.map((row) => {
      const references = scanConsentAuthorizationSource(row.plantedAt, repoFile(row.fixture), ownerContexts);
      return {
        rowId: row.rowId,
        classes: [...new Set(references.map(({ referenceClass }) => referenceClass))].sort(),
        constructors: [...new Set(references.map(({ constructor }) => constructor).filter(Boolean))].sort(),
        signatureMatches: references.filter((reference) =>
          Object.entries(row.signature).every(([field, value]) => reference[field] === value),
        ).length,
      };
    });
    process.stdout.write(`coverage-identity-classification=${JSON.stringify(classifications)}\n`);
    expect(
      classifications.filter(({ rowId, signatureMatches }) => {
        const row = censusCoverage.rows.find((entry) => entry.rowId === rowId);
        return (row.census === "classified") !== signatureMatches > 0;
      }),
    ).toEqual([]);
    // The five repaired rows kept every field the identity did not decide: same
    // identifier, same fixture, same expression kind, same disposition, same
    // owner, same observable census outcome.
    expect(
      censusCoverage.rows
        .filter(({ arm }) => typeof arm === "string" && legacyF5CoverageIdentityMutant[arm] !== undefined)
        .map(({ rowId, expressionKind, disposition, census, owner }) => [
          rowId,
          expressionKind,
          disposition,
          census,
          owner ?? null,
        ]),
    ).toEqual([
      ["key-string-literal-element-access", "StringLiteral", "classified", "classified", null],
      ["key-shadowed-lexical-constant-element-access", "Identifier", "declared-open", "admitted-unknown", "#6493"],
      [
        "key-shadowed-lexical-constant-template-element-access",
        "TemplateExpression",
        "declared-open",
        "admitted-unknown",
        "#6493",
      ],
      [
        "key-computed-binding-element-over-lexical-constant",
        "Identifier",
        "declared-open",
        "admitted-unknown",
        "#6493",
      ],
      [
        "key-computed-binding-element-over-constant-template",
        "TemplateExpression",
        "declared-open",
        "admitted-unknown",
        "#6493",
      ],
    ]);
  });

  it("routes every other runtime key shape to key:runtime-unknown", () => {
    // Five key shapes no coverage identity names -- a call, a conditional, a
    // property access, an ordinary mutable binding, and a computed binding
    // element over a runtime name. None of them is enumerated anywhere in the
    // analyzer, and each is admitted and counted under the one generic arm.
    const planted = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/runtime-shapes.ts",
      [
        "let mutableKey = makeKey();",
        "authorization[makeKey()](context);",
        "authorization[flag ? first : second](context);",
        "authorization[keys.first](context);",
        "authorization[mutableKey](context);",
        "const { [makeKey()]: alias } = authorization;",
        "",
      ].join("\n"),
      ownerContexts,
    );
    process.stdout.write(`runtime-key-shapes=${JSON.stringify(planted)}\n`);
    expect(planted.filter(({ referenceClass }) => referenceClass !== "admitted-unknown")).toEqual([]);
    expect(planted).toHaveLength(5);
    expect([...new Set(planted.map(({ arm }) => arm))]).toEqual([consentAuthorizationKeyRuntimeUnknownArm]);
    expect([...new Set(planted.map(({ syntaxKind }) => syntaxKind))].toSorted()).toEqual([
      "CallExpression",
      "ConditionalExpression",
      "Identifier",
      "PropertyAccessExpression",
    ]);

    // And the whole-corpus census counts the residual arm rather than dropping
    // it: a shape nobody has committed a row for is still published.
    const residual = realTreeResult.census.admittedUnknowns.filter(
      ({ arm }) => arm === consentAuthorizationKeyRuntimeUnknownArm,
    );
    expect(residual.length).toBeGreaterThan(0);
    expect(residual.every(({ count }) => count > 0)).toBe(true);
    expect(censusCoverage.rows.filter(({ arm }) => arm === consentAuthorizationKeyRuntimeUnknownArm)).toEqual([]);
  });

  it("rejects deletion of every committed census row and fixture through coverage.arm-partition", () => {
    process.stdout.write(`census-deletion-receipt=${JSON.stringify(candidateDeletionReceipt)}\n`);

    // The inventory is the immutable pre-mutation one: thirty-four unique row
    // identifiers, one trial each, nothing missing and nothing extra.
    expect(censusDeletionInventory).toHaveLength(34);
    expect(candidateDeletionReceipt.trialCount).toBe(34);
    expect(new Set(candidateDeletionReceipt.rowIds).size).toBe(34);
    expect(candidateDeletionReceipt.rowIds.toSorted()).toEqual(
      censusCoverage.rows.map(({ rowId }) => rowId).toSorted(),
    );
    expect(candidateDeletionReceipt.inventoryDigest).toBe(sha256(JSON.stringify(censusDeletionInventory)));
    expect(candidateDeletionReceipt.trials.every(({ remainingRows }) => remainingRows === 33)).toBe(true);
    expect(candidateDeletionReceipt.trials.every(({ remainingFixtures }) => remainingFixtures === 33)).toBe(true);

    // Every trial fails, at the named code and the named first clause.
    expect(candidateDeletionReceipt.survivors).toEqual([]);
    expect(candidateDeletionReceipt.survivorCount).toBe(0);
    expect([...new Set(candidateDeletionReceipt.trials.map(({ code }) => code))]).toEqual([
      "consent-authorization-coverage-partition-partial",
    ]);
    expect([...new Set(candidateDeletionReceipt.trials.map(({ firstClause }) => firstClause))]).toEqual([
      "coverage.arm-partition",
    ]);

    // Grouped as the issue records it: twenty-nine omissions that were already
    // rejected stay rejected, and the five that survived at the parked head are
    // rejected now.
    const alreadyRejected = [
      "key-direct-identifier-call",
      "key-no-substitution-template-element-access",
      "key-string-literal-binding-element-property-name",
      "key-string-literal-computed-property-name-in-binding-element",
      "key-element-access-over-lexical-constant",
      "key-element-access-over-constant-template-expression",
      "key-element-access-over-constant-concatenation",
      "key-element-access-over-parenthesized-constant",
      "key-element-access-over-as-expression-constant",
      "key-element-access-over-satisfies-expression-constant",
      "key-element-access-over-non-null-constant",
      "key-element-access-over-type-assertion-constant",
      "key-unrelated-constructor-like-string",
      "specifier-canonical-named-import",
      "specifier-namespace-import",
      "specifier-default-import",
      "specifier-import-equals",
      "specifier-namespace-re-export",
      "specifier-namespace-binding-dynamic-key",
      "specifier-escaping-namespace-binding",
      "specifier-string-literal-dynamic-import",
      "specifier-string-literal-require",
      "specifier-no-substitution-template-dynamic-import",
      "specifier-lexical-constant-dynamic-import",
      "specifier-constant-concatenation-dynamic-import",
      "specifier-no-substitution-template-require",
      "specifier-lexical-constant-require",
      "specifier-constant-concatenation-require",
      "specifier-runtime-unknown",
    ];
    const repairedRejections = [
      "key-string-literal-element-access",
      "key-shadowed-lexical-constant-element-access",
      "key-shadowed-lexical-constant-template-element-access",
      "key-computed-binding-element-over-lexical-constant",
      "key-computed-binding-element-over-constant-template",
    ];
    expect(alreadyRejected).toHaveLength(29);
    expect(repairedRejections).toHaveLength(5);
    expect([...alreadyRejected, ...repairedRejections].toSorted()).toEqual(
      censusCoverage.rows.map(({ rowId }) => rowId).toSorted(),
    );
    for (const group of [alreadyRejected, repairedRejections]) {
      for (const rowId of group) {
        const trial = candidateDeletionReceipt.trials.find((entry) => entry.rowId === rowId);
        expect(trial).toBeDefined();
        expect(trial.survived).toBe(false);
        expect(trial.firstClause).toBe("coverage.arm-partition");
      }
    }

    // The real guard entrypoint reaches the same clause on a repaired omission,
    // so the sweep above is the authority the entrypoint consults and not a
    // parallel reimplementation of it.
    expect(repairedOmissionGuardOutcomes.candidate.failure).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(repairedOmissionGuardOutcomes.candidate.failure.code).toBe(
      "consent-authorization-coverage-partition-partial",
    );
    expect(repairedOmissionGuardOutcomes.candidate.failure.reachedClause).toBe("coverage.arm-partition");
    expect(coordinatedOmissionGuardFailure.reachedClause).toBe("coverage.arm-partition");
  });

  it("reproduces exactly five parked survivors with the candidate-local legacy identity mutant", () => {
    process.stdout.write(
      `legacy-f5-deletion-receipt=${JSON.stringify({
        mutant: legacyF5CoverageIdentityMutant,
        rewrites: legacyMutantSource.rewrites,
        mutantArms: legacyMutantCensusArms,
        ...legacyDeletionReceipt,
      })}\n`,
    );

    // The mutant changes the five coverage identities and nothing else: five
    // written literals in the analyzer's own text, and the five committed rows
    // that name them.
    expect(Object.keys(legacyF5CoverageIdentityMutant)).toHaveLength(5);
    expect(legacyMutantSource.rewrites).toBe(5);
    expect(
      legacyMutantCoverage.rows.filter(
        (row, index) => JSON.stringify(row) !== JSON.stringify(censusCoverage.rows[index]),
      ),
    ).toHaveLength(5);
    expect(legacyMutantCensusArms.residual).toEqual(derivedCensusArms.residual);
    expect(legacyMutantCensusArms.specifier).toEqual(derivedCensusArms.specifier);
    expect(legacyMutantCensusArms.key).toEqual(
      [
        "binding-element-key",
        "computed-property:binding-element-computed-name",
        "computed-property:binding-element-property-name",
        "computed-property:element-access",
        "constant-key:AsExpression",
        "constant-key:BinaryExpression",
        "constant-key:Identifier",
        "constant-key:NonNullExpression",
        "constant-key:ParenthesizedExpression",
        "constant-key:SatisfiesExpression",
        "constant-key:TemplateExpression",
        "constant-key:TypeAssertionExpression",
        "consumption:direct-identifier",
        "element-access-key",
        "key:runtime-unknown",
      ].toSorted(),
    );

    // The same immutable thirty-four-pair sweep, and exactly the five omissions
    // the parked head left green come back green -- no more and no fewer.
    expect(legacyDeletionReceipt.trialCount).toBe(34);
    expect(legacyDeletionReceipt.rowIds).toEqual(candidateDeletionReceipt.rowIds);
    expect(legacyDeletionReceipt.inventoryDigest).toBe(candidateDeletionReceipt.inventoryDigest);
    expect(legacyDeletionReceipt.survivorCount).toBe(5);
    expect(legacyDeletionReceipt.survivors).toEqual([
      "key-string-literal-element-access",
      "key-shadowed-lexical-constant-element-access",
      "key-shadowed-lexical-constant-template-element-access",
      "key-computed-binding-element-over-lexical-constant",
      "key-computed-binding-element-over-constant-template",
    ]);

    // The discriminator is candidate-local: it reads the committed analyzer and
    // the committed matrix in this worktree and nothing else, so it reproduces
    // the parked survivors with the parked branch and object unavailable.
    expect(legacyMutantSource.source).not.toBe(analyzerSourceText);
    expect(legacyMutantSource.source).toContain('"element-access-key"');
    expect(analyzerSourceText).not.toContain('"element-access-key"');

    // And the whole guard agrees at the entrypoint: the same coordinated
    // deletion that is red under the candidate identities is green under the
    // legacy ones, with every other input frozen.
    expect(repairedOmissionGuardOutcomes.legacy.failure).toBe(null);
    expect(repairedOmissionGuardOutcomes.legacy.result.violations).toEqual([]);
    expect(repairedOmissionGuardOutcomes.candidate.result).toBe(null);
  });

  it("keeps all ten successor-owned rows declared open and both silent rows silent", () => {
    const owned = censusCoverage.rows.filter(({ disposition }) => disposition === "declared-open");
    const silent = censusCoverage.rows.filter(({ disposition }) => disposition === "silent-by-design");
    process.stdout.write(
      `successor-owned-rows=${JSON.stringify({
        owned: owned.map(({ rowId, arm, census, owner }) => ({ rowId, arm, census, owner })),
        silent: silent.map(({ rowId, arm, census }) => ({ rowId, arm: arm ?? null, census })),
      })}\n`,
    );

    expect(owned).toHaveLength(10);
    expect(owned.map(({ rowId }) => rowId).toSorted()).toEqual(
      [
        "key-shadowed-lexical-constant-element-access",
        "key-shadowed-lexical-constant-template-element-access",
        "key-computed-binding-element-over-lexical-constant",
        "key-computed-binding-element-over-constant-template",
        "specifier-no-substitution-template-dynamic-import",
        "specifier-lexical-constant-dynamic-import",
        "specifier-constant-concatenation-dynamic-import",
        "specifier-no-substitution-template-require",
        "specifier-lexical-constant-require",
        "specifier-constant-concatenation-require",
      ].toSorted(),
    );
    expect(owned.every(({ owner }) => owner === consentAuthorizationDeclaredOpenOwner)).toBe(true);
    expect(owned.every(({ census }) => census === "admitted-unknown")).toBe(true);

    expect(silent.map(({ rowId, census }) => [rowId, census]).toSorted()).toEqual([
      ["key-unrelated-constructor-like-string", "silent"],
      ["specifier-runtime-unknown", "admitted-unknown"],
    ]);

    // Observed live, not asserted about: every successor-owned shape is still
    // admitted as an unknown, and the silent-by-design key shape still emits
    // nothing at all.
    const observed = [...owned, ...silent].map((row) => ({
      rowId: row.rowId,
      census: observeConsentAuthorizationCoverageRow(row, repoFile(row.fixture), ownerContexts).census,
    }));
    expect(observed).toEqual([...owned, ...silent].map(({ rowId, census }) => ({ rowId, census })));
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

  it("dispositions the compiler's enumerated extension set exactly and fails closed on a member it does not name", () => {
    const enumerated = Object.values(ts.Extension);
    const dispositioned = consentAuthorizationExtensionDispositions.map(({ extension }) => extension);
    process.stdout.write(
      `extension-disposition=${JSON.stringify(
        consentAuthorizationExtensionDispositions.map(({ extension, scanned, scriptKind }) => [
          extension,
          scanned,
          scriptKind,
        ]),
      )}\n`,
    );
    expect(dispositioned.toSorted()).toEqual(enumerated.toSorted());
    expect(assertConsentAuthorizationExtensionDisposition()).toHaveLength(enumerated.length);

    // Every module extension is scanned and only the two non-module members are
    // not, so the corpus is bounded by what the grammar supports rather than by
    // what the candidate head happens to carry.
    const scanned = consentAuthorizationExtensionDispositions
      .filter((entry) => entry.scanned)
      .map(({ extension }) => extension);
    expect(scanned).toContain(ts.Extension.Mts);
    expect(scanned).toContain(ts.Extension.Dmts);
    expect(scanned).toContain(ts.Extension.Cts);
    expect(scanned).toContain(ts.Extension.Dcts);
    expect(
      consentAuthorizationExtensionDispositions
        .filter((entry) => !entry.scanned)
        .map(({ extension }) => extension)
        .toSorted(),
    ).toEqual([ts.Extension.Json, ts.Extension.TsBuildInfo].toSorted());
    expect(consentAuthorizationExtensionDispositions.every(({ reason }) => reason.trim().length > 0)).toBe(true);

    let thrown = null;
    try {
      assertConsentAuthorizationExtensionDisposition([...enumerated, ".zz-unenumerated"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(thrown.code).toBe("consent-authorization-extension-disposition-partial");
    expect(thrown.details.undispositioned).toEqual([".zz-unenumerated"]);
  });

  it("censuses committed module TypeScript source at an arbitrary path", () => {
    process.stdout.write(
      `arbitrary-controls=${JSON.stringify({
        surface: arbitraryControlResult.surface,
        files: arbitraryControlResult.corpus.files,
        codes: arbitraryControlResult.violations.map(({ code }) => code).toSorted(),
      })}\n`,
    );
    expect(arbitraryControlResult.corpus.files).toContain("zz-unrelated/plain-directory/module.mts");
    expect(arbitraryControlResult.surface).toEqual({ scanned: 10, total: 10 });
    expect(
      arbitraryControlResult.violations.some(
        ({ code, site }) => code === "consent-authorization-site-unregistered" && site?.owner === "seventhModuleProbe",
      ),
    ).toBe(true);
    expect(arbitraryControlResult.corpus.extensionAuthority).toBe("ts.Extension");
  });

  it("fails constant-key and template-key element accesses discovered at arbitrary paths", () => {
    const unclassified = arbitraryControlResult.violations.filter(
      ({ code, reference }) =>
        code === "consent-authorization-reference-unclassified" &&
        reference?.syntaxKind === "ElementAccessExpression" &&
        reference.file.startsWith("zz-unrelated/"),
    );
    expect(unclassified.map(({ reference }) => [reference.file, reference.constructor]).toSorted()).toEqual([
      ["zz-unrelated/plain-directory/constant-key.ts", "authorizeConsentForActor"],
      ["zz-unrelated/plain-directory/template-key.ts", "authorizeConsentForActor"],
    ]);

    // A key that is genuinely unrelated stays silent, so the resolver reports a
    // resolved fact rather than every computed access it meets, and the one key
    // it cannot fold is an admitted unknown rather than a violation.
    const neighbourKeys = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/neighbour.ts",
      'const key = "authorizeConsentForNobody";\nauthorization[key](context);\nauthorization[runtimeKey](context);\n',
      ownerContexts,
    );
    expect(neighbourKeys.filter(({ referenceClass }) => referenceClass !== "admitted-unknown")).toEqual([]);
    // `runtimeKey` names no lexical constant at all, so it is neither a written
    // literal nor a shadowed constant: it is an ordinary runtime key and reaches
    // the generic residual arm.
    expect(neighbourKeys.map(({ referenceClass, axis, arm }) => [referenceClass, axis, arm])).toEqual([
      ["admitted-unknown", "key", consentAuthorizationKeyRuntimeUnknownArm],
    ]);
  });

  it("fails closed on a canonical namespace binding and the dynamic key taken through it", () => {
    const accesses = arbitraryControlResult.violations.filter(
      ({ code }) => code === "consent-authorization-noncanonical-module-access",
    );
    expect(accesses.map(({ reference }) => reference.form).toSorted()).toEqual(["dynamic-key", "namespace-import"]);
    expect(
      accesses.every(({ reference }) => reference.file === "zz-unrelated/plain-directory/namespace-binding.ts"),
    ).toBe(true);

    // A namespace binding of an unrelated module is not the canonical module,
    // so no dynamic key through it is reported.
    const neighbourNamespace = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/neighbour.ts",
      'import * as neighbour from "./unrelated-module";\nexport const value = neighbour[runtimeKey](context);\n',
      ownerContexts,
    );
    expect(neighbourNamespace.filter(({ referenceClass }) => referenceClass !== "admitted-unknown")).toEqual([]);
  });

  it("matches every census coverage row against the real analyzer", () => {
    const matrix = censusCoverage.rows.map((row) => {
      const observed = observeConsentAuthorizationCoverageRow(row, repoFile(row.fixture), ownerContexts);
      return {
        rowId: row.rowId,
        axis: row.axis,
        expressionKind: row.expressionKind,
        shape: row.shape,
        fixture: row.fixture,
        plantedAt: row.plantedAt,
        disposition: row.disposition,
        owner: row.owner ?? null,
        committedCensus: row.census,
        observedCensus: observed.census,
        matchedReferences: observed.matchedReferences,
        admittedUnknownKinds: observed.admittedUnknownKinds,
      };
    });
    process.stdout.write(`census-coverage-matrix=${JSON.stringify(matrix)}\n`);
    process.stdout.write(
      `census-coverage-counts=${JSON.stringify({
        ...consentAuthorizationCoverageCounts(censusCoverage),
        rows: censusCoverage.rows.length,
        admittedUnknownTotal: realTreeResult.census.admittedUnknownTotal,
        admittedUnknowns: realTreeResult.census.admittedUnknowns,
      })}\n`,
    );

    // Every expectation below is the committed datum; the observed side is the
    // live analyzer run over that row's own fixture.
    expect(matrix.map(({ observedCensus }) => observedCensus)).toEqual(censusCoverage.rows.map(({ census }) => census));
    expect(
      collectConsentAuthorizationCoverageViolations(censusCoverage, censusCoverageSchema, { censusFixtureFiles }),
    ).toEqual([]);
    expect(collectOpenSchemaObjectPaths(censusCoverageSchema)).toEqual([]);
    expect(validateAgainstSchema(censusCoverage, censusCoverageSchema)).toEqual([]);
    expect(censusFixtureFiles).toEqual(censusCoverage.rows.map(({ fixture }) => fixture).toSorted());
    expect(consentAuthorizationCoverageCounts(censusCoverage)).toEqual({
      classified: 22,
      "declared-open": 10,
      "silent-by-design": 2,
    });
    expect(
      censusCoverage.rows.filter(({ disposition }) => disposition === "declared-open").map(({ owner }) => owner),
    ).toEqual(Array.from({ length: 10 }, () => consentAuthorizationDeclaredOpenOwner));
    expect(
      censusCoverage.rows
        .filter(({ disposition }) => disposition !== "declared-open")
        .every(({ owner }) => owner === undefined),
    ).toBe(true);

    // A declared-open shape is a published residual, never a silent drop: the
    // named default arm admits it and the whole-corpus census counts it.
    expect(
      matrix.filter(({ disposition }) => disposition === "declared-open").map(({ observedCensus }) => observedCensus),
    ).toEqual(Array.from({ length: 10 }, () => "admitted-unknown"));
    expect(realTreeResult.census.defaultArm).toBe("admitted-unknown");
    expect(realTreeResult.census.admittedUnknownTotal).toBeGreaterThan(0);
    expect(realTreeResult.coverage.rows).toBe(censusCoverage.rows.length);
    expect(realTreeResult.coverage.fixtureRoot).toBe(consentAuthorizationCensusFixtureRoot);
  });

  it("fails closed when the coverage partition does not cover the analyzer's own expression kinds", () => {
    const capture = (run) => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return null;
    };
    const committedAxes = consentAuthorizationCoverageAxisKinds(censusCoverage);
    process.stdout.write(
      `coverage-axes=${JSON.stringify({
        authorities: consentAuthorizationCoverageAxisAuthorities,
        derived: derivedCoverageAxes,
        committed: committedAxes,
      })}\n`,
    );
    expect(derivedCoverageAxes.key).toEqual(committedAxes.key);
    expect(derivedCoverageAxes.specifier).toEqual(committedAxes.specifier);
    expect(censusCoverage.axisAuthorities).toEqual(consentAuthorizationCoverageAxisAuthorities);
    expect(capture(() => assertConsentAuthorizationCoveragePartition(censusCoverage, derivedCoverageAxes))).toBe(null);

    // The axes are read out of the analyzer's own text rather than restated, so
    // removing one branch from a copy of that text removes exactly its kind.
    const analyzerSource = repoFile(analyzerPath);
    const withoutIdentifierArm = analyzerSource.replace(
      "  if (ts.isIdentifier(node)) {\n    const bound = bindings.get(node.text);",
      "  if (node === null) {\n    const bound = bindings.get(node.text);",
    );
    expect(withoutIdentifierArm === analyzerSource).toBe(false);
    const narrowed = deriveConsentAuthorizationCoverageAxes({ analyzerSource: withoutIdentifierArm });
    expect(derivedCoverageAxes.key.filter((kind) => !narrowed.key.includes(kind))).toEqual(["Identifier"]);

    // A committed row whose kind the analyzer no longer branches on.
    const unbranched = capture(() => assertConsentAuthorizationCoveragePartition(censusCoverage, narrowed));
    expect(unbranched).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(unbranched.code).toBe("consent-authorization-coverage-partition-partial");
    expect(unbranched.details.differences).toEqual([{ axis: "key", unrowed: [], unbranched: ["Identifier"] }]);

    // A branch the matrix carries no row for, on the other axis.
    const unrowed = capture(() =>
      assertConsentAuthorizationCoveragePartition(censusCoverage, {
        ...derivedCoverageAxes,
        specifier: [...derivedCoverageAxes.specifier, "ConditionalExpression"],
      }),
    );
    expect(unrowed).toBeInstanceOf(ConsentAuthorizationGuardError);
    expect(unrowed.code).toBe("consent-authorization-coverage-partition-partial");
    expect(unrowed.details.differences).toEqual([
      { axis: "specifier", unrowed: ["ConditionalExpression"], unbranched: [] },
    ]);
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

  it("rejects a stale but well-formed receipt and aggregate provenance", () => {
    const live = deriveConsentAuthorizationReceiptProvenance(realTreeResult);
    const receiptFor = (provenance, caseId = "MUT-PROBE") => ({ caseId, provenance });
    const aggregateFor = (provenance, receipts) => ({
      provenance,
      receipts: receipts.map((receipt) => ({ caseId: receipt.caseId, sha256: sha256(JSON.stringify(receipt)) })),
      counts: {
        total: receipts.length,
        candidateGreen: receipts.length,
        mutantRed: receipts.length,
        active: receipts.length,
        preserved: receipts.length,
      },
    });
    const enumerationFor = (receipts) => ({ cases: receipts.map(({ caseId }) => caseId) });
    const codesFor = (violations) => violations.map(({ code, field }) => [code, field]).toSorted();

    const controls = [
      { name: "fresh exact head", provenance: live },
      { name: "stale candidate head", provenance: { ...live, candidateHead: staleProvenanceSha } },
      { name: "stale analyzed tree", provenance: { ...live, analyzedTree: staleProvenanceSha } },
      { name: "stale base tip", provenance: { ...live, baseTipAtAnalysis: staleProvenanceSha } },
      { name: "other environment", provenance: { ...live, environment: "merge-group" } },
      { name: "other candidate-head role", provenance: { ...live, candidateHeadRole: "analyzedTree" } },
      { name: "malformed sha", provenance: { ...live, candidateHead: staleProvenanceSha.slice(0, 39) } },
      { name: "missing field", provenance: { ...live, analyzedTree: undefined } },
    ];
    const observed = controls.map((control) => ({
      name: control.name,
      executable: codesFor(collectMutationProvenanceViolations("receipt:probe", control.provenance, live)),
      schema: validateAgainstSchema(control.provenance, receiptSchema.properties.provenance).length,
    }));
    process.stdout.write(`receipt-provenance-controls=${JSON.stringify(observed)}\n`);

    // The three commit-sha fields, the environment and the role are all
    // rejected under one stable named failure; a value the schema already
    // rejects keeps being rejected there too.
    expect(observed[0]).toEqual({ name: "fresh exact head", executable: [], schema: 0 });
    expect(observed.slice(1, 6).map(({ executable }) => executable)).toEqual([
      [["consent-authorization-mutation-provenance-mismatch", "candidateHead"]],
      [["consent-authorization-mutation-provenance-mismatch", "analyzedTree"]],
      [["consent-authorization-mutation-provenance-mismatch", "baseTipAtAnalysis"]],
      [["consent-authorization-mutation-provenance-mismatch", "environment"]],
      [["consent-authorization-mutation-provenance-mismatch", "candidateHeadRole"]],
    ]);
    // The four stale-but-valid controls are invisible to the schema; that is
    // the whole reason the executable authority exists.
    expect(observed.slice(1, 5).map(({ schema }) => schema)).toEqual([0, 0, 0, 0]);
    expect(observed[6].executable).toEqual([["consent-authorization-mutation-provenance-mismatch", "candidateHead"]]);
    expect(observed[6].schema).toBeGreaterThan(0);
    expect(observed[7].executable).toEqual([["consent-authorization-mutation-provenance-missing", "analyzedTree"]]);
    expect(observed[7].schema).toBeGreaterThan(0);
    expect(consentAuthorizationReceiptProvenanceFields).toHaveLength(5);

    // Aggregate-level: a stale aggregate, a receipt that disagrees with an
    // otherwise fresh aggregate, and a receipt the aggregate does not bind.
    const fresh = receiptFor(live);
    expect(
      collectMutationAggregateViolations(aggregateFor(live, [fresh]), enumerationFor([fresh]), {
        expectedProvenance: live,
        receipts: [fresh],
      }),
    ).toEqual([]);

    const staleAggregate = collectMutationAggregateViolations(
      aggregateFor({ ...live, candidateHead: staleProvenanceSha }, [fresh]),
      enumerationFor([fresh]),
      { expectedProvenance: live, receipts: [fresh] },
    );
    expect(staleAggregate.map(({ code, scope }) => [code, scope]).toSorted()).toEqual([
      ["consent-authorization-mutation-provenance-mismatch", "aggregate"],
      ["consent-authorization-mutation-provenance-mismatch", "receipt:MUT-PROBE/aggregate"],
    ]);

    const staleReceipt = receiptFor({ ...live, analyzedTree: staleProvenanceSha });
    expect(
      collectMutationAggregateViolations(aggregateFor(live, [staleReceipt]), enumerationFor([staleReceipt]), {
        expectedProvenance: live,
        receipts: [staleReceipt],
      })
        .map(({ code, scope }) => [code, scope])
        .toSorted(),
    ).toEqual([
      ["consent-authorization-mutation-provenance-mismatch", "receipt:MUT-PROBE"],
      ["consent-authorization-mutation-provenance-mismatch", "receipt:MUT-PROBE/aggregate"],
    ]);

    expect(
      collectMutationAggregateViolations(aggregateFor(live, [receiptFor(live)]), enumerationFor([fresh]), {
        expectedProvenance: live,
        receipts: [{ ...fresh, command: "an unbound rewrite" }],
      }).map(({ code }) => code),
    ).toEqual(["consent-authorization-mutation-receipt-digest-mismatch"]);
  });

  it("proves the executed guard, and rejects a mutant whose own guard is still nonzero", () => {
    const { candidate, mutant, priorMutant, priorRewrote, mutantRewrote, acceptanceClauseId } = executedPartitionNarrow;
    process.stdout.write(
      `executed-partition-narrow=${JSON.stringify({ acceptanceClauseId, candidate, mutant, priorMutant })}\n`,
    );
    expect(mutantRewrote).toBe(true);
    expect(priorRewrote).toBe(true);
    expect(acceptanceClauseId).toBe(consentAuthorizationClauseByCode["consent-authorization-site-unregistered"]);

    // The corrected candidate stays red for the seventh site, and the clause it
    // first fails at is read back off the finished process.
    expect(candidate.guardExitCode).toBe(1);
    expect(candidate.guardViolationCodes).toContain("consent-authorization-site-unregistered");
    expect(candidate.guardFirstFailingClauseId).toBe("reconciliation.observed-completeness");
    expect(candidate.acceptanceExitCode).toBe(0);
    expect(candidate.acceptanceResult).toBe("pass");
    expect(candidate.acceptanceFirstFailingClauseId).toBe("");

    // The one-rewrite bypass mutant's own guard is green -- no clause is
    // reached at all -- so the unchanged acceptance test is red at the intended
    // clause rather than at a later one.
    expect(mutant.guardExitCode).toBe(0);
    expect(mutant.guardViolationCodes).toEqual([]);
    expect(mutant.guardFirstFailingClauseId).toBe("");
    expect(mutant.acceptanceExitCode).toBeGreaterThan(0);
    expect(mutant.acceptanceResult).toBe("fail");
    expect(mutant.acceptanceFirstFailingClauseId).toBe("reconciliation.observed-completeness");
    expect(assertExecutedMutantBypasses(partitionNarrowCaseId, mutant)).toBe(mutant);

    // The rewrite this case carried before the repair disabled one clause and
    // left the rest of the partition's consumers intact: its guard is still
    // nonzero, at a later clause, so the harness refuses it.
    expect(priorMutant.guardExitCode).toBe(1);
    expect(priorMutant.guardViolationCodes).not.toContain("consent-authorization-site-unregistered");
    expect(priorMutant.guardViolationCodes).toContain("consent-authorization-partition-drift");
    expect(priorMutant.guardFirstFailingClauseId).toBe("reconciliation.partition-digest");
    expect(() => assertExecutedMutantBypasses(partitionNarrowCaseId, priorMutant)).toThrow(
      /mutant guard still exits 1 at reconciliation\.partition-digest/,
    );

    // Every code the guard can report names the clause it is decided at, so a
    // first failing clause is always readable off a run.
    expect(Object.values(consentAuthorizationClauseByCode).every((clause) => clause.includes("."))).toBe(true);
    expect(realTreeResult.violations).toEqual([]);
    expect(driftResult.violations.every(({ clause }) => typeof clause === "string" && clause.length > 0)).toBe(true);
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
    censusCoverage: {
      path: consentAuthorizationCensusCoveragePath,
      sha256: repoFileSha256(consentAuthorizationCensusCoveragePath),
      rows: censusCoverage.rows.length,
      classified: consentAuthorizationCoverageCounts(censusCoverage).classified,
      declaredOpen: consentAuthorizationCoverageCounts(censusCoverage)["declared-open"],
      silentByDesign: consentAuthorizationCoverageCounts(censusCoverage)["silent-by-design"],
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
  // The provenance authority runs over the aggregate and over every receipt it
  // binds, against the live analysis rather than against anything committed.
  expect(
    collectMutationAggregateViolations(aggregate, enumeration, {
      expectedProvenance: deriveConsentAuthorizationReceiptProvenance(realTreeResult),
      receipts,
    }),
  ).toEqual([]);
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
