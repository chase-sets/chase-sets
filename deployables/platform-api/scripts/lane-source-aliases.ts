// @ts-ignore The canonical source-alias helper is intentionally shared as a small ESM script.
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";

type SourceAlias = { find: string | RegExp; replacement: string };

function packageNameForSpecifier(specifier: string) {
  const match = /^(@[^/]+\/[^/]+)(?:\/|$)/.exec(specifier);
  return match?.[1];
}

function packageNameForAlias(alias: SourceAlias) {
  const source = alias.find instanceof RegExp ? alias.find.source : `^${alias.find}`;
  const match = /^\^(@[^\\]+\\\/[^\\]+)/.exec(source);
  return match?.[1]?.replaceAll("\\/", "/");
}

function indexAliases(aliases: SourceAlias[]) {
  const byPackage = new Map();
  for (const alias of aliases) {
    const packageName = packageNameForAlias(alias);
    if (!packageName) continue;
    const entries = byPackage.get(packageName) ?? [];
    entries.push(alias);
    byPackage.set(packageName, entries);
  }
  return byPackage;
}

export function createPlatformApiLaneSourceAliasPlugin() {
  let aliasesByPackage;

  return {
    name: "platform-api-lane-source-aliases",
    enforce: "pre",
    resolveId(source: string) {
      const packageName = packageNameForSpecifier(source);
      if (!packageName) return null;

      aliasesByPackage ??= indexAliases(createWorkspaceSourceAliases());
      for (const alias of aliasesByPackage.get(packageName) ?? []) {
        if (typeof alias.find === "string" ? source === alias.find : alias.find.test(source)) {
          return alias.replacement;
        }
      }
      return null;
    },
  };
}

export function createPlatformApiVitestOverrides(env = process.env, aliases = createWorkspaceSourceAliases) {
  if (env.CHASE_SETS_LANE_MODE === "1") {
    return { plugins: [createPlatformApiLaneSourceAliasPlugin()] };
  }

  return { resolve: { alias: aliases() } };
}
