import type {
  BcMarketplaceRouteModule,
  LinkEnvironment,
  LinkIntent,
  LinkIntentCatalog,
  LinkParameters,
  LinkParameterRule,
  ParsedLinkIntent,
} from "@chase-sets/bounded-context-module";
import { linkIntentOrigins } from "./link-intent-origins.generated";
import { matchRoutes } from "react-router";
import { resolveWebHostRouteRecords, type WebContextManifest, type WebContextRegistry, type WebHostName } from "./web";

export type * from "@chase-sets/bounded-context-module/link-intents";

const hosts: readonly WebHostName[] = ["marketplace-web", "admin-web", "public-web"];
function originFor(host: WebHostName, environment: LinkEnvironment) {
  const origin =
    Object.hasOwn(linkIntentOrigins, host) && Object.hasOwn(linkIntentOrigins[host], environment)
      ? linkIntentOrigins[host][environment]
      : undefined;
  if (typeof origin !== "string") throw new Error(`Indeterminate canonical origin for ${host}/${environment}`);
  return origin;
}

export function composeLinkIntents(contexts: WebContextRegistry): LinkIntentCatalog {
  const intents: LinkIntent[] = [];
  const partition: LinkIntentCatalog["partition"][number][] = [];
  const ids = new Set<string>();
  for (const host of hosts) {
    for (const route of resolveWebHostRouteRecords(contexts, host)) {
      if (route.contextName !== route.sourceContext)
        throw new Error(`Link intent owner mismatch: ${route.contextName}/${route.routeId}`);
      const metadata = route as typeof route &
        Partial<Pick<BcMarketplaceRouteModule, "canonicalLink" | "authorization" | "availability">>;
      const base = {
        owner: route.contextName,
        routeId: route.routeId,
        host,
        path: `/${route.routePath.replace(/^\//, "")}`,
      };
      if (metadata.canonicalLink?.kind !== "route-derived") {
        partition.push({
          ...base,
          kind: "indeterminate",
          reason:
            metadata.canonicalLink?.kind === "not-applicable"
              ? metadata.canonicalLink.reason
              : "No owner-published canonical link metadata",
        });
        continue;
      }
      const id = `${route.contextName}.${route.routeId}`;
      if (ids.has(id)) throw new Error(`Duplicate link intent ${id}`);
      if (!metadata.authorization || !metadata.availability) throw new Error(`Missing link intent metadata ${id}`);
      const path = `/${route.routePath.replace(/^\//, "")}`;
      if (path.includes("*") || path.includes("?")) throw new Error(`Unsupported link intent path ${id}`);
      const pathParameters = [...path.matchAll(/:([A-Za-z][\w]*)/g)].map((match) => match[1]!);
      if (new Set(pathParameters).size !== pathParameters.length) throw new Error(`Duplicate path parameter ${id}`);
      if (
        route.linkParameters !== undefined &&
        (!plainObject(route.linkParameters) ||
          Object.keys(route.linkParameters).some((key) => key !== "query") ||
          !plainObject(route.linkParameters.query))
      )
        throw new Error(`Invalid link parameter schema ${id}`);
      const queryParameters = route.linkParameters?.query ?? {};
      for (const [name, rule] of Object.entries(queryParameters)) {
        if (
          !/^[A-Za-z][\w]*$/.test(name) ||
          !Number.isInteger(rule.maxLength) ||
          rule.maxLength < 1 ||
          rule.maxLength > 2048 ||
          !["value", "return-target"].includes(rule.kind) ||
          Object.keys(rule).some((key) => !["kind", "maxLength", "values"].includes(key)) ||
          (rule.values && (!rule.values.length || rule.values.some((value) => typeof value !== "string")))
        )
          throw new Error(`Invalid query parameter schema ${id}/${name}`);
      }
      ids.add(id);
      intents.push({
        ...base,
        id,
        path,
        pathParameters,
        queryParameters,
        authorization: metadata.authorization,
        availability: metadata.availability,
        webFallback: "same-route",
        missingTarget: "not-found",
        retiredTarget: "reject",
      });
      partition.push({ ...base, kind: "intent", intentId: id });
    }
  }
  return { intents, partition };
}

function plainObject(input: unknown): input is Record<string, unknown> {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
  );
}

function safeValue(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0020\u007f\\/%?#]/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function safeReturnTarget(value: string) {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\%\u0000-\u0020\u007f]/.test(value) &&
    !value.split(/[/?#]/).some((segment) => segment === "." || segment === "..")
  );
}

function validQueryValue(value: unknown, rule: LinkParameterRule): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= rule.maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (!rule.values || rule.values.includes(value)) &&
    (rule.kind === "return-target" ? safeReturnTarget(value) : safeValue(value, rule.maxLength))
  );
}

function validateParameters(intent: LinkIntent, input: unknown): asserts input is LinkParameters {
  if (
    !plainObject(input) ||
    Object.keys(input).some((key) => !["path", "query"].includes(key)) ||
    !plainObject(input.path) ||
    (input.query !== undefined && !plainObject(input.query))
  )
    throw new Error("Invalid link parameter object");
  const path = input.path;
  if (
    Object.keys(path).length !== intent.pathParameters.length ||
    Object.keys(path).some((key) => !intent.pathParameters.includes(key)) ||
    intent.pathParameters.some((key) => !safeValue(path[key]))
  )
    throw new Error("Invalid path parameter");
  for (const [key, value] of Object.entries(input.query ?? {})) {
    const rule = Object.hasOwn(intent.queryParameters, key) ? intent.queryParameters[key] : undefined;
    if (!rule || !validQueryValue(value, rule)) throw new Error(`Invalid query parameter ${key}`);
  }
}

export function buildCanonicalLink(
  catalog: LinkIntentCatalog,
  intentId: string,
  parameters: LinkParameters,
  environment: LinkEnvironment = "production",
) {
  const matches = catalog.intents.filter((intent) => intent.id === intentId);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous link intent ${intentId}`);
  const intent = matches[0]!;
  validateParameters(intent, parameters);
  const path = intent.path.replace(/:([A-Za-z][\w]*)/g, (_, key: string) => encodeURIComponent(parameters.path[key]!));
  const query = new URLSearchParams(parameters.query).toString();
  const href = `${path}${query ? `?${query}` : ""}`;
  if (routeWinner(catalog, intent.host, href) !== intent.id)
    throw new Error(`Link parameters select another contributed route: ${intent.id}`);
  return { href, url: `${originFor(intent.host, environment)}${href}` };
}

function routeWinner(catalog: LinkIntentCatalog, host: WebHostName, href: string) {
  return matchRoutes(
    catalog.partition
      .filter((row) => row.host === host)
      .map((row) => ({ id: `${row.owner}.${row.routeId}`, path: row.path })),
    href,
  )?.at(-1)?.route.id;
}

export function parseCanonicalLink(catalog: LinkIntentCatalog, input: string): ParsedLinkIntent {
  const rejected = (reason: string): ParsedLinkIntent => ({ kind: "rejected", reason });
  if (
    typeof input !== "string" ||
    input.length > 8192 ||
    /[\u0000-\u0020\u007f\\]/.test(input) ||
    input.startsWith("//")
  )
    return rejected("unsafe-url-shape");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return rejected("malformed-url");
  }
  if (url.protocol !== "https:") return rejected("unregistered-scheme");
  if (url.username || url.password) return rejected("userinfo");
  if (!/^https:\/\/[^/?#@:]+(?:\/|\?|#|$)/.test(input)) return rejected("noncanonical-authority");
  const origins = hosts.flatMap((host) =>
    (["production", "staging"] as const).map((environment) => ({
      host,
      environment,
      origin: originFor(host, environment),
    })),
  );
  const authority = origins.find((entry) => entry.origin === url.origin && input.startsWith(`${entry.origin}/`));
  if (!authority) return rejected("unregistered-origin");
  if (url.hash) return rejected("unknown-fragment");
  const rawPath = input.slice(input.indexOf("/", "https://".length)).split("?")[0]!;
  let segments: string[];
  try {
    if (/%(?![\da-fA-F]{2})/.test(input)) return rejected("malformed-encoding");
    segments = rawPath.split("/").slice(1).map(decodeURIComponent);
    if (segments.some((segment) => segment === "." || segment === ".." || /[\\/%\u0000-\u0020\u007f]/.test(segment)))
      return rejected("traversal");
    decodeURIComponent(url.search.replace(/\+/g, " "));
  } catch {
    return rejected("malformed-encoding");
  }
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) return rejected("duplicate-parameter");
    query[key] = value;
  }
  const candidates: { intent: LinkIntent; parameters: LinkParameters }[] = [];
  for (const intent of catalog.intents.filter((entry) => entry.host === authority.host)) {
    const template = intent.path.split("/").slice(1);
    if (
      template.length !== segments.length ||
      template.some((part, index) => !part.startsWith(":") && part !== segments[index])
    )
      continue;
    const path: Record<string, string> = Object.create(null);
    template.forEach((part, index) => {
      if (part.startsWith(":")) path[part.slice(1)] = segments[index]!;
    });
    const parameters = { path, ...(Object.keys(query).length ? { query } : {}) };
    try {
      validateParameters(intent, parameters);
    } catch {
      continue;
    }
    candidates.push({ intent, parameters });
  }
  if (candidates.length !== 1) return rejected(candidates.length ? "ambiguous-intent" : "unknown-intent-or-parameter");
  if (routeWinner(catalog, authority.host, `${url.pathname}${url.search}`) !== candidates[0]!.intent.id)
    return rejected("unregistered-route-winner");
  return { kind: "intent", ...candidates[0]!, environment: authority.environment };
}

export function linkIntentFixtures(catalog: LinkIntentCatalog) {
  return catalog.intents.map((intent) => ({
    intentId: intent.id,
    parameters: { path: Object.fromEntries(intent.pathParameters.map((key) => [key, "fixture-1"])) },
  }));
}

export function createContextLinkBuilder<TParameters extends Record<string, LinkParameters>>(input: unknown) {
  if (
    !plainObject(input) ||
    typeof input.contextName !== "string" ||
    typeof input.packageName !== "string" ||
    !Array.isArray(input.deployableContributions)
  )
    throw new Error("Invalid link context manifest");
  const manifest = input as WebContextManifest & { packageName: string };
  const catalog = composeLinkIntents([
    { contextName: manifest.contextName, packageName: manifest.packageName, manifest },
  ]);
  const build = <TId extends keyof TParameters & string>(
    routeId: TId,
    parameters: TParameters[TId],
    environment: LinkEnvironment = "production",
  ) => buildCanonicalLink(catalog, `${manifest.contextName}.${routeId}`, parameters, environment);
  return Object.assign(build, {
    fromHref(href: string, host: WebHostName, environment: LinkEnvironment = "production") {
      const parsed = parseCanonicalLink(catalog, `${originFor(host, environment)}${href}`);
      if (parsed.kind !== "intent") throw new Error(`Invalid owner link: ${parsed.reason}`);
      return buildCanonicalLink(catalog, parsed.intent.id, parsed.parameters, environment);
    },
  });
}
