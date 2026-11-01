import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";

type SourceAlias = { find: string | RegExp; replacement: string };
type AliasIndex = {
  byPackage: Map<string, SourceAlias[]>;
  fallback: SourceAlias[];
};

function packageNameForSpecifier(specifier: string) {
  const match = /^(@[^/]+\/[^/]+)(?:\/|$)/.exec(specifier);
  return match?.[1];
}

function packageNameForAlias(alias: SourceAlias) {
  const source = alias.find instanceof RegExp ? alias.find.source : `^${alias.find}`;
  const unescapedSource = source.replace(/^\^/, "").replaceAll(/\\(.)/g, "$1");
  return /^(@[^/]+\/[^/$(]+)/.exec(unescapedSource)?.[1];
}

function indexAliases(aliases: SourceAlias[]): AliasIndex {
  const byPackage = new Map<string, SourceAlias[]>();
  const fallback: SourceAlias[] = [];
  for (const alias of aliases) {
    const packageName = packageNameForAlias(alias);
    if (!packageName) {
      fallback.push(alias);
      continue;
    }
    const entries = byPackage.get(packageName) ?? [];
    entries.push(alias);
    byPackage.set(packageName, entries);
  }
  return { byPackage, fallback };
}

/** Serves lane mode with an indexed resolver while preserving canonical alias semantics. */
export function createPlatformApiLaneSourceAliasPlugin(aliases = createWorkspaceSourceAliases()) {
  const index = indexAliases(aliases);

  return {
    name: "platform-api-lane-source-aliases",
    enforce: "pre",
    resolveId(source: string) {
      const packageName = packageNameForSpecifier(source);
      if (!packageName) return null;

      for (const alias of [...(index.byPackage.get(packageName) ?? []), ...index.fallback]) {
        if (typeof alias.find === "string" ? source === alias.find : alias.find.test(source)) {
          return source.replace(alias.find, alias.replacement);
        }
      }
      return null;
    },
  };
}

/** Serves platform-api Vitest with canonical aliases outside lane mode. */
export function createPlatformApiVitestOverrides(env = process.env, aliases = createWorkspaceSourceAliases) {
  if (env.CHASE_SETS_LANE_MODE === "1") {
    return { plugins: [createPlatformApiLaneSourceAliasPlugin(aliases())] };
  }

  return { resolve: { alias: aliases() } };
}
