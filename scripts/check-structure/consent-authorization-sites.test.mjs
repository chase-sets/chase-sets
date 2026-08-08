import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  consentAuthorizationSpecifierRuntimeUnknownArm,
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
const mutationEvidencePath = "scripts/check-structure/consent-authorization-mutation-evidence.mjs";
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

const batteryWorkUnits = {
  fullTreeAnalyses: 0,
  scratchCorpusAnalyses: 0,
  scratchRepositoryConstructions: 0,
  uniqueCandidateAnalyzerModuleImports: 0,
  analyzerSourceRewriteModuleImports: 0,
  executedGuardNodeSubprocesses: 0,
  totalChildProcessSpawns: 0,
  reconciliationGitLsFilesSpawns: 0,
  compilerSurfaceSourceParses: 0,
  trackedFilesDigested: 0,
};

const batteryWorkUnitCeilings = Object.freeze({
  fullTreeAnalyses: 1,
  scratchCorpusAnalyses: 15,
  scratchRepositoryConstructions: 14,
  uniqueCandidateAnalyzerModuleImports: 0,
  analyzerSourceRewriteModuleImports: 0,
  executedGuardNodeSubprocesses: 0,
  totalChildProcessSpawns: 408,
  reconciliationGitLsFilesSpawns: 3,
  compilerSurfaceSourceParses: 7,
  trackedFilesDigested: 111,
});

const committedTotalChildProcessSpawnsByEnvironment = Object.freeze({
  plain: 344,
  "pull-request-merge-ref": 345,
  "merge-group": 342,
});

const committedProvenanceGitSpawnsByEnvironment = Object.freeze({
  plain: 11,
  "pull-request-merge-ref": 13,
  "merge-group": 10,
});

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

function rawGit(cwd) {
  return (args, options = {}) =>
    execFileSync("git", args, {
      cwd,
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 1024,
      ...options,
    });
}

function countGit(delegate, counter = batteryWorkUnits, recordInvocation = null) {
  return (args, options = {}) => {
    const before = counter.totalChildProcessSpawns;
    counter.totalChildProcessSpawns += 1;
    const result = delegate(args, options);
    recordInvocation?.({ args, before, after: counter.totalChildProcessSpawns });
    return result;
  };
}

function runCountedChildProcess(file, args, options) {
  batteryWorkUnits.totalChildProcessSpawns += 1;
  return execFileSync(file, args, options);
}

function analyzeWithWorkUnitMeter(options = {}) {
  const analysisRoot = path.resolve(options.repoRoot ?? repoRoot);
  const authorityRoot = path.resolve(options.authorityRoot ?? repoRoot);
  if (analysisRoot === path.resolve(repoRoot)) batteryWorkUnits.fullTreeAnalyses += 1;
  else batteryWorkUnits.scratchCorpusAnalyses += 1;
  const countedExecGit = countGit(options.execGit ?? rawGit(analysisRoot));
  const countedExecAuthorityGit = countGit(
    options.execAuthorityGit ?? rawGit(authorityRoot),
    batteryWorkUnits,
    options.recordAuthorityGitInvocation,
  );
  const suppliedDerivation = options.deriveProvenance;
  return analyzeConsentAuthorizationSites({
    ...options,
    execGit: countedExecGit,
    execAuthorityGit: countedExecAuthorityGit,
    deriveProvenance: suppliedDerivation
      ? () => suppliedDerivation(countedExecGit)
      : () => deriveGuardCandidateProvenance({ execGit: (args) => countedExecGit(args) }),
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const registry = loadConsentAuthorizationRegistry();
const registrySchema = loadConsentAuthorizationRegistrySchema();
const censusCoverage = loadConsentAuthorizationCensusCoverage();
const censusCoverageSchema = loadConsentAuthorizationCensusCoverageSchema();
let directlyCalledAnalyzerExportSpawnEvidence = null;
let directExecFileSyncSpawnEvidence = null;
const censusFixtureFiles = listConsentAuthorizationCensusFixtures({
  repoRoot,
  execGit: countGit(rawGit(repoRoot), batteryWorkUnits, (evidence) => {
    directlyCalledAnalyzerExportSpawnEvidence = evidence;
  }),
});
const derivedCoverageAxes = deriveConsentAuthorizationCoverageAxes();
const derivedCensusArms = deriveConsentAuthorizationCensusArms();
const enumeration = loadConsentAuthorizationCaseEnumeration();
const enumerationSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-case-enumeration-v1.schema.json`);
const receiptSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-mutation-v1.schema.json`);
const aggregateSchema = readJsonFixture(`${fixtureRoot}/consent-authorization-mutation-aggregate-v1.schema.json`);
const evidenceReceipt = readJsonFixture("scripts/check-structure/consent-authorization-evidence-receipt.json");
Object.assign(batteryWorkUnits, evidenceReceipt.digestBound.workUnits);
const ownerContexts = loadTypeScriptOwnerContextArtifact();
const ownerContextPartition = loadTypeScriptOwnerContextPartition();
const ownerContextSchema = loadTypeScriptOwnerContextSchema();
const provenanceFixtures = {
  plain: readJsonFixture(`${provenanceFixtureRoot}/plain.json`),
  "pull-request-merge-ref": readJsonFixture(`${provenanceFixtureRoot}/pull-request-merge-ref.json`),
  "merge-group": readJsonFixture(`${provenanceFixtureRoot}/merge-group.json`),
};

let authoritySideListingSpawnEvidence = null;
const realTreeResult = deepFreeze(
  analyzeWithWorkUnitMeter({
    repoRoot,
    recordAuthorityGitInvocation: (evidence) => {
      authoritySideListingSpawnEvidence = evidence;
    },
  }),
);
const realTreeResultDigest = sha256(JSON.stringify(realTreeResult));
const committedBatteryWorkUnits = Object.freeze({
  fullTreeAnalyses: 1,
  scratchCorpusAnalyses: 15,
  scratchRepositoryConstructions: 14,
  uniqueCandidateAnalyzerModuleImports: 0,
  analyzerSourceRewriteModuleImports: 0,
  executedGuardNodeSubprocesses: 0,
  totalChildProcessSpawns: committedTotalChildProcessSpawnsByEnvironment[realTreeResult.environment],
  ...evidenceReceipt.digestBound.workUnits,
});
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
  return runCountedChildProcess("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function scratchExecGit(scratch) {
  return rawGit(scratch);
}

function initScratchRepo(prefix) {
  batteryWorkUnits.scratchRepositoryConstructions += 1;
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
  return (execGit = scratchExecGit(scratch)) => deriveGuardCandidateProvenance({ env: {}, execGit });
}

function analyzeScratch(scratch, overrides = {}, module = null) {
  if (module !== null) throw new Error("scratch analyzer-module imports belong to the offline evidence entrypoint");
  const analyze = (module ?? { analyzeConsentAuthorizationSites }).analyzeConsentAuthorizationSites;
  if (analyze !== analyzeConsentAuthorizationSites) {
    registerAnalyzerModuleImport("candidate");
  }
  return analyzeWithWorkUnitMeter({
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
    deriveProvenance: (execGit = scratchExecGit(scratch)) =>
      deriveGuardCandidateProvenance({
        env: { GITHUB_EVENT_NAME: "pull_request" },
        execGit: (args) => execGit(args),
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
    deriveProvenance: (execGit = scratchExecGit(scratch)) =>
      deriveGuardCandidateProvenance({
        env: { GITHUB_EVENT_NAME: "merge_group" },
        execGit: (args) => execGit(args),
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
  return analyzeWithWorkUnitMeter({
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
  const execGit = countGit((args, options) => {
    calls.push(args.join(" "));
    return scratchExecGit(scratch)(args, options);
  });
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
 * source, and is outside the committed mutation ledger: its only job is to
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
  const workUnitsBefore = {
    corpusAnalyses: batteryWorkUnits.fullTreeAnalyses + batteryWorkUnits.scratchCorpusAnalyses,
    filesystemMaterializations: batteryWorkUnits.scratchRepositoryConstructions,
  };
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
  const workUnits = {
    corpusAnalyses:
      batteryWorkUnits.fullTreeAnalyses + batteryWorkUnits.scratchCorpusAnalyses - workUnitsBefore.corpusAnalyses,
    filesystemMaterializations:
      batteryWorkUnits.scratchRepositoryConstructions - workUnitsBefore.filesystemMaterializations,
  };
  return {
    rowId,
    fixture,
    remainingRows: withoutRow.rows.length,
    remainingFixtures: withoutFixture.length,
    code: failure?.code ?? (rowViolations.length > 0 ? "consent-authorization-coverage-invalid" : null),
    firstClause: failure?.reachedClause ?? (rowViolations.length > 0 ? "coverage.committed-rows" : null),
    survived: failure === null && rowViolations.length === 0,
    workUnits,
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
  const args = [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "scripts/check-structure/consent-authorization-*",
    `${fixtureRoot}`,
  ];
  const before = batteryWorkUnits.totalChildProcessSpawns;
  const listed = runCountedChildProcess("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  directExecFileSyncSpawnEvidence = {
    args,
    before,
    after: batteryWorkUnits.totalChildProcessSpawns,
  };
  return listed.split("\0").filter(Boolean).sort();
}

function scanFixture(relativePath) {
  return scanConsentAuthorizationSource(relativePath, repoFile(relativePath), ownerContexts);
}

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

function mutationEvidenceCaseIds(source) {
  const sourceFile = ts.createSourceFile(mutationEvidencePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let caseIds = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "mutationEvidenceCases" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      caseIds = node.initializer.elements.map((entry) => {
        if (
          !ts.isCallExpression(entry) ||
          !ts.isIdentifier(entry.expression) ||
          entry.expression.text !== "mutationCase" ||
          !entry.arguments[0] ||
          !ts.isStringLiteral(entry.arguments[0])
        ) {
          throw new Error("the offline mutation case list must contain only mutationCase calls with literal ids");
        }
        return entry.arguments[0].text;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (caseIds === null) throw new Error("the offline mutation case list was not found");
  return caseIds;
}

function collectOfflineEnumerationViolations(caseIds, committedEnumeration) {
  const observed = new Set(caseIds);
  const committed = new Set(committedEnumeration.cases);
  return [
    ...[...committed]
      .filter((caseId) => !observed.has(caseId))
      .map((caseId) => ({
        code: "consent-authorization-enumeration-case-missing",
        caseId,
      })),
    ...[...observed]
      .filter((caseId) => !committed.has(caseId))
      .map((caseId) => ({
        code: "consent-authorization-enumeration-case-unauthorized",
        caseId,
      })),
  ];
}

function batteryWorkUnitReceipt(actual, committed = committedBatteryWorkUnits) {
  return Object.fromEntries(
    Object.keys(batteryWorkUnitCeilings).map((name) => [
      name,
      { committed: committed[name], ceiling: batteryWorkUnitCeilings[name], observed: actual[name] },
    ]),
  );
}

function collectBatteryWorkUnitViolations(actual, committed = committedBatteryWorkUnits) {
  return Object.entries(batteryWorkUnitReceipt(actual, committed)).flatMap(([name, reading]) => {
    const violations = [];
    if (reading.committed > reading.ceiling) violations.push(`${name}: committed value exceeds issue ceiling`);
    if (reading.observed !== reading.committed) violations.push(`${name}: observed value differs from committed value`);
    return violations;
  });
}

function isolatedCounter() {
  return { totalChildProcessSpawns: 0 };
}

function collectSpawnMeterControlViolations(controls) {
  return Object.entries(controls).flatMap(([name, evidence]) =>
    evidence !== null && evidence.after - evidence.before === 1
      ? []
      : [`${name}: counting wrapper did not meter one spawn`],
  );
}

function assertRealSpawnMeterControls() {
  const realSpawnMeterControls = {
    "authority-side listing": authoritySideListingSpawnEvidence,
    "direct execFileSync": directExecFileSyncSpawnEvidence,
    "directly-called analyzer export": directlyCalledAnalyzerExportSpawnEvidence,
  };
  expect(realSpawnMeterControls["authority-side listing"]?.args).toEqual([
    "ls-files",
    "-z",
    "--",
    consentAuthorizationCensusFixtureRoot,
  ]);
  expect(realSpawnMeterControls["direct execFileSync"]?.args).toEqual([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "scripts/check-structure/consent-authorization-*",
    fixtureRoot,
  ]);
  expect(realSpawnMeterControls["directly-called analyzer export"]?.args).toEqual([
    "ls-files",
    "-z",
    "--",
    consentAuthorizationCensusFixtureRoot,
  ]);
  expect(collectSpawnMeterControlViolations(realSpawnMeterControls)).toEqual([]);

  for (const [name, evidence] of Object.entries(realSpawnMeterControls)) {
    const withoutCountingWrapper = {
      ...realSpawnMeterControls,
      [name]: evidence === null ? null : { ...evidence, after: evidence.before },
    };
    expect(collectSpawnMeterControlViolations(withoutCountingWrapper)).toEqual([
      `${name}: counting wrapper did not meter one spawn`,
    ]);
  }
}

function registerAnalyzerModuleImport(kind, counter = batteryWorkUnits) {
  if (kind === "candidate") counter.uniqueCandidateAnalyzerModuleImports += 1;
  else if (kind === "source-rewrite") counter.analyzerSourceRewriteModuleImports += 1;
  else throw new Error(`unknown analyzer module import kind: ${kind}`);
}

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
        return runCountedChildProcess("git", ["grep", "-n", salvageBaseSha, "--", ...paths], {
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
    const gitOut = (args) => runCountedChildProcess("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
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
      ["key-shadowed-lexical-constant-element-access", "Identifier", "classified", "classified", null],
      ["key-shadowed-lexical-constant-template-element-access", "TemplateExpression", "classified", "classified", null],
      ["key-computed-binding-element-over-lexical-constant", "Identifier", "classified", "classified", null],
      ["key-computed-binding-element-over-constant-template", "TemplateExpression", "classified", "classified", null],
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
    expect(
      candidateDeletionReceipt.trials.every(
        ({ workUnits }) => workUnits.corpusAnalyses === 0 && workUnits.filesystemMaterializations === 0,
      ),
    ).toBe(true);

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
    expect(
      legacyDeletionReceipt.trials.every(
        ({ workUnits }) => workUnits.corpusAnalyses === 0 && workUnits.filesystemMaterializations === 0,
      ),
    ).toBe(true);
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

  it("classifies every formerly declared-open row and leaves both silent rows silent", () => {
    const formerlyOpenRowIds = [
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
    ];
    const classified = censusCoverage.rows.filter(({ rowId }) => formerlyOpenRowIds.includes(rowId));
    const silent = censusCoverage.rows.filter(({ disposition }) => disposition === "silent-by-design");
    process.stdout.write(
      `formerly-open-rows=${JSON.stringify({
        classified: classified.map(({ rowId, arm, census, owner }) => ({ rowId, arm, census, owner })),
        silent: silent.map(({ rowId, arm, census }) => ({ rowId, arm: arm ?? null, census })),
      })}\n`,
    );

    expect(classified).toHaveLength(10);
    expect(classified.map(({ rowId }) => rowId).toSorted()).toEqual(formerlyOpenRowIds.toSorted());
    expect(
      classified.every(
        ({ disposition, census, owner }) =>
          disposition === "classified" && census === "classified" && owner === undefined,
      ),
    ).toBe(true);
    expect(censusCoverage.rows.filter(({ disposition }) => disposition === "declared-open")).toEqual([]);
    expect(consentAuthorizationDeclaredOpenOwner).toBe("#6493");

    expect(silent.map(({ rowId, census }) => [rowId, census]).toSorted()).toEqual([
      ["key-unrelated-constructor-like-string", "silent"],
      ["specifier-runtime-unknown", "admitted-unknown"],
    ]);

    // Observed live, not asserted about: every successor-owned shape is still
    // admitted as an unknown, and the silent-by-design key shape still emits
    // nothing at all.
    const observed = [...classified, ...silent].map((row) => ({
      rowId: row.rowId,
      census: observeConsentAuthorizationCoverageRow(row, repoFile(row.fixture), ownerContexts).census,
    }));
    expect(observed).toEqual([...classified, ...silent].map(({ rowId, census }) => ({ rowId, census })));
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

  it("resolves a constant key against its nearest lexical binding", () => {
    const references = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/sibling-scope-keys.ts",
      repoFile(`${fixtureRoot}/references/sibling-scope-keys.ts`),
      ownerContexts,
    ).filter(({ referenceClass }) => referenceClass === "unexpected");
    expect(references.map(({ constructor }) => constructor).toSorted()).toEqual([
      "authorizeConsentForActor",
      "authorizeConsentForProvisioning",
    ]);
  });

  it("lets an inner binding shadow an outer binding of the same name", () => {
    const references = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/nested-shadowing-key.ts",
      repoFile(`${fixtureRoot}/references/nested-shadowing-key.ts`),
      ownerContexts,
    );
    expect(
      references.filter(
        ({ line, referenceClass, constructor }) =>
          line === 5 && referenceClass === "unexpected" && constructor === "authorizeConsentForActor",
      ),
    ).toHaveLength(1);
  });

  it("resolves a transitive alias in its declaration environment", () => {
    const references = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/nested-shadowing-key.ts",
      repoFile(`${fixtureRoot}/references/nested-shadowing-key.ts`),
      ownerContexts,
    );
    const classified = references.filter(({ referenceClass }) => referenceClass === "unexpected");
    expect(classified.map(({ constructor }) => constructor)).toEqual([
      "authorizeConsentForActor",
      "authorizeConsentForProvisioning",
      "authorizeConsentForProvisioning",
    ]);
    expect(
      references.filter(
        ({ referenceClass, axis, arm }) =>
          referenceClass === "admitted-unknown" && axis === "key" && arm === consentAuthorizationKeyRuntimeUnknownArm,
      ),
    ).toHaveLength(1);
  });

  it("stays silent when the nearest binding is not a single constant string", () => {
    for (const fixture of ["non-const-binding-key.ts", "duplicate-same-scope-binding-key.ts"]) {
      const references = scanConsentAuthorizationSource(
        `zz-unrelated/plain-directory/${fixture}`,
        repoFile(`${fixtureRoot}/references/${fixture}`),
        ownerContexts,
      );
      expect(references.filter(({ referenceClass }) => referenceClass !== "admitted-unknown")).toEqual([]);
      expect(
        references.filter(({ referenceClass, axis }) => referenceClass === "admitted-unknown" && axis === "key"),
      ).toHaveLength(1);
    }
  });

  for (const [name, rowId, constructor] of [
    [
      "classifies a shadowed constant key as an unclassified reference",
      "key-shadowed-lexical-constant-element-access",
      "authorizeConsentForActor",
    ],
    [
      "classifies a shadowed template key as an unclassified reference",
      "key-shadowed-lexical-constant-template-element-access",
      "authorizeConsentForActor",
    ],
    [
      "classifies a computed binding-element key over a lexical constant",
      "key-computed-binding-element-over-lexical-constant",
      "authorizeConsentForActor",
    ],
    [
      "classifies a computed binding-element template key",
      "key-computed-binding-element-over-constant-template",
      "authorizeConsentForActor",
    ],
  ]) {
    it(name, () => {
      const row = censusCoverage.rows.find((entry) => entry.rowId === rowId);
      const references = scanConsentAuthorizationSource(row.plantedAt, repoFile(row.fixture), ownerContexts);
      expect(
        references.filter(
          ({ referenceClass, constructor: observed, arm }) =>
            referenceClass === "unexpected" && observed === constructor && arm === row.arm,
        ),
      ).toHaveLength(1);
    });
  }

  it("stays silent for an unrelated resolved key", () => {
    const references = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/unrelated-resolved-key.ts",
      'const key = "authorizeConsentForNobody";\nauthorization[key](context);\n',
      ownerContexts,
    );
    expect(references).toEqual([]);
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

  // Acquisition arity is not part of the census grammar. Both forms accept
  // trailing arguments -- `import(specifier, options)` carries an
  // import-attributes bag and `require(specifier, extra)` is ordinary
  // JavaScript -- and neither changes which module the first specifier reaches.
  // An arity-exact gate would drop a canonical acquisition out of the census
  // entirely while its one-argument twin stayed classified, so each form is
  // pinned to the identical class and arm at both arities.
  it("classifies canonical acquisition identically with and without trailing arguments", () => {
    const canonicalSpecifier =
      "../../bounded-contexts/identity/features/consents/domain/consent-recording-authorization";
    const acquire = (source) =>
      scanConsentAuthorizationSource("zz-unrelated/plain-directory/acquisition-arity.ts", source, ownerContexts).map(
        ({ referenceClass, form, axis, arm }) => ({ referenceClass, form, axis, arm }),
      );

    const canonicalDynamicImport = {
      referenceClass: "noncanonical-module-access",
      form: "dynamic-import",
      axis: "specifier",
      arm: "dynamic-import:string-literal",
    };
    const canonicalRequire = { ...canonicalDynamicImport, form: "require", arm: "require:string-literal" };

    expect(acquire(`export const probe = () => import("${canonicalSpecifier}");`)).toEqual([canonicalDynamicImport]);
    expect(acquire(`export const probe = () => import("${canonicalSpecifier}", { with: {} });`)).toEqual([
      canonicalDynamicImport,
    ]);
    expect(acquire(`export const probe = require("${canonicalSpecifier}");`)).toEqual([canonicalRequire]);
    expect(acquire(`export const probe = require("${canonicalSpecifier}", { paths: [] });`)).toEqual([
      canonicalRequire,
    ]);

    // The residual arm is unchanged in both arities: an unrelated runtime
    // specifier owes this guard nothing, so it stays a counted admitted unknown
    // rather than becoming a violation or disappearing from the census.
    const runtimeUnknown = {
      referenceClass: "admitted-unknown",
      form: "require",
      axis: "specifier",
      arm: consentAuthorizationSpecifierRuntimeUnknownArm,
    };
    expect(acquire("export const probe = (request) => require(request.specifier);")).toEqual([runtimeUnknown]);
    expect(acquire("export const probe = (request) => require(request.specifier, { paths: [] });")).toEqual([
      runtimeUnknown,
    ]);
  });

  for (const [name, rowIds] of [
    [
      "classifies a template-literal canonical module acquisition",
      ["specifier-no-substitution-template-dynamic-import", "specifier-no-substitution-template-require"],
    ],
    [
      "classifies a lexical-constant canonical module acquisition",
      ["specifier-lexical-constant-dynamic-import", "specifier-lexical-constant-require"],
    ],
    [
      "classifies a concatenated canonical module acquisition",
      ["specifier-constant-concatenation-dynamic-import", "specifier-constant-concatenation-require"],
    ],
  ]) {
    it(name, () => {
      for (const rowId of rowIds) {
        const row = censusCoverage.rows.find((entry) => entry.rowId === rowId);
        const references = scanConsentAuthorizationSource(row.plantedAt, repoFile(row.fixture), ownerContexts);
        expect(
          references.filter(
            ({ referenceClass, form, arm }) =>
              referenceClass === "noncanonical-module-access" && form === row.signature.form && arm === row.arm,
          ),
        ).toHaveLength(1);
      }
    });
  }

  it("stays silent for an equivalent unrelated module acquisition", () => {
    for (const fixture of ["unrelated-module-dynamic-import.ts", "unrelated-module-require.ts"]) {
      expect(
        scanConsentAuthorizationSource(
          `zz-unrelated/plain-directory/${fixture}`,
          repoFile(`${fixtureRoot}/references/${fixture}`),
          ownerContexts,
        ),
      ).toEqual([]);
    }
  });

  it("admits a substituted template specifier as a runtime unknown", () => {
    const references = scanConsentAuthorizationSource(
      "zz-unrelated/plain-directory/substituted-template-specifier.ts",
      [
        'const target = "consent-recording-authorization";',
        "export const probe = import(`../../bounded-contexts/identity/features/consents/domain/${target}`);",
      ].join("\n"),
      ownerContexts,
    );
    expect(
      references.map(({ referenceClass, axis, arm, syntaxKind }) => ({ referenceClass, axis, arm, syntaxKind })),
    ).toEqual([
      {
        referenceClass: "admitted-unknown",
        axis: "specifier",
        arm: consentAuthorizationSpecifierRuntimeUnknownArm,
        syntaxKind: "TemplateExpression",
      },
    ]);
  });

  it("counts and publishes admitted-unknown module acquisitions without failing", () => {
    const row = censusCoverage.rows.find(({ rowId }) => rowId === "specifier-runtime-unknown");
    const references = scanConsentAuthorizationSource(row.plantedAt, repoFile(row.fixture), ownerContexts);
    const admitted = references.filter(
      ({ referenceClass, axis }) => referenceClass === "admitted-unknown" && axis === "specifier",
    );
    process.stdout.write(`admitted-unknown-specifier-control=${JSON.stringify(admitted)}\n`);
    expect(admitted).toHaveLength(1);
    expect(admitted[0].arm).toBe(consentAuthorizationSpecifierRuntimeUnknownArm);
    expect(references.filter(({ referenceClass }) => referenceClass !== "admitted-unknown")).toEqual([]);
  });

  it("records the admitted-unknown census as provenance and never as an expectation", () => {
    const suite = ts.createSourceFile(suitePath, repoFile(suitePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const frozenComparisons = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["toBe", "toEqual", "toStrictEqual"].includes(node.expression.name.text) &&
        ts.isCallExpression(node.expression.expression) &&
        ts.isIdentifier(node.expression.expression.expression) &&
        node.expression.expression.expression.text === "expect" &&
        node.expression.expression.arguments[0]?.getText(suite).includes("realTreeResult.census.admittedUnknown")
      ) {
        frozenComparisons.push(node.getText(suite));
      }
      ts.forEachChild(node, visit);
    };
    visit(suite);
    expect(frozenComparisons).toEqual([]);
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
      classified: 32,
      "declared-open": 0,
      "silent-by-design": 2,
    });
    expect(censusCoverage.rows.filter(({ disposition }) => disposition === "declared-open")).toEqual([]);
    expect(
      censusCoverage.rows
        .filter(({ disposition }) => disposition !== "declared-open")
        .every(({ owner }) => owner === undefined),
    ).toBe(true);

    expect(matrix.filter(({ disposition }) => disposition === "classified")).toHaveLength(32);
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
    const otherEnvironment = receiptSchema.properties.provenance.properties.environment.enum.find(
      (environment) => environment !== live.environment,
    );
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
      { name: "other environment", provenance: { ...live, environment: otherEnvironment } },
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

  it("matches the offline evidence module against the committed case enumeration", () => {
    const caseIds = mutationEvidenceCaseIds(repoFile(mutationEvidencePath));
    expect(caseIds).toHaveLength(39);
    expect(collectOfflineEnumerationViolations(caseIds, enumeration)).toEqual([]);

    const missing = collectOfflineEnumerationViolations(caseIds.slice(1), enumeration);
    expect(missing).toEqual([{ code: "consent-authorization-enumeration-case-missing", caseId: caseIds[0] }]);

    const unauthorizedId = "MUT-SYNTHETIC-UNAUTHORIZED";
    const unauthorized = collectOfflineEnumerationViolations([...caseIds, unauthorizedId], enumeration);
    expect(unauthorized).toEqual([
      { code: "consent-authorization-enumeration-case-unauthorized", caseId: unauthorizedId },
    ]);
  });

  it("asserts the committed battery work-unit budget from instrumented counters", () => {
    const receipt = batteryWorkUnitReceipt(batteryWorkUnits);
    process.stdout.write(`consent-authorization-work-units=${JSON.stringify(receipt)}\n`);
    process.stdout.write(
      `consent-authorization-total-spawn-classes=${JSON.stringify(committedTotalChildProcessSpawnsByEnvironment)}\n`,
    );
    assertRealSpawnMeterControls();
    expect(collectBatteryWorkUnitViolations(batteryWorkUnits)).toEqual([]);
    expect(Object.values(committedTotalChildProcessSpawnsByEnvironment).every((value) => value <= 408)).toBe(true);
    expect(sha256(JSON.stringify(realTreeResult))).toBe(realTreeResultDigest);
    expect(Object.isFrozen(realTreeResult)).toBe(true);

    const widened = {
      ...committedBatteryWorkUnits,
      totalChildProcessSpawns: committedBatteryWorkUnits.totalChildProcessSpawns + 1,
    };
    expect(collectBatteryWorkUnitViolations(batteryWorkUnits, widened)).toContain(
      "totalChildProcessSpawns: observed value differs from committed value",
    );

    const importControl = structuredClone(batteryWorkUnits);
    registerAnalyzerModuleImport("source-rewrite", importControl);
    expect(collectBatteryWorkUnitViolations(importControl)).toContain(
      "analyzerSourceRewriteModuleImports: observed value differs from committed value",
    );

    for (const [environment, expectedSpawns] of Object.entries(committedProvenanceGitSpawnsByEnvironment)) {
      const provenanceCounter = isolatedCounter();
      const fixture = provenanceFixtures[environment];
      const provenance = deriveGuardCandidateProvenance({
        env: fixture.env,
        execGit: countGit(scriptedExecGit(fixture.gitResponses), provenanceCounter),
        readEventPayload: () => (fixture.eventPayload === null ? "{}" : JSON.stringify(fixture.eventPayload)),
      });
      expect(provenance.roles.landingCandidate.sha).toBe(fixture.expected.roles.landingCandidate.sha);
      expect(provenanceCounter.totalChildProcessSpawns).toBe(expectedSpawns);
    }
  });
});
