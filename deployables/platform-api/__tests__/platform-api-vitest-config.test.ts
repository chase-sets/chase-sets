import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createWorkspaceSourceAliases } from "../../../scripts/workspace-source-aliases.mjs";
import {
  createPlatformApiLaneSourceAliasPlugin,
  createPlatformApiVitestOverrides,
} from "../scripts/lane-source-aliases";

function canonicalReplacement(aliases: ReturnType<typeof createWorkspaceSourceAliases>, source: string) {
  return aliases.find((alias) => (typeof alias.find === "string" ? source === alias.find : alias.find.test(source)))
    ?.replacement;
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
  for (const source of [
    "@chase-sets/identity/server",
    "@chase-sets/event-core/storage",
    "@chase-sets/platform-policy/queries",
    "@chase-sets/platform-runtime/api",
  ]) {
    assert.equal(await resolveId(source), canonicalReplacement(canonicalAliases, source), source);
  }
});

test("does not claim non-workspace imports", () => {
  const resolveId = createPlatformApiLaneSourceAliasPlugin().resolveId;
  assert.equal(resolveId("node:fs"), null);
  assert.equal(resolveId("hono"), null);
});
