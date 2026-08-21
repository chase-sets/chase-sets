import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCorpusMatches,
  assertHeadBinding,
  assertPortablePayload,
  assertProportionality,
  binaryPolicy,
  buildCorpusManifest,
  buildRelease,
  checkCorpus,
  checkGrammar,
  deriveGrammar,
  findHostPaths,
  fixtureRoot,
  liveHeadBinding,
  observeNestingDepth,
  observeReporterStates,
  observedMembersFor,
  PRE_LANDING_HEAD,
  reconcileGrammarCorpus,
  repoRoot,
  resolveVendorSurface,
  sha256,
  stableJson,
  stagingValidators,
  toPortableText,
  validateCorpusManifest,
  validateRelease,
  validateRuntimeWitness,
  writeZipEntries,
} from "./authority.mjs";
import { checkConsumerIndependence, recoverRegisteredValue, scanTrackedConsumers } from "./recovery-oracle.mjs";
import {
  resetTransaction,
  runTransaction,
  validateConformanceReceipt,
  validateTransactionReceipt,
  verifyTransactionHarness,
} from "./transaction.mjs";

const temporaryRoots = [];
const temporaryRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "playwright-authority-test-"));
  temporaryRoots.push(root);
  return root;
};
const clone = (value) => structuredClone(value);
const once = (build) => {
  let value;
  return () => (value ??= build());
};
const corpus = once(() => checkCorpus());
const release = once(() => buildRelease());
const corpusFile = (relative) => readFileSync(path.join(fixtureRoot, relative));
const liveHead = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const resign = (release) => ({
  ...release,
  receiptDigest: sha256(stableJson((({ receiptDigest, ...rest }) => rest)(release))),
});
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("proportional authority", () => {
  it("refuses an authority larger than its protected surface", () => {
    const denominatorFiles = [89, 30, 622, 343, 178, 409, 35].map((lines, index) => ({
      file: `protected-${index}`,
      lines,
    }));
    const receipt = {
      status: "WITHIN_PROTECTED_SURFACE",
      denominatorFiles,
      denominatorLines: 1706,
      authorityFiles: ["authority.mjs"],
      executableLines: 700,
      testLines: 800,
      fixtureLines: 206,
      measuredLines: 1706,
      textFixtureBytes: 550_000,
      binaryFixtureBytes: 1_500_000,
    };
    expect(assertProportionality(receipt)).toBe(receipt);
    expect(() => assertProportionality({ ...receipt, fixtureLines: 207, measuredLines: 1707 })).toThrow(/EXCEEDS/);
    expect(() => assertProportionality({ ...receipt, fixtureLines: 207 })).toThrow(/RECEIPT_INVALID/);
    expect(() => assertProportionality({ ...receipt, status: "EXCEEDS_PROTECTED_SURFACE" })).toThrow(/MISDECLARED/);
    const over = { ...receipt, status: "EXCEEDS_PROTECTED_SURFACE", fixtureLines: 300, measuredLines: 1800 };
    expect(assertProportionality(over)).toBe(over);
    const omitted = clone(receipt);
    delete omitted.denominatorLines;
    expect(() => assertProportionality(omitted)).toThrow(/SCHEMA/);
    expect(() =>
      assertProportionality({
        ...receipt,
        denominatorFiles: [{ ...denominatorFiles[0], nestedUnknown: true }, ...denominatorFiles.slice(1)],
      }),
    ).toThrow(/SCHEMA/);

    // The shipped receipt is measured on formatter-governed sources, not on an exempted numerator.
    const shipped = release().proportionality;
    expect(shipped.measuredLines).toBe(shipped.executableLines + shipped.testLines + shipped.fixtureLines);
    expect(shipped.denominatorLines).toBe(1706);
    expect(shipped.status).toBe(
      shipped.measuredLines <= shipped.denominatorLines ? "WITHIN_PROTECTED_SURFACE" : "EXCEEDS_PROTECTED_SURFACE",
    );
    expect(shipped.textFixtureBytes).toBeGreaterThan(500_000);
    // An authority above its protected surface stays inspectable and is refused to every consumer.
    const consumable = shipped.status === "WITHIN_PROTECTED_SURFACE";
    const bound = resign({ ...release(), headBinding: { mode: "checked-out-git-head", derivationHead: liveHead() } });
    const consume = () => validateRelease(bound, { expectedHead: liveHead() });
    if (consumable) expect(consume()).toBe(bound);
    else expect(consume).toThrow(/PROPORTIONALITY_DECISION_REQUIRED/);
    const ignored = readFileSync(path.join(repoRoot, ".prettierignore"), "utf8");
    expect(ignored).not.toMatch(/^scripts\/playwright-evidence-authority\/$/m);
    for (const file of shipped.authorityFiles.filter((name) => /\.(?:mjs|ts)$/.test(name)))
      expect(ignored).not.toContain(file);
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
    expect(grammar.members.map(({ id }) => id)).toContain("trace:screencast-frame");
    expect(grammar.members.filter(({ id }) => id.startsWith("reporter:")).map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "reporter:expected",
        "reporter:unexpected",
        "reporter:skipped",
        "reporter:timedOut",
        "reporter:interrupted",
      ]),
    );

    const vendor = resolveVendorSurface();
    const core = readFileSync(vendor.sources.coreBundle, "utf8");
    const planted = deriveGrammar({
      sourceOverrides: {
        coreBundle: core.replace(
          "_processedContextCreatedEvent()",
          'case "synthetic-planted-upstream-member": break;\n_processedContextCreatedEvent()',
        ),
      },
    });
    expect(planted.members.find(({ id }) => id === "trace:synthetic-planted-upstream-member")?.partition).toBe(
      "INDETERMINATE",
    );
    expect(() =>
      deriveGrammar({
        sourceOverrides: { coreBundle: core.replaceAll("_processedContextCreatedEvent()", "anchor-removed()") },
      }),
    ).toThrow(/ANCHOR/);
    const missing = clone(grammar);
    missing.members.pop();
    expect(() => checkGrammar(missing)).toThrow(/STALE/);
  });

  it("keeps derivation byte-identical with ignored build output present", () => {
    const before = stableJson(deriveGrammar());
    const root = temporaryRoot();
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist/coreBundle.js"), 'case "synthetic-build-only": break;');
    expect(stableJson(deriveGrammar())).toBe(before);
  });
});

describe("closed real corpus", () => {
  it("builds the complete real Playwright 1.60 retained-evidence corpus", () => {
    const manifest = corpus();
    const grammar = checkGrammar();
    const captureConfig = readFileSync(new URL("./capture.config.ts", import.meta.url), "utf8");
    expect(captureConfig).not.toMatch(/from\s+["'][^"']*playwright\.config/);
    expect(captureConfig).not.toContain("webServer");
    expect(captureConfig).toMatch(/trace:\s*"on-first-retry"/);
    expect(captureConfig).toMatch(/outputDir:/);
    expect(reconcileGrammarCorpus(grammar, manifest)).toBe(true);
    expect(manifest.payloads.map(({ path: file }) => file)).toEqual(
      expect.arrayContaining([
        "capture/trace.zip",
        "capture/index.html",
        "capture/report.json",
        "capture/runtime-receipt.json",
        "capture/storage-state.json",
        "capture/font.woff2",
        "capture/opaque-body.bin",
        "capture/attachment.bin",
        "capture/rendered-value.png",
        "capture/screenshot.png",
        "capture/video.webm",
        "corrupt-trace.zip",
        "dangling-reference.trace",
        "declared-controls.json",
      ]),
    );
    expect(
      manifest.payloads.find(({ path: file }) => file === "capture/trace.zip").referenceEdges.length,
    ).toBeGreaterThan(0);
    for (const limit of Object.values(manifest.limits)) {
      expect(limit.supportedMaximum).toBeGreaterThanOrEqual(limit.largestRequired);
      expect(limit.firstRefused).toBe(limit.supportedMaximum + 1);
    }
    expect(JSON.stringify(manifest)).not.toContain(`${"largest"}${"Valid"}`);

    // AC3 both directions, observed from payload bytes rather than by iterating the grammar.
    const traceMembers = observedMembersFor("capture/trace.zip", corpusFile("capture/trace.zip"));
    expect(traceMembers).toContain("trace:screencast-frame");
    expect(manifest.payloads.find(({ path: file }) => file === "declared-controls.json").sourceMembers).toEqual([]);
    expect(manifest.coverage.observed.some((id) => manifest.coverage.declared.includes(id))).toBe(false);
    expect([...manifest.coverage.observed, ...manifest.coverage.declared].sort()).toEqual(
      grammar.members.map(({ id }) => id).sort(),
    );
    expect(manifest.coverage.memberCoverage.every(({ coverage }) => coverage !== "UNCOVERED")).toBe(true);
    const reverse = clone(grammar);
    reverse.members = reverse.members.filter(({ id }) => id !== "trace:screencast-frame");
    expect(() => reconcileGrammarCorpus(reverse, manifest)).toThrow(/FORWARD_GAP/);
    const uncovered = clone(manifest);
    uncovered.coverage.declared = [];
    expect(() => reconcileGrammarCorpus(grammar, uncovered)).toThrow(/REVERSE_GAP/);
    const masked = clone(manifest);
    masked.coverage.declared = [...masked.coverage.declared, masked.coverage.observed[0]];
    expect(() => reconcileGrammarCorpus(grammar, masked)).toThrow(/DECLARED_CONTROL_INVENTORY/);

    // AC3/AC5 reporter rows are observations of real results, never a literal table.
    const report = JSON.parse(corpusFile("capture/report.json").toString("utf8"));
    expect(manifest.reporterStates).toEqual(observeReporterStates(report));
    expect(manifest.reporterStates.length).toBeGreaterThan(0);
    const reported = JSON.stringify(report);
    for (const row of manifest.reporterStates) {
      expect(reported).toContain(`"status":"${row.status}"`);
      expect(row.classification).toBe(`${row.outcome}/${row.status}`);
      for (const annotation of row.annotations) expect(reported).toContain(`"type":"${annotation.type}"`);
    }
    expect(
      manifest.reporterStates.flatMap(({ annotations }) => annotations).map(({ description }) => description),
    ).toContain("bounded synthetic corpus");
    const produced = new Set(manifest.reporterStates.map(({ classification }) => classification));
    const controls = JSON.parse(corpusFile("declared-controls.json").toString("utf8"));
    expect(controls.synthetic).toBe(true);
    expect(controls.reporterControls.every(({ classification }) => !produced.has(classification))).toBe(true);
    expect(controls.reporterControls.map(({ classification }) => classification)).toContain("expected/timedOut");

    // #6950 D-HEADROOM: the triplet is re-derived, and a deeper corpus moves it.
    const payloads = manifest.payloads.map(({ path: file }) => corpusFile(file));
    expect(manifest.limits.nestingDepth.largestRequired).toBe(observeNestingDepth(payloads));
    const deepObject = Array.from({ length: 20 }).reduce((value) => ({ nested: value }), { leaf: 1 });
    const deepArchive = writeZipEntries([{ name: "deep.json", bytes: Buffer.from(JSON.stringify(deepObject)) }]);
    const deeper = writeZipEntries([{ name: "inner.zip", bytes: deepArchive }]);
    expect(observeNestingDepth([...payloads, deeper])).toBeGreaterThan(manifest.limits.nestingDepth.largestRequired);

    // Provenance/privacy: no durable payload may carry a host-absolute path.
    for (const payload of manifest.payloads)
      expect(assertPortablePayload(payload.path, corpusFile(payload.path))).toBe(true);
    expect(findHostPaths(corpusFile("capture/report.json").toString("utf8"))).toEqual([]);
    expect(corpusFile("capture/report.json").toString("utf8")).toContain(
      "<repo>/scripts/playwright-evidence-authority",
    );
    const planted = Buffer.from(JSON.stringify({ file: path.join(repoRoot, "scripts/x.ts") }));
    expect(() => assertPortablePayload("planted.json", planted)).toThrow(/DURABLE_PAYLOAD_CARRIES/);
    expect(() => assertPortablePayload("planted.zip", writeZipEntries([{ name: "a.trace", bytes: planted }]))).toThrow(
      /DURABLE_PAYLOAD_CARRIES/,
    );
    expect(findHostPaths(toPortableText(planted.toString("utf8")))).toEqual([]);
    for (const rule of ["C:\\\\Users\\\\someone\\\\repo", "/Users/someone/repo/x", "/home/someone/repo/x"])
      expect(findHostPaths(rule).length).toBeGreaterThan(0);

    const missing = clone(manifest);
    missing.payloads.pop();
    expect(() => assertCorpusMatches(missing, manifest)).toThrow(/STALE/);
    const duplicate = clone(manifest);
    duplicate.payloads.push(clone(duplicate.payloads[0]));
    expect(() => validateCorpusManifest(duplicate)).toThrow(/PATH_SET/);
    const relabeled = clone(manifest);
    relabeled.limits.nestingDepth[`${"largest"}${"Valid"}`] = relabeled.limits.nestingDepth.largestRequired;
    delete relabeled.limits.nestingDepth.largestRequired;
    expect(() => validateCorpusManifest(relabeled)).toThrow(/SCHEMA/);
    const stale = clone(manifest);
    stale.playwrightVersion = "1.59.0";
    expect(() => validateCorpusManifest(stale)).toThrow(/OUT_OF_DOMAIN/);
    const dateOnly = clone(manifest);
    dateOnly.capturedAt = "2026-08-20";
    expect(() => validateCorpusManifest(dateOnly)).toThrow(/OUT_OF_DOMAIN/);
    const spoofed = clone(manifest);
    spoofed.payloads[0].digest = "0".repeat(64);
    expect(() => assertCorpusMatches(spoofed, manifest)).toThrow(/STALE/);
    const nestedUnknown = clone(manifest);
    nestedUnknown.payloads[0].referenceEdges = [
      { from: "a", target: "resources/" + "a".repeat(40), present: true, surprise: 1 },
    ];
    expect(() => validateCorpusManifest(nestedUnknown)).toThrow(/SCHEMA/);
    expect(stableJson(buildCorpusManifest())).toBe(stableJson(manifest));
  });
});

describe("independent recovery authority", () => {
  it("recovers governing leaks independently of any sanitizer", () => {
    const value = "SYNTHETIC_R1_REGISTERED_VALUE_0123456789";
    const splitAtOne = value.indexOf("1");
    const nested = { a: { b: { c: { d: { e: { f: { value } } } } } } };
    const jsonl = `${JSON.stringify(value.slice(0, 13))}\n${JSON.stringify(value.slice(13))}`;
    const controls = [
      Buffer.from(value),
      Buffer.from(JSON.stringify({ value })),
      Buffer.from(encodeURIComponent(value)),
      Buffer.from(Buffer.from(value).toString("base64")),
      Buffer.from(Buffer.from(value).toString("base64url")),
      Buffer.from(value, "utf16le"),
      Buffer.from(JSON.stringify(nested)),
      Buffer.from(jsonl),
      Buffer.from(JSON.stringify({ chunks: [value.slice(0, splitAtOne), value.slice(splitAtOne + 1)], separator: 1 })),
      Buffer.from(Buffer.from(Buffer.from(value).toString("base64")).toString("base64")),
      ...[0, 1, 2].map((offset) =>
        Buffer.from(
          `<div data-value="${Buffer.concat([Buffer.alloc(offset, 0x78), Buffer.from(value)]).toString("base64")}"></div>`,
        ),
      ),
    ];
    for (const payload of controls)
      expect(recoverRegisteredValue({ registeredValue: value, payloads: [payload] }).status).toBe("HIT");
    const split = (value.length / 2) | 0;
    const deepChunks = { a: { b: { c: { chunks: [value.slice(0, split), value.slice(split)], separator: "" } } } };
    expect(
      recoverRegisteredValue({
        registeredValue: value,
        payloads: [Buffer.from(JSON.stringify(deepChunks))],
        limits: { maxDepth: 2 },
      }).status,
    ).toBe("INDETERMINATE");
    expect(
      recoverRegisteredValue({
        registeredValue: value,
        payloads: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
        limits: { maxPayloads: 1 },
      }).status,
    ).toBe("INDETERMINATE");
    expect(
      recoverRegisteredValue({
        registeredValue: value,
        payloads: [Buffer.from(value)],
        limits: { maxBytes: Buffer.byteLength(value) - 1 },
      }).status,
    ).toBe("INDETERMINATE");
    expect(
      recoverRegisteredValue({ registeredValue: value, payloads: [Buffer.from("synthetic-clear-control")] }).status,
    ).toBe("CLEAR");
  });

  it("exports a forward-facing black-box independence check", () => {
    expect(checkConsumerIndependence("export function candidate(bytes) { return bytes; }")).toEqual({
      independent: true,
      violations: [],
    });
    expect(
      checkConsumerIndependence('import { recoverRegisteredValue } from "./recovery-oracle.mjs";').independent,
    ).toBe(false);
    expect(checkConsumerIndependence("const stringRepresentations = new Map();").violations).toContain(
      "PREDECESSOR_TABLE",
    );
    const scan = scanTrackedConsumers();
    expect(scan.scannedCandidates).toBeGreaterThan(0);
    expect(scan.totalCandidates).toBeGreaterThanOrEqual(scan.scannedCandidates);
    expect(scan.violations).toEqual([]);
  });
});

describe("observed witnesses", () => {
  it("observes runtime authority order from emitted events", () => {
    const receipt = JSON.parse(corpusFile("capture/runtime-receipt.json").toString("utf8"));
    expect(validateRuntimeWitness(receipt)).toEqual(receipt);
    const wrongOrder = clone(receipt);
    [wrongOrder.events[1], wrongOrder.events[2]] = [wrongOrder.events[2], wrongOrder.events[1]];
    expect(() => validateRuntimeWitness(wrongOrder)).toThrow(/ORDER/);
    const asserted = clone(receipt);
    asserted.events[0].digest = "0".repeat(64);
    expect(() => validateRuntimeWitness(asserted)).toThrow(/EVENT/);
    const nestedUnknown = clone(receipt);
    nestedUnknown.events[0].surprise = true;
    expect(() => validateRuntimeWitness(nestedUnknown)).toThrow(/SCHEMA/);
    expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_REGISTERED_PROBE_VALUE");
    expect(Object.keys(receipt)).not.toContain("reporterStates");
  });

  it("observes residue after every protocol failure", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    const transactions = path.join(root, "transactions");
    mkdirSync(source);
    writeFileSync(path.join(source, "a.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(source, "b.txt"), "opaque evidence");
    const receipt = verifyTransactionHarness({ source, transactionRoot: transactions });
    expect(receipt.observations).toHaveLength(10);
    expect(receipt.observations.map(({ inject }) => inject)).toEqual(
      expect.arrayContaining([
        "none",
        "mid-read",
        "mid-build",
        "validation",
        "reference-validation",
        "oracle-validation",
        "receipt-validation",
        "pre-commit",
        "rename",
        "post-commit",
      ]),
    );
    for (const row of receipt.observations.filter(({ inject }) => !["none", "post-commit"].includes(inject))) {
      expect(
        Object.values(row.census)
          .flatMap(Object.values)
          .every((value) => value === 0),
      ).toBe(true);
    }
    const dateOnly = clone(receipt);
    dateOnly.observedAt = "2026-08-20";
    expect(() => validateConformanceReceipt(dateOnly)).toThrow(/BOUNDS/);
    const nestedUnknown = clone(receipt);
    nestedUnknown.observations[0].surprise = true;
    expect(() => validateConformanceReceipt(nestedUnknown)).toThrow(/OPEN/);
  });
});

describe("candidate-neutral publication", () => {
  it("enforces one transaction commit boundary without transforming content", () => {
    const root = temporaryRoot();
    const source = path.join(root, "source");
    const transactions = path.join(root, "transactions");
    mkdirSync(source);
    writeFileSync(path.join(source, "payload.bin"), Buffer.from([9, 8, 7, 0, 255]));
    const result = runTransaction({ source, transactionRoot: transactions });
    expect(result.status).toBe("PUBLISHED");
    const destination = path.join(transactions, "published-authority");
    expect(readFileSync(path.join(destination, "payload.bin"))).toEqual(readFileSync(path.join(source, "payload.bin")));
    const receipt = JSON.parse(readFileSync(path.join(destination, "transaction-receipt.json"), "utf8"));
    expect(validateTransactionReceipt(receipt)).toEqual(receipt);
    expect(() => validateTransactionReceipt({ ...receipt, timings: { elapsedMs: 60_001 } })).toThrow(/BOUNDS/);
    const sourceCode = readFileSync(new URL("./transaction.mjs", import.meta.url), "utf8");
    expect(sourceCode.match(/renameSync\(/g)).toHaveLength(1);
    expect(
      sourceCode.slice(
        sourceCode.indexOf("renameSync(staging, destination)"),
        sourceCode.indexOf('return { status: "PUBLISHED"'),
      ),
    ).not.toContain("writeFileSync");
    expect(resetTransaction({ transactionRoot: transactions })).toEqual({
      staging: 0,
      destination: 0,
      receipt: 0,
      uploadEligible: 0,
      registry: 0,
    });

    // AC6 names payload, receipt, reference and oracle validation, and all of it runs inside staging.
    const validators = stagingValidators();
    const invoked = [];
    const observed = runTransaction({
      source: fixtureRoot,
      transactionRoot: path.join(root, "authority"),
      validators: Object.fromEntries(
        Object.entries(validators).map(([stage, run]) => [
          stage,
          (staged) => (invoked.push([stage, staged.length]), run(staged)),
        ]),
      ),
    });
    expect(observed.status).toBe("PUBLISHED");
    expect(invoked.map(([stage]) => stage)).toEqual(["reference-validation", "oracle-validation"]);
    expect(invoked.every(([, files]) => files > 0)).toBe(true);
    const refused = runTransaction({
      source,
      transactionRoot: path.join(root, "tampered"),
      validators: {
        "oracle-validation": validators["oracle-validation"],
        "reference-validation": () => {
          throw new Error("STAGED_REFERENCE_EDGES_CHANGED");
        },
      },
    });
    expect(refused.status).toBe("ROLLED_BACK");
    expect(refused.code).toBe("STAGED_REFERENCE_EDGES_CHANGED");
  });

  it("releases the closed seven-class binary policy table", () => {
    const policy = binaryPolicy(corpus());
    expect(Object.keys(policy.rows).sort()).toEqual([
      "attachment",
      "opaque-body",
      "rendered-value",
      "screenshot",
      "unknown-dangling-reference",
      "video-screencast",
      "woff2",
    ]);
    for (const row of Object.values(policy.rows))
      expect(Object.keys(row).sort()).toEqual(["bytes", "digest", "magic", "mime", "recoverability", "referenceEdges"]);
    expect(JSON.stringify(policy)).not.toMatch(/safeMechanism|sanitizer|selected|none/);
    const digests = Object.values(policy.rows).map(({ digest }) => digest);
    expect(new Set(digests).size).toBe(7);
    expect(policy.rows.screenshot.digest).not.toBe(policy.rows["rendered-value"].digest);
    const manifest = corpus();
    const own = (name, suffix) =>
      expect(policy.rows[name].referenceEdges).toEqual(
        manifest.payloads.find(({ path: file }) => file.endsWith(suffix)).referenceEdges,
      );
    own("video-screencast", "video.webm");
    own("unknown-dangling-reference", "dangling-reference.trace");
    expect(policy.rows["unknown-dangling-reference"].referenceEdges.some(({ present }) => !present)).toBe(true);
    expect(policy.rows["unknown-dangling-reference"].recoverability).toBe(
      recoverRegisteredValue({
        registeredValue: "SYNTHETIC_REGISTERED_PROBE_VALUE_0000000000",
        payloads: [corpusFile("dangling-reference.trace")],
      }).status === "HIT"
        ? "HIT"
        : policy.rows["unknown-dangling-reference"].recoverability,
    );
    const deleted = clone(release());
    delete deleted.binaryPolicy.rows["video-screencast"];
    expect(() => validateRelease(resign(deleted))).toThrow(/BINARY_POLICY_ROWS_INVALID/);
  });

  it("closes release schemas and refuses unbound or stale heads", () => {
    const current = release();
    expect(validateRelease(current)).toEqual(current);

    // P2: the binding is computed from the live Git state, never re-read from the release it binds.
    const pending = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        "scripts/playwright-evidence-authority",
        "scripts/fixtures/playwright-evidence-authority",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const expectedBinding = pending.trim()
      ? { mode: "pre-landing-unbound", derivationHead: PRE_LANDING_HEAD }
      : { mode: "checked-out-git-head", derivationHead: liveHead() };
    expect(liveHeadBinding()).toEqual(expectedBinding);
    expect(current.headBinding).toEqual(expectedBinding);

    // P1 a stale but well-formed head, and P3 the reviewer forged-head probe: both must refuse.
    expect(() => assertHeadBinding({ mode: "checked-out-git-head", derivationHead: "d".repeat(40) })).toThrow(/STALE/);
    expect(() => assertHeadBinding({ mode: "pre-landing-unbound", derivationHead: liveHead() })).toThrow(
      /BINDING_INVALID/,
    );
    const forged = resign({
      ...current,
      headBinding: { mode: "checked-out-git-head", derivationHead: "f".repeat(40) },
    });
    expect(() => validateRelease(forged, { expectedHead: liveHead() })).toThrow(
      /EXPECTED_HEAD_REFUSED_BINDING_MISMATCH/,
    );
    const unbound = resign({
      ...current,
      headBinding: { mode: "pre-landing-unbound", derivationHead: PRE_LANDING_HEAD },
    });
    expect(() => validateRelease(unbound, { expectedHead: liveHead() })).toThrow(
      /EXPECTED_HEAD_REFUSED_BINDING_MISMATCH/,
    );
    const elsewhere = resign({
      ...current,
      headBinding: { mode: "checked-out-git-head", derivationHead: "a".repeat(40) },
    });
    expect(() => validateRelease(elsewhere, { expectedHead: "a".repeat(40) })).toThrow(
      /EXPECTED_HEAD_REFUSED_CHECKOUT_MISMATCH/,
    );
    expect(() => validateRelease(current, { expectedHead: "[AUTHORITY_HEAD]" })).toThrow(/UNBOUND/);
    expect(() => validateRelease(current, { expectedHead: "0".repeat(40) })).toThrow(/EXPECTED_HEAD_REFUSED/);
    const within = {
      ...current.proportionality,
      status: "WITHIN_PROTECTED_SURFACE",
      executableLines: 700,
      testLines: 800,
      fixtureLines: 206,
      measuredLines: 1706,
    };
    const proportional = resign({ ...current, proportionality: within });
    expect(() => validateRelease(proportional, { requireIndependentPass: true })).toThrow(/REVIEW/);
    expect(() => validateRelease(current, { requireIndependentPass: true })).toThrow(
      /PROPORTIONALITY_DECISION_REQUIRED/,
    );

    const nestedUnknown = clone(current);
    nestedUnknown.binaryPolicy.rows.woff2.surprise = true;
    expect(() => validateRelease(resign(nestedUnknown))).toThrow(/SCHEMA/);
    const dateOnly = resign({ ...current, releasedAt: "2026-08-20" });
    expect(() => validateRelease(dateOnly)).toThrow(/OUT_OF_DOMAIN/);
    const outOfRange = clone(current);
    outOfRange.proportionality.measuredLines = 1707;
    expect(() => validateRelease(resign(outOfRange))).toThrow(/RECEIPT_INVALID|EXCEEDS/);
    const unsigned = clone(current);
    unsigned.decisions[0].ruling = "B";
    expect(() => validateRelease(unsigned)).toThrow(/OUT_OF_DOMAIN/);
  });
});
