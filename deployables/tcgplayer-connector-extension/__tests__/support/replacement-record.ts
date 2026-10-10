// #9257 code-replacement qualification packet. A new closed schema for new captures only; #8589's v2
// restart records keep their own parser (`probe-record.ts`) and bytes.
export const replacementPins = { playwrightVersion: "1.60.0", chromiumVersion: "148.0.7778.96" } as const;
export const replacementArms = ["same-version-byte-swap", "version-ordered-install", "cdp-load-unpacked"] as const;
export type ReplacementArm = (typeof replacementArms)[number];
export const replacementMechanisms = ["version-ordered-install", "cdp-load-unpacked", "NONE"] as const;
export type ReplacementMechanism = (typeof replacementMechanisms)[number];
// B always carries the version the AC6 upgrade slice consumes; A's version is pinned per arm.
export const consumedVersion = "0.1.0";
export const armFixtureVersions: Record<ReplacementArm, { A: string; syntheticA: boolean }> = {
  "same-version-byte-swap": { A: consumedVersion, syntheticA: false },
  // SYNTHETIC: strictly lower than 0.1.0 and labelled in the manifest's version_name; harness-only.
  "version-ordered-install": { A: "0.0.1", syntheticA: true },
  "cdp-load-unpacked": { A: consumedVersion, syntheticA: false },
};
export const captureStageNames = ["install", "relaunch", "load-unpacked", "repeat-relaunch"] as const;
export type CaptureStage = (typeof captureStageNames)[number];
export const captureStages: Record<ReplacementArm, readonly CaptureStage[]> = {
  "same-version-byte-swap": ["install", "relaunch", "repeat-relaunch"],
  "version-ordered-install": ["install", "relaunch", "repeat-relaunch"],
  "cdp-load-unpacked": ["install", "relaunch", "load-unpacked", "repeat-relaunch"],
};
export const stageLaunch: Record<CaptureStage, 1 | 2 | 3> = {
  install: 1,
  relaunch: 2,
  "load-unpacked": 2,
  "repeat-relaunch": 3,
};
// The bundle each stage must have executed for the arm to count; unlisted stages are recorded, not constrained.
const executedExpectations: Record<ReplacementArm, Partial<Record<CaptureStage, "A" | "B">>> = {
  "same-version-byte-swap": { install: "A", relaunch: "A" },
  "version-ordered-install": { install: "A", relaunch: "B", "repeat-relaunch": "B" },
  "cdp-load-unpacked": { install: "A", "load-unpacked": "B", "repeat-relaunch": "B" },
};
export const captureFailureCodes = ["worker-not-observed", "evaluation-failed", "registrations-unobserved"] as const;

export type FileDigest = { name: string; bytes: number; sha256: string };
export type BundleRecord = {
  label: "A" | "B";
  identity: string;
  manifestVersion: string;
  syntheticVersion: boolean;
  files: FileDigest[];
};
export type StagingRecord = { bundle: "A" | "B"; stagedAt: string; source: FileDigest[]; staged: FileDigest[] };
export type InstalledObservation = { reason: string; previousVersion: string | null; observedAt: string };
export type RegistrationObservation = {
  scope: string;
  active: string | null;
  waiting: string | null;
  installing: string | null;
};
export type LaunchObservation = {
  workerUrl: string;
  executedIdentity: string;
  workerStartedAt: string;
  runtimeManifestVersion: string;
  onInstalled: InstalledObservation[];
  onInstalledObservedForMs: number;
  registrations: RegistrationObservation[];
  contextServiceWorkers: string[];
  marker: { present: boolean; nonce: string | null };
};
export type CaptureFailure = { code: (typeof captureFailureCodes)[number]; message: string };
type CaptureBase = {
  arm: ReplacementArm;
  stage: CaptureStage;
  launch: 1 | 2 | 3;
  run: string;
  profile: string;
  chromiumVersion: string;
  capturedAt: string;
};
export type Capture = CaptureBase &
  ({ observation: LaunchObservation } | { observation: null; failure: CaptureFailure });
export type LoadUnpackedRecord = {
  route: "Extensions.loadUnpacked";
  requestedAt: string;
  extensionId: string | null;
  error: string | null;
};
export type ArmRecord = {
  name: ReplacementArm;
  profile: string;
  markerNonce: string;
  bundles: { A: BundleRecord; B: BundleRecord };
  stagings: [StagingRecord, StagingRecord];
  captures: Capture[];
  loadUnpacked: LoadUnpackedRecord | null;
};
export type ReplacementBody = {
  schema: "extension-code-replacement-qualification";
  schemaVersion: 1;
  run: {
    id: string;
    sourceHead: string;
    checkoutHead: string;
    runId: string;
    runAttempt: string;
    job: string;
    capturedAt: string;
  };
  pins: { playwrightVersion: string; chromiumVersion: string };
  extension: { id: string; syntheticKeySha256: string };
  arms: ArmRecord[];
};
export type ReplacementRecord = ReplacementBody & { selectedReplacementMechanism: ReplacementMechanism };
export type ReplacementAssessment = {
  selected: ReplacementMechanism;
  parseError: string | null;
  failures: Record<"record" | ReplacementArm, string[]>;
};

function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new Error(`${path}: expected exactly ${keys.join(",")}`);
  return value as Record<string, unknown>;
}

function list<T>(
  value: unknown,
  min: number,
  max: number,
  path: string,
  parse: (row: unknown, at: string, index: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`${path}: expected ${min}..${max} entries`);
  return value.map((row, index) => parse(row, `${path}[${index}]`, index));
}

function text(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || (pattern && !pattern.test(value)))
    throw new Error(`${path}: expected bounded text`);
  return value;
}

function nullable<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T | null {
  return value === null ? null : parse(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path}: expected boolean`);
  return value;
}

function integer(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error(`${path}: expected integer 0..${max}`);
  return value;
}

function instant(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`${path}: expected a millisecond UTC instant`);
  return value;
}

function member<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) throw new Error(`${path}: unexpected value`);
  return value as T;
}

const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const manifestVersion = /^(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){0,3}$/;
const chromiumVersion = /^\d{1,6}(?:\.\d{1,6}){3}$/;
const playwrightVersion = /^\d{1,6}(?:\.\d{1,6}){2}$/;
const extensionId = /^[a-p]{32}$/;

function digests(value: unknown, path: string): FileDigest[] {
  const files = list(value, 1, 16, path, (row, at) => {
    const file = object(row, ["name", "bytes", "sha256"], at);
    return {
      name: text(file.name, `${at}.name`, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
      bytes: integer(file.bytes, `${at}.bytes`, 1_000_000),
      sha256: text(file.sha256, `${at}.sha256`, sha256),
    };
  });
  for (let index = 1; index < files.length; index++)
    if (files[index - 1]!.name >= files[index]!.name) throw new Error(`${path}: expected sorted unique names`);
  return files;
}

function bundle(value: unknown, label: "A" | "B", path: string): BundleRecord {
  const row = object(value, ["label", "identity", "manifestVersion", "syntheticVersion", "files"], path);
  if (row.label !== label) throw new Error(`${path}.label: expected ${label}`);
  return {
    label,
    identity: text(row.identity, `${path}.identity`),
    manifestVersion: text(row.manifestVersion, `${path}.manifestVersion`, manifestVersion),
    syntheticVersion: boolean(row.syntheticVersion, `${path}.syntheticVersion`),
    files: digests(row.files, `${path}.files`),
  };
}

function staging(value: unknown, label: "A" | "B", path: string): StagingRecord {
  const row = object(value, ["bundle", "stagedAt", "source", "staged"], path);
  if (row.bundle !== label) throw new Error(`${path}.bundle: expected ${label}`);
  return {
    bundle: label,
    stagedAt: instant(row.stagedAt, `${path}.stagedAt`),
    source: digests(row.source, `${path}.source`),
    staged: digests(row.staged, `${path}.staged`),
  };
}

function observation(value: unknown, path: string): LaunchObservation {
  const row = object(
    value,
    [
      "workerUrl",
      "executedIdentity",
      "workerStartedAt",
      "runtimeManifestVersion",
      "onInstalled",
      "onInstalledObservedForMs",
      "registrations",
      "contextServiceWorkers",
      "marker",
    ],
    path,
  );
  const marker = object(row.marker, ["present", "nonce"], `${path}.marker`);
  const present = boolean(marker.present, `${path}.marker.present`);
  const nonce = nullable(marker.nonce, `${path}.marker.nonce`, text);
  if (present !== (nonce !== null)) throw new Error(`${path}.marker: nonce must accompany presence`);
  return {
    workerUrl: text(row.workerUrl, `${path}.workerUrl`),
    executedIdentity: text(row.executedIdentity, `${path}.executedIdentity`),
    workerStartedAt: instant(row.workerStartedAt, `${path}.workerStartedAt`),
    runtimeManifestVersion: text(row.runtimeManifestVersion, `${path}.runtimeManifestVersion`, manifestVersion),
    onInstalled: list(row.onInstalled, 0, 8, `${path}.onInstalled`, (entry, at) => {
      const installed = object(entry, ["reason", "previousVersion", "observedAt"], at);
      return {
        reason: text(installed.reason, `${at}.reason`, /^[a-z_]{1,32}$/),
        previousVersion: nullable(installed.previousVersion, `${at}.previousVersion`, (value, p) =>
          text(value, p, manifestVersion),
        ),
        observedAt: instant(installed.observedAt, `${at}.observedAt`),
      };
    }),
    onInstalledObservedForMs: integer(row.onInstalledObservedForMs, `${path}.onInstalledObservedForMs`, 60_000),
    registrations: list(row.registrations, 0, 8, `${path}.registrations`, (entry, at) => {
      const registration = object(entry, ["scope", "active", "waiting", "installing"], at);
      return {
        scope: text(registration.scope, `${at}.scope`),
        active: nullable(registration.active, `${at}.active`, text),
        waiting: nullable(registration.waiting, `${at}.waiting`, text),
        installing: nullable(registration.installing, `${at}.installing`, text),
      };
    }),
    contextServiceWorkers: list(row.contextServiceWorkers, 0, 8, `${path}.contextServiceWorkers`, (entry, at) =>
      text(entry, at),
    ),
    marker: { present, nonce },
  };
}

function capture(value: unknown, stage: CaptureStage, path: string): Capture {
  const keys = ["arm", "stage", "launch", "run", "profile", "chromiumVersion", "capturedAt", "observation"];
  const failed = (value as Record<string, unknown> | null)?.observation === null;
  const row = object(value, failed ? [...keys, "failure"] : keys, path);
  if (row.stage !== stage) throw new Error(`${path}.stage: expected ${stage}`);
  if (row.launch !== stageLaunch[stage]) throw new Error(`${path}.launch: expected ${stageLaunch[stage]}`);
  const base: CaptureBase = {
    arm: member(row.arm, replacementArms, `${path}.arm`),
    stage,
    launch: stageLaunch[stage],
    run: text(row.run, `${path}.run`),
    profile: text(row.profile, `${path}.profile`),
    chromiumVersion: text(row.chromiumVersion, `${path}.chromiumVersion`, chromiumVersion),
    capturedAt: instant(row.capturedAt, `${path}.capturedAt`),
  };
  if (!failed) return { ...base, observation: observation(row.observation, `${path}.observation`) };
  const failure = object(row.failure, ["code", "message"], `${path}.failure`);
  return {
    ...base,
    observation: null,
    failure: {
      code: member(failure.code, captureFailureCodes, `${path}.failure.code`),
      message: text(failure.message, `${path}.failure.message`),
    },
  };
}

function arm(value: unknown, name: ReplacementArm, path: string): ArmRecord {
  const row = object(
    value,
    ["name", "profile", "markerNonce", "bundles", "stagings", "captures", "loadUnpacked"],
    path,
  );
  if (row.name !== name) throw new Error(`${path}.name: expected ${name} in canonical order`);
  const bundles = object(row.bundles, ["A", "B"], `${path}.bundles`);
  const stagings = list(row.stagings, 2, 2, `${path}.stagings`, (entry, at, index) =>
    staging(entry, index === 0 ? "A" : "B", at),
  );
  const stages = captureStages[name];
  const captures = list(row.captures, stages.length, stages.length, `${path}.captures`, (entry, at, index) =>
    capture(entry, stages[index]!, at),
  );
  let loadUnpacked: LoadUnpackedRecord | null = null;
  if (name === "cdp-load-unpacked") {
    const load = object(row.loadUnpacked, ["route", "requestedAt", "extensionId", "error"], `${path}.loadUnpacked`);
    if (load.route !== "Extensions.loadUnpacked") throw new Error(`${path}.loadUnpacked.route: unexpected route`);
    loadUnpacked = {
      route: "Extensions.loadUnpacked",
      requestedAt: instant(load.requestedAt, `${path}.loadUnpacked.requestedAt`),
      extensionId: nullable(load.extensionId, `${path}.loadUnpacked.extensionId`, text),
      error: nullable(load.error, `${path}.loadUnpacked.error`, text),
    };
    if ((loadUnpacked.extensionId === null) === (loadUnpacked.error === null))
      throw new Error(`${path}.loadUnpacked: expected exactly one of extensionId or error`);
  } else if (row.loadUnpacked !== null) throw new Error(`${path}.loadUnpacked: only cdp-load-unpacked re-registers`);
  return {
    name,
    profile: text(row.profile, `${path}.profile`),
    markerNonce: text(row.markerNonce, `${path}.markerNonce`, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
    bundles: { A: bundle(bundles.A, "A", `${path}.bundles.A`), B: bundle(bundles.B, "B", `${path}.bundles.B`) },
    stagings: stagings as [StagingRecord, StagingRecord],
    captures,
    loadUnpacked,
  };
}

const bodyKeys = ["schema", "schemaVersion", "run", "pins", "extension", "arms"];

// A body may carry its recorded selection; the selector always recomputes it.
function parseBody(value: unknown): { body: ReplacementBody; recorded: ReplacementMechanism | null } {
  const recorded =
    value !== null && typeof value === "object" && "selectedReplacementMechanism" in value
      ? member(value.selectedReplacementMechanism, replacementMechanisms, "record.selectedReplacementMechanism")
      : null;
  const record = object(value, recorded ? [...bodyKeys, "selectedReplacementMechanism"] : bodyKeys, "record");
  if (record.schema !== "extension-code-replacement-qualification") throw new Error("record.schema: unexpected");
  if (record.schemaVersion !== 1) throw new Error("record.schemaVersion: expected 1");
  const run = object(
    record.run,
    ["id", "sourceHead", "checkoutHead", "runId", "runAttempt", "job", "capturedAt"],
    "record.run",
  );
  const runId = text(run.runId, "record.run.runId", /^[A-Za-z0-9._-]{1,64}$/);
  const runAttempt = text(run.runAttempt, "record.run.runAttempt", /^[1-9]\d{0,3}$/);
  if (run.id !== `${runId}/${runAttempt}`) throw new Error("record.run.id: expected runId/runAttempt");
  const pins = object(record.pins, ["playwrightVersion", "chromiumVersion"], "record.pins");
  const extension = object(record.extension, ["id", "syntheticKeySha256"], "record.extension");
  if (!Array.isArray(record.arms) || record.arms.length < 2 || record.arms.length > replacementArms.length)
    throw new Error("record.arms: expected the required arms and optionally cdp-load-unpacked");
  const body: ReplacementBody = {
    schema: "extension-code-replacement-qualification",
    schemaVersion: 1,
    run: {
      id: `${runId}/${runAttempt}`,
      sourceHead: text(run.sourceHead, "record.run.sourceHead", commit),
      checkoutHead: text(run.checkoutHead, "record.run.checkoutHead", commit),
      runId,
      runAttempt,
      job: text(run.job, "record.run.job", /^[A-Za-z0-9._-]{1,128}$/),
      capturedAt: instant(run.capturedAt, "record.run.capturedAt"),
    },
    pins: {
      playwrightVersion: text(pins.playwrightVersion, "record.pins.playwrightVersion", playwrightVersion),
      chromiumVersion: text(pins.chromiumVersion, "record.pins.chromiumVersion", chromiumVersion),
    },
    extension: {
      id: text(extension.id, "record.extension.id", extensionId),
      syntheticKeySha256: text(extension.syntheticKeySha256, "record.extension.syntheticKeySha256", sha256),
    },
    arms: record.arms.map((entry, index) => arm(entry, replacementArms[index]!, `record.arms[${index}]`)),
  };
  return { body, recorded };
}

function compareVersions(left: string, right: string) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const sameDigests = (left: FileDigest[], right: FileDigest[]) => JSON.stringify(left) === JSON.stringify(right);

function armFailures(body: ReplacementBody, row: ArmRecord): string[] {
  const failures: string[] = [];
  const pinned = armFixtureVersions[row.name];
  const { A, B } = row.bundles;
  if (A.manifestVersion !== pinned.A || A.syntheticVersion !== pinned.syntheticA)
    failures.push(`bundle A version ${A.manifestVersion} does not match the arm pin ${pinned.A}`);
  if (B.manifestVersion !== consumedVersion || B.syntheticVersion)
    failures.push(`bundle B version ${B.manifestVersion} is not ${consumedVersion}`);
  if (row.name === "version-ordered-install" && compareVersions(A.manifestVersion, B.manifestVersion) >= 0)
    failures.push("bundle A version is not strictly lower than B");
  for (const entry of [A, B])
    if (entry.identity !== `SYNTHETIC-9257:${row.name}:${entry.label}`)
      failures.push(`bundle ${entry.label} identity is not compiled for this arm`);
  const worker = (entry: BundleRecord) => entry.files.find((file) => file.name === "worker.js")?.sha256;
  if (!worker(A) || !worker(B) || worker(A) === worker(B)) failures.push("A and B worker bytes are not distinct");
  row.stagings.forEach((entry, index) => {
    const built = index === 0 ? A : B;
    if (!sameDigests(entry.source, built.files) || !sameDigests(entry.staged, entry.source))
      failures.push(`staged ${entry.bundle} set differs from its built set`);
  });
  const timeline = [row.stagings[0].stagedAt];
  for (const entry of row.captures) {
    if (entry.arm !== row.name || entry.profile !== row.profile || entry.run !== body.run.id)
      failures.push(`${entry.stage} capture is spliced from another arm, profile or run`);
    if (entry.chromiumVersion !== replacementPins.chromiumVersion)
      failures.push(`${entry.stage} capture ran Chromium ${entry.chromiumVersion}`);
    if (entry.stage === "relaunch") timeline.push(row.stagings[1].stagedAt);
    if (entry.stage === "load-unpacked" && row.loadUnpacked) timeline.push(row.loadUnpacked.requestedAt);
    timeline.push(entry.capturedAt);
    if (!entry.observation) {
      failures.push(`${entry.stage} capture is incomplete: ${entry.failure.code}`);
      continue;
    }
    if (entry.observation.workerUrl !== `chrome-extension://${body.extension.id}/worker.js`)
      failures.push(`${entry.stage} worker URL is not the fixture worker`);
    const expected = executedExpectations[row.name][entry.stage];
    if (!expected) continue;
    const executed = row.bundles[expected];
    if (entry.observation.executedIdentity !== executed.identity)
      failures.push(`${entry.stage} executed ${entry.observation.executedIdentity}, not ${executed.identity}`);
    if (entry.observation.runtimeManifestVersion !== executed.manifestVersion)
      failures.push(`${entry.stage} runtime version ${entry.observation.runtimeManifestVersion}`);
    if (!entry.observation.marker.present || entry.observation.marker.nonce !== row.markerNonce)
      failures.push(`${entry.stage} IndexedDB marker did not survive`);
  }
  for (let index = 1; index < timeline.length; index++)
    if (timeline[index - 1]! > timeline[index]!) failures.push("captures and stagings are out of order");
  if (
    row.name === "cdp-load-unpacked" &&
    (row.loadUnpacked?.error || row.loadUnpacked?.extensionId !== body.extension.id)
  )
    failures.push(`Extensions.loadUnpacked did not re-register ${body.extension.id}`);
  return failures;
}

// Fail closed: anything that does not parse, any pin mismatch, splice, incomplete capture, a recorded
// selection the selector disagrees with, or an arm (a) that did not reproduce the stale identity selects
// NONE. Arm (b) wins when both candidates qualify.
export function assessReplacement(value: unknown): ReplacementAssessment {
  const failures: ReplacementAssessment["failures"] = {
    record: [],
    "same-version-byte-swap": [],
    "version-ordered-install": [],
    "cdp-load-unpacked": [],
  };
  let body: ReplacementBody;
  let recorded: ReplacementMechanism | null;
  try {
    ({ body, recorded } = parseBody(value));
  } catch (error) {
    return { selected: "NONE", parseError: error instanceof Error ? error.message : String(error), failures };
  }
  if (body.pins.playwrightVersion !== replacementPins.playwrightVersion)
    failures.record.push(`Playwright ${body.pins.playwrightVersion} is not ${replacementPins.playwrightVersion}`);
  if (body.pins.chromiumVersion !== replacementPins.chromiumVersion)
    failures.record.push(`Chromium ${body.pins.chromiumVersion} is not ${replacementPins.chromiumVersion}`);
  if (new Set(body.arms.map((entry) => entry.profile)).size !== body.arms.length)
    failures.record.push("arms share a profile");
  if (new Set(body.arms.map((entry) => entry.markerNonce)).size !== body.arms.length)
    failures.record.push("arms share a marker");
  for (const entry of body.arms) failures[entry.name].push(...armFailures(body, entry));
  if (body.arms.length < replacementArms.length) failures["cdp-load-unpacked"].push("arm not run");
  const control = failures.record.length === 0 && failures["same-version-byte-swap"].length === 0;
  const selected: ReplacementMechanism = !control
    ? "NONE"
    : failures["version-ordered-install"].length === 0
      ? "version-ordered-install"
      : failures["cdp-load-unpacked"].length === 0
        ? "cdp-load-unpacked"
        : "NONE";
  if (recorded !== null && recorded !== selected) {
    failures.record.push(`recorded selection ${recorded} does not match the strict selector's ${selected}`);
    return { selected: "NONE", parseError: null, failures };
  }
  return { selected, parseError: null, failures };
}

export const selectReplacementMechanism = (value: unknown) => assessReplacement(value).selected;

export function buildReplacementRecord(body: ReplacementBody): ReplacementRecord {
  return { ...body, selectedReplacementMechanism: selectReplacementMechanism(body) };
}

export function parseReplacementRecord(value: unknown): ReplacementRecord {
  const { body, recorded } = parseBody(value);
  if (recorded === null) throw new Error("record: expected exactly selectedReplacementMechanism");
  if (recorded !== selectReplacementMechanism(body))
    throw new Error("record.selectedReplacementMechanism: does not match the strict selector");
  return { ...body, selectedReplacementMechanism: recorded };
}
