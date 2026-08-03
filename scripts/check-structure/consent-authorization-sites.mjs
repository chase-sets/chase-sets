import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { GuardCandidateProvenanceError, deriveGuardCandidateProvenance } from "./guard-candidate-provenance.mjs";
import {
  compareTypeScriptOwnerContexts,
  deriveTypeScriptOwnerContexts,
  loadTypeScriptOwnerContextArtifact,
  loadTypeScriptOwnerContextPartition,
  loadTypeScriptOwnerContextSchema,
} from "./typescript-owner-context-derivation.mjs";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

export const consentAuthorizationRegistryPath = "scripts/check-structure/consent-authorization-site-registry.json";
export const consentAuthorizationRegistrySchemaPath =
  "scripts/check-structure/consent-authorization-site-registry.schema.json";
export const consentAuthorizationCaseEnumerationPath =
  "scripts/check-structure/consent-authorization-case-enumeration.json";
export const consentAuthorizationCensusCoveragePath =
  "scripts/check-structure/consent-authorization-census-coverage.json";
export const consentAuthorizationCensusCoverageSchemaPath =
  "scripts/check-structure/consent-authorization-census-coverage.schema.json";
export const consentAuthorizationCensusFixtureRoot =
  "scripts/check-structure/fixtures/consent-authorization-sites/census";

export const consentAuthorizationConstructors = Object.freeze([
  "authorizeConsentForActor",
  "authorizeConsentForSelfRegistration",
  "authorizeConsentForProvisioning",
]);

const constructorClassifications = new Map([
  [consentAuthorizationConstructors[0], "actor"],
  [consentAuthorizationConstructors[1], "self-registration"],
  [consentAuthorizationConstructors[2], "provisioning"],
]);
const constructorNames = new Set(consentAuthorizationConstructors);
const declarationFile = "bounded-contexts/identity/features/consents/domain/consent-recording-authorization.ts";
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const commitShaPattern = /^[0-9a-f]{40}$/;

/**
 * The candidate corpus is bounded by an extension set, so that set is a derived
 * grammar member and is derived from the compiler API the guard already parses
 * with: `ts.Extension` is the compiler's own total enumeration of the
 * extensions it recognises. Every member is dispositioned here by name, and
 * `assertConsentAuthorizationExtensionDisposition` fails closed the moment the
 * enumeration and this table disagree in either direction, so a compiler
 * upgrade that introduces a module extension turns the guard red rather than
 * silently narrowing the surface it claims to have censused.
 *
 * Every extension that names a JavaScript or TypeScript module is scanned,
 * because any of them can carry a call expression: `.mts` and `.d.mts` are
 * carried by the candidate head today, and `.cts`, `.d.cts`, `.js`, `.jsx` and
 * `.cjs` are admitted by the grammar that supports them rather than by whether
 * a file using one happens to exist. `.json` and `.tsbuildinfo` are the only
 * excluded members: neither is a module, so neither can hold a consumption.
 */
export const consentAuthorizationExtensionDispositions = Object.freeze(
  [
    { extension: ts.Extension.Ts, scriptKind: "TS", reason: "TypeScript module" },
    { extension: ts.Extension.Dts, scriptKind: "TS", reason: "TypeScript declaration module" },
    { extension: ts.Extension.Tsx, scriptKind: "TSX", reason: "TypeScript module with JSX syntax" },
    { extension: ts.Extension.Mts, scriptKind: "TS", reason: "TypeScript ECMAScript module" },
    { extension: ts.Extension.Dmts, scriptKind: "TS", reason: "TypeScript ECMAScript declaration module" },
    { extension: ts.Extension.Cts, scriptKind: "TS", reason: "TypeScript CommonJS module" },
    { extension: ts.Extension.Dcts, scriptKind: "TS", reason: "TypeScript CommonJS declaration module" },
    { extension: ts.Extension.Js, scriptKind: "JS", reason: "JavaScript module" },
    { extension: ts.Extension.Jsx, scriptKind: "JSX", reason: "JavaScript module with JSX syntax" },
    { extension: ts.Extension.Mjs, scriptKind: "JS", reason: "JavaScript ECMAScript module" },
    { extension: ts.Extension.Cjs, scriptKind: "JS", reason: "JavaScript CommonJS module" },
    { extension: ts.Extension.Json, scriptKind: null, reason: "data document, never a module that can call" },
    { extension: ts.Extension.TsBuildInfo, scriptKind: null, reason: "build metadata, never a module that can call" },
  ].map((entry) => Object.freeze({ ...entry, scanned: entry.scriptKind !== null })),
);

// Longest first, so `.d.mts` is never decided by the `.mts` arm and
// `.tsbuildinfo` is never decided by the `.ts` arm.
const dispositionsByLongestExtension = consentAuthorizationExtensionDispositions.toSorted(
  (left, right) => right.extension.length - left.extension.length,
);

/**
 * Governing clause of MUT-AC10-EXTENSION-DISPOSITION-OPEN. The committed
 * disposition must cover the compiler's enumeration exactly; a member on either
 * side alone is an unresolved grammar, not a narrower corpus.
 */
export function assertConsentAuthorizationExtensionDisposition(enumerated = Object.values(ts.Extension)) {
  const dispositioned = consentAuthorizationExtensionDispositions.map(({ extension }) => extension);
  const undispositioned = enumerated.filter((extension) => !dispositioned.includes(extension));
  const unenumerated = dispositioned.filter((extension) => !enumerated.includes(extension));
  if (undispositioned.length > 0 || unenumerated.length > 0) {
    throw guardFailure(
      "consent-authorization-extension-disposition-partial",
      "corpus.extension-disposition",
      "the committed extension disposition does not cover the compiler's enumerated extension set exactly",
      { undispositioned, unenumerated },
    );
  }
  return consentAuthorizationExtensionDispositions;
}

export function consentAuthorizationExtensionDisposition(file) {
  const normalized = normalizePath(file);
  return dispositionsByLongestExtension.find((entry) => normalized.endsWith(entry.extension)) ?? null;
}

/**
 * The guard asserts about the tree named by `candidateHead`, never about the
 * tree it happens to be executing over. `analyzedTree` is recorded as
 * provenance and asserted about nowhere, so a pull-request synthetic merge
 * commit never becomes semantic authority. The candidate-provenance module
 * already resolves this role for every classified checkout --
 * `landingCandidate` is `pull_request.head.sha` under `pull_request`,
 * `merge_group.head_sha` under `merge_group`, and exact `HEAD` in a plain
 * checkout -- so this guard reads that role rather than adding a second
 * resolution path of its own.
 */
export const candidateHeadProvenanceRole = "landingCandidate";

/**
 * A value resolved at run time from Git is recorded, never compared against a
 * committed literal. This expectation set is empty by construction, and its
 * emptiness is the property the guard's suite asserts: a single entry here is
 * exactly the frozen-base-constant defect that turns an unchanged authority red
 * the moment ordinary unrelated movement of the base branch lands. It is
 * declared rather than omitted so that the negative control has an arbitrary
 * literal of its own to supply and can therefore discriminate.
 */
export const frozenProvenanceExpectations = Object.freeze([]);

export class ConsentAuthorizationGuardError extends Error {
  constructor(code, reachedClause, message, details = {}) {
    super(message);
    this.name = "ConsentAuthorizationGuardError";
    this.code = code;
    this.reachedClause = reachedClause;
    this.details = details;
  }
}

function guardFailure(code, reachedClause, message, details = {}) {
  return new ConsentAuthorizationGuardError(code, reachedClause, message, details);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The clause each reported violation code is decided at. The guard publishes
 * the clause alongside the code so that a first failing clause is read off an
 * executed run rather than asserted about it: a mutation receipt that claims a
 * governing clause must be able to point at the clause the guard actually
 * reached first.
 */
export const consentAuthorizationClauseByCode = Object.freeze({
  "consent-authorization-registry-invalid": "registry.committed-rows",
  "consent-authorization-provenance-frozen-mismatch": "provenance.frozen-expectations",
  "consent-authorization-coverage-invalid": "coverage.committed-rows",
  "consent-authorization-declaration-invalid": "declaration.expected-exports",
  "consent-authorization-declaration-missing": "declaration.expected-exports",
  "consent-authorization-owner-ambiguous": "owner.stability",
  "consent-authorization-site-unregistered": "reconciliation.observed-completeness",
  "consent-authorization-site-missing": "reconciliation.registry-completeness",
  "consent-authorization-import-invalid": "reference.owning-import",
  "consent-authorization-import-missing": "reference.owning-import",
  "consent-authorization-reference-unclassified": "reference.classification",
  "consent-authorization-noncanonical-module-access": "reference.canonical-module-binding",
  "consent-authorization-partition-drift": "reconciliation.partition-digest",
  "consent-authorization-mutation-enumeration-drift": "mutation.enumeration",
  "consent-authorization-mutation-count-drift": "mutation.enumeration",
  "consent-authorization-mutation-incomplete": "mutation.enumeration",
  "consent-authorization-mutation-provenance-missing": "mutation.receipt-provenance",
  "consent-authorization-mutation-provenance-mismatch": "mutation.receipt-provenance",
  "consent-authorization-mutation-receipt-digest-mismatch": "mutation.receipt-binding",
});

// Owner-context authority failures are named by the derivation module, which
// owns their vocabulary; they are all reached at the one clause this guard
// consults it at.
const ownerContextClause = "derivation.owner-context-authority";

function finding(code, message, details = {}) {
  return {
    code,
    clause:
      consentAuthorizationClauseByCode[code] ?? (code.startsWith("derivation-artifact-") ? ownerContextClause : null),
    message,
    ...details,
  };
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

export function loadConsentAuthorizationRegistry(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.registryPath ?? consentAuthorizationRegistryPath);
}

export function loadConsentAuthorizationRegistrySchema(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.schemaPath ?? consentAuthorizationRegistrySchemaPath);
}

export function loadConsentAuthorizationCaseEnumeration(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.enumerationPath ?? consentAuthorizationCaseEnumerationPath);
}

export function loadConsentAuthorizationCensusCoverage(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.coveragePath ?? consentAuthorizationCensusCoveragePath);
}

export function loadConsentAuthorizationCensusCoverageSchema(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.schemaPath ?? consentAuthorizationCensusCoverageSchemaPath);
}

function defaultExecGit(args, rootDir, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
    ...options,
  });
}

function gitBuffer(execGit, args, reachedClause, options) {
  let raw;
  try {
    raw = execGit(args, options);
  } catch (error) {
    throw guardFailure(
      "consent-authorization-corpus-unavailable",
      reachedClause,
      `git ${args.join(" ")} could not be executed`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (raw === undefined || raw === null) {
    throw guardFailure(
      "consent-authorization-corpus-unavailable",
      reachedClause,
      `git ${args.join(" ")} returned no output`,
    );
  }
  return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
}

/* ------------------------------------------------------------------------ */
/* Provenance -- consumed from guard-candidate-provenance.mjs, never re-derived */
/* ------------------------------------------------------------------------ */

export function deriveConsentAuthorizationProvenanceOutcome(deriveProvenance) {
  try {
    return { ok: true, provenance: deriveProvenance(), code: null, reachedClause: null, message: null };
  } catch (error) {
    if (error instanceof GuardCandidateProvenanceError) {
      return {
        ok: false,
        provenance: null,
        code: error.code,
        reachedClause: error.reachedClause,
        message: error.message,
      };
    }
    return {
      ok: false,
      provenance: null,
      code: "guard-provenance-unavailable",
      reachedClause: "unexpected-failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Governing clause of MUT-PROV-ACCEPT-UNRESOLVED. Only a successfully derived
 * provenance record may pass; every candidate-provenance failure is surfaced
 * under the name that module assigned it and exits nonzero, and there is no
 * fallback record.
 */
export function requireResolvedProvenance(outcome) {
  if (!outcome.ok) {
    throw guardFailure(
      "consent-authorization-provenance-unresolved",
      outcome.reachedClause,
      `guard candidate provenance failed as ${outcome.code} at ${outcome.reachedClause}: ${outcome.message}`,
      { provenanceCode: outcome.code },
    );
  }
  return outcome.provenance;
}

/**
 * The owner-context derivation module owns the compiler grammar. Its committed
 * total key partition decides which keys are semantic compiler identity and
 * which are environmental provenance, and only the semantic keys are compared
 * -- which is exactly what keeps a lockfile-only change green. Governing
 * variable of MUT-ARTIFACT-COMPARE-ENVIRONMENTAL.
 */
export function consentAuthorizationOwnerContextComparedKeys(partition) {
  return partition.semantic;
}

export function collectFrozenProvenanceViolations(provenance, expectations = frozenProvenanceExpectations) {
  const violations = [];
  for (const expectation of expectations) {
    const observed = provenance?.roles?.[expectation.role]?.sha ?? null;
    if (observed !== expectation.sha) {
      violations.push(
        finding(
          "consent-authorization-provenance-frozen-mismatch",
          `${expectation.role} does not equal its frozen committed expectation`,
          { role: expectation.role, expected: expectation.sha, observed },
        ),
      );
    }
  }
  return violations;
}

export function resolveConsentAuthorizationCandidateHead(provenance) {
  const role = provenance?.roles?.[candidateHeadProvenanceRole] ?? null;
  const sha = role?.sha ?? null;
  if (typeof sha !== "string" || !commitShaPattern.test(sha)) {
    throw guardFailure(
      "consent-authorization-candidate-head-invalid",
      "candidate-head-role",
      `provenance role ${candidateHeadProvenanceRole} did not supply a full lowercase commit sha`,
      { role: candidateHeadProvenanceRole, observed: sha },
    );
  }
  return { sha, source: role.source ?? null };
}

/* ------------------------------------------------------------------------ */
/* Corpus -- enumerated from the candidate-head object, never a filesystem walk */
/* ------------------------------------------------------------------------ */

export function isConsentAuthorizationTestSource(relativeFile) {
  const normalized = normalizePath(relativeFile);
  const basename = path.posix.basename(normalized);
  const segments = normalized.split("/");
  return (
    basename.includes(".test.") ||
    segments.includes("tests") ||
    segments.includes("e2e") ||
    normalized.startsWith("scripts/check-structure/fixtures/")
  );
}

function isCandidateSourceExtension(file) {
  return consentAuthorizationExtensionDisposition(file)?.scanned === true;
}

function parseTreeEntries(raw) {
  const entries = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(" ");
    entries.push({ type, oid, file: normalizePath(record.slice(tab + 1)) });
  }
  return entries;
}

function parseBatchPayload(raw, entries) {
  const contents = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = raw.indexOf(10, offset);
    if (newline < 0) {
      throw guardFailure(
        "consent-authorization-corpus-unavailable",
        "candidate-head-blob-batch",
        `git cat-file --batch ended before ${entry.file}`,
      );
    }
    const header = raw.toString("utf8", offset, newline).split(" ");
    if (header.length !== 3 || header[1] !== "blob") {
      throw guardFailure(
        "consent-authorization-corpus-unavailable",
        "candidate-head-blob-batch",
        `git cat-file --batch did not return a blob for ${entry.file}`,
        { header: header.join(" ") },
      );
    }
    const start = newline + 1;
    const size = Number(header[2]);
    contents.set(entry.file, raw.toString("utf8", start, start + size));
    offset = start + size + 1;
  }
  return contents;
}

/**
 * Governing clause of MUT-AC10-CORPUS-FILESYSTEM-WALK and
 * MUT-CORPUS-BIND-ANALYZED-TREE. The tracked surface is an object query against
 * the exact candidate-head commit, so a built worktree and a clean worktree
 * yield the identical partition, and generated modules that the index never
 * carried can never enter.
 */
export function enumerateConsentAuthorizationCorpus({
  repoRoot: rootDir = repoRoot,
  execGit = (args, options) => defaultExecGit(args, rootDir, options),
  candidateHead,
  environment = "plain",
} = {}) {
  if (typeof candidateHead !== "string" || !commitShaPattern.test(candidateHead)) {
    throw guardFailure(
      "consent-authorization-candidate-head-invalid",
      "candidate-head-argument",
      "the corpus requires a full lowercase candidate-head commit sha",
      { observed: candidateHead ?? null },
    );
  }
  assertConsentAuthorizationExtensionDisposition();

  let existence;
  try {
    existence = execGit(["cat-file", "-e", `${candidateHead}^{commit}`]);
  } catch (error) {
    existence = { status: Number.isInteger(error?.status) ? error.status : 1 };
  }
  if (existence && Number.isInteger(existence.status) && existence.status !== 0) {
    throw guardFailure(
      "consent-authorization-candidate-head-unresolved",
      "candidate-head-object",
      `the candidate-head object ${candidateHead} could not be resolved and the guard never falls back to HEAD`,
      { candidateHead },
    );
  }

  const treeEntries = parseTreeEntries(
    gitBuffer(execGit, ["ls-tree", "-r", "-z", candidateHead], "candidate-head-tree"),
  )
    .filter((entry) => entry.type === "blob")
    .filter((entry) => isCandidateSourceExtension(entry.file));

  const unionsUntrackedNonignored = environment === "plain";
  const untrackedFiles = unionsUntrackedNonignored
    ? [
        ...new Set(
          gitBuffer(execGit, ["ls-files", "--others", "--exclude-standard", "-z"], "untracked-nonignored")
            .toString("utf8")
            .split("\0")
            .filter(Boolean)
            .map(normalizePath),
        ),
      ]
        .filter(isCandidateSourceExtension)
        .filter((file) => !treeEntries.some((entry) => entry.file === file))
        .sort()
    : [];

  const sourceFiles = [...treeEntries.map((entry) => entry.file), ...untrackedFiles].sort();
  const scannedTreeEntries = treeEntries
    .filter((entry) => !isConsentAuthorizationTestSource(entry.file))
    .toSorted((left, right) => left.file.localeCompare(right.file));
  const scannedUntracked = untrackedFiles.filter((file) => !isConsentAuthorizationTestSource(file));
  const scannedFiles = [...scannedTreeEntries.map((entry) => entry.file), ...scannedUntracked].sort();

  return {
    candidateHead,
    environment,
    treeEntries: scannedTreeEntries,
    untrackedFiles: scannedUntracked,
    sourceFiles,
    scannedFiles,
    unionsUntrackedNonignored,
    scannedExtensions: consentAuthorizationExtensionDispositions
      .filter(({ scanned }) => scanned)
      .map(({ extension }) => extension),
    surface: { scanned: scannedFiles.length, total: sourceFiles.length },
  };
}

export function readConsentAuthorizationCorpusSources({
  repoRoot: rootDir = repoRoot,
  execGit = (args, options) => defaultExecGit(args, rootDir, options),
  corpus,
}) {
  const contents =
    corpus.treeEntries.length === 0
      ? new Map()
      : parseBatchPayload(
          gitBuffer(execGit, ["cat-file", "--batch", "--buffer"], "candidate-head-blob-batch", {
            input: Buffer.from(`${corpus.treeEntries.map((entry) => entry.oid).join("\n")}\n`, "utf8"),
          }),
          corpus.treeEntries,
        );
  for (const file of corpus.untrackedFiles) {
    contents.set(file, readFileSync(path.join(rootDir, file), "utf8"));
  }
  return contents;
}

/* ------------------------------------------------------------------------ */
/* Reference and owner derivation                                            */
/* ------------------------------------------------------------------------ */

function scriptKindFor(file) {
  const disposition = consentAuthorizationExtensionDisposition(file);
  if (!disposition?.scanned) {
    throw guardFailure(
      "consent-authorization-script-kind-unresolved",
      "parsing.script-kind",
      `${file} has no committed scanned script kind, so it cannot be parsed under a guessed grammar`,
      { file, disposition: disposition?.extension ?? null },
    );
  }
  return ts.ScriptKind[disposition.scriptKind];
}

function modifiersInclude(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function lineFor(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function decodedMemberName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return null;
}

function isRuntimeFunctionLike(node, runtimeKindSet) {
  return runtimeKindSet.has(node.kind) && ts.isFunctionLike(node) && Boolean(node.body);
}

function containingRuntimeFunctions(node, runtimeKindSet) {
  const values = [];
  for (let current = node.parent; current; current = current.parent) {
    if (isRuntimeFunctionLike(current, runtimeKindSet)) values.push(current);
  }
  return values;
}

function routeOwner(node, runtimeKindSet, resolveOuter) {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node) || !ts.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const method = call.expression.name.text.toUpperCase();
  const route = call.arguments[0];
  if (!httpMethods.has(method) || !ts.isStringLiteral(route)) return null;
  const outer = resolveOuter(node);
  if (outer.status !== "stable") return { status: "ambiguous" };
  return { status: "stable", owner: `${outer.owner} > ${method} ${route.text}` };
}

function isWithinCallOrNewArgument(node) {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.arguments?.some(
        (argument) => current === argument || (current.pos >= argument.pos && current.end <= argument.end),
      )
    ) {
      return true;
    }
    if (
      !ts.isParenthesizedExpression(parent) &&
      !ts.isObjectLiteralExpression(parent) &&
      !ts.isPropertyAssignment(parent)
    ) {
      if (ts.isStatement(parent) || ts.isFunctionLike(parent)) return false;
    }
  }
  return false;
}

function locallyRootedObjectOwner(node) {
  let member;
  let objectLiteral;
  let suffix;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    member = decodedMemberName(node.name);
    objectLiteral = node.parent;
    suffix = ts.isMethodDeclaration(node) ? "method" : ts.isGetAccessorDeclaration(node) ? "get" : "set";
  } else if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isPropertyAssignment(node.parent) &&
    node.parent.initializer === node
  ) {
    member = decodedMemberName(node.parent.name);
    if (member === "__proto__") return { status: "ambiguous" };
    objectLiteral = node.parent.parent;
    suffix = "";
  } else {
    return null;
  }
  if (!member || !ts.isObjectLiteralExpression(objectLiteral)) return { status: "ambiguous" };
  const formattedMember =
    suffix === "method"
      ? `${member}()`
      : suffix === "get"
        ? `get ${member}`
        : suffix === "set"
          ? `set ${member}`
          : member;
  const members = [formattedMember];
  let current = objectLiteral;
  while (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) {
    const name = decodedMemberName(current.parent.name);
    if (!name) return { status: "ambiguous" };
    members.unshift(name);
    current = current.parent.parent;
    if (!ts.isObjectLiteralExpression(current)) return { status: "ambiguous" };
  }
  if (
    ts.isVariableDeclaration(current.parent) &&
    current.parent.initializer === current &&
    ts.isIdentifier(current.parent.name)
  ) {
    const tail = members.join(".");
    return { status: "stable", owner: `${current.parent.name.text}.${tail}` };
  }
  return { status: "unrooted", objectLiteral };
}

function classMemberOwner(node) {
  if (
    !ts.isConstructorDeclaration(node) &&
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return null;
  }
  const classNode = node.parent;
  if (!ts.isClassDeclaration(classNode) && !ts.isClassExpression(classNode)) return null;
  let className = classNode.name?.text ?? null;
  if (
    !className &&
    ts.isVariableDeclaration(classNode.parent) &&
    classNode.parent.initializer === classNode &&
    ts.isIdentifier(classNode.parent.name)
  ) {
    className = classNode.parent.name.text;
  }
  if (!className) return { status: "ambiguous" };
  const staticPrefix = modifiersInclude(node, ts.SyntaxKind.StaticKeyword) ? "static." : "";
  if (ts.isConstructorDeclaration(node)) {
    return { status: "stable", owner: `${className}.${staticPrefix}constructor` };
  }
  const name = decodedMemberName(node.name);
  if (!name) return { status: "ambiguous" };
  const member = ts.isMethodDeclaration(node)
    ? `${name}()`
    : ts.isGetAccessorDeclaration(node)
      ? `get ${name}`
      : `set ${name}`;
  return { status: "stable", owner: `${className}.${staticPrefix}${member}` };
}

function namedEvaluationContext(node, namedKindSet) {
  const parent = node.parent;
  return namedKindSet.has(parent?.kind) ? parent : null;
}

export function deriveConsentAuthorizationOwner(node, artifact) {
  const runtimeKindSet = new Set(artifact.runtimeKinds.map(({ kind }) => kind));
  const namedKindSet = new Set(artifact.namedEvaluationContexts.map(({ kind }) => kind));
  const boundaries = containingRuntimeFunctions(node, runtimeKindSet);

  const resolveFrom = (startIndex) => {
    for (let index = startIndex; index < boundaries.length; index += 1) {
      const boundary = boundaries[index];
      const resolveOuter = () => resolveFrom(index + 1);

      if ((ts.isFunctionDeclaration(boundary) || ts.isFunctionExpression(boundary)) && boundary.name) {
        const name = decodedMemberName(boundary.name);
        return name ? { status: "stable", owner: name } : { status: "ambiguous" };
      }

      const route = routeOwner(boundary, runtimeKindSet, resolveOuter);
      if (route) return route;

      const classOwner = classMemberOwner(boundary);
      if (classOwner) return classOwner;

      const objectOwner = locallyRootedObjectOwner(boundary);
      if (objectOwner?.status === "stable") return objectOwner;
      if (objectOwner?.status === "ambiguous") return objectOwner;

      const context = namedEvaluationContext(boundary, namedKindSet);
      if (context) {
        switch (context.kind) {
          case ts.SyntaxKind.PropertyAssignment:
            if (
              objectOwner?.status === "unrooted" &&
              isWithinCallOrNewArgument(objectOwner.objectLiteral) &&
              !boundary.name
            ) {
              continue;
            }
            return { status: "ambiguous" };
          case ts.SyntaxKind.VariableDeclaration:
            if (ts.isIdentifier(context.name) && context.initializer === boundary) {
              const outer = resolveOuter();
              return {
                status: "stable",
                owner:
                  outer.status === "stable" && outer.owner !== "<module>"
                    ? `${outer.owner} > ${context.name.text}`
                    : context.name.text,
              };
            }
            return { status: "ambiguous" };
          case ts.SyntaxKind.ShorthandPropertyAssignment:
          case ts.SyntaxKind.Parameter:
          case ts.SyntaxKind.BindingElement:
          case ts.SyntaxKind.PropertyDeclaration:
          case ts.SyntaxKind.BinaryExpression:
          case ts.SyntaxKind.ExportAssignment:
          default:
            return { status: "ambiguous" };
        }
      }

      if (
        (ts.isArrowFunction(boundary) || ts.isFunctionExpression(boundary)) &&
        !boundary.name &&
        isWithinCallOrNewArgument(boundary)
      ) {
        continue;
      }
      return { status: "ambiguous" };
    }
    return { status: "stable", owner: "<module>" };
  };

  const resolved = resolveFrom(0);
  return resolved.status === "stable" ? resolved.owner : null;
}

function importDetails(node) {
  const specifier = node.parent;
  if (!ts.isImportSpecifier(specifier) || (specifier.name !== node && specifier.propertyName !== node)) {
    return null;
  }
  let declaration = specifier.parent;
  while (declaration && !ts.isImportDeclaration(declaration)) declaration = declaration.parent;
  const source = declaration && ts.isStringLiteral(declaration.moduleSpecifier) ? declaration.moduleSpecifier.text : "";
  return {
    source,
    localName: specifier.name.text,
    importedName: specifier.propertyName?.text ?? specifier.name.text,
    aliased: Boolean(specifier.propertyName),
    typeOnly: specifier.isTypeOnly || declaration?.importClause?.isTypeOnly || false,
  };
}

/**
 * Every census-visible reference carries the identity of the analyzer arm that
 * decided it, at the granularity one committed coverage row is written at. The
 * arm is what the coverage matrix is total against: a branch that can decide a
 * reference and carries no row, or a row naming an arm no branch can reach,
 * fails closed. A declaration and a bare identifier reference in a position
 * that is neither a key nor an acquisition specifier carry no arm, because
 * neither is a member of either axis grammar.
 */
function computedConstructorProperty(node) {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
  if (!constructorNames.has(node.text)) return null;
  if (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) {
    return { constructor: node.text, axis: "key", arm: "computed-property:element-access" };
  }
  if (
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
  }
  return null;
}

/* -- Canonical-module bindings and constant keys -------------------------- */

const declarationModulePath = declarationFile.slice(0, -path.extname(declarationFile).length);

/**
 * A specifier reaches the canonical module when it resolves onto the
 * declaration module's path, with or without a written extension. This is
 * deliberately broader than the canonical-import check in
 * `resolvesToDeclarationModule`: that clause decides whether a named import is
 * the one canonical binding and must stay exact, while this clause decides
 * whether a non-canonical form reached the module at all, where a wider net
 * only ever reports more.
 */
function reachesCanonicalModule(relativeFile, specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(normalizePath(relativeFile)), normalizePath(specifier)),
  );
  const disposition = consentAuthorizationExtensionDisposition(resolved);
  const withoutExtension = disposition ? resolved.slice(0, -disposition.extension.length) : resolved;
  return resolved === declarationModulePath || withoutExtension === declarationModulePath;
}

function canonicalSpecifierText(node) {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

/**
 * The two acquisition forms the canonical-module classifier recognises. They
 * are declared here rather than spelled inline so that the census arm authority
 * reads the same two names the classifier dispatches on.
 */
export const consentAuthorizationAcquisitionArms = Object.freeze(["dynamic-import", "require"]);

/**
 * The specifier expression shapes the acquisition classifier dispositions by
 * name. Each member is one branch: `folded` says whether this analyzer can fold
 * the shape to one definite specifier string, and only the string-literal shape
 * can be, because folding the other three is the declared-open residual the
 * sibling slice owns. Every
 * specifier expression whose kind no member names routes to the named
 * `runtime-unknown` default arm by construction, so a shape this table does not
 * carry is an admitted unknown rather than a silent drop.
 */
export const consentAuthorizationSpecifierShapeDispositions = Object.freeze(
  [
    { shape: "string-literal", syntaxKind: "StringLiteral", folded: true },
    { shape: "no-substitution-template", syntaxKind: "NoSubstitutionTemplateLiteral", folded: false },
    { shape: "identifier", syntaxKind: "Identifier", folded: false },
    { shape: "concatenation", syntaxKind: "BinaryExpression", folded: false },
  ].map((entry) => Object.freeze(entry)),
);

export const consentAuthorizationSpecifierRuntimeUnknownArm = "specifier:runtime-unknown";

/**
 * The disposition table must name compiler syntax kinds, and exactly one member
 * may fold, so the table can never quietly widen into the declared-open
 * residual the sibling slice owns.
 */
export function assertConsentAuthorizationSpecifierShapeDispositions(
  dispositions = consentAuthorizationSpecifierShapeDispositions,
) {
  const unresolved = dispositions
    .map(({ syntaxKind }) => syntaxKind)
    .filter((syntaxKind) => typeof ts.SyntaxKind[syntaxKind] !== "number");
  const shapes = dispositions.map(({ shape }) => shape);
  const duplicated = shapes.filter((shape, index) => shapes.indexOf(shape) !== index);
  if (unresolved.length > 0 || duplicated.length > 0 || dispositions.filter(({ folded }) => folded).length !== 1) {
    throw guardFailure(
      "consent-authorization-specifier-shape-disposition-invalid",
      "coverage.specifier-shape-disposition",
      "the committed specifier shape disposition does not name distinct compiler syntax kinds with exactly one folded shape",
      { unresolved, duplicated },
    );
  }
  return dispositions;
}

// Resolved through the compiler's forward mapping, never through its reverse
// one: several syntax kinds share a numeric value with a boundary alias, so
// `ts.SyntaxKind[node.kind]` answers `FirstTemplateToken` where the disposition
// names `NoSubstitutionTemplateLiteral`.
function consentAuthorizationSpecifierShape(node) {
  return (
    consentAuthorizationSpecifierShapeDispositions.find((entry) => ts.SyntaxKind[entry.syntaxKind] === node.kind) ??
    null
  );
}

// A `const` name whose value is not one resolvable string -- two declarations of
// one name, or a value this resolver cannot fold -- is unresolved, never a
// guess.
const ambiguousConstantBinding = Symbol("ambiguous-constant-binding");

// Expressions that carry their operand's value unchanged, so a key wrapped in
// one of them is still the same constant key.
const valueTransparentExpressionKinds = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

function collectConstantStringBinding(node, bindings) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return;
  bindings.set(node.name.text, bindings.has(node.name.text) ? ambiguousConstantBinding : node.initializer);
}

/**
 * Governing clause of MUT-AC4-CONSTANT-KEY-UNRESOLVED and
 * MUT-AC4-TEMPLATE-KEY-UNRESOLVED. Folds the key forms whose value is fixed by
 * the module's own text -- string and template literals, `const` bindings over
 * them, template substitution, and `+` concatenation -- and returns null for
 * every key that is not, so a resolved key is a fact and an unresolved key is
 * an admitted unknown.
 */
export function resolveConsentAuthorizationConstantKey(node, bindings, seen = new Set()) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (valueTransparentExpressionKinds.has(node.kind)) {
    return resolveConsentAuthorizationConstantKey(node.expression, bindings, seen);
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const resolved = resolveConsentAuthorizationConstantKey(span.expression, bindings, seen);
      if (resolved === null) return null;
      text += resolved + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveConsentAuthorizationConstantKey(node.left, bindings, seen);
    const right = resolveConsentAuthorizationConstantKey(node.right, bindings, seen);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(node)) {
    const bound = bindings.get(node.text);
    if (bound === undefined || bound === ambiguousConstantBinding || seen.has(node.text)) return null;
    seen.add(node.text);
    const resolved = resolveConsentAuthorizationConstantKey(bound, bindings, seen);
    seen.delete(node.text);
    return resolved;
  }
  return null;
}

function noncanonicalAccess(relativeFile, sourceFile, node, form, binding, arm = `specifier:${form}`) {
  return {
    file: relativeFile,
    constructor: null,
    line: lineFor(sourceFile, node),
    referenceClass: "noncanonical-module-access",
    form,
    binding,
    axis: "specifier",
    arm,
    syntaxKind: ts.SyntaxKind[node.kind],
  };
}

/**
 * The named default arm. A key or specifier position the analyzer reaches but
 * cannot fold to one definite string is recorded here and counted in the
 * published census, so a shape the committed coverage matrix does not classify
 * is an admitted unknown rather than a silent drop. It is a census fact and
 * never a violation: an ordinary `object[runtimeKey]` in an unrelated file owes
 * this guard nothing.
 */
function admittedUnknown(relativeFile, sourceFile, node, axis, arm, form = null) {
  return {
    file: relativeFile,
    constructor: null,
    line: lineFor(sourceFile, node),
    referenceClass: "admitted-unknown",
    axis,
    arm,
    form,
    syntaxKind: ts.SyntaxKind[node.kind],
  };
}

/**
 * Governing clause of MUT-AC4-NAMESPACE-BINDING-UNTRACKED. Every form that
 * reaches the canonical module without being one canonical named import binds
 * or republishes the whole module surface, and the census cannot see a
 * constructor reached through it. Each form is recorded where it is written,
 * and the local names it binds are returned so their uses can be classified.
 */
function collectCanonicalModuleBinding(relativeFile, sourceFile, node, bindings, accesses, unknowns) {
  if (
    ts.isImportDeclaration(node) &&
    reachesCanonicalModule(relativeFile, canonicalSpecifierText(node.moduleSpecifier))
  ) {
    const clause = node.importClause;
    if (clause?.name) {
      bindings.set(clause.name.text, clause.name);
      accesses.push(noncanonicalAccess(relativeFile, sourceFile, node, "default-import", clause.name.text));
    }
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, clause.namedBindings.name);
      accesses.push(
        noncanonicalAccess(relativeFile, sourceFile, node, "namespace-import", clause.namedBindings.name.text),
      );
    }
    return;
  }
  if (
    ts.isExportDeclaration(node) &&
    reachesCanonicalModule(relativeFile, canonicalSpecifierText(node.moduleSpecifier)) &&
    (!node.exportClause || ts.isNamespaceExport(node.exportClause))
  ) {
    accesses.push(noncanonicalAccess(relativeFile, sourceFile, node, "namespace-re-export", null));
    return;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    reachesCanonicalModule(relativeFile, canonicalSpecifierText(node.moduleReference.expression))
  ) {
    bindings.set(node.name.text, node.name);
    accesses.push(noncanonicalAccess(relativeFile, sourceFile, node, "import-equals", node.name.text));
    return;
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return;
  const acquired =
    node.expression.kind === ts.SyntaxKind.ImportKeyword
      ? consentAuthorizationAcquisitionArms[0]
      : ts.isIdentifier(node.expression) && node.expression.text === "require"
        ? consentAuthorizationAcquisitionArms[1]
        : null;
  if (!acquired) return;
  const specifier = node.arguments[0];
  // The acquisition and the specifier shape together name one census arm, so a
  // dynamic import written as a no-substitution template is a different
  // published arm from the same import written as a string literal, and from
  // the same template shape taken through `require`.
  const disposition = consentAuthorizationSpecifierShape(specifier);
  const arm = disposition ? `${acquired}:${disposition.shape}` : consentAuthorizationSpecifierRuntimeUnknownArm;
  const text = disposition?.folded === true ? canonicalSpecifierText(specifier) : null;
  if (text === null) {
    unknowns.push(admittedUnknown(relativeFile, sourceFile, specifier, "specifier", arm, acquired));
    return;
  }
  if (reachesCanonicalModule(relativeFile, text)) {
    accesses.push(noncanonicalAccess(relativeFile, sourceFile, node, acquired, null, arm));
  }
}

export function scanConsentAuthorizationSource(relativeFile, source, artifact) {
  const sourceFile = ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relativeFile),
  );
  const references = [];
  const constantBindings = new Map();
  const canonicalBindings = new Map();
  const canonicalAccesses = [];
  const unknowns = [];
  const elementAccesses = [];
  const visit = (node) => {
    collectConstantStringBinding(node, constantBindings);
    collectCanonicalModuleBinding(relativeFile, sourceFile, node, canonicalBindings, canonicalAccesses, unknowns);
    if (ts.isElementAccessExpression(node)) elementAccesses.push(node);
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isComputedPropertyName(node.propertyName) &&
      !ts.isStringLiteral(node.propertyName.expression) &&
      !ts.isNoSubstitutionTemplateLiteral(node.propertyName.expression)
    ) {
      unknowns.push(
        admittedUnknown(relativeFile, sourceFile, node.propertyName.expression, "key", "binding-element-key"),
      );
    }
    if (ts.isIdentifier(node) && constructorNames.has(node.text)) {
      const base = { file: relativeFile, constructor: node.text, line: lineFor(sourceFile, node) };
      if (ts.isFunctionDeclaration(node.parent) && node.parent.name === node) {
        references.push({
          ...base,
          referenceClass: "declaration",
          exported: modifiersInclude(node.parent, ts.SyntaxKind.ExportKeyword),
        });
      } else {
        const imported = importDetails(node);
        if (imported) {
          references.push({
            ...base,
            referenceClass: "import",
            axis: "specifier",
            arm: "specifier:canonical-named-import",
            ...imported,
          });
        } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          references.push({
            ...base,
            referenceClass: "consumption",
            axis: "key",
            arm: "consumption:direct-identifier",
            owner: deriveConsentAuthorizationOwner(node, artifact),
            position: node.getStart(sourceFile),
          });
        } else {
          references.push({
            ...base,
            referenceClass: "unexpected",
            syntaxKind: ts.SyntaxKind[node.parent.kind],
          });
        }
      }
    } else {
      const computed = computedConstructorProperty(node);
      if (computed) {
        references.push({
          file: relativeFile,
          constructor: computed.constructor,
          line: lineFor(sourceFile, node),
          referenceClass: "unexpected",
          axis: computed.axis,
          arm: computed.arm,
          syntaxKind: ts.SyntaxKind[node.parent.kind],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // The constant bindings are complete only once the whole module has been
  // walked, so every key that is constant by resolution rather than by literal
  // is folded here. A key written as a literal is already classified at the
  // literal itself by `computedConstructorProperty`, and is skipped so that one
  // reference is never counted twice.
  for (const access of elementAccesses) {
    const argument = access.argumentExpression;
    if (!argument || ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) continue;
    const key = resolveConsentAuthorizationConstantKey(argument, constantBindings);
    if (key === null) {
      unknowns.push(admittedUnknown(relativeFile, sourceFile, argument, "key", "element-access-key"));
      continue;
    }
    if (!constructorNames.has(key)) continue;
    // The arm is the outermost key form the resolver folded, so every branch of
    // the constant-key grammar is its own published census arm rather than one
    // undifferentiated "resolved key".
    references.push({
      file: relativeFile,
      constructor: key,
      line: lineFor(sourceFile, access),
      referenceClass: "unexpected",
      axis: "key",
      arm: `constant-key:${ts.SyntaxKind[argument.kind]}`,
      syntaxKind: ts.SyntaxKind[access.kind],
    });
  }

  references.push(...canonicalAccesses);
  if (canonicalBindings.size > 0) {
    const declarationNames = new Set(canonicalBindings.values());
    const visitBindingUse = (node) => {
      if (ts.isIdentifier(node) && canonicalBindings.has(node.text) && !declarationNames.has(node)) {
        const parent = node.parent;
        const isMemberName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isQualifiedName(parent) && parent.right === node);
        if (!isMemberName) {
          if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            // A statically written member name is decided by its own
            // identifier: it is classified when it spells a constructor, and
            // provably is not one otherwise.
          } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
            // A key that resolves is already classified above or at its
            // literal; a key that does not resolve could name any export of the
            // module, so it fails closed.
            if (resolveConsentAuthorizationConstantKey(parent.argumentExpression, constantBindings) === null) {
              references.push(noncanonicalAccess(relativeFile, sourceFile, parent, "dynamic-key", node.text));
            }
          } else {
            references.push(noncanonicalAccess(relativeFile, sourceFile, node, "escaping-binding", node.text));
          }
        }
      }
      ts.forEachChild(node, visitBindingUse);
    };
    visitBindingUse(sourceFile);
  }

  references.push(...unknowns);
  return references;
}

/* ------------------------------------------------------------------------ */
/* Census coverage -- derived axes, committed rows, named default arm        */
/* ------------------------------------------------------------------------ */

/**
 * The two functions that own the census grammar. The coverage matrix is total
 * against these and against nothing else: the key axis is exactly the set of
 * expression kinds the constant-key resolver branches on, and the specifier
 * axis is exactly the set of node kinds the canonical-module acquisition
 * classifier branches on. Both are read out of this module's own parsed source
 * rather than restated by hand, so a branch added without a row -- or a row
 * kept after its branch is gone -- fails closed.
 */
export const consentAuthorizationCoverageAxisAuthorities = Object.freeze({
  key: "resolveConsentAuthorizationConstantKey",
  specifier: "collectCanonicalModuleBinding",
});

export const consentAuthorizationDeclaredOpenOwner = "#6493";

const coverageCensusOutcomes = Object.freeze(["classified", "admitted-unknown", "silent"]);

function findFunctionDeclaration(sourceFile, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function syntaxKindMemberName(node) {
  return ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "ts" &&
    node.expression.name.text === "SyntaxKind"
    ? node.name.text
    : null;
}

function syntaxKindSetMembers(sourceFile, name) {
  let members = null;
  const visit = (node) => {
    if (members) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.arguments?.length === 1 &&
      ts.isArrayLiteralExpression(node.initializer.arguments[0])
    ) {
      members = node.initializer.arguments[0].elements.map(syntaxKindMemberName);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
}

function isPredicateOnParameter(node, parameterName) {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    ts.isIdentifier(node.arguments[0]) &&
    node.arguments[0].text === parameterName &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "ts" &&
    node.expression.name.text.startsWith("is")
  );
}

function isKindSetMembershipOnParameter(node, parameterName) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  const callee = node.expression;
  const argument = node.arguments[0];
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "has" &&
    ts.isIdentifier(callee.expression) &&
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    argument.expression.text === parameterName &&
    argument.name.text === "kind"
  );
}

function collectBranchedExpressionKinds(sourceFile, functionName, parameterName) {
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  if (!declaration?.body) {
    throw guardFailure(
      "consent-authorization-coverage-axis-underived",
      "coverage.axis-authority",
      `${functionName} could not be read out of the analyzer's own source, so its branch set cannot be derived`,
      { functionName },
    );
  }
  const kinds = new Set();
  const visit = (node) => {
    if (isPredicateOnParameter(node, parameterName)) {
      kinds.add(node.expression.name.text.slice(2));
    } else if (isKindSetMembershipOnParameter(node, parameterName)) {
      const setName = node.expression.expression.text;
      const members = syntaxKindSetMembers(sourceFile, setName);
      if (!members || members.length === 0 || members.some((member) => member === null)) {
        throw guardFailure(
          "consent-authorization-coverage-axis-underived",
          "coverage.axis-authority",
          `${functionName} consults ${setName}, whose members are not a readable compiler syntax-kind set`,
          { functionName, setName },
        );
      }
      for (const member of members) kinds.add(member);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);

  const derived = [...kinds].sort();
  const unresolved = derived.filter((kind) => typeof ts.SyntaxKind[kind] !== "number");
  if (derived.length === 0 || unresolved.length > 0) {
    throw guardFailure(
      "consent-authorization-coverage-axis-underived",
      "coverage.axis-authority",
      `${functionName} yielded no compiler syntax kind, or yielded a name the compiler does not enumerate`,
      { functionName, derived, unresolved },
    );
  }
  return derived;
}

/**
 * Reads the axes out of the running module's own source, so a mutation-case
 * scratch copy derives from the copy that is executing rather than from the
 * committed file it was rewritten out of.
 */
export function deriveConsentAuthorizationCoverageAxes({ analyzerSource } = {}) {
  const source = analyzerSource ?? readFileSync(fileURLToPath(import.meta.url), "utf8");
  const sourceFile = ts.createSourceFile(
    "consent-authorization-coverage-axis-authority.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return {
    key: collectBranchedExpressionKinds(sourceFile, consentAuthorizationCoverageAxisAuthorities.key, "node"),
    specifier: collectBranchedExpressionKinds(
      sourceFile,
      consentAuthorizationCoverageAxisAuthorities.specifier,
      "node",
    ),
  };
}

export function consentAuthorizationCoverageAxisKinds(coverage) {
  const axes = { key: new Set(), specifier: new Set() };
  for (const row of coverage?.rows ?? []) {
    if (row?.axis === "key" || row?.axis === "specifier") axes[row.axis].add(row.expressionKind);
  }
  return { key: [...axes.key].sort(), specifier: [...axes.specifier].sort() };
}

/**
 * Governing clause of the coverage totality. The committed rows' axis sets and
 * the analyzer's own branch sets must agree in both directions -- the same
 * construction the extension disposition already uses against the compiler's
 * enumerated extension set.
 */
export function assertConsentAuthorizationCoveragePartition(coverage, derivedAxes) {
  const branchSets = derivedAxes ?? deriveConsentAuthorizationCoverageAxes();
  const committed = consentAuthorizationCoverageAxisKinds(coverage);
  const differences = [];
  for (const axis of ["key", "specifier"]) {
    const branched = branchSets[axis] ?? [];
    const unrowed = branched.filter((kind) => !committed[axis].includes(kind));
    const unbranched = committed[axis].filter((kind) => !branched.includes(kind));
    if (unrowed.length > 0 || unbranched.length > 0) differences.push({ axis, unrowed, unbranched });
  }
  if (differences.length > 0) {
    throw guardFailure(
      "consent-authorization-coverage-partition-partial",
      "coverage.partition",
      "the committed census coverage matrix does not cover the analyzer's own branched expression kinds exactly",
      { differences },
    );
  }
  return committed;
}

/* -- Census arm authority -- one identity per committed coverage row ------- */

function stringLiteralText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function objectLiteralStringProperty(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if ((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      return stringLiteralText(property.initializer);
    }
  }
  return null;
}

function collectNodes(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Every object literal the analyzer emits a reference from that names both its
 * axis and its arm as written literals. This is the analyzer's own text, so an
 * arm that is deleted from the code disappears from the derived set.
 */
function collectWrittenAxisArms(sourceFile) {
  return collectNodes(sourceFile, ts.isObjectLiteralExpression)
    .map((node) => ({ axis: objectLiteralStringProperty(node, "axis"), arm: objectLiteralStringProperty(node, "arm") }))
    .filter(({ axis, arm }) => axis !== null && arm !== null);
}

function collectCalleeStringArguments(sourceFile, calleeName, indexes) {
  return collectNodes(
    sourceFile,
    (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName,
  )
    .map((node) => indexes.map((index) => stringLiteralText(node.arguments[index])))
    .filter((values) => values.every((value) => value !== null));
}

function declaredArrayLiteral(sourceFile, name) {
  for (const declaration of collectNodes(
    sourceFile,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  )) {
    const arrays = collectNodes(declaration, ts.isArrayLiteralExpression);
    if (arrays.length > 0) return arrays[0];
  }
  return null;
}

function declaredStringConstant(sourceFile, name) {
  for (const declaration of collectNodes(
    sourceFile,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  )) {
    const text = stringLiteralText(declaration.initializer);
    if (text !== null) return text;
  }
  return null;
}

function requireDerived(values, what) {
  if (!Array.isArray(values) || values.length === 0) {
    throw guardFailure(
      "consent-authorization-coverage-arm-underived",
      "coverage.arm-authority",
      `${what} could not be read out of the analyzer's own source, so the census arm set cannot be derived`,
      { what },
    );
  }
  return values;
}

/**
 * The census arm identities, at the granularity one committed coverage row is
 * written at, read out of the analyzer's own parsed source.
 *
 * The key axis is the acquisition-free half: one arm per written classification
 * position, one arm per constant-key fold the resolver branches on -- minus the
 * two literal kinds the element-access loop skips because a literal key is
 * already decided at the literal itself -- and the two named default arms an
 * unfoldable key routes to. The specifier axis is the canonical named import,
 * one arm per written non-acquisition access form, the full cross product of
 * the acquisition forms and the dispositioned specifier shapes, and the named
 * runtime-unknown default arm. Sixteen specifier shapes therefore have sixteen
 * derived identities rather than four parent node kinds.
 */
export function deriveConsentAuthorizationCensusArms({ analyzerSource } = {}) {
  const source = analyzerSource ?? readFileSync(fileURLToPath(import.meta.url), "utf8");
  const sourceFile = ts.createSourceFile(
    "consent-authorization-census-arm-authority.mjs",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const written = collectWrittenAxisArms(sourceFile);
  const foldedKinds = collectBranchedExpressionKinds(
    sourceFile,
    consentAuthorizationCoverageAxisAuthorities.key,
    "node",
  );
  const literalKeyKinds = collectBranchedExpressionKinds(sourceFile, "scanConsentAuthorizationSource", "argument");
  const outerFoldedKinds = foldedKinds.filter((kind) => !literalKeyKinds.includes(kind));
  const defaultKeyArms = collectCalleeStringArguments(sourceFile, "admittedUnknown", [3, 4])
    .filter(([axis]) => axis === "key")
    .map(([, arm]) => arm);

  const accessForms = collectCalleeStringArguments(sourceFile, "noncanonicalAccess", [3]).map(([form]) => form);
  const acquisitions = (declaredArrayLiteral(sourceFile, "consentAuthorizationAcquisitionArms")?.elements ?? [])
    .map(stringLiteralText)
    .filter((value) => value !== null);
  const shapes = (declaredArrayLiteral(sourceFile, "consentAuthorizationSpecifierShapeDispositions")?.elements ?? [])
    .map((element) => objectLiteralStringProperty(element, "shape"))
    .filter((value) => value !== null);
  const runtimeUnknownArm = declaredStringConstant(sourceFile, "consentAuthorizationSpecifierRuntimeUnknownArm");

  requireDerived(outerFoldedKinds, "the constant-key fold branch set");
  requireDerived(defaultKeyArms, "the named key default arms");
  requireDerived(accessForms, "the written non-canonical access forms");
  requireDerived(acquisitions, "the acquisition arms");
  requireDerived(shapes, "the specifier shape dispositions");
  requireDerived(runtimeUnknownArm === null ? [] : [runtimeUnknownArm], "the specifier runtime-unknown default arm");

  const unique = (values) => [...new Set(values)].sort();
  return {
    key: unique([
      ...written.filter(({ axis }) => axis === "key").map(({ arm }) => arm),
      ...outerFoldedKinds.map((kind) => `constant-key:${kind}`),
      ...defaultKeyArms,
    ]),
    specifier: unique([
      ...written.filter(({ axis }) => axis === "specifier").map(({ arm }) => arm),
      ...accessForms.map((form) => `specifier:${form}`),
      ...acquisitions.flatMap((acquisition) => shapes.map((shape) => `${acquisition}:${shape}`)),
      runtimeUnknownArm,
    ]),
  };
}

export function consentAuthorizationCommittedCensusArms(coverage) {
  const arms = { key: [], specifier: [] };
  for (const row of coverage?.rows ?? []) {
    if ((row?.axis === "key" || row?.axis === "specifier") && typeof row.arm === "string") arms[row.axis].push(row.arm);
  }
  return { key: [...new Set(arms.key)].sort(), specifier: [...new Set(arms.specifier)].sort() };
}

/**
 * Governing clause of the coverage totality at row granularity. Three
 * properties are asserted together, and any one of them alone would leave a
 * coordinated row-plus-fixture omission green:
 *
 *  - every derived arm is witnessed by at least one committed row, so deleting
 *    the only row for an arm fails closed;
 *  - every committed row names an arm the analyzer can reach, so a row kept
 *    after its branch is gone fails closed;
 *  - every recorded census outcome is witnessed, and no two rows share one
 *    (axis, arm, expression kind, census) identity, so no row is a duplicate of
 *    another and the negative rows cannot all be deleted.
 *
 * Arms whose expression-kind domain is closed by the analyzer's own branch set
 * carry exactly one row each. The two unfoldable-key default arms are open by
 * construction -- any expression kind can reach them -- so their committed rows
 * are witnesses of that residual rather than a partition of it.
 */
export function assertConsentAuthorizationCensusArmPartition(coverage, derivedArms) {
  const arms = derivedArms ?? deriveConsentAuthorizationCensusArms();
  const committed = consentAuthorizationCommittedCensusArms(coverage);
  const rows = coverage?.rows ?? [];
  const differences = [];
  for (const axis of ["key", "specifier"]) {
    const witnessed = rows.filter((row) => row.axis === axis && row.census !== "silent").map((row) => row.arm);
    const unwitnessed = arms[axis].filter((arm) => !witnessed.includes(arm));
    const underived = committed[axis].filter((arm) => !arms[axis].includes(arm));
    if (unwitnessed.length > 0 || underived.length > 0) differences.push({ axis, unwitnessed, underived });
  }
  const unwitnessedOutcomes = coverageCensusOutcomes.filter((outcome) => !rows.some((row) => row.census === outcome));
  if (unwitnessedOutcomes.length > 0) {
    differences.push({ axis: "census-outcome", unwitnessed: unwitnessedOutcomes, underived: [] });
  }
  const identities = rows.map((row) => [row.axis, row.arm ?? "", row.expressionKind, row.census].join("\0"));
  const duplicated = [...new Set(identities.filter((identity, index) => identities.indexOf(identity) !== index))];
  if (duplicated.length > 0) {
    differences.push({ axis: "row-identity", unwitnessed: [], underived: duplicated.map((key) => key.split("\0")[1]) });
  }
  if (differences.length > 0) {
    throw guardFailure(
      "consent-authorization-coverage-partition-partial",
      "coverage.arm-partition",
      "the committed census coverage matrix does not carry exactly one witnessed row identity per analyzer census arm",
      { differences },
    );
  }
  return committed;
}

export function listConsentAuthorizationCensusFixtures({
  repoRoot: rootDir = repoRoot,
  execGit = (args, options) => defaultExecGit(args, rootDir, options),
} = {}) {
  return gitBuffer(execGit, ["ls-files", "-z", "--", consentAuthorizationCensusFixtureRoot], "census-fixture-index")
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
}

export function collectConsentAuthorizationCoverageViolations(coverage, schema, { censusFixtureFiles = null } = {}) {
  const violations = validateAgainstSchema(coverage, schema);
  for (const pointer of collectOpenSchemaObjectPaths(schema)) {
    violations.push(`${pointer}: schema object must be recursively closed`);
  }
  if (!coverage || !Array.isArray(coverage.rows)) return violations;
  if (coverage.version !== 1) violations.push("coverage version must equal 1");
  if (
    coverage.axisAuthorities?.key !== consentAuthorizationCoverageAxisAuthorities.key ||
    coverage.axisAuthorities?.specifier !== consentAuthorizationCoverageAxisAuthorities.specifier
  ) {
    violations.push("coverage axis authorities must name this analyzer's own branch owners");
  }

  const seenRowIds = new Set();
  const seenFixtures = new Set();
  for (const [index, row] of coverage.rows.entries()) {
    const label = `rows[${index}]`;
    if (seenRowIds.has(row.rowId)) violations.push(`${label}: duplicate coverage row identifier`);
    seenRowIds.add(row.rowId);
    if (seenFixtures.has(row.fixture)) violations.push(`${label}: duplicate coverage fixture`);
    seenFixtures.add(row.fixture);
    if (row.fixture !== `${consentAuthorizationCensusFixtureRoot}/${row.rowId}.ts`) {
      violations.push(`${label}: fixture must be the census fixture named for the row`);
    }
    const plantedSegments = String(row.plantedAt ?? "").split("/");
    if (plantedSegments.length !== 3 || plantedSegments.at(-1) !== `${row.rowId}.ts`) {
      violations.push(`${label}: plantedAt must be a two-directory path whose basename names the row`);
    }
    if (/consent|authorization|census/i.test(plantedSegments.slice(0, -1).join("/"))) {
      violations.push(`${label}: plantedAt directories must carry no guard vocabulary`);
    }
    if (typeof ts.SyntaxKind[row.expressionKind] !== "number") {
      violations.push(`${label}: expressionKind must name a compiler syntax kind`);
    }
    if (!coverageCensusOutcomes.includes(row.census)) {
      violations.push(`${label}: census must be one recorded observable outcome`);
    }
    if ((row.disposition === "classified") !== (row.census === "classified")) {
      violations.push(`${label}: disposition and recorded census outcome disagree`);
    }
    if (row.disposition === "declared-open" && row.census !== "admitted-unknown") {
      violations.push(`${label}: a declared-open shape must be admitted as an unknown rather than dropped in silence`);
    }
    if (row.disposition === "declared-open" && row.owner !== consentAuthorizationDeclaredOpenOwner) {
      violations.push(`${label}: a declared-open row must name its owning issue`);
    }
    if (row.disposition !== "declared-open" && row.owner !== undefined) {
      violations.push(`${label}: only a declared-open row carries an owning issue`);
    }
    // A row the analyzer emits something for names the arm that emitted it; a
    // silent row is the assertion that no arm emits anything, so it carries
    // none. Either way the row's arm state is decided, never omitted.
    if ((row.census === "silent") === (typeof row.arm === "string")) {
      violations.push(`${label}: exactly a non-silent row names the analyzer census arm that decides it`);
    }
  }

  if (Array.isArray(censusFixtureFiles)) {
    for (const file of censusFixtureFiles) {
      if (!seenFixtures.has(file)) violations.push(`${file}: census fixture has no committed coverage row`);
    }
    for (const row of coverage.rows) {
      if (!censusFixtureFiles.includes(row.fixture)) {
        violations.push(`${row.rowId}: coverage row names a census fixture the index does not carry`);
      }
    }
  }
  return violations;
}

/**
 * The observable census outcome for one committed row, produced by driving that
 * row's fixture through the real analyzer at the arbitrary path the row is
 * planted at. A row that starts classifying, or stops classifying, changes this
 * value in one direction or the other.
 */
export function observeConsentAuthorizationCoverageRow(row, source, artifact) {
  const references = scanConsentAuthorizationSource(row.plantedAt, source, artifact);
  const matched = references.filter((reference) =>
    Object.entries(row.signature).every(([field, value]) => reference[field] === value),
  );
  const unknowns = references.filter(
    (reference) => reference.referenceClass === "admitted-unknown" && reference.axis === row.axis,
  );
  const census = matched.length > 0 ? "classified" : unknowns.length > 0 ? "admitted-unknown" : "silent";
  return {
    rowId: row.rowId,
    census,
    matchedReferences: matched.length,
    admittedUnknownKinds: [...new Set(unknowns.map(({ syntaxKind }) => syntaxKind))].sort(),
    // The arms the live analyzer actually reached for this row's own fixture,
    // so a committed arm is bound to an executed observation and not merely to
    // a name that also appears in the analyzer's text.
    observedArms: [
      ...new Set((census === "classified" ? matched : unknowns).map(({ arm }) => arm).filter(Boolean)),
    ].sort(),
  };
}

export function consentAuthorizationCoverageCounts(coverage) {
  const counts = { classified: 0, "declared-open": 0, "silent-by-design": 0 };
  for (const row of coverage?.rows ?? []) {
    if (row.disposition in counts) counts[row.disposition] += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------------ */
/* Registry                                                                  */
/* ------------------------------------------------------------------------ */

function siteKey(site) {
  return [site.file, site.owner, site.constructor, site.ordinal].join("\0");
}

function siteIdentity(site) {
  return { file: site.file, owner: site.owner, constructor: site.constructor, ordinal: site.ordinal };
}

function importKey(site) {
  return [site.file, site.constructor].join("\0");
}

/**
 * The complete canonical identity of one owning import: which file binds which
 * constructor, out of which written module specifier, under which local and
 * imported names, and whether the binding is aliased or type-only. Nothing here
 * is a summary -- a redirected specifier, a rename, or a type-only binding all
 * change this record, so the partition digest separates them.
 */
function importIdentity(imported) {
  return {
    file: imported.file,
    constructor: imported.constructor,
    source: imported.source ?? null,
    localName: imported.localName ?? null,
    importedName: imported.importedName ?? null,
    aliased: imported.aliased === true,
    typeOnly: imported.typeOnly === true,
  };
}

/**
 * The specifier a registered owning file must write to reach the declaration
 * module, derived from the two paths rather than committed anywhere, so the
 * expected side of the import delta is a fact about the registry and the
 * declaration module and never a frozen literal.
 */
export function expectedConsentAuthorizationImportIdentity(site) {
  const relative = path.posix.relative(path.posix.dirname(normalizePath(site.file)), declarationModulePath);
  return {
    file: normalizePath(site.file),
    constructor: site.constructor,
    source: relative.startsWith(".") ? relative : `./${relative}`,
    localName: site.constructor,
    importedName: site.constructor,
    aliased: false,
    typeOnly: false,
  };
}

function resolvesToDeclarationModule(imported) {
  if (!imported.source.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(imported.file), imported.source));
  return resolved === declarationFile.slice(0, -path.extname(declarationFile).length);
}

function safeRegistryPath(value) {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

export function collectConsentAuthorizationRegistryViolations(registry, schema) {
  const violations = validateAgainstSchema(registry, schema);
  for (const pointer of collectOpenSchemaObjectPaths(schema)) {
    violations.push(`${pointer}: schema object must be recursively closed`);
  }
  if (!registry || !Array.isArray(registry.sites)) return violations;
  if (registry.version !== 1) violations.push("registry version must equal 1");
  if (registry.sites.length !== 6) violations.push("registry must contain exactly six sites");

  const seen = new Set();
  const ordinals = new Map();
  const counts = { actor: 0, "self-registration": 0, provisioning: 0 };
  for (const [index, site] of registry.sites.entries()) {
    const label = `sites[${index}]`;
    if (!safeRegistryPath(site.file)) violations.push(`${label}: file must be a normalized repository-relative path`);
    if (constructorClassifications.get(site.constructor) !== site.classification) {
      violations.push(`${label}: constructor and classification disagree`);
    }
    if (!site.reason?.trim()) violations.push(`${label}: reason must be non-empty`);
    if (site.classification === "provisioning" && !/#6120\b.*permanent|permanent.*#6120\b/i.test(site.reason)) {
      violations.push(`${label}: provisioning reason must name the #6120 permanent exemption`);
    }
    if (site.classification in counts) counts[site.classification] += 1;
    const key = siteKey(site);
    if (seen.has(key)) violations.push(`${label}: duplicate semantic site identity`);
    seen.add(key);
    const group = [site.file, site.owner, site.constructor].join("\0");
    const values = ordinals.get(group) ?? [];
    values.push(site.ordinal);
    ordinals.set(group, values);
  }
  if (JSON.stringify(counts) !== JSON.stringify({ actor: 2, "self-registration": 1, provisioning: 3 })) {
    violations.push("registry partition must be exactly 2 actor / 1 self-registration / 3 provisioning");
  }
  for (const values of ordinals.values()) {
    const ordered = values.toSorted((left, right) => left - right);
    if (ordered.some((value, index) => value !== index + 1)) {
      violations.push("site ordinals must be contiguous within each semantic owner and constructor");
    }
  }
  return violations;
}

function addOrdinals(consumptions) {
  const counts = new Map();
  return consumptions
    .toSorted((left, right) => left.file.localeCompare(right.file) || left.position - right.position)
    .map((site) => {
      const group = [site.file, site.owner, site.constructor].join("\0");
      const ordinal = (counts.get(group) ?? 0) + 1;
      counts.set(group, ordinal);
      return { ...site, ordinal };
    });
}

export function digestConsentAuthorizationPartition({ declarations, imports, consumptions }) {
  const stable = {
    declarations: declarations.map(({ file, constructor }) => ({ file, constructor })),
    imports: imports.map(importIdentity),
    consumptions: consumptions.map(({ file, owner, constructor, ordinal, classification }) => ({
      file,
      owner,
      constructor,
      ordinal,
      classification,
    })),
  };
  return sha256(JSON.stringify(stable));
}

/* ------------------------------------------------------------------------ */
/* Mutation aggregate                                                        */
/* ------------------------------------------------------------------------ */

/**
 * The provenance fields every mutation receipt and the aggregate record. They
 * are recorded, never a frozen expectation -- but a recorded value that is not
 * the value the live analysis produced is a stale receipt, and a stale receipt
 * proves nothing about the head it claims.
 */
export const consentAuthorizationReceiptProvenanceFields = Object.freeze([
  "environment",
  "candidateHeadRole",
  "candidateHead",
  "analyzedTree",
  "baseTipAtAnalysis",
]);

/**
 * The provenance a receipt executed at this head must carry, derived from one
 * live analysis result rather than restated anywhere.
 */
export function deriveConsentAuthorizationReceiptProvenance(result) {
  return {
    environment: result?.environment ?? null,
    candidateHeadRole: result?.candidateHeadRole ?? null,
    candidateHead: result?.candidateHead ?? null,
    analyzedTree: result?.provenance?.roles?.analyzedTree?.sha ?? null,
    baseTipAtAnalysis: result?.provenance?.roles?.baseTipAtAnalysis?.sha ?? null,
  };
}

/**
 * Governing clause of the receipt-provenance authority. A well-formed value of
 * the right shape is not evidence: every recorded field is compared against the
 * live expectation, so a syntactically valid forty-character sha from another
 * commit, another environment, or another candidate-head role is rejected under
 * a stable named failure instead of passing the schema.
 */
export function collectMutationProvenanceViolations(scope, observed, expected) {
  const violations = [];
  for (const field of consentAuthorizationReceiptProvenanceFields) {
    const value = observed?.[field];
    if (typeof value !== "string" || value.length === 0) {
      violations.push(
        finding("consent-authorization-mutation-provenance-missing", `${scope}: ${field} is absent or not a string`, {
          scope,
          field,
          expected: expected?.[field] ?? null,
          observed: value ?? null,
        }),
      );
      continue;
    }
    if (value !== expected?.[field]) {
      violations.push(
        finding(
          "consent-authorization-mutation-provenance-mismatch",
          `${scope}: ${field} does not equal the live analysis provenance`,
          { scope, field, expected: expected?.[field] ?? null, observed: value },
        ),
      );
    }
  }
  return violations;
}

export function collectMutationAggregateViolations(aggregate, enumeration, options = {}) {
  const violations = [];
  const executed = aggregate.receipts.map(({ caseId }) => caseId);
  const committed = [...enumeration.cases];
  if (JSON.stringify(executed.toSorted()) !== JSON.stringify(committed.toSorted())) {
    violations.push(
      finding("consent-authorization-mutation-enumeration-drift", "executed receipts do not equal the committed list", {
        missing: committed.filter((caseId) => !executed.includes(caseId)),
        unexpected: executed.filter((caseId) => !committed.includes(caseId)),
      }),
    );
  }
  if (aggregate.counts.total !== committed.length) {
    violations.push(
      finding("consent-authorization-mutation-count-drift", "executed total does not equal the committed total", {
        expected: committed.length,
        observed: aggregate.counts.total,
      }),
    );
  }
  for (const key of ["candidateGreen", "mutantRed", "active", "preserved"]) {
    if (aggregate.counts[key] !== aggregate.counts.total) {
      violations.push(
        finding("consent-authorization-mutation-incomplete", `${key} does not cover every executed case`, {
          key,
          expected: aggregate.counts.total,
          observed: aggregate.counts[key],
        }),
      );
    }
  }

  // Provenance authority. The aggregate and every receipt it binds are checked
  // against one live expectation, and each receipt is checked against the
  // aggregate as well, so no receipt can be fresh in the aggregate and stale in
  // itself or the other way round.
  const { expectedProvenance = null, receipts = null } = options;
  if (expectedProvenance) {
    violations.push(...collectMutationProvenanceViolations("aggregate", aggregate.provenance, expectedProvenance));
  }
  if (Array.isArray(receipts)) {
    const bound = new Map(aggregate.receipts.map((entry) => [entry.caseId, entry]));
    for (const receipt of receipts) {
      const scope = `receipt:${receipt?.caseId ?? "unnamed"}`;
      if (expectedProvenance) {
        violations.push(...collectMutationProvenanceViolations(scope, receipt?.provenance, expectedProvenance));
      }
      violations.push(
        ...collectMutationProvenanceViolations(`${scope}/aggregate`, receipt?.provenance, aggregate.provenance),
      );
      const entry = bound.get(receipt?.caseId);
      const digest = sha256(JSON.stringify(receipt));
      if (!entry || entry.sha256 !== digest) {
        violations.push(
          finding(
            "consent-authorization-mutation-receipt-digest-mismatch",
            `${scope}: the aggregate does not bind this receipt's exact bytes`,
            { scope, expected: entry?.sha256 ?? null, observed: digest },
          ),
        );
      }
    }
  }
  return violations;
}

/* ------------------------------------------------------------------------ */
/* Analysis                                                                  */
/* ------------------------------------------------------------------------ */

export function analyzeConsentAuthorizationSites(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const authorityRoot = path.resolve(options.authorityRoot ?? repoRoot);
  const execGit = options.execGit ?? ((args, execOptions) => defaultExecGit(args, rootDir, execOptions));
  const execAuthorityGit =
    options.execAuthorityGit ?? ((args, execOptions) => defaultExecGit(args, authorityRoot, execOptions));
  const registry = options.registry ?? loadConsentAuthorizationRegistry({ repoRoot: rootDir });
  const schema = options.schema ?? loadConsentAuthorizationRegistrySchema({ repoRoot: rootDir });

  const provenanceOutcome =
    options.provenanceOutcome ??
    deriveConsentAuthorizationProvenanceOutcome(
      options.deriveProvenance ?? (() => deriveGuardCandidateProvenance({ execGit: (args) => execGit(args) })),
    );
  const provenance = requireResolvedProvenance(provenanceOutcome);
  const candidate = resolveConsentAuthorizationCandidateHead(provenance);

  const violations = collectConsentAuthorizationRegistryViolations(registry, schema).map((message) =>
    finding("consent-authorization-registry-invalid", message),
  );
  violations.push(...collectFrozenProvenanceViolations(provenance));

  const ownerContextPartition = options.ownerContextPartition ?? loadTypeScriptOwnerContextPartition();
  const ownerContextSchema = options.ownerContextSchema ?? loadTypeScriptOwnerContextSchema();
  const committedOwnerContexts = options.ownerContextArtifact ?? loadTypeScriptOwnerContextArtifact();
  const derivedOwnerContexts = (options.deriveOwnerContexts ?? deriveTypeScriptOwnerContexts)({
    resolutionRoot: authorityRoot,
  });
  const ownerContextComparison = compareTypeScriptOwnerContexts(committedOwnerContexts, derivedOwnerContexts, {
    partition: ownerContextPartition,
    schema: ownerContextSchema,
    comparedKeys: consentAuthorizationOwnerContextComparedKeys(ownerContextPartition),
  });
  for (const violation of ownerContextComparison.violations) {
    violations.push(finding(violation.code, violation.message ?? `owner-context authority failed: ${violation.code}`));
  }

  const censusCoverage = options.censusCoverage ?? loadConsentAuthorizationCensusCoverage({ repoRoot: authorityRoot });
  const censusCoverageSchema =
    options.censusCoverageSchema ?? loadConsentAuthorizationCensusCoverageSchema({ repoRoot: authorityRoot });
  const coverageAxes = assertConsentAuthorizationCoveragePartition(censusCoverage, options.coverageAxes);
  assertConsentAuthorizationSpecifierShapeDispositions();
  const coverageArms = assertConsentAuthorizationCensusArmPartition(censusCoverage, options.coverageArms);
  const censusFixtureFiles =
    options.censusFixtureFiles ??
    listConsentAuthorizationCensusFixtures({ repoRoot: authorityRoot, execGit: execAuthorityGit });
  for (const message of collectConsentAuthorizationCoverageViolations(censusCoverage, censusCoverageSchema, {
    censusFixtureFiles,
  })) {
    violations.push(finding("consent-authorization-coverage-invalid", message));
  }

  const corpus = enumerateConsentAuthorizationCorpus({
    repoRoot: rootDir,
    execGit,
    candidateHead: candidate.sha,
    environment: provenance.environment,
  });
  const sources = readConsentAuthorizationCorpusSources({ repoRoot: rootDir, execGit, corpus });
  // Admitted unknowns are folded into counts as each file is scanned rather
  // than accumulated: they are a whole-corpus census fact, so the guard
  // publishes how many of each shape it met without carrying one record per
  // ordinary computed access in the repository.
  const references = [];
  const admittedUnknownCounts = new Map();
  for (const file of corpus.scannedFiles) {
    for (const reference of scanConsentAuthorizationSource(file, sources.get(file) ?? "", committedOwnerContexts)) {
      if (reference.referenceClass === "admitted-unknown") {
        const key = [reference.axis, reference.arm, reference.syntaxKind].join("\0");
        admittedUnknownCounts.set(key, (admittedUnknownCounts.get(key) ?? 0) + 1);
        continue;
      }
      references.push(reference);
    }
  }
  const admittedUnknowns = [...admittedUnknownCounts.entries()]
    .map(([key, count]) => {
      const [axis, arm, expressionKind] = key.split("\0");
      return { axis, arm, expressionKind, count };
    })
    .toSorted(
      (left, right) =>
        left.axis.localeCompare(right.axis) ||
        left.arm.localeCompare(right.arm) ||
        left.expressionKind.localeCompare(right.expressionKind),
    );

  const declarations = references
    .filter((reference) => reference.referenceClass === "declaration")
    .toSorted((left, right) => left.constructor.localeCompare(right.constructor));
  const imports = references
    .filter((reference) => reference.referenceClass === "import")
    .toSorted(
      (left, right) => left.file.localeCompare(right.file) || left.constructor.localeCompare(right.constructor),
    );
  const consumptions = addOrdinals(references.filter((reference) => reference.referenceClass === "consumption")).map(
    (site) => ({ ...site, classification: constructorClassifications.get(site.constructor) }),
  );
  const unexpected = references.filter((reference) => reference.referenceClass === "unexpected");
  const noncanonicalAccesses = references.filter(
    (reference) => reference.referenceClass === "noncanonical-module-access",
  );
  const registrySites = Array.isArray(registry?.sites) ? registry.sites : [];

  const expectedDeclarations = new Set(consentAuthorizationConstructors.map((name) => `${declarationFile}\0${name}`));
  const observedDeclarations = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.file}\0${declaration.constructor}`;
    observedDeclarations.set(key, (observedDeclarations.get(key) ?? 0) + 1);
    if (!declaration.exported || !expectedDeclarations.has(key)) {
      violations.push(
        finding(
          "consent-authorization-declaration-invalid",
          `${declaration.file}:${declaration.line} is not an expected exported constructor declaration`,
          { reference: declaration },
        ),
      );
    }
  }
  for (const key of expectedDeclarations) {
    if (observedDeclarations.get(key) !== 1) {
      violations.push(
        finding(
          "consent-authorization-declaration-missing",
          `expected exactly one constructor declaration ${key.replace("\0", ":")}`,
        ),
      );
    }
  }

  const registryKeys = new Set(registrySites.map(siteKey));
  const observedKeys = new Set(consumptions.map(siteKey));
  for (const site of consumptions) {
    if (!site.owner) {
      violations.push(
        finding("consent-authorization-owner-ambiguous", `${site.file}:${site.line} has no stable semantic owner`, {
          site,
        }),
      );
    } else if (!registryKeys.has(siteKey(site))) {
      violations.push(
        finding(
          "consent-authorization-site-unregistered",
          `${site.file}:${site.line} has unregistered ${site.constructor} consumption in ${site.owner} ordinal ${site.ordinal}`,
          { site },
        ),
      );
    }
  }
  for (const site of registrySites) {
    if (!observedKeys.has(siteKey(site))) {
      violations.push(
        finding(
          "consent-authorization-site-missing",
          `registered ${site.constructor} consumption is missing from ${site.file} in ${site.owner} ordinal ${site.ordinal}`,
          { site },
        ),
      );
    }
  }

  const expectedImports = new Set(registrySites.map(importKey));
  const observedImports = new Map();
  for (const imported of imports) {
    const key = importKey(imported);
    observedImports.set(key, (observedImports.get(key) ?? 0) + 1);
    if (
      imported.aliased ||
      imported.typeOnly ||
      imported.localName !== imported.constructor ||
      imported.importedName !== imported.constructor ||
      !resolvesToDeclarationModule(imported) ||
      !expectedImports.has(key)
    ) {
      violations.push(
        finding(
          "consent-authorization-import-invalid",
          `${imported.file}:${imported.line} has an aliased, non-owning, or non-canonical import binding`,
          { reference: imported },
        ),
      );
    }
  }
  for (const key of expectedImports) {
    if (observedImports.get(key) !== 1) {
      violations.push(
        finding(
          "consent-authorization-import-missing",
          `registered owning file must have exactly one canonical import binding for ${key.replace("\0", ":")}`,
        ),
      );
    }
  }

  for (const reference of unexpected) {
    violations.push(
      finding(
        "consent-authorization-reference-unclassified",
        `${reference.file}:${reference.line} uses ${reference.constructor} as ${reference.syntaxKind}`,
        { reference },
      ),
    );
  }

  for (const reference of noncanonicalAccesses) {
    violations.push(
      finding(
        "consent-authorization-noncanonical-module-access",
        `${reference.file}:${reference.line} reaches the declaration module as ${reference.form}, which the census cannot see a constructor through`,
        { reference },
      ),
    );
  }

  const partition = {
    declarations,
    imports,
    consumptions,
    counts: {
      actor: consumptions.filter((site) => site.classification === "actor").length,
      "self-registration": consumptions.filter((site) => site.classification === "self-registration").length,
      provisioning: consumptions.filter((site) => site.classification === "provisioning").length,
    },
  };
  const partitionDigest = digestConsentAuthorizationPartition(partition);
  const expectedPartitionDigest = registry?.partitionDigest ?? null;
  const registryCounts = {
    actor: registrySites.filter((site) => site.classification === "actor").length,
    "self-registration": registrySites.filter((site) => site.classification === "self-registration").length,
    provisioning: registrySites.filter((site) => site.classification === "provisioning").length,
  };
  const added = consumptions.filter((site) => !registryKeys.has(siteKey(site))).map(siteIdentity);
  const removed = registrySites.filter((site) => !observedKeys.has(siteKey(site))).map(siteIdentity);

  // The owning-import edge is part of the partition, so its delta is reported
  // in the same terms as the consumption delta: an import redirected onto
  // another module preserves every call and still moves the digest and names an
  // expected and an observed identity here.
  const expectedImportIdentities = [
    ...new Map(
      registrySites.map((site) => {
        const identity = expectedConsentAuthorizationImportIdentity(site);
        return [importKey(identity), identity];
      }),
    ).values(),
  ];
  const observedImportIdentities = imports.map(importIdentity);
  const identityOf = (identity) => JSON.stringify(identity);
  const observedImportIdentitySet = new Set(observedImportIdentities.map(identityOf));
  const expectedImportIdentitySet = new Set(expectedImportIdentities.map(identityOf));
  const addedImports = observedImportIdentities.filter(
    (identity) => !expectedImportIdentitySet.has(identityOf(identity)),
  );
  const removedImports = expectedImportIdentities.filter(
    (identity) => !observedImportIdentitySet.has(identityOf(identity)),
  );

  const drift =
    added.length > 0 ||
    removed.length > 0 ||
    addedImports.length > 0 ||
    removedImports.length > 0 ||
    partitionDigest !== expectedPartitionDigest
      ? {
          added,
          removed,
          addedImports,
          removedImports,
          previousCounts: registryCounts,
          currentCounts: partition.counts,
          previousTotal: registrySites.length,
          currentTotal: consumptions.length,
          previousImportTotal: expectedImportIdentities.length,
          currentImportTotal: observedImportIdentities.length,
          previousDigest: expectedPartitionDigest,
          currentDigest: partitionDigest,
        }
      : null;
  if (drift) {
    violations.push(
      finding(
        "consent-authorization-partition-drift",
        `the observed partition changed: ${drift.previousTotal} registered and ${drift.currentTotal} observed consumptions, ${added.length} added and ${removed.length} removed, ${drift.previousImportTotal} expected and ${drift.currentImportTotal} observed owning imports, ${addedImports.length} added and ${removedImports.length} removed, digest ${drift.previousDigest} to ${drift.currentDigest}`,
        { drift },
      ),
    );
  }

  return {
    schemaVersion: "consent-authorization-sites/v1",
    provenance,
    candidateHead: candidate.sha,
    candidateHeadRole: candidateHeadProvenanceRole,
    candidateHeadSource: candidate.source,
    environment: provenance.environment,
    surface: corpus.surface,
    corpus: {
      trackedAuthority: `git ls-tree -r -z ${candidate.sha}`,
      untrackedAuthority: corpus.unionsUntrackedNonignored ? "git ls-files --others --exclude-standard -z" : null,
      unionsUntrackedNonignored: corpus.unionsUntrackedNonignored,
      honoredIgnoreSources: corpus.unionsUntrackedNonignored
        ? [".gitignore", ".git/info/exclude", "core.excludesFile"]
        : [],
      extensionAuthority: "ts.Extension",
      scannedExtensions: corpus.scannedExtensions,
      files: corpus.scannedFiles,
    },
    ownerContexts: {
      artifactPath: "scripts/check-structure/typescript-owner-contexts.json",
      partitionPath: "scripts/check-structure/typescript-owner-context-partition.json",
      ok: ownerContextComparison.ok,
      comparedKeys: ownerContextComparison.comparedKeys,
      evaluatedKeys: ownerContextComparison.evaluatedKeys,
      sourceSha256: committedOwnerContexts?.resolution?.implementationSourceSha256 ?? null,
      runtimeSetHash: committedOwnerContexts?.runtimeSetHash ?? null,
      namedEvaluationSetHash: committedOwnerContexts?.namedEvaluationSetHash ?? null,
      dispositionSetHash: committedOwnerContexts?.dispositionSetHash ?? null,
    },
    coverage: {
      path: consentAuthorizationCensusCoveragePath,
      schemaPath: consentAuthorizationCensusCoverageSchemaPath,
      fixtureRoot: consentAuthorizationCensusFixtureRoot,
      rows: Array.isArray(censusCoverage?.rows) ? censusCoverage.rows.length : 0,
      counts: consentAuthorizationCoverageCounts(censusCoverage),
      axisAuthorities: consentAuthorizationCoverageAxisAuthorities,
      axes: coverageAxes,
      arms: coverageArms,
      specifierShapes: consentAuthorizationSpecifierShapeDispositions.map(({ shape }) => shape),
    },
    census: {
      defaultArm: "admitted-unknown",
      admittedUnknownTotal: admittedUnknowns.reduce((total, entry) => total + entry.count, 0),
      admittedUnknowns,
    },
    partition,
    partitionDigest,
    expectedPartitionDigest,
    drift,
    violations,
  };
}

export function formatConsentAuthorizationCensus(result) {
  const ignore = result.corpus.honoredIgnoreSources;
  return [
    `candidateHead=${result.candidateHead} role=${result.candidateHeadRole} environment=${result.environment}`,
    `analyzedTree=${result.provenance.roles.analyzedTree.sha} (provenance only, asserted about nowhere)`,
    `scanned=${result.surface.scanned}/total=${result.surface.total} tracked-authority='${result.corpus.trackedAuthority}'`,
    `untracked-union=${result.corpus.unionsUntrackedNonignored} untracked-authority='${result.corpus.untrackedAuthority ?? "none"}'`,
    `honored-ignore-rules=${ignore.length > 0 ? ignore.join(",") : "none (tracked objects only)"}`,
    `scanned-extensions=${result.corpus.scannedExtensions.join(",")} extension-authority=${result.corpus.extensionAuthority}`,
    `coverage-rows=${result.coverage.rows} classified=${result.coverage.counts.classified} declared-open=${result.coverage.counts["declared-open"]} silent-by-design=${result.coverage.counts["silent-by-design"]}`,
    `coverage-key-axis=${result.coverage.axes.key.join(",")} authority=${result.coverage.axisAuthorities.key}`,
    `coverage-specifier-axis=${result.coverage.axes.specifier.join(",")} authority=${result.coverage.axisAuthorities.specifier}`,
    `coverage-key-arms=${result.coverage.arms.key.length} coverage-specifier-arms=${result.coverage.arms.specifier.length} specifier-shapes=${result.coverage.specifierShapes.join(",")}`,
    `census-default-arm=${result.census.defaultArm} admitted-unknowns=${result.census.admittedUnknownTotal} shapes=${
      result.census.admittedUnknowns
        .map((entry) => `${entry.axis}:${entry.arm}:${entry.expressionKind}=${entry.count}`)
        .join(",") || "none"
    }`,
    `partitionDigest=${result.partitionDigest} expected=${result.expectedPartitionDigest}`,
  ].join("\n");
}

function main() {
  let result;
  try {
    result = analyzeConsentAuthorizationSites();
  } catch (error) {
    const receipt = {
      code: error?.code ?? "consent-authorization-guard-unavailable",
      reachedClause: error?.reachedClause ?? "unexpected-failure",
      message: error instanceof Error ? error.message : String(error),
    };
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${formatConsentAuthorizationCensus(result)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes("--json") ? 0 : 2)}\n`);
  if (result.violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
