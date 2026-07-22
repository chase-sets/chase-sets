import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import { fetchWithTimeout } from "./platform-smoke-fetch.mjs";
import { repoRoot } from "./lib/repo.mjs";

export const PUBLIC_WEB_ROUTE_SMOKE_MODES = ["no-5xx", "healthy"];

const mountedRegistryPath = "deployables/public-web/app/generated/web-context-registry.ts";
const generatedHelpArticlesPath = "bounded-contexts/public-presence/features/help/domain/generated/articles.ts";
const publicPresenceLocalizationPath = "contracts/localization/locales/en/public-presence.ts";
const degradedMarkerLocalizationKey = "publicPresence.help.policyValueUnavailable";
const legacyPolicyRouteIds = ["sales-fees", "faq", "order-protection", "refunds-and-returns"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadMountedContextNames(rootDir) {
  const source = await readFile(path.join(rootDir, mountedRegistryPath), "utf8");
  const names = [...source.matchAll(/^\s{4}contextName: "([a-z0-9]+(?:-[a-z0-9]+)*)",$/gmu)].map((match) => match[1]);
  assert(names.length > 0, `${mountedRegistryPath} did not mount any public-web contexts.`);
  assert(new Set(names).size === names.length, `${mountedRegistryPath} mounted a context more than once.`);
  return names;
}

async function loadMountedManifestRoutes(rootDir, mountedContextNames) {
  const routes = [];
  for (const contextName of mountedContextNames) {
    const manifestPath = path.join(rootDir, "bounded-contexts", contextName, "context.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(
      manifest.contextName === contextName,
      `${path.relative(rootDir, manifestPath)} declares contextName '${manifest.contextName}' instead of '${contextName}'.`,
    );
    const contributions = (manifest.deployableContributions ?? []).filter(
      (contribution) => contribution.deployable === "public-web",
    );
    assert(contributions.length === 1, `${contextName} must declare exactly one public-web contribution.`);
    for (const route of contributions[0].routes ?? []) {
      assert(
        typeof route.routeId === "string" && route.routeId,
        `${contextName} has a public-web route without routeId.`,
      );
      assert(
        typeof route.routePath === "string",
        `${contextName}:${route.routeId} has a non-string public-web routePath.`,
      );
      routes.push({
        contextName,
        routeId: route.routeId,
        routePath: route.routePath,
        routeType: route.routeType,
        key: `${contextName}:${route.routeId}`,
      });
    }
  }
  assert(routes.length > 0, "Mounted public-web manifests did not declare any routes.");
  assert(
    new Set(routes.map((route) => route.key)).size === routes.length,
    "Mounted public-web route ids are not unique.",
  );
  return routes;
}

async function loadGeneratedHelpArticles(rootDir) {
  const filePath = path.join(rootDir, generatedHelpArticlesPath);
  const source = await readFile(filePath, "utf8");
  const prefix = "export const helpArticles = ";
  const start = source.indexOf(prefix);
  const expressionStart = start + prefix.length;
  const expressionEnd = source.indexOf(" as const satisfies readonly HelpArticle[];", expressionStart);
  assert(
    start >= 0 && expressionEnd > expressionStart,
    `${generatedHelpArticlesPath} has an unsupported generated shape.`,
  );

  const articles = runInNewContext(`(${source.slice(expressionStart, expressionEnd)})`, Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    filename: generatedHelpArticlesPath,
    timeout: 1_000,
  });
  assert(Array.isArray(articles) && articles.length > 0, `${generatedHelpArticlesPath} did not contain any articles.`);
  return articles.map((article) => {
    assert(typeof article.slug === "string" && article.slug, "Generated help article is missing slug.");
    assert(
      typeof article.locale === "string" && article.locale,
      `Generated help article '${article.slug}' is missing locale.`,
    );
    assert(
      typeof article.category === "string" && article.category,
      `Generated help article '${article.slug}' is missing category.`,
    );
    assert(
      typeof article.href === "string" && article.href.startsWith("/"),
      `Generated help article '${article.slug}' has an invalid href.`,
    );
    assert(
      Array.isArray(article.policyValueKeys),
      `Generated help article '${article.slug}' has invalid policyValueKeys.`,
    );
    return {
      id: `${article.locale}:${article.slug}`,
      slug: article.slug,
      locale: article.locale,
      category: article.category,
      href: article.href,
      policyValueKeys: [...article.policyValueKeys],
    };
  });
}

async function loadPublicPolicyDegradedMarker(rootDir) {
  const source = await readFile(path.join(rootDir, publicPresenceLocalizationPath), "utf8");
  const escapedKey = degradedMarkerLocalizationKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*"${escapedKey}":\\s*("(?:[^"\\\\]|\\\\.)*"),?$`, "mu").exec(source);
  assert(match, `${publicPresenceLocalizationPath} does not declare '${degradedMarkerLocalizationKey}'.`);
  const marker = JSON.parse(match[1]);
  assert(typeof marker === "string" && marker.length > 0, `${degradedMarkerLocalizationKey} must be non-empty.`);
  return marker;
}

function normalizeRoutePath(routePath) {
  return routePath ? `/${routePath.replace(/^\/+|\/+$/gu, "")}` : "/";
}

function representativeParameterizedPath(routePath) {
  const resolved = routePath.replace(
    /:([A-Za-z][A-Za-z0-9_]*)(?:\?)?/gu,
    (_match, parameter) => `route-smoke-${parameter}`,
  );
  assert(!resolved.includes(":"), `Public-web route '${routePath}' contains an unsupported route parameter.`);
  assert(!resolved.includes("*"), `Public-web route '${routePath}' contains an unsupported wildcard.`);
  return normalizeRoutePath(resolved);
}

function concretePathsForManifestRoute(route, helpArticles) {
  if (route.routePath === "help/:category") {
    return [...new Set(helpArticles.map((article) => `/help/${article.category}`))].sort();
  }
  if (route.routePath === "help/:category/:slug") {
    const paths = helpArticles
      .filter((article) => article.href === `/help/${article.category}/${article.slug}`)
      .map((article) => article.href);
    assert(paths.length > 0, "The mounted help article route has no matching generated help articles.");
    return [...new Set(paths)].sort();
  }
  return route.routePath.includes(":") || route.routePath.includes("*")
    ? [representativeParameterizedPath(route.routePath)]
    : [normalizeRoutePath(route.routePath)];
}

function addInventoryEntry(entries, routePath, source) {
  const existing = entries.get(routePath) ?? {
    path: routePath,
    manifestRouteKeys: [],
    helpArticleIds: [],
    strictReasons: [],
  };
  if (source.manifestRouteKey && !existing.manifestRouteKeys.includes(source.manifestRouteKey)) {
    existing.manifestRouteKeys.push(source.manifestRouteKey);
  }
  if (source.helpArticleId && !existing.helpArticleIds.includes(source.helpArticleId)) {
    existing.helpArticleIds.push(source.helpArticleId);
  }
  entries.set(routePath, existing);
}

export async function loadPublicWebRouteInventory(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const mountedContextNames = await loadMountedContextNames(rootDir);
  const manifestRoutes = await loadMountedManifestRoutes(rootDir, mountedContextNames);
  const helpArticles = await loadGeneratedHelpArticles(rootDir);
  const degradedMarker = await loadPublicPolicyDegradedMarker(rootDir);
  const entries = new Map();

  for (const route of manifestRoutes) {
    for (const routePath of concretePathsForManifestRoute(route, helpArticles)) {
      addInventoryEntry(entries, routePath, { manifestRouteKey: route.key });
    }
  }
  for (const article of helpArticles) {
    addInventoryEntry(entries, article.href, { helpArticleId: article.id });
  }

  for (const routeId of legacyPolicyRouteIds) {
    const matchingRoutes = manifestRoutes.filter((route) => route.routeId === routeId);
    assert(matchingRoutes.length === 1, `Expected exactly one mounted legacy policy route '${routeId}'.`);
    const routePaths = concretePathsForManifestRoute(matchingRoutes[0], helpArticles);
    assert(routePaths.length === 1, `Legacy policy route '${routeId}' must resolve to one concrete path.`);
    entries.get(routePaths[0]).strictReasons.push(`legacy-policy:${routeId}`);
  }

  const tokenBearingHelpArticle = helpArticles
    .filter(
      (article) => article.policyValueKeys.length > 0 && article.href === `/help/${article.category}/${article.slug}`,
    )
    .sort((left, right) => left.href.localeCompare(right.href, "en"))[0];
  assert(tokenBearingHelpArticle, "Generated help catalog has no token-bearing help article route.");
  entries.get(tokenBearingHelpArticle.href).strictReasons.push(`token-bearing-help:${tokenBearingHelpArticle.id}`);

  const routeEntries = [...entries.values()]
    .map((entry) => ({
      ...entry,
      manifestRouteKeys: entry.manifestRouteKeys.sort(),
      helpArticleIds: entry.helpArticleIds.sort(),
      strictReasons: entry.strictReasons.sort(),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));

  return {
    mountedContextNames,
    manifestRoutes,
    helpArticles,
    routes: routeEntries,
    strictRoutes: routeEntries.filter((entry) => entry.strictReasons.length > 0),
    tokenBearingHelpArticle,
    degradedMarker,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isHtmlContentType(contentType) {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "text/html";
}

const nonVisibleHtmlElements = new Set(["script", "style", "template", "noscript"]);

function findHtmlElement(node, tagName) {
  if (node.tagName === tagName) return node;
  for (const child of node.childNodes ?? []) {
    const match = findHtmlElement(child, tagName);
    if (match) return match;
  }
  return null;
}

function visibleHtmlText(node) {
  if (node.nodeName === "#comment") return " ";
  if (node.nodeName === "#text") return node.value;
  if (
    nonVisibleHtmlElements.has(node.tagName) ||
    node.attrs?.some((attribute) => attribute.name.toLowerCase() === "hidden")
  ) {
    return " ";
  }
  return ` ${(node.childNodes ?? []).map(visibleHtmlText).join("")} `;
}

function normalizeText(value) {
  return value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizeVisibleHtmlText(html) {
  const document = parse(html);
  return normalizeText(visibleHtmlText(findHtmlElement(document, "body") ?? document));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsCanonicalPhrase(text, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  const phraseBoundary = "\\p{L}\\p{N}\\p{M}\\p{Pc}";
  return new RegExp(
    `(?<![${phraseBoundary}])${escapeRegularExpression(normalizedPhrase)}(?![${phraseBoundary}])`,
    "u",
  ).test(text);
}

async function probeRoute({
  baseUrl,
  route,
  mode,
  degradedMarker,
  fetchImpl,
  attempts,
  retryDelayMs,
  timeoutMs,
  logger,
}) {
  const input = new URL(route.path, `${baseUrl}/`).toString();
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        input,
        { redirect: "follow" },
        {
          label: `public route ${route.path}`,
          timeoutMs,
        },
      );
      const isStrict = mode === "healthy" && route.strictReasons.length > 0;
      const body = isStrict ? await response.text() : null;
      if (!isStrict) await response.body?.cancel();

      const contentType = response.headers.get("content-type");

      if (response.status >= 500) {
        lastFailure = `${route.path} returned ${response.status} ${response.statusText || "Server Error"}.`;
      } else if (isStrict && response.status !== 200) {
        lastFailure = `${route.path} must return healthy 200, got ${response.status} ${response.statusText}.`;
      } else if (isStrict && !isHtmlContentType(contentType)) {
        lastFailure = `${route.path} must return HTML content, got '${contentType ?? "missing Content-Type"}'.`;
      } else if (isStrict && containsCanonicalPhrase(normalizeVisibleHtmlText(body), degradedMarker)) {
        lastFailure = `${route.path} returned the degraded marker '${degradedMarker}'.`;
      } else {
        logger.log(`[public-route-smoke] ${route.path} -> ${response.status}${isStrict ? " healthy" : ""}`);
        return;
      }
    } catch (error) {
      lastFailure = `${route.path} could not be fetched: ${describeError(error)}.`;
    }

    if (attempt < attempts) {
      logger.warn(`[public-route-smoke] ${lastFailure} Retrying (${attempt + 1}/${attempts}) in ${retryDelayMs}ms.`);
      await delay(retryDelayMs);
    }
  }
  throw new Error(lastFailure);
}

export async function smokePublicWebRoutes(options) {
  const mode = options.mode;
  assert(
    PUBLIC_WEB_ROUTE_SMOKE_MODES.includes(mode),
    `Public route smoke mode must be one of: ${PUBLIC_WEB_ROUTE_SMOKE_MODES.join(", ")}.`,
  );
  const parsedBaseUrl = new URL(options.baseUrl);
  assert(["http:", "https:"].includes(parsedBaseUrl.protocol), "Public route smoke base URL must use HTTP or HTTPS.");
  parsedBaseUrl.pathname = "/";
  parsedBaseUrl.search = "";
  parsedBaseUrl.hash = "";

  const logger = options.logger ?? console;
  const inventory = await loadPublicWebRouteInventory({ rootDir: options.rootDir });
  logger.log(
    `[public-route-smoke] Discovered ${inventory.routes.length} concrete paths from ${inventory.manifestRoutes.length} mounted manifest routes and ${inventory.helpArticles.length} generated help articles (${inventory.strictRoutes.length} healthy deployed targets).`,
  );

  const failures = [];
  for (const route of inventory.routes) {
    try {
      await probeRoute({
        baseUrl: parsedBaseUrl.toString(),
        route,
        mode,
        degradedMarker: inventory.degradedMarker,
        fetchImpl: options.fetchImpl ?? fetch,
        attempts: options.attempts ?? 1,
        retryDelayMs: options.retryDelayMs ?? 1_000,
        timeoutMs: options.timeoutMs ?? 15_000,
        logger,
      });
    } catch (error) {
      failures.push(describeError(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Public route smoke failed (${mode}):\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }
  logger.log(`[public-route-smoke] Passed ${inventory.routes.length} public routes in ${mode} mode.`);
  return inventory;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number.parseInt(value, 10);
  assert(
    Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value,
    `${optionName} must be a positive integer.`,
  );
  return parsed;
}

function parseCliArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    assert(option.startsWith("--"), `Unexpected public route smoke argument '${option}'.`);
    const value = args[index + 1];
    assert(value && !value.startsWith("--"), `${option} requires a value.`);
    assert(!values.has(option), `${option} may be provided only once.`);
    values.set(option, value);
    index += 1;
  }
  const supported = new Set(["--base-url", "--mode", "--attempts", "--retry-delay-ms", "--timeout-ms"]);
  for (const option of values.keys()) assert(supported.has(option), `Unknown public route smoke option '${option}'.`);
  assert(values.has("--base-url"), "--base-url is required.");
  assert(values.has("--mode"), "--mode is required.");
  return {
    baseUrl: values.get("--base-url"),
    mode: values.get("--mode"),
    attempts: values.has("--attempts") ? parsePositiveInteger(values.get("--attempts"), "--attempts") : 1,
    retryDelayMs: values.has("--retry-delay-ms")
      ? parsePositiveInteger(values.get("--retry-delay-ms"), "--retry-delay-ms")
      : 1_000,
    timeoutMs: values.has("--timeout-ms") ? parsePositiveInteger(values.get("--timeout-ms"), "--timeout-ms") : 15_000,
  };
}

async function main() {
  await smokePublicWebRoutes(parseCliArgs(process.argv.slice(2)));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(describeError(error));
    process.exitCode = 1;
  });
}
