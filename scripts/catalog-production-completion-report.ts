#!/usr/bin/env node
// Retained ops verifier for the Production Catalog Completion Report. In file
// mode it reads a frozen Scope Sync Batch completion manifest artifact. In
// database mode (`--facts database --batch-id <id>`) it reads observed facts
// from the deployed Catalog database in one read-only snapshot, taking the
// universe from `--manifest` when given or from the batch plan otherwise. It
// reconciles the facts into a deterministic completion report, optionally
// reconciles a repeat execution against a previously accepted manifest, and
// exits nonzero when the launch is blocked. Output is asserted support-safe
// before it is emitted.
//
// Exit codes: 0 = complete and convergent, 2 = launch blockers, unknown facts,
// or a non-convergent repeat run, 1 = the check itself could not run.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { postgresClientConfig } from "./lib/postgres-connection.mjs";
import {
  assertSupportSafe,
  parseProductionCatalogCompletionManifest,
  reconcileProductionCatalogCompletion,
  reconcileRepeatRun,
  renderCompletionSummary,
  type ProductionCatalogCompletionManifest,
} from "../bounded-contexts/catalog/features/completion-report/domain/index.ts";
import {
  queryProductionCatalogCompletionFacts,
  type ProductionCatalogDatabaseFacts,
} from "../bounded-contexts/catalog/features/completion-report/read-model/query.ts";

export const CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION = "catalog-production-completion-report/v1";

export type CatalogCompletionVerifierOptions = Readonly<{
  environment: string;
  checkedAt: string;
  facts: "file" | "database";
  batchId: string | null;
  launchCutoff: string | null;
  catalogDatabaseUrl: string | null;
  manifestPath: string | null;
  acceptedManifestPath: string | null;
  outPath: string | null;
}>;

// A database-mode precondition that failed before any connection was opened.
// The code names the missing authority; the message never echoes the URL.
export class CatalogCompletionPreflightError extends Error {
  readonly code:
    | "facts-source-invalid"
    | "batch-id-missing"
    | "catalog-database-url-missing"
    | "catalog-database-url-invalid"
    | "managed-postgres-ca-missing";
  constructor(code: CatalogCompletionPreflightError["code"], message: string) {
    super(`[${code}] ${message}`);
    this.name = "CatalogCompletionPreflightError";
    this.code = code;
  }
}

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
    facts: parseFactsSource(readOption(argv, "--facts")),
    batchId: readOption(argv, "--batch-id"),
    launchCutoff: readOption(argv, "--launch-cutoff"),
    catalogDatabaseUrl:
      readOption(argv, "--catalog-database-url") ??
      readEnv(env, "CATALOG_DATABASE_URL") ??
      readEnv(env, "DATABASE_URL_CATALOG"),
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

// Database mode: reconcile observed facts. A non-empty `unknownFacts` makes the
// record `evidence-incomplete`; a universe derived from the batch plan carries
// `completionProof: false` and never proves completion.
export function buildCatalogCompletionDatabaseRecord(input: {
  facts: ProductionCatalogDatabaseFacts;
  acceptedManifest?: unknown;
  environment: string;
  checkedAt: string;
}) {
  const manifest = parseProductionCatalogCompletionManifest(input.facts.manifest);
  const report = reconcileProductionCatalogCompletion(manifest, { generatedAt: input.checkedAt });
  const repeatRun =
    input.acceptedManifest === undefined
      ? undefined
      : reconcileRepeatRun(parseProductionCatalogCompletionManifest(input.acceptedManifest), manifest);
  const unknownFacts = [...input.facts.unknownFacts];

  const record = {
    schemaVersion: CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION,
    environment: input.environment,
    checkedAt: input.checkedAt,
    factsSource: "database" as const,
    result: unknownFacts.length > 0 ? ("evidence-incomplete" as const) : report.result,
    completionProof: input.facts.completionProof,
    unknownFacts,
    reportedFacts: input.facts.reportedFacts,
    convergent: repeatRun ? repeatRun.convergent : null,
    report,
    ...(repeatRun ? { repeatRun } : {}),
  };
  assertSupportSafe(record);
  return { record, report, repeatRun, unknownFacts };
}

export function catalogCompletionExitCode(result: {
  report: { result: "complete" | "incomplete" };
  repeatRun?: { convergent: boolean };
  unknownFacts?: readonly string[];
}): 0 | 2 {
  const blocked =
    result.report.result !== "complete" ||
    (result.repeatRun ? !result.repeatRun.convergent : false) ||
    (result.unknownFacts?.length ?? 0) > 0;
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

export type CatalogCompletionPool = Parameters<typeof queryProductionCatalogCompletionFacts>[0] &
  Readonly<{ end: () => Promise<void> }>;

export async function runCatalogCompletionDatabaseVerifier(
  options: CatalogCompletionVerifierOptions,
  createPool: (config: ReturnType<typeof postgresClientConfig>) => CatalogCompletionPool = (config) =>
    new pg.Pool({ ...config, max: 1 }),
) {
  if (!options.batchId) {
    throw new CatalogCompletionPreflightError("batch-id-missing", "--batch-id <id> is required with --facts database.");
  }
  const frozenManifest =
    options.manifestPath === null
      ? null
      : parseProductionCatalogCompletionManifest(readManifestArtifact(options.manifestPath));
  const acceptedManifest =
    options.acceptedManifestPath === null ? undefined : readManifestArtifact(options.acceptedManifestPath);
  const pool = createPool(catalogCompletionDatabaseConfig(options.catalogDatabaseUrl));
  try {
    const facts = await queryProductionCatalogCompletionFacts(pool, {
      batchId: options.batchId,
      observedAt: options.checkedAt,
      frozenManifest,
      launchCutoff: options.launchCutoff,
    });
    return buildCatalogCompletionDatabaseRecord({
      facts,
      acceptedManifest,
      environment: options.environment,
      checkedAt: options.checkedAt,
    });
  } finally {
    await pool.end();
  }
}

// Resolve the Catalog connection without connecting. A deployed (non-local)
// database must carry its managed CA as `sslrootcert`, and the file must be
// readable; otherwise the run fails by name instead of trying system trust.
export function catalogCompletionDatabaseConfig(
  catalogDatabaseUrl: string | null,
  read: (path: string, encoding: "utf8") => string = readFileSync,
) {
  if (!catalogDatabaseUrl) {
    throw new CatalogCompletionPreflightError(
      "catalog-database-url-missing",
      "CATALOG_DATABASE_URL, DATABASE_URL_CATALOG, or --catalog-database-url is required with --facts database.",
    );
  }
  let url: URL;
  try {
    url = new URL(catalogDatabaseUrl);
  } catch {
    throw new CatalogCompletionPreflightError("catalog-database-url-invalid", "The Catalog database URL is not a URL.");
  }
  if (!localDatabaseHosts.has(url.hostname)) {
    const caPath = url.searchParams.get("sslrootcert");
    let ca = "";
    try {
      ca = caPath ? read(caPath, "utf8") : "";
    } catch {
      ca = "";
    }
    if (!ca.trim()) {
      throw new CatalogCompletionPreflightError(
        "managed-postgres-ca-missing",
        "The deployed Catalog database URL must carry a readable managed Postgres CA as sslrootcert.",
      );
    }
  }
  return postgresClientConfig(catalogDatabaseUrl, process.env, read);
}

const localDatabaseHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseFactsSource(value: string | null): CatalogCompletionVerifierOptions["facts"] {
  if (value === null || value === "file") return "file";
  if (value === "database") return "database";
  throw new CatalogCompletionPreflightError("facts-source-invalid", "--facts must be file or database.");
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
  const { record, report, repeatRun, unknownFacts } =
    options.facts === "database"
      ? await runCatalogCompletionDatabaseVerifier(options)
      : { ...runCatalogCompletionVerifier(options), unknownFacts: undefined };
  const serialized = JSON.stringify(record, null, 2);
  if (options.outPath) writeFileSync(options.outPath, `${serialized}\n`);
  process.stdout.write(`${serialized}\n`);
  process.stderr.write(`${renderCompletionSummary(report, repeatRun)}\n`);
  if ("factsSource" in record) {
    process.stderr.write(`${renderDatabaseFactsSummary(record)}\n`);
  }
  process.exitCode = catalogCompletionExitCode({ report, repeatRun, unknownFacts });
}

function renderDatabaseFactsSummary(record: ReturnType<typeof buildCatalogCompletionDatabaseRecord>["record"]): string {
  const facts = record.reportedFacts;
  const statuses = Object.entries(facts.publicationCountsByStatus).map(([status, count]) => `${status}=${count}`);
  const lines = [
    `  facts: database (completion proof: ${record.completionProof ? "yes" : "no, universe derived from the batch plan"})`,
    `  evidence: ${record.result === "evidence-incomplete" ? "EVIDENCE-INCOMPLETE" : "complete"}`,
    `  external reference duplicates: ${facts.externalReferenceDuplicates}`,
    `  legacy profile markers: ${facts.legacyProfileMarkerCount}`,
    `  non-terminal integration jobs: ${facts.nonTerminalIntegrationJobCount}`,
    `  publication by status: ${statuses.join(", ") || "none"}`,
  ];
  for (const fact of record.unknownFacts) lines.push(`    - unknown: ${fact}`);
  return lines.join("\n");
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
