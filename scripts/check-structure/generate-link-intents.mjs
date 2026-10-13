import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function deriveOwnerLinkTypes(root) {
  const paths = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], { cwd: root, encoding: "utf8" })
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
        path: `bounded-contexts/${manifest.contextName}/routes/link-intents.ts`,
        source: `// Generated from this context's route contributions by generate-link-intents.mjs.\nimport manifest from "../context.json" with { type: "json" };\nimport { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";\n\n// prettier-ignore\nexport const links = createContextLinkBuilder<{\n${rows.join("\n")}\n}>(manifest);\n`,
      },
    ];
  });
}

if (process.argv[1] === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, "../..");
  for (const file of deriveOwnerLinkTypes(root)) writeFileSync(path.join(root, file.path), file.source);
}
