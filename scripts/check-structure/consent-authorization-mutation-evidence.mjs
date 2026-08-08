import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";

export const provenanceFixtureRoot = "scripts/check-structure/fixtures/guard-candidate-provenance";
let exportedMutationEvidenceCases = [];
export { exportedMutationEvidenceCases as mutationEvidenceCases };
export let executeConsentAuthorizationMutationEvidence;
export let collectCommitShaLiteralEqualities;
export let collectAnalyzerExpectationOrigins;

const evidenceModulePath = "scripts/check-structure/consent-authorization-mutation-evidence.mjs";
const evidenceReceiptPath = "scripts/check-structure/consent-authorization-evidence-receipt.json";
const evidenceReceiptSchemaPath = "scripts/check-structure/consent-authorization-evidence-receipt.schema.json";
const evidenceAnalyzerPath = "scripts/check-structure/consent-authorization-sites.mjs";
const evidenceCompilerShimRoot = "packages/typescript-compiler-api";
const evidenceVerifierOnly =
  new URL(import.meta.url).searchParams.has("receipt-verifier") ||
  globalThis.__CHASE_SETS_CONSENT_AUTHORIZATION_RECEIPT_VERIFIER__ === true;

export const consentAuthorizationEvidenceFailureCodes = Object.freeze({
  stale: "consent-authorization-evidence-receipt-stale",
  malformed: "consent-authorization-evidence-receipt-malformed",
  tampered: "consent-authorization-evidence-receipt-tampered",
  enumeration: "consent-authorization-evidence-enumeration-mismatch",
  inventory: "consent-authorization-evidence-inventory-mismatch",
});

export const consentAuthorizationEvidenceWorkUnitCeilings = Object.freeze({
  reconciliationGitLsFilesSpawns: 3,
  compilerSurfaceSourceParses: 7,
  trackedFilesDigested: 105,
});

export class ConsentAuthorizationEvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ConsentAuthorizationEvidenceError";
    this.code = code;
    this.details = details;
  }
}

function throwEvidence(code, message, details = {}) {
  throw new ConsentAuthorizationEvidenceError(code, message, details);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalConsentAuthorizationEvidence(value) {
  return JSON.stringify(canonicalValue(value));
}

function evidenceSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepositoryPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sourceFileFor(relativePath, bytes, workUnits) {
  workUnits.compilerSurfaceSourceParses += 1;
  return ts.createSourceFile(relativePath, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function exportedCommittedPaths(sourceFile, trackedFiles) {
  const matches = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (!initializer || (!ts.isStringLiteral(initializer) && !ts.isNoSubstitutionTemplateLiteral(initializer)))
        continue;
      const candidate = normalizeRepositoryPath(initializer.text).replace(/\/$/, "");
      if (trackedFiles.has(candidate)) matches.add(candidate);
      for (const trackedFile of trackedFiles) {
        if (trackedFile.startsWith(`${candidate}/`)) matches.add(trackedFile);
      }
    }
  }
  return matches;
}

function staticModuleSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function resolveTrackedModule(importer, specifier, trackedFiles) {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith("@chase-sets/")) {
    const packageName = specifier.slice("@chase-sets/".length);
    const candidate = `packages/${packageName}/index.mjs`;
    if (!trackedFiles.has(candidate)) {
      throwEvidence(
        consentAuthorizationEvidenceFailureCodes.inventory,
        `workspace import is not tracked: ${specifier}`,
      );
    }
    return candidate;
  }
  if (!specifier.startsWith(".")) return null;
  const unresolved = normalizeRepositoryPath(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [unresolved, `${unresolved}.mjs`, `${unresolved}.js`, `${unresolved}/index.mjs`];
  const resolved = candidates.find((candidate) => trackedFiles.has(candidate));
  if (!resolved) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.inventory,
      `relative import from ${importer} is not a tracked repository module: ${specifier}`,
    );
  }
  return resolved;
}

function isDeclaredConsentAuthorizationFootprint(relativePath, dataInputPaths) {
  if (relativePath === evidenceAnalyzerPath || relativePath === evidenceModulePath) return true;
  if (relativePath.startsWith("scripts/check-structure/fixtures/consent-authorization-sites/")) return true;
  if (relativePath.startsWith(`${provenanceFixtureRoot}/`)) return true;
  if (
    /^scripts\/check-structure\/consent-authorization-(?:site-registry|case-enumeration|census-coverage)(?:-v1\.schema)?\.json$/.test(
      relativePath,
    )
  ) {
    return true;
  }
  return dataInputPaths.has(relativePath);
}

export function deriveConsentAuthorizationEvidenceInventory({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  trackedFiles: suppliedTrackedFiles = null,
  readBytes = (relativePath) => readFileSync(path.join(rootDir, relativePath)),
  execGitLsFiles = () =>
    execFileSync("git", ["ls-files", "-z"], {
      cwd: rootDir,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  controls = {},
} = {}) {
  const workUnits = {
    reconciliationGitLsFilesSpawns: 0,
    compilerSurfaceSourceParses: 0,
    trackedFilesDigested: 0,
  };

  let trackedEntries;
  try {
    if (suppliedTrackedFiles === null) {
      workUnits.reconciliationGitLsFilesSpawns += 1;
      trackedEntries = execGitLsFiles().toString("utf8").split("\0").filter(Boolean);
    } else {
      trackedEntries = [...suppliedTrackedFiles];
    }
  } catch (error) {
    throwEvidence(consentAuthorizationEvidenceFailureCodes.inventory, "tracked-file enumeration failed", {
      cause: error?.message ?? String(error),
    });
  }

  const normalizedTracked = trackedEntries.map(normalizeRepositoryPath);
  const trackedFiles = new Set(normalizedTracked);
  if (
    trackedFiles.size !== normalizedTracked.length ||
    normalizedTracked.some((entry) => path.posix.isAbsolute(entry))
  ) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.inventory,
      "tracked-file enumeration is duplicate or non-relative",
    );
  }

  const sourceFiles = new Map();
  const importClosure = new Set();
  const queue = [evidenceAnalyzerPath, evidenceModulePath];
  try {
    while (queue.length > 0) {
      const relativePath = queue.shift();
      if (importClosure.has(relativePath)) continue;
      if (!trackedFiles.has(relativePath)) {
        throwEvidence(
          consentAuthorizationEvidenceFailureCodes.inventory,
          `import-closure member is not tracked: ${relativePath}`,
        );
      }
      const sourceFile = sourceFileFor(relativePath, readBytes(relativePath), workUnits);
      sourceFiles.set(relativePath, sourceFile);
      importClosure.add(relativePath);
      for (const specifier of staticModuleSpecifiers(sourceFile)) {
        const resolved = resolveTrackedModule(relativePath, specifier, trackedFiles);
        if (resolved !== null && !importClosure.has(resolved)) queue.push(resolved);
      }
    }

    if (controls.secondParsePath) {
      sourceFileFor(controls.secondParsePath, readBytes(controls.secondParsePath), workUnits);
    }
  } catch (error) {
    if (error instanceof ConsentAuthorizationEvidenceError) throw error;
    throwEvidence(consentAuthorizationEvidenceFailureCodes.inventory, "static import-closure derivation failed", {
      cause: error?.message ?? String(error),
    });
  }

  const dataInputPaths = new Set();
  for (const sourceFile of sourceFiles.values()) {
    for (const dataPath of exportedCommittedPaths(sourceFile, trackedFiles)) dataInputPaths.add(dataPath);
  }
  if (controls.suppressExportedRoot) {
    for (const relativePath of [...dataInputPaths]) {
      if (relativePath.startsWith(`${controls.suppressExportedRoot}/`)) dataInputPaths.delete(relativePath);
    }
  }

  const compilerShimFiles = new Set(
    [...trackedFiles].filter((entry) => entry.startsWith(`${evidenceCompilerShimRoot}/`)),
  );
  const declaredFootprint = new Set(
    [...trackedFiles].filter(
      (entry) =>
        entry !== evidenceReceiptPath &&
        entry !== evidenceReceiptSchemaPath &&
        entry !== "scripts/check-structure/consent-authorization-sites.test.mjs" &&
        entry !== "scripts/check-structure/consent-authorization-evidence-receipt.test.mjs" &&
        (entry.startsWith(`${evidenceCompilerShimRoot}/`) ||
          isDeclaredConsentAuthorizationFootprint(entry, dataInputPaths)),
    ),
  );
  const derivedPaths = new Set([...importClosure, ...dataInputPaths, ...compilerShimFiles, ...declaredFootprint]);
  derivedPaths.delete(evidenceReceiptPath);
  if (controls.suppressExportedRoot) {
    for (const relativePath of [...derivedPaths]) {
      if (relativePath.startsWith(`${controls.suppressExportedRoot}/`)) derivedPaths.delete(relativePath);
    }
  }
  for (const relativePath of controls.suppressInventoryPaths ?? []) derivedPaths.delete(relativePath);

  const untrackedDerived = [...derivedPaths].filter((entry) => !trackedFiles.has(entry)).toSorted();
  const missingDerived = [...declaredFootprint].filter((entry) => !derivedPaths.has(entry)).toSorted();
  if (untrackedDerived.length > 0 || missingDerived.length > 0) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.inventory,
      "derived inventory disagrees with tracked authority",
      {
        untrackedDerived,
        missingDerived,
      },
    );
  }

  const inventory = [];
  try {
    for (const relativePath of [...derivedPaths].toSorted()) {
      const bytes = readBytes(relativePath);
      workUnits.trackedFilesDigested += 1;
      inventory.push({ path: relativePath, sha256: evidenceSha256(bytes) });
    }
    if (controls.doubleDigestPath) {
      evidenceSha256(readBytes(controls.doubleDigestPath));
      workUnits.trackedFilesDigested += 1;
    }
  } catch (error) {
    throwEvidence(consentAuthorizationEvidenceFailureCodes.inventory, "governing-input digest computation failed", {
      cause: error?.message ?? String(error),
    });
  }

  return {
    inventory,
    inventorySha256: evidenceSha256(canonicalConsentAuthorizationEvidence(inventory)),
    importClosure: [...importClosure].toSorted(),
    dataInputPaths: [...dataInputPaths].toSorted(),
    compilerShimFiles: [...compilerShimFiles].toSorted(),
    reconciliation: {
      derivedOutsideTracked: untrackedDerived,
      trackedFootprintMissingFromDerived: missingDerived,
    },
    workUnits,
  };
}

function compactExecutedCaseReceipt(receipt) {
  const evidence = {
    candidate: {
      exitCode: receipt.candidateSubrun.exitCode,
      result: receipt.candidateSubrun.result,
      stdoutSha256: receipt.candidateSubrun.stdoutSha256,
      stderrSha256: receipt.candidateSubrun.stderrSha256,
    },
    expected: {
      ...receipt.expected,
      owner: receipt.expected.owner ?? "not-applicable",
    },
    firstFailingClauseId: receipt.firstFailingClauseId,
    mutant: {
      exitCode: receipt.mutantSubrun.exitCode,
      result: receipt.mutantSubrun.result,
      stdoutSha256: receipt.mutantSubrun.stdoutSha256,
      stderrSha256: receipt.mutantSubrun.stderrSha256,
    },
    mutationStatus: receipt.mutationActive ? "active" : "inactive",
    noEarlierClauseStatus: receipt.noEarlierClause ? "proven" : "unproven",
    preservedStatus:
      canonicalConsentAuthorizationEvidence(receipt.preservedVariableHashes.candidate) ===
      canonicalConsentAuthorizationEvidence(receipt.preservedVariableHashes.mutant)
        ? "preserved"
        : "changed",
  };
  return {
    caseId: receipt.caseId,
    evidence,
    evidenceSha256: evidenceSha256(canonicalConsentAuthorizationEvidence(evidence)),
  };
}

export function buildConsentAuthorizationEvidenceReceipt({
  aggregate,
  receipts,
  inventoryResult,
  floatingProvenance,
  previousReceipt = null,
}) {
  const cases = receipts
    .map(compactExecutedCaseReceipt)
    .toSorted((left, right) => left.caseId.localeCompare(right.caseId));
  const digestBound = {
    aggregate: {
      counts: aggregate.counts,
      reconciliation: aggregate.reconciliation,
      validStatus: aggregate.valid ? "valid" : "invalid",
    },
    cases,
    governingInputs: {
      inventory: inventoryResult.inventory,
      inventorySha256: inventoryResult.inventorySha256,
    },
    workUnits: inventoryResult.workUnits,
  };
  const previousDigest = previousReceipt?.digestBound
    ? evidenceSha256(canonicalConsentAuthorizationEvidence(previousReceipt.digestBound))
    : null;
  const nextDigest = evidenceSha256(canonicalConsentAuthorizationEvidence(digestBound));
  const preserveFloating =
    previousDigest === nextDigest &&
    previousReceipt?.floatingProvenance?.generationHead === floatingProvenance.generationHead;
  return {
    contractVersion: "consent-authorization-evidence-receipt/v1",
    digestBound,
    floatingProvenance: preserveFloating ? previousReceipt.floatingProvenance : floatingProvenance,
  };
}

function evidenceCaseCounts(cases) {
  return {
    total: cases.length,
    candidateGreen: cases.filter(
      ({ evidence }) => evidence.candidate.exitCode === 0 && evidence.candidate.result === "pass",
    ).length,
    mutantRed: cases.filter(({ evidence }) => evidence.mutant.exitCode > 0 && evidence.mutant.result === "fail").length,
    active: cases.filter(({ evidence }) => evidence.mutationStatus === "active").length,
    preserved: cases.filter(({ evidence }) => evidence.preservedStatus === "preserved").length,
  };
}

export function verifyConsentAuthorizationEvidenceReceipt(
  receipt,
  enumeration,
  schema,
  validateSchema,
  derivationOptions = {},
) {
  let schemaViolations;
  try {
    schemaViolations = validateSchema(receipt, schema);
  } catch (error) {
    throwEvidence(consentAuthorizationEvidenceFailureCodes.malformed, "receipt schema validation failed", {
      cause: error?.message ?? String(error),
    });
  }
  if (schemaViolations.length > 0) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.malformed,
      "receipt violates its recursively closed schema",
      {
        schemaViolations,
      },
    );
  }

  const cases = receipt.digestBound.cases;
  const caseIds = cases.map(({ caseId }) => caseId);
  const uniqueCaseIds = new Set(caseIds);
  const recomputedCounts = evidenceCaseCounts(cases);
  const caseBindingsMatch = cases.every(
    ({ evidence, evidenceSha256: committedSha256 }) =>
      evidenceSha256(canonicalConsentAuthorizationEvidence(evidence)) === committedSha256,
  );
  if (
    uniqueCaseIds.size !== caseIds.length ||
    canonicalConsentAuthorizationEvidence(recomputedCounts) !==
      canonicalConsentAuthorizationEvidence(receipt.digestBound.aggregate.counts) ||
    !caseBindingsMatch ||
    receipt.digestBound.aggregate.validStatus !== "valid"
  ) {
    throwEvidence(consentAuthorizationEvidenceFailureCodes.tampered, "receipt aggregate is internally inconsistent");
  }

  const committedEnumeration = [...enumeration.cases].toSorted();
  const expectedReconciliation = Object.fromEntries(
    ["salvageHeadTotal", "retiredTotal", "carriedTotal", "addedTotal", "total"].map((key) => [
      key,
      enumeration.reconciliation[key],
    ]),
  );
  if (
    canonicalConsentAuthorizationEvidence([...caseIds].toSorted()) !==
      canonicalConsentAuthorizationEvidence(committedEnumeration) ||
    canonicalConsentAuthorizationEvidence(receipt.digestBound.aggregate.reconciliation) !==
      canonicalConsentAuthorizationEvidence(expectedReconciliation)
  ) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.enumeration,
      "receipt case set differs from committed enumeration",
      {
        receiptCaseIds: [...caseIds].toSorted(),
        committedEnumeration,
      },
    );
  }

  let live;
  try {
    live = deriveConsentAuthorizationEvidenceInventory(derivationOptions);
  } catch (error) {
    if (error instanceof ConsentAuthorizationEvidenceError) throw error;
    throwEvidence(consentAuthorizationEvidenceFailureCodes.inventory, "live inventory derivation failed", {
      cause: error?.message ?? String(error),
    });
  }
  const committedInputs = receipt.digestBound.governingInputs;
  if (
    committedInputs.inventorySha256 !== live.inventorySha256 ||
    canonicalConsentAuthorizationEvidence(committedInputs.inventory) !==
      canonicalConsentAuthorizationEvidence(live.inventory) ||
    canonicalConsentAuthorizationEvidence(receipt.digestBound.workUnits) !==
      canonicalConsentAuthorizationEvidence(live.workUnits)
  ) {
    throwEvidence(
      consentAuthorizationEvidenceFailureCodes.stale,
      "receipt does not match the live governing-input bytes",
      {
        committedInventorySha256: committedInputs.inventorySha256,
        liveInventorySha256: live.inventorySha256,
        committedWorkUnits: receipt.digestBound.workUnits,
        liveWorkUnits: live.workUnits,
      },
    );
  }
  return live;
}

if (!evidenceVerifierOnly) {
  const {
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
  } = await import("./consent-authorization-sites.mjs");
  const { deriveGuardCandidateProvenance } = await import("./guard-candidate-provenance.mjs");
  const {
    compareTypeScriptOwnerContexts,
    deriveTypeScriptOwnerContexts,
    loadTypeScriptOwnerContextArtifact,
    loadTypeScriptOwnerContextPartition,
    loadTypeScriptOwnerContextSchema,
    typeScriptOwnerContextArtifactPath,
    typeScriptOwnerContextPartitionPath,
  } = await import("./typescript-owner-context-derivation.mjs");
  const { collectOpenSchemaObjectPaths, validateAgainstSchema } = await import("./identity-creation-path-registry.mjs");
  const { repoRoot } = await import("../lib/repo.mjs");

  const fixtureRoot = "scripts/check-structure/fixtures/consent-authorization-sites";
  const ownerContextFixtureRoot = "scripts/check-structure/fixtures/typescript-owner-context-derivation";
  const analyzerPath = "scripts/check-structure/consent-authorization-sites.mjs";
  const suitePath = "scripts/check-structure/consent-authorization-mutation-evidence.mjs";
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
          readEventPayload: () =>
            JSON.stringify({ pull_request: { head: { sha: head }, base: { sha: advancedBase } } }),
        }),
    };
  }

  function buildMergeGroupScratchRepo(prefix) {
    const scratch = initScratchRepo(prefix);
    writeProductSurface(scratch);
    const base = commitScratch(scratch, "base");
    writeScratchFile(
      scratch,
      "docs/landing-note.md",
      "The landing candidate is itself the prospective merged result.\n",
    );
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
    writeScratchFile(
      scratch,
      "dist/generated.ts",
      repoFile(`${fixtureRoot}/corpus/ignored-generated/authorization.ts`),
    );
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

  function cleanupRetainedScratchRepos() {
    for (const scratch of retainedScratchRepos) rmSync(scratch, { recursive: true, force: true });
  }

  process.once("exit", cleanupRetainedScratchRepos);

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
  collectCommitShaLiteralEqualities = function collectCommitShaLiteralEqualities(relativeFile, source) {
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
  };

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
  collectAnalyzerExpectationOrigins = function collectAnalyzerExpectationOrigins(relativeFile, source) {
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
  };

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
      command: `node ${suitePath} --execute`,
    };
  }

  const mutationEvidenceCases = [
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
  exportedMutationEvidenceCases = mutationEvidenceCases;

  function normalizedAnalyzerSource() {
    let source = repoFile(analyzerPath);
    for (const [specifier, target] of [
      ['"@chase-sets/typescript-compiler-api"', "packages/typescript-compiler-api/index.mjs"],
      ['"./guard-candidate-provenance.mjs"', "scripts/check-structure/guard-candidate-provenance.mjs"],
      [
        '"./typescript-owner-context-derivation.mjs"',
        "scripts/check-structure/typescript-owner-context-derivation.mjs",
      ],
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
    const reportLineEnd = stdout.indexOf("\n");
    const report = JSON.parse(stdout.slice(0, reportLineEnd));
    const acceptanceExitCode = outcome.status ?? 1;
    const normalizeExecutedOutput = (value) =>
      value
        .replaceAll(pathToFileURL(runnerPath).href, "file://<scratch-runner>")
        .replaceAll(pathToFileURL(modulePath).href, "file://<scratch-analyzer>")
        .replaceAll(scratchRepo.replaceAll("\\", "/"), "<scratch-checkout>")
        .replaceAll(scratchRepo, "<scratch-checkout>");
    return {
      acceptanceClauseId: report.acceptanceClauseId,
      run: {
        guardExitCode: report.guardExitCode,
        guardViolationCodes: report.guardViolationCodes,
        guardFirstFailingClauseId: report.guardFirstFailingClauseId,
        acceptanceExitCode,
        acceptanceResult: acceptanceExitCode === 0 ? "pass" : "fail",
        acceptanceFirstFailingClauseId: acceptanceExitCode === 0 ? "" : report.acceptanceClauseId,
        stdoutSha256: sha256(stdout.slice(0, reportLineEnd + 1)),
        stderrSha256: sha256(normalizeExecutedOutput(stderr)),
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
    const descriptor = mutationEvidenceCases.find(({ caseId }) => caseId === partitionNarrowCaseId);
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
   * settled authority's two lockfile fixtures written in turn to one path, so the derived
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
          ({ code, site }) =>
            code === "consent-authorization-site-unregistered" && site?.owner === "seventhModuleProbe",
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
  /* Offline entrypoint                                                         */
  /* -------------------------------------------------------------------------- */

  function assertOfflineEvidence(condition, message) {
    if (!condition) throw new Error(message);
  }

  function buildMutationAggregate(receipts) {
    return {
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
  }

  executeConsentAuthorizationMutationEvidence = async function executeConsentAuthorizationMutationEvidence({
    receiptDir = null,
    emitReceipt = false,
  } = {}) {
    const receipts = await Promise.all(mutationEvidenceCases.map(generateReceipt));
    const aggregate = buildMutationAggregate(receipts);
    const schemaViolations = validateAgainstSchema(aggregate, aggregateSchema);
    assertOfflineEvidence(schemaViolations.length === 0, `aggregate schema: ${schemaViolations.join("; ")}`);
    const aggregateViolations = collectMutationAggregateViolations(aggregate, enumeration, {
      expectedProvenance: deriveConsentAuthorizationReceiptProvenance(realTreeResult),
      receipts,
    });
    assertOfflineEvidence(aggregateViolations.length === 0, `aggregate authority: ${aggregateViolations.join("; ")}`);

    const caseIds = aggregate.receipts.map(({ caseId }) => caseId).toSorted();
    assertOfflineEvidence(
      JSON.stringify(caseIds) === JSON.stringify([...enumeration.cases].toSorted()),
      "executed receipt identifiers differ from the committed enumeration",
    );
    assertOfflineEvidence(
      new Set(caseIds).size === enumeration.reconciliation.total,
      "executed case identifiers repeat",
    );
    assertOfflineEvidence(
      Object.values(aggregate.counts).every((count) => count === enumeration.reconciliation.total),
      `mutation aggregate is incomplete: ${JSON.stringify(aggregate.counts)}`,
    );
    assertOfflineEvidence(
      JSON.stringify([...enumeration.carried, ...enumeration.added].toSorted()) ===
        JSON.stringify([...enumeration.cases].toSorted()),
      "the committed carried and added sets do not reconcile to the case enumeration",
    );
    assertOfflineEvidence(
      enumeration.carried.length === enumeration.reconciliation.carriedTotal,
      "carried count drifted",
    );
    assertOfflineEvidence(enumeration.added.length === enumeration.reconciliation.addedTotal, "added count drifted");
    assertOfflineEvidence(
      enumeration.retired.length === enumeration.reconciliation.retiredTotal,
      "retired count drifted",
    );
    assertOfflineEvidence(enumeration.cases.length === enumeration.reconciliation.total, "case count drifted");
    assertOfflineEvidence(
      enumeration.reconciliation.salvageHeadTotal -
        enumeration.reconciliation.retiredTotal +
        enumeration.reconciliation.addedTotal ===
        enumeration.reconciliation.total,
      "reconciliation arithmetic drifted",
    );
    assertOfflineEvidence(
      enumeration.carried.every((caseId) => !enumeration.retired.includes(caseId)) &&
        enumeration.added.every((caseId) => !enumeration.retired.includes(caseId)),
      "an active case is also retired",
    );

    if (receiptDir !== null) {
      mkdirSync(receiptDir, { recursive: true });
      for (const receipt of receipts) {
        writeFileSync(path.join(receiptDir, `${receipt.caseId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
      }
      writeFileSync(path.join(receiptDir, "mutation-aggregate.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    }
    let evidenceReceipt = null;
    if (emitReceipt) {
      const inventoryResult = deriveConsentAuthorizationEvidenceInventory({ rootDir: repoRoot });
      let previousReceipt = null;
      try {
        previousReceipt = JSON.parse(repoFile(evidenceReceiptPath));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const roleRecord = Object.fromEntries(
        Object.entries(realTreeResult.provenance.roles).map(([role, value]) => [
          role,
          { sha: value.sha === null ? "absent" : `git:${value.sha}`, source: value.source },
        ]),
      );
      const startedAt = receipts.map(({ timestamps }) => timestamps.startedAt).toSorted()[0];
      const finishedAt = receipts
        .map(({ timestamps }) => timestamps.finishedAt)
        .toSorted()
        .at(-1);
      const scratchCommands = receipts
        .map(({ executedGuard }) => executedGuard?.command)
        .filter(Boolean)
        .map((command) => evidenceSha256(canonicalConsentAuthorizationEvidence(command)))
        .toSorted();
      evidenceReceipt = buildConsentAuthorizationEvidenceReceipt({
        aggregate,
        receipts,
        inventoryResult,
        floatingProvenance: {
          environment: realTreeResult.environment,
          generationHead: `git:${execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).trim()}`,
          generatedAt: startedAt,
          completedAt: finishedAt,
          roles: roleRecord,
          scratchCommandSha256: evidenceSha256(canonicalConsentAuthorizationEvidence(scratchCommands)),
          typescriptVersion: ts.version,
        },
        previousReceipt,
      });
      const evidenceReceiptSchema = readJsonFixture(evidenceReceiptSchemaPath);
      const evidenceSchemaViolations = validateAgainstSchema(evidenceReceipt, evidenceReceiptSchema);
      assertOfflineEvidence(
        evidenceSchemaViolations.length === 0,
        `evidence receipt schema: ${evidenceSchemaViolations.join("; ")}`,
      );
      verifyConsentAuthorizationEvidenceReceipt(
        evidenceReceipt,
        enumeration,
        evidenceReceiptSchema,
        validateAgainstSchema,
        { rootDir: repoRoot },
      );
      writeFileSync(path.join(repoRoot, evidenceReceiptPath), `${JSON.stringify(evidenceReceipt, null, 2)}\n`);
    }
    return { receipts, aggregate, evidenceReceipt };
  };

  function commandLineOptions(argv) {
    const options = { execute: false, emitReceipt: false, receiptDir: null };
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === "--execute") options.execute = true;
      else if (argument === "--emit-receipt") options.emitReceipt = true;
      else if (argument === "--receipt-dir") options.receiptDir = argv[++index] ?? null;
      else throw new Error(`unknown argument: ${argument}`);
    }
    return options;
  }

  async function main() {
    const options = commandLineOptions(process.argv.slice(2));
    if (!options.execute) throw new Error("offline mutation evidence requires --execute");
    const { receipts, aggregate } = await executeConsentAuthorizationMutationEvidence({
      receiptDir: options.receiptDir,
      emitReceipt: options.emitReceipt,
    });
    for (const receipt of receipts) process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.stdout.write(`${JSON.stringify(aggregate)}\n`);
  }

  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}
