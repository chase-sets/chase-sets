import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const REVIEWED_PLAN_FORMAT = "chase-sets/terraform-reviewed-plan/v1";
export const ENCRYPTED_PAYLOAD_FORMAT = "chase-sets/terraform-encrypted-payload/v1";
export const REVIEW_TEXT_FILE = "reviewed-plan.txt";
export const PROVENANCE_FILE = "provenance.json";
export const ENCRYPTED_PAYLOAD_FILE = "apply-payload.enc";

const ENCRYPTION_SECRET_ENV = "PLAN_ENCRYPTION_SECRET";
const EXPECTED_BUNDLE_FILES = [ENCRYPTED_PAYLOAD_FILE, PROVENANCE_FILE, REVIEW_TEXT_FILE].sort();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function exactMatch(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name} did not match the reviewed plan provenance.`);
  }
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseTimestamp(value, name) {
  const timestamp = Date.parse(requiredString(value, name));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${name} must be an ISO-8601 timestamp.`);
  }
  return timestamp;
}

function filesRecursively(root) {
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".terraform") continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) entries.push(...filesRecursively(absolute));
    else entries.push(absolute);
  }
  return entries;
}

export function terraformConfigurationDigest(terraformRoot) {
  const absoluteRoot = resolve(terraformRoot);
  const files = filesRecursively(absoluteRoot)
    .filter((file) => file.endsWith(".tf"))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error(`No Terraform configuration files were found under ${terraformRoot}.`);
  }

  const inventory = files.map((file) => ({
    path: relative(absoluteRoot, file).split(sep).join("/"),
    sha256: sha256(readFileSync(file)),
  }));
  return sha256(canonicalJson(inventory));
}

function fileDigest(file, name) {
  try {
    return sha256(readFileSync(file));
  } catch (error) {
    throw new Error(`${name} could not be read: ${error.message}`);
  }
}

function validateSecretSafeReviewText(reviewText, sensitiveValues) {
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || value.length < 4) {
      throw new Error("Every sensitive value must be present and at least four characters before sealing a plan.");
    }
    if (reviewText.includes(value)) {
      throw new Error("Reviewable plan text contained a credential value; refusing to seal or upload it.");
    }
  }
}

function deriveEncryptionKey(secret, salt, provenance) {
  const context = [provenance.repository, provenance.terraformRoot, provenance.stateKey].join("\0");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), salt, Buffer.from(context), 32));
}

function validateCommit(value, name) {
  if (!COMMIT_PATTERN.test(value)) {
    throw new Error(`${name} must be an exact lowercase 40-character commit SHA.`);
  }
}

function validateDigest(value, name) {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
}

function validateProvenanceShape(provenance) {
  exactMatch(provenance.format, REVIEWED_PLAN_FORMAT, "format");
  for (const field of [
    "repository",
    "sourceWorkflowPath",
    "sourceWorkflowRef",
    "releaseRef",
    "approvalEnvironment",
    "terraformRoot",
    "stateKey",
    "terraformVersion",
    "createdAt",
  ]) {
    requiredString(provenance[field], field);
  }
  parsePositiveInteger(provenance.sourceWorkflowRunId, "sourceWorkflowRunId");
  parsePositiveInteger(provenance.sourceWorkflowRunAttempt, "sourceWorkflowRunAttempt");
  validateCommit(provenance.sourceWorkflowCommit, "sourceWorkflowCommit");
  validateCommit(provenance.releaseCommit, "releaseCommit");
  for (const field of [
    "terraformConfigurationSha256",
    "terraformLockSha256",
    "backendConfigSha256",
    "reviewTextSha256",
    "applyPayloadSha256",
  ]) {
    validateDigest(provenance[field], field);
  }
  parseTimestamp(provenance.createdAt, "createdAt");
}

export function sealReviewedPlan({
  planBinaryPath,
  reviewTextPath,
  outputDirectory,
  terraformRootPath,
  backendConfigPath,
  encryptionSecret,
  sensitiveValues,
  provenance: provenanceInput,
  now = new Date(),
  randomBytesFn = randomBytes,
}) {
  requiredString(encryptionSecret, ENCRYPTION_SECRET_ENV);
  const planBytes = readFileSync(planBinaryPath);
  if (planBytes.length === 0) throw new Error("Terraform apply payload was empty.");
  const reviewText = readFileSync(reviewTextPath, "utf8");
  if (reviewText.trim() === "") throw new Error("Reviewable Terraform plan text was empty.");
  validateSecretSafeReviewText(reviewText, sensitiveValues);

  const terraformRoot = resolve(terraformRootPath);
  const provenance = {
    format: REVIEWED_PLAN_FORMAT,
    ...provenanceInput,
    createdAt: now.toISOString(),
    terraformConfigurationSha256: terraformConfigurationDigest(terraformRoot),
    terraformLockSha256: fileDigest(join(terraformRoot, ".terraform.lock.hcl"), "Terraform lock file"),
    backendConfigSha256: fileDigest(backendConfigPath, "Terraform backend configuration"),
    reviewTextSha256: sha256(Buffer.from(reviewText)),
    applyPayloadSha256: sha256(planBytes),
  };
  validateProvenanceShape(provenance);
  exactMatch(provenance.sourceWorkflowCommit, provenance.releaseCommit, "sourceWorkflowCommit");
  exactMatch(provenance.releaseRef, provenance.releaseCommit, "releaseRef");

  const provenanceBytes = Buffer.from(canonicalJson(provenance));
  const salt = randomBytesFn(32);
  const iv = randomBytesFn(12);
  const key = deriveEncryptionKey(encryptionSecret, salt, provenance);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(provenanceBytes);
  const ciphertext = Buffer.concat([cipher.update(planBytes), cipher.final()]);
  const envelope = {
    format: ENCRYPTED_PAYLOAD_FORMAT,
    algorithm: "aes-256-gcm",
    keyDerivation: "hkdf-sha256",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    throw new Error("Reviewed plan output directory must be empty before sealing.");
  }
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(join(outputDirectory, REVIEW_TEXT_FILE), reviewText, { mode: 0o600 });
  writeFileSync(join(outputDirectory, PROVENANCE_FILE), provenanceBytes, { mode: 0o600 });
  writeFileSync(join(outputDirectory, ENCRYPTED_PAYLOAD_FILE), canonicalJson(envelope), { mode: 0o600 });
  return provenance;
}

function validateExpectedProvenance(provenance, expected) {
  const fields = [
    "repository",
    "sourceWorkflowPath",
    "sourceWorkflowRef",
    "sourceWorkflowRunId",
    "sourceWorkflowRunAttempt",
    "sourceWorkflowCommit",
    "releaseCommit",
    "releaseRef",
    "approvalEnvironment",
    "terraformRoot",
    "stateKey",
  ];
  for (const field of fields) exactMatch(provenance[field], expected[field], field);
}

function validateFreshness(createdAt, now, maxAgeSeconds) {
  const createdAtMs = parseTimestamp(createdAt, "createdAt");
  const nowMs = now.getTime();
  if (createdAtMs > nowMs + 60_000) {
    throw new Error("Reviewed plan provenance is dated in the future.");
  }
  if (nowMs - createdAtMs > maxAgeSeconds * 1000) {
    throw new Error("Reviewed plan is stale and must be planned and reviewed again.");
  }
}

function decodeBase64(value, name) {
  requiredString(value, name);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${name} was not canonical base64.`);
  }
  return decoded;
}

export function openReviewedPlan({
  bundleDirectory,
  outputPlanPath,
  terraformRootPath,
  backendConfigPath,
  encryptionSecret,
  expectedProvenance,
  maxAgeSeconds,
  now = new Date(),
}) {
  requiredString(encryptionSecret, ENCRYPTION_SECRET_ENV);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("maxAgeSeconds must be a positive integer.");
  }
  rmSync(outputPlanPath, { force: true });

  const bundleFiles = readdirSync(bundleDirectory).sort();
  if (JSON.stringify(bundleFiles) !== JSON.stringify(EXPECTED_BUNDLE_FILES)) {
    throw new Error(`Reviewed plan artifact had an unexpected file set: ${bundleFiles.join(", ") || "none"}.`);
  }

  const provenanceBytes = readFileSync(join(bundleDirectory, PROVENANCE_FILE));
  let provenance;
  let envelope;
  try {
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
    envelope = JSON.parse(readFileSync(join(bundleDirectory, ENCRYPTED_PAYLOAD_FILE), "utf8"));
  } catch {
    throw new Error("Reviewed plan provenance or encrypted payload was not valid JSON.");
  }
  validateProvenanceShape(provenance);
  validateExpectedProvenance(provenance, expectedProvenance);
  validateFreshness(provenance.createdAt, now, maxAgeSeconds);
  exactMatch(envelope.format, ENCRYPTED_PAYLOAD_FORMAT, "encrypted payload format");
  exactMatch(envelope.algorithm, "aes-256-gcm", "encrypted payload algorithm");
  exactMatch(envelope.keyDerivation, "hkdf-sha256", "encrypted payload key derivation");

  const reviewText = readFileSync(join(bundleDirectory, REVIEW_TEXT_FILE));
  exactMatch(sha256(reviewText), provenance.reviewTextSha256, "reviewTextSha256");
  exactMatch(
    terraformConfigurationDigest(terraformRootPath),
    provenance.terraformConfigurationSha256,
    "terraformConfigurationSha256",
  );
  exactMatch(
    fileDigest(join(terraformRootPath, ".terraform.lock.hcl"), "Terraform lock file"),
    provenance.terraformLockSha256,
    "terraformLockSha256",
  );
  exactMatch(
    fileDigest(backendConfigPath, "Terraform backend configuration"),
    provenance.backendConfigSha256,
    "backendConfigSha256",
  );

  const salt = decodeBase64(envelope.salt, "salt");
  const iv = decodeBase64(envelope.iv, "iv");
  const authTag = decodeBase64(envelope.authTag, "authTag");
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  if (salt.length !== 32 || iv.length !== 12 || authTag.length !== 16) {
    throw new Error("Encrypted payload parameters had invalid lengths.");
  }

  let planBytes;
  try {
    const key = deriveEncryptionKey(encryptionSecret, salt, provenance);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(provenanceBytes);
    decipher.setAuthTag(authTag);
    planBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Reviewed plan authentication or decryption failed.");
  }
  exactMatch(sha256(planBytes), provenance.applyPayloadSha256, "applyPayloadSha256");

  mkdirSync(dirname(outputPlanPath), { recursive: true });
  writeFileSync(outputPlanPath, planBytes, { mode: 0o600 });
  return provenance;
}

export function validateReviewedPlanSource({
  run,
  artifacts,
  expectedRepository,
  expectedWorkflowPath,
  expectedWorkflowRunId,
  expectedWorkflowRunAttempt,
  expectedCommit,
  expectedBranch,
  expectedArtifactName,
  expectedArtifactDigest,
  maxAgeSeconds,
  now = new Date(),
}) {
  validateCommit(expectedCommit, "expectedCommit");
  if (!ARTIFACT_DIGEST_PATTERN.test(expectedArtifactDigest)) {
    throw new Error("expectedArtifactDigest must be an explicit sha256: GitHub artifact digest.");
  }
  const runId = parsePositiveInteger(expectedWorkflowRunId, "expectedWorkflowRunId");
  const runAttempt = parsePositiveInteger(expectedWorkflowRunAttempt, "expectedWorkflowRunAttempt");
  exactMatch(run.id, runId, "source workflow run id");
  exactMatch(run.run_attempt, runAttempt, "source workflow run attempt");
  exactMatch(run.repository?.full_name, expectedRepository, "source repository");
  exactMatch(run.path, expectedWorkflowPath, "source workflow path");
  exactMatch(run.event, "workflow_dispatch", "source workflow event");
  exactMatch(run.status, "completed", "source workflow status");
  exactMatch(run.conclusion, "success", "source workflow conclusion");
  exactMatch(run.head_sha, expectedCommit, "source workflow commit");
  exactMatch(run.head_branch, expectedBranch, "source workflow branch");

  const candidates = artifacts.filter((artifact) => artifact.name === expectedArtifactName);
  if (candidates.length !== 1) {
    throw new Error("Expected exactly one immutable reviewed-plan artifact in the source run.");
  }
  const artifact = candidates[0];
  exactMatch(artifact.workflow_run?.id, runId, "artifact source workflow run id");
  exactMatch(artifact.expired, false, "artifact expiration state");
  exactMatch(artifact.digest, expectedArtifactDigest, "GitHub artifact digest");
  validateFreshness(artifact.created_at, now, maxAgeSeconds);
  return artifact;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${name ?? "end of command"}.`);
    }
    options[name.slice(2)] = value;
  }
  return { command, options };
}

function option(options, name) {
  return requiredString(options[name], `--${name}`);
}

function expectedProvenanceFromOptions(options) {
  return {
    repository: option(options, "repository"),
    sourceWorkflowPath: option(options, "source-workflow-path"),
    sourceWorkflowRef: option(options, "source-workflow-ref"),
    sourceWorkflowRunId: parsePositiveInteger(option(options, "source-run-id"), "--source-run-id"),
    sourceWorkflowRunAttempt: parsePositiveInteger(option(options, "source-run-attempt"), "--source-run-attempt"),
    sourceWorkflowCommit: option(options, "source-workflow-commit"),
    releaseCommit: option(options, "release-commit"),
    releaseRef: option(options, "release-ref"),
    approvalEnvironment: option(options, "approval-environment"),
    terraformRoot: option(options, "terraform-root"),
    stateKey: option(options, "state-key"),
  };
}

function sensitiveValuesFromEnvironment(options) {
  const names = option(options, "sensitive-env-names").split(",").filter(Boolean);
  return names.map((name) => requiredString(process.env[name], `environment variable ${name}`));
}

function runCli(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "seal") {
    const expected = expectedProvenanceFromOptions(options);
    sealReviewedPlan({
      planBinaryPath: option(options, "plan-binary"),
      reviewTextPath: option(options, "review-text"),
      outputDirectory: option(options, "out-dir"),
      terraformRootPath: option(options, "terraform-root-path"),
      backendConfigPath: option(options, "backend-config"),
      encryptionSecret: process.env[ENCRYPTION_SECRET_ENV],
      sensitiveValues: sensitiveValuesFromEnvironment(options),
      provenance: {
        ...expected,
        terraformVersion: option(options, "terraform-version"),
      },
    });
    return;
  }

  if (command === "open") {
    openReviewedPlan({
      bundleDirectory: option(options, "bundle-dir"),
      outputPlanPath: option(options, "output-plan"),
      terraformRootPath: option(options, "terraform-root-path"),
      backendConfigPath: option(options, "backend-config"),
      encryptionSecret: process.env[ENCRYPTION_SECRET_ENV],
      expectedProvenance: expectedProvenanceFromOptions(options),
      maxAgeSeconds: parsePositiveInteger(option(options, "max-age-seconds"), "--max-age-seconds"),
    });
    return;
  }

  if (command === "verify-source") {
    const run = JSON.parse(readFileSync(option(options, "run-json"), "utf8"));
    const artifactResponse = JSON.parse(readFileSync(option(options, "artifacts-json"), "utf8"));
    validateReviewedPlanSource({
      run,
      artifacts: artifactResponse.artifacts ?? [],
      expectedRepository: option(options, "repository"),
      expectedWorkflowPath: option(options, "source-workflow-path"),
      expectedWorkflowRunId: option(options, "source-run-id"),
      expectedWorkflowRunAttempt: option(options, "source-run-attempt"),
      expectedCommit: option(options, "release-commit"),
      expectedBranch: option(options, "source-branch"),
      expectedArtifactName: option(options, "artifact-name"),
      expectedArtifactDigest: option(options, "artifact-digest"),
      maxAgeSeconds: parsePositiveInteger(option(options, "max-age-seconds"), "--max-age-seconds"),
    });
    return;
  }

  throw new Error("Expected command: seal, open, or verify-source.");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    // Error messages intentionally name only failed fields and never include secret values.
    console.error(error.message);
    process.exitCode = 1;
  }
}
