import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { fileURLToPath } from "node:url";

// This is deliberately a derivation, rather than the route-smoke checker that
// will consume it.  Its input is the Git index's tracked files: gitignored
// build output and untracked local files never participate.
export const generatedHelpCatalogPath = "bounded-contexts/public-presence/features/help/domain/generated/articles.ts";
export const trackedFileRule =
  "Only paths returned by `git ls-files` are read; therefore gitignored and untracked files are excluded.";
const contextManifestPath = /^bounded-contexts\/[^/]+\/context\.json$/;

function failure(source, detail) {
  throw new Error(`public-web route inventory: ${source}: ${detail}`);
}

function trackedFiles(rootDir) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: rootDir, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "en"));
  } catch (error) {
    failure("git ls-files", error instanceof Error ? error.message : String(error));
  }
}

function readTracked(rootDir, tracked, relativePath, source) {
  if (!tracked.includes(relativePath)) failure(source, "source is missing or not tracked");
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) failure(source, "tracked source is missing from the worktree");
  return readFileSync(absolutePath, "utf8");
}

function stringProperty(object, propertyName, source) {
  const property = object.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === propertyName) ||
        (ts.isStringLiteral(candidate.name) && candidate.name.text === propertyName)),
  );
  if (!property || !ts.isStringLiteral(property.initializer))
    failure(source, `article is missing string '${propertyName}'`);
  return property.initializer.text;
}

export function readGeneratedHelpArticles({ rootDir, tracked, catalogPath = generatedHelpCatalogPath }) {
  const sourceText = readTracked(rootDir, tracked, catalogPath, catalogPath);
  const sourceFile = ts.createSourceFile(catalogPath, sourceText, ts.ScriptTarget.Latest, true);
  if (sourceFile.parseDiagnostics.length > 0)
    failure(catalogPath, sourceFile.parseDiagnostics[0].messageText.toString());

  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "helpArticles");
  let initializer = declaration?.initializer;
  while (
    initializer &&
    (ts.isAsExpression(initializer) ||
      ts.isSatisfiesExpression(initializer) ||
      ts.isParenthesizedExpression(initializer))
  ) {
    initializer = initializer.expression;
  }
  if (!declaration || !initializer || !ts.isArrayLiteralExpression(initializer)) {
    failure(catalogPath, "must export helpArticles as an array literal");
  }

  return initializer.elements.map((element, index) => {
    const source = `${catalogPath} helpArticles[${index}]`;
    if (!ts.isObjectLiteralExpression(element)) failure(source, "article must be an object literal");
    return {
      slug: stringProperty(element, "slug", source),
      category: stringProperty(element, "category", source),
      href: stringProperty(element, "href", source),
      source: catalogPath,
    };
  });
}

function readPublicWebRouteRecords({ rootDir, tracked }) {
  const routes = [];
  for (const relativePath of tracked.filter((candidate) => contextManifestPath.test(candidate))) {
    let document;
    try {
      const parsed = ts.parseConfigFileTextToJson(
        relativePath,
        readTracked(rootDir, tracked, relativePath, relativePath),
      );
      if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, " "));
      document = parsed.config;
    } catch (error) {
      failure(relativePath, `malformed JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      failure(relativePath, "context manifest must be a JSON object");
    }
    if (!Array.isArray(document.deployableContributions)) {
      failure(relativePath, "context manifest must contain a deployableContributions array");
    }
    document.deployableContributions.forEach((contribution, contributionIndex) => {
      if (!contribution || contribution.deployable !== "public-web" || !Array.isArray(contribution.routes)) return;
      contribution.routes.forEach((route, routeIndex) => {
        if (!route || typeof route.routeId !== "string" || typeof route.routePath !== "string") {
          failure(
            `${relativePath} deployableContributions[${contributionIndex}].routes[${routeIndex}]`,
            "routeId and routePath are required strings",
          );
        }
        routes.push({
          ...route,
          source: `${relativePath} deployableContributions[${contributionIndex}].routes[${routeIndex}]`,
        });
      });
    });
  }
  return routes;
}

function expandHelpCategory(route, articles) {
  return [...new Set(articles.map((article) => article.category))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((category) => ({
      kind: "EXPANDED",
      memberId: `${route.routeId}:${category}`,
      path: `/${route.routePath.replace(":category", category)}`,
      source: route.source,
      expansionSource: generatedHelpCatalogPath,
      reason: "category enumerated from the generated help catalog",
    }));
}

function expandHelpArticle(route, articles) {
  return articles.map((article) => ({
    kind: "EXPANDED",
    memberId: `${route.routeId}:${article.category}:${article.slug}`,
    path: article.href,
    source: route.source,
    expansionSource: `${article.source} (${article.category}/${article.slug})`,
    reason: "article enumerated from the generated help catalog",
  }));
}

// The default arm below is intentional: all unknown parameter shapes are
// recorded as INDETERMINATE. New manifest routes can never become fetchable by
// accident merely because this module has not learned their shape yet.
function classifyRoute(route, articles) {
  if (!route.routePath.includes(":")) {
    return [{ kind: "CONCRETE", memberId: route.routeId, path: `/${route.routePath}`, source: route.source }];
  }
  if (route.routePath === "help/:category") return expandHelpCategory(route, articles);
  if (route.routePath === "help/:category/:slug") return expandHelpArticle(route, articles);
  return [
    {
      kind: "INDETERMINATE",
      memberId: route.routeId,
      path: `/${route.routePath}`,
      source: route.source,
      reason: `no authoritative enumeration is defined for parameterized route shape '${route.routePath}'`,
    },
  ];
}

export function derivePublicWebRouteInventory({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  catalogPath = generatedHelpCatalogPath,
} = {}) {
  const tracked = trackedFiles(rootDir);
  const articles = readGeneratedHelpArticles({ rootDir, tracked, catalogPath });
  const routeRecords = readPublicWebRouteRecords({ rootDir, tracked });
  const members = routeRecords.flatMap((route) => classifyRoute(route, articles));
  const partition = Object.fromEntries(
    ["CONCRETE", "EXPANDED", "INDETERMINATE"].map((kind) => [kind, members.filter((member) => member.kind === kind)]),
  );
  const memberIds = new Set();
  for (const member of members) {
    if (memberIds.has(member.memberId)) failure(member.source, `duplicate derived member '${member.memberId}'`);
    memberIds.add(member.memberId);
  }
  return {
    derivedAgainst: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    trackedFileRule,
    sources: { manifests: routeRecords.map((route) => route.source), generatedHelpCatalog: catalogPath },
    counts: Object.fromEntries(Object.entries(partition).map(([kind, entries]) => [kind, entries.length])),
    members,
    partition,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(derivePublicWebRouteInventory(), null, 2)}\n`);
}
