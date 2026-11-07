// Pure event adapter controls; no collector, runner, subprocess or network execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { invariant, sha256 } from "./helpers.mjs";
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
const executableRoles = [
  ...Object.values(inventoryOperations.tools),
  inventoryOperations.runtime,
  inventoryOperations.dockerDaemon,
  inventoryOperations.containerdDaemon,
];
const serviceRoles = Object.values(inventoryOperations.services);
const daemonRoles = [inventoryOperations.dockerPid, inventoryOperations.containerdPid];
const thrownAt = (site, code) =>
  inventoryCategory(
    capture(() =>
      inventoryAt(site, () => {
        throw new Error(code);
      }),
    ),
  );
for (const code of ["STOCK_TOOL_UNAVAILABLE", "REAL_TARGET_UNAVAILABLE", "PACKAGE_IDENTITY_UNAVAILABLE"]) {
  assert(!inventoryInvariantCodes.includes(code));
  const categories = new Set(executableRoles.map(() => inventoryCategory(new Error(code))));
  assert.equal(categories.size, 1);
  console.log(`shared-literal bypass: ${executableRoles.length} executable roles, ${code}, ${[...categories]}`);
}
for (const [roles, code] of [
  [serviceRoles.map((role) => role.read), "SERVICE_FILE_IDENTITY_UNAVAILABLE"],
  [daemonRoles, "ACTIVE_DAEMON_IDENTITY_REQUIRED"],
]) {
  assert(!inventoryInvariantCodes.includes(code));
  const categories = new Set(roles.map(() => inventoryCategory(new Error(code))));
  assert.equal(categories.size, 1);
  console.log(`shared-literal bypass: ${roles.length} roles, ${code}, ${[...categories]}`);
}
function identityInvariantClosure(text) {
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0);
  const sharedHelpers = new Set(["resolveTool", "executable", "owningPackage", "unitFiles"]);
  const violations = [];
  const fields = [];
  const walk = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "invariant") {
      let parent = node.parent;
      let insideIdentity = false;
      let insideSite = false;
      let helper = false;
      while (parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name?.text === "observeIdentity") insideIdentity = true;
        if (ts.isVariableDeclaration(parent) && sharedHelpers.has(parent.name.getText(tree))) helper = true;
        if (ts.isCallExpression(parent) && parent.expression.getText(tree) === "inventoryAt") insideSite = true;
        parent = parent.parent;
      }
      const code = node.arguments[1];
      const daemon =
        node.arguments[0].getText(tree).includes(".test(pid)") ||
        node.arguments[0].getText(tree).includes(".test(containerdPid)");
      if (helper || (insideIdentity && (insideSite || daemon))) {
        if (!ts.isPropertyAccessExpression(code)) violations.push(code.getText(tree));
        else fields.push({ text: code.getText(tree), start: code.getStart(tree), end: code.end });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  assert.deepEqual(violations, [], "identity invariant must use a source-owned site field, not a shared literal");
  assert(fields.length >= 6, "shared helpers and both daemon guards must be covered");
  return fields;
}
const invariantFields = identityInvariantClosure(source);
for (const { start, end } of invariantFields)
  assert.throws(
    () => identityInvariantClosure(`${source.slice(0, start)}"STOCK_TOOL_UNAVAILABLE"${source.slice(end)}`),
    /identity invariant must use/,
  );

// Evaluate only source-selected helper expressions with synthetic dependencies, never observeIdentity.
// No real filesystem, subprocess, collector, runner or metadata query is available to them.
const identityTree = ts.createSourceFile("inventory.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const descendants = (node, predicate) => {
  const found = [];
  const walk = (child) => {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, walk);
  };
  walk(node);
  return found;
};
const expression = (node, bindings, text = node.getText(identityTree)) =>
  new Function(...Object.keys(bindings), `return (${text});`)(...Object.values(bindings));
const helper = (name, bindings, sharedCode) => {
  assert(["resolveTool", "executable", "owningPackage", "unitFiles"].includes(name));
  const declarations = descendants(
    identityTree,
    (node) =>
      ts.isVariableDeclaration(node) &&
      node.name.getText(identityTree) === name &&
      ts.isArrowFunction(node.initializer),
  );
  assert.equal(declarations.length, 1);
  const initializer = declarations[0].initializer;
  let text = initializer.getText(identityTree);
  if (sharedCode) {
    const guards = descendants(
      initializer,
      (node) => ts.isCallExpression(node) && node.expression.getText(identityTree) === "invariant",
    );
    assert.equal(guards.length, 1);
    const code = guards[0].arguments[1];
    const offset = initializer.getStart(identityTree);
    text = `${text.slice(0, code.getStart(identityTree) - offset)}${JSON.stringify(sharedCode)}${text.slice(code.end - offset)}`;
  }
  return expression(initializer, bindings, text);
};
const resolve = (available, sharedCode) =>
  helper(
    "resolveTool",
    {
      cleanEnvironment: () => ({ PATH: "/synthetic/bin" }),
      path: path.posix,
      lstatSync: () => ({ isFile: () => available, isSymbolicLink: () => false }),
      invariant,
    },
    sharedCode,
  );
const missingTool = resolve(false);
const availableTool = resolve(true);
for (const role of executableRoles) {
  assert.equal(thrownAt(role.process, role.process.unavailable), role.process.unavailable);
  assert.equal(
    inventoryCategory(capture(() => inventoryAt(role.process, () => missingTool(role.process, secret)))),
    role.process.unavailable,
  );
  assert.equal(availableTool(role.process, "synthetic-tool"), "/synthetic/bin/synthetic-tool");
  assert.equal(
    inventoryCategory(
      capture(() => inventoryAt(role.process, () => resolve(false, "STOCK_TOOL_UNAVAILABLE")(role.process, secret))),
    ),
    role.process.raw,
  );
  const executableBindings = {
    inventoryAt,
    invariant,
    path: path.posix,
    realpathSync: () => "relative-target",
  };
  const executable = helper("executable", executableBindings);
  assert.equal(inventoryCategory(capture(() => executable(role, "/synthetic/tool"))), role.process.realTarget);
  assert.equal(
    inventoryCategory(
      capture(() => helper("executable", executableBindings, "REAL_TARGET_UNAVAILABLE")(role, "/synthetic/tool")),
    ),
    role.process.raw,
  );
  const packageBindings = {
    inventoryAt,
    invariant,
    query: (site) => (site === role.owner ? "synthetic-package: /synthetic/tool" : "malformed"),
    sha256,
  };
  const owningPackage = helper("owningPackage", packageBindings);
  assert.equal(inventoryCategory(capture(() => owningPackage(role, "/synthetic/tool"))), role.package.packageIdentity);
  assert.equal(
    inventoryCategory(
      capture(() => helper("owningPackage", packageBindings, "PACKAGE_IDENTITY_UNAVAILABLE")(role, "/synthetic/tool")),
    ),
    role.package.raw,
  );
}
for (const field of ["unavailable", "realTarget"])
  assert.equal(new Set(executableRoles.map((role) => role.process[field])).size, 28);
assert.equal(new Set(executableRoles.map((role) => role.package.packageIdentity)).size, 28);
for (const role of serviceRoles) {
  const bindings = {
    inventoryAt,
    invariant,
    path: path.posix,
    query: (site) => (site === role.fragment ? "relative-service-file" : ""),
  };
  const unitFiles = helper("unitFiles", bindings);
  assert.equal(inventoryCategory(capture(() => unitFiles(role, secret))), role.read.serviceFile);
  assert.equal(
    inventoryCategory(capture(() => helper("unitFiles", bindings, "SERVICE_FILE_IDENTITY_UNAVAILABLE")(role, secret))),
    role.read.raw,
  );
}
assert.equal(new Set(serviceRoles.map((role) => role.read.serviceFile)).size, 2);
const daemonGuards = descendants(
  identityTree,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(identityTree) === "invariant" &&
    ts.isPropertyAccessExpression(node.arguments[1]) &&
    node.arguments[1].name.text === "daemonIdentity",
);
assert.equal(daemonGuards.length, 2);
for (const [index, guard] of daemonGuards.entries()) {
  const run = (pid, containerdPid) => expression(guard, { invariant, inventoryOperations, pid, containerdPid });
  assert.equal(run("123", "456"), undefined);
  assert.equal(
    inventoryCategory(capture(() => run(index === 0 ? "0" : "123", index === 1 ? "0" : "456"))),
    daemonRoles[index].daemonIdentity,
  );
}
assert.equal(new Set(daemonRoles.map((role) => role.daemonIdentity)).size, 2);
// The split daemon guards accept exactly the former conjunction, including malformed values.
for (const pid of ["1", "123", "0", "", "-1", "1.5", null, undefined])
  for (const containerdPid of ["2", "456", "0", "", "-1", "2.5", null, undefined]) {
    const expected = /^[1-9]\d*$/.test(pid) && /^[1-9]\d*$/.test(containerdPid);
    let accepted = true;
    try {
      for (const guard of daemonGuards) expression(guard, { invariant, inventoryOperations, pid, containerdPid });
    } catch {
      accepted = false;
    }
    assert.equal(accepted, expected);
  }
const queryDeclaration = descendants(
  identityTree,
  (node) => ts.isVariableDeclaration(node) && node.name.getText(identityTree) === "query",
)[0];
const queryResolve = descendants(
  queryDeclaration,
  (node) => ts.isCallExpression(node) && node.expression.getText(identityTree) === "resolveTool",
);
assert.equal(queryResolve.length, 1);
const versionSite = inventoryOperations.versions.curl;
assert.equal(
  inventoryCategory(
    capture(() =>
      inventoryAt(versionSite, () =>
        expression(queryResolve[0], { resolveTool: missingTool, site: versionSite, tool: "curl" }),
      ),
    ),
  ),
  versionSite.unavailable,
);
for (const role of [inventoryOperations.dockerDaemon, inventoryOperations.containerdDaemon]) {
  for (const failedSite of [role.target, role.hash]) {
    const executable = helper("executable", {
      inventoryAt,
      invariant,
      path: path.posix,
      query: () => "/synthetic/target",
      resolveTool: (site, name) => (site === failedSite ? missingTool : availableTool)(site, name),
    });
    assert.equal(
      inventoryCategory(capture(() => executable(role, "/synthetic/proc/exe", true))),
      failedSite.unavailable,
    );
    assert.notEqual(failedSite.unavailable, versionSite.unavailable);
    assert.notEqual(failedSite.unavailable, role.process.unavailable);
  }
  assert.notEqual(role.target.unavailable, role.hash.unavailable);
}
// Measurement calls the same helpers: successful values and fail-closed predicates are unchanged.
const role = inventoryOperations.tools.curl;
const packageValue = { disposition: "UNOWNED_PUBLIC_DISTRIBUTION_RECONCILIATION_REQUIRED" };
const bytes = Buffer.from("SYNTHETIC_NATIVE_BYTES");
const successExecutable = helper("executable", {
  inventoryAt,
  invariant,
  path: path.posix,
  realpathSync: () => "/synthetic/target",
  readFileSync: () => bytes,
  sha256,
  owningPackage: () => packageValue,
});
assert.deepEqual(successExecutable(role, "/synthetic/tool"), {
  path: "/synthetic/tool",
  realTarget: "/synthetic/target",
  sha256: sha256(bytes),
  format: "native",
  package: packageValue,
});
const successPackage = helper("owningPackage", {
  inventoryAt,
  invariant,
  sha256,
  query: (site) =>
    site === role.owner
      ? "synthetic-package: /synthetic/target"
      : site === role.packageVersion
        ? "synthetic-package\t1.0\tamd64\n"
        : null,
});
assert.deepEqual(successPackage(role, "/synthetic/target"), {
  name: "synthetic-package",
  version: "1.0",
  architecture: "amd64",
  metadataSha256: null,
  policySha256: null,
});
const successService = helper("unitFiles", {
  inventoryAt,
  invariant,
  path: path.posix,
  sha256,
  query: (site) => (site === inventoryOperations.services.docker.fragment ? "/synthetic/unit" : ""),
  realpathSync: (file) => file,
  lstatSync: () => ({ isFile: () => true }),
  readFileSync: () => bytes,
});
assert.deepEqual(successService(inventoryOperations.services.docker, "docker"), [
  { path: "/synthetic/unit", realTarget: "/synthetic/unit", sha256: sha256(bytes) },
]);
function identityBehavior(text) {
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0);
  const shape = (node) => {
    if (ts.isBlock(node)) {
      const statements = node.statements.flatMap((statement) => {
        if (
          ts.isExpressionStatement(statement) &&
          ts.isCallExpression(statement.expression) &&
          statement.expression.expression.getText(tree) === "invariant"
        ) {
          const condition = statement.expression.arguments[0];
          if (
            condition.getText(tree).includes(".test(pid)") ||
            condition.getText(tree).includes(".test(containerdPid)")
          ) {
            const predicates =
              ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                ? [condition.left, condition.right]
                : [condition];
            return predicates.map((predicate) => ["daemon-invariant", shape(predicate)]);
          }
        }
        return [shape(statement)];
      });
      return [node.kind, statements];
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "invariant") return [node.kind, "invariant", shape(node.arguments[0])];
      if (node.expression.text === "resolveTool") {
        assert([1, 2].includes(node.arguments.length));
        return [node.kind, "resolveTool", shape(node.arguments.at(-1))];
      }
    }
    if (
      ts.isArrowFunction(node) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.name.getText(tree) === "resolveTool"
    ) {
      assert(
        ["name", "site,name"].includes(node.parameters.map((parameter) => parameter.name.getText(tree)).join(",")),
      );
      return [node.kind, shape(node.parameters.at(-1)), shape(node.body)];
    }
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(shape(child));
    });
    return [node.kind, node.text ?? null, node.operator ?? null, children];
  };
  return tree.statements.flatMap((node) => {
    if (ts.isFunctionDeclaration(node) && ["observeIdentity", "enforceExecutables", "collect"].includes(node.name.text))
      return [[node.name.text, shape(node)]];
    if (ts.isVariableStatement(node))
      return node.declarationList.declarations
        .filter((declaration) => declaration.name.getText(tree) === "resolveTool")
        .map((declaration) => ["resolveTool", shape(declaration)]);
    return [];
  });
}
// Measured from exact H1'' 238059eb. Normalize only refusal codes, resolver site arguments
// and the equivalent split daemon conjunction; retain every other AST node and ordering.
const baselineIdentityBehavior = "5d78727057fdd31f3e1d72b683e40cd9ff822284a9116db47b8964c51238afe3";
assert.equal(sha256(JSON.stringify(identityBehavior(source))), baselineIdentityBehavior);
for (const [before, after] of [
  ["maxBuffer: 16 * 1024 * 1024", "maxBuffer: 1"],
  ["fields.length === 3", "fields.length === 2"],
  ['format: script ? "script" : "native"', 'format: script ? "script" : "changed"'],
]) {
  assert(source.includes(before));
  assert.notEqual(sha256(JSON.stringify(identityBehavior(source.replace(before, after)))), baselineIdentityBehavior);
}
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
  for (const node of firstArgs("resolveTool")) {
    const resolved = resolve(node);
    assert(resolved.length > 0, "resolver site must resolve");
    for (const site of resolved) assert(sites.includes(site) && Object.hasOwn(site, "unavailable"));
  }
  for (const { text: field } of identityInvariantClosure(text)) {
    const fieldTree = ts.createSourceFile("field.mjs", field, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const code of resolve(fieldTree.statements[0].expression)) assert(expectedCodes.includes(code));
  }
  const querySet = new Set(querySites.filter((site) => Object.hasOwn(site, "incomplete")));
  assert(firstArgs("inventoryDiskHead").length === 1);
  querySet.add(inventoryOperations.diskHead);
  assert.deepEqual(querySet, new Set(queries));
  const wrapperArgs = firstArgs("inventoryAt");
  const wrapped = new Set(wrapperArgs.flatMap(resolve));
  assert.deepEqual(wrapped, new Set(sites));
  for (const site of wrapped) assert(sites.includes(site));
  const spawns = calls.filter((call) => call.expression.text === "spawnSync");
  assert.equal(spawns.length, 2, "all subprocesses must use the registered metadata/disk paths");
  const spawnSites = new Set();
  for (const spawn of spawns) {
    let parent = spawn.parent;
    while (parent && !(ts.isCallExpression(parent) && parent.expression.getText(tree) === "inventoryAt"))
      parent = parent.parent;
    assert(parent, "subprocess reporting wrapper required");
    for (const site of resolve(parent.arguments[0])) if (Object.hasOwn(site, "incomplete")) spawnSites.add(site);
  }
  assert.deepEqual(spawnSites, new Set(queries));
  const span = (node) => ({ start: node.getStart(tree), end: node.end });
  return {
    registrations: [...queryArgs, ...wrapperArgs, ...firstArgs("resolveTool")].map(span),
    spawns: spawns.map((node) => span(node.expression)),
  };
}
const { registrations, spawns } = sourceClosure(source);
for (const { start, end } of registrations) {
  const bypass = `${source.slice(0, start)}unregisteredSite${source.slice(end)}`;
  assert.throws(() => sourceClosure(bypass), /unregistered expression/);
  const missingProperty = `${source.slice(0, start)}inventoryOperations.unregisteredSite${source.slice(end)}`;
  assert.throws(() => sourceClosure(missingProperty), /unregistered operation property/);
}
assert.throws(() => sourceClosure(source.replace("inventoryDiskHead(disk)", "unclassifiedDiskHead(disk)")));
for (const { start, end } of spawns)
  assert.throws(
    () => sourceClosure(`${source.slice(0, start)}unregisteredSpawn${source.slice(end)}`),
    /all subprocesses must use/,
  );
assert.throws(
  () => sourceClosure(`${source}\nspawnSync("SYNTHETIC_NEVER_EXECUTED", []);\n`),
  /all subprocesses must use/,
);
console.log(
  `PASS pure push/branch-creation matrix; ${expectedCodes.length} exact categories, ${sites.length} operation wrappers, ${queries.length} query sites and ${registrations.length * 2 + spawns.length + 2} source-registration bypass controls; 28 executable/2 service/2 daemon roles, ${invariantFields.length} invariant-literal bypasses, version/argument resolution and H1'' measurement behavior preserved; no collector or subprocess execution`,
);
