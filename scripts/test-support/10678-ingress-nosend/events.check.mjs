// Pure event adapter controls; no collector, runner, subprocess or network execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "@chase-sets/typescript-compiler-api";
import {
  inventoryAt,
  inventoryCategory,
  inventoryDiskHead,
  inventoryInvariantCodes,
  inventoryOperations,
  inventoryQueryResult,
  inventoryRefusal,
  inventoryRefusalCodes,
  normalizePushEvent,
  stockTools,
  validateExecutionHead,
} from "./inventory.mjs";
const protocol = JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url)));
const head = "a".repeat(40);
const event = {
  repository: { full_name: "chase-sets/chase-sets" },
  ref: `refs/heads/${protocol.branch}`,
  before: "b".repeat(40),
  after: head,
  deleted: false,
};
const identity = { eventName: "push", ref: event.ref, sha: head };
const normalized = normalizePushEvent(event, identity, protocol);
assert.deepEqual(normalized, {
  eventName: "push",
  ref: event.ref,
  before: event.before,
  after: head,
  head,
  base: null,
  merge: null,
});
validateExecutionHead(normalized, head, head);
assert.throws(() => validateExecutionHead(normalized, "c".repeat(40), head));
assert.throws(() => validateExecutionHead(normalized, head, "c".repeat(40)));
for (const patch of [
  { repository: { full_name: "SYNTHETIC-fork/repo" } },
  { repository: {} },
  { ref: "refs/heads/main" },
  { ref: "refs/heads/other" },
  { ref: "refs/tags/host/10678-ingress-nosend-diagnostic" },
  { ref: undefined },
  { deleted: true },
  { deleted: undefined },
  { after: "0".repeat(40) },
  { after: "c".repeat(40) },
  { after: "bad" },
  { after: undefined },
  { before: undefined },
  { pull_request: { head: { sha: head } } },
])
  assert.throws(() => normalizePushEvent({ ...event, ...patch }, identity, protocol), /EVENT_NOT_ADMITTED/);
for (const patch of [
  { eventName: "pull_request" },
  { eventName: undefined },
  { ref: "refs/heads/main" },
  { ref: undefined },
  { sha: "c".repeat(40) },
  { sha: undefined },
])
  assert.throws(() => normalizePushEvent(event, { ...identity, ...patch }, protocol), /EVENT_NOT_ADMITTED/);
const created = normalizePushEvent(
  { ...event, before: "0".repeat(40), created: true, base_ref: null },
  identity,
  protocol,
);
assert.deepEqual(created, { ...normalized, before: "0".repeat(40) });
assert.equal(created.base, null);
assert.equal(created.merge, null);
validateExecutionHead(created, head, head);
assert.throws(() => validateExecutionHead(created, event.before, head), /DISK_EVENT_PAYLOAD_HEAD_MISMATCH/);
const subsequent = normalizePushEvent({ ...event, created: false, base_ref: null }, identity, protocol);
assert.deepEqual(subsequent, normalized);
validateExecutionHead(subsequent, head, head);
assert.equal(
  inventoryRefusal(new Error("EVENT_NOT_ADMITTED")),
  "INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=EVENT_NOT_ADMITTED",
);
const secret = "SYNTHETIC_PRIVATE_cookie_token_value";
assert.equal(inventoryRefusal(new Error(secret)), "INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=OTHER");
assert(!inventoryRefusal(new Error(secret)).includes(secret));

const terminal = (code) => `INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=${code}`;
assert.equal(
  inventoryRefusal(new Error("INVENTORY_METADATA_QUERY_FAILED")),
  terminal("INVENTORY_METADATA_QUERY_FAILED"),
);
assert.equal(inventoryRefusal(new Error("INVENTORY_METADATA_INCOMPLETE")), terminal("INVENTORY_METADATA_INCOMPLETE"));
assert.equal(inventoryRefusal(new Error("METADATA_QUERY_FAILED")), terminal("OTHER"));
const leaves = (value) => (Object.hasOwn(value, "raw") ? [value] : Object.values(value).flatMap(leaves));
const sites = leaves(inventoryOperations);
const queries = sites.filter((site) => Object.hasOwn(site, "incomplete"));
const expectedCodes = [...inventoryInvariantCodes, ...sites.flatMap(Object.values)];
assert.deepEqual(inventoryRefusalCodes, expectedCodes);
assert.equal(new Set(expectedCodes).size, expectedCodes.length);
const capture = (run) => {
  let thrown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert(thrown, "control must refuse");
  return thrown;
};
for (const code of expectedCodes) {
  assert.equal(inventoryCategory(new Error(code)), code);
  assert.equal(inventoryRefusal(new Error(code)), terminal(code));
  assert.equal(
    inventoryRefusal(
      Object.assign(new Error(code), {
        stack: secret,
        stdout: secret,
        stderr: secret,
        argv: [secret],
        path: secret,
        url: secret,
        package: secret,
        env: secret,
      }),
    ),
    terminal(code),
  );
  assert.equal(inventoryRefusal(new Error(`${code}_${secret}`)), terminal("OTHER"));
  assert.equal(inventoryRefusal(new Error(`${secret}_${code}`)), terminal("OTHER"));
  assert.equal(
    inventoryCategory(
      capture(() =>
        inventoryAt(inventoryOperations.rootSetup, () => {
          throw new Error(code);
        }),
      ),
    ),
    code,
  );
}
for (const unknown of [
  undefined,
  null,
  secret,
  1,
  {},
  { message: secret },
  { message: { toString: () => secret } },
  {
    get message() {
      throw new Error(secret);
    },
  },
]) {
  assert.equal(inventoryRefusal(unknown), terminal("OTHER"));
  assert(!inventoryRefusal(unknown).includes(secret));
}
const markerError = Object.assign(new Error(secret), {
  stack: secret,
  stdout: secret,
  stderr: secret,
  argv: [secret],
  path: secret,
  url: secret,
  package: secret,
  env: secret,
});
for (const site of sites) {
  const value = {};
  assert.equal(
    inventoryAt(site, () => value),
    value,
  );
  assert.equal(
    inventoryRefusal(
      capture(() =>
        inventoryAt(site, () => {
          throw markerError;
        }),
      ),
    ),
    terminal(site.raw),
  );
  // Same exception without the production wrapper cannot acquire the site category.
  assert.equal(inventoryRefusal(markerError), terminal("OTHER"));
  assert(
    !inventoryRefusal(
      capture(() =>
        inventoryAt(site, () => {
          throw markerError;
        }),
      ),
    ).includes(secret),
  );
}
for (const site of [undefined, {}, { raw: secret }, { ...inventoryOperations.rootSetup }, "rootSetup"])
  assert.equal(
    inventoryRefusal(
      capture(() =>
        inventoryAt(site, () => {
          throw markerError;
        }),
      ),
    ),
    terminal("OTHER"),
  );

const complete = { error: undefined, signal: null, status: 0, stdout: Buffer.from(` ${secret}\n`) };
for (const site of queries.filter((site) => site !== inventoryOperations.diskHead)) {
  assert.equal(inventoryQueryResult(site, complete), ` ${secret}`);
  for (const patch of [{ error: markerError }, { signal: "SYNTHETIC_SIGNAL" }, { status: null }, { status: 0.5 }]) {
    const result = { ...complete, ...patch };
    assert.equal(inventoryCategory(capture(() => inventoryQueryResult(site, result))), site.incomplete);
    assert.equal(inventoryCategory(capture(() => inventoryQueryResult(site, result, true))), site.incomplete);
  }
  const nonzero = { ...complete, status: 1 };
  assert.equal(inventoryCategory(capture(() => inventoryQueryResult(site, nonzero))), site.failed);
  assert.equal(inventoryQueryResult(site, nonzero, true), null);
  // Optional nonzero output is never decoded, as before.
  assert.equal(inventoryQueryResult(site, { ...nonzero, stdout: Buffer.from([0xc3]) }, true), null);
  for (const stdout of [Buffer.from([0xc3]), Buffer.from(`\ufeff${secret}`)]) {
    assert.equal(inventoryCategory(capture(() => inventoryQueryResult(site, { ...complete, stdout }))), site.decode);
  }
}
assert.equal(inventoryDiskHead({ status: 0, stdout: ` ${head}\n` }), head);
assert.equal(
  inventoryCategory(capture(() => inventoryDiskHead({ status: 1, stdout: head }))),
  inventoryOperations.diskHead.failed,
);
for (const patch of [{ error: markerError }, { signal: "SYNTHETIC_SIGNAL" }, { status: null }])
  assert.equal(
    inventoryCategory(capture(() => inventoryDiskHead({ status: 1, stdout: head, ...patch }))),
    inventoryOperations.diskHead.incomplete,
  );
assert.equal(
  inventoryCategory(capture(() => inventoryDiskHead({ status: 0, stdout: null }))),
  inventoryOperations.diskHead.raw,
);
assert.equal(
  inventoryCategory(capture(() => inventoryQueryResult({ ...inventoryOperations.server }, { ...complete, status: 1 }))),
  "OTHER",
);

// Resolve query/wrapper expressions from the production AST and the production role table.
// No test-owned list of query sites can omit a new production call.
const source = readFileSync(new URL("./inventory.mjs", import.meta.url), "utf8");
function sourceClosure(text) {
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0);
  const calls = [];
  const walk = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node);
    ts.forEachChild(node, walk);
  };
  walk(tree);
  const env = { inventoryOperations: [inventoryOperations], name: stockTools };
  const resolve = (node) => {
    if (ts.isIdentifier(node)) {
      assert(Object.hasOwn(env, node.text), `unregistered expression ${node.text}`);
      return env[node.text];
    }
    if (ts.isPropertyAccessExpression(node))
      return resolve(node.expression).map((value) => {
        assert(Object.hasOwn(value, node.name.text), "unregistered operation property");
        return value[node.name.text];
      });
    if (ts.isElementAccessExpression(node))
      return resolve(node.expression).flatMap((value) =>
        resolve(node.argumentExpression).flatMap((key) => {
          if (value === inventoryOperations.versions && key === "sh") {
            assert(text.includes('if (name === "sh")'));
            assert(text.includes('versions.sh = "NO_VERSION_SWITCH_PACKAGE_VERSION_CAPTURED"'));
            return [];
          }
          assert(Object.hasOwn(value, key), "unregistered operation key");
          return [value[key]];
        }),
      );
    if (ts.isStringLiteral(node)) return [node.text];
    assert.fail(`unregistered expression ${node.getText(tree)}`);
  };
  const firstArgs = (name) => calls.filter((call) => call.expression.text === name).map((call) => call.arguments[0]);
  env.executableSite = [...new Set(firstArgs("executable").flatMap(resolve))];
  env.serviceSite = [...new Set(firstArgs("unitFiles").flatMap(resolve))];
  const queryArgs = firstArgs("query");
  const querySites = queryArgs.flatMap((node) => {
    const resolved = resolve(node);
    assert(resolved.length > 0, "query site must resolve");
    for (const site of resolved) {
      if (!Object.hasOwn(site, "incomplete")) {
        // Only root-process branches query target/hash; ordinary executables use filesystem reads.
        assert(["executableSite.target", "executableSite.hash"].includes(node.getText(tree)));
        let branch = node.parent;
        while (branch && !ts.isConditionalExpression(branch)) branch = branch.parent;
        assert(branch);
        assert.equal(branch.condition.getText(tree), "rootProcess");
      }
    }
    return resolved;
  });
  env.site = [...new Set(querySites)];
  const querySet = new Set(querySites.filter((site) => Object.hasOwn(site, "incomplete")));
  assert(firstArgs("inventoryDiskHead").length === 1);
  querySet.add(inventoryOperations.diskHead);
  assert.deepEqual(querySet, new Set(queries));
  const wrapperArgs = firstArgs("inventoryAt");
  const wrapped = new Set(wrapperArgs.flatMap(resolve));
  assert.deepEqual(wrapped, new Set(sites));
  for (const site of wrapped) assert(sites.includes(site));
  return [...queryArgs, ...wrapperArgs].map((node) => ({ start: node.getStart(tree), end: node.end }));
}
const registrations = sourceClosure(source);
for (const { start, end } of registrations) {
  const bypass = `${source.slice(0, start)}unregisteredSite${source.slice(end)}`;
  assert.throws(() => sourceClosure(bypass), /unregistered expression/);
  const missingProperty = `${source.slice(0, start)}inventoryOperations.unregisteredSite${source.slice(end)}`;
  assert.throws(() => sourceClosure(missingProperty), /unregistered operation property/);
}
assert.throws(() => sourceClosure(source.replace("inventoryDiskHead(disk)", "unclassifiedDiskHead(disk)")));
console.log(
  `PASS pure push/branch-creation matrix; ${expectedCodes.length} exact categories, ${sites.length} operation wrappers, ${queries.length} query sites and ${registrations.length * 2 + 1} source-registration bypass controls; no collector or subprocess execution`,
);
