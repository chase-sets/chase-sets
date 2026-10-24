import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const nativeRemoval = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: (...args: Parameters<typeof original.spawnSync>) => nativeRemoval(...args),
  };
});

const control = await import(new URL("./selector-agent-control.mjs", import.meta.url).href);
const { JSDOM } = await import(import.meta.resolve("jsdom"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const scratch = path.join(repo, "artifacts", "9514", "tests");
mkdirSync(scratch, { recursive: true });
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const html = `<main data-selector-orders aria-busy="false">
  <select name="dateRange"><option value="LastTwoYears" selected>Last 2 years</option><option value="LastThreeMonths">Last 90 days</option></select>
  <div data-quick-filter="ReadyToShip"><span data-filter-label> Ready   to Ship </span><span data-filter-count>8675309</span></div>
  <span data-orders-completion data-load="load-1" data-range="LastTwoYears"></span>
  <section>SYNTHETIC_PRIVATE_ROWS</section><p>all orders: 999999</p>
</main>`;
const documentFor = (markup = html) => new JSDOM(markup).window.document;
const command = (binding: { runId: string }, operation: string) => ({
  runId: binding.runId,
  policyHash: control.POLICY.hash,
  operation,
});
const nativeWitness = () => ({
  epoch: 1,
  names: 2,
  scanned: 2,
  enumeration: "COMPLETE",
  roots: [[1, "RETURNED", "NONE", 0, 0]] as (string | number | null)[][],
  started: [1, 1, 1, "ROOT", "CHILDREN"],
  completed: [1, 1, 1, "ROOT", "CHILDREN", "RETURNED", "NONE"],
  caught: null,
  caughtCount: 0,
  terminal: null,
  predicates: Array(10).fill("NOT_OBSERVED"),
  lastPredicate: null,
  dialogBits: Array(3).fill("NOT_OBSERVED"),
  buttonBits: Array(5).fill("NOT_OBSERVED"),
  identity: "INITIAL_MATCH",
  budget: "WITHIN",
  final: true,
  integrity: "COMPLETE",
});
function nativeSlot(witness: unknown, nonce = "a".repeat(48), child = 5151) {
  const payload = Buffer.from(JSON.stringify({ nonce, child: hash(`${nonce}:${child}`), witness }));
  const frame = Buffer.alloc(4096);
  frame.write(String(payload.length).padStart(8, "0") + hash(payload));
  payload.copy(frame, 72);
  return frame;
}
function fixture(mode = "S") {
  const root = mkdtempSync(path.join(scratch, "selector-capability-synthetic-"));
  const profile = path.join(root, "profile");
  mkdirSync(profile);
  const executable = path.join(root, "synthetic-chrome.exe");
  writeFileSync(executable, "SYNTHETIC EXECUTABLE, NOT A BROWSER");
  const binding = {
    evidence: "synthetic",
    runId: path.basename(root),
    mode,
    performer: "selector-agent-operator",
    verifier: "selector-agent-host-verifier",
    session: "synthetic-session",
    model: "gpt-6.1-sol/high",
    tool: "channels-selector-run-endpoint/v1",
    root,
    profile,
    profileIdentity: control.validateCleanupTarget({ root, profile }),
    executable,
    executableHash: hash(readFileSync(executable)),
    version: "synthetic-1",
    packageId: "abcdefghijklmnopabcdefghijklmnop",
    packageHash: "a".repeat(64),
    adapterHash: hash(readFileSync(new URL("./selector-agent-control.mjs", import.meta.url))),
    policyIdentity: control.POLICY.identity,
    policyHash: control.POLICY.hash,
    controlHash: hash(readFileSync(new URL("./selector-agent-control.mjs", import.meta.url))),
    startedAt: new Date().toISOString(),
    freshSignedOut: true,
  };
  let doc = documentFor();
  const calls: string[] = [];
  const browser = {
    identity: binding,
    async inspect() {
      calls.push("inspect");
      return control.inspectOrders(doc, "LastTwoYears");
    },
    async action(operation: string) {
      calls.push(operation);
      return { ok: true };
    },
    async close() {
      calls.push("close");
    },
  };
  return {
    binding,
    browser,
    calls,
    profile,
    root,
    document: () => doc,
    replace: (next: Document) => {
      doc = next;
    },
  };
}

describe("selector-agent-control-capability", () => {
  it("executes the native window predicate without page traversal; window, prompt, focus and uniqueness mutants fail", async () => {
    const exposed = await mutant("const nativeRemovalScript =", "export const nativeRemovalScript =");
    const { execFileSync: execute } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const harness = String.raw`
import ast, json, sys, types
input = json.load(sys.stdin)
tree = ast.parse(input['script'])
parts = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name == 'states': parts.append(node)
    elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'title': parts.append(node)
    elif isinstance(node, ast.While): parts.append(node)
    elif isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Name) and node.test.left.id == 'button': parts.append(node)
    elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Tuple) and [item.id for item in node.targets[0].elts] == ['bus', 'dialog', 'path']: parts.append(node)
    elif isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'site': parts.append(node)
    elif isinstance(node, ast.If) and any(isinstance(item, ast.Call) and isinstance(item.func, ast.Name) and item.func.id == 'states' for item in ast.walk(node.test)): parts.append(node)
assert len(parts) == 10
nodes, touched, clock = input['nodes'], [], [0]
root, bus = b'/org/a11y/atspi/accessible/root', b':1.1'
scope = {'stage':'PROCESS', 'pid':42, 'until':4, 'button':None, 'root':root, 'accessible':b'org.a11y.atspi.Accessible', 'witness':{'epoch':0,'caughtCount':0,'integrity':'COMPLETE'}, 'predicate_keys':list(range(10)), 'emit_witness':lambda:None, 'decoded':lambda fn:fn, 'predicate':lambda key,value:value}
def children(owner, path):
    touched.append(path.decode())
    return [value.encode() for value in (input['roots'] if path == root else nodes[path.decode()]['children'])]
def call(owner, path, interface, method, arguments=None):
    if method == b'ListNames': return ([bus],)
    if method == b'GetConnectionUnixProcessID': return (42,)
    assert method == b'GetState'
    scope['stage'] = 'WINDOW'
    node = nodes[path.decode()]
    words = [0, 0]
    for state in node['states']: words[state // 32] |= 1 << (state % 32)
    return (node.get('words', words),)
def now():
    clock[0] += 1
    return clock[0]
scope.update({'time':types.SimpleNamespace(time=now, sleep=lambda value:None), 'children':children, 'call':call,
    'role':lambda owner,path:nodes[path.decode()]['role'].encode(), 'name':lambda owner,path:nodes[path.decode()]['name'].encode(),
    'strings':lambda reply:reply[0], 'scalar':lambda reply,reader:reader(reply[0]), 'uint':lambda value:value,
    'params':lambda *values:values, 'child':lambda value,index:value[index], 'length':len, 'unref':lambda value:None})
try:
    exec(compile(ast.Module(body=parts, type_ignores=[]), '<production native window predicate>', 'exec'), scope)
    accepted = True
except (RuntimeError, KeyError): accepted = False
print(json.dumps({'accepted':accepted, 'stage':scope['stage'], 'touched':touched}))
`;
    const nodes = {
      frame: { role: "frame", name: "SYNTHETIC_BROWSER", children: ["view", "dialog", "inactive"], states: [] },
      view: { role: "panel", name: "SYNTHETIC_VIEW", children: ["page-dialog"], states: [] },
      "page-dialog": { role: "dialog", name: "SYNTHETIC_PAGE_PROMPT", children: [], states: [1, 25, 30] },
      dialog: {
        role: "dialog",
        name: 'Remove "Chase Sets Temporary Order Authority Capture"?',
        children: ["button"],
        states: [1, 25, 30],
      },
      inactive: { role: "dialog", name: "SYNTHETIC_INACTIVE_BROWSER_UI", children: [], states: [25, 30] },
      button: { role: "push button", name: "Remove", children: [], states: [8, 12, 24, 25, 30] },
    };
    const run = (
      script: string,
      value: Record<
        string,
        { role: string; name: string; children: string[]; states: number[]; words?: number[] }
      > = nodes,
    ) =>
      JSON.parse(
        execute(process.platform === "win32" ? "python" : "python3", ["-c", harness], {
          input: JSON.stringify({ script, nodes: value, roots: ["frame"] }),
          encoding: "utf8",
        }),
      ) as { accepted: boolean; stage: string; touched: string[] };
    const source = exposed.nativeRemovalScript as string;
    const positive = run(source);
    expect(positive.accepted).toBe(true);
    expect(positive.touched).not.toContain("view");
    const broad = source.replace(
      "for path in candidates:",
      "for path in [node for candidate in candidates for node in [candidate] + children(bus, candidate)]:",
    );
    expect(run(broad).accepted).toBe(false);
    const unguardedInactive = source.replace(
      "if not predicate('dialogState', states(bus, path, 1, 25, 30)): continue",
      "if False: continue",
    );
    expect(run(unguardedInactive).accepted).toBe(false);
    const wrong = { ...nodes, dialog: { ...nodes.dialog, name: "SYNTHETIC_UNKNOWN_ACTIVE_PROMPT" } };
    expect(run(source, wrong).accepted).toBe(false);
    expect(
      run(source.replace("if actual != title: raise RuntimeError()", "if False: raise RuntimeError()"), wrong).accepted,
    ).toBe(true);
    const unfocused = { ...nodes, button: { ...nodes.button, states: [8, 24, 25, 30] } };
    expect(run(source, unfocused)).toMatchObject({ accepted: false, stage: "WINDOW" });
    expect(
      run(source.replace("states(bus, path, 8, 12, 24, 25, 30)", "states(bus, path, 8, 24, 25, 30)"), unfocused)
        .accepted,
    ).toBe(true);
    const duplicate = {
      ...nodes,
      frame: { ...nodes.frame, children: ["view", "dialog", "second", "inactive"] },
      second: nodes.dialog,
    };
    expect(run(source, duplicate).accepted).toBe(false);
    expect(
      run(source.replace("if len(matches) > 1: raise RuntimeError()", "if False: raise RuntimeError()"), duplicate)
        .accepted,
    ).toBe(true);
    for (const state of [8, 24, 25, 30])
      expect(
        run(source, {
          ...nodes,
          button: { ...nodes.button, states: nodes.button.states.filter((value) => value !== state) },
        }).accepted,
      ).toBe(false);
    expect(run(source, { ...nodes, dialog: { ...nodes.dialog, states: [25, 30] } }).accepted).toBe(false);
    expect(run(source, { ...nodes, dialog: { ...nodes.dialog, words: [0] } }).accepted).toBe(false);
  });
  it("native discovery admits only closed host witnesses, never private output or an inferred native action", async () => {
    const exposed = await mutant("function readNativeRemovalOutput(", "export function readNativeRemovalOutput(");
    const witness = nativeWitness();
    const output = (value: unknown) => `NATIVE_REMOVE_WITNESS:${JSON.stringify(value)}\nNATIVE_REMOVE_REFUSED:OWNER\n`;
    expect(exposed.readNativeRemovalOutput(output(witness))).toEqual({
      result: "NATIVE_REMOVE_REFUSED:OWNER",
      witness,
    });
    const partial = `NATIVE_REMOVE_WITNESS:${JSON.stringify(witness)}\n`;
    expect(exposed.readNativeRemovalOutput(partial)).toEqual({ result: "", witness: null });
    expect(exposed.readNativeRemovalOutput(partial + output(witness))).toEqual({ result: "", witness: null });
    expect(
      exposed.readNativeRemovalOutput('NATIVE_REMOVE_WITNESS:{"private":"SYNTHETIC_PRIVATE"}\n' + output(witness)),
    ).toEqual({
      result: "",
      witness: null,
    });
    for (const value of [
      { ...witness, title: "SYNTHETIC_PRIVATE_TITLE" },
      { ...witness, terminal: ["ROLE", "SYNTHETIC_PRIVATE_EXCEPTION"] },
      { ...witness, names: 65 },
      { ...witness, roots: [[1, "RPC_FAILED", "SYNTHETIC_PRIVATE_ERROR", null, null]] },
      { ...witness, final: "true" },
      { ...witness, budget: "UNKNOWN" },
    ])
      expect(exposed.readNativeRemovalOutput(output(value))).toEqual({ result: "", witness: null });
    expect(exposed.readNativeRemovalOutput("SYNTHETIC_PRIVATE_OUTPUT").witness).toBeNull();
    expect(exposed.readNativeRemovalOutput("SYNTHETIC_PRIVATE_OUTPUT\nNATIVE_REMOVE_SENT")).toEqual({
      result: "",
      witness: null,
    });
    expect(exposed.readNativeRemovalOutput("x".repeat(4097))).toEqual({ result: "", witness: null });
    expect(exposed.readNativeRemovalOutput(partial.repeat(10))).toEqual({ result: "", witness: null });
    expect(exposed.readNativeRemovalOutput(output(witness).trimEnd())).toEqual({ result: "", witness: null });
    expect(
      exposed.readNativeRemovalOutput(`NATIVE_REMOVE_WITNESS:${JSON.stringify(witness)}\nNATIVE_REMOVE_SENT\n`),
    ).toEqual({ result: "", witness: null });
  });
  it("accepts only intact, fixed-size, current-child diagnostic slots and retains an honest in-flight call", async () => {
    const exposed = await mutant("function readNativeRemovalSlot(", "export function readNativeRemovalSlot(");
    const witness = {
      ...nativeWitness(),
      final: false,
      enumeration: "IN_FLIGHT",
      started: [2, 1, 2, "ROOT", "CHILDREN"],
      roots: [
        [1, "RETURNED", "NONE", 0, 0],
        [2, "IN_FLIGHT", "NONE", null, null],
      ],
    };
    const frame = nativeSlot(witness);
    expect(exposed.readNativeRemovalSlot(frame, "a".repeat(48), 5151)).toEqual(witness);
    expect(witness.started[0]).toBeGreaterThan(witness.completed[0]);
    for (const invalid of [
      frame.subarray(0, 4095),
      Buffer.concat([frame, Buffer.alloc(1)]),
      Buffer.alloc(4096),
      nativeSlot({ ...witness, private: "SYNTHETIC_PRIVATE" }),
    ])
      expect(exposed.readNativeRemovalSlot(invalid, "a".repeat(48), 5151)).toBeNull();
    const torn = Buffer.from(frame);
    torn[80] ^= 1;
    expect(exposed.readNativeRemovalSlot(torn, "a".repeat(48), 5151)).toBeNull();
    const tail = Buffer.from(frame);
    tail[4095] = 1;
    expect(exposed.readNativeRemovalSlot(tail, "a".repeat(48), 5151)).toBeNull();
    expect(exposed.readNativeRemovalSlot(frame, "b".repeat(48), 5151)).toBeNull();
    expect(exposed.readNativeRemovalSlot(frame, "a".repeat(48), 5152)).toBeNull();
  });
  it("executes correlated root, descendant, false-predicate and interrupted-call diagnostic discriminators", async () => {
    const exposed = await mutant("const nativeRemovalScript =", "export const nativeRemovalScript =");
    const { execFileSync: execute } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const harness = String.raw`
import ast, copy, hashlib, json, sys, types
input = json.load(sys.stdin)
tree = ast.parse(input['script'])
prefix = []
for node in tree.body:
    if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Tuple):
        if any(isinstance(item, ast.Name) and item.id == 'profile' for item in node.targets[0].elts): break
    if not isinstance(node, ast.Import) and not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Attribute)): prefix.append(node)
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ['call', 'children']]
frames, inflight, clock = [], [], [0]
scope = dict(json=json, hashlib=hashlib, sys=types.SimpleNamespace(argv=['a'*48]), time=types.SimpleNamespace(time=lambda:clock[0]), os=types.SimpleNamespace(getpid=lambda:5151, pwrite=lambda fd,data,offset:frames.append(data)))
exec(compile(ast.Module(body=prefix+functions, type_ignores=[]), '<production diagnostic functions; synthetic RPC only>', 'exec'), scope)
scope.update(until=30, site='ROOT', ordinal=1, root=b'/SYNTHETIC_ROOT', accessible=b'SYNTHETIC_ACCESSIBLE', connection=None,
    ptr=lambda:True, c=types.SimpleNamespace(byref=lambda value:value, string_at=lambda value:value),
    remote_error=lambda error:b'org.freedesktop.DBus.Error.UnknownMethod', free=lambda value:None,
    child=lambda value,index:value[index], length=len, unref=lambda value:None, string=lambda value,unused:value)
scope['witness'].update(epoch=1, names=2, scanned=2, enumeration='IN_FLIGHT', roots=[[1,'NOT_STARTED','NONE',None,None]])
replies = [None, ([],), None]
def invoke(*args):
    inflight.append(copy.deepcopy(scope['witness']))
    return replies.pop(0)
scope['invoke'] = invoke
try: scope['children'](b':SYNTHETIC_UNSUPPORTED', scope['root'])
except RuntimeError:
    scope['witness'].update(caught=scope['witness']['completed'], caughtCount=1)
scope['ordinal'] = 2
scope['witness']['roots'].append([2,'NOT_STARTED','NONE',None,None])
scope['children'](b':SYNTHETIC_SUPPORTED', scope['root'])
after_root = copy.deepcopy(scope['witness'])
scope['site'] = 'TOP_LEVEL_WIDGET'
try: scope['children'](b':SYNTHETIC_SUPPORTED', b'/SYNTHETIC_DESCENDANT')
except RuntimeError: pass
after_descendant = copy.deepcopy(scope['witness'])
scope['predicate']('dialogState', False)
after_false = copy.deepcopy(scope['witness'])
def killed(*args): raise SystemExit()
scope['invoke'] = killed
scope['site'] = 'DIRECT_CHILD'
try: scope['call'](b':SYNTHETIC_SUPPORTED', b'/SYNTHETIC_CHILD', b'SYNTHETIC_ACCESSIBLE', b'GetRoleName')
except SystemExit: pass
print(json.dumps(dict(root=after_root, descendant=after_descendant, falsePredicate=after_false, interrupted=scope['witness'], inflight=inflight, slotSize=max(map(len,frames)), synthetic=True, nativeExecution=False)))
`;
    const result = JSON.parse(
      execute(process.platform === "win32" ? "python" : "python3", ["-c", harness], {
        input: JSON.stringify({ script: exposed.nativeRemovalScript }),
        encoding: "utf8",
      }),
    );
    expect(result).toMatchObject({ synthetic: true, nativeExecution: false, slotSize: 4096 });
    expect(result.root.roots).toEqual([
      [1, "RPC_FAILED", "UNKNOWN_METHOD", null, null],
      [2, "RETURNED", "NONE", 0, 0],
    ]);
    expect(result.root.completed.slice(3)).toEqual(["ROOT", "CHILDREN", "RETURNED", "NONE"]);
    expect(result.root.caught.slice(3)).toEqual(["ROOT", "CHILDREN", "RPC_FAILED", "UNKNOWN_METHOD"]);
    expect(result.descendant.roots).toEqual(result.root.roots);
    expect(result.descendant.completed.slice(3)).toEqual([
      "TOP_LEVEL_WIDGET",
      "CHILDREN",
      "RPC_FAILED",
      "UNKNOWN_METHOD",
    ]);
    expect(result.falsePredicate.predicates[2]).toBe("FALSE");
    expect(result.falsePredicate.predicates[1]).toBe("NOT_OBSERVED");
    expect(result.interrupted.started.slice(3)).toEqual(["DIRECT_CHILD", "ROLE"]);
    expect(result.interrupted.completed).toEqual(result.descendant.completed);
    expect(result.interrupted.started[0]).toBeGreaterThan(result.interrupted.completed[0]);
    expect(result.inflight[0].roots[0][1]).toBe("IN_FLIGHT");
    expect(result.inflight[0].completed).toBeNull();
  });
  it("explicitly admits browser-local metadata; missing automation flag mutant fails", async () => {
    expect(control.hermeticChromiumArguments.filter((arg: string) => arg === "--enable-automation")).toHaveLength(1);
    const altered = await mutant('  "--enable-automation",\n', "");
    expect(altered.hermeticChromiumArguments).not.toContain("--enable-automation");
    expect(Object.isFrozen(control.hermeticChromiumArguments)).toBe(true);
  });
  it("binds the canonical executable rather than a launch-path alias; lexical-path mutant fails", async () => {
    const f = fixture("C");
    const alias = path.join(f.root, "executable-alias");
    symlinkSync(f.root, alias, "junction");
    const executable = path.join(alias, path.basename(f.binding.executable));
    const preparation = {
      evidence: "synthetic",
      profileDirectory: f.profile,
      extensionId: f.binding.packageId,
      packageDigests: { "synthetic-package": "b".repeat(64) },
      t0: f.binding.startedAt,
    };
    const make = (adapter: typeof control) =>
      adapter.createSyntheticBinding({
        preparation,
        executable,
        version: f.binding.version,
        session: f.binding.session,
        model: f.binding.model,
      });
    expect(make(control).executable).toBe(realpathSync(f.binding.executable));
    expect(make(control).executableHash).toBe(f.binding.executableHash);
    const altered = await mutant("executable: realpathSync(executable)", "executable: path.resolve(executable)");
    expect(make(altered).executable).not.toBe(realpathSync(f.binding.executable));
  });
  it("native bus config stays outside sealed v4 inventory; inside-root placement mutant is refused", async () => {
    const packaging = await import(new URL("../integrations/order-authority-probe/package.mjs", import.meta.url).href);
    const parent = mkdtempSync(path.join(scratch, "native-bus-inventory-"));
    const altered = await mutant(
      "path.join(path.dirname(root), `${path.basename(root)}.native-bus.conf`)",
      'path.join(root, "native-bus.conf")',
    );
    for (const [name, adapter] of [
      ["correct", control],
      ["inside-root", altered],
    ] as const) {
      const root = path.join(parent, `selector-capability-${name}`);
      const preparation = packaging.prepare({
        out: root,
        cadenceMs: 1,
        cadenceSource: packaging.AUTHORITY,
        t0: new Date().toISOString(),
        synthetic: true,
      });
      const before = packaging.verifyPackage(root);
      const config = adapter.writeNativeBusConfiguration(preparation);
      if (name === "correct") {
        expect(path.dirname(config)).toBe(parent);
        expect(packaging.verifyPackage(root)).toEqual(before);
      } else expect(() => packaging.verifyPackage(root)).toThrow("inventory_mismatch");
    }
  });
  it.each([
    "confirmed",
    "unknown-output",
    "native-exception",
    "native-executable-refusal",
    "retired-native-stage",
    "native-executable-unreadable-refusal",
    "native-library-refusal",
    "native-window-refusal",
    "native-interrupted",
    "native-torn-slot",
    "native-foreign-child",
    "native-stale-slot",
    "native-malformed-with-slot",
    "native-oversized-output",
    "missing-private-bus",
    "missing-native-action-mutant",
    "missing-foreground-mutant",
    "foreground-private-exception",
    "profile-mismatch",
    "duplicate-profile-switch",
    "missing-browser-process",
    "duplicate-browser-process",
    "invalid-browser-pid",
    "metadata-private-exception",
    "missing-automation-flag",
    "metadata-detach-exception",
    "mode-S-refusal",
  ] as const)("native confirmation %s precedes exact-ID UI removal", async (result) => {
    const f = fixture(result === "mode-S-refusal" ? "S" : "C");
    const digests = { "synthetic-package": "b".repeat(64) };
    f.binding.packageHash = hash(JSON.stringify(digests));
    let rendered = false,
      removed = false,
      clicked = false,
      detached = false,
      foregrounded = false,
      url = "";
    const preflightRefused = [
      "profile-mismatch",
      "duplicate-profile-switch",
      "missing-browser-process",
      "duplicate-browser-process",
      "invalid-browser-pid",
      "metadata-private-exception",
      "missing-automation-flag",
      "metadata-detach-exception",
      "mode-S-refusal",
    ].includes(result);
    const metadataCalls: string[] = [];
    const args = [
      f.binding.executable,
      ...control.hermeticChromiumArguments.filter(
        (arg: string) => result !== "missing-automation-flag" || arg !== "--enable-automation",
      ),
      `--user-data-dir=${f.profile}`,
    ];
    // Chromium's process title loses these boundaries; the structured browser
    // query must retain them rather than learning to parse the display title.
    expect(`${args.join(" ")}\0`.split("\0")).not.toContain(`--user-data-dir=${f.profile}`);
    const metadata = {
      send: async (method: string) => {
        metadataCalls.push(method);
        expect(clicked).toBe(false);
        if (result === "metadata-private-exception" || !args.includes("--enable-automation"))
          throw new Error("SYNTHETIC_PRIVATE_METADATA_EXCEPTION");
        if (method === "Browser.getBrowserCommandLine")
          return {
            arguments:
              result === "profile-mismatch"
                ? [f.binding.executable, `--user-data-dir=${path.join(f.root, "unrelated-profile")}`]
                : result === "duplicate-profile-switch"
                  ? [...args, "--user-data-dir=/SYNTHETIC_OTHER_PROFILE"]
                  : args,
          };
        if (method === "SystemInfo.getProcessInfo")
          return {
            processInfo:
              result === "missing-browser-process"
                ? []
                : result === "duplicate-browser-process"
                  ? [
                      { type: "browser", id: 4242 },
                      { type: "browser", id: 4243 },
                    ]
                  : [{ type: "browser", id: result === "invalid-browser-pid" ? "4242" : 4242 }],
          };
        throw new Error("SYNTHETIC_FORBIDDEN_METADATA_METHOD");
      },
      detach: async () => {
        detached = true;
        if (result === "metadata-detach-exception") throw new Error("SYNTHETIC_PRIVATE_DETACH_EXCEPTION");
      },
    };
    const item = {
      count: async () => (rendered && !removed ? 1 : 0),
      waitFor: async ({ state }: { state: string }) => {
        if (state === "visible") rendered = true;
        else expect(removed).toBe(true);
      },
      locator: (selector: string) => {
        expect(selector).toBe("#removeButton");
        return {
          click: async () => {
            expect(removed).toBe(false);
            expect(detached).toBe(true);
            expect(foregrounded).toBe(true);
            clicked = true;
          },
        };
      },
    };
    const page = {
      goto: async (next: string) => {
        url = next;
      },
      url: () => url,
      bringToFront: async () => {
        expect(detached).toBe(true);
        if (result === "foreground-private-exception") throw new Error("SYNTHETIC_PRIVATE_FOREGROUND_EXCEPTION");
        foregrounded = true;
      },
      on: () => {},
      locator: (selector: string) => {
        if (selector === `extensions-item[id="${f.binding.packageId}"]`) return item;
        throw new Error(`Unexpected WebUI confirmation selector: ${selector}`);
      },
    };
    nativeRemoval
      .mockReset()
      .mockImplementation((_executable: string, args: string[], options: { stdio: unknown[] }) => {
        expect(args.slice(2, 5)).toEqual([f.binding.profile, f.binding.executable, f.binding.executableHash]);
        expect(args[5]).toBe("unix:path=/SYNTHETIC_PRIVATE_BUS");
        expect(args[7]).toBe("4242");
        expect(args[1]).not.toContain("'cmdline'");
        expect(args[1]).toContain("actual_executable != executable");
        expect(args[1]).toContain("b'Remove \"Chase Sets Temporary Order Authority Capture\"?'");
        expect(args[1]).toContain("b'GetName', params(index)");
        expect(args[1]).not.toContain("b'GetActions'");
        expect(args[1]).toContain("if default != [0]: raise RuntimeError()");
        expect(rendered).toBe(true);
        const witness = nativeWitness();
        if (
          [
            "confirmed",
            "native-torn-slot",
            "native-foreign-child",
            "native-stale-slot",
            "native-malformed-with-slot",
            "native-oversized-output",
          ].includes(result)
        ) {
          witness.identity = "ACTION_RECHECK_MATCH";
          witness.predicates[8] = witness.predicates[9] = "TRUE";
          witness.started = [2, 1, 1, "REMOVE_BUTTON", "DO_ACTION"];
          witness.completed = [2, 1, 1, "REMOVE_BUTTON", "DO_ACTION", "RETURNED", "NONE"];
        }
        if (result === "native-interrupted") {
          witness.final = false;
          witness.enumeration = "IN_FLIGHT";
          witness.started = [2, 1, 2, "ROOT", "CHILDREN"];
          witness.roots.push([2, "IN_FLIGHT", "NONE", null, null]);
        }
        const slot = nativeSlot(witness, result === "native-stale-slot" ? "a".repeat(48) : args[8]);
        if (result === "native-torn-slot") slot[80] ^= 1;
        writeSync(options.stdio[3] as number, slot, 0, 4096, 0);
        const response = (terminal: string, status = 1) => ({
          pid: 5151,
          stdout: `NATIVE_REMOVE_WITNESS:${JSON.stringify(witness)}\n${terminal}\n`,
          status,
          signal: null,
        });
        if (result === "native-interrupted") return { pid: 5151, stdout: "", status: null, signal: "SIGTERM" };
        if (result === "native-foreign-child") return { ...response("NATIVE_REMOVE_SENT", 0), pid: 5152 };
        if (result === "native-malformed-with-slot")
          return { ...response("NATIVE_REMOVE_SENT", 0), stdout: "NATIVE_REMOVE_WITNESS:{" };
        if (result === "native-oversized-output")
          return { ...response("NATIVE_REMOVE_SENT", 0), stdout: "x".repeat(4097) };
        if (["native-torn-slot", "native-stale-slot"].includes(result)) return response("NATIVE_REMOVE_SENT", 0);
        if (result === "native-exception") return response("NATIVE_REMOVE_REFUSED:ROLE");
        if (result === "unknown-output")
          return { ...response("NATIVE_REMOVE_SENT"), stdout: "SYNTHETIC_PRIVATE_NATIVE_OUTPUT" };
        if (result === "native-executable-unreadable-refusal")
          return response("NATIVE_REMOVE_REFUSED:PROCESS_EXECUTABLE_UNREADABLE");
        if (result === "retired-native-stage") return response("NATIVE_REMOVE_REFUSED:PROCESS_EXECUTABLE_ALIAS");
        if (["native-executable-refusal", "native-library-refusal", "native-window-refusal"].includes(result))
          return response(
            `NATIVE_REMOVE_REFUSED:${result === "native-executable-refusal" ? "PROCESS_EXECUTABLE" : result === "native-window-refusal" ? "WINDOW" : "LIBRARY"}`,
          );
        removed = true;
        return response("NATIVE_REMOVE_SENT", 0);
      });
    const browserControl =
      result === "missing-native-action-mutant"
        ? await mutant(
            "const child = spawnSync(",
            'const child = (() => ({ status: 0, pid: 5151, stdout: "NATIVE_REMOVE_SENT\\n" }))(',
          )
        : result === "missing-foreground-mutant"
          ? await mutant("await bounded(() => page.bringToFront());", "await Promise.resolve();")
          : control;
    const browser = browserControl.createPlaywrightSelectorBrowser({
      context: {
        browser: () => ({ version: () => f.binding.version, newBrowserCDPSession: async () => metadata }),
        newPage: async () => page,
      },
      preparation: {
        evidence: "synthetic",
        extensionId: f.binding.packageId,
        profileDirectory: f.profile,
        packageDigests: digests,
      },
      binding: f.binding,
      ordersUrl: pathToFileURL(path.join(f.root, "synthetic-orders.html")).href,
      deadline: Date.parse(f.binding.startedAt) + 900000,
      nativeSessionBus: result === "missing-private-bus" ? undefined : "unix:path=/SYNTHETIC_PRIVATE_BUS",
    });
    if (result === "missing-foreground-mutant") await expect(browser.action("remove")).rejects.toThrow("to be true");
    else if (result === "confirmed") expect(await browser.action("remove")).toEqual({ ok: true });
    else
      await expect(browser.action("remove")).rejects.toMatchObject({
        code: result === "mode-S-refusal" ? "PROTOCOL_REFUSED" : "CONTROL_BOUNDARY_LOST",
        message: "selector_operation_refused",
      });
    expect(removed).toBe(result === "confirmed");
    expect(clicked).toBe(
      !preflightRefused &&
        !["missing-private-bus", "missing-foreground-mutant", "foreground-private-exception"].includes(result),
    );
    expect(foregrounded).toBe(
      !preflightRefused &&
        !["missing-private-bus", "missing-foreground-mutant", "foreground-private-exception"].includes(result),
    );
    expect(browser.hostNativeRemovalStage()).toBe(
      {
        confirmed: "UI_ABSENT",
        "unknown-output": "UNKNOWN",
        "native-exception": "ROLE",
        "native-executable-refusal": "PROCESS_EXECUTABLE",
        "retired-native-stage": "UNKNOWN",
        "native-executable-unreadable-refusal": "PROCESS_EXECUTABLE_UNREADABLE",
        "native-library-refusal": "LIBRARY",
        "native-window-refusal": "WINDOW",
        "native-interrupted": "UNKNOWN",
        "native-torn-slot": "UNKNOWN",
        "native-foreign-child": "UNKNOWN",
        "native-stale-slot": "UNKNOWN",
        "native-malformed-with-slot": "UNKNOWN",
        "native-oversized-output": "UNKNOWN",
        "missing-private-bus": "CAPABILITY",
        "missing-native-action-mutant": "UNKNOWN",
        "missing-foreground-mutant": "WINDOW",
        "foreground-private-exception": "WINDOW",
        "profile-mismatch": "PROCESS_PROFILE",
        "duplicate-profile-switch": "PROCESS_PROFILE",
        "missing-browser-process": "PROCESS_UNIQUE",
        "duplicate-browser-process": "PROCESS_UNIQUE",
        "invalid-browser-pid": "PROCESS_UNIQUE",
        "metadata-private-exception": "PROCESS_PROFILE",
        "missing-automation-flag": "PROCESS_PROFILE",
        "metadata-detach-exception": "PROCESS_UNIQUE",
        "mode-S-refusal": null,
      }[result],
    );
    if (result === "native-interrupted")
      expect(browser.hostNativeRemovalWitness()).toMatchObject({
        transport: "INTERRUPTED",
        record: {
          final: false,
          started: [2, 1, 2, "ROOT", "CHILDREN"],
          completed: [1, 1, 1, "ROOT", "CHILDREN", "RETURNED", "NONE"],
        },
      });
    if (
      [
        "native-torn-slot",
        "native-foreign-child",
        "native-stale-slot",
        "native-malformed-with-slot",
        "native-oversized-output",
      ].includes(result)
    )
      expect(browser.hostNativeRemovalWitness()).toEqual({ transport: "REFUSED", record: null });
    expect(
      readdirSync(path.dirname(f.root)).filter((name) => name.startsWith(`${path.basename(f.root)}.remove-`)),
    ).toEqual([]);
    expect(nativeRemoval).toHaveBeenCalledTimes(
      preflightRefused ||
        [
          "missing-private-bus",
          "missing-native-action-mutant",
          "missing-foreground-mutant",
          "foreground-private-exception",
        ].includes(result)
        ? 0
        : 1,
    );
    if (!["missing-private-bus", "mode-S-refusal"].includes(result)) {
      expect(metadataCalls[0]).toBe("Browser.getBrowserCommandLine");
      expect(detached).toBe(true);
      if (
        ![
          "profile-mismatch",
          "duplicate-profile-switch",
          "metadata-private-exception",
          "missing-automation-flag",
        ].includes(result)
      )
        expect(metadataCalls).toEqual(["Browser.getBrowserCommandLine", "SystemInfo.getProcessInfo"]);
    } else expect(metadataCalls).toEqual([]);
  });
  it("waits for the actual fixed helper API before cancel-before-begin, not navigation commit", async () => {
    const f = fixture("C");
    const digests = { "synthetic-package": "b".repeat(64) };
    f.binding.packageHash = hash(JSON.stringify(digests));
    const preparation = {
      evidence: "synthetic",
      extensionId: f.binding.packageId,
      profileDirectory: f.profile,
      packageDigests: digests,
      captureUrl: `chrome-extension://${f.binding.packageId}/capture.html`,
    };
    const ordersUrl = pathToFileURL(path.join(f.root, "synthetic-orders.html")).href;
    let url = "",
      helperReady = false;
    const doc = documentFor();
    const orders = {
      url: () => url,
      goto: async (next: string) => {
        url = next;
      },
      evaluate: async (_fn: unknown, value: { range: string; previous: unknown }) =>
        control.inspectOrders(doc, value.range, value.previous),
      locator: () => ({
        selectOption: async () => {
          doc.querySelector("[data-orders-completion]")!.setAttribute("data-load", "load-2");
        },
      }),
    };
    let helperUrl = "",
      accepted = false;
    let resolveDialog: (value: { ok: boolean; code: string }) => void = () => {};
    const native = {
      message: () =>
        "AGENT: one selector lifecycle with pre-launch T0, including sign-in and removal within T0+15 minutes? Preparation grants no execution; no raw recording or retries.",
      accept: async () => {
        accepted = true;
        resolveDialog({ ok: true, code: "scrubbed_export_created" });
      },
      dismiss: async () => {
        resolveDialog({ ok: false, code: "canceled" });
      },
    };
    let onDialog: (dialog: typeof native) => void = () => {};
    const helper = {
      url: () => helperUrl,
      goto: async (next: string) => {
        helperUrl = next;
      },
      on: (event: string, listener: (dialog: typeof native) => void) => {
        if (event === "dialog") onDialog = listener;
      },
      waitForFunction: async (predicate: () => boolean) => {
        const realm = createContext({ orderAuthorityCapture: { run: () => {}, abort: () => {} } });
        expect(new Script(`(${predicate.toString()})()`).runInContext(realm)).toBe(true);
        helperReady = true;
      },
      evaluate: async () => {
        if (!helperReady) throw new Error("synthetic_helper_not_loaded");
        return new Promise<{ ok: boolean; code: string }>((resolve) => {
          resolveDialog = resolve;
          onDialog(native);
        });
      },
    };
    let pages = 0;
    const context = {
      browser: () => ({ version: () => f.binding.version }),
      newPage: async () => (pages++ === 0 ? orders : helper),
      close: async () => {},
    };
    const browser = control.createPlaywrightSelectorBrowser({
      context,
      preparation,
      binding: f.binding,
      ordersUrl,
      deadline: Date.parse(f.binding.startedAt) + 900000,
    });
    const session = control.attachSelectorSession({ binding: f.binding, browser });
    await session.dispatch(command(f.binding, "attach"));
    expect(await session.dispatch(command(f.binding, "cancel-before-begin"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("CANCELLED");
    expect(accepted).toBe(false);
  });
  it("restart never re-admits a consumed root, even after terminal closure", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "close"));
    expect(() => control.attachSelectorSession({ binding: f.binding, browser: f.browser })).toThrow(
      "selector_lifecycle_consumed",
    );
  });
  it("attaches only the exact bound Channels route and exposes no raw browser capability", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    expect(Object.keys(session).sort()).toEqual(["dispatch", "hostTerminal"]);
    expect(
      await session.dispatch({ runId: f.binding.runId, policyHash: control.POLICY.hash, operation: "attach" }),
    ).toEqual({ ok: true });
    expect(f.calls).toEqual([]);
    for (const key of ["profile", "executableHash", "session", "tool", "controlHash", "policyHash"]) {
      expect(() =>
        control.attachSelectorSession({ binding: { ...f.binding, [key]: "wrong" }, browser: f.browser }),
      ).toThrow();
    }
  });
  it("the authenticated run endpoint is the actual attachment path, not a CDP port", async () => {
    const f = fixture();
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    const endpoint = await control.createRunEndpoint(session, f.binding);
    try {
      const denied = await fetch(endpoint.url, { method: "POST", body: JSON.stringify(command(f.binding, "attach")) });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe("");
      expect(session.hostTerminal().cause).toBeNull();
      const attached = await fetch(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(command(f.binding, "attach")),
      });
      expect(await attached.json()).toEqual({ ok: true });
      const hostile = await fetch(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({ ...command(f.binding, "evaluate"), js: "SYNTHETIC_PRIVATE_ROWS" }),
      });
      expect(hostile.status).toBe(204);
      expect(await hostile.text()).toBe("");
      expect(f.calls).toEqual([]);
      expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
    } finally {
      await endpoint.close();
    }
  });
});

describe("selector-agent-control-boundary", () => {
  it("rejects private, hostile, paused and caller-JS output before emission in both modes", async () => {
    for (const mode of ["C", "S"]) {
      for (const operation of [
        "CDP",
        "evaluate",
        "snapshot",
        "fetch",
        "network-events",
        "page-world-click",
        "begin-count-export",
      ]) {
        const f = fixture(mode);
        const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
        expect(
          await session.dispatch({ runId: f.binding.runId, policyHash: control.POLICY.hash, operation }),
        ).toBeNull();
        expect(f.calls).toEqual([]);
        expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
      }
      const f = fixture(mode);
      const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
      expect(
        await session.dispatch({
          runId: f.binding.runId,
          policyHash: control.POLICY.hash,
          operation: "attach",
          js: "SYNTHETIC_PRIVATE_ROWS",
        }),
      ).toBeNull();
      expect(f.calls).toEqual([]);
    }
  });
  it("independent request, page-world laundering and reconstruction attempts fail on EACH exposed path", async () => {
    for (const mode of ["C", "S"] as const) {
      for (const operation of control.POLICY.operations[mode]) {
        for (const field of ["url", "js", "selector", "request", "network", "question"]) {
          const f = fixture(mode);
          const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
          expect(
            await session.dispatch({ ...command(f.binding, operation), [field]: "SYNTHETIC_PRIVATE_ROWS" }),
          ).toBeNull();
          expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
          expect(f.calls).toEqual([]);
        }
      }
    }
  });
  it("pause suppresses inputs, outputs, exceptions and events without releasing capability enforcement", async () => {
    const f = fixture("C");
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "pause"));
    expect(await session.dispatch(command(f.binding, "capture"))).toBeNull();
    expect(f.calls).toEqual([]);
    expect(await session.dispatch({ ...command(f.binding, "capture"), events: "SYNTHETIC_PRIVATE_ROWS" })).toBeNull();
    expect(session.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
    const thrown = fixture();
    thrown.browser.action = async () => {
      throw new Error("SYNTHETIC_PRIVATE_ROWS");
    };
    const other = control.attachSelectorSession({ binding: thrown.binding, browser: thrown.browser });
    await other.dispatch(command(thrown.binding, "attach"));
    await other.dispatch(command(thrown.binding, "resume"));
    expect(await other.dispatch(command(thrown.binding, "navigate-orders"))).toBeNull();
    expect(other.hostTerminal().cause).toBe("ADAPTER_FAILURE");
    expect(JSON.stringify(other.hostTerminal())).not.toContain("PRIVATE");
  });
  it("hostile adapter payload and an in-flight refusal never emit, even after an awaited operation", async () => {
    const f = fixture();
    f.browser.inspect = async () => ({
      ...control.inspectOrders(f.document(), "LastTwoYears"),
      payload: { rows: "SYNTHETIC_PRIVATE_ROWS" },
    });
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "resume"));
    await session.dispatch(command(f.binding, "navigate-orders"));
    expect(await session.dispatch(command(f.binding, "initial-range"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("DISCLOSURE_GUARD");
    const racing = fixture("C");
    let release: () => void = () => {};
    racing.browser.action = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const concurrent = control.attachSelectorSession({ binding: racing.binding, browser: racing.browser });
    await concurrent.dispatch(command(racing.binding, "attach"));
    const pending = concurrent.dispatch(command(racing.binding, "install"));
    expect(await concurrent.dispatch(command(racing.binding, "evaluate"))).toBeNull();
    release();
    expect(await pending).toBeNull();
  });
});

describe("selector-agent-profile-cleanup", () => {
  it("refuses root, parent, another profile, every linked ancestor and a raced target", () => {
    const f = fixture();
    expect(control.validateCleanupTarget(f.binding)).toBeDefined();
    for (const profile of [f.root, path.dirname(f.root), path.join(f.root, "other")]) {
      expect(() => control.validateCleanupTarget({ ...f.binding, profile })).toThrow();
    }
    const link = path.join(f.root, "linked");
    symlinkSync(f.profile, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => control.validateCleanupTarget({ ...f.binding, profile: link })).toThrow();
    const admitted = control.validateCleanupTarget(f.binding);
    renameSync(f.profile, path.join(f.root, "replaced"));
    mkdirSync(f.profile);
    expect(() => control.validateCleanupTarget(f.binding, admitted)).toThrow();
    expect(existsSync(f.profile)).toBe(true);
  });
  it("independent complete zero-match AND zero-unknown census is required four times, never inferred from UI", () => {
    const f = fixture();
    const at = new Date().toISOString();
    const value = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      at,
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    expect(control.validateCleanupEvidence(f.binding, value)).toBe(value);
    for (const observations of [
      [],
      value.observations.slice(1),
      [{ ...value.observations[0], unknown: 1 }, ...value.observations.slice(1)],
      [{ ...value.observations[0], matches: 1 }, ...value.observations.slice(1)],
      [{ ...value.observations[0], complete: false }, ...value.observations.slice(1)],
    ]) {
      expect(control.validateCleanupEvidence(f.binding, { ...value, observations })).toBeNull();
    }
    expect(
      control.validateCleanupEvidence(f.binding, {
        ...value,
        at: new Date(Date.parse(f.binding.startedAt) + 900001).toISOString(),
      }),
    ).toBeNull();
  });
  it("PowerShell rejects linked ancestors, unsafe targets, live and incomplete census fixtures without deletion", () => {
    const f = fixture();
    const script = fileURLToPath(new URL("./selector-profile-cleanup.ps1", import.meta.url));
    const test = path.join(f.root, "cleanup-fixtures.ps1");
    const admission = path.join(f.root, "native-identity.json");
    writeFileSync(admission, JSON.stringify(f.binding));
    writeFileSync(
      test,
      `. '${script.replaceAll("'", "''")}'
      $a=@{root='${f.root.replaceAll("'", "''")}';profile='${f.profile.replaceAll("'", "''")}';policyIdentity='${control.POLICY.identity}';policyHash='${control.POLICY.hash}';mode='S';scope='capability'}
      Assert-SelectorCleanupTarget $a | Out-Null
      foreach($c in @(@{complete=$false;matches=0;unknown=0},@{complete=$true;matches=1;unknown=0},@{complete=$true;matches=0;unknown=1})) {
        $refused=$false;try{Assert-SelectorCensus $c}catch{$refused=$true};if(-not $refused){throw 'census_bypass'}
      }
      $a.profile=$a.root;$refused=$false;try{Assert-SelectorCleanupTarget $a}catch{$refused=$true};if(-not $refused){throw 'root_bypass'}
      if($IsWindows) {
        Initialize-SelectorCleanupNative
        $binding=Get-Content -LiteralPath '${admission.replaceAll("'", "''")}' -TotalCount 100 | ConvertFrom-Json
        $native=[SelectorCleanupNative]::new($binding.profile,$true)
        try {
          Assert-SelectorNativeIdentity $binding $binding.profile $native
          $refused=$false;try{[IO.Directory]::Move($binding.profile,$binding.profile+'-raced')}catch{$refused=$true}
          if(-not $refused){throw 'native_race_bypass'}
        } finally {$native.Dispose()}
      }
      Write-Output 'synthetic cleanup fixtures passed'
    `,
    );
    expect(execFileSync("pwsh", ["-NoProfile", "-File", test], { encoding: "utf8" }).trim()).toBe(
      "synthetic cleanup fixtures passed",
    );
    expect(existsSync(f.profile)).toBe(true);
  });
  it("PowerShell preserves canonical JSON timestamps before native cleanup; date-coercion mutant is refused", () => {
    const f = fixture();
    const source = fileURLToPath(new URL("./selector-profile-cleanup.ps1", import.meta.url));
    const original = readFileSync(source, "utf8");
    expect(original.split("ConvertFrom-Json -DateKind String")).toHaveLength(2);
    const mutated = path.join(f.root, "date-coercion-mutant.ps1");
    writeFileSync(mutated, original.replace("ConvertFrom-Json -DateKind String", "ConvertFrom-Json"));
    const admission = {
      format: "selector-profile-cleanup/v1",
      root: f.root,
      profile: f.profile,
      profileIdentity: f.binding.profileIdentity,
      scope: "capability",
      mode: "S",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      startedAt: f.binding.startedAt,
      normalClosedAt: f.binding.startedAt,
    };
    for (const [name, script, canonical, reached] of [
      ["candidate", source, true, true],
      ["coercion-mutant", mutated, true, false],
      ["noncanonical", source, false, false],
    ] as const) {
      const file = path.join(f.root, `${name}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          ...admission,
          startedAt: canonical ? admission.startedAt : admission.startedAt.replace(/\.\d{3}Z$/, "Z"),
        }),
      );
      const probe = path.join(f.root, `${name}.ps1`);
      writeFileSync(
        probe,
        `. '${script.replaceAll("'", "''")}'
        $script:nativeReached=$false
        function Initialize-SelectorCleanupNative { $script:nativeReached=$true; throw 'SYNTHETIC_PREFLIGHT_STOP' }
        $result=Invoke-SelectorProfileCleanup '${file.replaceAll("'", "''")}' '${path.join(f.root, `${name}.jsonl`).replaceAll("'", "''")}'
        if($script:nativeReached -ne $${reached}) { throw 'timestamp_discriminator_failed' }
        if($result.cleanup -ne 'REFUSED' -or $result.observations.Count -ne 0) { throw 'synthetic_cutoff_failed' }
        Write-Output 'timestamp discriminator passed; native cleanup intentionally not executed'
      `,
      );
      expect(execFileSync("pwsh", ["-NoProfile", "-File", probe], { encoding: "utf8" }).trim()).toBe(
        "timestamp discriminator passed; native cleanup intentionally not executed",
      );
    }
    expect(existsSync(f.profile)).toBe(true);
  });
});

describe("selector-agent-package-parity", () => {
  it("withdraws human launch authority without changing the v4 worker or permissions", () => {
    const core = path.join(
      repo,
      "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe",
    );
    expect(readFileSync(path.join(core, "helper.js"), "utf8")).not.toContain("HUMAN ONLY");
    const packaging = readFileSync(path.join(core, "package.mjs"), "utf8");
    expect(packaging).not.toContain("HUMAN-operated");
    expect(packaging).toContain("operation-capability-policy");
    const cleanup = readFileSync(new URL("./selector-profile-cleanup.ps1", import.meta.url), "utf8");
    expect(cleanup).toContain(`$SelectorOperationCapabilityPolicyHash = '${control.POLICY.hash}'`);
    expect(hash(readFileSync(path.join(core, "worker.js")))).toBe(
      "3530d525a67b8534b7697ceac7d16de547c5203ad2861831f6cee69199905856",
    );
    expect(hash(readFileSync(path.join(core, "manifest.json")))).toBe(
      "7e4d6ca9b8e34087eb9d36375d4ed0848bc806a8531748a831ab9d92888050b4",
    );
  });
});

describe("selector-agent-orders-anchor-contract", () => {
  it("the code-owned Orders predicate serializes into a browser realm without Node closures", () => {
    const context = createContext({ document: documentFor() });
    const result = new Script(`(${control.inspectOrders.toString()})(document, "LastTwoYears")`).runInContext(context);
    expect(result.payload.currentEpochComplete).toBe(true);
  });
  it("returns only the nine structural predicates and discriminates missing, duplicate, unrelated and stale completion", () => {
    const result = control.inspectOrders(documentFor(), "LastTwoYears");
    expect(result.payload).toEqual({
      rangeSemanticsValid: true,
      selectedRangeValid: true,
      quickFilterRelationshipValid: true,
      currentEpochComplete: true,
      oldCompletionInvalidated: false,
      rangeControlMatches: 1,
      quickFilterLabelMatches: 1,
      adjacentCountMatches: 1,
      completionSignalMatches: 1,
    });
    expect(JSON.stringify(result.payload)).not.toMatch(/8675309|999999|PRIVATE/);
    for (const [markup, cause] of [
      [html.replace('name="dateRange"', 'name="wrong"'), "ANCHOR_ABSENT"],
      [html.replace("data-selector-orders", "data-unrelated-shell"), "ORDERS_UI_UNREACHABLE"],
      [html.replace("Ready   to Ship", "Other status"), "STATE_CONTRADICTORY"],
      [html.replace("data-filter-count", "data-unrelated-count"), "ANCHOR_ABSENT"],
      [html.replace("data-orders-completion", "data-ready-state"), "SETTLE_UNOBSERVABLE"],
      [html.replace('data-range="LastTwoYears"', 'data-range="LastThreeMonths"'), "STATE_CONTRADICTORY"],
      [html.replace("</main>", '<select name="dateRange"></select></main>'), "ANCHOR_AMBIGUOUS"],
    ])
      expect(control.inspectOrders(documentFor(markup), "LastTwoYears").cause).toBe(cause);
  });
  it("requires fixed distinct terminal causes and keeps failed cleanup separate", () => {
    const terminal = { phase: "post-reload", cause: "DEADLINE", cleanup: "FAILED", at: new Date().toISOString() };
    expect(control.validateTerminal(terminal)).toEqual(terminal);
    for (const cause of [
      undefined,
      "unknown",
      "NETWORK_TIMEOUT",
      "DEADLINE provider.example",
      "ADAPTER_FAILURE collapse",
    ]) {
      expect(control.validateTerminal({ ...terminal, cause })).toBeNull();
    }
    for (const cleanup of ["PENDING", "REFUSED", "FAILED", "LATE"]) {
      expect(control.validateTerminal({ ...terminal, cleanup }, true)).toBeNull();
    }
    for (const cause of control.POLICY.causes)
      expect(control.validateTerminal({ ...terminal, cause })?.cause).toBe(cause);
    expect(
      control.validateTerminal({ phase: "disposal", cause: null, cleanup: "TIMELY_VERIFIED", at: terminal.at }, true),
    ).not.toBeNull();
  });
  it("simultaneous protocol/cleanup failure preserves cause and phase; later cleanup cannot restore acceptance", async () => {
    const f = fixture();
    f.browser.action = async () => {
      throw new Error("SYNTHETIC_PRIVATE_ROWS");
    };
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    await session.dispatch(command(f.binding, "resume"));
    await session.dispatch(command(f.binding, "navigate-orders"));
    await session.dispatch(command(f.binding, "close"));
    const at = new Date().toISOString();
    const failed = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "FAILED",
      code: "CLEANUP_REFUSED",
      at,
      observations: [],
    };
    expect(session.hostTerminal(failed)).toMatchObject({
      phase: "Orders-navigation",
      cause: "ADAPTER_FAILURE",
      cleanup: "FAILED",
    });
    const later = {
      ...failed,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    expect(session.hostTerminal(later).cleanup).toBe("FAILED");
    expect(control.validateTerminal(session.hostTerminal(), true)).toBeNull();
  });
  it("the structure-evidence CLI refuses extra/private/missing/drifted fields and accepts only the frozen chronology schema", () => {
    const f = fixture();
    const at = new Date().toISOString();
    const payload = control.inspectOrders(f.document(), "LastTwoYears").payload;
    const cleanup = {
      format: "selector-profile-cleanup-result/v1",
      runId: f.binding.runId,
      policyIdentity: control.POLICY.identity,
      policyHash: control.POLICY.hash,
      cleanup: "TIMELY_VERIFIED",
      code: "CLEANUP_OBSERVED",
      at,
      observations: Array.from({ length: 4 }, () => ({ complete: true, matches: 0, unknown: 0, at })),
    };
    const value = {
      format: "selector-agent-structure-evidence/v1",
      binding: f.binding,
      observations: ["initial-range", "post-reload", "fallback-check"].map((phase, i) => ({
        phase,
        at,
        payload: { ...payload, oldCompletionInvalidated: i > 0 },
      })),
      terminal: { phase: "disposal", cause: null, cleanup: "TIMELY_VERIFIED", at },
      cleanup,
    };
    expect(control.verifyStructureEvidence(value)).toBe(true);
    for (const mutant of [
      { ...value, private: "SYNTHETIC_PRIVATE_ROWS" },
      { ...value, terminal: { ...value.terminal, cause: "unknown" } },
      { ...value, binding: { ...value.binding, policyHash: "0".repeat(64) } },
      { ...value, observations: value.observations.slice(1) },
      { ...value, cleanup: { ...cleanup, observations: [] } },
    ])
      expect(control.verifyStructureEvidence(mutant)).toBe(false);
    const file = path.join(f.root, "synthetic-structure.json");
    writeFileSync(file, JSON.stringify(value));
    const cli = fileURLToPath(new URL("./selector-agent-control.mjs", import.meta.url));
    expect(
      execFileSync(process.execPath, [cli, "--verify-structure-evidence", "--evidence", file], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toContain("independent host acceptance remains pending");
    writeFileSync(file, JSON.stringify({ ...value, private: "SYNTHETIC_PRIVATE_ROWS" }));
    expect(() =>
      execFileSync(process.execPath, [cli, "--verify-structure-evidence", "--evidence", file], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
  });
  it("range and reload invalidate old completion; readyState, sleeps, static shell and self-flags are not settle", () => {
    const doc = documentFor();
    const initial = control.inspectOrders(doc, "LastTwoYears");
    expect(control.inspectOrders(doc, "LastTwoYears", { token: initial.token }).cause).toBe("SETTLE_UNOBSERVABLE");
    expect(
      control.inspectOrders(doc, "LastTwoYears", { token: initial.token, documentChanged: true }).payload
        .currentEpochComplete,
    ).toBe(false);
    doc.querySelector("main")!.setAttribute("aria-busy", "true");
    const pending = control.inspectOrders(doc, "LastTwoYears", { token: initial.token });
    expect(pending.payload.oldCompletionInvalidated).toBe(true);
    expect(pending.payload.currentEpochComplete).toBe(false);
    expect(pending.cause).toBeNull();
    doc.querySelector("main")!.setAttribute("aria-busy", "false");
    doc.querySelector("[data-orders-completion]")!.setAttribute("data-load", "load-2");
    expect(control.inspectOrders(doc, "LastTwoYears", { token: initial.token }).payload.currentEpochComplete).toBe(
      true,
    );
    for (const flag of [
      "data-ready-state",
      "data-network-idle",
      "data-sleep",
      "data-click-success",
      "data-adapter-settled",
    ]) {
      const mutant = documentFor(html.replace("data-orders-completion", flag));
      expect(control.inspectOrders(mutant, "LastTwoYears").cause).toBe("SETTLE_UNOBSERVABLE");
    }
  });
  it("S refuses every C crossover, stale binding and repeated protocol action; a known loading expiry is DEADLINE", async () => {
    for (const operation of ["install", "capture", "cancel-before-begin", "remove", "read-count", "export", "begin"]) {
      const f = fixture();
      const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser });
      expect(await session.dispatch(command(f.binding, operation))).toBeNull();
      expect(f.calls).toEqual([]);
    }
    const f = fixture();
    let now = Date.parse(f.binding.startedAt);
    const session = control.attachSelectorSession({ binding: f.binding, browser: f.browser, now: () => now });
    await session.dispatch(command(f.binding, "attach"));
    now += 900001;
    expect(await session.dispatch(command(f.binding, "resume"))).toBeNull();
    expect(session.hostTerminal().cause).toBe("DEADLINE");
    const g = fixture();
    const other = control.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await other.dispatch(command(g.binding, "attach"));
    g.browser.identity = { ...g.binding, session: "drift" };
    expect(await other.dispatch(command(g.binding, "resume"))).toBeNull();
    expect(other.hostTerminal().cause).toBe("CONTROL_BOUNDARY_LOST");
  });
});

async function mutant(from: string, to: string) {
  const source = fileURLToPath(new URL("./selector-agent-control.mjs", import.meta.url));
  const original = readFileSync(source, "utf8");
  expect(original.split(from)).toHaveLength(2);
  const changed = original
    .replace(from, to)
    .replace("const source = fileURLToPath(import.meta.url);", `const source = ${JSON.stringify(source)};`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`);
}
describe("named bypass mutants", () => {
  it("after-output and pause-events mutants are killed by pre-output custody assertions", async () => {
    const bypass = await mutant("return terminal || paused ? null : result;", "return result;");
    const f = fixture("C");
    let release: () => void = () => {};
    f.browser.action = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    };
    const session = bypass.attachSelectorSession({ binding: f.binding, browser: f.browser });
    await session.dispatch(command(f.binding, "attach"));
    const pending = session.dispatch(command(f.binding, "install"));
    await session.dispatch(command(f.binding, "evaluate"));
    release();
    expect(await pending).not.toBeNull(); // The discriminating invariant would FAIL.
    const pause = await mutant('if (paused && op !== "resume" && op !== "close") return null;', "");
    const g = fixture("C");
    g.browser.action = async () => ({ ok: true });
    const paused = pause.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await paused.dispatch(command(g.binding, "attach"));
    await paused.dispatch(command(g.binding, "pause"));
    await paused.dispatch(command(g.binding, "capture"));
    expect(paused.hostTerminal().cause).toBeNull();
    // Even though final output gating survives, the forbidden action ran.
    expect(await paused.dispatch(command(g.binding, "capture"))).toBeNull();
    expect(paused.hostTerminal().cause).toBe("PROTOCOL_REFUSED");
  });
  it("C-mode model-exposed raw browser and S-to-C crossover mutants fail the closed capability contract", async () => {
    const raw = await mutant(
      "return Object.freeze({ dispatch, hostTerminal });",
      "return Object.freeze({ dispatch, hostTerminal, browser });",
    );
    const f = fixture("C");
    expect(Object.keys(raw.attachSelectorSession({ binding: f.binding, browser: f.browser }))).toContain("browser");
    const crossover = await mutant(
      "!POLICY.operations[admitted.mode].includes(message.operation)",
      "!POLICY.operations.C.includes(message.operation)",
    );
    const g = fixture();
    g.browser.action = async () => ({ ok: true });
    const session = crossover.attachSelectorSession({ binding: g.binding, browser: g.browser });
    await session.dispatch(command(g.binding, "attach"));
    expect(await session.dispatch(command(g.binding, "capture"))).toEqual({ ok: true });
  });
  it("skip-census, reparse and race mutants FAIL the cleanup discriminators", async () => {
    const skip = await mutant('if (value.cleanup === "TIMELY_VERIFIED") {', "if (false) {");
    const f = fixture();
    const at = new Date().toISOString();
    expect(
      skip.validateCleanupEvidence(f.binding, {
        format: "selector-profile-cleanup-result/v1",
        runId: f.binding.runId,
        policyIdentity: control.POLICY.identity,
        policyHash: control.POLICY.hash,
        cleanup: "TIMELY_VERIFIED",
        code: "CLEANUP_OBSERVED",
        at,
        observations: [],
      }),
    ).not.toBeNull();
    const race = await mutant('check(!expected || same(identities, expected), "cleanup_race_refused");', "");
    const admitted = race.validateCleanupTarget(f.binding);
    renameSync(f.profile, path.join(f.root, "old-profile"));
    mkdirSync(f.profile);
    expect(() => race.validateCleanupTarget(f.binding, admitted)).not.toThrow();
    const reparse = await mutant(
      "stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current",
      "true",
    );
    const linked = fixture();
    const target = path.join(linked.root, "target");
    mkdirSync(target);
    renameSync(linked.profile, path.join(linked.root, "old-profile"));
    symlinkSync(target, linked.profile, process.platform === "win32" ? "junction" : "dir");
    expect(() => reparse.validateCleanupTarget({ ...linked.binding, profileIdentity: undefined })).not.toThrow();
  });
});
