import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  aggregateCap,
  caps,
  checkpointNames,
  journeyPackageTarget,
  knownLocatorFor,
  packageRoot,
  rawRoot,
  recordDirectory,
  stagingRoot,
  timelineAttachmentName,
} from "./lib/journey-package-contract.mjs";
import {
  checkoutGit,
  checkpointWidths,
  completeTimeline,
  encodePng,
  identityEnv,
  padPng,
  pngChunk,
  pngSignature,
  ihdr,
  scanPackageForWitnesses,
  scanlines,
  witnesses,
} from "./fixtures/journey-package/support.mjs";
import { rawPlaywrightRoots, scanPlaywrightArtifactUploads } from "./playwright-artifact-upload-fence.mjs";
import { inspectJourneyPackage, journeyPackageStep } from "./prepare-journey-package.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const packagerPath = path.join(repoRoot, "scripts/prepare-journey-package.mjs");
const title = "market-following consent, held evidence and permanent stop @marketplace-account";
// A repository-shaped spec path that is never the contract target.
const notTheTarget = "deployables/marketplace/e2e/not-the-journey-package-target.spec.ts";
const timelineStart = Date.parse("2026-11-01T10:00:00.000Z");
const attachedLater = "2026-11-01T10:01:00.000Z";
const fixedNow = () => new Date("2026-11-03T12:00:00.000Z");
const MiB = 1024 * 1024;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "journey-package-"));
  roots.push(root);
  mkdirSync(path.join(root, rawRoot, recordDirectory, "attempt-0"), { recursive: true });
  return root;
}

const timelineBytes = (timeline) => Buffer.from(JSON.stringify(timeline));
const captureBytes = (name) => encodePng(checkpointWidths[name]);

function completeItems(timeline = completeTimeline(timelineStart)) {
  return [
    { name: timelineAttachmentName, bytes: timelineBytes(timeline) },
    ...checkpointNames.map((name) => ({ name, bytes: captureBytes(name) })),
  ];
}

// Writes first-attempt candidates the way the reporter does: body bytes under
// the record directory, referenced relative to the raw root.
function candidatesFor(root, items) {
  return items.map((item, index) => {
    const file = item.file ?? `${recordDirectory}/attempt-0/${index}.bin`;
    if (item.bytes !== undefined) writeFileSync(path.join(root, rawRoot, file), item.bytes);
    return {
      name: item.name,
      contentType: item.contentType ?? (item.name === timelineAttachmentName ? "application/json" : "image/png"),
      file,
      attachedAt: item.attachedAt === undefined ? attachedLater : item.attachedAt,
    };
  });
}

function attempt(retry, status, extra = {}) {
  return {
    retry,
    status,
    durationMs: 1200,
    failure: null,
    candidates: retry === 0 ? [] : null,
    excluded: retry === 0 ? { automatic: 0, unlisted: 0, png: 0 } : null,
    ...extra,
  };
}

const assertionFailure = {
  classification: "assertion",
  knownLocator: "authorize-reviewed-offers",
  location: `${journeyPackageTarget.file}:120:7`,
};

function writeRecord(root, { items = completeItems(), attempts, target = {}, run, targets, raw } = {}) {
  const candidates = candidatesFor(root, items);
  const first = attempts?.[0] ?? attempt(0, "passed");
  const allAttempts = [{ ...first, candidates: first.candidates?.length ? first.candidates : candidates }];
  for (const later of attempts?.slice(1) ?? []) allAttempts.push(later);
  const record = raw ?? {
    schemaVersion: "journey-package-record/v1",
    run: run ?? { id: "7001", attempt: "1" },
    targets: targets ?? [
      {
        file: journeyPackageTarget.file,
        title,
        project: journeyPackageTarget.project,
        expectedStatus: "passed",
        outcome: "expected",
        attempts: attempts?.length === 0 ? [] : allAttempts,
        ...target,
      },
    ],
  };
  writeFileSync(path.join(root, rawRoot, recordDirectory, "record.json"), JSON.stringify(record));
  return record;
}

function step(root, overrides = {}, git) {
  const env = identityEnv(overrides);
  return journeyPackageStep({ root, env, git: git ?? checkoutGit(env), now: fixedNow });
}

function packageFiles(root) {
  const directory = path.join(root, packageRoot);
  const walk = (folder, prefix = "") =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(folder, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );
  return existsSync(directory) ? walk(directory).sort() : null;
}

const readManifest = (root) => JSON.parse(readFileSync(path.join(root, packageRoot, "manifest.json"), "utf8"));

function expectRefused(result, code, refusalPath) {
  expect(result.outcome).toMatchObject({ status: "refused", code });
  if (refusalPath !== undefined) expect(result.outcome.path).toBe(refusalPath);
  expect(result.exitCode).toBe(1);
  expect(result.outputs).toEqual({ publish: "false" });
  return result;
}

function expectNoPackage(root) {
  expect(existsSync(path.join(root, packageRoot))).toBe(false);
  expect(existsSync(path.join(root, stagingRoot))).toBe(false);
}

function rehash(root, relative) {
  const manifest = readManifest(root);
  const bytes = readFileSync(path.join(root, packageRoot, relative));
  const entry = manifest.files.find((file) => file.path === relative);
  entry.bytes = bytes.length;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(path.join(root, packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function inspectCli(directory, overrides = {}) {
  const expectations = {
    "--expect-test": journeyPackageTarget.file,
    "--expect-run": "7001",
    "--expect-attempt": "1",
    "--expect-job": "90001",
    "--expect-job-index": "3",
    "--expect-source-head": "a".repeat(40),
    ...overrides,
  };
  return spawnSync(process.execPath, [packagerPath, "--inspect", directory, ...Object.entries(expectations).flat()], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("journey package projection", () => {
  it("derives one authoritative state from the first attempt for every Playwright ending", { timeout: 60_000 }, () => {
    const failed = attempt(0, "failed", { failure: assertionFailure });
    const rows = [
      ["passed", "success", [attempt(0, "passed")], {}, "success", "passed", false],
      [
        "skipped",
        "success",
        [attempt(0, "skipped")],
        { expectedStatus: "skipped", outcome: "skipped" },
        "diagnostics",
        "skipped",
        true,
      ],
      [
        "expected failure",
        "success",
        [failed],
        { expectedStatus: "failed", outcome: "expected" },
        "diagnostics",
        "expected-failure",
        true,
      ],
      [
        "retry-recovered",
        "success",
        [failed, attempt(1, "passed")],
        { outcome: "flaky" },
        "diagnostics",
        "retry-recovered",
        true,
      ],
      ["failed", "failure", [failed], { outcome: "unexpected" }, "diagnostics", "failed", true],
      [
        "timed out",
        "failure",
        [attempt(0, "timedOut", { failure: { ...assertionFailure, classification: "timeout" } })],
        { outcome: "unexpected" },
        "diagnostics",
        "timed-out",
        true,
      ],
      [
        "interrupted",
        "failure",
        [attempt(0, "interrupted")],
        { outcome: "skipped" },
        "diagnostics",
        "interrupted",
        true,
      ],
      [
        "unexpected pass",
        "failure",
        [attempt(0, "passed")],
        { expectedStatus: "failed", outcome: "unexpected" },
        "diagnostics",
        "failed",
        true,
      ],
      ["passed beside a failed producer", "failure", [attempt(0, "passed")], {}, "diagnostics", "passed", false],
    ];
    for (const [name, producer, attempts, target, kind, state, partial] of rows) {
      const root = makeRoot();
      writeRecord(root, { attempts, target });
      const result = step(root, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: producer });
      expect(result.exitCode, name).toBe(0);
      expect(result.outcome, name).toMatchObject({ status: "published", package: kind, state, partial });
      const prefix = kind === "success" ? "journey-package" : "journey-package-diagnostics";
      expect(result.outputs, name).toEqual({ publish: "true", "artifact-name": `${prefix}-7001-1-3`, package: kind });
      const projected = JSON.parse(readFileSync(path.join(root, packageRoot, "result.json"), "utf8"));
      expect(projected, name).toMatchObject({ state, retry: 0, status: attempts[0].status });
    }

    const notExecuted = makeRoot();
    writeRecord(notExecuted, { attempts: [], target: { outcome: "skipped" } });
    const result = step(notExecuted, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: "failure" });
    expect(result.outcome).toMatchObject({
      status: "published",
      package: "diagnostics",
      state: "not-executed",
      partial: true,
    });
    expect(packageFiles(notExecuted)).toEqual(["manifest.json", "result.json"]);
    expect(JSON.parse(readFileSync(path.join(notExecuted, packageRoot, "result.json"), "utf8"))).toEqual({
      state: "not-executed",
      expectedStatus: "passed",
      status: null,
      outcome: null,
      retry: 0,
      durationMs: null,
      classification: null,
      knownLocator: null,
      location: null,
    });

    for (const [name, attempts, target] of [
      ["failed", [failed], { outcome: "unexpected" }],
      ["not executed", [], { outcome: "skipped" }],
      ["interrupted", [attempt(0, "interrupted")], { outcome: "skipped" }],
    ]) {
      const root = makeRoot();
      writeRecord(root, { attempts, target });
      const result = step(root);
      expect(result.outcome, name).toMatchObject({ status: "refused", code: "outcome-conflict" });
      expect(result.exitCode, name).toBe(1);
      expectNoPackage(root);
    }
  });

  it("publishes nothing and exits 0 for an absent or unenrolled target", () => {
    const absent = makeRoot();
    const result = step(absent);
    expect(result).toMatchObject({
      exitCode: 0,
      outputs: { publish: "false" },
      outcome: { status: "summary", state: "absent" },
    });

    const unenrolled = makeRoot();
    writeRecord(unenrolled, { items: checkpointNames.map((name) => ({ name, bytes: captureBytes(name) })) });
    expect(step(unenrolled)).toMatchObject({ exitCode: 0, outcome: { status: "summary", state: "unenrolled" } });
    expectNoPackage(unenrolled);

    // A raw timeline that does not declare the contract never enrolls, even
    // when it carries secrets, and none of its bytes are read into a package.
    const raw = makeRoot();
    writeRecord(raw, {
      items: [{ name: timelineAttachmentName, bytes: Buffer.from(JSON.stringify({ sessionId: witnesses.session })) }],
      attempts: [attempt(0, "failed", { failure: assertionFailure })],
      target: { outcome: "unexpected" },
    });
    expect(step(raw, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: "failure" })).toMatchObject({
      exitCode: 0,
      outcome: { status: "summary", state: "unenrolled" },
    });
    expectNoPackage(raw);
  });

  it("refuses an incomplete, conflicting or unknown-version success", () => {
    const incomplete = completeTimeline(timelineStart);
    incomplete.entries = incomplete.entries.filter((entry) => entry.command !== "confirm-checkout");
    const root = makeRoot();
    writeRecord(root, { items: completeItems(incomplete) });
    expectRefused(step(root), "timeline-incomplete", "confirm-checkout-command");
    expectNoPackage(root);

    const twoTimelines = makeRoot();
    writeRecord(twoTimelines, { items: [...completeItems(), completeItems()[0]] });
    expectRefused(step(twoTimelines), "timeline-conflict");

    const version = completeTimeline(timelineStart);
    version.version = 2;
    const unknownVersion = makeRoot();
    writeRecord(unknownVersion, { items: completeItems(version) });
    expectRefused(step(unknownVersion), "timeline-version");

    const twoTargets = makeRoot();
    const record = writeRecord(twoTargets);
    record.targets.push({ ...record.targets[0], title: `${title} duplicate` });
    writeFileSync(path.join(twoTargets, rawRoot, recordDirectory, "record.json"), JSON.stringify(record));
    expectRefused(step(twoTargets), "target-conflict");

    const otherTarget = makeRoot();
    writeRecord(otherTarget, { target: { file: notTheTarget } });
    expectRefused(step(otherTarget), "target-conflict");
  });

  it(
    "closed timeline schema refuses nested unknown, date-only, out-of-range and empty values",
    { timeout: 60_000 },
    () => {
      const cases = [
        ["nested unknown key", (timeline) => (timeline.entries[2].viewport.devicePixelRatio = 2), "timeline-invalid"],
        ["top-level unknown key", (timeline) => (timeline.sessionId = witnesses.session), "timeline-invalid"],
        [
          "entry unknown key",
          (timeline) => (timeline.entries[0].requestBody = { password: witnesses.password }),
          "timeline-invalid",
        ],
        ["date-only instant", (timeline) => (timeline.entries[0].at = "2026-11-01"), "timeline-invalid"],
        ["instant without offset", (timeline) => (timeline.entries[0].at = "2026-11-01T10:00:00"), "timeline-invalid"],
        ["out-of-range day", (timeline) => (timeline.entries[0].at = "2026-02-30T10:00:00Z"), "timeline-invalid"],
        [
          "out-of-range offset",
          (timeline) => (timeline.entries[0].at = "2026-11-01T10:00:00+24:00"),
          "timeline-invalid",
        ],
        ["empty entries", (timeline) => (timeline.entries = []), "timeline-invalid"],
        ["empty amount", (timeline) => (timeline.entries[5].amount = ""), "timeline-invalid"],
        ["unknown command", (timeline) => (timeline.entries[1].command = "DeleteEverything"), "timeline-invalid"],
        [
          "secret in an Offer ID",
          (timeline) => (timeline.entries[1].offerIds = [witnesses.session]),
          "timeline-invalid",
        ],
        ["credential URL as a route", (timeline) => (timeline.entries[2].route = witnesses.url), "timeline-invalid"],
        ["over-budget convergence", (timeline) => (timeline.entries[5].budgetMs = 180_001), "timeline-invalid"],
        ["elapsed beyond its window", (timeline) => (timeline.entries[5].elapsedMs = 9000), "timeline-invalid"],
        ["out-of-order entries", (timeline) => timeline.entries.reverse(), "timeline-invalid"],
        [
          "duplicate capture entry",
          (timeline) => timeline.entries.push({ ...timeline.entries[11], at: "2026-11-01T10:00:30.000Z" }),
          "timeline-conflict",
        ],
      ];
      for (const [name, mutate, code] of cases) {
        const timeline = completeTimeline(timelineStart);
        mutate(timeline);
        const root = makeRoot();
        writeRecord(root, { items: completeItems(timeline) });
        const result = step(root);
        expect(result.outcome, name).toMatchObject({ status: "refused", code });
        expect(JSON.stringify(result), name).not.toMatch(/jrnywitness/i);
        expectNoPackage(root);
      }
    },
  );

  it("keeps only enum and repository-location failure facts", () => {
    expect(
      knownLocatorFor(
        "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Authorize reviewed Offers' })\n",
      ),
    ).toBe("authorize-reviewed-offers");
    expect(knownLocatorFor(`Locator: getByText('${witnesses.session}')`)).toBe("unknown");
    expect(knownLocatorFor(undefined)).toBe("unknown");

    const root = makeRoot();
    writeRecord(root, {
      attempts: [attempt(0, "failed", { failure: { ...assertionFailure, location: `${witnesses.url}:1:1` } })],
      target: { outcome: "unexpected" },
    });
    // The record's location is a closed pattern; an unsafe value is refused, never copied.
    const refused = step(root, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: "failure" });
    expect(refused.outcome).toMatchObject({ status: "refused", code: "record-invalid" });
    expect(JSON.stringify(refused)).not.toMatch(/jrnywitness/i);
  });
});

describe("journey package capture provenance", () => {
  it("capture provenance", { timeout: 60_000 }, () => {
    const refusals = [
      ["captured before its entry", { attachedAt: "2026-11-01T10:00:01.000Z" }, "capture-provenance"],
      ["no attach time", { attachedAt: null }, "capture-provenance"],
      ["wrong IHDR width", { bytes: encodePng(1440) }, "capture-invalid"],
      ["not a PNG content type", { contentType: "image/jpeg" }, "capture-invalid"],
      [
        "tEXt chunk",
        { bytes: encodePng(390, 2, { before: [pngChunk("tEXt", Buffer.from(`Comment\0${witnesses.password}`))] }) },
        "capture-invalid",
      ],
      [
        "zTXt chunk",
        { bytes: encodePng(390, 2, { after: [pngChunk("zTXt", Buffer.from("Comment\0\0x"))] }) },
        "capture-invalid",
      ],
      [
        "iTXt chunk",
        { bytes: encodePng(390, 2, { before: [pngChunk("iTXt", Buffer.from("Comment\0\0\0\0\0x"))] }) },
        "capture-invalid",
      ],
      [
        "eXIf chunk",
        { bytes: encodePng(390, 2, { before: [pngChunk("eXIf", Buffer.from("MM\0*"))] }) },
        "capture-invalid",
      ],
      ["PLTE chunk", { bytes: encodePng(390, 2, { before: [pngChunk("PLTE", Buffer.alloc(3))] }) }, "capture-invalid"],
      [
        "unknown critical chunk",
        { bytes: encodePng(390, 2, { before: [pngChunk("ABCD", Buffer.alloc(1))] }) },
        "capture-invalid",
      ],
      [
        "bad CRC",
        {
          bytes: (() => {
            const png = encodePng(390);
            png[png.length - 20] ^= 0xff;
            return png;
          })(),
        },
        "capture-invalid",
      ],
      [
        "bytes after IEND",
        { bytes: Buffer.concat([encodePng(390), Buffer.from(witnesses.bearer)]) },
        "capture-invalid",
      ],
      [
        "data after the image stream",
        {
          bytes: (() => {
            const stream = Buffer.concat([deflateSync(scanlines(390, 2)), Buffer.from(witnesses.cookie)]);
            return Buffer.concat([pngSignature, ihdr(390, 2), pngChunk("IDAT", stream), pngChunk("IEND")]);
          })(),
        },
        "capture-invalid",
      ],
      [
        "short image stream",
        {
          bytes: Buffer.concat([
            pngSignature,
            ihdr(390, 3),
            pngChunk("IDAT", deflateSync(scanlines(390, 2))),
            pngChunk("IEND"),
          ]),
        },
        "capture-invalid",
      ],
      [
        "split IDAT runs",
        {
          bytes: (() => {
            const stream = deflateSync(scanlines(390, 2));
            return Buffer.concat([
              pngSignature,
              ihdr(390, 2),
              pngChunk("IDAT", stream.subarray(0, 4)),
              pngChunk("prVt", Buffer.alloc(1)),
              pngChunk("IDAT", stream.subarray(4)),
              pngChunk("IEND"),
            ]);
          })(),
        },
        "capture-invalid",
      ],
      [
        "interlaced",
        {
          bytes: Buffer.concat([
            pngSignature,
            ihdr(390, 2, { interlace: 1 }),
            pngChunk("IDAT", deflateSync(scanlines(390, 2))),
            pngChunk("IEND"),
          ]),
        },
        "capture-invalid",
      ],
      [
        "16-bit depth",
        {
          bytes: Buffer.concat([
            pngSignature,
            ihdr(390, 2, { bitDepth: 16 }),
            pngChunk("IDAT", deflateSync(scanlines(390, 2))),
            pngChunk("IEND"),
          ]),
        },
        "capture-invalid",
      ],
      [
        "invalid filter byte",
        {
          bytes: (() => {
            const raw = scanlines(390, 2);
            raw[0] = 9;
            return Buffer.concat([pngSignature, ihdr(390, 2), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND")]);
          })(),
        },
        "capture-invalid",
      ],
    ];
    for (const [name, patch, code] of refusals) {
      const items = completeItems();
      const index = items.findIndex((item) => item.name === "journey-review-390");
      items[index] = { ...items[index], ...patch };
      for (const producer of ["success", "failure"]) {
        const root = makeRoot();
        const failing = producer === "failure";
        writeRecord(root, {
          items,
          attempts: [attempt(0, failing ? "failed" : "passed", { failure: failing ? assertionFailure : null })],
          target: { outcome: failing ? "unexpected" : "expected" },
        });
        const result = step(root, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: producer });
        expect(result.outcome, `${name} (${producer})`).toMatchObject({
          status: "refused",
          code,
          path: "captures/journey-review-390.png",
        });
        expect(result.exitCode, name).toBe(1);
        expectNoPackage(root);
      }
    }

    // A capture whose checkpoint has no timeline entry refuses.
    const noEntry = completeTimeline(timelineStart);
    noEntry.entries = noEntry.entries.filter((entry) => entry.checkpoint !== "journey-active-1440");
    const unbound = makeRoot();
    writeRecord(unbound, { items: completeItems(noEntry) });
    expectRefused(step(unbound), "capture-provenance", "captures/journey-active-1440.png");

    const duplicate = makeRoot();
    writeRecord(duplicate, {
      items: [...completeItems(), { name: "journey-review-390", bytes: captureBytes("journey-review-390") }],
    });
    expectRefused(step(duplicate), "capture-conflict", "captures/journey-review-390.png");

    // A success needs all five captures.
    const missing = makeRoot();
    writeRecord(missing, {
      items: completeItems().filter((item) => item.name !== "journey-checkout-confirmation-1440"),
    });
    expectRefused(step(missing), "capture-incomplete", "journey-checkout-confirmation-1440");

    // A failure keeps the captures it completed and is marked partial.
    const partial = makeRoot();
    writeRecord(partial, {
      items: completeItems().filter((item) => !/active|confirmation/.test(item.name)),
      attempts: [attempt(0, "failed", { failure: assertionFailure })],
      target: { outcome: "unexpected" },
    });
    const kept = step(partial, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: "failure" });
    expect(kept.outcome).toMatchObject({ status: "published", package: "diagnostics", state: "failed", partial: true });
    expect(packageFiles(partial)).toEqual([
      "captures/journey-review-1440.png",
      "captures/journey-review-390.png",
      "manifest.json",
      "result.json",
      "timeline.json",
    ]);

    // Ancillary chunks are dropped; the rebuilt PNG keeps the exact pixels.
    const ancillary = makeRoot();
    const items = completeItems();
    items[1] = {
      ...items[1],
      bytes: encodePng(390, 2, {
        before: [pngChunk("gAMA", Buffer.alloc(4))],
        after: [pngChunk("tIME", Buffer.alloc(7))],
      }),
    };
    writeRecord(ancillary, { items });
    expect(step(ancillary).outcome).toMatchObject({ status: "published", package: "success" });
    const rebuilt = readFileSync(path.join(ancillary, packageRoot, "captures/journey-review-390.png"));
    expect(scanPackageForWitnesses(path.join(ancillary, packageRoot)).hits).toEqual([]);
    expect(rebuilt.includes(Buffer.from("gAMA"))).toBe(false);
    expect(rebuilt.includes(Buffer.from("tIME"))).toBe(false);
  });
});

describe("journey package identity, containment and caps", () => {
  it("identity, containment and caps", { timeout: 60_000 }, () => {
    // Success binds the full identity and exact inventory.
    const root = makeRoot();
    writeRecord(root);
    const published = step(root);
    expect(published.exitCode).toBe(0);
    expect(packageFiles(root)).toEqual([
      "captures/journey-active-1440.png",
      "captures/journey-active-390.png",
      "captures/journey-checkout-confirmation-1440.png",
      "captures/journey-review-1440.png",
      "captures/journey-review-390.png",
      "manifest.json",
      "result.json",
      "timeline.json",
    ]);
    expect(existsSync(path.join(root, stagingRoot))).toBe(false);
    const manifest = readManifest(root);
    expect(manifest).toMatchObject({
      schemaVersion: "journey-package/v1",
      artifactName: "journey-package-7001-1-3",
      package: "success",
      state: "passed",
      partial: false,
      identity: {
        sourceHead: "a".repeat(40),
        checkout: { sha: "b".repeat(40), ref: "refs/pull/11005/merge", tree: "c".repeat(40) },
        run: { id: 7001, attempt: 1 },
        job: { checkRunId: 90001, index: 3, batch: "marketplace_browse,marketplace_account" },
        test: { file: journeyPackageTarget.file, title, project: journeyPackageTarget.project, retry: 0 },
        producerOutcome: "success",
        capturedAt: "2026-11-03T12:00:00.000Z",
      },
    });
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(root, packageRoot, file.path));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(scanPackageForWitnesses(path.join(root, packageRoot)).hits).toEqual([]);

    // Every identity input is required and bounded.
    for (const [key, value] of [
      ["JOURNEY_PACKAGE_PRODUCER_OUTCOME", "cancelled"],
      ["JOURNEY_PACKAGE_SOURCE_HEAD", ""],
      ["JOURNEY_PACKAGE_CHECKOUT_SHA", "B".repeat(40)],
      ["JOURNEY_PACKAGE_CHECKOUT_TREE", undefined],
      ["GITHUB_REF", "refs/heads/../main"],
      ["GITHUB_RUN_ID", "0"],
      ["GITHUB_RUN_ATTEMPT", "one"],
      ["JOURNEY_PACKAGE_CHECK_RUN_ID", "-5"],
      ["JOURNEY_PACKAGE_JOB_INDEX", "01"],
      ["JOURNEY_PACKAGE_SUITE_BATCH", "marketplace account"],
    ]) {
      const invalid = makeRoot();
      writeRecord(invalid);
      expectRefused(step(invalid, { [key]: value }), "identity-invalid", key);
      expectNoPackage(invalid);
    }

    // The checkout is re-read at packaging time.
    const moved = makeRoot();
    writeRecord(moved);
    expectRefused(
      step(moved, {}, (...args) => (args.at(-1) === "HEAD^{commit}" ? "d".repeat(40) : "c".repeat(40))),
      "checkout-mismatch",
    );

    // Stale or mixed attempts never qualify.
    for (const [name, options, code] of [
      ["previous run attempt", { run: { id: "7001", attempt: "2" } }, "record-stale"],
      ["previous run", { run: { id: "7000", attempt: "1" } }, "record-stale"],
      ["local record", { run: { id: "local", attempt: "local" } }, "record-stale"],
      ["outcome disagrees with attempts", { target: { outcome: "flaky" } }, "record-invalid"],
      ["passed twice", { attempts: [attempt(0, "passed"), attempt(1, "passed")] }, "record-invalid"],
      [
        "attempt gap",
        { attempts: [attempt(0, "failed"), { ...attempt(1, "passed"), retry: 2 }], target: { outcome: "flaky" } },
        "record-invalid",
      ],
      [
        "later attempt candidates",
        { attempts: [attempt(0, "failed"), { ...attempt(1, "passed"), candidates: [] }], target: { outcome: "flaky" } },
        "record-invalid",
      ],
      ["unknown record key", { target: { stdout: witnesses.password } }, "record-invalid"],
    ]) {
      const stale = makeRoot();
      writeRecord(stale, options);
      const result = step(stale);
      expect(result.outcome, name).toMatchObject({ status: "refused", code });
      expect(JSON.stringify(result), name).not.toMatch(/jrnywitness/i);
      expectNoPackage(stale);
    }

    // Paths stay inside the raw root: no traversal, absolute path, symlink, directory or missing file.
    for (const reference of ["traversal", "absolute", "symlink", "directory", "missing"]) {
      const contained = makeRoot();
      const outsideFile = path.join(contained, "outside.png");
      writeFileSync(outsideFile, captureBytes("journey-review-390"));
      mkdirSync(path.join(contained, rawRoot, "linked-target"), { recursive: true });
      writeFileSync(path.join(contained, rawRoot, "linked-target/capture.png"), captureBytes("journey-review-390"));
      symlinkSync(path.join(contained, rawRoot, "linked-target"), path.join(contained, rawRoot, "linked"), "junction");
      const file = {
        traversal: "../../../outside.png",
        absolute: outsideFile,
        symlink: "linked/capture.png",
        directory: "linked-target",
        missing: "missing/capture.png",
      }[reference];
      const items = completeItems();
      items[1] = { name: "journey-review-390", file };
      writeRecord(contained, { items });
      const result = step(contained);
      expect(result.outcome, reference).toMatchObject({ status: "refused", code: "containment" });
      expectNoPackage(contained);
    }

    // Caps: the largest measured hosted PNG and an exactly-at-cap PNG pass; one byte more refuses.
    for (const [bytes, accepted] of [
      [6_441_147, true],
      [caps.capture, true],
      [caps.capture + 1, false],
    ]) {
      const capped = makeRoot();
      const items = completeItems();
      items[1] = { ...items[1], bytes: padPng(captureBytes("journey-review-390"), bytes) };
      writeRecord(capped, { items });
      const result = step(capped);
      if (accepted) expect(result.outcome, String(bytes)).toMatchObject({ status: "published", package: "success" });
      else {
        expectRefused(result, "over-cap", "captures/journey-review-390.png");
        expect(result.outcome.detail).toEqual({ bytes, cap: caps.capture });
        expectNoPackage(capped);
      }
    }
    for (const [bytes, accepted] of [
      [caps.timeline, true],
      [caps.timeline + 1, false],
    ]) {
      const capped = makeRoot();
      const items = completeItems();
      const compact = JSON.stringify(completeTimeline(timelineStart));
      items[0] = { ...items[0], bytes: Buffer.from(compact + " ".repeat(bytes - compact.length)) };
      writeRecord(capped, { items });
      const result = step(capped);
      if (accepted) expect(result.outcome, String(bytes)).toMatchObject({ status: "published" });
      else {
        expectRefused(result, "over-cap", "timeline.json");
        expect(result.outcome.detail).toEqual({ bytes, cap: caps.timeline });
      }
    }
    expect(aggregateCap).toBe(5 * caps.capture + caps.timeline + caps.result + caps.manifest);

    // --inspect re-validates a downloaded package against the expected identity.
    const directory = path.join(root, packageRoot);
    const receipt = inspectCli(directory);
    expect(receipt.status, receipt.stderr).toBe(0);
    expect(JSON.parse(receipt.stdout)).toMatchObject({
      inspected: true,
      artifactName: "journey-package-7001-1-3",
      package: "success",
      state: "passed",
      partial: false,
    });
    for (const [flag, value, field] of [
      ["--expect-run", "7002", "run"],
      ["--expect-attempt", "2", "attempt"],
      ["--expect-job", "90002", "job"],
      ["--expect-job-index", "4", "jobIndex"],
      ["--expect-source-head", "e".repeat(40), "sourceHead"],
      ["--expect-test", notTheTarget, "test"],
    ]) {
      const mismatch = inspectCli(directory, { [flag]: value });
      expect(mismatch.status, flag).toBe(1);
      expect(mismatch.stderr, flag).toContain(`refused: inspect-mismatch at ${field}`);
    }
  });

  it("--inspect refuses tampered, extra, missing, ancillary and oversized package files", { timeout: 60_000 }, () => {
    const tampers = [
      ["changed byte", (directory) => writeFileSync(path.join(directory, "result.json"), "{}\n"), "inspect-mismatch"],
      ["extra file", (directory) => writeFileSync(path.join(directory, "trace.zip"), "x"), "inspect-mismatch"],
      ["missing file", (directory) => rmSync(path.join(directory, "timeline.json")), "inspect-mismatch"],
      [
        "ancillary chunk",
        (directory, root) => {
          writeFileSync(
            path.join(directory, "captures/journey-review-390.png"),
            encodePng(390, 2, { before: [pngChunk("gAMA", Buffer.alloc(4))] }),
          );
          rehash(root, "captures/journey-review-390.png");
        },
        "capture-invalid",
      ],
      [
        "oversized result",
        (directory, root) => {
          writeFileSync(path.join(directory, "result.json"), " ".repeat(caps.result + 1));
          rehash(root, "result.json");
        },
        "over-cap",
      ],
    ];
    for (const [name, tamper, code] of tampers) {
      const root = makeRoot();
      writeRecord(root);
      expect(step(root).exitCode).toBe(0);
      const directory = path.join(root, packageRoot);
      tamper(directory, root);
      expect(() => inspectJourneyPackage(directory), name).toThrow(expect.objectContaining({ code }));
    }
  });

  it("writes publish=true only after the staged package validates, through the CLI", { timeout: 60_000 }, () => {
    const root = makeRoot();
    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic journey package test");
    git("config", "user.email", "synthetic@example.invalid");
    git("config", "commit.gpgSign", "false");
    writeFileSync(path.join(root, "README.md"), "Synthetic checkout\n");
    git("add", "README.md");
    git("commit", "-m", "Synthetic checkout");
    writeRecord(root);
    const outputs = path.join(root, "github-output.txt");
    const summary = path.join(root, "github-step-summary.md");
    const run = (overrides) =>
      spawnSync(process.execPath, [packagerPath, "--root", root], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          ...identityEnv({
            JOURNEY_PACKAGE_CHECKOUT_SHA: git("rev-parse", "HEAD"),
            JOURNEY_PACKAGE_CHECKOUT_TREE: git("rev-parse", "HEAD^{tree}"),
            ...overrides,
          }),
          GITHUB_OUTPUT: outputs,
          GITHUB_STEP_SUMMARY: summary,
        },
      });

    const published = run({});
    expect(published.status, published.stderr).toBe(0);
    expect(readFileSync(outputs, "utf8")).toBe(
      "publish=true\nartifact-name=journey-package-7001-1-3\npackage=success\n",
    );
    expect(readFileSync(summary, "utf8")).toContain("published `journey-package-7001-1-3`");
    expect(packageFiles(root)).toHaveLength(8);

    writeFileSync(outputs, "");
    const refused = run({ JOURNEY_PACKAGE_CHECKOUT_TREE: "f".repeat(40) });
    expect(refused.status).toBe(1);
    expect(readFileSync(outputs, "utf8")).toBe("publish=false\n");
    expect(refused.stdout).toContain("refused: checkout-mismatch");
    expectNoPackage(root);
  });
});

describe("journey package workflow and boundaries", () => {
  it("existing semantics hold", () => {
    const workflowText = readFileSync(path.join(repoRoot, ".github/workflows/platform-pr.yml"), "utf8");
    const steps = parse(workflowText).jobs["e2e-tests"].steps;
    const names = steps.map((entry) => entry.name);
    const responsive = names.indexOf("Upload successful responsive evidence");
    expect(names.slice(responsive)).toEqual([
      "Upload successful responsive evidence",
      "Prepare journey package",
      "Upload journey package",
    ]);
    const [prepare, upload] = steps.slice(responsive + 1);
    const responsiveUpload = steps[responsive];

    expect(prepare).toEqual({
      name: "Prepare journey package",
      id: "journey-package",
      if: "${{ !cancelled() && steps.e2e-producer.outcome != 'skipped' }}",
      env: {
        JOURNEY_PACKAGE_PRODUCER_OUTCOME: "${{ steps.e2e-producer.outcome }}",
        JOURNEY_PACKAGE_SOURCE_HEAD:
          "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || '' }}",
        JOURNEY_PACKAGE_CHECKOUT_SHA: "${{ steps.responsive-evidence-checkout.outputs.checkout-commit }}",
        JOURNEY_PACKAGE_CHECKOUT_TREE: "${{ steps.responsive-evidence-checkout.outputs.checkout-tree }}",
        JOURNEY_PACKAGE_CHECK_RUN_ID: "${{ job.check_run_id }}",
        JOURNEY_PACKAGE_JOB_INDEX: "${{ strategy.job-index }}",
        JOURNEY_PACKAGE_SUITE_BATCH: "${{ matrix.suite_batch }}",
      },
      run: "node ./scripts/prepare-journey-package.mjs",
    });
    expect(upload).toEqual({
      name: "Upload journey package",
      if: "${{ !cancelled() && steps.journey-package.outputs.publish == 'true' }}",
      uses: responsiveUpload.uses,
      with: {
        name: "${{ steps.journey-package.outputs.artifact-name }}",
        path: packageRoot,
        "if-no-files-found": "error",
        "retention-days": 14,
      },
    });
    expect(Object.keys(prepare)).not.toContain("continue-on-error");
    expect(Object.keys(upload)).not.toContain("continue-on-error");
    const producer = steps.find((entry) => entry.id === "e2e-producer");
    expect(producer["continue-on-error"]).toBeUndefined();

    const evaluate = (condition, values) => {
      let expression = condition.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
      for (const [name, value] of Object.entries(values))
        expression = expression.replaceAll(name, JSON.stringify(value));
      return runInNewContext(expression);
    };
    for (const cancelled of [false, true]) {
      for (const outcome of ["success", "failure", "skipped", "cancelled"]) {
        expect(evaluate(prepare.if, { "cancelled()": cancelled, "steps.e2e-producer.outcome": outcome })).toBe(
          !cancelled && outcome !== "skipped",
        );
      }
      for (const publish of ["true", "false", ""]) {
        expect(
          evaluate(upload.if, { "cancelled()": cancelled, "steps.journey-package.outputs.publish": publish }),
        ).toBe(!cancelled && publish === "true");
      }
    }

    // The package root never overlaps a raw Playwright root, and the fence passes.
    for (const raw of rawPlaywrightRoots) {
      for (const own of [packageRoot, stagingRoot]) {
        expect(`${own}/`.startsWith(`${raw}/`) || `${raw}/`.startsWith(`${own}/`)).toBe(false);
      }
    }
    expect(rawPlaywrightRoots).toContain(rawRoot);
    const fence = scanPlaywrightArtifactUploads({ root: repoRoot });
    expect(fence.status).toBe("pass");
    expect(fence.findings).toEqual([]);

    // The contract names only the real target, and the producer config records it.
    const config = readFileSync(path.join(repoRoot, "playwright.config.ts"), "utf8");
    expect(existsSync(path.join(repoRoot, journeyPackageTarget.file))).toBe(true);
    expect(config).toContain(`name: "${journeyPackageTarget.project}"`);
    expect(config).toContain('testMatch: "deployables/marketplace/e2e/**/*.spec.ts"');
    expect(config).toContain(`outputDir: "${rawRoot}"`);
    expect(config.match(/\["\.\/scripts\/lib\/journey-package-reporter\.mjs"\]/g)).toHaveLength(1);
  });
});
