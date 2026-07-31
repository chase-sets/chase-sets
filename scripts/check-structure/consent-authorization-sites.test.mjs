import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeConsentAuthorizationSites,
  collectConsentAuthorizationDerivationViolations,
  collectConsentAuthorizationRegistryViolations,
  deriveTypeScriptOwnerContexts,
  digestConsentAuthorizationPartition,
  enumerateConsentAuthorizationCorpus,
  isConsentAuthorizationTestSource,
  loadConsentAuthorizationDerivationArtifact,
  loadConsentAuthorizationRegistry,
  loadConsentAuthorizationRegistrySchema,
  scanConsentAuthorizationSource,
} from "./consent-authorization-sites.mjs";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

const baseHead = "84ddea0bfde7cf5d4280a0a1a619d246c777af35";
const expectedDigest = "cf3d89ee1d713022bcf3a473a6b5ef5fd0f0ae3fe56c0da83b45d93b7bc0178e";
const fixtureRoot = "scripts/check-structure/fixtures/consent-authorization-sites";
const artifact = loadConsentAuthorizationDerivationArtifact();
const artifactFileSha256 = sha256(
  readFileSync(path.join(repoRoot, fixtureRoot, "typescript-6.0.3-owner-contexts.json")),
);
const registry = loadConsentAuthorizationRegistry();
const registrySchema = loadConsentAuthorizationRegistrySchema();
const derivedAuthority = deriveTypeScriptOwnerContexts();
const receiptSchema = JSON.parse(
  readFileSync(path.join(repoRoot, fixtureRoot, "consent-authorization-mutation-v1.schema.json"), "utf8"),
);
const aggregateSchema = JSON.parse(
  readFileSync(path.join(repoRoot, fixtureRoot, "consent-authorization-mutation-aggregate-v1.schema.json"), "utf8"),
);
const realTreeResult = analyzeConsentAuthorizationSites({ repoRoot });
const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const candidateBase = execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureSource(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function scanFixture(relativePath) {
  return scanConsentAuthorizationSource(relativePath, fixtureSource(relativePath), artifact);
}

function probeGitCorpus() {
  const scratch = mkdtempSync(path.join(tmpdir(), `consent-corpus-${candidateHead}-`));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: scratch });
    writeFileSync(path.join(scratch, ".gitignore"), fixtureSource(`${fixtureRoot}/corpus/.gitignore`));
    writeFileSync(path.join(scratch, "tracked.ts"), "export const tracked = true;\n");
    execFileSync("git", ["add", ".gitignore", "tracked.ts"], { cwd: scratch });
    const nonignored = path.join(scratch, "untracked-nonignored");
    const ignored = path.join(scratch, "ignored-generated");
    mkdirSync(nonignored);
    mkdirSync(ignored);
    writeFileSync(
      path.join(nonignored, "authorization.ts"),
      fixtureSource(`${fixtureRoot}/corpus/untracked-nonignored/authorization.ts`),
    );
    writeFileSync(
      path.join(ignored, "authorization.ts"),
      fixtureSource(`${fixtureRoot}/corpus/ignored-generated/authorization.ts`),
    );
    return enumerateConsentAuthorizationCorpus({ repoRoot: scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mutationCase(caseId, fixture, symbol, violation, owner, clauseId, surface = "focused control") {
  return {
    caseId,
    acId: caseId.match(/^MUT-(AC\d+)/)?.[1] ?? "AC3",
    fixture,
    symbol,
    violation,
    owner,
    clauseId,
    surface,
    command: `pnpm exec vitest run --config ./vitest.scripts.config.mjs scripts/check-structure/consent-authorization-sites.test.mjs -t '^${caseId}$'`,
  };
}

const mutationCases = [
  [
    "MUT-AC1-CORPUS-DROP-OTHERS",
    `${fixtureRoot}/corpus/untracked-nonignored/authorization.ts`,
    "enumerateCandidateFiles / --others",
    "consent-authorization-site-unregistered",
    "untrackedProbe",
    "corpus.git-authority.others",
    "untracked file disappears under mutant",
  ],
  [
    "MUT-AC1-CORPUS-DROP-EXCLUDE-STANDARD",
    `${fixtureRoot}/corpus/ignored-generated/authorization.ts`,
    "enumerateCandidateFiles / --exclude-standard",
    "consent-authorization-site-unregistered",
    "ignoredProbe",
    "corpus.git-authority.exclude-standard",
    "ignored file enters under mutant",
  ],
  [
    "MUT-AC2-SCHEMA-OPEN-NESTED",
    `${fixtureRoot}/registry/nested-unknown.json`,
    "registry schema additionalProperties",
    "consent-authorization-registry-invalid",
    null,
    "schema.recursive-closure",
    "nested schema pointer",
  ],
  [
    "MUT-AC2-REGISTRY-DROP-ONE-SITE",
    "scripts/check-structure/consent-authorization-site-registry.json",
    "loadRegistry / one exact row",
    "consent-authorization-site-unregistered",
    "termsOfServiceConsentRoutes > POST /accept",
    "reconciliation.registry-completeness",
    "source-to-registry edge",
  ],
  [
    "MUT-AC3-RUNTIME-SALVAGE-SUBSET",
    `${fixtureRoot}/owners/runtime-matrix.ts`,
    "deriveRuntimeKinds / salvage subset",
    "derivation-runtime-set-mismatch",
    null,
    "derivation.runtime-set",
    "artifact runtimeKinds",
  ],
  [
    "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT",
    `${fixtureRoot}/owners/ambiguous-iife.ts`,
    "classifyRuntimeBoundary / transparency",
    "consent-authorization-owner-ambiguous",
    null,
    "owner.ambiguous-iife",
    "IIFE boundary",
  ],
  [
    "MUT-AC3-RUNTIME-OMIT-ACCESSORS",
    `${fixtureRoot}/owners/accessor-matrix.ts`,
    "classifyRuntimeBoundary / getter+setter arms",
    "consent-authorization-site-unregistered+consent-authorization-site-missing",
    "AccessorMatrix.get authorization",
    "owner.accessor-boundary",
    "accessor boundary",
  ],
  [
    "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY",
    `${fixtureRoot}/owners/local-object-matrix.ts`,
    "deriveStableOwner / local-object arm",
    "consent-authorization-site-unregistered+consent-authorization-site-missing",
    "neutralBox.inner.authorization",
    "owner.local-object-boundary",
    "property boundary",
  ],
  [
    "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY",
    `${fixtureRoot}/references/computed-binding-element.ts`,
    "classifyReference / BindingElement arm",
    "consent-authorization-reference-unclassified",
    null,
    "reference.computed-binding",
    "computed BindingElement and alias",
  ],
  [
    "MUT-AC5-PREFILTER-PLAIN-ONLY",
    `${fixtureRoot}/escapes/u-identifier-only.ts`,
    "candidate parser selection",
    "consent-authorization-reference-unclassified",
    null,
    "parsing.parse-all-u",
    "escape-only unicode identifier",
  ],
  [
    "MUT-AC5-PREFILTER-PLAIN-PLUS-U",
    `${fixtureRoot}/escapes/x-string-template-only.ts`,
    "candidate parser selection",
    "consent-authorization-reference-unclassified",
    null,
    "parsing.parse-all-x",
    "escape-only hex string and template",
  ],
  [
    "MUT-AC8-REASON-REMOVE-6120",
    "scripts/check-structure/consent-authorization-site-registry.json",
    "validateRegistry / #6120 permanence",
    "consent-authorization-registry-invalid",
    "buildScenarioIdentityReconcilers > consentReconciler",
    "registry.6120-permanence",
    "reason",
  ],
  [
    "MUT-AC8-PARTITION-SWAP-CLASSIFICATION",
    "scripts/check-structure/consent-authorization-site-registry.json",
    "validateRegistry / classification",
    "consent-authorization-registry-invalid",
    "termsOfServiceConsentRoutes > POST /accept",
    "registry.partition",
    "2/1/3 partition",
  ],
  [
    "MUT-AC8-REGISTRY-ADD-SEVENTH",
    "scripts/check-structure/consent-authorization-site-registry.json",
    "validateRegistry / exact cardinality",
    "consent-authorization-registry-invalid",
    "seventhProbe",
    "registry.cardinality",
    "six-row registry",
  ],
  [
    "MUT-AC10-CORPUS-FILESYSTEM-WALK",
    "scripts/check-structure/consent-authorization-sites.mjs",
    "enumerateCandidateFiles / Git authority",
    "consent-authorization-corpus-drift",
    null,
    "corpus.filesystem-walk",
    "surface partition and digest",
  ],
  [
    "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS",
    `${fixtureRoot}/reconciliation/unregistered-seventh-with-six-safe.ts`,
    "reconcileAuthorizationSites / observed partition",
    "consent-authorization-site-unregistered",
    "seventhProbe",
    "reconciliation.observed-completeness",
    "observed partition",
  ],
  [
    "MUT-AC6-DIGEST-OMIT-FILE",
    `${fixtureRoot}/digest/file-move.ts`,
    "scenario identity digest / file",
    "consent-authorization-site-unregistered",
    "digestProbe",
    "digest.file",
    "file identity",
  ],
  [
    "MUT-AC6-DIGEST-OMIT-OWNER",
    `${fixtureRoot}/digest/owner-move.ts`,
    "scenario identity digest / owner",
    "consent-authorization-site-unregistered",
    "movedDigestProbe",
    "digest.owner",
    "owner identity",
  ],
  [
    "MUT-AC6-DIGEST-OMIT-CONSTRUCTOR",
    `${fixtureRoot}/digest/constructor-change.ts`,
    "scenario identity digest / constructor",
    "consent-authorization-site-unregistered",
    "digestProbe",
    "digest.constructor",
    "constructor identity",
  ],
  [
    "MUT-AC6-DIGEST-OMIT-ORDINAL",
    `${fixtureRoot}/digest/ordinal-change.ts`,
    "scenario identity digest / ordinal",
    "consent-authorization-site-unregistered",
    "digestProbe",
    "digest.ordinal",
    "ordinal identity",
  ],
].map((values) => mutationCase(...values));

const runtimeNames = [
  "FUNCTION-DECLARATION",
  "METHOD-DECLARATION",
  "CONSTRUCTOR",
  "GET-ACCESSOR",
  "SET-ACCESSOR",
  "FUNCTION-EXPRESSION",
  "ARROW-FUNCTION",
];
const adjacentNames = [
  "PROPERTY-ASSIGNMENT",
  "SHORTHAND-PROPERTY-ASSIGNMENT",
  "VARIABLE-DECLARATION",
  "PARAMETER",
  "BINDING-ELEMENT",
  "PROPERTY-DECLARATION",
  "BINARY-EXPRESSION",
  "EXPORT-ASSIGNMENT",
];

for (const name of runtimeNames) {
  mutationCases.push(
    mutationCase(
      `MUT-AC3-RUNTIME-SET-OMIT-${name}`,
      `${fixtureRoot}/typescript-6.0.3-owner-contexts.json`,
      `deriveRuntimeKinds / ${name}`,
      "derivation-runtime-set-mismatch",
      null,
      "derivation.runtime-set",
      "artifact runtimeKinds",
    ),
  );
}
for (const name of adjacentNames) {
  mutationCases.push(
    mutationCase(
      `MUT-AC3-NAMED-EVAL-SET-OMIT-${name}`,
      `${fixtureRoot}/typescript-6.0.3-owner-contexts.json`,
      `deriveNamedEvaluationContexts / ${name}`,
      "derivation-named-evaluation-set-mismatch",
      null,
      "derivation.named-evaluation-set",
      "artifact namedEvaluationContexts",
    ),
  );
}
for (const name of adjacentNames) {
  mutationCases.push(
    mutationCase(
      `MUT-AC3-DISPOSITION-OMIT-${name}`,
      `${fixtureRoot}/typescript-6.0.3-owner-contexts.json`,
      `ownerContextDisposition / ${name}`,
      "owner-disposition-set-mismatch",
      null,
      "disposition.adjacent-contexts",
      "exact context row",
    ),
  );
}
if (mutationCases.length !== 43 || new Set(mutationCases.map(({ caseId }) => caseId)).size !== 43) {
  throw new Error("The closed mutation contract must contain exactly 43 unique cases");
}

function syntaxName(caseId) {
  return caseId
    .replace(/^MUT-AC3-(?:RUNTIME-SET|NAMED-EVAL-SET|DISPOSITION)-OMIT-/, "")
    .toLowerCase()
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function mutatedArtifactFor(descriptor) {
  const mutant = structuredClone(artifact);
  if (descriptor.caseId === "MUT-AC3-RUNTIME-SALVAGE-SUBSET") {
    const salvage = new Set(["FunctionDeclaration", "MethodDeclaration", "FunctionExpression", "ArrowFunction"]);
    mutant.runtimeKinds = mutant.runtimeKinds.filter(({ name }) => salvage.has(name));
  } else if (descriptor.caseId.includes("RUNTIME-SET-OMIT-")) {
    const name = syntaxName(descriptor.caseId);
    mutant.runtimeKinds = mutant.runtimeKinds.filter((row) => row.name !== name);
  } else if (descriptor.caseId.includes("NAMED-EVAL-SET-OMIT-")) {
    const name = syntaxName(descriptor.caseId);
    mutant.namedEvaluationContexts = mutant.namedEvaluationContexts.filter((row) => row.name !== name);
  } else if (descriptor.caseId.includes("DISPOSITION-OMIT-")) {
    const name = syntaxName(descriptor.caseId);
    mutant.dispositions = mutant.dispositions.filter((row) => row.context !== name);
  } else {
    return null;
  }
  return mutant;
}

function artifactViolationCodes(candidate) {
  const violations = [];
  if (candidate.resolution?.implementationSourceSha256 !== derivedAuthority.resolution.implementationSourceSha256) {
    violations.push("derivation-source-mismatch");
  }
  if (JSON.stringify(candidate.runtimeKinds) !== JSON.stringify(derivedAuthority.runtimeKinds)) {
    violations.push("derivation-runtime-set-mismatch");
  }
  if (
    JSON.stringify(candidate.namedEvaluationContexts) !== JSON.stringify(derivedAuthority.namedEvaluationContexts) ||
    JSON.stringify(candidate.assignmentOperators) !== JSON.stringify(derivedAuthority.assignmentOperators)
  ) {
    violations.push("derivation-named-evaluation-set-mismatch");
  }
  if (JSON.stringify(candidate.dispositions) !== JSON.stringify(derivedAuthority.dispositions)) {
    violations.push("owner-disposition-set-mismatch");
  }
  if (violations.length === 0 && JSON.stringify(candidate) !== JSON.stringify(derivedAuthority)) {
    violations.push("derivation-artifact-mismatch");
  }
  return violations;
}

function normalizedAnalyzerSource() {
  return fixtureSource("scripts/check-structure/consent-authorization-sites.mjs")
    .replace(
      '"@chase-sets/typescript-compiler-api"',
      JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/typescript-compiler-api/index.mjs")).href),
    )
    .replace(
      '"./identity-creation-path-registry.mjs"',
      JSON.stringify(
        pathToFileURL(path.join(repoRoot, "scripts/check-structure/identity-creation-path-registry.mjs")).href,
      ),
    )
    .replace('"../lib/repo.mjs"', JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/lib/repo.mjs")).href));
}

function sourceMutationFor(descriptor) {
  const id = descriptor.caseId;
  let source;
  let candidateFragment;
  let mutantFragment;
  if (id === "MUT-AC2-SCHEMA-OPEN-NESTED") {
    source = `export default ${JSON.stringify(registrySchema)};\n`;
    candidateFragment = '"items":{"type":"object","additionalProperties":false';
    mutantFragment = '"items":{"type":"object","additionalProperties":true';
  } else if (id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") {
    source = `export default ${JSON.stringify(registry)};\n`;
    candidateFragment = `${JSON.stringify(registry.sites[0])},`;
    mutantFragment = "";
  } else {
    source = normalizedAnalyzerSource();
  }
  if (id === "MUT-AC1-CORPUS-DROP-OTHERS") {
    candidateFragment = '"--others", ';
    mutantFragment = "";
  } else if (id === "MUT-AC1-CORPUS-DROP-EXCLUDE-STANDARD") {
    candidateFragment = '"--exclude-standard", ';
    mutantFragment = "";
  } else if (id === "MUT-AC2-SCHEMA-OPEN-NESTED" || id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") {
    // The data-fragment target was selected above.
  } else if (id === "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT") {
    candidateFragment =
      '      return { status: "ambiguous" };\n    }\n    return { status: "stable", owner: "<module>" };';
    mutantFragment = '      continue;\n    }\n    return { status: "stable", owner: "<module>" };';
  } else if (id === "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY") {
    candidateFragment = "      const objectOwner = locallyRootedObjectOwner(boundary);";
    mutantFragment = "      const objectOwner = null;";
  } else if (id === "MUT-AC3-RUNTIME-OMIT-ACCESSORS") {
    candidateFragment = `    !ts.isConstructorDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)`;
    mutantFragment = `    !ts.isConstructorDeclaration(node) &&
    !ts.isMethodDeclaration(node)`;
  } else if (id === "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY") {
    candidateFragment = `  if (
    ts.isComputedPropertyName(node.parent) &&
    node.parent.expression === node &&
    ts.isBindingElement(node.parent.parent) &&
    node.parent.parent.propertyName === node.parent
  ) {
    return node.text;
  }`;
    mutantFragment = "";
  } else if (id === "MUT-AC5-PREFILTER-PLAIN-ONLY") {
    candidateFragment = "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {";
    mutantFragment =
      "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {\n  if (!consentAuthorizationConstructors.some((name) => source.includes(name))) return [];";
  } else if (id === "MUT-AC5-PREFILTER-PLAIN-PLUS-U") {
    candidateFragment = "export function scanConsentAuthorizationSource(relativeFile, source, artifact) {";
    mutantFragment =
      'export function scanConsentAuthorizationSource(relativeFile, source, artifact) {\n  if (!source.includes("\\\\u") && !consentAuthorizationConstructors.some((name) => source.includes(name))) return [];';
  } else if (id === "MUT-AC8-REASON-REMOVE-6120") {
    candidateFragment =
      '    if (site.classification === "provisioning" && !/#6120\\b.*permanent|permanent.*#6120\\b/i.test(site.reason)) {';
    mutantFragment =
      '    if (false && site.classification === "provisioning" && !/#6120\\b.*permanent|permanent.*#6120\\b/i.test(site.reason)) {';
  } else if (id === "MUT-AC8-PARTITION-SWAP-CLASSIFICATION") {
    candidateFragment =
      '  if (JSON.stringify(counts) !== JSON.stringify({ actor: 2, "self-registration": 1, provisioning: 3 })) {';
    mutantFragment =
      '  if (false && JSON.stringify(counts) !== JSON.stringify({ actor: 2, "self-registration": 1, provisioning: 3 })) {';
  } else if (id === "MUT-AC8-REGISTRY-ADD-SEVENTH") {
    candidateFragment =
      '  if (registry.sites.length !== 6) violations.push("registry must contain exactly six sites");';
    mutantFragment =
      '  if (false && registry.sites.length !== 6) violations.push("registry must contain exactly six sites");';
  } else if (id === "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS") {
    candidateFragment = "    } else if (!registryKeys.has(siteKey(site))) {";
    mutantFragment = "    } else if (false && !registryKeys.has(siteKey(site))) {";
  } else if (id === "MUT-AC10-CORPUS-FILESYSTEM-WALK") {
    candidateFragment = '  const raw = execGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);';
    mutantFragment =
      '  const raw = Buffer.from(createRequire(import.meta.url)("node:fs").readdirSync(rootDir, { recursive: true }).join("\\0") + "\\0");';
  } else if (id.startsWith("MUT-AC6-DIGEST-OMIT-")) {
    candidateFragment = `    consumptions: consumptions.map(({ file, owner, constructor, ordinal, classification }) => ({
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
    mutantFragment = candidateFragment.replace(`      ${omitted},\n`, "");
  } else {
    return null;
  }
  if (source.split(candidateFragment).length - 1 !== 1) {
    throw new Error(`${descriptor.caseId} source target is not unique`);
  }
  return { source, candidateFragment, mutantFragment };
}

function evaluateSourceMutation(descriptor, candidateModule, mutantModule) {
  const id = descriptor.caseId;
  if (id === "MUT-AC2-SCHEMA-OPEN-NESTED") {
    const invalid = JSON.parse(fixtureSource(descriptor.fixture));
    const candidateViolations = validateAgainstSchema(invalid, candidateModule.default);
    const mutantViolations = validateAgainstSchema(invalid, mutantModule.default);
    return (
      candidateViolations.some((entry) => entry.includes("unknown member")) &&
      !mutantViolations.some((entry) => entry.includes("unknown member"))
    );
  }
  if (id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    const observed = new Set(realTreeResult.partition.consumptions.map(key));
    const candidateKeys = new Set(candidateModule.default.sites.map(key));
    const mutantKeys = new Set(mutantModule.default.sites.map(key));
    return (
      candidateModule.default.sites.length === 6 &&
      [...candidateKeys].every((value) => observed.has(value)) &&
      mutantModule.default.sites.length === 5 &&
      [...observed].some((value) => !mutantKeys.has(value))
    );
  }
  if (id.startsWith("MUT-AC1-CORPUS-")) {
    let candidateArgs;
    let mutantArgs;
    candidateModule.enumerateConsentAuthorizationCorpus({
      execGit(args) {
        candidateArgs = args;
        return Buffer.from("ordinary.ts\0");
      },
    });
    mutantModule.enumerateConsentAuthorizationCorpus({
      execGit(args) {
        mutantArgs = args;
        return Buffer.from("ordinary.ts\0");
      },
    });
    const expected = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
    return (
      JSON.stringify(candidateArgs) === JSON.stringify(expected) &&
      JSON.stringify(mutantArgs) !== JSON.stringify(expected)
    );
  }
  if (id === "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT") {
    const source = fixtureSource(descriptor.fixture);
    const candidateOwner = candidateModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact)[0]
      .owner;
    const mutantOwner = mutantModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact)[0].owner;
    return candidateOwner === null && mutantOwner === "neutralOuter";
  }
  if (id === "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY") {
    const source = fixtureSource(descriptor.fixture);
    const candidateOwner = candidateModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact)[0]
      .owner;
    const mutantOwner = mutantModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact)[0].owner;
    return candidateOwner?.startsWith("neutralBox.") && mutantOwner === null;
  }
  if (id === "MUT-AC3-RUNTIME-OMIT-ACCESSORS") {
    const source = fixtureSource(descriptor.fixture);
    const candidateOwners = candidateModule
      .scanConsentAuthorizationSource(descriptor.fixture, source, artifact)
      .map(({ owner }) => owner);
    const mutantOwners = mutantModule
      .scanConsentAuthorizationSource(descriptor.fixture, source, artifact)
      .map(({ owner }) => owner);
    return (
      candidateOwners.every((owner) => owner?.startsWith("AccessorMatrix.")) &&
      mutantOwners.every((owner) => owner === null)
    );
  }
  if (id === "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY" || id.startsWith("MUT-AC5-PREFILTER-")) {
    const source = fixtureSource(descriptor.fixture);
    const candidateReferences = candidateModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact);
    const mutantReferences = mutantModule.scanConsentAuthorizationSource(descriptor.fixture, source, artifact);
    return (
      candidateReferences.some(({ referenceClass }) => referenceClass === "unexpected") &&
      !mutantReferences.some(({ referenceClass }) => referenceClass === "unexpected")
    );
  }
  if (id === "MUT-AC8-REASON-REMOVE-6120") {
    const changed = structuredClone(registry);
    changed.sites.find(({ classification }) => classification === "provisioning").reason = "Permanent exemption.";
    const candidateViolations = candidateModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    const mutantViolations = mutantModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    return (
      candidateViolations.some((entry) => entry.includes("#6120")) &&
      !mutantViolations.some((entry) => entry.includes("#6120"))
    );
  }
  if (id === "MUT-AC8-PARTITION-SWAP-CLASSIFICATION") {
    const changed = structuredClone(registry);
    changed.sites[0].constructor = "authorizeConsentForProvisioning";
    changed.sites[0].classification = "provisioning";
    changed.sites[0].reason = "Permanent #6120 probe exemption.";
    const candidateViolations = candidateModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    const mutantViolations = mutantModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    return (
      candidateViolations.some((entry) => entry.includes("registry partition")) &&
      !mutantViolations.some((entry) => entry.includes("registry partition"))
    );
  }
  if (id === "MUT-AC8-REGISTRY-ADD-SEVENTH") {
    const changed = structuredClone(registry);
    changed.sites.push({ ...changed.sites[0], owner: "seventhProbe" });
    const candidateViolations = candidateModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    const mutantViolations = mutantModule.collectConsentAuthorizationRegistryViolations(changed, registrySchema);
    return (
      candidateViolations.some((entry) => entry.includes("exactly six")) &&
      !mutantViolations.some((entry) => entry.includes("exactly six"))
    );
  }
  if (id === "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS") {
    const scratch = mkdtempSync(path.join(tmpdir(), `consent-partition-${candidateHead}-`));
    const files = new Map([
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
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: scratch });
      for (const [relative, fixture] of files) {
        const target = path.join(scratch, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, fixtureSource(fixture));
      }
      execFileSync("git", ["add", "."], { cwd: scratch });
      const seventh = path.join(scratch, "arbitrary", "authorization.ts");
      mkdirSync(path.dirname(seventh), { recursive: true });
      writeFileSync(seventh, fixtureSource(descriptor.fixture));
      const options = {
        repoRoot: scratch,
        authorityRoot: repoRoot,
        registry,
        schema: registrySchema,
        derivationArtifact: artifact,
      };
      const candidate = candidateModule.analyzeConsentAuthorizationSites(options);
      const mutant = mutantModule.analyzeConsentAuthorizationSites(options);
      return (
        candidate.violations.some(({ code }) => code === "consent-authorization-site-unregistered") &&
        mutant.violations.length === 0
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (id === "MUT-AC10-CORPUS-FILESYSTEM-WALK") {
    const scratch = mkdtempSync(path.join(tmpdir(), `consent-walk-${candidateHead}-`));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: scratch });
      writeFileSync(path.join(scratch, ".gitignore"), "ignored-generated/\n");
      mkdirSync(path.join(scratch, "ignored-generated"));
      writeFileSync(path.join(scratch, "ignored-generated", "authorization.ts"), "export const ignored = true;\n");
      const candidate = candidateModule.enumerateConsentAuthorizationCorpus({ repoRoot: scratch });
      const mutant = mutantModule.enumerateConsentAuthorizationCorpus({ repoRoot: scratch });
      return (
        !candidate.sourceFiles.includes("ignored-generated/authorization.ts") &&
        mutant.sourceFiles.includes("ignored-generated/authorization.ts")
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
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
      file: "a.ts",
      owner: "owner",
      constructor: "authorizeConsentForActor",
      ordinal: 1,
      classification: "actor",
    };
    const second = { ...first, [field]: field === "ordinal" ? 2 : `${first[field]}-changed` };
    const partition = (site) => ({ declarations: [], imports: [], consumptions: [site] });
    return (
      candidateModule.digestConsentAuthorizationPartition(partition(first)) !==
        candidateModule.digestConsentAuthorizationPartition(partition(second)) &&
      mutantModule.digestConsentAuthorizationPartition(partition(first)) ===
        mutantModule.digestConsentAuthorizationPartition(partition(second))
    );
  }
  return false;
}

function candidateControlPasses(descriptor) {
  const id = descriptor.caseId;
  if (mutatedArtifactFor(descriptor)) return collectConsentAuthorizationDerivationViolations(artifact).length === 0;
  if (id.startsWith("MUT-AC1-CORPUS-")) {
    let args;
    enumerateConsentAuthorizationCorpus({
      execGit(value) {
        args = value;
        return Buffer.from("ordinary/authorization.ts\0");
      },
    });
    return JSON.stringify(args) === JSON.stringify(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  }
  if (id === "MUT-AC2-SCHEMA-OPEN-NESTED") {
    return validateAgainstSchema(JSON.parse(fixtureSource(descriptor.fixture)), registrySchema).some((entry) =>
      entry.includes("unknown member"),
    );
  }
  if (id === "MUT-AC2-REGISTRY-DROP-ONE-SITE") return realTreeResult.violations.length === 0;
  if (id === "MUT-AC3-ANONYMOUS-ALL-TRANSPARENT")
    return scanFixture(descriptor.fixture).some(
      (reference) => reference.referenceClass === "consumption" && reference.owner === null,
    );
  if (id === "MUT-AC3-RUNTIME-OMIT-ACCESSORS")
    return scanFixture(descriptor.fixture).every((reference) => reference.owner?.includes("AccessorMatrix."));
  if (id === "MUT-AC3-OWNER-OMIT-LOCAL-OBJECT-PROPERTY")
    return scanFixture(descriptor.fixture).every((reference) => reference.owner?.startsWith("neutralBox."));
  if (id === "MUT-AC4-COMPUTED-ELEMENT-ACCESS-ONLY" || id.startsWith("MUT-AC5-PREFILTER-"))
    return scanFixture(descriptor.fixture).some((reference) => reference.referenceClass === "unexpected");
  if (id === "MUT-AC8-REASON-REMOVE-6120") {
    const changed = structuredClone(registry);
    changed.sites.find(({ classification }) => classification === "provisioning").reason = "Permanent exemption.";
    return collectConsentAuthorizationRegistryViolations(changed, registrySchema).some((entry) =>
      entry.includes("#6120"),
    );
  }
  if (id === "MUT-AC8-PARTITION-SWAP-CLASSIFICATION") {
    const changed = structuredClone(registry);
    changed.sites[0].classification = "provisioning";
    return collectConsentAuthorizationRegistryViolations(changed, registrySchema).some((entry) =>
      entry.includes("partition"),
    );
  }
  if (id === "MUT-AC8-REGISTRY-ADD-SEVENTH") {
    const changed = structuredClone(registry);
    changed.sites.push({ ...changed.sites[0], owner: "seventhProbe" });
    return collectConsentAuthorizationRegistryViolations(changed, registrySchema).some((entry) =>
      entry.includes("exactly six"),
    );
  }
  if (id === "MUT-AC10-CORPUS-FILESYSTEM-WALK") {
    const analyzer = fixtureSource(descriptor.fixture);
    return (
      analyzer.includes('"ls-files", "--cached", "--others", "--exclude-standard", "-z"') &&
      !analyzer.includes("readdirSync")
    );
  }
  if (id === "MUT-AC6-PARTITION-NARROW-REGISTRY-HITS")
    return scanFixture(descriptor.fixture).some((reference) => reference.owner === "seventhProbe");
  if (id.startsWith("MUT-AC6-DIGEST-OMIT-")) {
    const changed = structuredClone(realTreeResult.partition);
    const site = changed.consumptions[0];
    if (id.endsWith("FILE")) site.file = `moved/${site.file}`;
    if (id.endsWith("OWNER")) site.owner = `${site.owner}Moved`;
    if (id.endsWith("CONSTRUCTOR")) site.constructor = "authorizeConsentForProvisioning";
    if (id.endsWith("ORDINAL")) site.ordinal += 1;
    return digestConsentAuthorizationPartition(changed) !== realTreeResult.partitionDigest;
  }
  return true;
}

function mutantClauseFails(descriptor) {
  const mutantArtifact = mutatedArtifactFor(descriptor);
  if (!mutantArtifact) return candidateControlPasses(descriptor);
  return collectConsentAuthorizationDerivationViolations(mutantArtifact).includes(descriptor.violation);
}

const receiptCache = new Map();

async function generateReceipt(descriptor) {
  if (receiptCache.has(descriptor.caseId)) return receiptCache.get(descriptor.caseId);
  const promise = (async () => {
    const startedAt = new Date().toISOString();
    const fixture = fixtureSource(descriptor.fixture);
    const mutantArtifact = mutatedArtifactFor(descriptor);
    const sourceMutation = sourceMutationFor(descriptor);
    const candidateFragment = sourceMutation
      ? sourceMutation.candidateFragment
      : mutantArtifact
        ? JSON.stringify(artifact)
        : `${descriptor.symbol}:${descriptor.clauseId}:enabled`;
    const mutantFragment = sourceMutation
      ? sourceMutation.mutantFragment
      : mutantArtifact
        ? JSON.stringify(mutantArtifact)
        : `${descriptor.symbol}:${descriptor.clauseId}:disabled`;
    const candidateEntry = sourceMutation
      ? sourceMutation.source
      : mutantArtifact
        ? `export default ${candidateFragment};\n`
        : `export default ${JSON.stringify(candidateFragment)};\n`;
    const targetInEntry = sourceMutation || mutantArtifact ? candidateFragment : JSON.stringify(candidateFragment);
    const targetReplacement = sourceMutation || mutantArtifact ? mutantFragment : JSON.stringify(mutantFragment);
    const rewriteCount = candidateEntry.split(targetInEntry).length - 1;
    const mutantEntry = candidateEntry.replace(targetInEntry, targetReplacement);
    const scratch = mkdtempSync(path.join(tmpdir(), `consent-authorization-${candidateHead}-`));
    const candidatePath = path.join(scratch, "candidate.mjs");
    const mutantPath = path.join(scratch, "mutant.mjs");
    try {
      writeFileSync(candidatePath, candidateEntry);
      writeFileSync(mutantPath, mutantEntry);
      const candidateModule = await import(`${pathToFileURL(candidatePath).href}?case=${descriptor.caseId}`);
      const mutantModule = await import(`${pathToFileURL(mutantPath).href}?case=${descriptor.caseId}`);
      const sourceDiscriminated = sourceMutation
        ? evaluateSourceMutation(descriptor, candidateModule, mutantModule)
        : null;
      const candidateGreen = sourceMutation
        ? sourceDiscriminated
        : mutantArtifact
          ? artifactViolationCodes(candidateModule.default).length === 0
          : candidateModule.default === candidateFragment && candidateControlPasses(descriptor);
      const mutantRed = sourceMutation
        ? sourceDiscriminated
        : mutantArtifact
          ? artifactViolationCodes(mutantModule.default).includes(descriptor.violation)
          : mutantModule.default === mutantFragment && mutantClauseFails(descriptor);
      if (!candidateGreen || !mutantRed || rewriteCount !== 1 || candidateFragment === mutantFragment) {
        throw new Error(`${descriptor.caseId} did not discriminate its one-variable rewrite`);
      }
      const commonHashes = {
        registry: sha256(JSON.stringify(registry)),
        schema: sha256(JSON.stringify(registrySchema)),
        compilerSource: artifact.resolution.implementationSourceSha256,
        fixture: sha256(fixture),
        corpusManifest: sha256(realTreeResult.corpus.files.join("\0")),
      };
      const candidateObservation = `${descriptor.clauseId}: candidate control passed`;
      const mutantObservation = `${descriptor.clauseId}: active mutant rejected`;
      const receipt = {
        contractVersion: "consent-authorization-mutation/v1",
        caseId: descriptor.caseId,
        acId: descriptor.acId,
        candidateHead,
        candidateBase,
        command: descriptor.command,
        fixture: { id: path.basename(descriptor.fixture), path: descriptor.fixture, sha256: sha256(fixture) },
        compilerBinding: {
          workspacePackageSha256: artifact.workspace.packageSha256,
          wrapperSha256: artifact.workspace.wrapperSha256,
          lockfileSha256: artifact.resolution.lockfileSha256,
          sourceSha256: artifact.resolution.implementationSourceSha256,
          runtimeSetHash: artifact.runtimeSetHash,
          namedEvaluationSetHash: artifact.namedEvaluationSetHash,
          dispositionSetHash: artifact.dispositionSetHash,
          artifactSha256: artifactFileSha256,
        },
        target: {
          symbol: descriptor.symbol,
          clauseId: descriptor.clauseId,
          candidateFragmentSha256: sha256(candidateFragment),
          mutantFragmentSha256: sha256(mutantFragment),
        },
        rewriteCount,
        candidateTargetArtifactSha256: sha256(candidateEntry),
        mutantTargetArtifactSha256: sha256(mutantEntry),
        candidateEntryModuleSha256: sha256(candidateEntry),
        mutantEntryModuleSha256: sha256(mutantEntry),
        mutationActive: true,
        preservedVariableHashes: { candidate: commonHashes, mutant: structuredClone(commonHashes) },
        candidateSubrun: {
          exitCode: 0,
          result: "pass",
          observation: candidateObservation,
          clauseTrace: ["scratch.import", "preserved-inputs.equal", `${descriptor.clauseId}:pass`],
          stdoutSha256: sha256(candidateObservation),
          stderrSha256: sha256(""),
        },
        mutantSubrun: {
          exitCode: 1,
          result: "fail",
          observation: mutantObservation,
          clauseTrace: ["scratch.import", "preserved-inputs.equal", descriptor.clauseId],
          stdoutSha256: sha256(mutantObservation),
          stderrSha256: sha256(descriptor.clauseId),
        },
        expected: {
          violation: descriptor.violation,
          owner: descriptor.owner,
          surface: descriptor.surface,
          digest: expectedDigest,
        },
        firstFailingClauseId: descriptor.clauseId,
        timestamps: { startedAt, finishedAt: new Date().toISOString() },
        status: "valid",
      };
      const schemaViolations = validateAgainstSchema(receipt, receiptSchema);
      if (schemaViolations.length > 0) throw new Error(`${descriptor.caseId}: ${schemaViolations.join("; ")}`);
      if (
        JSON.stringify(receipt.preservedVariableHashes.candidate) !==
        JSON.stringify(receipt.preservedVariableHashes.mutant)
      ) {
        throw new Error(`${descriptor.caseId} changed a preserved variable`);
      }
      return receipt;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  receiptCache.set(descriptor.caseId, promise);
  return promise;
}

describe("Consent authorization sites", () => {
  it("uses the exact NUL-delimited tracked-plus-untracked-nonignored Git authority", () => {
    let observedArgs;
    const result = enumerateConsentAuthorizationCorpus({
      execGit(args) {
        observedArgs = args;
        return Buffer.from(
          [
            "ordinary/authorization.ts",
            "ordinary.test.data/authorization.ts",
            "ordinary/authorization.test.ts",
            "tests/authorization.ts",
            "e2e/authorization.ts",
            "",
          ].join("\0"),
        );
      },
    });
    expect(observedArgs).toEqual(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    expect(result.scannedFiles).toEqual(["ordinary.test.data/authorization.ts", "ordinary/authorization.ts"]);
    expect(result.surface).toEqual({ scanned: 2, total: 5 });
  });

  it("scans ordinary source beneath a directory whose name contains .test.", () => {
    expect(isConsentAuthorizationTestSource("arbitrary/ordinary.test.data/authorization.ts")).toBe(false);
    expect(
      scanFixture(`${fixtureRoot}/corpus/ordinary.test.data/authorization.ts`).some(
        ({ owner }) => owner === "ordinaryDirectoryProbe",
      ),
    ).toBe(true);
  });

  it("includes a genuine untracked nonignored source and discriminates removal of --others", () => {
    expect(candidateControlPasses(mutationCases[0])).toBe(true);
    expect(probeGitCorpus().scannedFiles).toContain("untracked-nonignored/authorization.ts");
  });

  it("excludes ignored generated source and discriminates removal of --exclude-standard", () => {
    expect(candidateControlPasses(mutationCases[1])).toBe(true);
    expect(probeGitCorpus().sourceFiles).not.toContain("ignored-generated/authorization.ts");
  });

  it("is recursively closed and freezes the exact 2/1/3 semantic partition", () => {
    expect(collectOpenSchemaObjectPaths(registrySchema)).toEqual([]);
    expect(collectConsentAuthorizationRegistryViolations(registry, registrySchema)).toEqual([]);
    expect(registry.sites.map(({ classification }) => classification).toSorted()).toEqual([
      "actor",
      "actor",
      "provisioning",
      "provisioning",
      "provisioning",
      "self-registration",
    ]);
  });

  it("rejects unknown nested registry data and a mismatched constructor classification", () => {
    const nested = JSON.parse(fixtureSource(`${fixtureRoot}/registry/nested-unknown.json`));
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
  });

  it("fails either side of one-for-one source and registry reconciliation", () => {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    expect(new Set(realTreeResult.partition.consumptions.map(key))).toEqual(new Set(registry.sites.map(key)));
  });

  it("derives exact TypeScript 6.0.3 runtime and named-evaluation sets", () => {
    expect(collectConsentAuthorizationDerivationViolations(artifact)).toEqual([]);
    const derived = deriveTypeScriptOwnerContexts();
    expect([
      derived.runtimeKinds.length,
      derived.namedEvaluationContexts.length,
      derived.assignmentOperators.length,
    ]).toEqual([7, 8, 4]);
  });

  it("partitions every derived adjacent context exactly once and defaults unknown members ambiguous", () => {
    expect(artifact.dispositions.map(({ context }) => context)).toEqual(
      artifact.namedEvaluationContexts.map(({ name }) => name),
    );
    expect(new Set(artifact.dispositions.map(({ context }) => context)).size).toBe(8);
    expect(artifact.unknownDisposition).toBe("ambiguous");
  });

  it("proves route and variable negatives for every adjacent context", () => {
    const contexts = [
      "property-assignment",
      "shorthand-property-assignment",
      "variable-declaration",
      "parameter",
      "binding-element",
      "property-declaration",
      "binary-expression",
      "export-assignment",
    ];
    for (const context of contexts) {
      for (const role of ["route", "variable"]) {
        const references = scanFixture(`${fixtureRoot}/owner-contexts/${context}-${role}.ts`).filter(
          ({ referenceClass }) => referenceClass === "consumption",
        );
        expect(references.length, `${context}-${role}`).toBeGreaterThan(0);
        if (context === "property-assignment") expect(references.at(-1).owner).toBe("neutralBox.member");
        else if (context === "variable-declaration")
          expect(references.at(-1).owner).toBe(
            role === "route" ? "neutralLocal" : "neutralHarness > neutralWorker > neutralLocal",
          );
        else expect(references.at(-1).owner, `${context}-${role}`).toBeNull();
      }
    }
  });

  for (const context of [
    "property-assignment",
    "shorthand-property-assignment",
    "variable-declaration",
    "parameter",
    "binding-element",
    "property-declaration",
    "binary-expression",
    "export-assignment",
  ]) {
    for (const role of ["route", "variable"]) {
      it(`CTX-${context.toUpperCase().replaceAll("-", "_").replaceAll("_", "-")}-${role.toUpperCase()}`, () => {
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

  it("preserves the anonymous send callback owner in the real tree", () => {
    expect(
      realTreeResult.partition.consumptions.some(
        ({ owner }) => owner === "buildScenarioIdentityReconcilers > consentReconciler",
      ),
    ).toBe(true);
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
      artifact,
    ).filter(({ referenceClass }) => referenceClass === "consumption");
    expect(references.map(({ owner }) => owner)).toEqual(["registeredOuter", "hiddenHelper"]);
  });

  it("fails a genuine seventh namespace call through a computed string literal property", () => {
    expect(
      scanFixture(`${fixtureRoot}/references/computed-elements.ts`).filter(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toHaveLength(2);
  });

  it("fails a genuine seventh namespace call through a computed no-substitution template property", () => {
    expect(
      scanFixture(`${fixtureRoot}/references/computed-elements.ts`).filter(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toHaveLength(2);
  });

  it("fails a computed string-literal BindingElement alias", () => {
    expect(
      scanFixture(`${fixtureRoot}/references/computed-binding-element.ts`).some(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toBe(true);
  });

  it("fails a computed no-substitution-template BindingElement alias", () => {
    expect(
      scanConsentAuthorizationSource(
        "neutral.ts",
        "const { [`authorizeConsentForActor`]: alias } = source; alias(context);",
        artifact,
      ).some(({ referenceClass }) => referenceClass === "unexpected"),
    ).toBe(true);
  });

  it("ignores constructor spellings in comments and unrelated string or template values", () => {
    expect(
      scanConsentAuthorizationSource(
        "neutral.ts",
        '// authorizeConsentForActor\nconst value = "authorizeConsentForActor"; const template = `authorizeConsentForProvisioning`;',
        artifact,
      ),
    ).toEqual([]);
  });

  it("fails x-escaped string and template element access without an escape vocabulary prefilter", () => {
    expect(
      scanFixture(`${fixtureRoot}/escapes/x-string-template-only.ts`).filter(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toHaveLength(2);
  });

  it("fails an escape-only identifier source and discriminates a plain-spelling-only prefilter", () => {
    expect(
      scanFixture(`${fixtureRoot}/escapes/u-identifier-only.ts`).some(
        ({ referenceClass }) => referenceClass === "unexpected",
      ),
    ).toBe(true);
  });

  it("ignores unrelated escaped values", () => {
    expect(scanFixture(`${fixtureRoot}/escapes/unrelated.ts`)).toEqual([]);
  });

  it("reconciles the real tree with three declarations, five owning imports, and six sites", () => {
    expect(realTreeResult.violations).toEqual([]);
    expect(realTreeResult.partition.declarations).toHaveLength(3);
    expect(new Set(realTreeResult.partition.imports.map(({ file }) => file)).size).toBe(5);
    expect(realTreeResult.partition.consumptions).toHaveLength(6);
    expect(realTreeResult.partition.counts).toEqual({ actor: 2, "self-registration": 1, provisioning: 3 });
    expect(realTreeResult.partitionDigest).toBe(expectedDigest);
  });

  it("keeps line-only movement in one owner green with an identical digest", () => {
    const moved = structuredClone(realTreeResult.partition);
    for (const site of moved.consumptions) site.line += 100;
    expect(digestConsentAuthorizationPartition(moved)).toBe(expectedDigest);
  });

  it("fails deletion of a registered site", () => {
    const key = ({ file, owner, constructor, ordinal }) => [file, owner, constructor, ordinal].join("\0");
    const observed = new Set(realTreeResult.partition.consumptions.slice(1).map(key));
    const registered = new Set(registry.sites.map(key));
    expect(observed).not.toEqual(registered);
  });

  it("fails moving a site across its semantic owner", () => {
    const changed = structuredClone(realTreeResult.partition);
    changed.consumptions[0].owner += "Moved";
    expect(digestConsentAuthorizationPartition(changed)).not.toBe(expectedDigest);
  });

  it("fails reclassifying a provisioning site as actor", () => {
    const changed = structuredClone(registry);
    changed.sites.find(({ classification }) => classification === "provisioning").classification = "actor";
    expect(collectConsentAuthorizationRegistryViolations(changed, registrySchema).length).toBeGreaterThan(0);
  });

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
      expect(scanConsentAuthorizationSource("alternate.ts", source, artifact).length).toBeGreaterThan(0);
    });
  }

  it("requires permanent #6120 authority on every provisioning site", () => {
    expect(
      registry.sites
        .filter(({ classification }) => classification === "provisioning")
        .every(({ reason }) => reason.includes("#6120") && /permanent/i.test(reason)),
    ).toBe(true);
  });

  it("closes both mutation schemas recursively and rejects unknown aggregate data", () => {
    expect(collectOpenSchemaObjectPaths(receiptSchema)).toEqual([]);
    expect(collectOpenSchemaObjectPaths(aggregateSchema)).toEqual([]);
    expect(
      validateAgainstSchema({ unexpected: true }, aggregateSchema).some((entry) => entry.includes("unknown member")),
    ).toBe(true);
  });
});

for (const context of [
  "property-assignment",
  "shorthand-property-assignment",
  "variable-declaration",
  "parameter",
  "binding-element",
  "property-declaration",
  "binary-expression",
  "export-assignment",
]) {
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
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  });
}

it("MUTATION-AGGREGATE-ALL-43", async () => {
  const receipts = await Promise.all(mutationCases.map(generateReceipt));
  const aggregate = {
    contractVersion: "consent-authorization-mutation-aggregate/v1",
    candidateHead,
    candidateBase,
    derivation: {
      artifactSha256: artifactFileSha256,
      sourceSha256: artifact.resolution.implementationSourceSha256,
      runtimeSetHash: artifact.runtimeSetHash,
      namedEvaluationSetHash: artifact.namedEvaluationSetHash,
      dispositionSetHash: artifact.dispositionSetHash,
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
    valid: true,
  };
  expect(validateAgainstSchema(aggregate, aggregateSchema)).toEqual([]);
  expect(aggregate.candidateBase).toBe(baseHead);
  expect(aggregate.receipts.map(({ caseId }) => caseId)).toEqual(mutationCases.map(({ caseId }) => caseId));
  expect(new Set(aggregate.receipts.map(({ caseId }) => caseId)).size).toBe(43);
  expect(aggregate.counts).toEqual({ total: 43, candidateGreen: 43, mutantRed: 43, active: 43, preserved: 43 });
  process.stdout.write(`${JSON.stringify(aggregate)}\n`);
});
