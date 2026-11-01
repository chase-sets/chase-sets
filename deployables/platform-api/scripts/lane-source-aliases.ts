import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import path from "node:path";

type SourceAlias = { find: string | RegExp; replacement: string };
type IndexedAlias = { alias: SourceAlias; index: number };
type AliasIndex = {
  byPackage: Map<string, IndexedAlias[]>;
  fallback: IndexedAlias[];
};

type ResolverContext = {
  resolve: (
    id: string,
    importer?: string,
    options?: Record<string, unknown>,
  ) => Promise<{ id: string } | string | null>;
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
  const byPackage = new Map<string, IndexedAlias[]>();
  const fallback: IndexedAlias[] = [];
  for (const [index, alias] of aliases.entries()) {
    const indexedAlias = { alias, index };
    const packageName = packageNameForAlias(alias);
    if (!packageName) {
      fallback.push(indexedAlias);
      continue;
    }
    const entries = byPackage.get(packageName) ?? [];
    entries.push(indexedAlias);
    byPackage.set(packageName, entries);
  }
  return { byPackage, fallback };
}

/** Creates the indexed lane resolver; canonical mode continues to use resolve.alias. */
export function createPlatformApiLaneSourceAliasPlugin(aliases = createWorkspaceSourceAliases()) {
  const index = indexAliases(aliases);

  return {
    name: "platform-api-lane-source-aliases",
    enforce: "pre",
    async resolveId(
      this: ResolverContext | undefined,
      source: string,
      importer?: string,
      options?: Record<string, unknown>,
    ) {
      const packageName = packageNameForSpecifier(source);
      if (!packageName) return null;

      const candidates = [...(index.byPackage.get(packageName) ?? []), ...index.fallback].sort(
        (left, right) => left.index - right.index,
      );
      for (const { alias } of candidates) {
        if (typeof alias.find === "string" ? source === alias.find : alias.find.test(source)) {
          const updated = source.replace(alias.find, alias.replacement);
          if (path.extname(updated)) return updated;
          return this ? ((await this.resolve(updated, importer, { ...options, skipSelf: true })) ?? updated) : updated;
        }
      }
      return null;
    },
  };
}

/** Serves platform-api Vitest with canonical resolve.alias outside lane mode and an indexed lane plugin under CHASE_SETS_LANE_MODE=1. */
export function createPlatformApiVitestOverrides(env = process.env, aliases = createWorkspaceSourceAliases) {
  if (env.CHASE_SETS_LANE_MODE === "1") {
    return { plugins: [createPlatformApiLaneSourceAliasPlugin(aliases())] };
  }

  return { resolve: { alias: aliases() } };
}
