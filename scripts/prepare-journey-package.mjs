import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import {
  JourneyPackageRefusal,
  artifactName,
  caps,
  captureEntryFor,
  checkpointNames,
  checkpoints,
  classifyAttachment,
  failureClassifications,
  isOffsetInstant,
  isPlainObject,
  isRepoLocation,
  journeyPackageRecordSchemaVersion,
  journeyPackageSchemaVersion,
  journeyPackageTarget,
  knownLocatorNames,
  packageKinds,
  packageRoot,
  producerOutcomes,
  rawRoot,
  recordDirectory,
  refuse,
  requireClosed,
  resultStates,
  stagingRoot,
  testOutcomes,
  testStatuses,
  timelineAttachmentName,
  timelineCompleteness,
  timelineContract,
  titlePattern,
  validateResult,
  validateTimeline,
} from "./lib/journey-package-contract.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const shaPattern = /^[0-9a-f]{40}$/;
const recordCap = 1024 * 1024;
const enrollmentReadBound = 16 * 1024 * 1024;
const maxRawPixelBytes = 256 * 1024 * 1024;
const failedStates = ["failed", "timed-out", "interrupted", "not-executed"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encodeJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function gitIn(root) {
  return (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

function envInteger(env, name, pattern) {
  const value = typeof env[name] === "string" ? env[name] : "";
  const number = Number(value);
  if (!pattern.test(value) || !Number.isSafeInteger(number)) refuse("identity-invalid", { path: name });
  return number;
}

function envPattern(env, name, pattern) {
  const value = typeof env[name] === "string" ? env[name] : "";
  if (!pattern.test(value)) refuse("identity-invalid", { path: name });
  return value;
}

// Identity comes from the job context and the checkout identity step; the
// checkout is re-read here and must still be the commit and tree it captured.
export function readPackagingIdentity(env, git) {
  const producerOutcome = env.JOURNEY_PACKAGE_PRODUCER_OUTCOME;
  if (!producerOutcomes.includes(producerOutcome)) {
    refuse("identity-invalid", { path: "JOURNEY_PACKAGE_PRODUCER_OUTCOME" });
  }
  const identity = {
    sourceHead: envPattern(env, "JOURNEY_PACKAGE_SOURCE_HEAD", shaPattern),
    checkout: {
      sha: envPattern(env, "JOURNEY_PACKAGE_CHECKOUT_SHA", shaPattern),
      ref: envPattern(env, "GITHUB_REF", /^refs\/(?!.*\.\.)[A-Za-z0-9._/-]{1,240}$/),
      tree: envPattern(env, "JOURNEY_PACKAGE_CHECKOUT_TREE", shaPattern),
    },
    run: {
      id: envInteger(env, "GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/),
      attempt: envInteger(env, "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]{0,3}$/),
    },
    job: {
      checkRunId: envInteger(env, "JOURNEY_PACKAGE_CHECK_RUN_ID", /^[1-9][0-9]{0,19}$/),
      index: envInteger(env, "JOURNEY_PACKAGE_JOB_INDEX", /^(?:0|[1-9][0-9]{0,3})$/),
      batch: envPattern(env, "JOURNEY_PACKAGE_SUITE_BATCH", /^[a-z0-9_]{1,64}(?:,[a-z0-9_]{1,64}){0,15}$/),
    },
    producerOutcome,
  };
  if (git("rev-parse", "--verify", "HEAD^{commit}") !== identity.checkout.sha) refuse("checkout-mismatch");
  if (git("rev-parse", "--verify", "HEAD^{tree}") !== identity.checkout.tree) refuse("checkout-mismatch");
  return identity;
}

// Every path component below the root must be a real directory or file.
function containedFile(root, relative, base = rawRoot) {
  if (typeof relative !== "string" || relative === "" || path.isAbsolute(relative)) refuse("containment");
  if (relative.split(/[\\/]/).some((segment) => segment === ".." || segment === "")) refuse("containment");
  const baseDirectory = path.resolve(root, base);
  const file = path.resolve(baseDirectory, relative);
  const inside = path.relative(baseDirectory, file);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) refuse("containment");
  let current = path.resolve(root);
  for (const segment of path.relative(current, file).split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      refuse("containment");
    }
    if (stat.isSymbolicLink()) refuse("containment");
    if (current !== file && !stat.isDirectory()) refuse("containment");
    if (current === file && !stat.isFile()) refuse("containment");
  }
  return { file, bytes: lstatSync(file).size };
}

function readRecord(root) {
  const relative = `${recordDirectory}/record.json`;
  try {
    lstatSync(path.resolve(root, rawRoot, relative));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  const { file, bytes } = containedFile(root, relative);
  if (bytes > recordCap) refuse("record-invalid");
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    refuse("record-invalid");
  }
  return validateRecord(value);
}

function validateRecord(value) {
  const code = "record-invalid";
  requireClosed(value, ["schemaVersion", "run", "targets"], code, "record");
  if (value.schemaVersion !== journeyPackageRecordSchemaVersion) refuse(code, { path: "record.schemaVersion" });
  requireClosed(value.run, ["id", "attempt"], code, "record.run");
  if (typeof value.run.id !== "string" || typeof value.run.attempt !== "string") refuse(code, { path: "record.run" });
  if (!Array.isArray(value.targets) || value.targets.length > 8) refuse(code, { path: "record.targets" });
  value.targets.forEach((target, index) => validateRecordTarget(target, `record.targets[${index}]`));
  return value;
}

function validateRecordTarget(target, at) {
  const code = "record-invalid";
  requireClosed(target, ["file", "title", "project", "expectedStatus", "outcome", "attempts"], code, at);
  if (typeof target.file !== "string" || typeof target.project !== "string") refuse(code, { path: at });
  if (typeof target.title !== "string" || target.title.length > 1024) refuse(code, { path: `${at}.title` });
  if (!testStatuses.includes(target.expectedStatus)) refuse(code, { path: `${at}.expectedStatus` });
  if (!testOutcomes.includes(target.outcome)) refuse(code, { path: `${at}.outcome` });
  if (!Array.isArray(target.attempts) || target.attempts.length > 8) refuse(code, { path: `${at}.attempts` });
  target.attempts.forEach((attempt, index) => {
    const where = `${at}.attempts[${index}]`;
    requireClosed(attempt, ["retry", "status", "durationMs", "failure", "candidates", "excluded"], code, where);
    if (attempt.retry !== index) refuse(code, { path: `${where}.retry` });
    if (!testStatuses.includes(attempt.status)) refuse(code, { path: `${where}.status` });
    if (!Number.isSafeInteger(attempt.durationMs) || attempt.durationMs < 0 || attempt.durationMs > 86_400_000) {
      refuse(code, { path: `${where}.durationMs` });
    }
    if (attempt.failure !== null) {
      requireClosed(attempt.failure, ["classification", "knownLocator", "location"], code, `${where}.failure`);
      if (!failureClassifications.includes(attempt.failure.classification)) refuse(code, { path: where });
      if (!knownLocatorNames.includes(attempt.failure.knownLocator)) refuse(code, { path: where });
      if (attempt.failure.location !== null && !isRepoLocation(attempt.failure.location)) {
        refuse(code, { path: where });
      }
    }
    if (index > 0) {
      if (attempt.candidates !== null || attempt.excluded !== null) refuse(code, { path: where });
      return;
    }
    requireClosed(attempt.excluded, ["automatic", "unlisted", "png"], code, `${where}.excluded`);
    for (const count of Object.values(attempt.excluded)) {
      if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) refuse(code, { path: `${where}.excluded` });
    }
    if (!Array.isArray(attempt.candidates) || attempt.candidates.length > 64) {
      refuse(code, { path: `${where}.candidates` });
    }
    attempt.candidates.forEach((candidate, position) => {
      const place = `${where}.candidates[${position}]`;
      requireClosed(candidate, ["name", "contentType", "file", "attachedAt"], code, place);
      if (!["timeline", "capture"].includes(classifyAttachment(candidate.name))) refuse(code, { path: place });
      if (typeof candidate.contentType !== "string" || candidate.contentType.length > 128) {
        refuse(code, { path: place });
      }
      if (candidate.file !== null && (typeof candidate.file !== "string" || candidate.file.length > 512)) {
        refuse(code, { path: place });
      }
      if (candidate.attachedAt !== null && !isOffsetInstant(candidate.attachedAt)) refuse(code, { path: place });
    });
  });
}

// Mirrors Playwright's test outcome so a record whose attempts and outcome
// disagree (stale or mixed attempts) never qualifies.
function outcomeOf(target) {
  let expected = 0;
  let unexpected = 0;
  let skipped = 0;
  for (const attempt of target.attempts) {
    if (attempt.status === "interrupted") continue;
    if (attempt.status === "skipped") {
      if (target.expectedStatus === "skipped") skipped += 1;
    } else if (attempt.status === target.expectedStatus) expected += 1;
    else unexpected += 1;
  }
  if (expected === 0 && unexpected === 0) return "skipped";
  if (unexpected === 0) return "expected";
  if (expected === 0 && skipped === 0) return "unexpected";
  return "flaky";
}

// The first attempt is the only authoritative attempt; later attempts only
// decide whether a failed first attempt was retry-recovered.
export function deriveState(target) {
  if (outcomeOf(target) !== target.outcome) refuse("record-invalid", { path: "record.targets[0].outcome" });
  if (target.attempts.length === 0) return "not-executed";
  const first = target.attempts[0];
  if (first.status === "skipped") return "skipped";
  if (first.status === "interrupted") return "interrupted";
  if (first.status === target.expectedStatus) {
    if (target.expectedStatus !== "passed") return "expected-failure";
    if (target.attempts.length !== 1) refuse("record-invalid", { path: "record.targets[0].attempts" });
    return "passed";
  }
  if (target.outcome === "flaky") return "retry-recovered";
  return first.status === "timedOut" ? "timed-out" : "failed";
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const textChunkTypes = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

function pngChunks(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(pngSignature)) refuse("capture-invalid");
  const chunks = [];
  let offset = 8;
  while (chunks.at(-1)?.type !== "IEND") {
    if (offset + 12 > bytes.length) refuse("capture-invalid");
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > bytes.length) refuse("capture-invalid");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) refuse("capture-invalid");
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      refuse("capture-invalid");
    }
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  if (offset !== bytes.length || chunks.at(-1).data.length !== 0) refuse("capture-invalid");
  return chunks;
}

// Accepts only 8-bit RGB/RGBA, non-interlaced PNGs whose CRC-checked IDAT
// inflates to exactly the scanlines IHDR declares. Text and EXIF chunks refuse;
// other ancillary chunks are dropped, or refused when `strict`.
function decodeCapturePng(bytes, expectedWidth, { strict }) {
  const chunks = pngChunks(bytes);
  const [header, ...rest] = chunks;
  if (header.type !== "IHDR" || header.data.length !== 13) refuse("capture-invalid");
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [bitDepth, colorType, compression, filter, interlace] = header.data.subarray(8);
  if (width !== expectedWidth || height < 1 || height > 65_535) refuse("capture-invalid");
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || compression !== 0 || filter !== 0 || interlace !== 0) {
    refuse("capture-invalid");
  }
  const data = [];
  let idatClosed = false;
  for (const chunk of rest.slice(0, -1)) {
    if (textChunkTypes.has(chunk.type)) refuse("capture-invalid");
    if (chunk.type === "IDAT") {
      if (idatClosed) refuse("capture-invalid");
      data.push(chunk.data);
      continue;
    }
    if (data.length > 0) idatClosed = true;
    if (strict || chunk.type[0] === chunk.type[0].toUpperCase()) refuse("capture-invalid");
  }
  if (data.length === 0) refuse("capture-invalid");
  const rowBytes = width * (colorType === 6 ? 4 : 3) + 1;
  const expectedBytes = rowBytes * height;
  if (expectedBytes > maxRawPixelBytes) refuse("capture-invalid");
  const compressed = Buffer.concat(data);
  let inflated;
  try {
    inflated = inflateSync(compressed, { info: true, maxOutputLength: expectedBytes });
  } catch {
    refuse("capture-invalid");
  }
  if (inflated.buffer.length !== expectedBytes || inflated.engine.bytesWritten !== compressed.length) {
    refuse("capture-invalid");
  }
  for (let row = 0; row < height; row += 1) if (inflated.buffer[row * rowBytes] > 4) refuse("capture-invalid");
  return { header: header.data, pixels: inflated.buffer };
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function rebuildCapturePng(bytes, expectedWidth) {
  const { header, pixels } = decodeCapturePng(bytes, expectedWidth, { strict: false });
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function requireCap(bytes, cap, file) {
  if (bytes > cap) refuse("over-cap", { path: file, detail: { bytes, cap } });
}

function readCandidate(root, candidate, cap, role) {
  if (candidate.file === null) refuse("containment", { path: role });
  const { file, bytes } = containedFile(root, candidate.file);
  requireCap(bytes, cap, role);
  return readFileSync(file);
}

// A timeline candidate enrolls the target only when it declares this contract.
function enrolledTimeline(root, candidate) {
  if (candidate.file === null) refuse("containment", { path: "timeline.json" });
  const { file, bytes } = containedFile(root, candidate.file);
  if (bytes > enrollmentReadBound) refuse("over-cap", { path: "timeline.json", detail: { bytes, cap: caps.timeline } });
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.contract !== timelineContract) return null;
  requireCap(bytes, caps.timeline, "timeline.json");
  if (candidate.contentType !== "application/json") refuse("timeline-invalid", { path: "timeline.contentType" });
  return validateTimeline(value);
}

function buildCaptures(root, first, timeline) {
  const captures = [];
  const seen = new Set();
  for (const candidate of first.candidates.filter((entry) => classifyAttachment(entry.name) === "capture")) {
    const role = `captures/${candidate.name}.png`;
    if (seen.has(candidate.name)) refuse("capture-conflict", { path: role });
    seen.add(candidate.name);
    if (candidate.contentType !== "image/png") refuse("capture-invalid", { path: role });
    const entry = captureEntryFor(timeline, candidate.name);
    if (!entry || candidate.attachedAt === null || Date.parse(candidate.attachedAt) < Date.parse(entry.at)) {
      refuse("capture-provenance", { path: role });
    }
    const source = readCandidate(root, candidate, caps.capture, role);
    let rebuilt;
    try {
      rebuilt = rebuildCapturePng(source, checkpoints[candidate.name].viewport.width);
    } catch (error) {
      if (error instanceof JourneyPackageRefusal) refuse(error.code, { path: role });
      throw error;
    }
    requireCap(rebuilt.length, caps.capture, role);
    captures.push({ checkpoint: candidate.name, path: role, bytes: rebuilt });
  }
  return captures.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function resultProjection(target, state, first) {
  return validateResult({
    state,
    expectedStatus: target.expectedStatus,
    status: first?.status ?? null,
    outcome: first ? target.outcome : null,
    retry: 0,
    durationMs: first?.durationMs ?? null,
    classification: first?.failure?.classification ?? null,
    knownLocator: first?.failure?.knownLocator ?? null,
    location: first?.failure?.location ?? null,
  });
}

function summaryOutcome(state, excluded) {
  return { status: "summary", state, excluded: excluded ?? null };
}

// Rebuilds the package from parsed values, stages it, validates the staged
// bytes as a downloader would, and only then renames it into place.
export function prepareJourneyPackage({ root = repoRoot, env = process.env, git, now = () => new Date() } = {}) {
  const packageDirectory = path.join(root, packageRoot);
  const stagingDirectory = path.join(root, stagingRoot);
  rmSync(packageDirectory, { recursive: true, force: true });
  rmSync(stagingDirectory, { recursive: true, force: true });
  try {
    const record = readRecord(root);
    if (record === null || record.targets.length === 0) return summaryOutcome("absent", null);
    const identity = readPackagingIdentity(env, git ?? gitIn(root));
    if (record.run.id !== String(identity.run.id) || record.run.attempt !== String(identity.run.attempt)) {
      refuse("record-stale");
    }
    if (record.targets.length !== 1) refuse("target-conflict");
    const [target] = record.targets;
    if (target.file !== journeyPackageTarget.file || target.project !== journeyPackageTarget.project) {
      refuse("target-conflict");
    }
    const state = deriveState(target);
    if (identity.producerOutcome === "success" && failedStates.includes(state)) refuse("outcome-conflict");
    const first = target.attempts[0] ?? null;
    const result = resultProjection(target, state, first);
    let timeline = null;
    let captures = [];
    if (first !== null) {
      const timelines = first.candidates.filter((candidate) => candidate.name === timelineAttachmentName);
      if (timelines.length > 1) refuse("timeline-conflict");
      timeline = timelines.length === 1 ? enrolledTimeline(root, timelines[0]) : null;
      if (timeline === null) return summaryOutcome("unenrolled", first.excluded);
      captures = buildCaptures(root, first, timeline);
    }
    if (!titlePattern.test(target.title)) refuse("record-invalid", { path: "record.targets[0].title" });
    const milestones = timeline === null ? null : timelineCompleteness(timeline);
    const missingCapture = checkpointNames.find((name) => !captures.some((capture) => capture.checkpoint === name));
    const complete = milestones?.complete === true && missingCapture === undefined;
    const kind = identity.producerOutcome === "success" && state === "passed" ? "success" : "diagnostics";
    if (kind === "success" && !milestones.complete) refuse("timeline-incomplete", { path: milestones.missing[0] });
    if (kind === "success" && missingCapture !== undefined) refuse("capture-incomplete", { path: missingCapture });
    const files = [{ path: "result.json", type: "result", checkpoint: null, bytes: encodeJson(result) }];
    if (timeline !== null)
      files.push({ path: "timeline.json", type: "timeline", checkpoint: null, bytes: encodeJson(timeline) });
    for (const capture of captures) files.push({ ...capture, type: "capture" });
    requireCap(files[0].bytes.length, caps.result, "result.json");
    if (timeline !== null) requireCap(files[1].bytes.length, caps.timeline, "timeline.json");
    const name = artifactName(kind, identity.run.id, identity.run.attempt, identity.job.index);
    const manifest = {
      schemaVersion: journeyPackageSchemaVersion,
      artifactName: name,
      package: kind,
      state,
      partial: kind === "diagnostics" && !(state === "passed" && complete),
      identity: {
        sourceHead: identity.sourceHead,
        checkout: identity.checkout,
        run: identity.run,
        job: identity.job,
        test: { file: target.file, title: target.title, project: target.project, retry: 0 },
        producerOutcome: identity.producerOutcome,
        capturedAt: now().toISOString(),
      },
      files: files
        .map((file) => ({
          path: file.path,
          type: file.type,
          checkpoint: file.checkpoint,
          bytes: file.bytes.length,
          sha256: sha256(file.bytes),
        }))
        .sort((left, right) => left.path.localeCompare(right.path, "en")),
    };
    const manifestBytes = encodeJson(manifest);
    requireCap(manifestBytes.length, caps.manifest, "manifest.json");
    mkdirSync(path.join(stagingDirectory, captures.length > 0 ? "captures" : ""), { recursive: true });
    for (const file of files) writeFileSync(path.join(stagingDirectory, file.path), file.bytes);
    writeFileSync(path.join(stagingDirectory, "manifest.json"), manifestBytes);
    inspectJourneyPackage(stagingDirectory, { identity: manifest.identity, artifactName: name });
    renameSync(stagingDirectory, packageDirectory);
    return {
      status: "published",
      state,
      package: kind,
      artifactName: name,
      partial: manifest.partial,
      files: manifest.files,
      excluded: first?.excluded ?? null,
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    rmSync(packageDirectory, { recursive: true, force: true });
    if (!(error instanceof JourneyPackageRefusal)) throw error;
    return { status: "refused", code: error.code, path: error.path, detail: error.detail };
  }
}

function listPackageFiles(directory) {
  const files = [];
  const visit = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) refuse("containment", { path: "package" });
      if (entry.isDirectory()) {
        if (relative !== "captures") refuse("inspect-mismatch", { path: "package" });
        visit(path.join(folder, entry.name), `${relative}/`);
      } else if (entry.isFile()) files.push(relative);
      else refuse("containment", { path: "package" });
    }
  };
  visit(directory, "");
  return files.sort();
}

function validateManifest(manifest) {
  const code = "inspect-mismatch";
  requireClosed(
    manifest,
    ["schemaVersion", "artifactName", "package", "state", "partial", "identity", "files"],
    code,
    "manifest",
  );
  if (manifest.schemaVersion !== journeyPackageSchemaVersion) refuse(code, { path: "manifest.schemaVersion" });
  if (!packageKinds.includes(manifest.package)) refuse(code, { path: "manifest.package" });
  if (!resultStates.includes(manifest.state)) refuse(code, { path: "manifest.state" });
  if (typeof manifest.partial !== "boolean") refuse(code, { path: "manifest.partial" });
  const identity = manifest.identity;
  requireClosed(
    identity,
    ["sourceHead", "checkout", "run", "job", "test", "producerOutcome", "capturedAt"],
    code,
    "manifest.identity",
  );
  requireClosed(identity.checkout, ["sha", "ref", "tree"], code, "manifest.identity.checkout");
  requireClosed(identity.run, ["id", "attempt"], code, "manifest.identity.run");
  requireClosed(identity.job, ["checkRunId", "index", "batch"], code, "manifest.identity.job");
  requireClosed(identity.test, ["file", "title", "project", "retry"], code, "manifest.identity.test");
  const shas = [identity.sourceHead, identity.checkout.sha, identity.checkout.tree];
  if (!shas.every((value) => shaPattern.test(value ?? ""))) refuse(code, { path: "manifest.identity" });
  if (typeof identity.checkout.ref !== "string" || !identity.checkout.ref.startsWith("refs/")) {
    refuse(code, { path: "manifest.identity.checkout.ref" });
  }
  const integers = [identity.run.id, identity.run.attempt, identity.job.checkRunId, identity.job.index];
  if (!integers.every((value) => Number.isSafeInteger(value) && value >= 0))
    refuse(code, { path: "manifest.identity" });
  if (typeof identity.job.batch !== "string") refuse(code, { path: "manifest.identity.job.batch" });
  if (identity.test.file !== journeyPackageTarget.file || identity.test.project !== journeyPackageTarget.project) {
    refuse(code, { path: "manifest.identity.test" });
  }
  if (typeof identity.test.title !== "string" || !titlePattern.test(identity.test.title) || identity.test.retry !== 0) {
    refuse(code, { path: "manifest.identity.test" });
  }
  if (!producerOutcomes.includes(identity.producerOutcome) || !isOffsetInstant(identity.capturedAt)) {
    refuse(code, { path: "manifest.identity" });
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 7) {
    refuse(code, { path: "manifest.files" });
  }
  manifest.files.forEach((file, index) => {
    const at = `manifest.files[${index}]`;
    requireClosed(file, ["path", "type", "checkpoint", "bytes", "sha256"], code, at);
    const expectedPath =
      file.type === "result"
        ? "result.json"
        : file.type === "timeline"
          ? "timeline.json"
          : file.type === "capture" && checkpointNames.includes(file.checkpoint)
            ? `captures/${file.checkpoint}.png`
            : null;
    if (expectedPath === null || file.path !== expectedPath) refuse(code, { path: at });
    if (file.type !== "capture" && file.checkpoint !== null) refuse(code, { path: at });
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256 ?? "")) {
      refuse(code, { path: at });
    }
  });
  return manifest;
}

// Validates a package directory exactly: inventory, caps, hashes, closed
// schemas, PNG structure and identity. Returns a receipt of closed values.
export function inspectJourneyPackage(directory, expected = {}) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    refuse("inspect-mismatch", { path: "package" });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("containment", { path: "package" });
  const inventory = listPackageFiles(directory);
  if (!inventory.includes("manifest.json")) refuse("inspect-mismatch", { path: "manifest.json" });
  const read = (relative, cap) => {
    const bytes = readFileSync(path.join(directory, relative));
    requireCap(bytes.length, cap, relative);
    return bytes;
  };
  let manifest;
  try {
    manifest = JSON.parse(read("manifest.json", caps.manifest).toString("utf8"));
  } catch (error) {
    if (error instanceof JourneyPackageRefusal) throw error;
    refuse("inspect-mismatch", { path: "manifest.json" });
  }
  validateManifest(manifest);
  const listed = manifest.files.map((file) => file.path);
  if (new Set(listed).size !== listed.length) refuse("inspect-mismatch", { path: "manifest.files" });
  if (JSON.stringify([...listed, "manifest.json"].sort()) !== JSON.stringify(inventory)) {
    refuse("inspect-mismatch", { path: "package" });
  }
  const contents = new Map();
  for (const file of manifest.files) {
    const cap = file.type === "capture" ? caps.capture : file.type === "timeline" ? caps.timeline : caps.result;
    const bytes = read(file.path, cap);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) refuse("inspect-mismatch", { path: file.path });
    contents.set(file.path, bytes);
  }
  const parse = (relative) => {
    try {
      return JSON.parse(contents.get(relative).toString("utf8"));
    } catch {
      refuse("inspect-mismatch", { path: relative });
    }
  };
  if (!contents.has("result.json")) refuse("inspect-mismatch", { path: "result.json" });
  const result = validateResult(parse("result.json"), "inspect-mismatch");
  if (result.state !== manifest.state) refuse("inspect-mismatch", { path: "result.json" });
  const timeline = contents.has("timeline.json") ? validateTimeline(parse("timeline.json")) : null;
  const captures = manifest.files.filter((file) => file.type === "capture");
  if (captures.length > 0 && timeline === null) refuse("inspect-mismatch", { path: "timeline.json" });
  for (const capture of captures) {
    if (!captureEntryFor(timeline, capture.checkpoint)) refuse("capture-provenance", { path: capture.path });
    try {
      decodeCapturePng(contents.get(capture.path), checkpoints[capture.checkpoint].viewport.width, { strict: true });
    } catch (error) {
      if (error instanceof JourneyPackageRefusal) refuse(error.code, { path: capture.path });
      throw error;
    }
  }
  const complete =
    timeline !== null && timelineCompleteness(timeline).complete && captures.length === checkpointNames.length;
  const identity = manifest.identity;
  if (manifest.package === "success") {
    if (manifest.state !== "passed" || manifest.partial || !complete || identity.producerOutcome !== "success") {
      refuse("inspect-mismatch", { path: "manifest.package" });
    }
  } else if (manifest.partial !== !(manifest.state === "passed" && complete)) {
    refuse("inspect-mismatch", { path: "manifest.partial" });
  }
  if (manifest.state === "not-executed" && timeline !== null) refuse("inspect-mismatch", { path: "timeline.json" });
  if (manifest.state !== "not-executed" && timeline === null) refuse("inspect-mismatch", { path: "timeline.json" });
  const name = artifactName(manifest.package, identity.run.id, identity.run.attempt, identity.job.index);
  if (manifest.artifactName !== name) refuse("inspect-mismatch", { path: "manifest.artifactName" });
  const mismatch = (field, actual, wanted) => {
    if (wanted !== undefined && actual !== wanted) refuse("inspect-mismatch", { path: field });
  };
  mismatch("artifactName", manifest.artifactName, expected.artifactName);
  if (expected.identity !== undefined && JSON.stringify(identity) !== JSON.stringify(expected.identity)) {
    refuse("inspect-mismatch", { path: "manifest.identity" });
  }
  mismatch("test", identity.test.file, expected.test);
  mismatch("run", identity.run.id, expected.run);
  mismatch("attempt", identity.run.attempt, expected.attempt);
  mismatch("job", identity.job.checkRunId, expected.job);
  mismatch("jobIndex", identity.job.index, expected.jobIndex);
  mismatch("sourceHead", identity.sourceHead, expected.sourceHead);
  return {
    artifactName: manifest.artifactName,
    package: manifest.package,
    state: manifest.state,
    partial: manifest.partial,
    identity,
    files: manifest.files.map(({ path: file, bytes, sha256: digest }) => ({ path: file, bytes, sha256: digest })),
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function refusalLine(outcome) {
  const detail = outcome.detail ? ` (bytes=${outcome.detail.bytes}, cap=${outcome.detail.cap})` : "";
  return `refused: ${outcome.code}${outcome.path ? ` at ${outcome.path}` : ""}${detail}`;
}

function summaryLines(outcome) {
  const lines = ["### Journey package", ""];
  if (outcome.status === "published") {
    lines.push(
      `- published \`${outcome.artifactName}\` (${outcome.package}, state ${outcome.state}, partial ${outcome.partial})`,
    );
    lines.push(`- files: ${outcome.files.map((file) => `\`${file.path}\` ${file.bytes} B`).join(", ")}`);
  } else if (outcome.status === "summary") {
    lines.push(`- no package: target ${outcome.state}`);
  } else {
    lines.push(`- no package: ${refusalLine(outcome)}`);
  }
  if (outcome.excluded) {
    const { automatic, unlisted, png } = outcome.excluded;
    lines.push(`- excluded attachments: automatic ${automatic}, unlisted ${unlisted}, PNG ${png}`);
  }
  return lines;
}

function inspectExpectations(argv) {
  const integer = (name) => {
    const value = option(argv, name);
    if (!/^(?:0|[1-9][0-9]{0,19})$/.test(value ?? "")) throw new Error(`${name} must be a non-negative integer`);
    return Number(value);
  };
  const sourceHead = option(argv, "--expect-source-head");
  if (!shaPattern.test(sourceHead ?? "")) throw new Error("--expect-source-head must be a 40-character SHA");
  const test = option(argv, "--expect-test");
  if (typeof test !== "string") throw new Error("--expect-test is required");
  return {
    test,
    run: integer("--expect-run"),
    attempt: integer("--expect-attempt"),
    job: integer("--expect-job"),
    jobIndex: integer("--expect-job-index"),
    sourceHead,
  };
}

// The workflow step: `publish=true` only for a package that passed the staged
// inspection; a refusal exits non-zero; absent and unenrolled targets exit 0.
export function journeyPackageStep(options = {}) {
  const outcome = prepareJourneyPackage(options);
  return {
    outcome,
    exitCode: outcome.status === "refused" ? 1 : 0,
    outputs:
      outcome.status === "published"
        ? { publish: "true", "artifact-name": outcome.artifactName, package: outcome.package }
        : { publish: "false" },
    summary: summaryLines(outcome),
  };
}

function main(argv, env) {
  const inspectDirectory = option(argv, "--inspect");
  if (inspectDirectory !== undefined) {
    try {
      const receipt = inspectJourneyPackage(path.resolve(inspectDirectory), inspectExpectations(argv));
      console.log(JSON.stringify({ inspected: true, ...receipt }, null, 2));
    } catch (error) {
      if (!(error instanceof JourneyPackageRefusal)) throw error;
      console.error(`Journey package ${refusalLine({ code: error.code, path: error.path, detail: error.detail })}`);
      process.exitCode = 1;
    }
    return;
  }
  const rootOption = option(argv, "--root");
  const step = journeyPackageStep({ root: rootOption ? path.resolve(rootOption) : repoRoot, env });
  console.log(step.summary.slice(2).join("\n"));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${step.summary.join("\n")}\n`);
  if (env.GITHUB_OUTPUT) {
    const lines = Object.entries(step.outputs).map(([key, value]) => `${key}=${value}\n`);
    appendFileSync(env.GITHUB_OUTPUT, lines.join(""));
  }
  process.exitCode = step.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env);
}
