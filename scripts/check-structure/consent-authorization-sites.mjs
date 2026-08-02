import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
 * #6361 settled Option C: the guard asserts about the tree named by
 * `candidateHead`. `analyzedTree` is recorded as provenance and asserted about
 * nowhere, so a pull-request synthetic merge commit never becomes semantic
 * authority. #6364 already resolves this role for every classified checkout --
 * `landingCandidate` is `pull_request.head.sha` under `pull_request`,
 * `merge_group.head_sha` under `merge_group`, and exact `HEAD` in a plain
 * checkout -- so this guard reads that role rather than adding a second
 * resolution path.
 */
export const candidateHeadProvenanceRole = "landingCandidate";

/**
 * #6361 and #6347 finding F6: a value resolved at run time from Git is
 * recorded, never compared against a committed literal. This expectation set is
 * empty by construction, and its emptiness is the property AC1 asserts -- a
 * single entry here is precisely the defect that failed hosted run 30659850723
 * on a frozen base constant. It is declared rather than omitted so that the
 * negative control has an arbitrary literal of its own to supply.
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

function finding(code, message, details = {}) {
  return { code, message, ...details };
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
/* Provenance -- consumed from #6364, never re-derived here.                  */
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
 * provenance record may pass; every #6364 failure is surfaced under the name
 * #6364 assigned it and exits nonzero, and there is no fallback record.
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
 * #6365 owns the compiler grammar. Its committed total key partition decides
 * which keys are semantic compiler identity and which are environmental
 * provenance, and only the semantic keys are compared -- which is exactly what
 * keeps a lockfile-only change green. Governing variable of
 * MUT-ARTIFACT-COMPARE-ENVIRONMENTAL.
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
  return /\.(?:ts|tsx|mjs)$/.test(file);
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
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
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

function computedConstructorProperty(node) {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
  if (!constructorNames.has(node.text)) return null;
  if (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) return node.text;
  if (
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
  }
  return null;
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
  const visit = (node) => {
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
          references.push({ ...base, referenceClass: "import", ...imported });
        } else if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
          references.push({
            ...base,
            referenceClass: "consumption",
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
      const constructor = computedConstructorProperty(node);
      if (constructor) {
        references.push({
          file: relativeFile,
          constructor,
          line: lineFor(sourceFile, node),
          referenceClass: "unexpected",
          syntaxKind: ts.SyntaxKind[node.parent.kind],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
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
    imports: imports.map(({ file, constructor }) => ({ file, constructor })),
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

export function collectMutationAggregateViolations(aggregate, enumeration) {
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
  return violations;
}

/* ------------------------------------------------------------------------ */
/* Analysis                                                                  */
/* ------------------------------------------------------------------------ */

export function analyzeConsentAuthorizationSites(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const authorityRoot = path.resolve(options.authorityRoot ?? repoRoot);
  const execGit = options.execGit ?? ((args, execOptions) => defaultExecGit(args, rootDir, execOptions));
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

  const corpus = enumerateConsentAuthorizationCorpus({
    repoRoot: rootDir,
    execGit,
    candidateHead: candidate.sha,
    environment: provenance.environment,
  });
  const sources = readConsentAuthorizationCorpusSources({ repoRoot: rootDir, execGit, corpus });
  const references = corpus.scannedFiles.flatMap((file) =>
    scanConsentAuthorizationSource(file, sources.get(file) ?? "", committedOwnerContexts),
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
  const drift =
    added.length > 0 || removed.length > 0 || partitionDigest !== expectedPartitionDigest
      ? {
          added,
          removed,
          previousCounts: registryCounts,
          currentCounts: partition.counts,
          previousTotal: registrySites.length,
          currentTotal: consumptions.length,
          previousDigest: expectedPartitionDigest,
          currentDigest: partitionDigest,
        }
      : null;
  if (drift) {
    violations.push(
      finding(
        "consent-authorization-partition-drift",
        `the observed partition changed: ${drift.previousTotal} registered and ${drift.currentTotal} observed consumptions, ${added.length} added and ${removed.length} removed, digest ${drift.previousDigest} to ${drift.currentDigest}`,
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
