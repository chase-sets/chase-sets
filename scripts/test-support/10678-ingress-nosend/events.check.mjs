// Pure event adapter controls; no collector, runner, subprocess or network execution.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { fixtureAuthority, fixtureMeasurementPayload } from "./authority-fixtures.mjs";
import {
  assembleReceipt,
  classifyExposure,
  exposureRuleIds,
  invariant,
  matrix,
  scanExposure,
  sha256,
} from "./helpers.mjs";
import {
  inventoryAt,
  inventoryCategory,
  inventoryDiskHead,
  inventoryInvariantCodes,
  inventoryOperations,
  inventoryQueryResult,
  inventoryRefusal,
  inventoryRefusalCodes,
  identityFingerprint,
  inventoryPublicationFiles,
  inventoryPublicationQueries,
  inventoryPublicationHitClasses,
  serializeIdentity,
  projectIdentity,
  decodeAuthority,
  validateInventoryPublication,
  normalizePushEvent,
  stockTools,
  measurementConfig,
  measurementPublicationRehearsal,
  measurementPublicationRoles,
  validateExecutionHead,
  bootstrapComparisonComponents,
  bootstrapComparisonPredicates,
  bootstrapComparisonCodes,
  createBootstrapComparison,
  bootstrapComparisonResult,
} from "./inventory.mjs";
const protocol = JSON.parse(readFileSync(new URL("./protocol.json", import.meta.url)));
const probeFunctions = ["distribution", "validateClosureDescriptor", "scriptClosureFingerprint", "validateScriptClosure", "validateToolPin", "validateToolObservation", "compareIdentity", "identityFingerprint", "enforceExecutables", "enforceIdentityPins"];
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
const immutableH2Source = execFileSync("git", ["show", "7400687eb03a26212b17998145ede703340a971f:scripts/test-support/10678-ingress-nosend/inventory.mjs"], { encoding: "utf8", windowsHide: true });
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

// Run the production constructor body only with in-memory I/O and synthetic query results.
// Neither the exported observer nor any real tool, collector, runner or filesystem writer is called.
function syntheticIdentity() {
  const written = new Map();
  const writeFileSync = (file, value) => written.set(file, Buffer.from(value));
  const declarations = (name) =>
    descendants(identityTree, (node) => ts.isVariableDeclaration(node) && node.name.getText(identityTree) === name);
  const bindings = {
    directory: "/synthetic/private",
    pins: Object.fromEntries(stockTools.map((name) => [name, { path: `/synthetic/${name}` }])),
    stockTools,
    inventoryAt,
    inventoryOperations,
    inventoryQueryResult,
    invariant,
    sha256,
    inventoryPublicationFiles,
    serializeIdentity,
    queryPublicationRoles: new Map(inventoryPublicationQueries.map((entry) => [entry.site, entry])),
    identityPublicationRoles: new WeakMap(),
    path: path.posix,
    os: { arch: () => "x64", release: () => "synthetic-kernel" },
    process: { env: { ImageVersion: "20000101.1.0", ImageOS: "ubuntu24" }, execPath: "/synthetic/node" },
    Date: class extends Date {
      constructor() {
        super("2000-01-01T00:00:00.000Z");
      }
    },
    mkdirSync: () => {},
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpathSync: (file) => file,
    readFileSync: (file) => (file === "/etc/os-release" ? "NAME=Synthetic\n" : bytes),
    writeFileSync,
    spawnSync: (executable, args) => {
      const tool = path.posix.basename(executable);
      let stdout = "Synthetic banner 1.0\n";
      if (tool === "dpkg-query" && args[0] === "-S") stdout = `synthetic-package: ${args[1]}\n`;
      else if (tool === "dpkg-query" && args[0] === "-W") stdout = "synthetic-package\t1.0\tamd64\n";
      else if (tool === "apt-cache") stdout = "Synthetic public metadata\n";
      else if (tool === "systemctl") {
        if (args.includes("MainPID")) stdout = args[1] === "docker" ? "101\n" : "102\n";
        else if (args.includes("FragmentPath")) stdout = `/synthetic/${args[1]}.service\n`;
        else if (args.includes("DropInPaths")) stdout = "";
        else stdout = "Synthetic service identity\n";
      } else if (tool === "docker" && args[0] === "version" && args.includes("--format"))
        stdout = '{"Version":"1.0","Os":"linux","Arch":"amd64"}';
      else if (tool === "docker" && args.includes("{{json .Runtimes}}"))
        stdout = '{"synthetic":{"path":"/synthetic/runtime"}}';
      else if (tool === "docker" && args.includes("{{.DefaultRuntime}}")) stdout = "synthetic";
      else if (tool === "sudo" && args[0] === "-n")
        stdout = args[1].endsWith("readlink")
          ? `/synthetic/daemon-${args.at(-1).split("/")[2]}\n`
          : `${"a".repeat(64)}  ${args.at(-1)}\n`;
      return { status: 0, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
    },
  };
  bindings.record = expression(declarations("record")[0].initializer, bindings);
  bindings.utf8 = expression(declarations("utf8")[0].initializer, bindings);
  bindings.cleanEnvironment = expression(declarations("cleanEnvironment")[0].initializer, bindings);
  bindings.resolveTool = expression(declarations("resolveTool")[0].initializer, bindings);
  bindings.writeJson = expression(declarations("writeJson")[0].initializer, bindings);
  bindings.canonical = new Function(
    "record",
    `const canonical = ${declarations("canonical")[0].initializer.getText(identityTree)}; return canonical;`,
  )(bindings.record);
  const observer = identityTree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name.text === "observeIdentity",
  );
  const construct = new Function(...Object.keys(bindings), `return () => ${observer.body.getText(identityTree)}`)(
    ...Object.values(bindings),
  );
  const actual = construct();
  assert.equal(Object.keys(actual.tools).length, 25);
  assert.equal(Object.keys(actual.versions).length, 25);
  assert(actual.daemon.activeRuntime && actual.daemon.executable && actual.daemon.containerdExecutable);
  assert.equal(actual.daemon.unitFiles.length, 1);
  assert.equal(actual.daemon.containerdUnitFiles.length, 1);
  return { actual, written, roles: bindings.identityPublicationRoles.get(actual), bindings };
}
const productionShape = syntheticIdentity();
const identityFile = "/synthetic/private/observed-identity.json";
const identityText = productionShape.written.get(identityFile).toString("utf8");
const keyedText = `${JSON.stringify(productionShape.actual, null, 2)}\n`;
const keyedHits = scanExposure([{ file: "synthetic-identity", text: keyedText }]);
assert.deepEqual(keyedHits, [
  { file: "synthetic-identity", line: keyedText.split("\n").findIndex((line) => line.includes('"dpkg-query": "')) + 1 },
]);
console.log("P5(a) H1''' keyed form: exactly one dpkg-query LABELED_FIELD hit; all other synthetic inputs frozen");
assert.deepEqual(
  scanExposure([{ file: "synthetic-identity", text: identityText }]),
  [],
  "P5 production identity must scan clean",
);
const memoryBefore = JSON.stringify(productionShape.actual);
const fingerprintBefore = JSON.stringify(identityFingerprint(productionShape.actual));
const serialized = JSON.parse(serializeIdentity(productionShape.actual));
const restored = {
  ...serialized,
  versions: Object.fromEntries(serialized.versions.map(({ tool, banner }) => [tool, banner])),
};
assert.equal(JSON.stringify(identityFingerprint(restored)), fingerprintBefore);
const wrapped = JSON.parse(serializeIdentity(productionShape.actual, { synthetic: true }));
assert.deepEqual(wrapped.authority, { synthetic: true });
assert.deepEqual(wrapped.actualIdentity, serialized);
assert.equal(JSON.stringify(productionShape.actual), memoryBefore);
assert.equal(JSON.stringify(identityFingerprint(productionShape.actual)), fingerprintBefore);
assert.equal(
  serializeIdentity(productionShape.actual),
  `${JSON.stringify(
    {
      ...productionShape.actual,
      versions: Object.entries(productionShape.actual.versions).map(([tool, banner]) => ({ tool, banner })),
    },
    null,
    2,
  )}\n`,
  "projection refactor preserves serializer bytes",
);
for (const [role, text] of [
  [
    "IDENTITY",
    serializeIdentity({
      ...productionShape.actual,
      versions: { ...productionShape.actual.versions, curl: `token: ${secret}` },
    }),
  ],
  ["VERSION_CURL_STDOUT", `token: ${secret}`],
]) {
  const files = [{ file: "synthetic-opaque-file", text }];
  const hits = scanExposure(files);
  const classes = inventoryPublicationHitClasses(hits, classifyExposure(files), new Map([[files[0].file, role]]));
  assert.equal(classes, `INVENTORY_PUBLICATION_HIT_CLASSES total=1 classes=${role}:LABELED_FIELD`);
  assert(!classes.includes(secret));
  assert.throws(
    () =>
      assert.equal(
        inventoryPublicationHitClasses(hits, classifyExposure(files), new Map([[files[0].file, "LEDGER"]])),
        classes,
      ),
    undefined,
    "mis-mapping only the role must go red",
  );
}
console.log("PASS P5 identity production shape; fingerprint equality and frozen banner/stdout role-marker controls");

const evaluateFunction = (name, bindings) => {
  const node = identityTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === name);
  return expression(node, bindings, node.getText(identityTree).replace(/^export /, ""));
};
const syntheticEnvelopeBytes = Buffer.from(JSON.stringify(fixtureAuthority().envelope));
const syntheticAuthority = decodeAuthority(syntheticEnvelopeBytes, sha256(syntheticEnvelopeBytes), {
  head,
  phase: "inventory",
  protocol,
});
const captureDirectory = "/synthetic/capture";
const memoryIO = {
  ...productionShape.bindings,
  readFileSync: (file) => {
    assert(productionShape.written.has(file), "synthetic read must be registered");
    return productionShape.written.get(file);
  },
  readdirSync: (directory) =>
    [...productionShape.written.keys()]
      .filter((file) => path.posix.dirname(file) === directory)
      .map((file) => path.posix.basename(file)),
};
evaluateFunction("preserveMetadata", memoryIO)("/synthetic/private", captureDirectory);
for (const prefix of ["identity-", "prepayload-identity-", "seal-identity-"]) {
  evaluateFunction("preserveMetadata", memoryIO)("/synthetic/private", "/synthetic/copy", prefix);
  assert.deepEqual(
    productionShape.written.get(`/synthetic/copy/${prefix}observed-identity.json`),
    productionShape.written.get(identityFile),
  );
}
evaluateFunction("preserveAuthority", memoryIO)(captureDirectory, syntheticAuthority, syntheticEnvelopeBytes);
const collectNode = identityTree.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name.text === "collect",
);
const collectInitializer = (name) =>
  descendants(collectNode, (node) => ts.isVariableDeclaration(node) && node.name.getText(identityTree) === name)[0]
    .initializer;
const artifactBindings = {
  ...memoryIO,
  startedAt: "2000-01-01T00:00:00.000Z",
  run: "1",
  attempt: "1",
  protocol,
  event: normalized,
  authority: syntheticAuthority,
  identity: productionShape.actual,
  capture: captureDirectory,
};
const productionReceipt = expression(collectInitializer("receipt"), artifactBindings);
memoryIO.writeJson(`${captureDirectory}/preparation-receipt.json`, productionReceipt);
const publicationFiles = expression(collectInitializer("files"), artifactBindings);
const publicationHits = scanExposure(publicationFiles);
assert.deepEqual(publicationHits, [], "complete neutral production capture must scan clean");
const manifestObject = descendants(
  collectNode,
  (node) =>
    ts.isObjectLiteralExpression(node) &&
    node.properties.some((property) => property.initializer?.getText(identityTree) === '"10678-inventory-manifest/v1"'),
);
assert.equal(manifestObject.length, 1);
const productionManifest = expression(manifestObject[0], { ...artifactBindings, files: publicationFiles });
memoryIO.writeJson(`${captureDirectory}/inventory-manifest.json`, productionManifest);
const productionGate = expression(collectInitializer("gate"), { ...artifactBindings, hits: publicationHits });
validateInventoryPublication(productionReceipt, productionGate);
assert.deepEqual(
  scanExposure([
    ...publicationFiles,
    { file: "synthetic-manifest", text: JSON.stringify(productionManifest, null, 2) },
    { file: "synthetic-gate", text: JSON.stringify(productionGate, null, 2) },
  ]),
  [],
);
assert.equal(
  productionShape.roles.size,
  publicationFiles.length + 2,
  "every scanned file has an in-memory role; manifest/gate are written after scan",
);
for (const file of publicationFiles) assert(productionShape.roles.has(file.file));
const ledger = JSON.parse(productionShape.written.get("/synthetic/private/metadata-command-ledger.json"));
assert.equal(publicationFiles.length, ledger.length * 2 + 10);
for (const entry of ledger) {
  assert(productionShape.roles.get(entry.output).endsWith("_STDOUT"));
  assert(productionShape.roles.get(entry.error).endsWith("_STDERR"));
}
const publicationTry = descendants(
  collectNode,
  (node) =>
    ts.isTryStatement(node) &&
    node.tryBlock.statements[0]?.getText(identityTree) === "validateInventoryPublication(receipt, gate);",
);
assert.equal(publicationTry.length, 1);
const printedFor = (files, receipt = productionReceipt) => {
  const hits = scanExposure(files);
  const gate = { ...productionGate, hits, publish: hits.length === 0, scan: hits.length ? "HITS" : "NO_HITS" };
  const printed = [];
  const bindings = {
    receipt,
    gate,
    hits,
    files,
    identity: productionShape.actual,
    identityPublicationRoles: new WeakMap([[productionShape.actual, productionShape.roles]]),
    inventoryAt,
    inventoryOperations,
    inventoryCategory,
    inventoryPublicationHitClasses,
    classifyExposure,
    validateInventoryPublication,
    console: { log: (line) => printed.push(line) },
  };
  try {
    new Function(...Object.keys(bindings), publicationTry[0].getText(identityTree))(...Object.values(bindings));
  } catch (error) {
    printed.push(inventoryRefusal(error));
  }
  return printed;
};
assert.deepEqual(printedFor(publicationFiles), []);
for (const [file, role, text] of [
  [
    "observed-identity.json",
    "IDENTITY",
    serializeIdentity({
      ...productionShape.actual,
      versions: { ...productionShape.actual.versions, curl: `token: ${secret}` },
    }),
  ],
  [
    ledger.find((entry) => productionShape.roles.get(entry.output) === "VERSION_CURL_STDOUT").output,
    "VERSION_CURL_STDOUT",
    `token: ${secret}`,
  ],
]) {
  const changedFiles = publicationFiles.map((entry) => (entry.file === file ? { ...entry, text } : entry));
  const printed = printedFor(changedFiles);
  assert.deepEqual(printed, [
    `INVENTORY_PUBLICATION_HIT_CLASSES total=1 classes=${role}:LABELED_FIELD`,
    terminal("PRIVATE_INVENTORY_PUBLICATION_REFUSED"),
  ]);
  assert(!printed.join("\n").includes(secret));
}
assert.deepEqual(printedFor(publicationFiles, { ...productionReceipt, complete: false }), [
  terminal("ZERO_ROW_INVENTORY_REQUIRED"),
]);
console.log(
  `PASS P5 complete production receipt/ledger/process/identity/authority/manifest/gate shapes; ${ledger.length} synthetic query records, ${publicationFiles.length} files; exact refusal-only output and preserveMetadata copies`,
);

// Extract only the writer expression and helper, never import or execute the runner.
const runnerSource = readFileSync(new URL("./runner.mjs", import.meta.url), "utf8");
const runnerTree = ts.createSourceFile("runner.mjs", runnerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(runnerTree.parseDiagnostics.length, 0);
const exactSink = descendants(
  runnerTree,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(runnerTree) === "json" &&
    node.arguments[0]?.getText(runnerTree).includes('"exact-run-inputs.json"'),
);
assert.equal(exactSink.length, 1);
const runnerJson = descendants(
  runnerTree,
  (node) => ts.isVariableDeclaration(node) && node.name.getText(runnerTree) === "json",
);
assert.equal(runnerJson.length, 1);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const frozenIdentity = freeze(productionShape.actual);
const frozenSinkBindings = freeze({
  path: { join: path.posix.join, dirname: path.posix.dirname, basename: path.posix.basename },
  capture: "/synthetic/capture",
  config: { head, tools: {}, bootstrapTools: {}, daemonTools: {}, expectedIdentity: {} },
  event: normalized,
  run: "1",
  attempt: "1",
  jobIdentity: { key: "synthetic" },
  protocol: { job: "synthetic" },
  sha256,
  readFileSync: () => Buffer.from("{}"),
  configPath: "/synthetic/config",
  authority: { identity: { synthetic: true } },
  process: { version: "SYNTHETIC_NODE" },
  childEnv: { LANG: "C.UTF-8" },
});
function evaluateIdentitySink(text, actualIdentity = frozenIdentity) {
  const writes = [];
  const json = new Function(
    "writeFileSync",
    "path",
    "capture",
    "publicationFiles",
    `return (${runnerJson[0].initializer.getText(runnerTree)});`,
  )(
    (file, text, options) => writes.push({ file, text, options }),
    frozenSinkBindings.path,
    frozenSinkBindings.capture,
    new Map(),
  );
  const bindings = { ...frozenSinkBindings, json, actualIdentity, projectIdentity };
  new Function(...Object.keys(bindings), text)(...Object.values(bindings));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].options, { mode: 0o600 });
  assert(writes[0].text.endsWith("\n"));
  return writes[0];
}
const greenSinkText = exactSink[0].getText(runnerTree);
const rawSinkText = greenSinkText.replace(/actualIdentity: projectIdentity\(actualIdentity\)/, "actualIdentity");
assert.equal(sha256(rawSinkText), "518271325430499d899f2748ea49333748c406f24dcb5de0372f06e855586a6c");
const sinkMemoryBefore = JSON.stringify(frozenIdentity);
const sinkFingerprintBefore = JSON.stringify(identityFingerprint(frozenIdentity));
const rawSink = evaluateIdentitySink(rawSinkText);
const rawSinkHits = scanExposure([rawSink]);
assert.equal(rawSinkHits.length, 1);
assert(rawSink.text.split("\n")[rawSinkHits[0].line - 1].includes('"dpkg-query": "'));
console.log(
  `CONTROL 1 RED: H1''' shorthand sink has exactly one dpkg-query LABELED_FIELD hit; reverted sink SHA-256=${sha256(rawSinkText)}`,
);
const greenSink = evaluateIdentitySink(greenSinkText);
assert.deepEqual(scanExposure([greenSink]), [], "CONTROL 1 GREEN: projected actualIdentity must scan clean");
const rawValue = JSON.parse(rawSink.text);
const greenValue = JSON.parse(greenSink.text);
const { actualIdentity: rawIdentity, ...rawOther } = rawValue;
const { actualIdentity: greenIdentity, ...greenOther } = greenValue;
assert.deepEqual(greenOther, rawOther);
assert.deepEqual(Object.keys(greenValue), Object.keys(rawValue));
const { versions: rawVersions, ...rawMembers } = rawIdentity;
const { versions: greenVersions, ...greenMembers } = greenIdentity;
assert.deepEqual(greenMembers, rawMembers);
assert.deepEqual(Object.keys(greenIdentity), Object.keys(rawIdentity));
assert.deepEqual(
  greenVersions.map(({ tool, banner }) => [tool, banner]),
  Object.entries(rawVersions),
);
assert.equal(JSON.stringify(frozenIdentity), sinkMemoryBefore);
assert.equal(JSON.stringify(identityFingerprint(frozenIdentity)), sinkFingerprintBefore);
assert.equal(
  JSON.stringify(
    identityFingerprint({
      ...greenIdentity,
      versions: Object.fromEntries(greenVersions.map(({ tool, banner }) => [tool, banner])),
    }),
  ),
  sinkFingerprintBefore,
);
console.log(
  "CONTROL 1 GREEN: zero identity-field hits; other bytes/order, memory and fingerprints unchanged (not whole-artifact measurement proof)",
);
const markedIdentity = freeze({
  ...frozenIdentity,
  versions: { ...frozenIdentity.versions, curl: `token: ${secret}` },
});
const markedSink = evaluateIdentitySink(greenSinkText, markedIdentity);
const markedHits = scanExposure([markedSink]);
assert.equal(markedHits.length, 1);
assert(markedSink.text.split("\n")[markedHits[0].line - 1].includes(secret));
assert.deepEqual(classifyExposure([markedSink]), [{ ...markedHits[0], rules: ["LABELED_FIELD"] }]);
const markerOutput = "CONTROL 2 PASS: one planted banner hit, LABELED_FIELD; no marker printed";
assert(!markerOutput.includes(secret));
console.log(markerOutput);

// Evaluate the real artifact writers with full reviewed constants and synthetic I/O.
// No runner entry point, tool, observer or filesystem writer is executed.
const runnerFunction = (name) =>
  runnerTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === name);
const runnerDeclaration = (name) =>
  descendants(runnerTree, (node) => ts.isVariableDeclaration(node) && node.name.getText(runnerTree) === name);
const execute = (text, bindings) => new Function(...Object.keys(bindings), text)(...Object.values(bindings));
const measurementFixture = fixtureAuthority(fixtureMeasurementPayload());
const measurementBytes = Buffer.from(JSON.stringify(measurementFixture.envelope));
const measurementAuthority = decodeAuthority(measurementBytes, sha256(measurementBytes), {
  head,
  phase: "measurement",
  protocol,
});
const completeConfig = freeze(measurementConfig(fixtureMeasurementPayload()));
const completedRows = matrix(protocol).map((row) => ({
  ...row,
  startedAt: "2000-01-01T00:00:00.000Z",
  completedAt: "2000-01-01T00:00:13.000Z",
  app: { status: 202, durationMs: row.durationMs, appTrace: "synthetic-app" },
  client: { status: 202, complete: true, contentType: "application/json", bytes: 4, bodySha256: sha256("null") },
  socket: { finished: true, bodyBytes: 4, bodySha256: sha256("null") },
  access: { nginxId: "synthetic-nginx", endpoint: "172.29.0.2:8080", status: 202, statuses: ["202"], lengths: ["4"] },
  captureComplete: true,
}));
const commandNode = descendants(
  runnerFunction("command"),
  (node) => ts.isVariableDeclaration(node) && node.name.getText(runnerTree) === "entry",
)[0];
const measurementCommands = Object.keys(completeConfig.tools).map((tool, i) => ({
  ...expression(
    commandNode.initializer,
    {
      tool,
      args: ["--version"],
      cwd: "/synthetic/repo",
      path: path.posix,
      output: `/synthetic/capture/${i}.stdout`,
      error: `/synthetic/capture/${i}.stderr`,
      Date: productionShape.bindings.Date,
    },
    commandNode.initializer.getText(runnerTree),
  ),
  exit: 0,
  signal: null,
  completedAt: "2000-01-01T00:00:01.000Z",
}));
const completeState = freeze({
  id: "nosend-1-1",
  run: "1",
  attempt: "1",
  authority: measurementAuthority.identity,
  commands: measurementCommands,
  rows: completedRows,
  phases: { protocolStart: "2000-01-01T00:00:00.000Z", protocolComplete: true },
  resources: [{ kind: "network", name: "nosend-1-1", networkId: "synthetic-network" }],
  boundaryInstalled: true,
  activeStack: "current",
  apiService: "synthetic-api",
  bridge: "br-synthetic",
  chartImages: completeConfig.images.prefetch,
  expectedConfigMap: { "ssl-redirect": "true", "custom-http-errors": "502,503,504" },
  nodeAddress: "172.29.0.2",
  nodeImageIds: [completeConfig.images.kind],
  servicePorts: { api: 8080 },
  stacks: Object.fromEntries(
    protocol.stacks.map((stack) => [
      stack.id,
      {
        sourceRef: stack.ref,
        declaredNodeImage: completeConfig.images[stack.id],
        adapter: stack.adapter,
        historicalNodePatch: stack.historicalNodePatch ?? "NOT_APPLICABLE",
        bundle: `/synthetic/${stack.id}.cjs`,
        bundleSha256: sha256("synthetic-bundle"),
        lockfileSha256: completeConfig.files["pnpm-lock.yaml"],
        closure: [{ file: "synthetic-entry.mjs", sha256: sha256("synthetic-entry") }],
        address: "172.29.0.3",
      },
    ]),
  ),
  failure: { phase: "synthetic", utc: "2000-01-01T00:00:00.000Z", reason: "SYNTHETIC_REASON" },
});
const measurementBindings = {
  ...frozenSinkBindings,
  authority: measurementAuthority,
  config: completeConfig,
  protocol,
  stateFile: "/synthetic/private/state.json",
  state: completeState,
  actualIdentity: frozenIdentity,
  assembleReceipt,
  projectIdentity,
  serializeIdentity,
  existsSync: () => true,
  captureComplete: true,
  files: publicationFiles,
  publicationFiles: new Map(),
};
const sealStatements = runnerFunction("seal").body.statements;
const receiptStart = sealStatements.findIndex(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => declaration.name.getText(runnerTree) === "receipt"),
);
const receiptEnd = sealStatements.findIndex((node) =>
  node.getText(runnerTree).startsWith('json(path.join(capture, "receipt.json")'),
);
assert(receiptStart >= 0 && receiptEnd > receiptStart);
const receiptWriter = sealStatements
  .slice(receiptStart, receiptEnd + 1)
  .map((node) => node.getText(runnerTree))
  .join("\n");
const rawManifestSink = descendants(
  runnerTree,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(runnerTree) === "json" &&
    node.arguments[0]?.getText(runnerTree).includes('"raw-manifest.json"'),
);
assert.equal(rawManifestSink.length, 1);
const ledgerSinks = descendants(
  runnerTree,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(runnerTree) === "json" &&
    node.arguments[0]?.getText(runnerTree).includes('"command-ledger.json"'),
);
assert.equal(ledgerSinks.length, 2);
assert.equal(ledgerSinks[0].getText(runnerTree), ledgerSinks[1].getText(runnerTree));
const saveDeclaration = runnerDeclaration("save");
assert.equal(saveDeclaration.length, 1);
const stateWriter = `(${saveDeclaration[0].initializer.getText(runnerTree)})();`;
const artifactCases = [
  [
    "receipt.json",
    receiptWriter,
    (b) => ({ ...b, state: { ...b.state, failure: { ...b.state.failure, reason: `token: ${secret}` } } }),
  ],
  [
    "raw-manifest.json",
    rawManifestSink[0].getText(runnerTree),
    (b) => ({ ...b, files: [...b.files, { file: `token: ${secret}`, bytes: 0, sha256: sha256("") }] }),
  ],
  ["exact-run-inputs.json", greenSinkText, (b) => ({ ...b, actualIdentity: markedIdentity })],
  [
    "prepayload-identity.json",
    descendants(
      runnerTree,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(runnerTree) === "writeFileSync" &&
        node.arguments[0]?.getText(runnerTree).includes('"prepayload-identity.json"'),
    )[0].getText(runnerTree),
    (b) => ({ ...b, actualIdentity: markedIdentity }),
  ],
  [
    "command-ledger.json",
    ledgerSinks[0].getText(runnerTree),
    (b) => ({
      ...b,
      state: {
        ...b.state,
        commands: b.state.commands.map((entry, i) => (i ? entry : { ...entry, args: [`token: ${secret}`] })),
      },
    }),
  ],
  [
    "state.json",
    stateWriter,
    (b) => ({ ...b, state: { ...b.state, failure: { ...b.state.failure, reason: `token: ${secret}` } } }),
  ],
];
const renderArtifact = (writer, bindings) => {
  const writes = [];
  const mutable = {
    ...bindings,
    state: structuredClone(bindings.state),
    publicationFiles: new Map(bindings.publicationFiles),
  };
  mutable.writeFileSync = (file, text) => writes.push({ file: path.posix.basename(file), text });
  mutable.json = expression(runnerJson[0].initializer, mutable, runnerJson[0].initializer.getText(runnerTree));
  execute(writer, mutable);
  assert.equal(writes.length, 1);
  return writes[0];
};
const neutralArtifacts = [];
for (const [name, writer, plant] of artifactCases) {
  const neutral = renderArtifact(writer, measurementBindings);
  assert.equal(neutral.file, name);
  assert.deepEqual(scanExposure([neutral]), [], `${name}: complete production shape must be clean`);
  const marked = renderArtifact(writer, plant(measurementBindings));
  assert.deepEqual(
    classifyExposure([marked]).map(({ rules }) => rules),
    [["LABELED_FIELD"]],
    `${name}: planted marker must be detected`,
  );
  assert.throws(
    () => assert.deepEqual(scanExposure([marked]), []),
    undefined,
    `${name}: bypassed scanner assertion is RED`,
  );
  neutralArtifacts.push(neutral);
  console.log(`H2-C1 RED/GREEN ${name}: full writer shape clean; frozen planted marker detected`);
}
assert(JSON.parse(neutralArtifacts.find((file) => file.file === "receipt.json").text).complete);
assert.deepEqual(
  JSON.parse(neutralArtifacts.find((file) => file.file === "exact-run-inputs.json").text).frozen,
  completeConfig,
);

const soloRules = [
  ["neutral", 9, ["DEPTH"]],
  ["\ufffd", 0, ["REPLACEMENT_CHAR"]],
  ["Bearer syntheticMarker123", 0, ["TOKEN_OR_PRIVATE_KEY"]],
  ["token: syntheticMarker123", 0, ["LABELED_FIELD"]],
  ['["cookie", "syntheticMarker123"]', 0, ["COOKIE_ARRAY"]],
  ["https://example.invalid/path?neutral=value", 0, ["URL_QUERY"]],
  ["?state=syntheticMarker123", 0, ["QUERY_PARAMETER"]],
  [JSON.stringify({ bodyBase64: Buffer.from("token: syntheticMarker123").toString("base64") }), 0, ["ENCODED_BODY"]],
];
const verifyRuleMapping = (classify) => {
  for (const [text, depth, rules] of soloRules)
    assert.deepEqual(classify([{ file: "synthetic-solo", text }], depth), [{ file: "synthetic-solo", line: 1, rules }]);
};
verifyRuleMapping(classifyExposure);
assert.throws(() =>
  verifyRuleMapping((files, depth) =>
    classifyExposure(files, depth).map((hit) => ({
      ...hit,
      rules: hit.rules.map((rule) =>
        rule === "REPLACEMENT_CHAR"
          ? "TOKEN_OR_PRIVATE_KEY"
          : rule === "TOKEN_OR_PRIVATE_KEY"
            ? "REPLACEMENT_CHAR"
            : rule,
      ),
    })),
  ),
);
const rehearsalNode = descendants(
  runnerFunction("measure"),
  (node) => ts.isIfStatement(node) && node.expression.getText(runnerTree) === "state.rows.length === 0",
);
assert.equal(rehearsalNode.length, 1);
const rowBlock = rehearsalNode[0].parent;
const rehearsalIndex = rowBlock.statements.indexOf(rehearsalNode[0]);
assert.equal(rowBlock.statements[rehearsalIndex + 1].getText(runnerTree), "state.rows.push(row);");
assert.equal(rowBlock.statements[rehearsalIndex + 2].getText(runnerTree), "save();");
assert(rowBlock.statements[rehearsalIndex + 3].getText(runnerTree).includes('await client("row", rung.id'));
const captureNode = runnerFunction("captureFiles");
const captureMemory = [
  ...neutralArtifacts,
  { file: "publication-gate.json", text: "neutral" },
  { file: "raw-manifest.json", text: "neutral" },
];
const collectCapture = expression(
  captureNode,
  {
    capture: captureDirectory,
    path: path.posix,
    invariant,
    sha256,
    readdirSync: () => captureMemory.map((file) => file.file),
    statSync: () => ({ isFile: () => true }),
    readFileSync: (file) => Buffer.from(captureMemory.find((entry) => entry.file === path.posix.basename(file)).text),
  },
  captureNode.getText(runnerTree),
);
assert.equal(collectCapture(true).length, captureMemory.length, "rehearsal has no file exemption");
const rehearse = (files, roles, enforce = measurementPublicationRehearsal) => {
  const state = { rows: [], commands: measurementCommands };
  const printed = [];
  try {
    execute(`${rehearsalNode[0].getText(runnerTree)}\nstate.rows.push({synthetic:true});`, {
      state,
      json: () => {},
      path: path.posix,
      capture: captureDirectory,
      captureFiles: (includeGate) => {
        assert.equal(includeGate, true);
        return files;
      },
      publicationFiles: roles,
      measurementPublicationRehearsal: enforce,
      console: { log: (line) => printed.push(line) },
    });
  } catch (error) {
    printed.push(
      JSON.stringify({ result: state.rows.length ? "PARTIAL_UNKNOWN" : "NOT_EXECUTED", reason: error.message }),
    );
  }
  return { rows: state.rows.length, printed };
};
assert.equal(
  rehearse(neutralArtifacts, new Map(neutralArtifacts.map((file) => [file.file, "MEASUREMENT_JSON"]))).rows,
  1,
);
for (const role of measurementPublicationRoles) {
  const files = [{ file: "synthetic-fixed-file", text: `token: ${secret}` }];
  const roles = new Map([[files[0].file, role]]);
  assert.equal(rehearse(files, roles, () => {}).rows, 1, "H2-C2 bypass RED wrongly starts a row");
  const result = rehearse(files, roles);
  assert.equal(result.rows, 0);
  assert.deepEqual(result.printed, [
    `MEASUREMENT_PUBLICATION_HIT_CLASSES total=1 classes=${role}:LABELED_FIELD`,
    JSON.stringify({ result: "NOT_EXECUTED", reason: "PRIVATE_MEASUREMENT_PUBLICATION_REFUSED" }),
  ]);
  assert(!result.printed.join("\n").includes(secret));
}
assert.equal(rehearse([{ file: "unregistered", text: `token: ${secret}` }], new Map()).rows, 0);
console.log(
  "H2-C2 RED/GREEN: all files, fixed role/rule mapping, zero rows on refusal; unchanged final seal scan retained",
);

const syntaxShape = (node) => {
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(syntaxShape(child));
  });
  return [node.kind, node.text ?? null, children];
};
// A closed writer census plus value origins: unknown writes cannot silently escape the trace.
function identityWriteClosure(inventoryText, runnerText, pinSource = true) {
  inventoryText = eraseProbeAnnotations(inventoryText, true);
  const rows = [];
  const productionTrees = [];
  for (const [file, text] of [
    ["inventory.mjs", inventoryText],
    ["runner.mjs", runnerText],
  ]) {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(tree.parseDiagnostics.length, 0);
    if (file === "inventory.mjs" && pinSource) {
      const frozen = ts.createSourceFile(file, immutableH2Source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      assert.deepEqual(tree.statements.map(syntaxShape), frozen.statements.map(syntaxShape), "annotation-only whole-module AST equals immutable H2");
      // SourceFile.text includes whitespace/comments. Retain the old exact-byte pin only
      // after proving every normalized candidate production node equals immutable H2.
      productionTrees.push(syntaxShape(frozen));
    } else productionTrees.push(syntaxShape(tree));
    const all = descendants(tree, () => true);
    const declarations = all.filter((node) => ts.isVariableDeclaration(node) || ts.isParameter(node));
    const scopes = new Map();
    const scope = (node) => {
      if (scopes.has(node)) return scopes.get(node);
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isBlock(parent) || ts.isSourceFile(parent) || (ts.isParameter(node) && ts.isFunctionLike(parent))) {
          scopes.set(node, parent);
          return parent;
        }
    };
    const resolutions = new Map();
    const resolve = (node) => {
      if (resolutions.has(node)) return resolutions.get(node);
      for (let parent = node.parent; parent; parent = parent.parent) {
        const match = declarations.find(
          (declaration) => declaration.name.getText(tree) === node.text && scope(declaration) === parent,
        );
        if (match) {
          resolutions.set(node, match);
          return match;
        }
      }
      resolutions.set(node, undefined);
    };
    const functionOwner = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isFunctionDeclaration(parent)) return parent.name.text;
    };
    const traced = new Map();
    const mutationInputs = new Map();
    const trace = (node, seen = new Set()) => {
      if (!node) return [];
      if (traced.has(node)) return traced.get(node);
      traced.set(node, []);
      const origins = [...new Map(traceValue(node, seen).map((origin) => [JSON.stringify(origin), origin])).values()];
      traced.set(node, origins);
      return origins;
    };
    const traceValue = (node, seen) => {
      if (!node || seen.has(node)) return [];
      seen = new Set([...seen, node]);
      if (ts.isPropertyAssignment(node)) return trace(node.initializer, seen);
      if (ts.isIdentifier(node)) {
        const declaration = resolve(node);
        if (!declaration) return [];
        if (
          functionOwner(declaration) === "observeIdentity" &&
          all.some(
            (entry) =>
              ts.isReturnStatement(entry) &&
              entry.expression?.getText(tree) === node.text &&
              ts.isFunctionDeclaration(entry.parent.parent) &&
              entry.parent.parent.name.text === "observeIdentity",
          )
        )
          return [{ mode: "raw", path: [] }];
        if (!mutationInputs.has(declaration)) {
          const mutations = all.filter(
            (entry) =>
              ts.isBinaryExpression(entry) &&
              entry.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(entry.left) &&
              descendants(entry.left, (child) => ts.isIdentifier(child) && resolve(child) === declaration).length,
          );
          const methodMutations = all.filter((entry) => {
            if (!ts.isCallExpression(entry) || !ts.isPropertyAccessExpression(entry.expression)) return false;
            const receiver =
              entry.expression.getText(tree) === "Object.assign" ? entry.arguments[0] : entry.expression.expression;
            return (
              ["push", "unshift", "splice", "set", "assign"].includes(entry.expression.name.text) &&
              descendants(receiver, (child) => ts.isIdentifier(child) && resolve(child) === declaration).length > 0
            );
          });
          mutationInputs.set(declaration, [
            declaration.initializer,
            ...mutations.map((entry) => entry.right),
            ...methodMutations.flatMap((entry) =>
              entry.arguments.slice(entry.expression.getText(tree) === "Object.assign" ? 1 : 0),
            ),
          ]);
        }
        return mutationInputs.get(declaration).flatMap((input) => trace(input, seen));
      }
      if (ts.isPropertyAccessExpression(node))
        return trace(node.expression, seen).map((origin) => ({ ...origin, path: [...origin.path, node.name.text] }));
      if (ts.isElementAccessExpression(node))
        return trace(node.expression, seen).map((origin) => ({
          ...origin,
          path: [...origin.path, node.argumentExpression.getText(tree)],
        }));
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(tree);
        if (name === "observeIdentity") return [{ mode: "raw", path: [] }];
        const origins = node.arguments.flatMap((argument) => trace(argument, seen));
        if (["projectIdentity", "serializeIdentity"].includes(name))
          return origins.map((origin) => ({ ...origin, mode: "projected" }));
        if (["sha256", "identityFingerprint"].includes(name))
          return origins.map((origin) => ({ ...origin, mode: "digest" }));
        return origins;
      }
      const children = [];
      ts.forEachChild(node, (child) => {
        children.push(...trace(child, seen));
      });
      return children;
    };
    const writerNames = new Set(["writeFileSync", "writeJson", "json", "openSync"]);
    for (const declaration of declarations)
      if (
        declaration.initializer &&
        ts.isIdentifier(declaration.initializer) &&
        writerNames.has(declaration.initializer.text)
      )
        writerNames.add(declaration.name.getText(tree));
    const fsImports = tree.statements.filter(
      (node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith("node:fs"),
    );
    assert.equal(fsImports.length, 1);
    const calls = all.filter((node) => ts.isCallExpression(node) && writerNames.has(node.expression.getText(tree)));
    for (const call of calls) {
      const origins = trace(call.arguments[1]);
      // Receipt imageVersion leaves are unchanged by projection; digest leaves are not identity objects.
      for (const origin of origins)
        assert(
          origin.mode !== "raw" || origin.path.join(".") === "imageVersion",
          `${file}:${tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1}: unprojected identity value`,
        );
      rows.push({
        file,
        line: tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1,
        writer: call.expression.getText(tree),
        origins,
        syntax: syntaxShape(call),
      });
    }
    rows.push({ file, imports: syntaxShape(fsImports[0]) });
  }
  const inventoryTree = ts.createSourceFile(
    "inventory.mjs",
    inventoryText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const mappings = descendants(
    inventoryTree,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map" &&
      node.expression.expression.getText(inventoryTree).replace(/\s/g, "") === "Object.entries(identity.versions)",
  );
  assert.equal(mappings.length, 1, "only one versions projection");
  const projected = rows.filter((row) => row.origins?.some((origin) => origin.mode === "projected"));
  assert.equal(projected.length, 3, "exactly three identity sinks");
  assert.equal(rows.filter((row) => row.origins).length, 36, "complete file-write/open census");
  if (pinSource)
    assert.equal(
      sha256(JSON.stringify(rows.map(({ line: _line, ...row }) => row))),
      "b7d7a1c6f4ee5a8f6168c130b897a60dde99dbc53f795b4e7be1a83eeb7d1be9",
      "closed write arguments/imports and their value-origin traces",
    );
  // This is a closed graph of the inspected production source, not an extensible JavaScript analyzer.
  if (pinSource)
    assert.equal(
      sha256(JSON.stringify(productionTrees)),
      "1e560752bc7310f2146e926b420f5d08ddfee1173bc47544eef6cb0a715c1bdd",
      "no untraced alias, writer API, mutation or versions transformation outside the closed graph",
    );
  return rows;
}
const writerClosure = identityWriteClosure(source, runnerSource);
console.log(`P1 writer census SHA-256=${sha256(JSON.stringify(writerClosure.map(({ line: _line, ...row }) => row)))}`);
const prepayloadSink = descendants(
  runnerTree,
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(runnerTree) === "writeFileSync" &&
    node.arguments[0]?.getText(runnerTree).includes('"prepayload-identity.json"'),
);
assert.equal(prepayloadSink.length, 1);
for (const [label, inventoryText, runnerText] of [
  ["site (iii) raw", source, runnerSource.replace("actualIdentity: projectIdentity(actualIdentity)", "actualIdentity")],
  [
    "site (ii) raw",
    source,
    runnerSource.replace(
      prepayloadSink[0].getText(runnerTree),
      'json(path.join(capture, "prepayload-identity.json"), { authority: authority.identity, actualIdentity })',
    ),
  ],
  [
    "new alias/member write",
    source,
    runnerSource.replace(
      'mark("preparationStart");',
      'const escaped = actualIdentity.versions; json("synthetic-new-write", { escaped }); mark("preparationStart");',
    ),
  ],
  [
    "container method mutation",
    source,
    runnerSource.replace(
      'mark("preparationStart");',
      'state.commands.push(actualIdentity); save(); mark("preparationStart");',
    ),
  ],
  [
    "second versions map",
    source.replace(
      "const serialized = projectIdentity(identity);",
      "const duplicate = Object.entries(identity.versions).map(([tool, banner]) => ({ tool, banner })); const serialized = projectIdentity(identity);",
    ),
    runnerSource,
  ],
]) {
  assert(inventoryText !== source || runnerText !== runnerSource, `${label}: mutant reached its target`);
  assert.throws(() => identityWriteClosure(inventoryText, runnerText), undefined, `${label}: closure must go red`);
  if (label === "container method mutation")
    assert.throws(
      () => identityWriteClosure(inventoryText, runnerText, false),
      /unprojected identity value/,
      "N2: trace itself refuses, independent of source pins",
    );
  console.log(`CONTROL 3 RED confirmed: ${label}; all other source/inputs frozen`);
}
for (const row of writerClosure.filter((row) => row.origins))
  console.log(`P1 WRITE ${row.file}:${row.line} ${row.writer} origins=${JSON.stringify(row.origins)}`);
console.log("CONTROL 3 PASS: full writer census and value-origin closure; five discriminating mutants rejected");

// Erase only the audited annotation grammar, never an acceptance expression.
function eraseProbeAnnotations(text, removeSeam = false) {
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  const walk = (node) => {
    if (ts.isForOfStatement(node) && ts.isBlock(node.statement) && node.statement.statements.length === 2 && node.statement.statements[0].getText(tree) === "comparisonStock(diagnostic, name);" && node.statement.statements[1].getText(tree).startsWith("validateToolObservation(tools[name], actual.tools[name], diagnostic)")) {
      edits.push([node.statement.getStart(tree), node.statement.getStart(tree) + 1, ""]);
      edits.push([node.statement.end - 1, node.statement.end, ""]);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "comparisonAt") {
      assert.equal(node.arguments[0].getText(tree), "diagnostic");
      assert.equal(node.arguments.length, 3);
      const operation = node.arguments[2];
      assert(ts.isArrowFunction(operation) && operation.parameters.length === 0 && !ts.isBlock(operation.body));
      edits.push([node.getStart(tree), node.end, operation.body.getText(tree)]);
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ["comparisonComponent", "comparisonStock"].includes(node.expression.expression.getText(tree))) {
      assert.equal(node.expression.arguments[0].getText(tree), "diagnostic");
      edits.push([node.getStart(tree), node.end, ""]);
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.parameters.at(-1)?.name.getText(tree) === "diagnostic") {
      const parameter = node.parameters.at(-1);
      edits.push([node.parameters.length === 1 ? parameter.getStart(tree) : node.parameters.at(-2).end, parameter.end, ""]);
    }
    if (ts.isCallExpression(node) && node.arguments.at(-1)?.getText(tree) === "diagnostic") {
      const previous = node.expression.getText(tree) === "validateScriptClosure" && node.arguments.length === 4 && node.arguments[2].getText(tree) === "false" ? node.arguments[1] : node.arguments.at(-2);
      edits.push([previous.end, node.arguments.at(-1).end, ""]);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "comparisonEqual") {
      edits.push([node.expression.getStart(tree), node.expression.end, "equal"]);
      edits.push([node.arguments[0].getStart(tree), node.arguments[1].getStart(tree), ""]);
    }
    ts.forEachChild(node, walk);
  };
  // The seam implementation itself is audited separately, not normalized into H2.
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node) && probeFunctions.includes(node.name.text)) walk(node);
    else if (removeSeam && ts.isFunctionDeclaration(node) && ["createBootstrapComparison", "comparisonComponent", "comparisonStock", "comparisonAt", "comparisonEqual", "bootstrapComparisonResult", "bootstrapComparisonCategory"].includes(node.name.text)) edits.push([node.getStart(tree), node.end, ""]);
    else if (removeSeam && ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ["bootstrapComparisonComponents", "bootstrapComparisonPredicates", "bootstrapComparisonCodes", "comparisonStates", "stockComparisonComponents", "comparisonPredicateCodes"].includes(declaration.name.getText(tree)))) edits.push([node.getStart(tree), node.end, ""]);
  }
  let result = text;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + replacement + result.slice(end);
  return result;
}

function identityBehavior(text) {
  text = eraseProbeAnnotations(text);
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0);
  const shape = (node) => {
    if (ts.isBlock(node)) {
      const statements = node.statements.flatMap((statement) => {
        const text = statement.getText(tree);
        if (
          text === "const publicationFiles = new Map(inventoryPublicationFiles);" ||
          text === "publicationFiles.set(`${name}.stdout`, queryPublicationRoles.get(site).stdout);" ||
          text === "publicationFiles.set(`${name}.stderr`, queryPublicationRoles.get(site).stderr);" ||
          text === "identityPublicationRoles.set(identity, publicationFiles);" ||
          text === 'invariant(root === pin.distributionRoot, "SCRIPT_DISTRIBUTION_ESCAPE");'
        )
          return [];
        if (
          ts.isTryStatement(statement) &&
          statement.tryBlock.getText(tree).replaceAll("\r\n", "\n").trim() ===
            "{\n    validateInventoryPublication(receipt, gate);\n  }"
        )
          return statement.tryBlock.statements.map(shape);
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
      if (node.expression.text === "scriptDistribution") {
        assert.equal(node.getText(tree), "scriptDistribution(root)");
        const old = ts.createSourceFile(
          "old.mjs",
          "Object.fromEntries(distributionFiles(root).map((file) => [path.relative(root, file), sha256(readFileSync(file))]))",
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        return shape(old.statements[0].expression);
      }
      if (
        node.expression.text === "writeFileSync" &&
        node.arguments[1]?.getText(tree) === "serializeIdentity(identity)"
      ) {
        assert.equal(node.arguments[0].getText(tree), 'path.join(directory, "observed-identity.json")');
        assert.deepEqual(
          node.arguments[2].properties.map((property) => [
            property.name.getText(tree),
            property.initializer.getText(tree),
          ]),
          [
            ["flag", '"wx"'],
            ["mode", "0o600"],
          ],
        );
        const old = ts.createSourceFile(
          "old.mjs",
          'writeJson(path.join(directory, "observed-identity.json"), identity)',
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        return shape(old.statements[0].expression);
      }
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
  `PASS pure push/branch-creation matrix; ${expectedCodes.length} exact categories, ${sites.length} operation wrappers, ${queries.length} query sites and ${registrations.length * 2 + spawns.length + 2} source-registration bypass controls; 28 executable/2 service/2 daemon roles, ${invariantFields.length} invariant-literal bypasses, version/argument resolution and H1'' measurement behavior preserved; no collector or provider execution`,
);

// Compile only the named production comparison graph with in-memory filesystem/query
// stubs. Neither module entrypoint, observer, collector nor workflow is executed.
const comparisonHelpers = ["createBootstrapComparison", "comparisonComponent", "comparisonStock", "comparisonAt", "comparisonEqual", "bootstrapComparisonResult", "bootstrapComparisonCategory"];
const comparisonVariables = ["record", "canonical", "equal", "bootstrapTools", "scriptClosureDescriptor", "compareClosurePaths", "bootstrapComparisonComponents", "bootstrapComparisonPredicates", "bootstrapComparisonCodes", "comparisonStates", "stockComparisonComponents", "comparisonPredicateCodes"];
const comparisonFactories = new Map();
function comparisonGraph(text, bindings) {
  if (comparisonFactories.has(text)) return comparisonFactories.get(text)(...Object.values(bindings));
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = tree.statements.flatMap((node) => {
    if (ts.isFunctionDeclaration(node) && [...probeFunctions, ...comparisonHelpers].includes(node.name.text)) return [node.getText(tree).replace(/^export /, "")];
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.filter((d) => comparisonVariables.includes(d.name.getText(tree))).map((d) => `const ${d.getText(tree)};`);
    return [];
  });
  const exports = [...probeFunctions, ...comparisonHelpers].filter((name) => declarations.some((text) => new RegExp(`(?:function|const) ${name}\\b`).test(text)));
  const factory = new Function(...Object.keys(bindings), `${declarations.join("\n")}\nreturn {${exports.join(",")}};`);
  comparisonFactories.set(text, factory);
  return factory(...Object.values(bindings));
}
const closurePairs = JSON.parse(readFileSync(new URL("./pnpm-11.0.9.closure.json", import.meta.url)));
const nativeBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x31]);
const scriptBytes = Buffer.from("#!/usr/bin/env node\nSYNTHETIC_PRIVATE_SCRIPT\n");
const distributionPin = { version: "SYNTHETIC", architecture: "x64", publicReference: "https://synthetic.invalid/public", archiveSha256: "a".repeat(64) };
const servicePin = (name) => ({ path: `/synthetic/${name}.service`, realTarget: `/synthetic/${name}.service`, sha256: "a".repeat(64) });
function comparisonFixture() {
  const tools = Object.fromEntries(stockTools.map((name) => [name, { path: `/synthetic/${name}`, realTarget: `/synthetic/${name}`, sha256: sha256(nativeBytes), format: "native", package: { name: "SYNTHETIC_PRIVATE_PACKAGE" }, distribution: structuredClone(distributionPin) }]));
  const runner = { image: "ubuntu-24.04", imageVersion: "SYNTHETIC", imageOS: "ubuntu24", architecture: "x64", kernel: "SYNTHETIC", os: "SYNTHETIC", codename: "synthetic", engine: { version: "1", apiVersion: "1", gitCommit: "synthetic" }, containerd: { version: "1", gitCommit: "synthetic" }, runc: { version: "1", gitCommit: "synthetic" }, dockerInit: { version: "1", gitCommit: "synthetic" } };
  const services = { docker: servicePin("docker"), containerd: servicePin("containerd") };
  const actual = { imageVersion: runner.imageVersion, imageOS: runner.imageOS, architecture: runner.architecture, kernel: runner.kernel, osRelease: 'PRETTY_NAME="SYNTHETIC"\nVERSION_CODENAME=synthetic\n', tools: structuredClone(tools), versions: { node: "SYNTHETIC_PRIVATE_BANNER" }, daemon: { executable: structuredClone(tools.docker), containerdExecutable: structuredClone(tools.containerd), defaultRuntime: "runc", activeRuntime: structuredClone(tools.runc), server: { Version: "1", ApiVersion: "1", GitCommit: "synthetic", Components: ["containerd", "runc", "docker-init"].map((Name) => ({ Name, Version: "1", Details: { GitCommit: "synthetic" } })) }, unitFiles: [services.docker], containerdUnitFiles: [services.containerd] } };
  const config = { tools, bootstrapTools: { node: tools.node }, daemonTools: { docker: structuredClone(tools.docker), containerd: structuredClone(tools.containerd) }, runnerIdentity: runner, servicePins: structuredClone(services), bootstrapIdentity: identityFingerprint(actual), expectedIdentity: identityFingerprint(actual) };
  return { config, actual, targets: Object.fromEntries(stockTools.map((name) => [`/synthetic/${name}`, `/synthetic/${name}`])), bytes: Object.fromEntries(stockTools.map((name) => [`/synthetic/${name}`, nativeBytes])), closure: closurePairs };
}
function traced(value, log, prefix = "input", seen = new WeakMap()) {
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const proxy = new Proxy(value, {
    get(target, key, receiver) { log.push(`get:${prefix}.${String(key)}`); return traced(Reflect.get(target, key, receiver), log, `${prefix}.${String(key)}`, seen); },
    ownKeys(target) { log.push(`keys:${prefix}`); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { log.push(`descriptor:${prefix}.${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    set() { throw new Error("SYNTHETIC_INPUT_MUTATION_REFUSED"); },
    defineProperty() { throw new Error("SYNTHETIC_INPUT_MUTATION_REFUSED"); },
    deleteProperty() { throw new Error("SYNTHETIC_INPUT_MUTATION_REFUSED"); },
  });
  seen.set(value, proxy);
  return proxy;
}
function graphRun(text, fixture, call, optIn) {
  const log = [];
  const f = traced(fixture, log);
  const bindings = {
    Buffer, path: path.posix, stockTools, measurementTools: stockTools, inventoryOperations, sha256, invariant, supportPath: "scripts/test-support/10678-ingress-nosend", WeakMap: fixture.WeakMap ?? WeakMap,
    isHash: (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    process: { execPath: fixture.processPath ?? "/synthetic/node" },
    realpathSync: (file) => { log.push(`realpath:${file}`); if (fixture.rawOp !== "read" && fixture.rawAt === file) throw fixture.rawError; return fixture.targets[file] ?? file; },
    readFileSync: (file) => { log.push(`read:${file}`); if (fixture.rawOp !== "realpath" && fixture.rawAt === file) throw fixture.rawError; return fixture.bytes[file] ?? nativeBytes; },
    resolveTool: (site, name) => { log.push(`resolve:${name}`); if (fixture.rawOp === "resolve" && fixture.rawAt === name) throw fixture.rawError; return fixture.resolved?.[name] ?? `/synthetic/${name}`; },
    scriptDistribution: (root) => { log.push(`distribution:${root}`); if (fixture.rawOp === "distribution") throw fixture.rawError; return fixture.closure; },
  };
  const graph = comparisonGraph(text, bindings);
  const diagnostic = optIn ? fixture.handle ?? graph.createBootstrapComparison() : undefined;
  let result, error;
  try { result = call(graph, f, diagnostic); } catch (caught) { error = caught; }
  const beforeReport = [...log];
  const context = optIn ? graph.bootstrapComparisonResult(diagnostic) : "AUTHORITY_BOOTSTRAP_REFUSED";
  const category = optIn && error ? graph.bootstrapComparisonCategory(diagnostic, error) : "OTHER";
  assert.deepEqual(log, beforeReport, "report never retraverses raw operands or re-observes inputs");
  return { result, error, log, context, category };
}
let comparisonControls = 0;
function equivalent(label, mutate, call, predicate, component) {
  const runs = [false, true].map((optIn) => {
    const oldFixture = comparisonFixture(); mutate(oldFixture);
    const fixture = comparisonFixture(); mutate(fixture);
    const old = graphRun(immutableH2Source, oldFixture, call, false);
    const current = graphRun(source, fixture, call, optIn);
    assert.deepEqual(current.log, old.log, `${label}: exact ordered query/filesystem/operand access and multiplicity`);
    assert.deepEqual(current.result, old.result, `${label}: successful return semantics`);
    assert.equal(current.error?.message, old.error?.message, `${label}: original refusal code`);
    if (oldFixture.rawError && old.error === oldFixture.rawError) assert.equal(current.error, fixture.rawError, `${label}: identical raw thrown object`);
    if (predicate && optIn) {
      assert(current.error, `${label}: refusing control`);
      assert(current.context.includes(`predicate=${predicate}`), `${label}: fixed predicate ${predicate}`);
      if (component) assert(current.context.includes(`component=${component}`), `${label}: fixed component`);
      assert(!current.context.includes("SYNTHETIC_PRIVATE"), `${label}: no private marker`);
      assert.equal(current.category, old.error === oldFixture.rawError ? "OTHER" : old.error.message, `${label}: only an actually failed predicate authenticates its fixed code`);
      assert.throws(() => assert(current.context.replace(predicate, "OTHER").includes(`predicate=${predicate}`)), undefined, `${label}: misattribution mutant discriminates`);
    }
    comparisonControls++;
    return current;
  });
  return runs[1];
}
const executableCall = (g, f, d) => g.enforceExecutables(f.config.tools, stockTools, false, d);
const identityCall = (g, f, d) => g.enforceIdentityPins(f.config, f.actual, true, d);
equivalent("executable success", () => {}, executableCall);
equivalent("identity success", () => {}, identityCall);
for (const name of stockTools) {
  const component = `STOCK_${name.replaceAll("-", "_").toUpperCase()}`;
  equivalent(`${name} byte mismatch`, (f) => { f.config.tools[name].sha256 = "b".repeat(64); }, executableCall, "OBSERVED_HASH", component);
  equivalent(`${name} resolved target mismatch`, (f) => { f.targets[`/synthetic/${name}`] = "/synthetic/SYNTHETIC_PRIVATE_TARGET"; }, executableCall, "OBSERVED_TARGET", component);
  if (name !== "node") equivalent(`${name} stock resolution`, (f) => { f.resolved = { [name]: "/synthetic/SYNTHETIC_PRIVATE_PATH" }; }, executableCall, "STOCK_RESOLVE", component);
  for (const [field, value, predicate] of [["path", "/synthetic/SYNTHETIC_PRIVATE_PATH", "OBSERVED_PATH"], ["realTarget", "/synthetic/SYNTHETIC_PRIVATE_TARGET", "OBSERVED_TARGET"], ["sha256", "b".repeat(64), "OBSERVED_HASH"], ["format", "script", "OBSERVED_FORMAT"], ["package", { name: "OTHER_SYNTHETIC_PRIVATE_PACKAGE" }, "OBSERVED_PACKAGE"]]) {
    equivalent(`${name} observed ${field}`, (f) => { f.actual.tools[name][field] = value; f.config.bootstrapIdentity = identityFingerprint(f.actual); }, identityCall, predicate, component);
  }
}
for (const [field, value, predicate] of [["path", 1, "PIN_PATH_TYPE"], ["path", "relative", "PIN_PATH"], ["realTarget", "relative", "PIN_TARGET"], ["sha256", "bad", "PIN_HASH"], ["format", "unknown", "PIN_FORMAT"]]) equivalent(`pin ${field}`, (f) => { f.config.tools.curl[field] = value; }, executableCall, predicate, "STOCK_CURL");
for (const [field, value, predicate] of [["version", 1, "DISTRIBUTION_VERSION_TYPE"], ["version", "", "DISTRIBUTION_VERSION"], ["architecture", 1, "DISTRIBUTION_ARCH_TYPE"], ["architecture", "", "DISTRIBUTION_ARCH"], ["publicReference", "SYNTHETIC_PRIVATE_URL", "DISTRIBUTION_REFERENCE"], ["archiveSha256", "bad", "DISTRIBUTION_HASH"]]) equivalent(`distribution ${field}`, (f) => { f.config.tools.curl.distribution[field] = value; }, executableCall, predicate, "STOCK_CURL");
equivalent("pin absent", (f) => { f.config.tools.curl = null; }, executableCall, "PIN_RECORD", "STOCK_CURL");
equivalent("distribution absent", (f) => { f.config.tools.curl.distribution = null; }, executableCall, "DISTRIBUTION_RECORD", "STOCK_CURL");
for (const field of ["imageVersion", "imageOS", "architecture", "kernel", "osReleaseSha256", "toolsSha256", "versionsSha256", "daemonSha256", "identitySha256"]) {
  const result = equivalent(`fingerprint ${field}`, (f) => { f.config.bootstrapIdentity[field] = "SYNTHETIC_PRIVATE_MISMATCH"; }, identityCall, "FINGERPRINT_EQUAL", "FINGERPRINT");
  assert.equal(result.context.split("mismatches=")[1], ({ imageVersion: "FINGERPRINT_IMAGE_VERSION", imageOS: "FINGERPRINT_IMAGE_OS", architecture: "FINGERPRINT_ARCHITECTURE", kernel: "FINGERPRINT_KERNEL", osReleaseSha256: "FINGERPRINT_OS_RELEASE", toolsSha256: "FINGERPRINT_TOOLS", versionsSha256: "FINGERPRINT_VERSIONS", daemonSha256: "FINGERPRINT_DAEMON", identitySha256: "FINGERPRINT_IDENTITY" })[field]);
}
const isolateIdentity = (mutate) => (f) => { mutate(f); f.config.bootstrapIdentity = identityFingerprint(f.actual); };
for (const [name, actualField] of [["docker", "executable"], ["containerd", "containerdExecutable"]]) equivalent(`daemon ${name}`, isolateIdentity((f) => { f.actual.daemon[actualField].sha256 = "b".repeat(64); }), identityCall, "OBSERVED_HASH", `DAEMON_${name.toUpperCase()}`);
equivalent("active runtime default", isolateIdentity((f) => { f.actual.daemon.defaultRuntime = "synthetic-other"; }), identityCall, "ACTIVE_RUNTIME_DEFAULT", "ACTIVE_RUNTIME");
equivalent("active runtime absent", isolateIdentity((f) => { f.actual.daemon.activeRuntime = null; }), identityCall, "ACTIVE_RUNTIME_PRESENT", "ACTIVE_RUNTIME");
equivalent("active runtime hash", isolateIdentity((f) => { f.actual.daemon.activeRuntime.sha256 = "b".repeat(64); }), identityCall, "OBSERVED_HASH", "ACTIVE_RUNTIME");
for (const [field, predicate] of [["image", "RUNNER_IMAGE"], ["imageVersion", "RUNNER_IMAGE_VERSION"], ["imageOS", "RUNNER_IMAGE_OS"], ["architecture", "RUNNER_ARCHITECTURE"], ["kernel", "RUNNER_KERNEL"], ["os", "RUNNER_OS"], ["codename", "RUNNER_CODENAME"]]) equivalent(`runner ${field}`, (f) => { f.config.runnerIdentity[field] = "SYNTHETIC_PRIVATE_MISMATCH"; }, identityCall, predicate, "RUNNER");
for (const [field, predicate] of [["version", "RUNNER_ENGINE_VERSION"], ["apiVersion", "RUNNER_ENGINE_API"], ["gitCommit", "RUNNER_ENGINE_COMMIT"]]) equivalent(`engine ${field}`, (f) => { f.config.runnerIdentity.engine[field] = "SYNTHETIC_PRIVATE_MISMATCH"; }, identityCall, predicate, "RUNNER");
for (const [index, component] of ["COMPONENT_CONTAINERD", "COMPONENT_RUNC", "COMPONENT_DOCKER_INIT"].entries()) for (const predicate of ["COMPONENT_COUNT", "COMPONENT_VERSION", "COMPONENT_COMMIT"]) equivalent(`${component} ${predicate}`, isolateIdentity((f) => {
  if (predicate === "COMPONENT_COUNT") f.actual.daemon.server.Components.splice(index, 1);
  else if (predicate === "COMPONENT_VERSION") f.actual.daemon.server.Components[index].Version = "SYNTHETIC_PRIVATE_MISMATCH";
  else f.actual.daemon.server.Components[index].Details.GitCommit = "SYNTHETIC_PRIVATE_MISMATCH";
}), identityCall, predicate, component);
for (const name of ["docker", "containerd"]) equivalent(`service ${name}`, (f) => { f.config.servicePins[name].sha256 = "b".repeat(64); }, identityCall, "SERVICE_EQUAL", `SERVICE_${name.toUpperCase()}`);
const rawError = new Error("SYNTHETIC_PRIVATE_RAW token: syntheticMarker");
equivalent("raw executable read", (f) => { f.rawAt = "/synthetic/curl"; f.rawError = rawError; }, executableCall, "EXECUTABLE_REALPATH", "STOCK_CURL");
equivalent("hostile fingerprint getter", (f) => { Object.defineProperty(f.actual, "imageVersion", { get() { throw rawError; }, enumerable: true }); f.rawError = rawError; }, identityCall, "FINGERPRINT_IMAGE_VERSION", "FINGERPRINT");
equivalent("hostile serialization getter", (f) => { Object.defineProperty(f.config.bootstrapIdentity, "kernel", { get() { throw rawError; }, enumerable: true }); f.rawError = rawError; }, identityCall, "FINGERPRINT_EXPECTED_SERIALIZE", "FINGERPRINT");
assert.equal(bootstrapComparisonResult(new Proxy({}, { get() { throw rawError; }, getOwnPropertyDescriptor() { throw rawError; } })), "component=OTHER predicate=OTHER");
assert.equal(bootstrapComparisonResult(createBootstrapComparison()), "component=OTHER predicate=OTHER", "no context crosses invocation handles");
equivalent("opaque recorder cannot invoke hostile caller getters", (f) => { f.handle = new Proxy({}, { get() { throw rawError; }, getOwnPropertyDescriptor() { throw rawError; } }); }, identityCall);
class BrokenDiagnosticStore extends WeakMap { get() { throw rawError; } set() { throw rawError; } has() { throw rawError; } }
equivalent("recorder fault cannot mask original comparison refusal", (f) => { f.WeakMap = BrokenDiagnosticStore; f.config.tools.curl.sha256 = "b".repeat(64); }, executableCall);
equivalent("recorder fault cannot mask raw thrown object", (f) => { f.WeakMap = BrokenDiagnosticStore; f.rawError = rawError; f.rawAt = "/synthetic/curl"; }, executableCall);
equivalent("recorder fault cannot alter success", (f) => { f.WeakMap = BrokenDiagnosticStore; }, identityCall);
equivalent("forged exact comparison message from raw getter is OTHER", (f) => { const error = new Error("RUNNER_OS_DAEMON_OR_TOOL_DRIFT"); Object.defineProperty(f.actual, "kernel", { get() { throw error; }, enumerable: true }); f.rawError = error; }, identityCall, "FINGERPRINT_KERNEL", "FINGERPRINT");
const fixedClosureDescriptor = fixtureMeasurementPayload().publicInputs.publicExecutables.pnpm.closure;
function scriptFixture(f) {
  Object.assign(f.config.tools.curl, { format: "script", sha256: sha256(scriptBytes), interpreter: { tool: "node", shebang: "#!/usr/bin/env node" }, distributionRoot: "/synthetic", closure: structuredClone(fixedClosureDescriptor) });
  f.bytes["/synthetic/curl"] = scriptBytes;
}
equivalent("synthetic stock script success (reviewed stocks remain native)", scriptFixture, executableCall);
for (const [label, mutate, predicate] of [
  ["tool", (f) => { f.config.tools.curl.interpreter.tool = "other"; }, "SCRIPT_TOOL"],
  ["shebang pin", (f) => { f.config.tools.curl.interpreter.shebang = "SYNTHETIC_PRIVATE_SHEBANG"; }, "SCRIPT_SHEBANG"],
  ["root pin", (f) => { f.config.tools.curl.distributionRoot = "relative"; }, "SCRIPT_ROOT"],
  ["descriptor", (f) => { f.config.tools.curl.closure.fileCount = 1; }, "CLOSURE_DESCRIPTOR"],
  ["resolved root", (f) => { f.targets["/synthetic"] = "/synthetic/other"; }, "DISTRIBUTION_ROOT"],
  ["outside root", (f) => { f.config.tools.curl.distributionRoot = "/other"; }, "DISTRIBUTION_TARGET"],
  ["observed shebang", (f) => { const bytes = Buffer.from("#!/synthetic/private\n"); f.bytes["/synthetic/curl"] = bytes; f.config.tools.curl.sha256 = sha256(bytes); }, "OBSERVED_SHEBANG"],
  ["closure nonarray", (f) => { f.closure = null; }, "CLOSURE_PAIRS"],
  ["pair nonarray", (f) => { f.closure = [null]; }, "CLOSURE_PAIR_ARRAY"],
  ["pair length", (f) => { f.closure = [["x"]]; }, "CLOSURE_PAIR_LENGTH"],
  ["path type", (f) => { f.closure = [[1, "a".repeat(64)]]; }, "CLOSURE_PATH_TYPE"],
  ["hash type", (f) => { f.closure = [["x", 1]]; }, "CLOSURE_HASH_TYPE"],
  ["empty path", (f) => { f.closure = [["", "a".repeat(64)]]; }, "CLOSURE_PATH_NONEMPTY"],
  ["path controls", (f) => { f.closure = [["x\\private", "a".repeat(64)]]; }, "CLOSURE_PATH_CHARACTERS"],
  ["path UTF8", (f) => { f.closure = [["x\ud800", "a".repeat(64)]]; }, "CLOSURE_PATH_UTF8"],
  ["path segments", (f) => { f.closure = [["x/./private", "a".repeat(64)]]; }, "CLOSURE_PATH_SEGMENTS"],
  ["path duplicate", (f) => { f.closure = [["x", "a".repeat(64)], ["x", "a".repeat(64)]]; }, "CLOSURE_PATH_UNIQUE"],
  ["bad hash", (f) => { f.closure = [["x", "bad"]]; }, "CLOSURE_HASH"],
  ["count", (f) => { f.closure = closurePairs.slice(1); }, "CLOSURE_COUNT"],
  ["digest", (f) => { f.closure = structuredClone(closurePairs); f.closure[0][1] = "b".repeat(64); }, "CLOSURE_DIGEST"],
]) equivalent(`script ${label}`, (f) => { scriptFixture(f); mutate(f); }, executableCall, predicate, "STOCK_CURL");
equivalent("stored sidecar order; not a runtime stock-script claim", (f) => { f.closure = [...closurePairs].reverse(); }, (g, f, d) => g.validateScriptClosure(f.closure, fixedClosureDescriptor, true, d), "CLOSURE_ORDER", "OTHER");
for (const [field, value, predicate] of [["format", "script", "INVOCATION_FORMAT"], ["invocation", "wrong", "INVOCATION_NAME"], ["multicall", false, "INVOCATION_MULTICALL"]]) equivalent(`multicall ${field}`, (f) => {
  Object.assign(f.config.tools.curl, { realTarget: "/synthetic/multicall", invocation: "curl", multicall: true }); f.config.tools.curl[field] = value;
}, executableCall, predicate, "STOCK_CURL");
equivalent("native magic", (f) => { f.bytes["/synthetic/curl"] = Buffer.from("SYNTHETIC_PRIVATE_NOT_ELF"); }, executableCall, "EXECUTABLE_FORMAT", "STOCK_CURL");
equivalent("interpreter process", (f) => { f.processPath = "/synthetic/other-node"; }, executableCall, "INTERPRETER_PROCESS", "INTERPRETER");
equivalent("interpreter path operand when explicitly enabled", () => {}, (g, f, d) => g.enforceExecutables(f.config.tools, stockTools, true, d), "INTERPRETER_PATH", "INTERPRETER");
equivalent("interpreter enabled success", (f) => { f.targets["/usr/local/bin/node"] = "/synthetic/node"; }, (g, f, d) => g.enforceExecutables(f.config.tools, stockTools, true, d));
equivalent("interpreter search keeps caught first-path refusal and next-path search", (f) => { f.rawAt = "/usr/local/bin/node"; f.rawError = rawError; }, executableCall);
for (const [field, predicate] of [["imageOS", "FINGERPRINT_IMAGE_OS"], ["architecture", "FINGERPRINT_ARCHITECTURE"], ["kernel", "FINGERPRINT_KERNEL"], ["osRelease", "FINGERPRINT_OS_RELEASE"], ["tools", "FINGERPRINT_TOOLS"], ["versions", "FINGERPRINT_VERSIONS"], ["daemon", "FINGERPRINT_DAEMON"]]) equivalent(`raw fingerprint ${field}`, (f) => { Object.defineProperty(f.actual, field, { get() { throw rawError; }, enumerable: true }); f.rawError = rawError; }, identityCall, predicate, "FINGERPRINT");
equivalent("raw full fingerprint serialization", (f) => { Object.defineProperty(f.actual, "extra", { get() { throw rawError; }, enumerable: true }); f.rawError = rawError; }, identityCall, "FINGERPRINT_IDENTITY", "FINGERPRINT");
equivalent("raw materialized fingerprint serialization without retraversal", (f) => {
  let count = 0;
  f.actual.imageVersion = Object.defineProperty({}, "synthetic", { get() { if (++count === 2) throw rawError; return "SYNTHETIC"; }, enumerable: true });
  f.rawError = rawError;
}, identityCall, "FINGERPRINT_ACTUAL_SERIALIZE", "FINGERPRINT");
for (const [predicate, setup] of [
  ["EXECUTABLE_READ", (f) => { f.rawOp = "read"; f.rawAt = "/synthetic/curl"; }],
  ["STOCK_RESOLVE", (f) => { f.rawOp = "resolve"; f.rawAt = "curl"; }],
  ["DISTRIBUTION_REALPATH", (f) => { scriptFixture(f); f.rawAt = "/synthetic"; }],
  ["DISTRIBUTION_READ", (f) => { scriptFixture(f); f.rawOp = "distribution"; }],
  ["INTERPRETER_PROCESS", (f) => { f.processPath = "/synthetic/process-node"; f.rawAt = f.processPath; }],
]) equivalent(`raw boundary ${predicate}`, (f) => { setup(f); f.rawError = rawError; }, executableCall, predicate);
equivalent("raw component selection after materialized fingerprint", (f) => {
  const components = f.actual.daemon.server.Components; let count = 0;
  Object.defineProperty(f.actual.daemon.server, "Components", { enumerable: true, get() { if (++count === 3) throw rawError; return components; } }); f.rawError = rawError;
}, identityCall, "COMPONENT_SELECT", "COMPONENT_CONTAINERD");
equivalent("raw service pin getter", (f) => { Object.defineProperty(f.config.servicePins, "docker", { get() { throw rawError; }, enumerable: true }); f.rawError = rawError; }, identityCall, "SERVICE_PINS", "SERVICE_DOCKER");
equivalent("per-invocation state does not leak after a refusal", (f) => { f.config.tools.curl.sha256 = "b".repeat(64); }, (g, f, d) => {
  let original; try { g.enforceExecutables(f.config.tools, stockTools, false, d); } catch (error) { original = error; }
  if (g.createBootstrapComparison) assert.equal(g.bootstrapComparisonResult(g.createBootstrapComparison()), "component=OTHER predicate=OTHER");
  throw original;
}, "OBSERVED_HASH", "STOCK_CURL");
const inventoryProbe = fixtureMeasurementPayload(); inventoryProbe.phase = "inventory";
const inventoryExpanded = measurementConfig(inventoryProbe);
const measurementExpanded = measurementConfig({ ...inventoryProbe, phase: "measurement" });
assert.deepEqual({ ...inventoryExpanded, phase: "measurement" }, measurementExpanded, "existing API losslessly expands unchanged public inputs in inventory phase");
assert(stockTools.every((name) => inventoryExpanded.tools[name].format === "native"), "reviewed bootstrap stock scripts are unreachable, not observed or repinned");
console.log(`PROBE GREEN: ${comparisonControls} immutable-H2/no-opt-in/opt-in execution controls; synthetic later gates isolated; no observer or collector invoked`);

function comparisonPartition(text, expectedBinding) {
  const tree = ts.createSourceFile("inventory.mjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const registry = (name) => {
    const variable = descendants(tree, (node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === name)[0];
    assert.equal(variable.initializer.expression.getText(tree), "Object.freeze");
    return variable.initializer.arguments[0].elements.flatMap((node) => {
      if (ts.isStringLiteral(node)) return [node.text];
      assert.equal(name, "bootstrapComparisonComponents");
      assert.equal(node.getText(tree).replace(/\s/g, ""), '...stockTools.map((name)=>`STOCK_${name.replaceAll("-","_").toUpperCase()}`)');
      return stockTools.map((name) => `STOCK_${name.replaceAll("-", "_").toUpperCase()}`);
    });
  };
  const registeredPredicates = registry("bootstrapComparisonPredicates");
  const registeredComponents = registry("bootstrapComparisonComponents");
  const registeredCodes = registry("bootstrapComparisonCodes");
  for (const values of [registeredPredicates, registeredComponents, registeredCodes]) assert.equal(new Set(values).size, values.length);
  const annotations = [];
  const componentBindings = [];
  const components = new Set(["OTHER", ...stockTools.map((name) => `STOCK_${name.replaceAll("-", "_").toUpperCase()}`)]);
  const codes = new Set();
  const predicates = new Set(["OTHER", "FINGERPRINT_EQUAL"]);
  const productionCodes = new Map();
  for (const fn of tree.statements.filter((node) => ts.isFunctionDeclaration(node) && [...probeFunctions, "comparisonEqual"].includes(node.name.text))) {
    for (const call of descendants(fn, (node) => ts.isCallExpression(node))) {
      if (call.expression.getText(tree) === "invariant") { assert(ts.isStringLiteral(call.arguments[1])); codes.add(call.arguments[1].text); }
      if (["comparisonComponent", "comparisonStock"].includes(call.expression.getText(tree))) {
        const context = call.arguments[1];
        if (call.expression.getText(tree) === "comparisonStock") assert.equal(context.getText(tree), "name");
        else if (ts.isStringLiteral(context)) components.add(context.text);
        else {
          const values = descendants(context, ts.isPropertyAssignment).map((property) => property.initializer);
          assert(values.length > 0 && values.every(ts.isStringLiteral));
          values.forEach((value) => components.add(value.text));
        }
        componentBindings.push({ owner: fn.name.text, expression: syntaxShape(call) });
      }
      if (call.expression.getText(tree) !== "comparisonAt") continue;
      const token = call.arguments[1];
      const tokens = ts.isStringLiteral(token) ? [token.text] : descendants(token, ts.isStringLiteral).map((node) => node.text);
      assert(tokens.length > 0);
      tokens.forEach((token) => { assert(registeredPredicates.includes(token), `unregistered predicate ${token}`); predicates.add(token); });
      const operation = call.arguments[2];
      assert(ts.isArrowFunction(operation) && !ts.isBlock(operation.body) && operation.parameters.length === 0);
      annotations.push({ owner: fn.name.text, tokens, expression: syntaxShape(operation.body) });
      for (let parent = call.parent; parent && parent !== fn; parent = parent.parent) if (ts.isCallExpression(parent) && parent.expression.getText(tree) === "invariant") {
        tokens.forEach((token) => productionCodes.set(token, parent.arguments[1].text)); break;
      }
    }
  }
  assert.deepEqual(predicates, new Set(registeredPredicates), "every registered predicate is used, none omitted");
  assert.deepEqual(components, new Set(registeredComponents), "every fixed component has a source binding");
  assert.deepEqual(codes, new Set(registeredCodes), "every reached existing comparison refusal remains source-owned");
  productionCodes.set("FINGERPRINT_EQUAL", "RUNNER_OS_DAEMON_OR_TOOL_DRIFT");
  const mappingNode = descendants(tree, (node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === "comparisonPredicateCodes")[0];
  const mappings = descendants(mappingNode, ts.isPropertyAssignment).flatMap((property) => {
    assert(ts.isArrayLiteralExpression(property.initializer));
    return property.initializer.elements.map((token) => { assert(ts.isStringLiteral(token)); return [token.text, property.name.getText(tree)]; });
  });
  assert.equal(new Map(mappings).size, mappings.length);
  assert.deepEqual(new Map(mappings), productionCodes, "safe-code authentication is derived from each production invariant, not a forged message");
  const binding = sha256(JSON.stringify({ annotations, componentBindings }));
  if (expectedBinding) assert.equal(binding, expectedBinding, "production expression/call-site classification binding");
  return { annotations, binding };
}
const partition = comparisonPartition(source, "65ca1fa7548a92a7a9424a2e6d5c34c0ca2b2d1133aae170b4fbde83405b0acc");
console.log(`PROBE PARTITION ${partition.annotations.length} source expression bindings SHA-256=${partition.binding}`);
for (const row of partition.annotations) {
  const before = `"${row.tokens[0]}"`;
  const owner = source.indexOf(`function ${row.owner}(`);
  const site = source.indexOf(before, owner);
  assert(site >= owner);
  assert.throws(() => comparisonPartition(source.slice(0, site) + '"OTHER"' + source.slice(site + before.length), partition.binding), undefined, `${row.owner}/${row.tokens[0]} bypass or misbinding refuses`);
}
for (const name of ["bootstrapComparisonPredicates", "bootstrapComparisonComponents", "bootstrapComparisonCodes"]) {
  const marker = `export const ${name} = Object.freeze([`;
  assert(source.includes(marker));
  assert.throws(() => comparisonPartition(source.replace(marker, `${marker}\n"UNUSED_SYNTHETIC_MEMBER",`), partition.binding));
}
assert.throws(() => comparisonPartition(source.replace('TOOL_PACKAGE_DRIFT: ["OBSERVED_PACKAGE"]', 'TOOL_PACKAGE_DRIFT: ["OBSERVED_HASH"]'), partition.binding));
const seamTree = ts.createSourceFile("inventory.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const seamCalls = new Set(["Object.freeze", "comparisonStates.set", "comparisonStates.get", "comparisonStates.has", "bootstrapComparisonComponents.includes", "bootstrapComparisonPredicates.includes", "comparisonComponent", "stockComparisonComponents.get", "operation", "comparisonPredicateCodes.get", "comparisonAt", "canonical", "Object.getOwnPropertyDescriptor", "state.fingerprint.map", "JSON.parse", "fields.flatMap"]);
for (const fn of seamTree.statements.filter((node) => ts.isFunctionDeclaration(node) && comparisonHelpers.includes(node.name.text))) for (const call of descendants(fn, ts.isCallExpression)) {
  const fixedTokenJoin = ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "join" && ts.isCallExpression(call.expression.expression) && call.expression.expression.expression.getText(seamTree) === "fields.flatMap" && call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === ",";
  assert(fixedTokenJoin || seamCalls.has(call.expression.getText(seamTree)), `no I/O, logging or caller sink in attribution helper ${fn.name.text}`);
}
for (const predicate of bootstrapComparisonPredicates) {
  const result = graphRun(source, comparisonFixture(), (g, _f, d) => g.comparisonAt(d, predicate, () => { throw rawError; }), true);
  assert.equal(result.error, rawError, "each registered annotation preserves its original raw thrown object");
  assert.equal(result.category, "OTHER", "no entered-but-uncompleted predicate authenticates a refusal");
  assert.equal(result.context, `component=OTHER predicate=${predicate}`);
}
console.log(`PROBE COMPLETE: ${bootstrapComparisonPredicates.length} annotation-boundary raw controls, full component/code closure and unused/member/misbinding mutants; helpers contain no I/O or logging`);
