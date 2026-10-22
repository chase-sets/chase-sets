import { execFileSync } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function deriveLinkIntentOrigins(root) {
  const authority = JSON.parse(readFileSync(path.join(root, "scripts/environment-hosts.json"), "utf8"));
  const origins = {};
  for (const [host, label] of [
    ["marketplace-web", "marketplace"],
    ["admin-web", "admin"],
    ["public-web", ""],
  ]) {
    origins[host] = {};
    for (const environment of ["production", "staging"]) {
      const hostname = [label, environment === "staging" ? "staging" : "", authority.rootDomain]
        .filter(Boolean)
        .join(".");
      const matches = authority.hosts.filter(
        (row) =>
          row.host === hostname &&
          row.status === "current" &&
          row.class === "application" &&
          row.environment === environment &&
          !row.templated,
      );
      if (matches.length !== 1) throw new Error(`Indeterminate canonical origin for ${host}/${environment}`);
      origins[host][environment] = `https://${hostname}`;
    }
  }
  return {
    path: "infrastructure/platform-runtime/link-intent-origins.generated.ts",
    source: `// Generated from scripts/environment-hosts.json by generate-link-intents.mjs.\nimport type { LinkEnvironment } from "@chase-sets/bounded-context-module";\nimport type { WebHostName } from "./web";\n\n// prettier-ignore\nexport const linkIntentOrigins: Readonly<Record<WebHostName, Readonly<Record<LinkEnvironment, string>>>> = ${JSON.stringify(origins, null, 2)};\n`,
  };
}

export function deriveOwnerLinkTypes(root) {
  const paths = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .trim()
    .split(/\r?\n/);
  return paths.flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
    const routes = manifest.deployableContributions
      .flatMap((c) => c.routes)
      .filter((r) => r.canonicalLink?.kind === "route-derived");
    if (!routes.length) return [];
    const rows = routes.map((route) => {
      const pathKeys = [...route.routePath.matchAll(/:([A-Za-z][\w]*)/g)].map((match) => `${match[1]}: string`);
      const queryKeys = Object.entries(route.linkParameters?.query ?? {}).map(
        ([name, rule]) =>
          `${name}?: ${rule.values ? rule.values.map((value) => JSON.stringify(value)).join(" | ") : "string"}`,
      );
      return `  ${JSON.stringify(route.routeId)}: { path: ${pathKeys.length ? `{ ${pathKeys.join("; ")} }` : "Record<string, never>"}; query?: ${queryKeys.length ? `{ ${queryKeys.join("; ")} }` : "never"} };`;
    });
    return [
      {
        path: `bounded-contexts/${manifest.contextName}/support/runtime-support/link-intents.ts`,
        source: `// Generated from this context's route contributions by generate-link-intents.mjs.\nimport manifest from "../../context.json" with { type: "json" };\nimport { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";\n\n// prettier-ignore\nexport const links = createContextLinkBuilder<{\n${rows.join("\n")}\n}>(manifest);\n`,
      },
    ];
  });
}

if (process.argv[1] === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, "../..");
  for (const file of [...deriveOwnerLinkTypes(root), deriveLinkIntentOrigins(root)]) {
    mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
    writeFileSync(path.join(root, file.path), file.source);
  }
}
