import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

export const consentAuthorizationRegistryPath = "scripts/check-structure/consent-authorization-site-registry.json";
export const consentAuthorizationRegistrySchemaPath =
  "scripts/check-structure/consent-authorization-site-registry.schema.json";

export const consentAuthorizationConstructors = Object.freeze([
  "authorizeConsentForActor",
  "authorizeConsentForSelfRegistration",
  "authorizeConsentForProvisioning",
]);

export const consentAuthorizationRequiredFamilies = Object.freeze([
  "bounded-contexts",
  "contracts",
  "deployables",
  "infrastructure",
  "scripts",
]);

const constructorClassifications = new Map([
  [consentAuthorizationConstructors[0], "actor"],
  [consentAuthorizationConstructors[1], "self-registration"],
  [consentAuthorizationConstructors[2], "provisioning"],
]);
const constructorNames = new Set(consentAuthorizationConstructors);
const declarationFile = "bounded-contexts/identity/features/consents/domain/consent-recording-authorization.ts";

function normalizePath(value) {
  return value.replaceAll("\\", "/");
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

function defaultExecGit(args, rootDir) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isConsentAuthorizationTestSource(relativeFile) {
  const normalized = normalizePath(relativeFile);
  return (
    normalized.includes(".test.") ||
    /(^|\/)tests\//.test(normalized) ||
    /(^|\/)e2e\//.test(normalized) ||
    normalized.startsWith("scripts/check-structure/fixtures/")
  );
}

export function enumerateConsentAuthorizationCorpus({
  repoRoot: rootDir = repoRoot,
  execGit = (args) => defaultExecGit(args, rootDir),
} = {}) {
  const raw = execGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const gitFiles = [...new Set(String(raw).split("\0").filter(Boolean).map(normalizePath))].sort();
  const sourceFiles = gitFiles.filter((file) => /\.(?:ts|tsx|mjs)$/.test(file));
  const candidates = sourceFiles.filter((file) => !isConsentAuthorizationTestSource(file));
  const scannedFiles = candidates;
  return {
    gitFiles,
    sourceFiles,
    candidates,
    scannedFiles,
    surface: { scanned: scannedFiles.length, total: candidates.length },
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

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) {
    return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
  }
  if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return null;
}

function ancestors(node) {
  const values = [];
  for (let current = node.parent; current; current = current.parent) values.push(current);
  return values;
}

function enclosingNamedFunction(startNode) {
  for (let current = startNode; current; current = current.parent) {
    if (isFunctionLike(current)) {
      const name = functionName(current);
      if (name) return name;
    }
  }
  return null;
}

function routeRole(node) {
  for (const ancestor of ancestors(node)) {
    if (!isFunctionLike(ancestor) || !ts.isCallExpression(ancestor.parent)) continue;
    const call = ancestor.parent;
    if (!call.arguments.includes(ancestor) || !ts.isPropertyAccessExpression(call.expression)) continue;
    const method = call.expression.name.text.toUpperCase();
    const route = call.arguments[0];
    if (!ts.isStringLiteral(route) || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
    const owner = enclosingNamedFunction(call.parent);
    if (owner) return `${owner} > ${method} ${route.text}`;
  }
  return null;
}

function variableRole(node) {
  for (const ancestor of ancestors(node)) {
    if (!isFunctionLike(ancestor)) continue;
    const role = functionName(ancestor);
    if (!role || !ts.isVariableDeclaration(ancestor.parent)) continue;
    const owner = enclosingNamedFunction(ancestor.parent.parent);
    if (owner && owner !== role) return `${owner} > ${role}`;
  }
  return null;
}

export function deriveConsentAuthorizationOwner(node) {
  return routeRole(node) ?? variableRole(node) ?? enclosingNamedFunction(node.parent) ?? "<module>";
}

function importDetails(node) {
  const specifier = node.parent;
  if (!ts.isImportSpecifier(specifier)) return null;
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

function lineFor(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scanFile(rootDir, relativeFile) {
  const source = readFileSync(path.join(rootDir, relativeFile), "utf8");
  if (
    !source.includes("\\u") &&
    !consentAuthorizationConstructors.some((constructorName) => source.includes(constructorName))
  ) {
    return [];
  }
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
            owner: deriveConsentAuthorizationOwner(node),
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
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
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
  const openSchemaPaths = collectOpenSchemaObjectPaths(schema);
  for (const pointer of openSchemaPaths) violations.push(`${pointer}: schema object must be recursively closed`);
  if (!registry || !Array.isArray(registry.sites)) return violations;

  const seen = new Set();
  const ordinals = new Map();
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
    const key = siteKey(site);
    if (seen.has(key)) violations.push(`${label}: duplicate semantic site identity`);
    seen.add(key);
    const group = [site.file, site.owner, site.constructor].join("\0");
    const values = ordinals.get(group) ?? [];
    values.push(site.ordinal);
    ordinals.set(group, values);
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

function digestPartition({ declarations, imports, consumptions }) {
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
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function analyzeConsentAuthorizationSites(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const registry = options.registry ?? loadConsentAuthorizationRegistry({ repoRoot: rootDir });
  const schema = options.schema ?? loadConsentAuthorizationRegistrySchema({ repoRoot: rootDir });
  const requiredFamilies = options.requiredFamilies ?? consentAuthorizationRequiredFamilies;
  const registrySites = Array.isArray(registry?.sites) ? registry.sites : [];
  const violations = collectConsentAuthorizationRegistryViolations(registry, schema).map((message) =>
    finding("consent-authorization-registry-invalid", message),
  );
  const corpus = enumerateConsentAuthorizationCorpus({ repoRoot: rootDir, execGit: options.execGit });

  for (const family of requiredFamilies) {
    if (!corpus.scannedFiles.some((file) => file.startsWith(`${family}/`))) {
      violations.push(
        finding("consent-authorization-corpus-narrowed", `scanned corpus has no source from ${family}/`, { family }),
      );
    }
  }

  const references = corpus.scannedFiles.flatMap((file) => scanFile(rootDir, file));
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
    if (!registryKeys.has(siteKey(site))) {
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
  return {
    surface: corpus.surface,
    corpus: {
      files: corpus.scannedFiles,
      families: requiredFamilies.filter((family) => corpus.scannedFiles.some((file) => file.startsWith(`${family}/`))),
    },
    partition,
    partitionDigest: digestPartition(partition),
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
