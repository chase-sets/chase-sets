import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";
import {
  parseIdentityTermsPopulationOptions,
  runIdentityTermsPopulation,
} from "./discovery-search-identity-terms-populate.mjs";

const env = { DATABASE_URL_DISCOVERY: "local-discovery", PLATFORM_CONTROL_DATABASE_URL: "local-control" };
const args = [
  "--environment=local",
  `--writer-sha=${"a".repeat(40)}`,
  "--writers-upgraded",
  "--alias-search=enabled",
  "--authorization=synthetic-test",
];

test("population dependencies load in native Node without opening database connections", () => {
  const resolver = new URL("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url).href;
  const control = new URL("../infrastructure/platform-runtime/control-plane.ts", import.meta.url).href;
  const adapter = new URL(
    "../bounded-contexts/discovery/support/runtime-support/search-identity-terms-population.ts",
    import.meta.url,
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { register } from "node:module";
       import assert from "node:assert/strict";
       register(${JSON.stringify(resolver)});
       const [{ Pool }, control, adapter] = await Promise.all([
         import("pg"), import(${JSON.stringify(control)}), import(${JSON.stringify(adapter)})
       ]);
       assert.equal(typeof Pool, "function");
       assert.equal(typeof control.createPostgresPlatformControlPlane, "function");
       assert.equal(typeof adapter.populateDiscoverySearchIdentityTerms, "function");`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("requires upgraded writers, exact SHA, authorization, explicit alias setting and both app-role connections", () => {
  assert.equal(parseIdentityTermsPopulationOptions(args, env).writerSha, "a".repeat(40));
  for (const prefix of ["--environment", "--writer-sha", "--writers-upgraded", "--alias-search", "--authorization"]) {
    assert.throws(() =>
      parseIdentityTermsPopulationOptions(
        args.filter((arg) => !arg.startsWith(prefix)),
        env,
      ),
    );
  }
  assert.throws(() => parseIdentityTermsPopulationOptions([...args, "--unknown"], env));
  assert.throws(() => parseIdentityTermsPopulationOptions([...args, "--environment=production"], env));
  assert.throws(() => parseIdentityTermsPopulationOptions(args, { ...env, DISCOVERY_ALIAS_SEARCH: "off" }), /differs/);
  assert.throws(() => parseIdentityTermsPopulationOptions(args, { DATABASE_URL: "no-fallback" }), /required/);
});

test("forwards the validated run and never returns a receipt after adapter failure", async () => {
  const calls = [];
  assert.deepEqual(
    await runIdentityTermsPopulation(args, env, {
      populate: async (input) => {
        calls.push(input);
        return { committed: true };
      },
    }),
    { committed: true },
  );
  assert.equal(calls[0].authorization, "synthetic-test");
  assert.match(calls[0].ownerId, /^discovery-identity-terms:/);
  await assert.rejects(
    runIdentityTermsPopulation(args, env, {
      populate: async () => {
        throw new Error("lost lease");
      },
    }),
    /lost lease/,
  );
});
