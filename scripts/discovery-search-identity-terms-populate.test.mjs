import assert from "node:assert/strict";
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
