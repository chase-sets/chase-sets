import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scanMembershipSetWriters, validateMembershipSetWriters } from "./membership-set-writers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const paths = [
  "bounded-contexts/identity/support/runtime-support/services.ts",
  "bounded-contexts/identity/features/memberships/api/runtime.ts",
  "bounded-contexts/identity/features/account-management/api/fences.ts",
];
const sources = () => new Map(paths.map((file) => [file, readFileSync(path.join(repoRoot, file), "utf8")]));

test("Membership writer census partitions every source and rejects the differently shaped sibling", () => {
  const result = validateMembershipSetWriters({ repoRoot });
  assert.deepEqual(result.violations, []);
  assert.equal(result.scanned, result.total);
  assert.equal(result.partition.discovered, result.partition.production + result.partition.excluded);
  assert.equal(result.plantedBypass, "REJECTED");
  for (const suffix of [
    "api.ts",
    "features/memberships/api/route.ts",
    "support/runtime-support/production-bootstrap.ts",
    "support/runtime-support/seed.ts",
    "support/runtime-support/admin-qa-actor-fixtures.ts",
    "features/invitations/api/acceptance-operation.ts",
    "features/account-management/api/runtime.ts",
  ])
    assert.ok(
      result.rows.some((row) => row.file === `bounded-contexts/identity/${suffix}`),
      suffix,
    );
});

test("source omission cannot turn the census green", () => {
  assert.throws(
    () => scanMembershipSetWriters(sources(), paths.slice(1)),
    /incomplete Membership writer source partition/,
  );
});

test("unchanged admission inputs plus a direct source append mutant rejects at the planner boundary", () => {
  const candidate = sources();
  assert.deepEqual(scanMembershipSetWriters(candidate, paths).violations, []);
  const file = paths[2];
  candidate.set(
    file,
    candidate
      .get(file)
      .replace(
        "store.appendToStreamsInTransaction(client, expanded)",
        "store.appendToStreamsInTransaction(client, inputs)",
      ),
  );
  assert.ok(
    scanMembershipSetWriters(candidate, paths).violations.includes(
      `${file}: raw append bypasses Membership Set planner`,
    ),
  );
});

test("a new function in an existing writer file cannot inherit its authority", () => {
  const candidate = sources();
  const file = "bounded-contexts/identity/api.ts";
  candidate.set(
    file,
    `export function newSibling(store, id, input) { return store['appendToStream']({streamId: \`identity.membership-\${id}\`, ...input}); }`,
  );
  assert.ok(
    scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
      line.includes("unclassified Membership writer (appendToStream, newSibling)"),
    ),
  );
});
