import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import {
  createPlatformApiLaneSourceAliasPlugin,
  createPlatformApiVitestOverrides,
} from "../scripts/lane-source-aliases";

function canonicalReplacement(aliases: ReturnType<typeof createWorkspaceSourceAliases>, source: string) {
  const hit = aliases.find((alias) =>
    typeof alias.find === "string" ? source === alias.find : alias.find.test(source),
  );
  return hit ? source.replace(hit.find, hit.replacement) : undefined;
}

function sourceForAlias(alias: ReturnType<typeof createWorkspaceSourceAliases>[number]) {
  if (typeof alias.find === "string") return alias.find;
  return alias.find.source
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\(\.\*\)/g, "probe")
    .replaceAll(/\\(.)/g, "$1");
}

test("keeps non-lane aliases canonical and resolves lane aliases to the same source targets", async () => {
  const canonicalAliases = createWorkspaceSourceAliases();
  const hosted = createPlatformApiVitestOverrides({});
  assert.deepEqual(hosted, { resolve: { alias: canonicalAliases } });

  const lane = createPlatformApiVitestOverrides({ CHASE_SETS_LANE_MODE: "1" });
  assert.equal(lane.resolve, undefined);
  assert.equal(lane.plugins?.length, 1);

  const resolveId = lane.plugins?.[0]?.resolveId;
  assert.equal(typeof resolveId, "function");
  const sources = canonicalAliases.map(sourceForAlias);
  assert.ok(sources.length > 0);
  assert.ok(sources.includes("@chase-sets/checkout"));
  assert.ok(sources.includes("@chase-sets/platform-operations/integration/link-intents"));
  assert.ok(sources.includes("@chase-sets/http/probe"));
  assert.ok(canonicalAliases.some((alias) => alias.find instanceof RegExp));
  let delegationOptions: Record<string, unknown> | undefined;
  const resolver = {
    resolve: async (id: string, _importer?: string, options?: Record<string, unknown>) => {
      delegationOptions = options;
      return { id: `${id}.ts` };
    },
  };
  for (const source of sources) {
    const canonical = canonicalReplacement(canonicalAliases, source);
    const expected = canonical && path.extname(canonical) ? canonical : { id: `${canonical}.ts` };
    assert.deepEqual(await resolveId.call(resolver, source), expected, source);
  }

  for (const source of ["@chase-sets/checkout", "@chase-sets/http/responses"]) {
    assert.equal(await resolveId.call(resolver, source), canonicalReplacement(canonicalAliases, source), source);
  }

  const extensionlessSource = "@chase-sets/commercial-terms/seed-support/ids";
  const expectedResolution = `${canonicalReplacement(canonicalAliases, extensionlessSource)}.ts`;
  assert.ok(existsSync(expectedResolution));
  assert.deepEqual(await resolveId.call(resolver, extensionlessSource), { id: expectedResolution });
  assert.equal(delegationOptions?.skipSelf, true);
});

test("does not claim non-workspace imports", async () => {
  const resolveId = createPlatformApiLaneSourceAliasPlugin().resolveId;
  assert.equal(await resolveId.call(undefined, "node:fs"), null);
  assert.equal(await resolveId.call(undefined, "hono"), null);
});

test("keeps canonical first-match order across indexed and fallback aliases", async () => {
  const plugin = createPlatformApiLaneSourceAliasPlugin([
    { find: /^(@synthetic\/pkg)\/special$/, replacement: "/generic.ts" },
    { find: /^@synthetic\/pkg\/special$/, replacement: "/specific.ts" },
  ]);

  assert.equal(await plugin.resolveId("@synthetic/pkg/special"), "/generic.ts");
});
