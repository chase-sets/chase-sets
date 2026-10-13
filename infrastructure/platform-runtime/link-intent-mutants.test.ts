import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { expect, it } from "vitest";
import manifest from "../../bounded-contexts/discovery/context.json" with { type: "json" };
import environmentHosts from "../../scripts/environment-hosts.json" with { type: "json" };
import { resolveWebHostRouteRecords, type WebContextManifest } from "./web";
import { matchRoutes } from "react-router";
import { composeLinkIntents, parseCanonicalLink } from "./link-intents";
import type { LinkIntentCatalog } from "@chase-sets/bounded-context-module";

const catalog = composeLinkIntents([
  { contextName: manifest.contextName, packageName: manifest.packageName, manifest: manifest as WebContextManifest },
]);
const source = readFileSync(fileURLToPath(new URL("./link-intents.ts", import.meta.url)), "utf8");

function mutant(before: string, after: string) {
  const pattern = new RegExp(
    before
      .replace(/\s/g, "")
      .split("")
      .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*"),
    "g",
  );
  expect([...source.matchAll(pattern)]).toHaveLength(1);
  const changed = source.replace(pattern, after);
  const compiled = ts.transpileModule(changed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports: { parseCanonicalLink?: typeof parseCanonicalLink } = {};
  new Function("require", "exports", compiled)((specifier: string) => {
    if (specifier === "./web") return { resolveWebHostRouteRecords };
    if (specifier === "react-router") return { matchRoutes };
    if (specifier.endsWith("environment-hosts.json")) return environmentHosts;
    throw new Error(`Unexpected mutant import ${specifier}`);
  }, exports);
  return exports.parseCanonicalLink!;
}

it("link-intent-build-parse-closed-matrix candidate-versus-bypass mutants", () => {
  const cases = [
    {
      name: "origin-check-bypassed",
      input: "https://unregistered.example/items/fixture-1",
      before: 'if (!authority) return rejected("unregistered-origin");',
      after:
        'if (!authority) return parseCanonicalLink(catalog, input.replace(url.origin, originFor("marketplace-web", "production")));',
    },
    {
      name: "scheme-check-bypassed",
      input: "http://marketplace.chasesets.com/items/fixture-1",
      before: 'if (url.protocol !== "https:") return rejected("unregistered-scheme");',
      after: 'if (url.protocol !== "https:") return parseCanonicalLink(catalog, input.replace(/^http:/, "https:"));',
    },
    {
      name: "userinfo-check-bypassed",
      input: "https://user@marketplace.chasesets.com/items/fixture-1",
      before: 'if (url.username || url.password) return rejected("userinfo");',
      after: 'if (url.username || url.password) return parseCanonicalLink(catalog, input.replace("user@", ""));',
    },
    {
      name: "port-check-bypassed",
      input: "https://marketplace.chasesets.com:444/items/fixture-1",
      before: 'return rejected("noncanonical-authority");',
      after: 'return parseCanonicalLink(catalog, input.replace(":444", ""));',
    },
    {
      name: "protocol-relative-check-bypassed",
      input: "//marketplace.chasesets.com/items/fixture-1",
      before: 'input.startsWith("//")) return rejected("unsafe-url-shape");',
      after: 'input.startsWith("//")) return parseCanonicalLink(catalog, `https:${input}`);',
    },
    {
      name: "traversal-check-bypassed",
      input: "https://marketplace.chasesets.com/x/../items/fixture-1",
      before: 'const rawPath = input.slice(input.indexOf("/", "https://".length)).split("?")[0]!;',
      after: "const rawPath = url.pathname;",
    },
    {
      name: "malformed-encoding-check-bypassed",
      input: "https://marketplace.chasesets.com/items/%ZZ",
      before: 'if (/%(?![\\da-fA-F]{2})/.test(input)) return rejected("malformed-encoding");',
      after:
        'if (/%(?![\\da-fA-F]{2})/.test(input)) return parseCanonicalLink(catalog, input.replace("%ZZ", "fixture-1"));',
    },
    {
      name: "duplicate-query-check-bypassed",
      input: "https://marketplace.chasesets.com/items/fixture-1?market=sell&market=sell",
      before: 'if (Object.hasOwn(query, key)) return rejected("duplicate-parameter");',
      after: "",
    },
    {
      name: "unknown-query-check-bypassed",
      input: "https://marketplace.chasesets.com/items/fixture-1?unknown=x",
      before: "if (!rule || !validQueryValue(value, rule)) throw new Error(`Invalid query parameter ${key}`);",
      after: "if (rule && !validQueryValue(value, rule)) throw new Error(`Invalid query parameter ${key}`);",
    },
    {
      name: "unknown-intent-check-bypassed",
      input: "https://marketplace.chasesets.com/no-such-intent",
      before:
        'if (candidates.length !== 1) return rejected(candidates.length ? "ambiguous-intent" : "unknown-intent-or-parameter");',
      after:
        'if (candidates.length === 0) return parseCanonicalLink(catalog, input.replace("/no-such-intent", "/items/fixture-1")); if (candidates.length !== 1) return rejected("ambiguous-intent");',
    },
  ];
  for (const row of cases) {
    expect(parseCanonicalLink(catalog, row.input).kind, row.name).toBe("rejected");
    expect(mutant(row.before, row.after)(catalog, row.input).kind, row.name).toBe("intent");
  }
  const item = catalog.intents.find((intent) => intent.id === "discovery.item-detail")!;
  const returnCatalog: LinkIntentCatalog = {
    ...catalog,
    intents: [{ ...item, queryParameters: { returnTo: { kind: "return-target", maxLength: 2048 } } }],
  };
  const unsafe = "https://marketplace.chasesets.com/items/fixture-1?returnTo=https%3A%2F%2Fevil.example";
  expect(parseCanonicalLink(returnCatalog, unsafe).kind).toBe("rejected");
  const bypass = mutant(
    'rule.kind === "return-target" ? safeReturnTarget(value) : safeValue(value, rule.maxLength)',
    'rule.kind === "return-target" ? true : safeValue(value, rule.maxLength)',
  );
  expect(bypass(returnCatalog, unsafe).kind, "unsafe-return-target-check-bypassed").toBe("intent");
  const ambiguous = { ...catalog, intents: [...catalog.intents, item] };
  const good = "https://marketplace.chasesets.com/items/fixture-1";
  expect(parseCanonicalLink(ambiguous, good).kind).toBe("rejected");
  expect(
    mutant(
      'if (candidates.length !== 1) return rejected(candidates.length ? "ambiguous-intent" : "unknown-intent-or-parameter");',
      'if (!candidates.length) return rejected("unknown-intent-or-parameter");',
    )(ambiguous, good).kind,
    "ambiguity-check-bypassed",
  ).toBe("intent");
  const shadowCatalog: LinkIntentCatalog = {
    ...catalog,
    partition: [
      ...catalog.partition,
      {
        owner: "synthetic",
        routeId: "static-shadow",
        host: "marketplace-web",
        path: "/items/reserved",
        kind: "indeterminate",
        reason: "Synthetic static-sibling control",
      },
    ],
  };
  const shadowInput = "https://marketplace.chasesets.com/items/reserved";
  expect(parseCanonicalLink(shadowCatalog, shadowInput).kind).toBe("rejected");
  expect(
    mutant(
      'if (routeWinner(catalog, authority.host, `${url.pathname}${url.search}`) !== candidates[0]!.intent.id) return rejected("unregistered-route-winner");',
      "",
    )(shadowCatalog, shadowInput).kind,
    "route-winner-check-bypassed",
  ).toBe("intent");
});
