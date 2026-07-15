#!/usr/bin/env node
// Retained ops verifier for the Production Catalog Completion Report. It reads
// a frozen Scope Sync Batch completion manifest artifact, reconciles it into a
// deterministic completion report, optionally reconciles a repeat execution
// against a previously accepted manifest, and exits nonzero when the launch is
// blocked. Output is asserted support-safe before it is emitted.
//
// Exit codes: 0 = complete and convergent, 2 = launch blockers or non-
// convergent repeat run, 1 = the check itself could not run.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertSupportSafe,
  parseProductionCatalogCompletionManifest,
  reconcileProductionCatalogCompletion,
  reconcileRepeatRun,
  renderCompletionSummary,
  type ProductionCatalogCompletionManifest,
} from "../bounded-contexts/catalog/features/completion-report/domain/index.ts";

export const CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION = "catalog-production-completion-report/v1";

export type CatalogCompletionVerifierOptions = Readonly<{
  environment: string;
  checkedAt: string;
  manifestPath: string | null;
  acceptedManifestPath: string | null;
  outPath: string | null;
}>;

export function parseCatalogCompletionArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CatalogCompletionVerifierOptions {
  return {
    environment:
      readOption(argv, "--environment") ??
      readEnv(env, "CATALOG_COMPLETION_ENVIRONMENT") ??
      readEnv(env, "DEPLOYMENT_ENVIRONMENT") ??
      "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    manifestPath: readOption(argv, "--manifest"),
    acceptedManifestPath: readOption(argv, "--accepted"),
    outPath: readOption(argv, "--out"),
  };
}

export function buildCatalogCompletionRecord(input: {
  manifest: unknown;
  acceptedManifest?: unknown;
  environment: string;
  checkedAt: string;
}) {
  const manifest = parseProductionCatalogCompletionManifest(input.manifest);
  const report = reconcileProductionCatalogCompletion(manifest, { generatedAt: input.checkedAt });
  const repeatRun =
    input.acceptedManifest === undefined
      ? undefined
      : reconcileRepeatRun(parseProductionCatalogCompletionManifest(input.acceptedManifest), manifest);

  const record = {
    schemaVersion: CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION,
    environment: input.environment,
    checkedAt: input.checkedAt,
    result: report.result,
    convergent: repeatRun ? repeatRun.convergent : null,
    report,
    ...(repeatRun ? { repeatRun } : {}),
  };
  assertSupportSafe(record);
  return { record, report, repeatRun };
}

export function catalogCompletionExitCode(result: {
  report: { result: "complete" | "incomplete" };
  repeatRun?: { convergent: boolean };
}): 0 | 2 {
  const blocked = result.report.result !== "complete" || (result.repeatRun ? !result.repeatRun.convergent : false);
  return blocked ? 2 : 0;
}

export function runCatalogCompletionVerifier(options: CatalogCompletionVerifierOptions) {
  if (!options.manifestPath) {
    throw new Error("--manifest <path> is required (a frozen production Catalog completion manifest artifact).");
  }
  const manifest = readManifestArtifact(options.manifestPath);
  const acceptedManifest =
    options.acceptedManifestPath === null ? undefined : readManifestArtifact(options.acceptedManifestPath);
  return buildCatalogCompletionRecord({
    manifest,
    acceptedManifest,
    environment: options.environment,
    checkedAt: options.checkedAt,
  });
}

function readManifestArtifact(path: string): ProductionCatalogCompletionManifest | unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read manifest artifact at ${path}: ${message}`);
  }
}

function readOption(argv: readonly string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || null;
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

async function main(): Promise<void> {
  const options = parseCatalogCompletionArgs(process.argv.slice(2));
  const { record, report, repeatRun } = runCatalogCompletionVerifier(options);
  const serialized = JSON.stringify(record, null, 2);
  if (options.outPath) writeFileSync(options.outPath, `${serialized}\n`);
  process.stdout.write(`${serialized}\n`);
  process.stderr.write(`${renderCompletionSummary(report, repeatRun)}\n`);
  process.exitCode = catalogCompletionExitCode({ report, repeatRun });
}

// Run as a CLI both when this module is the process entry and when it is loaded
// through the run-catalog-production-completion-report.mjs strip-types wrapper
// (whose entry path shares this basename). Importing the module from a test
// runner leaves argv[1] pointing at the runner and never triggers main().
const entryPath = process.argv[1] ?? "";
const isCliEntry =
  entryPath === fileURLToPath(import.meta.url) || /catalog-production-completion-report\.(mjs|ts)$/.test(entryPath);
if (isCliEntry) {
  main().catch((error: unknown) => {
    process.stderr.write(`Catalog completion verifier failed: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
