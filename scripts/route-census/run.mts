#!/usr/bin/env -S pnpm exec tsx
import { asRouteCensusError, RouteCensusError } from "./errors.mts";
import { readAndValidateArtifact, runParity } from "./runner.mts";
import { sha256 } from "./target-authority.mts";
import { readFile } from "node:fs/promises";
import path from "node:path";

const USAGE = `Usage:
  pnpm exec tsx scripts/route-census/run.mts parity --base-root <path> --expect-base-head <40hex> --candidate-root <path> --expect-candidate-head <40hex> --expect-harness-head <40hex> --expect-comparison <empty|nonempty> --out <new-path>
  pnpm exec tsx scripts/route-census/run.mts validate --artifact <path> --expect-base-head <40hex> --expect-candidate-head <40hex> --expect-harness-head <40hex> [--expect-base-root <path>] [--expect-candidate-root <path>]`;

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || !allowed.includes(name)) {
      throw new RouteCensusError("E_USAGE", `Invalid option near '${name ?? "end"}'.`);
    }
    if (options[name] !== undefined) throw new RouteCensusError("E_USAGE", `Duplicate option '${name}'.`);
    options[name] = value;
  }
  for (const name of required) {
    if (options[name] === undefined) throw new RouteCensusError("E_USAGE", `Missing required option '${name}'.`);
  }
  return options;
}

function exactHead(value: string, name: string): string {
  if (!/^[a-f0-9]{40}$/.test(value))
    throw new RouteCensusError("E_USAGE", `${name} must be 40 lowercase hex characters.`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "parity") {
    const options = parseOptions(
      args,
      [
        "--base-root",
        "--expect-base-head",
        "--candidate-root",
        "--expect-candidate-head",
        "--expect-harness-head",
        "--expect-comparison",
        "--out",
      ],
      [
        "--base-root",
        "--expect-base-head",
        "--candidate-root",
        "--expect-candidate-head",
        "--expect-harness-head",
        "--expect-comparison",
        "--out",
      ],
    );
    if (options["--expect-comparison"] !== "empty" && options["--expect-comparison"] !== "nonempty") {
      throw new RouteCensusError("E_USAGE", "--expect-comparison must be empty or nonempty.");
    }
    const artifact = await runParity({
      baseRoot: options["--base-root"],
      baseHead: exactHead(options["--expect-base-head"], "--expect-base-head"),
      candidateRoot: options["--candidate-root"],
      candidateHead: exactHead(options["--expect-candidate-head"], "--expect-candidate-head"),
      harnessHead: exactHead(options["--expect-harness-head"], "--expect-harness-head"),
      expectedState: options["--expect-comparison"],
      outputPath: options["--out"],
    });
    const bytes = await readFile(path.resolve(options["--out"]));
    process.stdout.write(
      `route-census: published ${path.resolve(options["--out"])} sha256=${sha256(bytes)} base=${artifact.base.counts.censusRecords} candidate=${artifact.candidate.counts.censusRecords} scanned=${artifact.base.counts.scanned}/${artifact.base.counts.total},${artifact.candidate.counts.scanned}/${artifact.candidate.counts.total} comparison=${artifact.comparison.actualState}\n`,
    );
    return;
  }
  if (command === "validate") {
    const options = parseOptions(
      args,
      [
        "--artifact",
        "--expect-base-head",
        "--expect-candidate-head",
        "--expect-harness-head",
        "--expect-base-root",
        "--expect-candidate-root",
      ],
      ["--artifact", "--expect-base-head", "--expect-candidate-head", "--expect-harness-head"],
    );
    const artifact = await readAndValidateArtifact(options["--artifact"], {
      baseHead: exactHead(options["--expect-base-head"], "--expect-base-head"),
      candidateHead: exactHead(options["--expect-candidate-head"], "--expect-candidate-head"),
      harnessHead: exactHead(options["--expect-harness-head"], "--expect-harness-head"),
      ...(options["--expect-base-root"] ? { baseRoot: options["--expect-base-root"] } : {}),
      ...(options["--expect-candidate-root"] ? { candidateRoot: options["--expect-candidate-root"] } : {}),
    });
    process.stdout.write(
      `route-census: valid schema=${artifact.schemaVersion} base=${artifact.base.provenance.head} candidate=${artifact.candidate.provenance.head} harness=${artifact.harness.head} comparison=${artifact.comparison.actualState}\n`,
    );
    return;
  }
  throw new RouteCensusError("E_USAGE", "Expected command 'parity' or 'validate'.");
}

try {
  await main();
} catch (error) {
  const normalized = asRouteCensusError(error, "E_ARTIFACT_INVALID");
  process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
  if (normalized.code === "E_USAGE") process.stderr.write(`${USAGE}\n`);
  process.exitCode = normalized.code === "E_EXPECTATION_MISMATCH" ? 1 : 2;
}
