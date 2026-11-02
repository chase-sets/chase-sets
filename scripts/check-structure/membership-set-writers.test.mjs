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
  console.log(
    `Membership writer census: ${result.scanned}/${result.total} sources; ${result.membershipSites} Membership sites; partition ${result.partition.production}+${result.partition.excluded}=${result.partition.discovered}; sibling bypass ${result.plantedBypass}`,
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.scanned, result.total);
  assert.equal(result.partition.discovered, result.partition.production + result.partition.excluded);
  assert.equal(result.plantedBypass, "REJECTED");
  for (const suffix of [
    "api.ts",
    "features/memberships/api/route.ts",
    "features/memberships/api/mcp.ts",
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
  for (const owner of [
    "membershipRoutes",
    "changeMembershipRole",
    "revokeMembership",
    "reinstateMembership",
    "appendPersonalIdentityRegistration",
    "grantGuestAccountForAuth",
    "acceptInvitationForUserFromAuth",
    "bootstrapPlatformAdminIdentity",
    "membershipReconciler",
    "reconcileRepresentativeMembership",
    "provisionAdminQaActorFixture",
  ])
    assert.ok(
      result.rows.some((row) => row.owner === owner),
      owner,
    );
});

test("source omission cannot turn the census green", () => {
  assert.throws(
    () => scanMembershipSetWriters(sources(), paths.slice(1)),
    /incomplete Membership writer source partition/,
  );
});

test("MCP writer enrollment permits only its three command handlers, never raw appends or new siblings", () => {
  const file = "bounded-contexts/identity/features/memberships/api/mcp.ts";
  for (const owner of ["changeMembershipRole", "revokeMembership", "reinstateMembership"]) {
    const candidate = sources();
    candidate.set(
      file,
      `export function ${owner}(services, id) { return services.commandHandler({streamId: 'identity.membership-' + id}); }`,
    );
    assert.deepEqual(scanMembershipSetWriters(candidate, [...paths, file]).violations, []);
    candidate.set(
      file,
      `export function ${owner}(store, id) { return store.appendToStream({streamId: 'identity.membership-' + id}); }`,
    );
    assert.ok(
      scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
        line.includes(`unclassified Membership writer (appendToStream, ${owner})`),
      ),
    );
  }
  const candidate = sources();
  candidate.set(
    file,
    "export function different(services, id) { return services.commandHandler({streamId: 'identity.membership-' + id}); }",
  );
  assert.ok(
    scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
      line.includes("unclassified Membership writer (commandHandler, different)"),
    ),
  );
});

test("the conservative census filter retains every append spelling, alias and escaped property", () => {
  const file = "scripts/synthetic-new-import.mjs";
  const calls = [
    ...[
      "appendToStream",
      "appendToStreams",
      "appendToStreamInTransaction",
      "appendToStreamsInTransaction",
      "appendToStreamsIndependently",
      "append",
      "commandHandler",
      "createAggregateCommandHandler",
    ].map((name) => `store.${name}(input)`),
    "store['appendToStream'](input)",
    "store[`appendToStream`](input)",
    "store['append\\u0054oStream'](input)",
    "store.append\\u0054oStream(input)",
    "(() => { const { appendToStream: emit } = store; return emit(input); })()",
    "(() => { const emit = store.appendToStream.bind(store); return emit(input); })()",
    "(() => { const label = `before ${input.id} after`; return store.appendToStream(input); })()",
  ];
  for (const call of calls) {
    const candidate = sources();
    candidate.set(
      file,
      `export function different(store, input) { const stream = 'identity.membership-mbr_new'; return ${call}; }`,
    );
    assert.ok(
      scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
        line.includes("unclassified Membership writer"),
      ),
      call,
    );
  }
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

test("a marker-free append cannot hide behind an existing read-only store factory", () => {
  const candidate = sources();
  const file = "bounded-contexts/identity/features/consents/api/terms-acceptance-resolver.ts";
  candidate.set(
    file,
    "export function different(store, input) { const emit = store['appendToStream'].bind(store); return emit(input); }",
  );
  assert.ok(
    scanMembershipSetWriters(candidate, [...paths, file]).violations.includes(
      `${file}: non-Membership EventStore factory gained a raw append`,
    ),
  );
});

test("a differently shaped import writer outside Identity cannot escape through string construction", () => {
  const candidate = sources();
  const file = "scripts/synthetic-new-import.mjs";
  candidate.set(
    file,
    "export function different(store, id, input) { const source = ['identity', 'membership-' + id].join('.'); const { appendToStreams: emit } = store; return emit([{ streamId: source, ...input }]); }",
  );
  assert.ok(
    scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
      line.includes("unclassified Membership writer (appendToStreams, different)"),
    ),
  );
});

test("a sibling cannot borrow a writer name from another owning file", () => {
  const candidate = sources();
  const file = "bounded-contexts/identity/api.ts";
  candidate.set(
    file,
    "export function reconcile(store, id) { return store.appendToStream({streamId: 'identity.membership-' + id, events: []}); }",
  );
  assert.ok(
    scanMembershipSetWriters(candidate, [...paths, file]).violations.some((line) =>
      line.includes("unclassified Membership writer (appendToStream, reconcile)"),
    ),
  );
});
