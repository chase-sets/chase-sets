import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

export const consentAuthorizationRegistryPath = "scripts/check-structure/consent-authorization-site-registry.json";
export const consentAuthorizationRegistrySchemaPath =
  "scripts/check-structure/consent-authorization-site-registry.schema.json";
export const consentAuthorizationDerivationArtifactPath =
  "scripts/check-structure/fixtures/consent-authorization-sites/typescript-6.0.3-owner-contexts.json";

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
const expectedPartitionDigest = "cf3d89ee1d713022bcf3a473a6b5ef5fd0f0ae3fe56c0da83b45d93b7bc0178e";
const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

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

function relativeTo(rootDir, absolutePath) {
  return normalizePath(path.relative(rootDir, absolutePath));
}

export function loadConsentAuthorizationRegistry(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.registryPath ?? consentAuthorizationRegistryPath);
}

export function loadConsentAuthorizationRegistrySchema(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.schemaPath ?? consentAuthorizationRegistrySchemaPath);
}

export function loadConsentAuthorizationDerivationArtifact(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.artifactPath ?? consentAuthorizationDerivationArtifactPath);
}

function packageJsonForEntry(entryPath) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "package.json");
    try {
      return { path: candidate, value: JSON.parse(readFileSync(candidate, "utf8")) };
    } catch {
      current = path.dirname(current);
    }
  }
  throw new Error(`No package.json owns ${entryPath}`);
}

function extractFunctionSource(source, symbolName) {
  const marker = `function ${symbolName}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`TypeScript source symbol ${symbolName} is missing`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`TypeScript source symbol ${symbolName} is unterminated`);
}

function switchCasesAtIndent(functionSource, spaces) {
  const expression = new RegExp(`^${" ".repeat(spaces)}case (\\d+) \\/\\* ([^*]+) \\*\\/:`, "gm");
  return [...functionSource.matchAll(expression)].map((match) => ({
    kind: Number(match[1]),
    name: match[2],
  }));
}

function lockfileKeys(lockfile) {
  const keys = [
    "typescript-api:",
    "version: '@typescript/typescript6@6.0.2'",
    "'@typescript/typescript6@6.0.2':",
    "'@typescript/old': typescript@6.0.3",
    "typescript@6.0.3:",
  ];
  return keys.map((key) => ({ key, occurrences: lockfile.split(key).length - 1 }));
}

function dispositionRows(namedEvaluationContexts) {
  const rows = {
    PropertyAssignment: {
      qualifier: "not a __proto__ setter",
      orderedOutcomes: [
        "stable:recursively-locally-rooted-object-path",
        "transparent:nameless-call-or-new-argument",
        "ambiguous",
      ],
    },
    ShorthandPropertyAssignment: {
      qualifier: "has objectAssignmentInitializer",
      orderedOutcomes: ["ambiguous"],
    },
    VariableDeclaration: {
      qualifier: "identifier name plus initializer",
      orderedOutcomes: ["stable:direct-local-identifier", "ambiguous"],
    },
    Parameter: {
      qualifier: "identifier default initializer and no rest token",
      orderedOutcomes: ["ambiguous"],
    },
    BindingElement: {
      qualifier: "identifier default initializer and no rest token",
      orderedOutcomes: ["ambiguous"],
    },
    PropertyDeclaration: {
      qualifier: "initializer present",
      orderedOutcomes: ["ambiguous"],
    },
    BinaryExpression: {
      qualifier: "identifier left and one derived assignment operator",
      orderedOutcomes: ["ambiguous"],
    },
    ExportAssignment: {
      qualifier: "any expression",
      orderedOutcomes: ["ambiguous"],
    },
  };
  return namedEvaluationContexts.map(({ name, kind }) => ({
    context: name,
    kind,
    ...rows[name],
  }));
}

export function deriveTypeScriptOwnerContexts(rootDir = repoRoot) {
  const workspacePackagePath = path.join(rootDir, "packages/typescript-compiler-api/package.json");
  const wrapperPath = path.join(rootDir, "packages/typescript-compiler-api/index.mjs");
  const lockfilePath = path.join(rootDir, "pnpm-lock.yaml");
  const workspacePackage = JSON.parse(readFileSync(workspacePackagePath, "utf8"));
  const workspaceRequire = createRequire(wrapperPath);
  const aliasEntry = workspaceRequire.resolve("typescript-api");
  const aliasPackage = packageJsonForEntry(aliasEntry);
  const aliasRequire = createRequire(aliasEntry);
  const implementationEntry = realpathSync(aliasRequire.resolve("@typescript/old"));
  const implementationPackage = packageJsonForEntry(implementationEntry);
  const source = readFileSync(implementationEntry, "utf8");
  const runtimeSource = extractFunctionSource(source, "isFunctionLikeDeclarationKind");
  const functionLikeSource = extractFunctionSource(source, "isFunctionLikeKind");
  const namedSource = extractFunctionSource(source, "isNamedEvaluationSource");
  const runtimeKinds = switchCasesAtIndent(runtimeSource, 4);
  const namedEvaluationContexts = switchCasesAtIndent(namedSource, 4);
  const assignmentOperators = switchCasesAtIndent(namedSource, 8);
  const dispositions = dispositionRows(namedEvaluationContexts);
  const lockfile = readFileSync(lockfilePath, "utf8");
  return {
    contractVersion: "consent-authorization-owner-contexts/v1",
    workspace: {
      packageName: workspacePackage.name,
      packageVersion: workspacePackage.version,
      packagePath: relativeTo(rootDir, workspacePackagePath),
      packageSha256: sha256(readFileSync(workspacePackagePath)),
      wrapperPath: relativeTo(rootDir, wrapperPath),
      wrapperSha256: sha256(readFileSync(wrapperPath)),
    },
    resolution: {
      aliasName: aliasPackage.value.name,
      aliasVersion: aliasPackage.value.version,
      aliasEntryPath: relativeTo(rootDir, realpathSync(aliasEntry)),
      implementationPackageName: implementationPackage.value.name,
      implementationVersion: implementationPackage.value.version,
      implementationPath: relativeTo(rootDir, implementationEntry),
      implementationSourceSha256: sha256(source),
      lockfilePath: relativeTo(rootDir, lockfilePath),
      lockfileSha256: sha256(lockfile),
      lockfileKeys: lockfileKeys(lockfile),
    },
    sourceSymbols: {
      functionLikeDeclarationKind: "isFunctionLikeDeclarationKind",
      functionLikeKind: "isFunctionLikeKind",
      namedEvaluationSource: "isNamedEvaluationSource",
      functionLikeKindSourceSha256: sha256(functionLikeSource),
    },
    runtimePredicate: "ts.isFunctionLike(node) && node.body",
    runtimeKinds,
    runtimeSetHash: sha256(JSON.stringify(runtimeKinds)),
    namedEvaluationContexts,
    namedEvaluationSetHash: sha256(JSON.stringify(namedEvaluationContexts)),
    assignmentOperators,
    assignmentOperatorSetHash: sha256(JSON.stringify(assignmentOperators)),
    dispositions,
    dispositionSetHash: sha256(JSON.stringify(dispositions)),
    unknownDisposition: "ambiguous",
  };
}

export function collectConsentAuthorizationDerivationViolations(artifact, rootDir = repoRoot) {
  const derived = deriveTypeScriptOwnerContexts(rootDir);
  if (JSON.stringify(artifact) === JSON.stringify(derived)) return [];
  const violations = [];
  if (artifact?.resolution?.implementationSourceSha256 !== derived.resolution.implementationSourceSha256) {
    violations.push("derivation-source-mismatch");
  }
  if (JSON.stringify(artifact?.runtimeKinds) !== JSON.stringify(derived.runtimeKinds)) {
    violations.push("derivation-runtime-set-mismatch");
  }
  if (
    JSON.stringify(artifact?.namedEvaluationContexts) !== JSON.stringify(derived.namedEvaluationContexts) ||
    JSON.stringify(artifact?.assignmentOperators) !== JSON.stringify(derived.assignmentOperators)
  ) {
    violations.push("derivation-named-evaluation-set-mismatch");
  }
  if (JSON.stringify(artifact?.dispositions) !== JSON.stringify(derived.dispositions)) {
    violations.push("owner-disposition-set-mismatch");
  }
  if (violations.length === 0) violations.push("derivation-artifact-mismatch");
  return violations;
}

function defaultExecGit(args, rootDir) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

export function enumerateConsentAuthorizationCorpus({
  repoRoot: rootDir = repoRoot,
  execGit = (args) => defaultExecGit(args, rootDir),
} = {}) {
  const raw = execGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const gitFiles = [
    ...new Set(Buffer.from(raw).toString("utf8").split("\0").filter(Boolean).map(normalizePath)),
  ].sort();
  const sourceFiles = gitFiles.filter((file) => /\.(?:ts|tsx|mjs)$/.test(file));
  const scannedFiles = sourceFiles.filter((file) => !isConsentAuthorizationTestSource(file));
  return {
    gitFiles,
    sourceFiles,
    scannedFiles,
    surface: { scanned: scannedFiles.length, total: sourceFiles.length },
  };
}

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

function scanFile(rootDir, relativeFile, artifact) {
  return scanConsentAuthorizationSource(relativeFile, readFileSync(path.join(rootDir, relativeFile), "utf8"), artifact);
}

function siteKey(site) {
  return [site.file, site.owner, site.constructor, site.ordinal].join("\0");
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

export function analyzeConsentAuthorizationSites(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const authorityRoot = path.resolve(options.authorityRoot ?? rootDir);
  const registry = options.registry ?? loadConsentAuthorizationRegistry({ repoRoot: rootDir });
  const schema = options.schema ?? loadConsentAuthorizationRegistrySchema({ repoRoot: rootDir });
  const artifact =
    options.derivationArtifact ?? loadConsentAuthorizationDerivationArtifact({ repoRoot: authorityRoot });
  const derivedArtifact = deriveTypeScriptOwnerContexts(authorityRoot);
  const registrySites = Array.isArray(registry?.sites) ? registry.sites : [];
  const violations = collectConsentAuthorizationRegistryViolations(registry, schema).map((message) =>
    finding("consent-authorization-registry-invalid", message),
  );
  for (const code of collectConsentAuthorizationDerivationViolations(artifact, authorityRoot)) {
    violations.push(finding(code, `installed TypeScript owner-context authority failed: ${code}`));
  }
  const corpus = enumerateConsentAuthorizationCorpus({ repoRoot: rootDir, execGit: options.execGit });
  const references = corpus.scannedFiles.flatMap((file) => scanFile(rootDir, file, derivedArtifact));
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
  return {
    surface: corpus.surface,
    corpus: {
      authority: "git ls-files --cached --others --exclude-standard -z",
      honoredIgnoreSources: [".gitignore", ".git/info/exclude", "core.excludesFile"],
      files: corpus.scannedFiles,
    },
    derivation: {
      artifactPath: consentAuthorizationDerivationArtifactPath,
      artifactSha256: sha256(readFileSync(path.join(authorityRoot, consentAuthorizationDerivationArtifactPath))),
      sourceSha256: artifact?.resolution?.implementationSourceSha256 ?? null,
      runtimeSetHash: artifact?.runtimeSetHash ?? null,
      namedEvaluationSetHash: artifact?.namedEvaluationSetHash ?? null,
      dispositionSetHash: artifact?.dispositionSetHash ?? null,
    },
    partition,
    partitionDigest,
    expectedPartitionDigest,
    violations,
  };
}

function main() {
  const result = analyzeConsentAuthorizationSites();
  process.stdout.write(`${JSON.stringify(result, null, process.argv.includes("--json") ? 0 : 2)}\n`);
  if (result.violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
