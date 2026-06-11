#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isCommitSha, readEnv, readOption } from "./lib/cli-options.mjs";

export const CANARY_ANALYSIS_VERSION = "canary-analysis/v1";

export function parseCanaryAnalysisArgs(argv, env = process.env) {
  return {
    filePath: readOption(argv, "--file") ?? readEnv("CANARY_ANALYSIS_INPUT", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runCanaryAnalysis(options) {
  const input = JSON.parse(await readFile(options.filePath, "utf8"));
  return evaluateCanaryAnalysis({ ...input, checkedAt: options.checkedAt });
}

export function evaluateCanaryAnalysis(input) {
  const errors = [];
  const signals = Array.isArray(input.signals) ? input.signals : [];
  const evaluatedSignals = signals.map(evaluateSignal);

  if (!isCommitSha(input.releaseCommit)) {
    errors.push("Canary analysis releaseCommit must be a 40-character Git commit SHA.");
  }
  if (signals.length === 0) {
    errors.push("Canary analysis requires at least one signal.");
  }

  for (const signal of evaluatedSignals) {
    if (signal.required && signal.status !== "pass") {
      errors.push(`Required canary signal ${signal.name} did not pass: ${signal.status}.`);
    }
  }

  return {
    schemaVersion: CANARY_ANALYSIS_VERSION,
    releaseCommit: input.releaseCommit ?? "",
    checkedAt: input.checkedAt,
    observationWindowSeconds: normalizeNonNegativeInteger(input.observationWindowSeconds ?? 0),
    signals: evaluatedSignals,
    passesCanaryAnalysisGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function evaluateSignal(signal) {
  const required = signal.required !== false;
  const name = requireString(signal.name, "canary signal name");
  const owner = requireString(signal.owner, `canary signal ${name} owner`);
  const status = signal.status ?? deriveStatus(signal);

  return {
    name,
    owner,
    required,
    status,
    ...(typeof signal.baseline === "number" ? { baseline: signal.baseline } : {}),
    ...(typeof signal.canary === "number" ? { canary: signal.canary } : {}),
    ...(typeof signal.maxIncrease === "number" ? { maxIncrease: signal.maxIncrease } : {}),
    ...(signal.source ? { source: String(signal.source) } : {}),
    ...(signal.threshold ? { threshold: String(signal.threshold) } : {}),
    ...(signal.currentState ? { currentState: String(signal.currentState) } : {}),
    ...(signal.detail ? { detail: String(signal.detail) } : {}),
  };
}

function deriveStatus(signal) {
  if (
    typeof signal.baseline !== "number" ||
    typeof signal.canary !== "number" ||
    typeof signal.maxIncrease !== "number"
  ) {
    return "missing";
  }
  return signal.canary <= signal.baseline + signal.maxIncrease ? "pass" : "fail";
}

async function main(argv, env = process.env) {
  const options = parseCanaryAnalysisArgs(argv, env);
  if (!options.filePath) {
    console.error("CANARY_ANALYSIS_INPUT or --file is required.");
    return 2;
  }

  const result = await runCanaryAnalysis(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passesCanaryAnalysisGate) {
    for (const error of result.errors) {
      console.error(error);
    }
    return 1;
  }
  return 0;
}

function normalizeNonNegativeInteger(value) {
  const normalized = Number.parseInt(String(value), 10);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : 0;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
