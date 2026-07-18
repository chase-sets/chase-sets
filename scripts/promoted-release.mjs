#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const PROMOTED_RELEASE_VERSION = "promoted-release/v1";
const IMAGE_REPOSITORY_PATTERN = /^registry\.digitalocean\.com\/[a-z0-9][a-z0-9-]*\/chase-sets-platform$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function buildPromotedReleaseRecord(input) {
  const record = {
    schemaVersion: PROMOTED_RELEASE_VERSION,
    producerRunId: String(input.producerRunId ?? "").trim(),
    producerRunAttempt: String(input.producerRunAttempt ?? "").trim(),
    environment: String(input.environment ?? "").trim(),
    releaseCommit: String(input.releaseCommit ?? "").trim(),
    treeHash: String(input.treeHash ?? "").trim(),
    imageRepository: normalizeImageRepository(input.imageRepository),
    imageDigest: String(input.imageDigest ?? "").trim(),
    promotionResult: String(input.promotionResult ?? "").trim(),
    promotedAt: String(input.promotedAt ?? "").trim(),
  };
  return { record, errors: validatePromotedReleaseRecord(record) };
}

export function validatePromotedReleaseRecord(record, expected = {}) {
  const errors = [];
  if (record?.schemaVersion !== PROMOTED_RELEASE_VERSION)
    errors.push(`schemaVersion must be ${PROMOTED_RELEASE_VERSION}.`);
  if (!isPositiveInteger(record?.producerRunId)) errors.push("producerRunId must be a positive integer.");
  if (!isPositiveInteger(record?.producerRunAttempt)) errors.push("producerRunAttempt must be a positive integer.");
  if (record?.environment !== "production") errors.push("environment must be production.");
  if (!isCommitSha(record?.releaseCommit)) errors.push("releaseCommit must be a 40-character Git commit SHA.");
  if (!isCommitSha(record?.treeHash)) errors.push("treeHash must be a 40-character Git tree SHA.");
  if (!IMAGE_REPOSITORY_PATTERN.test(record?.imageRepository ?? "")) {
    errors.push("imageRepository must be an allowlisted Chase Sets DigitalOcean repository.");
  }
  if (!IMAGE_DIGEST_PATTERN.test(record?.imageDigest ?? ""))
    errors.push("imageDigest must be an immutable sha256 digest.");
  if (record?.promotionResult !== "promoted") errors.push("promotionResult must be promoted.");
  if (!isIsoInstant(record?.promotedAt)) errors.push("promotedAt must be an ISO-8601 instant.");

  if (expected.producerRunId && String(record?.producerRunId) !== String(expected.producerRunId)) {
    errors.push("producerRunId does not match the triggering Platform Deploy run.");
  }
  if (expected.producerRunAttempt && String(record?.producerRunAttempt) !== String(expected.producerRunAttempt)) {
    errors.push("producerRunAttempt does not match the triggering Platform Deploy run attempt.");
  }
  if (expected.environment && record?.environment !== expected.environment) {
    errors.push(`environment does not match expected ${expected.environment}.`);
  }
  return errors;
}

function normalizeImageRepository(value) {
  const image = String(value ?? "")
    .trim()
    .split("@")[0];
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

function isPositiveInteger(value) {
  return /^[1-9]\d*$/.test(String(value ?? ""));
}

function isIsoInstant(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === "create") {
    const result = buildPromotedReleaseRecord({
      producerRunId: readOption(argv, "--producer-run-id"),
      producerRunAttempt: readOption(argv, "--producer-run-attempt"),
      environment: readOption(argv, "--environment"),
      releaseCommit: readOption(argv, "--release-commit"),
      treeHash: readOption(argv, "--tree-hash"),
      imageRepository: readOption(argv, "--image-repository"),
      imageDigest: readOption(argv, "--image-digest"),
      promotionResult: readOption(argv, "--promotion-result"),
      promotedAt: readOption(argv, "--promoted-at"),
    });
    assertValid(result.errors);
    await writeJsonRecord(readOption(argv, "--out"), result.record);
    return;
  }

  if (command === "validate") {
    const record = JSON.parse(await readFile(readOption(argv, "--file"), "utf8"));
    assertValid(
      validatePromotedReleaseRecord(record, {
        producerRunId: readOption(argv, "--expected-producer-run-id"),
        producerRunAttempt: readOption(argv, "--expected-producer-run-attempt"),
        environment: readOption(argv, "--expected-environment"),
      }),
    );
    const output = readOption(argv, "--github-output");
    if (output) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        output,
        `release_commit=${record.releaseCommit}\nimage_repository=${record.imageRepository}\nimage_digest=${record.imageDigest}\nimage=${record.imageRepository}\ndigest=${record.imageDigest}\n`,
      );
    }
    console.log(`Validated promoted release ${record.releaseCommit}@${record.imageDigest}.`);
    return;
  }

  throw new Error("Usage: promoted-release.mjs <create|validate> [options]");
}

function assertValid(errors) {
  if (errors.length > 0) throw new Error(`Invalid promoted release:\n- ${errors.join("\n- ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
