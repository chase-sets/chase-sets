// Pure assertions and named source reads only. Never call the collector or runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compareConfigMaps,
  compareIdentity,
  decodeAuthority,
  identityFingerprint,
  inventoryRefusal,
  invocation,
  maximumEnvelopeBytes,
  measurementTools,
  measurementConfig,
  scriptClosureDescriptor,
  scriptClosureFingerprint,
  scriptDistribution,
  validateClosureDescriptor,
  validateScriptAuthority,
  validateScriptClosure,
  stockTools,
  validateAuthorityPath,
  validateCensus,
  validateInventoryPublication,
  validateMeasurementPins,
  validateToolObservation,
} from "./inventory.mjs";
import { parseProtocol, scanExposure, sha256 } from "./helpers.mjs";
import { fixturePayload as payload, fixtureMeasurementPayload, fixtureAuthority } from "./authority-fixtures.mjs";

const p = parseProtocol(readFileSync(new URL("./protocol.json", import.meta.url), "utf8"));
const template = JSON.parse(readFileSync(new URL("./inputs.template.json", import.meta.url), "utf8"));
const head = "a".repeat(40);
const hash = "b".repeat(64);
const clone = (v) => structuredClone(v);
const bytes = (v) => Buffer.from(JSON.stringify(v));
const encoded = (v) => ({ utf8Base64: bytes(v).toString("base64"), sha256: sha256(bytes(v)) });
const envelope = (config = payload(), patch = {}) => fixtureAuthority(config, patch).envelope;
const accept = (e, phase = "inventory") => decodeAuthority(bytes(e), sha256(bytes(e)), { head, phase, protocol: p });
let groups = 0;
const check = (name, run) => {
  run();
  groups++;
  console.log(`PASS ${name}`);
};

check("three freeze cycles removed; template and legacy authority refused", () => {
  for (const field of ["head", "review", "files", "verdict", "payloadSha256", "envelopeSha256"])
    assert(!Object.hasOwn(template, field));
  accept(envelope());
  assert.throws(() => accept(template), /SCHEMA_2/);
  assert.throws(() => accept({ schema: 1 }), /SCHEMA_2/);
  for (const field of ["review", "verdict", "payloadSha256", "envelopeSha256", "receiptSha256"])
    assert.throws(() => accept(envelope({ ...payload(), [field]: hash })), /CIRCULAR_PAYLOAD_FIELD/);
  const root = path.resolve("synthetic-repo");
  const temp = path.resolve("synthetic-temp");
  validateAuthorityPath(path.join(temp, "10678-authority", "freeze.json"), root, temp);
  assert.throws(() => validateAuthorityPath(path.join(root, "inputs.template.json"), root, temp), /EXTERNAL_AUTHORITY/);
  assert.throws(() => validateAuthorityPath(path.join(temp, "arbitrary.json"), root, temp), /FIXED_EXTERNAL/);
});

check("missing stale wrong-head wrong-phase or tampered P R E cannot authorize", () => {
  const e = envelope();
  const malformed = Buffer.from("SYNTHETIC_PRIVATE_MARKER not JSON");
  assert.throws(
    () => decodeAuthority(malformed, sha256(malformed), { head, protocol: p }),
    (error) => error.message === "MALFORMED_AUTHORITY_JSON",
  );
  assert.throws(() => decodeAuthority(Buffer.alloc(0), hash, { head, protocol: p }), /ENVELOPE_SIZE/);
  assert.throws(
    () => decodeAuthority(Buffer.alloc(maximumEnvelopeBytes + 1), hash, { head, protocol: p }),
    /ENVELOPE_SIZE/,
  );
  assert.throws(() => decodeAuthority(bytes(e), undefined, { head, protocol: p }), /FREEZE_DIGEST/);
  assert.throws(() => decodeAuthority(bytes(e), hash, { head, protocol: p }), /FREEZE_DIGEST/);
  for (const [field, value] of [
    ["head", "c".repeat(40)],
    ["phase", "measurement"],
    ["verdict", "PENDING_HOST_REVIEW"],
    ["payloadSha256", hash],
    ["reviewSha256", hash],
    ["subjectBindingSha256", hash],
    ["payloadUtf8Base64", "e30="],
    ["reviewUtf8Base64", "e30="],
    ["subjectBindingUtf8Base64", "e30="],
  ])
    assert.throws(() => accept({ ...e, [field]: value }));
  for (const patch of [
    { head: "c".repeat(40) },
    { phase: "unknown" },
    { briefSha256: hash },
    { methodSha256: hash },
    { decisionSha256: hash },
    { retainedConfigMap: { path: "/guess.yaml" } },
    { sources: [] },
  ])
    assert.throws(() => accept(envelope({ ...payload(), ...patch })));
  const b = JSON.parse(Buffer.from(e.subjectBindingUtf8Base64, "base64"));
  for (const patch of [
    { payloadSha256: hash },
    { head: "c".repeat(40) },
    { phase: "measurement" },
    { verdict: "BLOCK" },
    { reviewSha256: hash },
  ]) {
    const changed = bytes({ ...b, ...patch });
    assert.throws(
      () =>
        accept({ ...e, subjectBindingUtf8Base64: changed.toString("base64"), subjectBindingSha256: sha256(changed) }),
      /STALE_OR_CONTRADICTORY/,
    );
  }
  for (const field of ["lane", "kind", "issue", "outcome", "model", "note"]) {
    const binding = clone(b);
    const completion = JSON.parse(Buffer.from(binding.completion.utf8Base64, "base64"));
    completion[field] = "synthetic-wrong";
    Object.assign(binding.completion, encoded(completion));
    const changed = bytes(binding);
    assert.throws(() =>
      accept({ ...e, subjectBindingUtf8Base64: changed.toString("base64"), subjectBindingSha256: sha256(changed) }),
    );
  }
});

check("exact complete external file census refuses omission addition escape or tamper", () => {
  const files = { "synthetic.txt": sha256("synthetic") };
  validateCensus(files, ["synthetic.txt"], () => Buffer.from("synthetic"));
  assert.throws(() => validateCensus({}, ["synthetic.txt"], () => Buffer.from("synthetic")), /INCOMPLETE/);
  assert.throws(
    () => validateCensus({ ...files, extra: hash }, ["synthetic.txt"], () => Buffer.from("synthetic")),
    /INCOMPLETE/,
  );
  assert.throws(() => validateCensus(files, ["synthetic.txt"], () => Buffer.from("tampered")), /DIGEST_MISMATCH/);
  for (const name of ["../escape", "/escape", "a/../escape", "a\\escape"])
    assert.throws(() => validateCensus({ [name]: hash }, [name], () => Buffer.from("synthetic")), /PATH_ESCAPE/);
});

const native = (name) => ({
  path: `/usr/bin/${name}`,
  realTarget: `/usr/bin/${name}`,
  sha256: hash,
  format: "native",
  package: { name: `synthetic-${name}`, version: "1", architecture: "amd64" },
  distribution: {
    version: "1",
    architecture: "amd64",
    publicReference: "https://example.invalid/synthetic-distribution",
    archiveSha256: hash,
  },
});
const observed = (pin) => ({
  path: pin.path,
  realTarget: pin.realTarget,
  sha256: pin.sha256,
  format: pin.format,
  package: pin.package,
});
const pins = () => measurementConfig(fixtureMeasurementPayload());
const syntheticIdentity = (tools) => ({
  imageVersion: "20261107.1.0",
  imageOS: "ubuntu24",
  architecture: "x64",
  kernel: "synthetic-kernel",
  osRelease: 'VERSION_ID="24.04"\n',
  tools: Object.fromEntries(stockTools.map((name) => [name, observed(tools[name])])),
  versions: { node: "synthetic-version" },
  daemon: {
    unit: "synthetic-unit",
    server: { Os: "linux" },
    executable: observed(native("dockerd")),
    containerdExecutable: observed(native("containerd")),
  },
});

check("measurement requires full reviewed pins and prior inventory custody", () => {
  const config = pins();
  validateMeasurementPins(config);
  const e = envelope(fixtureMeasurementPayload());
  accept(e, "measurement");
  console.log(
    `SYNTHETIC D/F/R/C/S with complete reviewed measurement constants, real 448-file descriptor/census E=${bytes(e).length} bytes, limit=${maximumEnvelopeBytes}; no execution authority`,
  );
  const missing = fixtureMeasurementPayload();
  delete missing.publicInputs.measurement;
  assert.throws(() => accept(envelope(missing), "measurement"), /PINS_REQUIRED/);
  for (const field of [
    "bootstrapTools",
    "bootstrapIdentity",
    "expectedIdentity",
    "daemonTools",
    "inventoryAuthority",
    "tools",
    "runnerIdentity",
    "servicePins",
  ]) {
    const changed = clone(config);
    delete changed[field];
    assert.throws(() => validateMeasurementPins(changed));
  }
  for (const field of ["imageVersion", "imageOS", "kernel", "osReleaseSha256", "architecture"]) {
    const changed = clone(config);
    changed.expectedIdentity[field] = "UNKNOWN";
    assert.throws(() => validateMeasurementPins(changed));
  }
  const changed = clone(config);
  delete changed.tools.ip6tables;
  assert.throws(() => validateMeasurementPins(changed));
  const custody = clone(config);
  custody.inventoryAuthority.receiptSha256 = "UNKNOWN";
  assert.throws(() => validateMeasurementPins(custody));
  for (const name of ["engine", "containerd", "runc", "dockerInit"]) {
    const changed = clone(config);
    delete changed.runnerIdentity[name].version;
    assert.throws(() => validateMeasurementPins(changed), /IDENTITY_REQUIRED/);
  }
  const missingService = clone(config);
  delete missingService.servicePins.docker.sha256;
  assert.throws(() => validateMeasurementPins(missingService), /SERVICE_PINS_REQUIRED/);
});

check("OS daemon service package and tool drift fail before preparation", () => {
  const config = pins();
  const actual = syntheticIdentity(config.tools);
  const expected = identityFingerprint(actual);
  compareIdentity(expected, actual);
  for (const mutate of [
    (v) => (v.kernel = "drift"),
    (v) => (v.imageVersion = "drift"),
    (v) => (v.osRelease = "drift"),
    (v) => (v.daemon.server.Os = "drift"),
    (v) => (v.daemon.unit = "drift"),
    (v) => (v.daemon.executable.sha256 = "c".repeat(64)),
    (v) => (v.tools.git.package.version = "drift"),
    (v) => (v.tools.git.sha256 = "c".repeat(64)),
  ]) {
    const changed = clone(actual);
    mutate(changed);
    assert.throws(() => compareIdentity(expected, changed), /DRIFT/);
  }
});

check("genuine multicall invocation preserved; shims and interpreter drift refused", () => {
  const pin = {
    ...native("iptables"),
    realTarget: "/usr/sbin/xtables-nft-multi",
    multicall: true,
    invocation: "iptables",
  };
  validateToolObservation(pin, observed(pin));
  assert.deepEqual(invocation({ iptables: pin }, "iptables", ["--version"]), {
    executable: "/usr/bin/iptables",
    args: ["--version"],
  });
  assert.throws(() => validateToolObservation({ ...pin, multicall: false }, observed(pin)), /AUTHENTICATED/);
  assert.throws(() => validateToolObservation(pin, { ...observed(pin), realTarget: "/tmp/shim" }), /DRIFT_OR_SHIM/);
  assert.throws(() => validateToolObservation(pin, { ...observed(pin), format: "script" }), /DRIFT_OR_SHIM/);
  const script = {
    ...native("pnpm"),
    format: "script",
    interpreter: { tool: "node", shebang: "#!/usr/bin/env node" },
    distributionRoot: "/opt/synthetic-pnpm",
    closure: scriptClosureDescriptor,
  };
  const complete = JSON.parse(readFileSync(new URL("./pnpm-11.0.9.closure.json", import.meta.url)));
  const actual = { ...observed(script), shebang: script.interpreter.shebang, closure: complete };
  validateToolObservation(script, actual);
  assert.equal(invocation({ pnpm: script, node: native("node") }, "pnpm", ["--version"]).executable, "/usr/bin/node");
  for (const patch of [{ shebang: "#!/bin/sh" }, { closure: complete.slice(1) }])
    assert.throws(() => validateToolObservation(script, { ...actual, ...patch }), /DRIFT/);
});

check("complete canonical script closure, strict descriptor and census-bound sidecar", () => {
  const complete = JSON.parse(readFileSync(new URL("./pnpm-11.0.9.closure.json", import.meta.url)));
  assert.deepEqual(validateScriptClosure(complete, scriptClosureDescriptor, true), {
    fileCount: 448,
    sha256: "99aa5fa37093261917e32dfdaee917eafa784011e116e2d707ba55f33e0c15d5",
  });
  assert.deepEqual(scriptClosureFingerprint([...complete].reverse()), scriptClosureFingerprint(complete));
  assert.throws(() => validateScriptClosure([...complete].reverse(), scriptClosureDescriptor, true), /ORDER/);
  for (const change of [
    (v) => v.slice(1),
    (v) => [...v, ["extra-file", hash]],
    (v) => v.map((pair, i) => (i === 1 ? [pair[0], hash] : pair)),
    (v) => v.map((pair, i) => (i === 1 ? [`renamed-${pair[0]}`, pair[1]] : pair)),
  ])
    assert.throws(() => validateScriptClosure(change(clone(complete)), scriptClosureDescriptor), /DRIFT/);
  for (const pair of [
    ["../escape", hash],
    ["/absolute", hash],
    ["a//b", hash],
    ["a/./b", hash],
    ["a/../b", hash],
    ["a\\b", hash],
    ["a\u0000b", hash],
    ["a\nb", hash],
    ["a\u007fb", hash],
    ["", hash],
    ["valid", hash.toUpperCase()],
    ["valid", 7],
    ["valid"],
    ["valid", hash, "extra"],
  ])
    assert.throws(() => scriptClosureFingerprint([pair]));
  assert.throws(() => scriptClosureFingerprint([complete[0], complete[0]]), /PATH_OR_HASH/);
  for (const [key, value] of [
    ["algorithm", "sha512"],
    ["algorithm", "SHA-256"],
    ["algorithm", "unknown"],
    ["schema", "unknown"],
    ["canonicalization", "unknown"],
    ["fileCount", 447],
    ["fileCount", "448"],
    ["sha256", hash],
    ["path", "elsewhere.json"],
    ["extra", true],
  ])
    assert.throws(() => validateClosureDescriptor({ ...scriptClosureDescriptor, [key]: value }), /DESCRIPTOR/);
  for (const key of Object.keys(scriptClosureDescriptor)) {
    const changed = { ...scriptClosureDescriptor };
    delete changed[key];
    assert.throws(() => validateClosureDescriptor(changed), /DESCRIPTOR/);
  }
  const config = pins();
  const relative = scriptClosureDescriptor.path;
  const raw = readFileSync(new URL("./pnpm-11.0.9.closure.json", import.meta.url));
  validateScriptAuthority(config, () => raw);
  assert.throws(() => validateScriptAuthority(config, () => Buffer.concat([raw, Buffer.from(" ")])), /DIGEST/);
  const noCensus = clone(config);
  delete noCensus.files[relative];
  assert.throws(() => validateScriptAuthority(noCensus, () => raw), /CENSUS/);
  assert.throws(() =>
    validateScriptAuthority(config, () => {
      throw new Error("SYNTHETIC_UNREADABLE");
    }),
  );
  for (const list of [
    complete.slice(1),
    [...complete, ["extra", hash]],
    complete.map((pair, i) => (i === 1 ? [pair[0], hash] : pair)),
    [...complete].reverse(),
  ]) {
    const changedRaw = bytes(list);
    const changed = clone(config);
    changed.files[relative] = sha256(changedRaw);
    assert.throws(() => validateScriptAuthority(changed, () => changedRaw));
  }
  const changedTemplate = clone(config);
  changedTemplate.publicInputs.publicExecutables.pnpm.closure.algorithm = "sha512";
  assert.throws(() => validateScriptAuthority(changedTemplate, () => raw), /DESCRIPTOR/);
  const emptyIO = {
    realpathSync: (file) => file,
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readdirSync: () => [],
    readFileSync: () => {
      throw new Error("UNREACHABLE");
    },
  };
  assert.deepEqual(scriptDistribution("/synthetic", emptyIO), []);
  assert.throws(() => scriptDistribution("/synthetic", { ...emptyIO, realpathSync: () => "/elsewhere" }), /ESCAPE/);
  for (const type of ["symlink", "special", "escape", "unreadable"]) {
    const io = {
      ...emptyIO,
      readdirSync: () => [{ name: "member" }],
      realpathSync: (file) => (type === "escape" && file.endsWith("member") ? "/escape" : file),
      lstatSync: (file) => ({
        isDirectory: () => file === "/synthetic",
        isSymbolicLink: () => type === "symlink" && file !== "/synthetic",
        isFile: () => type !== "special",
      }),
      readFileSync: () => {
        throw new Error("SYNTHETIC_UNREADABLE");
      },
    };
    assert.throws(() => scriptDistribution("/synthetic", io));
  }
  assert.deepEqual(
    scanExposure([
      { file: "descriptor", text: JSON.stringify(scriptClosureDescriptor) },
      { file: "sidecar", text: raw.toString("utf8") },
    ]),
    [],
  );
  for (const value of [scriptClosureDescriptor, complete]) {
    assert(
      scanExposure([{ file: "synthetic", text: JSON.stringify([value, { token: "synthetic-marker-value" }]) }]).length >
        0,
    );
  }
});

check("one exact retained ConfigMap and complete approved-only normalization", () => {
  const data = { "error-log-path": "/dev/null", "ssl-redirect": "true" };
  const doc = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "ingress-nginx-controller", namespace: "ingress-nginx" },
    data,
  };
  const local = { ...data, "error-log-path": "/dev/stderr", "error-log-level": "info" };
  compareConfigMaps([doc], local);
  for (const docs of [
    [],
    [doc, doc],
    [null],
    [{ ...doc, kind: "Secret" }],
    [{ ...doc, apiVersion: "v2" }],
    [{ ...doc, metadata: { ...doc.metadata, namespace: "wrong" } }],
    [{ ...doc, metadata: { ...doc.metadata, name: "wrong" } }],
    [{ ...doc, data: null }],
  ])
    assert.throws(() => compareConfigMaps(docs, local));
  for (const changed of [
    { ...local, extra: "unexpected" },
    { "error-log-path": "/dev/stderr", "error-log-level": "info" },
    { ...local, "ssl-redirect": "false" },
    { ...local, "error-log-level": "warn" },
  ])
    assert.throws(() => compareConfigMaps([doc], changed));
  assert.equal(sha256(readFileSync(new URL("./retained-configmap.yaml", import.meta.url))), p.retainedConfigMapSha256);
});

check("typed zero-row inventory and private exposure gate cannot forge diagnostic PASS", () => {
  const receipt = {
    schema: "10678-inventory-receipt/v1",
    phase: "inventory",
    measurementDisposition: "NOT_EXECUTED",
    rowCount: 0,
    rows: [],
    complete: true,
    phases: ["inventoryStart", "inventoryComplete"],
  };
  const gate = {
    schema: "10678-inventory-publication/v1",
    phase: "inventory",
    publish: true,
    complete: true,
    scan: "NO_HITS",
    hits: [],
  };
  validateInventoryPublication(receipt, gate);
  for (const patch of [
    { phase: "measurement" },
    { rowCount: 1 },
    { rows: [{}] },
    { complete: false },
    { protocolStart: "never" },
    { armed: false },
    { phases: ["inventoryStart", "protocolStart", "inventoryComplete"] },
    { measurementDisposition: "PASS" },
  ])
    assert.throws(() => validateInventoryPublication({ ...receipt, ...patch }, gate));
  for (const patch of [
    { schema: 1 },
    { phase: "measurement" },
    { publish: false },
    { complete: false },
    { scan: "HITS" },
    { hits: [{ file: "synthetic", line: 1 }] },
  ]) {
    validateInventoryPublication(receipt, gate);
    assert.throws(
      () => validateInventoryPublication(receipt, { ...gate, ...patch }),
      (error) => {
        assert.equal(
          inventoryRefusal(error),
          "INVENTORY_REFUSED_MEASUREMENT_NOT_EXECUTED category=PRIVATE_INVENTORY_PUBLICATION_REFUSED",
        );
        return true;
      },
    );
  }
  assert.deepEqual(scanExposure([{ file: "synthetic.log", text: "cookie: synthetic-sensitive-value" }]), [
    { file: "synthetic.log", line: 1 },
  ]);
});

check("collector imports no runner or network client; workflow phase paths are exclusive", () => {
  const source = readFileSync(new URL("./inventory.mjs", import.meta.url), "utf8");
  assert(!/from\s+["'][^"']*(?:runner|https?|net|tls)[^"']*["']/.test(source));
  assert(!/\b(?:fetch|https?\.request|import\()\s*\(/.test(source));
  const workflow = readFileSync(
    new URL("../../../.github/workflows/ingress-nosend-diagnostic.yml", import.meta.url),
    "utf8",
  );
  assert(!workflow.includes("$GITHUB_WORKSPACE/scripts/test-support/10678-ingress-nosend/freeze.json"));
  for (const name of [
    "Prepare reviewed public prerequisites",
    "Prepare isolated diagnostic",
    "Measure fixed serial protocol",
  ]) {
    const section = workflow.slice(workflow.indexOf(`- name: ${name}`)).split(/\n      - /)[0];
    assert(section.includes("if: steps.authority.outputs.phase == 'measurement'"));
  }
  const inventory = workflow.slice(workflow.indexOf("- name: Collect read-only inventory")).split(/\n      - /)[0];
  assert(inventory.includes("phase == 'inventory'"));
  assert(!inventory.includes("runner.mjs"));
  assert(inventory.includes("inventory.mjs"));
});

console.log(`PASS ${groups} pure authority groups; no collector, harness, process, container or network execution`);
