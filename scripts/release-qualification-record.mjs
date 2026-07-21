#!/usr/bin/env node
// Durable release-qualification records.
//
// The dedicated private `chase-sets-release-qualification` Space is the
// promotion authority for merge-queue qualification evidence. This module owns
// the `release-qualification/v1` record contract, the append-only attempt-key
// scheme, the head-before-put writer (byte-identical retries are idempotent,
// conflicting records at the same attempt key fail closed), and the fail-closed
// production reader that accepts only the exact selected record whose tree and
// digest match the release being promoted.
//
// Provider access uses ONLY the dedicated bucket-scoped Spaces credentials
// (RELEASE_EVIDENCE_SPACES_ACCESS_ID / RELEASE_EVIDENCE_SPACES_SECRET_KEY) and
// fails before any provider call when either is withheld. Broad Terraform-state
// Spaces credentials are never read here. No credential value is ever printed.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const RELEASE_QUALIFICATION_SCHEMA_VERSION = "release-qualification/v1";
// Cost wager (see the release-qualification-evidence runbook): each record is
// capped at 64 KiB so 30-day bucket usage stays within the ratified
// 1 GiB / $1-per-month wager.
export const RELEASE_QUALIFICATION_RECORD_MAX_BYTES = 64 * 1024;
export const RELEASE_QUALIFICATION_EVIDENCE_BUCKET = "chase-sets-release-qualification";
export const RELEASE_QUALIFICATION_SPACES_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
export const RELEASE_QUALIFICATION_ATTEMPT_PREFIX = "v1/attempts";
export const RELEASE_QUALIFICATION_CANARY_PREFIX = "v1/canary";
// A brand-new direct release may only trust qualification evidence younger
// than 24 hours. Rollback re-uses the record key retained in the previously
// promoted release manifest and is exempt from this age limit.
export const RELEASE_QUALIFICATION_MAX_NEW_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
const COMPLETED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// The two dedicated bucket-scoped Spaces credentials, stored in the
// `merge-gate` and `production` GitHub environments. Every provider-touching
// caller must thread exactly these names; the workflow credential guard in
// scripts/workflow-provider-credentials.mjs enforces the step-env contract.
export const RELEASE_EVIDENCE_SPACES_CREDENTIAL_ENV = Object.freeze([
  "RELEASE_EVIDENCE_SPACES_ACCESS_ID",
  "RELEASE_EVIDENCE_SPACES_SECRET_KEY",
]);

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_REPOSITORY_PATTERN = /^registry\.digitalocean\.com\/[a-z0-9][a-z0-9-]*\/chase-sets-platform$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LANE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9./_-]*$/;
const RESULTS = new Set(["pass", "fail"]);

export function buildReleaseQualificationRecord(input) {
  const record = {
    schemaVersion: RELEASE_QUALIFICATION_SCHEMA_VERSION,
    repository: normalize(input.repository),
    candidateSha: normalize(input.candidateSha).toLowerCase(),
    candidateTreeSha: normalize(input.candidateTreeSha).toLowerCase(),
    imageRepository: normalize(input.imageRepository),
    imageDigest: normalize(input.imageDigest).toLowerCase(),
    qualificationLane: normalize(input.qualificationLane),
    classifierPolicyVersion: normalize(input.classifierPolicyVersion),
    runId: normalize(input.runId),
    runAttempt: normalize(input.runAttempt),
    startedAt: normalize(input.startedAt),
    completedAt: normalize(input.completedAt),
    result: normalize(input.result),
    evidenceLinks: Array.isArray(input.evidenceLinks) ? input.evidenceLinks.map(normalize) : input.evidenceLinks,
  };
  return { record, errors: validateReleaseQualificationRecord(record) };
}

export function validateReleaseQualificationRecord(record) {
  const errors = [];
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["record must be a JSON object."];
  }

  if (record.schemaVersion !== RELEASE_QUALIFICATION_SCHEMA_VERSION) {
    return [
      `schemaVersion must be ${RELEASE_QUALIFICATION_SCHEMA_VERSION}; readers fail closed on any other version (got ${JSON.stringify(record.schemaVersion ?? null)}).`,
    ];
  }

  const knownFields = new Set([
    "schemaVersion",
    "repository",
    "candidateSha",
    "candidateTreeSha",
    "imageRepository",
    "imageDigest",
    "qualificationLane",
    "classifierPolicyVersion",
    "runId",
    "runAttempt",
    "startedAt",
    "completedAt",
    "result",
    "evidenceLinks",
  ]);
  for (const field of Object.keys(record)) {
    if (!knownFields.has(field)) {
      errors.push(`unknown field ${field} is not part of ${RELEASE_QUALIFICATION_SCHEMA_VERSION}.`);
    }
  }

  if (!REPOSITORY_PATTERN.test(record.repository ?? "")) {
    errors.push("repository must be an owner/name GitHub repository slug.");
  }
  if (!isCommitSha(record.candidateSha)) {
    errors.push("candidateSha must be the 40-character merge-group candidate commit SHA.");
  }
  if (!isCommitSha(record.candidateTreeSha)) {
    errors.push("candidateTreeSha must be the 40-character candidate git tree SHA.");
  }
  if (!IMAGE_REPOSITORY_PATTERN.test(record.imageRepository ?? "")) {
    errors.push("imageRepository must be an allowlisted Chase Sets DigitalOcean registry repository.");
  }
  if (!IMAGE_DIGEST_PATTERN.test(record.imageDigest ?? "")) {
    errors.push("imageDigest must be an immutable sha256 image digest.");
  }
  if (!LANE_PATTERN.test(record.qualificationLane ?? "")) {
    errors.push("qualificationLane must be a lowercase token naming the qualification lane.");
  }
  if (!POLICY_VERSION_PATTERN.test(record.classifierPolicyVersion ?? "")) {
    errors.push("classifierPolicyVersion must name the classifier policy version that gated this attempt.");
  }
  if (!isPositiveInteger(record.runId)) {
    errors.push("runId must be the positive integer GitHub Actions run id.");
  }
  if (!isPositiveInteger(record.runAttempt)) {
    errors.push("runAttempt must be the positive integer GitHub Actions run attempt.");
  }
  if (!isIsoInstant(record.startedAt)) {
    errors.push("startedAt must be an ISO-8601 UTC instant.");
  }
  if (!isIsoInstant(record.completedAt)) {
    errors.push("completedAt must be an ISO-8601 UTC instant.");
  } else if (isIsoInstant(record.startedAt) && Date.parse(record.completedAt) < Date.parse(record.startedAt)) {
    errors.push("completedAt must not precede startedAt.");
  }
  if (!RESULTS.has(record.result)) {
    errors.push("result must be pass or fail.");
  }
  if (!Array.isArray(record.evidenceLinks) || record.evidenceLinks.length === 0) {
    errors.push("evidenceLinks must be a non-empty array of https evidence URLs.");
  } else {
    for (const link of record.evidenceLinks) {
      if (typeof link !== "string" || !/^https:\/\/\S+$/.test(link)) {
        errors.push(`evidenceLinks entry ${JSON.stringify(link)} must be an https URL.`);
      }
    }
  }

  return errors;
}

// Append-only attempt keys: a requeued same-tree candidate lands at a distinct
// run/attempt key, so no two qualification attempts ever share a key and a
// conflicting object at an existing key can only mean tampering or reuse.
export function releaseQualificationAttemptKey(record, { prefix = RELEASE_QUALIFICATION_ATTEMPT_PREFIX } = {}) {
  return `${prefix}/${record.repository}/${record.candidateTreeSha}/${record.imageDigest}/${record.runId}-${record.runAttempt}.json`;
}

export function serializeReleaseQualificationRecord(record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > RELEASE_QUALIFICATION_RECORD_MAX_BYTES) {
    return {
      body: null,
      errors: [
        `record serializes to ${bytes} bytes, above the ${RELEASE_QUALIFICATION_RECORD_MAX_BYTES}-byte cost-wager cap; trim evidenceLinks.`,
      ],
    };
  }
  return { body, errors: [] };
}

// Head-before-put writer. Attempt keys embed the writer's own run id/attempt,
// so a same-key retry can only be this writer retrying: byte-identical bodies
// are idempotent successes, anything else fails closed without overwriting.
export async function writeReleaseQualificationRecord({ record, prefix }, storage) {
  const errors = validateReleaseQualificationRecord(record);
  if (errors.length > 0) {
    return { outcome: "invalid", key: null, errors };
  }

  const { body, errors: sizeErrors } = serializeReleaseQualificationRecord(record);
  if (sizeErrors.length > 0) {
    return { outcome: "invalid", key: null, errors: sizeErrors };
  }

  const key = releaseQualificationAttemptKey(record, prefix ? { prefix } : {});
  if (await storage.objectExists(key)) {
    const existing = await storage.getObject(key);
    if (existing === body) {
      return { outcome: "idempotent", key, errors: [] };
    }
    return {
      outcome: "conflict",
      key,
      errors: [
        `attempt key ${key} already holds a different record; qualification evidence is append-only and this write fails closed.`,
      ],
    };
  }

  await storage.putObject(key, body);
  return { outcome: "written", key, errors: [] };
}

// Fail-closed production reader. Consumes the exact record key selected during
// release resolution; never scans a prefix for "some old pass".
export function verifyReleaseQualificationRecord({ body, recordKey, expected }) {
  let record;
  try {
    record = JSON.parse(body);
  } catch {
    return { passed: false, record: null, errors: [`record at ${recordKey} is not valid JSON; failing closed.`] };
  }

  const errors = validateReleaseQualificationRecord(record);
  if (errors.length > 0) {
    return { passed: false, record, errors };
  }

  const derivedKey = releaseQualificationAttemptKey(record);
  if (derivedKey !== recordKey) {
    errors.push(`record content derives attempt key ${derivedKey} but was read from ${recordKey}; failing closed.`);
  }
  if (record.repository !== expected.repository) {
    errors.push(`record repository ${record.repository} does not match expected ${expected.repository}.`);
  }
  if (record.candidateTreeSha !== expected.treeSha) {
    errors.push(
      `record tree ${record.candidateTreeSha} does not match the release tree ${expected.treeSha} recomputed from the checked-out main SHA.`,
    );
  }
  if (record.imageDigest !== expected.imageDigest) {
    errors.push(
      `record image digest ${record.imageDigest} does not match the release image digest ${expected.imageDigest}.`,
    );
  }
  if (record.classifierPolicyVersion !== expected.classifierPolicyVersion) {
    errors.push(
      `record classifier policy version ${record.classifierPolicyVersion} does not match expected ${expected.classifierPolicyVersion}.`,
    );
  }
  if (record.result !== "pass") {
    errors.push(`record result is ${record.result}; only pass records authorize promotion.`);
  }

  const mode = expected.mode ?? "new-release";
  if (mode !== "new-release" && mode !== "rollback") {
    errors.push(`mode must be new-release or rollback (got ${JSON.stringify(mode)}).`);
  } else if (mode === "new-release") {
    const verifiedAt = Date.parse(expected.verifiedAt ?? "");
    const completedAt = Date.parse(record.completedAt);
    if (!Number.isFinite(verifiedAt)) {
      errors.push("expected.verifiedAt must be an ISO-8601 instant for new-release verification.");
    } else if (completedAt - verifiedAt > COMPLETED_AT_FUTURE_SKEW_MS) {
      errors.push(
        `record completedAt ${record.completedAt} is in the future relative to ${expected.verifiedAt}; failing closed.`,
      );
    } else if (verifiedAt - completedAt > RELEASE_QUALIFICATION_MAX_NEW_RELEASE_AGE_MS) {
      errors.push(
        `record completedAt ${record.completedAt} is older than the 24-hour limit for a new direct release; requalify the candidate. Rollback via the previously promoted release manifest is exempt.`,
      );
    }
  }

  return { passed: errors.length === 0, record, errors };
}

export async function resolveCommitTreeSha(commitSha, { gitOutput = defaultGitOutput } = {}) {
  if (!isCommitSha(commitSha)) {
    throw new Error("main SHA must be a 40-character git commit SHA.");
  }
  const tree = (await gitOutput(["rev-parse", `${commitSha}^{tree}`])).trim().toLowerCase();
  if (!isCommitSha(tree)) {
    throw new Error(`git rev-parse ${commitSha}^{tree} did not return a tree SHA.`);
  }
  return tree;
}

// Fails BEFORE any provider call when either dedicated credential is withheld.
// Error text names the env vars only; values are never read into messages.
export function requireEvidenceCredentials(env = process.env) {
  const missing = RELEASE_EVIDENCE_SPACES_CREDENTIAL_ENV.filter((name) => !env[name] || !env[name].trim());
  if (missing.length > 0) {
    throw new Error(
      `Refusing to call the provider: missing dedicated release-evidence Spaces credentials ${missing.join(", ")}. ` +
        "These are the bucket-scoped key secrets in the merge-gate and production GitHub environments; broad Terraform-state credentials are not accepted here.",
    );
  }
  return {
    accessKeyId: env.RELEASE_EVIDENCE_SPACES_ACCESS_ID.trim(),
    secretAccessKey: env.RELEASE_EVIDENCE_SPACES_SECRET_KEY.trim(),
  };
}

function commandOutput(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // Never echo provider responses wholesale into thrown errors beyond
        // the aws CLI's own redacted message; credentials are env-only.
        const message = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function defaultGitOutput(args) {
  return commandOutput("git", args, process.env);
}

export function createSpacesStorage({ bucket, endpointUrl, env = process.env, runCommand = commandOutput }) {
  const credentials = requireEvidenceCredentials(env);
  const commandEnv = {
    ...env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: "",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
  };
  const s3api = (args) => runCommand("aws", ["s3api", ...args, "--endpoint-url", endpointUrl], commandEnv);

  return {
    async objectExists(key) {
      try {
        await s3api(["head-object", "--bucket", bucket, "--key", key]);
        return true;
      } catch (error) {
        if (/\(404\)|Not Found|NoSuchKey/i.test(error.message)) {
          return false;
        }
        throw error;
      }
    },
    async getObject(key) {
      const dir = await mkdtemp(join(tmpdir(), "release-qualification-"));
      try {
        const target = join(dir, "record.json");
        await s3api(["get-object", "--bucket", bucket, "--key", key, target]);
        return await readFile(target, "utf8");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async putObject(key, body) {
      const dir = await mkdtemp(join(tmpdir(), "release-qualification-"));
      try {
        const source = join(dir, "record.json");
        await writeFile(source, body);
        await s3api([
          "put-object",
          "--bucket",
          bucket,
          "--key",
          key,
          "--body",
          source,
          "--content-type",
          "application/json",
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async deleteObject(key) {
      await s3api(["delete-object", "--bucket", bucket, "--key", key]);
    },
  };
}

// Provider-backed canary probe: write, idempotent retry, conflict rejection,
// requeued-attempt write, read-back verify, then cleanup. Runs under the
// dedicated v1/canary/ prefix so v1/attempts/ stays append-only evidence.
export async function runCanaryProbe({ storage, now = () => new Date() }) {
  const startedAt = now().toISOString();
  const canaryRunId = String(Date.now());
  const base = buildReleaseQualificationRecord({
    repository: "chase-sets/chase-sets",
    candidateSha: "0123456789abcdef0123456789abcdef01234567",
    candidateTreeSha: "89abcdef0123456789abcdef0123456789abcdef",
    imageRepository: "registry.digitalocean.com/chase-sets/chase-sets-platform",
    imageDigest: `sha256:${"0".repeat(64)}`,
    qualificationLane: "canary",
    classifierPolicyVersion: "release-scope-classifier/v0-canary",
    runId: canaryRunId,
    runAttempt: "1",
    startedAt,
    completedAt: startedAt,
    result: "pass",
    evidenceLinks: ["https://github.com/chase-sets/chase-sets/issues/5836"],
  }).record;
  const prefix = `${RELEASE_QUALIFICATION_CANARY_PREFIX}/${startedAt.slice(0, 10)}`;

  const steps = [];
  const writtenKeys = [];
  const check = (name, passed, detail) => {
    steps.push({ name, passed, detail });
    if (!passed) {
      throw new Error(`canary step failed: ${name} (${detail})`);
    }
  };

  try {
    const first = await writeReleaseQualificationRecord({ record: base, prefix }, storage);
    if (first.key) writtenKeys.push(first.key);
    check("initial write", first.outcome === "written", `outcome=${first.outcome}`);

    const retry = await writeReleaseQualificationRecord({ record: base, prefix }, storage);
    check("byte-identical retry is idempotent", retry.outcome === "idempotent", `outcome=${retry.outcome}`);

    const conflicting = { ...base, result: "fail" };
    const conflict = await writeReleaseQualificationRecord({ record: conflicting, prefix }, storage);
    check(
      "conflicting record at same attempt key fails closed",
      conflict.outcome === "conflict",
      `outcome=${conflict.outcome}`,
    );

    const requeued = { ...base, runId: String(Number(canaryRunId) + 1) };
    const requeue = await writeReleaseQualificationRecord({ record: requeued, prefix }, storage);
    if (requeue.key) writtenKeys.push(requeue.key);
    check(
      "requeued same-tree candidate writes a distinct key",
      requeue.outcome === "written" && requeue.key !== first.key,
      `outcome=${requeue.outcome}`,
    );

    const readBack = await storage.getObject(first.key);
    const verify = verifyReleaseQualificationRecord({
      body: readBack,
      recordKey: first.key,
      expected: {
        repository: base.repository,
        treeSha: base.candidateTreeSha,
        imageDigest: base.imageDigest,
        classifierPolicyVersion: base.classifierPolicyVersion,
        mode: "new-release",
        verifiedAt: now().toISOString(),
      },
    });
    // The canary key carries the canary prefix, so the reader must reject it:
    // proof that verification is bound to the exact attempt key, not content.
    check(
      "reader rejects a record read from a non-attempt key",
      !verify.passed && verify.errors.some((error) => error.includes("derives attempt key")),
      verify.errors.join(" | ") || "unexpected pass",
    );
  } finally {
    for (const key of writtenKeys) {
      await storage.deleteObject(key).catch(() => {});
    }
  }

  return { schemaVersion: "release-qualification-canary/v1", startedAt, prefix, steps, result: "pass" };
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : value;
}

function isPositiveInteger(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

async function main(argv) {
  const [command] = argv;
  const bucket = readOption(argv, "--bucket") ?? RELEASE_QUALIFICATION_EVIDENCE_BUCKET;
  const endpointUrl = readOption(argv, "--endpoint-url") ?? RELEASE_QUALIFICATION_SPACES_ENDPOINT;
  const outPath = readOption(argv, "--out");

  if (command === "write") {
    const recordPath = readOption(argv, "--record");
    if (!recordPath) throw new Error("write requires --record <path-to-record-json>.");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const storage = createSpacesStorage({ bucket, endpointUrl });
    const result = await writeReleaseQualificationRecord({ record }, storage);
    const summary = { command: "write", bucket, key: result.key, outcome: result.outcome, errors: result.errors };
    if (outPath) await writeJsonRecord(outPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (result.outcome !== "written" && result.outcome !== "idempotent") process.exitCode = 1;
    return;
  }

  if (command === "verify") {
    const recordKey = readOption(argv, "--record-key");
    const repository = readOption(argv, "--repository");
    const mainSha = readOption(argv, "--main-sha");
    const imageDigest = readOption(argv, "--image-digest");
    const classifierPolicyVersion = readOption(argv, "--classifier-policy-version");
    const mode = readOption(argv, "--mode") ?? "new-release";
    if (!recordKey || !repository || !mainSha || !imageDigest || !classifierPolicyVersion) {
      throw new Error(
        "verify requires --record-key, --repository, --main-sha, --image-digest, and --classifier-policy-version.",
      );
    }
    const treeSha = await resolveCommitTreeSha(mainSha);
    const storage = createSpacesStorage({ bucket, endpointUrl });
    const body = await storage.getObject(recordKey);
    const result = verifyReleaseQualificationRecord({
      body,
      recordKey,
      expected: {
        repository,
        treeSha,
        imageDigest: imageDigest.toLowerCase(),
        classifierPolicyVersion,
        mode,
        verifiedAt: new Date().toISOString(),
      },
    });
    const summary = {
      command: "verify",
      bucket,
      recordKey,
      mode,
      treeSha,
      passed: result.passed,
      errors: result.errors,
    };
    if (outPath) await writeJsonRecord(outPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }

  if (command === "canary") {
    const storage = createSpacesStorage({ bucket, endpointUrl });
    const summary = await runCanaryProbe({ storage });
    if (outPath) await writeJsonRecord(outPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error("usage: release-qualification-record.mjs <write|verify|canary> [options]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
