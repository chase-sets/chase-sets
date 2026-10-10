import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildReplacementBundle,
  extensionIdForKey,
  fileDigests,
  stageBundle,
  syntheticReplacementKey,
  syntheticReplacementKeySha256,
} from "../fixtures/code-replacement/bundle";
import { parseProbeRecord } from "./probe-record";
import {
  armFixtureVersions,
  assessReplacement,
  buildReplacementRecord,
  captureStages,
  consumedVersion,
  parseReplacementRecord,
  replacementArms,
  selectReplacementMechanism,
  stageLaunch,
  type ArmRecord,
  type BundleRecord,
  type Capture,
  type CaptureStage,
  type ReplacementArm,
  type ReplacementBody,
} from "./replacement-record";

const extensionId = "dmofhpcfbklknkfdfllmbkmpofkmdkkk";
const workerUrl = `chrome-extension://${extensionId}/worker.js`;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + seconds * 1_000).toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const executed: Record<ReplacementArm, Record<CaptureStage, "A" | "B">> = {
  "same-version-byte-swap": { install: "A", relaunch: "A", "load-unpacked": "A", "repeat-relaunch": "A" },
  "version-ordered-install": { install: "A", relaunch: "B", "load-unpacked": "B", "repeat-relaunch": "B" },
  "cdp-load-unpacked": { install: "A", relaunch: "A", "load-unpacked": "B", "repeat-relaunch": "B" },
};
const offsets: Record<CaptureStage, number> = { install: 1, relaunch: 3, "load-unpacked": 5, "repeat-relaunch": 6 };

function syntheticBundle(name: ReplacementArm, label: "A" | "B"): BundleRecord {
  const version = label === "A" ? armFixtureVersions[name].A : consumedVersion;
  return {
    label,
    identity: `SYNTHETIC-9257:${name}:${label}`,
    manifestVersion: version,
    syntheticVersion: label === "A" && armFixtureVersions[name].syntheticA,
    files: [
      { name: "manifest.json", bytes: 300, sha256: sha(`${name}/${label}/manifest`) },
      { name: "observer.html", bytes: 90, sha256: sha("observer") },
      { name: "worker.js", bytes: 700, sha256: sha(`${name}/${label}/worker`) },
    ],
  };
}

function syntheticArm(name: ReplacementArm): ArmRecord {
  const base = replacementArms.indexOf(name) * 100;
  const profile = `/SYNTHETIC/9257/${name}/profile`;
  const markerNonce = `0000000${replacementArms.indexOf(name)}-0000-4000-8000-000000009257`;
  const bundles = { A: syntheticBundle(name, "A"), B: syntheticBundle(name, "B") };
  const captures = captureStages[name].map((stage): Capture => {
    const bundle = bundles[executed[name][stage]];
    return {
      arm: name,
      stage,
      launch: stageLaunch[stage],
      run: "38022590812/1",
      profile,
      chromiumVersion: "148.0.7778.96",
      capturedAt: at(base + offsets[stage]),
      observation: {
        workerUrl,
        executedIdentity: bundle.identity,
        workerStartedAt: at(base + offsets[stage] - 1),
        runtimeManifestVersion: bundle.manifestVersion,
        onInstalled: stage === "install" ? [{ reason: "install", previousVersion: null, observedAt: at(base) }] : [],
        onInstalledObservedForMs: 2_000,
        registrations: [
          { scope: `chrome-extension://${extensionId}/`, active: workerUrl, waiting: null, installing: null },
        ],
        contextServiceWorkers: [workerUrl],
        marker: { present: true, nonce: markerNonce },
      },
    };
  });
  return {
    name,
    profile,
    markerNonce,
    bundles,
    stagings: [
      { bundle: "A", stagedAt: at(base), source: copy(bundles.A.files), staged: copy(bundles.A.files) },
      { bundle: "B", stagedAt: at(base + 2), source: copy(bundles.B.files), staged: copy(bundles.B.files) },
    ],
    captures,
    loadUnpacked:
      name === "cdp-load-unpacked"
        ? { route: "Extensions.loadUnpacked", requestedAt: at(base + 4), extensionId, error: null }
        : null,
  };
}

function syntheticBody(arms: readonly ReplacementArm[] = replacementArms): ReplacementBody {
  return {
    schema: "extension-code-replacement-qualification",
    schemaVersion: 1,
    run: {
      id: "38022590812/1",
      sourceHead: "a".repeat(40),
      checkoutHead: "b".repeat(40),
      runId: "38022590812",
      runAttempt: "1",
      job: "e2e",
      capturedAt: at(1_000),
    },
    pins: { playwrightVersion: "1.60.0", chromiumVersion: "148.0.7778.96" },
    extension: { id: extensionId, syntheticKeySha256: syntheticReplacementKeySha256 },
    arms: arms.map(syntheticArm),
  };
}

const mutate = (change: (body: ReplacementBody) => void, arms?: readonly ReplacementArm[]) => {
  const body = structuredClone(syntheticBody(arms));
  change(body);
  return body;
};
const arm = (body: ReplacementBody, name: ReplacementArm) => body.arms.find((entry) => entry.name === name)!;
const stageOf = (body: ReplacementBody, name: ReplacementArm, stage: CaptureStage) =>
  arm(body, name).captures.find((entry) => entry.stage === stage)!;
const observed = (body: ReplacementBody, name: ReplacementArm, stage: CaptureStage) => {
  const capture = stageOf(body, name, stage);
  if (!capture.observation) throw new Error("synthetic capture must be observed");
  return capture.observation;
};

test("replacement-record selects version-ordered-install beside a reproduced arm (a) and round-trips", () => {
  const body = syntheticBody();
  const assessment = assessReplacement(body);
  expect(assessment.failures).toEqual({
    record: [],
    "same-version-byte-swap": [],
    "version-ordered-install": [],
    "cdp-load-unpacked": [],
  });
  expect(assessment.selected).toBe("version-ordered-install");
  const record = buildReplacementRecord(body);
  expect(record.selectedReplacementMechanism).toBe("version-ordered-install");
  expect(parseReplacementRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  expect(selectReplacementMechanism(record)).toBe("version-ordered-install");
  // Arm (c) is optional; the required arms alone still select (b).
  expect(selectReplacementMechanism(syntheticBody(replacementArms.slice(0, 2)))).toBe("version-ordered-install");
});

test("replacement-record selects cdp-load-unpacked only when arm (b) does not qualify", () => {
  const body = mutate((body) => {
    observed(body, "version-ordered-install", "relaunch").executedIdentity = "SYNTHETIC-9257:version-ordered-install:A";
  });
  expect(assessReplacement(body).failures["version-ordered-install"]).toEqual([
    "relaunch executed SYNTHETIC-9257:version-ordered-install:A, not SYNTHETIC-9257:version-ordered-install:B",
  ]);
  expect(selectReplacementMechanism(body)).toBe("cdp-load-unpacked");
  expect(parseReplacementRecord(buildReplacementRecord(body)).selectedReplacementMechanism).toBe("cdp-load-unpacked");
});

test("replacement-record selects NONE when arm (a) does not reproduce the stale identity", () => {
  const replaced = mutate((body) => {
    const relaunch = observed(body, "same-version-byte-swap", "relaunch");
    relaunch.executedIdentity = "SYNTHETIC-9257:same-version-byte-swap:B";
  });
  expect(assessReplacement(replaced).failures["same-version-byte-swap"]).toEqual([
    "relaunch executed SYNTHETIC-9257:same-version-byte-swap:B, not SYNTHETIC-9257:same-version-byte-swap:A",
  ]);
  expect(selectReplacementMechanism(replaced)).toBe("NONE");
  for (const change of [
    (body: ReplacementBody) => (observed(body, "same-version-byte-swap", "relaunch").marker.nonce = "lost"),
    (body: ReplacementBody) => (arm(body, "same-version-byte-swap").bundles.A.manifestVersion = "0.0.1"),
    (body: ReplacementBody) => {
      const capture = stageOf(body, "same-version-byte-swap", "repeat-relaunch");
      Object.assign(capture, { observation: null, failure: { code: "worker-not-observed", message: "SYNTHETIC" } });
    },
  ])
    expect(selectReplacementMechanism(mutate(change))).toBe("NONE");
});

test("replacement-record selects NONE for missing, short, incomplete and unrun inputs", () => {
  expect(selectReplacementMechanism(undefined)).toBe("NONE");
  expect(selectReplacementMechanism({})).toBe("NONE");
  expect(selectReplacementMechanism(syntheticBody(replacementArms.slice(0, 1)))).toBe("NONE");
  const short = mutate((body) => arm(body, "version-ordered-install").captures.pop());
  expect(assessReplacement(short).parseError).toBe("record.arms[1].captures: expected 3..3 entries");
  const missingStaging = mutate((body) => arm(body, "version-ordered-install").stagings.pop());
  expect(assessReplacement(missingStaging).parseError).toBe("record.arms[1].stagings: expected 2..2 entries");
  const missingKey = mutate((body) => {
    delete (observed(body, "version-ordered-install", "repeat-relaunch") as Partial<Record<string, unknown>>)
      .registrations;
  });
  expect(assessReplacement(missingKey).parseError).toMatch(/^record\.arms\[1\]\.captures\[2\]\.observation: expected/);
  const incomplete = mutate((body) =>
    Object.assign(stageOf(body, "version-ordered-install", "repeat-relaunch"), {
      observation: null,
      failure: { code: "evaluation-failed", message: "SYNTHETIC evaluation failure" },
    }),
  );
  expect(assessReplacement(incomplete).failures["version-ordered-install"]).toEqual([
    "repeat-relaunch capture is incomplete: evaluation-failed",
  ]);
  // Arm (c) still qualifies, so an incomplete arm (b) falls through rather than selecting (b).
  expect(selectReplacementMechanism(incomplete)).toBe("cdp-load-unpacked");
  const bothIncomplete = mutate((body) => {
    for (const name of ["version-ordered-install", "cdp-load-unpacked"] as const)
      Object.assign(stageOf(body, name, "repeat-relaunch"), {
        observation: null,
        failure: { code: "worker-not-observed", message: "SYNTHETIC no worker" },
      });
  });
  expect(selectReplacementMechanism(bothIncomplete)).toBe("NONE");
  for (const loadUnpacked of [
    { route: "Extensions.loadUnpacked", requestedAt: at(204), extensionId: null, error: "SYNTHETIC refused" },
    { route: "Extensions.loadUnpacked", requestedAt: at(204), extensionId: "a".repeat(32), error: null },
  ] as const)
    expect(
      assessReplacement(
        mutate((body) => {
          observed(body, "version-ordered-install", "relaunch").marker = { present: false, nonce: null };
          arm(body, "cdp-load-unpacked").loadUnpacked = { ...loadUnpacked };
        }),
      ).selected,
    ).toBe("NONE");
});

test("replacement-record selects NONE for pin-mismatched inputs", () => {
  for (const change of [
    (body: ReplacementBody) => (body.pins.chromiumVersion = "149.0.0.0"),
    (body: ReplacementBody) => (body.pins.playwrightVersion = "1.61.0"),
    (body: ReplacementBody) => (stageOf(body, "same-version-byte-swap", "install").chromiumVersion = "149.0.0.0"),
  ]) {
    const body = mutate(change);
    expect(assessReplacement(body).parseError).toBeNull();
    expect(selectReplacementMechanism(body)).toBe("NONE");
  }
});

test("replacement-record selects NONE for inputs spliced across runs, arms, profiles or time", () => {
  const changes = [
    (body: ReplacementBody) => (stageOf(body, "same-version-byte-swap", "relaunch").run = "38015154175/1"),
    (body: ReplacementBody) =>
      (stageOf(body, "same-version-byte-swap", "relaunch").profile = arm(body, "version-ordered-install").profile),
    (body: ReplacementBody) => (stageOf(body, "same-version-byte-swap", "relaunch").arm = "version-ordered-install"),
    (body: ReplacementBody) =>
      (arm(body, "version-ordered-install").profile = arm(body, "same-version-byte-swap").profile),
    (body: ReplacementBody) => (arm(body, "version-ordered-install").stagings[1].stagedAt = at(500)),
    (body: ReplacementBody) =>
      (arm(body, "same-version-byte-swap").bundles.B.identity = "SYNTHETIC-9257:version-ordered-install:B"),
  ];
  for (const change of changes) {
    const body = mutate(change, replacementArms.slice(0, 2));
    expect(assessReplacement(body).parseError).toBeNull();
    expect(selectReplacementMechanism(body)).toBe("NONE");
  }
  const reordered = mutate((body) => body.arms.reverse(), replacementArms.slice(0, 2));
  expect(assessReplacement(reordered).parseError).toBe(
    "record.arms[0].name: expected same-version-byte-swap in canonical order",
  );
});

test("replacement-record requires the pinned fixture versions and complete equal staging", () => {
  const changes = [
    (body: ReplacementBody) => (arm(body, "version-ordered-install").bundles.A.manifestVersion = "0.1.0"),
    (body: ReplacementBody) => (arm(body, "version-ordered-install").bundles.A.syntheticVersion = false),
    (body: ReplacementBody) => (arm(body, "version-ordered-install").bundles.B.manifestVersion = "0.2.0"),
    (body: ReplacementBody) => arm(body, "version-ordered-install").stagings[1].staged.pop(),
    (body: ReplacementBody) =>
      (arm(body, "version-ordered-install").stagings[1].staged[2]!.sha256 = sha("SYNTHETIC stale worker")),
    (body: ReplacementBody) => {
      const { A, B } = arm(body, "version-ordered-install").bundles;
      B.files[2]!.sha256 = A.files[2]!.sha256;
    },
    (body: ReplacementBody) => (observed(body, "version-ordered-install", "repeat-relaunch").marker.nonce = "lost"),
    (body: ReplacementBody) =>
      (observed(body, "version-ordered-install", "relaunch").workerUrl =
        `chrome-extension://${"a".repeat(32)}/worker.js`),
    (body: ReplacementBody) => (observed(body, "version-ordered-install", "relaunch").runtimeManifestVersion = "0.0.1"),
  ];
  for (const change of changes) {
    const body = mutate(change, replacementArms.slice(0, 2));
    expect(assessReplacement(body).parseError).toBeNull();
    expect(assessReplacement(body).failures["version-ordered-install"]).not.toEqual([]);
    expect(selectReplacementMechanism(body)).toBe("NONE");
  }
});

test("replacement-record records observed onInstalled reasons without selecting on them", () => {
  for (const onInstalled of [[], [{ reason: "chrome_update", previousVersion: "0.0.1", observedAt: at(102) }]]) {
    const body = mutate((body) => (observed(body, "version-ordered-install", "relaunch").onInstalled = onInstalled));
    expect(selectReplacementMechanism(body)).toBe("version-ordered-install");
  }
});

test("replacement-record parsing is closed, recursive, UTC and bounded", () => {
  const record = buildReplacementRecord(syntheticBody());
  const rejects = (change: (value: Record<string, any>) => void, message: RegExp) => {
    const value = structuredClone(record) as Record<string, any>;
    change(value);
    expect(() => parseReplacementRecord(value)).toThrow(message);
    expect(selectReplacementMechanism(value)).toBe("NONE");
  };
  rejects((value) => (value.arms[1].captures[1].observation.marker.extra = true), /marker: expected exactly/);
  rejects(
    (value) =>
      (value.arms[1].captures[1].observation.onInstalled = [
        { reason: "update", previousVersion: null, observedAt: at(1), extra: 1 },
      ]),
    /onInstalled\[0\]: expected exactly/,
  );
  rejects((value) => (value.arms[0].bundles.A.files[0].mode = "0644"), /files\[0\]: expected exactly/);
  rejects((value) => (value.run.extra = "SYNTHETIC"), /record\.run: expected exactly/);
  rejects((value) => (value.arms[0].captures[0].capturedAt = "2026-10-09T12:00:01.000+00:00"), /UTC instant/);
  rejects((value) => (value.run.capturedAt = "2026-10-09T12:00:01Z"), /UTC instant/);
  rejects(
    (value) =>
      (value.arms[1].captures[1].observation.onInstalled = Array.from({ length: 9 }, () => ({
        reason: "update",
        previousVersion: "0.0.1",
        observedAt: at(1),
      }))),
    /expected 0\.\.8 entries/,
  );
  rejects((value) => (value.arms[1].captures[1].observation.executedIdentity = "x".repeat(1025)), /bounded text/);
  rejects((value) => (value.arms[1].captures[1].observation.onInstalledObservedForMs = 60_001), /integer/);
  rejects((value) => (value.arms[1].captures[1].observation.marker = { present: true, nonce: null }), /nonce must/);
  rejects((value) => (value.arms[0].loadUnpacked = value.arms[2].loadUnpacked), /only cdp-load-unpacked/);
  rejects((value) => (value.run.sourceHead = "main"), /sourceHead/);
  rejects((value) => (value.run.id = "38015154175/1"), /runId\/runAttempt/);
  rejects((value) => (value.selectedReplacementMechanism = "cdp-load-unpacked"), /does not match the strict selector/);
  rejects((value) => (value.selectedReplacementMechanism = "runtime.reload"), /unexpected value/);
});

test("replacement-record is a separate schema; #8589 v2 parsing is unchanged", () => {
  const record = buildReplacementRecord(syntheticBody());
  expect(() => parseProbeRecord(record)).toThrow();
  expect(() => parseReplacementRecord({ ...record, schemaVersion: 2 })).toThrow("record.schemaVersion: expected 1");
  expect(() =>
    parseReplacementRecord({ schemaVersion: 2, chromiumVersion: "148.0.7778.96", playwrightVersion: "1.60.0" }),
  ).toThrow(/record: expected exactly/);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("code-replacement bundles compile distinct identities at one synthetic extension id and stage completely", () => {
  const root = mkdtempSync(join(tmpdir(), "replacement-9257-"));
  roots.push(root);
  expect(extensionIdForKey(syntheticReplacementKey)).toBe(extensionId);
  const A = buildReplacementBundle(join(root, "A"), "version-ordered-install", "A", "0.0.1", true);
  const B = buildReplacementBundle(join(root, "B"), "version-ordered-install", "B", consumedVersion, false);
  expect(() => buildReplacementBundle(join(root, "A"), "version-ordered-install", "A", "0.0.1", true)).toThrow(
    "Replacement bundle destination must be fresh",
  );
  const worker = (directory: string) => readFileSync(join(directory, "worker.js"), "utf8");
  expect(worker(A.directory)).toContain('const identity = "SYNTHETIC-9257:version-ordered-install:A";');
  expect(worker(B.directory)).toContain('const identity = "SYNTHETIC-9257:version-ordered-install:B";');
  expect(worker(B.directory)).not.toMatch(/readFile|fetch\(|getURL|compiled-identity/);
  const manifest = (directory: string) => JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  expect(manifest(A.directory)).toMatchObject({
    version: "0.0.1",
    version_name: "0.0.1 SYNTHETIC lower-than-0.1.0",
    key: syntheticReplacementKey,
    background: { service_worker: "worker.js", type: "module" },
  });
  expect(manifest(B.directory).version).toBe("0.1.0");
  expect(manifest(B.directory)).not.toHaveProperty("version_name");
  expect(A.files.map((file) => file.name)).toEqual(["manifest.json", "observer.html", "worker.js"]);
  const install = join(root, "profile", "extension-under-test");
  expect(stageBundle(A, install).staged).toEqual(A.files);
  writeFileSync(join(install, "seed.js"), "SYNTHETIC stale file");
  const staging = stageBundle(B, install);
  expect(staging.staged).toEqual(staging.source);
  expect(staging.source).toEqual(B.files);
  expect(fileDigests(install).map((file) => file.name)).not.toContain("seed.js");
});
