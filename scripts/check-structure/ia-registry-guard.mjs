import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { listContextManifests, repoRoot } from "../lib/repo.mjs";

// Guard: every route family a bounded context contributes to a web deployable
// (deployableContributions[].routes[] in the context's context.json), and the
// admin-web console/desk section it lives under, must be declared in
// scripts/check-structure/ia-registry.json before the guard passes. A
// "family" is the top-level path segment of a contributed routePath (before
// the admin-web section prefix that resolveWebHostRouteRecords applies at
// build time) — e.g. routePath "sessions/:id" belongs to family "sessions".
//
// Why: routes are already contributed declaratively (context.json ->
// context.json -> hand-authored context-registry per deployable), but nothing
// previously stopped a context from contributing a
// brand-new top-level route family. Once a family is registered, any context
// may attach a nested panel/tab/drawer under it (a routePath whose top-level
// segment matches the family) with no new entry — grafts stay cheap; a new
// top-level surface needs one, which is a reviewed, deliberate act.
//
// This guard has two independent checks:
//
// 1. Registry membership: every route a context.json contributes must
//    resolve to a family present in ia-registry.json (data, not code, per
//    check-structure convention), and every registered family must still
//    have at least one contributed route (a ratchet against stale entries).
// 2. Composition-root literals: deployables/*/app/routes.ts wires context-
//    contributed routes exclusively through generated helper calls
//    (resolveXxxRouteConfigRecords()); the only route() calls with a literal
//    string path are a short, fixed set of non-context infrastructure routes
//    (health checks, manifest, service worker, section home pages, ...).
//    Each composition root is parsed with ts.createSourceFile and walked
//    with ts.forEachChild to find every route() call regardless of nesting
//    inside layout() children arrays or .flatMap() calls — a raw text scan
//    would need to re-derive that nesting itself and risks missing a call
//    wrapped across lines or hidden behind a computed argument. A literal
//    path outside the declared infrastructureRoutes allowlist means someone
//    hand-added a route directly in the composition root instead of
//    contributing it through a context's context.json — the exact
//    "improvised, not declared" shape this guard exists to catch.

export const iaRegistryPath = "scripts/check-structure/ia-registry.json";

export const knownWebDeployables = new Set(["admin-web", "marketplace-web", "public-web"]);
export const adminWebSections = new Set(["access", "catalog", "commerce", "growth", "support", "platform"]);

// The deployable composition roots that wire context-contributed routes.
// Kept here (not derived from context.json) because these are fixed
// per-deployable entry points, not context-owned data.
export const iaRouteConfigFiles = [
  { deployable: "admin-web", relativeFile: "deployables/admin-web/app/routes.ts" },
  { deployable: "marketplace-web", relativeFile: "deployables/marketplace/app/routes.ts" },
  { deployable: "public-web", relativeFile: "deployables/public-web/app/routes.ts" },
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function lineFor(content, position) {
  return content.slice(0, position).split(/\r?\n/).length;
}

export function routeFamilySegment(routePath) {
  return (routePath ?? "").split("/")[0] ?? "";
}

export function iaFamilyKey({ deployable, section, family }) {
  return `${deployable}::${section ?? ""}::${family}`;
}

export function loadIaRegistry(options = {}) {
  const rootDir = options.repoRoot ?? repoRoot;
  const registryPath = options.registryPath ?? iaRegistryPath;
  const absolutePath = path.join(rootDir, registryPath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

export function validateIaRegistryShape(registry, { contextNames, registryPath = iaRegistryPath } = {}) {
  const violations = [];

  if (!isPlainObject(registry)) {
    violations.push(`${registryPath}: registry must be an object`);
    return violations;
  }

  if (!Array.isArray(registry.families)) {
    violations.push(`${registryPath}: families must be an array`);
  } else {
    const seenKeys = new Set();

    registry.families.forEach((entry, index) => {
      const label = `${registryPath} families[${index}]`;

      if (!isPlainObject(entry)) {
        violations.push(`${label}: entry must be an object`);
        return;
      }

      if (!knownWebDeployables.has(entry.deployable)) {
        violations.push(`${label}: deployable must be one of ${[...knownWebDeployables].join(", ")}`);
        return;
      }

      if (entry.deployable === "admin-web") {
        if (!adminWebSections.has(entry.section)) {
          violations.push(
            `${label}: section is required for admin-web entries and must be one of ${[...adminWebSections].join(", ")}`,
          );
        }
      } else if (entry.section !== undefined) {
        violations.push(`${label}: section must be omitted for non-admin-web deployables`);
      }

      if (typeof entry.family !== "string" || entry.family.includes("/")) {
        violations.push(`${label}: family must be a single path segment string (no "/")`);
      }

      if (!isNonEmptyString(entry.owningContext)) {
        violations.push(`${label}: owningContext must be a non-empty string`);
      } else if (contextNames && !contextNames.has(entry.owningContext)) {
        violations.push(`${label}: owningContext '${entry.owningContext}' does not match any bounded context`);
      }

      if (!isNonEmptyString(entry.purpose)) {
        violations.push(`${label}: purpose must be a non-empty string`);
      }

      const key = iaFamilyKey(entry);
      if (seenKeys.has(key)) {
        violations.push(`${label}: duplicate family entry for ${key}`);
      }
      seenKeys.add(key);
    });
  }

  if (!isPlainObject(registry.infrastructureRoutes)) {
    violations.push(`${registryPath}: infrastructureRoutes must be an object`);
  } else {
    for (const deployable of knownWebDeployables) {
      const list = registry.infrastructureRoutes[deployable];
      if (!Array.isArray(list) || !list.every((value) => typeof value === "string")) {
        violations.push(`${registryPath}: infrastructureRoutes.${deployable} must be an array of strings`);
      }
    }
  }

  return violations;
}

export function computeContributedRouteFamilies({ contextManifests }) {
  const families = [];

  for (const context of contextManifests.values()) {
    const contextName = context.manifest?.contextName;
    const fileLabel = `${context.root}/context.json`;

    for (const contribution of context.manifest?.deployableContributions ?? []) {
      if (!knownWebDeployables.has(contribution.deployable)) continue;

      for (const route of contribution.routes ?? []) {
        families.push({
          deployable: contribution.deployable,
          section: contribution.deployable === "admin-web" ? route.section : undefined,
          family: routeFamilySegment(route.routePath),
          contextName,
          routeId: route.routeId,
          routePath: route.routePath,
          file: fileLabel,
        });
      }
    }
  }

  return families;
}

// Parses a deployable's route-config composition root and returns every
// literal string path passed as the first argument to a top-level `route(`
// call, wherever it appears in the module (react-router/dev's `layout` takes
// a component file as its first argument, not a URL path, so only `route`
// calls are in scope here).
export function collectRouteConfigLiteralPaths({ repoRoot: rootDir, relativeFile }) {
  const absolutePath = path.join(rootDir, relativeFile);
  if (!existsSync(absolutePath)) {
    return [];
  }

  const content = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const literals = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "route" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      literals.push({
        path: node.arguments[0].text,
        line: lineFor(content, node.getStart(sourceFile)),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function defaultContextManifests(rootDir) {
  return new Map(
    listContextManifests({ repoRoot: rootDir }).map((context) => [
      `bounded-contexts/${context.dirName}`,
      { root: `bounded-contexts/${context.dirName}`, manifest: context.manifest },
    ]),
  );
}

export function findIaRegistryViolations(options = {}) {
  const rootDir = options.repoRoot ?? repoRoot;
  const registryPath = options.registryPath ?? iaRegistryPath;
  const contextManifests = options.contextManifests ?? defaultContextManifests(rootDir);
  const violations = [];

  const registry = loadIaRegistry({ repoRoot: rootDir, registryPath });
  if (!registry) {
    violations.push(`${registryPath}: registry file is missing`);
    return violations;
  }

  const contextNames = new Set(
    [...contextManifests.values()].map((context) => context.manifest?.contextName).filter(Boolean),
  );

  violations.push(...validateIaRegistryShape(registry, { contextNames, registryPath }));
  if (!Array.isArray(registry.families)) {
    return violations;
  }

  const registeredEntries = new Map();
  for (const entry of registry.families) {
    if (!isPlainObject(entry) || !knownWebDeployables.has(entry.deployable)) continue;
    registeredEntries.set(iaFamilyKey(entry), entry);
  }

  const contributedFamilies = computeContributedRouteFamilies({ contextManifests });
  const observedKeys = new Set();

  for (const contributed of contributedFamilies) {
    const key = iaFamilyKey(contributed);
    observedKeys.add(key);

    if (!registeredEntries.has(key)) {
      const sectionLabel = contributed.section ? ` ${contributed.section}` : "";
      violations.push(
        `${contributed.file}: route '${contributed.routeId}' (routePath ${JSON.stringify(contributed.routePath)}) ` +
          `contributes an unregistered ${contributed.deployable}${sectionLabel} route family '${contributed.family}'. ` +
          `Register it in ${registryPath} (a deliberate, reviewed act), or, if this is a panel/tab on an existing ` +
          "surface, point the routePath's top-level segment at an already-registered family instead.",
      );
    }
  }

  for (const [key, entry] of registeredEntries) {
    if (!observedKeys.has(key)) {
      violations.push(
        `${registryPath}: family entry ${JSON.stringify(entry)} has no contributed route left; remove the stale ` +
          "entry in the same change that removed its last route (ratchet — the registry tracks live surfaces only).",
      );
    }
  }

  const infrastructureRoutes = isPlainObject(registry.infrastructureRoutes) ? registry.infrastructureRoutes : {};
  const routeConfigFiles = options.routeConfigFiles ?? iaRouteConfigFiles;

  for (const { deployable, relativeFile } of routeConfigFiles) {
    const allowlist = new Set(infrastructureRoutes[deployable] ?? []);

    for (const literal of collectRouteConfigLiteralPaths({ repoRoot: rootDir, relativeFile })) {
      if (allowlist.has(literal.path)) continue;

      violations.push(
        `${relativeFile}:${literal.line}: route(${JSON.stringify(literal.path)}, ...) is a literal route not ` +
          `declared in ${registryPath} infrastructureRoutes.${deployable}. Route families must be contributed ` +
          "through a context's context.json deployableContributions (and registered there), not hand-added to the " +
          "deployable's composition root.",
      );
    }
  }

  return violations;
}

// Convenience wrapper matching the { violations, warnings } shape the other
// check-structure/run.mjs phase validators return.
export function validateIaRegistry(options = {}) {
  return { violations: findIaRegistryViolations(options), warnings: [] };
}

async function main() {
  const contextManifests = defaultContextManifests(repoRoot);
  const result = validateIaRegistry({ repoRoot, contextManifests });

  if (result.violations.length > 0) {
    console.error("Surface & IA registry guard failed.");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Surface & IA registry guard passed across ${contextManifests.size} bounded contexts.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
