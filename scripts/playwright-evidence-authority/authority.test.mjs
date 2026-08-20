import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCorpusMatches, assertProportionality, binaryPolicy, buildCorpusManifest, buildRelease,
  checkCorpus, checkGrammar, deriveGrammar, fixtureRoot, reconcileGrammarCorpus, resolveVendorSurface,
  sha256, stableJson, validateCorpusManifest, validateRelease, validateRuntimeWitness,
} from "./authority.mjs";
import { checkConsumerIndependence, recoverRegisteredValue, scanTrackedConsumers } from "./recovery-oracle.mjs";
import { resetTransaction, runTransaction, validateConformanceReceipt, validateTransactionReceipt, verifyTransactionHarness } from "./transaction.mjs";

const temporaryRoots = [];
const temporaryRoot = () => { const root = mkdtempSync(path.join(tmpdir(), "playwright-authority-test-")); temporaryRoots.push(root); return root; };
const clone = (value) => structuredClone(value);
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("proportional authority", () => {
  it("refuses an authority larger than its protected surface", () => {
    const denominatorFiles = [89, 30, 622, 343, 178, 409, 35].map((lines, index) => ({ file: `protected-${index}`, lines }));
    const receipt = { denominatorFiles, denominatorLines: 1706, authorityFiles: ["authority.mjs"], executableLines: 700, testLines: 800, fixtureLines: 206, measuredLines: 1706, binaryFixtureBytes: 1_500_000 };
    expect(assertProportionality(receipt)).toBe(receipt);
    expect(() => assertProportionality({ ...receipt, measuredLines: 1707 })).toThrow(/EXCEEDS/);
    const omitted = clone(receipt); delete omitted.denominatorLines;
    expect(() => assertProportionality(omitted)).toThrow(/SCHEMA/);
    expect(() => assertProportionality({ ...receipt, denominatorFiles: [{ ...denominatorFiles[0], nestedUnknown: true }, ...denominatorFiles.slice(1)] })).toThrow(/SCHEMA/);
  });
});

describe("vendor-derived grammar", () => {
  it("derives and partitions the complete Playwright 1.60 evidence grammar", () => {
    const grammar = deriveGrammar();
    expect(checkGrammar(grammar)).toEqual(grammar);
    expect(grammar.playwrightVersion).toBe("1.60.0");
    expect(grammar.defaultPartition).toBe("INDETERMINATE");
    expect(grammar.members.map(({ id }) => id)).toEqual([...grammar.members.map(({ id }) => id)].sort());
    expect(grammar.members.every(({ partition }) => ["HANDLED", "INDETERMINATE"].includes(partition))).toBe(true);
    expect(grammar.members.filter(({ id }) => id.startsWith("trace:")).map(({ id }) => id)).toContain("trace:screencast-frame");
    expect(grammar.members.filter(({ id }) => id.startsWith("reporter:")).map(({ id }) => id)).toEqual(expect.arrayContaining(["reporter:expected", "reporter:unexpected", "reporter:skipped", "reporter:timedOut", "reporter:interrupted"]));

    const vendor = resolveVendorSurface(), core = readFileSync(vendor.sources.coreBundle, "utf8");
    const planted = deriveGrammar({ sourceOverrides: { coreBundle: core.replace("_processedContextCreatedEvent()", 'case "synthetic-planted-upstream-member": break;\n_processedContextCreatedEvent()') } });
    expect(planted.members.find(({ id }) => id === "trace:synthetic-planted-upstream-member")?.partition).toBe("INDETERMINATE");
    expect(() => deriveGrammar({ sourceOverrides: { coreBundle: core.replaceAll("_processedContextCreatedEvent()", "anchor-removed()") } })).toThrow(/ANCHOR/);
    const missing = clone(grammar); missing.members.pop();
    expect(() => checkGrammar(missing)).toThrow(/STALE/);
  });

  it("keeps derivation byte-identical with ignored build output present", () => {
    const before = stableJson(deriveGrammar()), root = temporaryRoot();
    mkdirSync(path.join(root, "dist")); writeFileSync(path.join(root, "dist/coreBundle.js"), 'case "synthetic-build-only": break;');
    expect(stableJson(deriveGrammar())).toBe(before);
  });
});

describe("closed real corpus", () => {
  it("builds the complete real Playwright 1.60 retained-evidence corpus", () => {
    const manifest = checkCorpus(), grammar = checkGrammar();
    const captureConfig = readFileSync(new URL("./capture.config.ts", import.meta.url), "utf8");
    expect(captureConfig).not.toMatch(/from\s+["'][^"']*playwright\.config/);
    expect(captureConfig).not.toContain("webServer");
    expect(captureConfig).toMatch(/trace:\s*"on-first-retry"/);
    expect(captureConfig).toMatch(/outputDir:/);
    expect(reconcileGrammarCorpus(grammar, manifest)).toBe(true);
    expect(manifest.payloads.map(({ path: file }) => file)).toEqual(expect.arrayContaining([
      "capture/trace.zip", "capture/index.html", "capture/report.json", "capture/runtime-receipt.json",
      "capture/storage-state.json", "capture/font.woff2", "capture/opaque-body.bin", "capture/attachment.bin", "capture/rendered-value.png",
      "capture/video.webm", "corrupt-trace.zip", "declared-controls.json",
    ]));
    expect(manifest.payloads.find(({ path: file }) => file === "capture/trace.zip").referenceEdges.length).toBeGreaterThan(0);
    for (const limit of Object.values(manifest.limits)) {
      expect(limit.supportedMaximum).toBeGreaterThanOrEqual(limit.largestRequired);
      expect(limit.firstRefused).toBe(limit.supportedMaximum + 1);
    }
    expect(JSON.stringify(manifest)).not.toContain(`${"largest"}${"Valid"}`);

    const missing = clone(manifest); missing.payloads.pop();
    expect(() => assertCorpusMatches(missing, manifest)).toThrow(/STALE/);
    const duplicate = clone(manifest); duplicate.payloads.push(clone(duplicate.payloads[0]));
    expect(() => validateCorpusManifest(duplicate)).toThrow(/PATH_SET/);
    const relabeled = clone(manifest); relabeled.limits.nestingDepth[`${"largest"}${"Valid"}`] = relabeled.limits.nestingDepth.largestRequired; delete relabeled.limits.nestingDepth.largestRequired;
    expect(() => validateCorpusManifest(relabeled)).toThrow(/SCHEMA/);
    const stale = clone(manifest); stale.playwrightVersion = "1.59.0";
    expect(() => validateCorpusManifest(stale)).toThrow(/PROVENANCE/);
    const spoofed = clone(manifest); spoofed.payloads[0].digest = "0".repeat(64);
    expect(() => assertCorpusMatches(spoofed, manifest)).toThrow(/STALE/);
    const reverse = clone(grammar); reverse.members = reverse.members.filter(({ id }) => id !== "trace:screencast-frame");
    expect(() => reconcileGrammarCorpus(reverse, manifest)).toThrow(/RECONCILIATION/);
  });
});

describe("independent recovery authority", () => {
  it("recovers governing leaks independently of any sanitizer", () => {
    const value = "SYNTHETIC_R1_REGISTERED_VALUE_0123456789";
    const splitAtOne = value.indexOf("1"), nested = { a: { b: { c: { d: { e: { f: { value } } } } } } };
    const jsonl = `${JSON.stringify(value.slice(0, 13))}\n${JSON.stringify(value.slice(13))}`;
    const controls = [
      Buffer.from(value), Buffer.from(JSON.stringify({ value })), Buffer.from(encodeURIComponent(value)),
      Buffer.from(Buffer.from(value).toString("base64")), Buffer.from(Buffer.from(value).toString("base64url")),
      Buffer.from(value, "utf16le"), Buffer.from(JSON.stringify(nested)), Buffer.from(jsonl),
      Buffer.from(JSON.stringify({ chunks: [value.slice(0, splitAtOne), value.slice(splitAtOne + 1)], separator: 1 })),
      Buffer.from(Buffer.from(Buffer.from(value).toString("base64")).toString("base64")),
      ...[0, 1, 2].map((offset) => Buffer.from(`<div data-value="${Buffer.concat([Buffer.alloc(offset, 0x78), Buffer.from(value)]).toString("base64")}"></div>`)),
    ];
    for (const payload of controls) expect(recoverRegisteredValue({ registeredValue: value, payloads: [payload] }).status).toBe("HIT");
    const split = value.length / 2 | 0, deepChunks = { a: { b: { c: { chunks: [value.slice(0, split), value.slice(split)], separator: "" } } } };
    expect(recoverRegisteredValue({ registeredValue: value, payloads: [Buffer.from(JSON.stringify(deepChunks))], limits: { maxDepth: 2 } }).status).toBe("INDETERMINATE");
    expect(recoverRegisteredValue({ registeredValue: value, payloads: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], limits: { maxPayloads: 1 } }).status).toBe("INDETERMINATE");
    expect(recoverRegisteredValue({ registeredValue: value, payloads: [Buffer.from(value)], limits: { maxBytes: Buffer.byteLength(value) - 1 } }).status).toBe("INDETERMINATE");
    expect(recoverRegisteredValue({ registeredValue: value, payloads: [Buffer.from("synthetic-clear-control")] }).status).toBe("CLEAR");
  });

  it("exports a forward-facing black-box independence check", () => {
    expect(checkConsumerIndependence("export function candidate(bytes) { return bytes; }")).toEqual({ independent: true, violations: [] });
    expect(checkConsumerIndependence('import { recoverRegisteredValue } from "./recovery-oracle.mjs";').independent).toBe(false);
    expect(checkConsumerIndependence("const stringRepresentations = new Map();").violations).toContain("PREDECESSOR_TABLE");
    const scan = scanTrackedConsumers();
    expect(scan.scannedCandidates).toBeGreaterThan(0);
    expect(scan.totalCandidates).toBeGreaterThanOrEqual(scan.scannedCandidates);
    expect(scan.violations).toEqual([]);
  });
});

describe("observed witnesses", () => {
  it("observes runtime authority order from emitted events", () => {
    const receipt = JSON.parse(readFileSync(path.join(fixtureRoot, "capture/runtime-receipt.json"), "utf8"));
    expect(validateRuntimeWitness(receipt)).toEqual(receipt);
    const wrongOrder = clone(receipt); [wrongOrder.events[1], wrongOrder.events[2]] = [wrongOrder.events[2], wrongOrder.events[1]];
    expect(() => validateRuntimeWitness(wrongOrder)).toThrow(/ORDER/);
    const asserted = clone(receipt); asserted.events[0].digest = "0".repeat(64);
    expect(() => validateRuntimeWitness(asserted)).toThrow(/EVENT/);
    expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_REGISTERED_PROBE_VALUE");
  });

  it("observes residue after every protocol failure", () => {
    const root = temporaryRoot(), source = path.join(root, "source"), transactions = path.join(root, "transactions");
    mkdirSync(source); writeFileSync(path.join(source, "a.bin"), Buffer.from([0, 1, 2])); writeFileSync(path.join(source, "b.txt"), "opaque evidence");
    const receipt = verifyTransactionHarness({ source, transactionRoot: transactions });
    expect(receipt.observations).toHaveLength(8);
    for (const row of receipt.observations.filter(({ inject }) => !["none", "post-commit"].includes(inject))) expect(Object.values(row.census).flatMap(Object.values).every((value) => value === 0)).toBe(true);
    const dateOnly = clone(receipt); dateOnly.observedAt = "2026-08-20";
    expect(() => validateConformanceReceipt(dateOnly)).toThrow(/BOUNDS/);
    const nestedUnknown = clone(receipt); nestedUnknown.observations[0].surprise = true;
    expect(() => validateConformanceReceipt(nestedUnknown)).toThrow(/OPEN/);
  });
});

describe("candidate-neutral publication", () => {
  it("enforces one transaction commit boundary without transforming content", () => {
    const root = temporaryRoot(), source = path.join(root, "source"), transactions = path.join(root, "transactions");
    mkdirSync(source); writeFileSync(path.join(source, "payload.bin"), Buffer.from([9, 8, 7, 0, 255]));
    const result = runTransaction({ source, transactionRoot: transactions });
    expect(result.status).toBe("PUBLISHED");
    const destination = path.join(transactions, "published-authority");
    expect(readFileSync(path.join(destination, "payload.bin"))).toEqual(readFileSync(path.join(source, "payload.bin")));
    const receipt = JSON.parse(readFileSync(path.join(destination, "transaction-receipt.json"), "utf8"));
    expect(validateTransactionReceipt(receipt)).toEqual(receipt);
    expect(() => validateTransactionReceipt({ ...receipt, timings: { elapsedMs: 60_001 } })).toThrow(/BOUNDS/);
    const sourceCode = readFileSync(new URL("./transaction.mjs", import.meta.url), "utf8");
    expect(sourceCode.match(/renameSync\(/g)).toHaveLength(1);
    expect(sourceCode.slice(sourceCode.indexOf("renameSync(staging, destination)"), sourceCode.indexOf("return { status: \"PUBLISHED\""))).not.toContain("writeFileSync");
    expect(resetTransaction({ transactionRoot: transactions })).toEqual({ staging: 0, destination: 0, receipt: 0, uploadEligible: 0, registry: 0 });
  });

  it("releases the closed seven-class binary policy table", () => {
    const policy = binaryPolicy();
    expect(Object.keys(policy.rows).sort()).toEqual(["attachment", "opaque-body", "rendered-value", "screenshot", "unknown-dangling-reference", "video-screencast", "woff2"]);
    for (const row of Object.values(policy.rows)) expect(Object.keys(row).sort()).toEqual(["bytes", "digest", "magic", "mime", "recoverability", "referenceEdges"]);
    expect(JSON.stringify(policy)).not.toMatch(/safeMechanism|sanitizer|selected|none/);
    const release = buildRelease(), deleted = clone(release); delete deleted.binaryPolicy.rows["video-screencast"];
    expect(() => validateRelease(deleted)).toThrow();
  });

  it("closes release schemas and refuses unbound or stale heads", () => {
    const release = buildRelease();
    expect(validateRelease(release)).toEqual(release);
    expect(() => validateRelease(release, { expectedHead: "[AUTHORITY_HEAD]" })).toThrow(/HEAD/);
    expect(() => validateRelease(release, { expectedHead: "0".repeat(40) })).toThrow(/HEAD/);
    expect(() => validateRelease(release, { requireIndependentPass: true })).toThrow(/REVIEW/);
    const nestedUnknown = clone(release); nestedUnknown.binaryPolicy.rows.woff2.surprise = true;
    expect(() => validateRelease(nestedUnknown)).toThrow();
    const dateOnly = clone(release); dateOnly.releasedAt = "2026-08-20";
    expect(() => validateRelease(dateOnly)).toThrow(/HEAD_BINDING/);
    const outOfRange = clone(release); outOfRange.proportionality.measuredLines = 1707;
    expect(() => validateRelease(outOfRange)).toThrow(/EXCEEDS/);
  });
});
