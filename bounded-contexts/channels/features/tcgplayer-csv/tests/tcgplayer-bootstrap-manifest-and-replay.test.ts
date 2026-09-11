import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tcgplayerCsvSchemaMigrations, tcgplayerCsvSchemaSql } from "../read-model/schema";
import { digestChannelSyncRunMembers } from "../domain/digest";

describe("tcgplayer-bootstrap-manifest-and-replay", () => {
  it("keeps boot SQL and the same-change migration aligned for every owned table and index", () => {
    const migration = tcgplayerCsvSchemaMigrations[0];
    if (!migration) throw new Error("TCGplayer CSV migration is unavailable.");
    for (const table of [
      "channel_export_schema_pins",
      "channel_inventory_snapshots",
      "channel_inventory_snapshot_rows",
      "channel_sync_runs",
      "channel_sync_run_rows",
    ]) {
      expect(tcgplayerCsvSchemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration.statements.join("\n")).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const index of [
      "channel_inventory_snapshot_rows_latest_idx",
      "channel_sync_runs_one_non_terminal_per_connection_idx",
    ]) {
      expect(tcgplayerCsvSchemaSql).toContain(index);
      expect(migration.statements.join("\n")).toContain(index);
    }
    expect(tcgplayerCsvSchemaSql).toContain("manual_claim_lease_policy_snapshot");
    expect(tcgplayerCsvSchemaSql).toContain("listing_id text NOT NULL");
    expect(tcgplayerCsvSchemaSql).toContain("desired_state_sequence bigint NOT NULL");
    expect(tcgplayerCsvSchemaSql).toContain("last_stream_version bigint NOT NULL");
    expect(tcgplayerCsvSchemaSql).toContain("ON DELETE RESTRICT");
  });

  it("imports producer interfaces instead of redeclaring or casting them across arbitrary paths", () => {
    const featureRoot = path.resolve(import.meta.dirname, "..");
    const sources = listSources(featureRoot).filter((file) => !file.includes(`${path.sep}tests${path.sep}`));
    const entries = sources.map((file) => ({
      relativePath: path.relative(featureRoot, file),
      source: readFileSync(file, "utf8"),
    }));
    const combined = entries.map((entry) => entry.source).join("\n");
    const candidate = inspectCanonicalProducerSources(entries);
    expect(candidate).toEqual({ scanned: sources.length, total: sources.length, violations: [] });
    expect(combined).toContain('from "../../outbound-sync/domain/contracts"');
    expect(combined).toContain('from "../../listing-composition/domain/contracts"');

    const mutants = [
      "interface ClaimedOperationReservation { operations: unknown[] }",
      "const reservation = value as ClaimedOperationReservation;",
      "const operation = reservation!.operations[0]!;",
      "const member = { desiredStateSequence: operation.listingRevision };",
    ];
    for (const source of mutants) {
      expect(
        inspectCanonicalProducerSources([{ relativePath: "arbitrary/deep/new-owner.ts", source }]).violations,
        source,
      ).not.toEqual([]);
    }
  });

  it("threads required export limits through the complete production caller inventory and rejects bypass mutants", () => {
    const featureRoot = path.resolve(import.meta.dirname, "..");
    const entries = listSources(featureRoot)
      .filter((file) => !file.includes(`${path.sep}tests${path.sep}`))
      .map((file) => ({ relativePath: path.relative(featureRoot, file), source: readFileSync(file, "utf8") }));
    const candidate = inspectExportLimitCallers(entries);
    expect(candidate).toEqual({
      scanned: entries.length,
      total: entries.length,
      callers: ["api/runtime.ts"],
      violations: [],
    });
    const runtime = entries.find((entry) => entry.relativePath.replaceAll("\\", "/") === "api/runtime.ts");
    if (!runtime) throw new Error("TCGplayer runtime caller is unavailable.");
    for (const mutant of [
      runtime.source.replace("limits: TcgplayerExportIngestLimits;", "limits?: TcgplayerExportIngestLimits;"),
      runtime.source.replace("input.limits,", "{ maxRecords: 100_000 },"),
      runtime.source.replace("input.limits,", "{ maxRecords: input.limits.maxRecords - 1 },"),
      runtime.source.replace(
        "type TcgplayerExportIngestLimits,",
        "type TcgplayerExportIngestLimits,\ntype LocalExportLimits = Readonly<{ maxRecords: number }>;",
      ),
      runtime.source.replace("input.limits,", "undefined as never,"),
    ]) {
      expect(
        inspectExportLimitCallers([{ relativePath: "arbitrary/raw-export-owner.ts", source: mutant }]).violations,
      ).not.toEqual([]);
    }
  });

  it("keeps the TCGplayer scope fence code-shaped and path-independent", () => {
    const featureRoot = path.resolve(import.meta.dirname, "..");
    const entries = listSources(featureRoot)
      .filter((file) => !file.includes(`${path.sep}tests${path.sep}`))
      .map((file) => ({ relativePath: path.relative(featureRoot, file), source: readFileSync(file, "utf8") }));
    expect(inspectTcgplayerScope(entries)).toEqual({ scanned: entries.length, total: entries.length, violations: [] });
    const arbitraryPathMutants = [
      'import { writeCatalog } from "../../../../catalog/api";',
      "await fetch(providerUrl, { method: 'POST' });",
      "const credential = await readCredential();",
      "const moveToLive = true;",
      "const providerByteLimit = 10_000_000;",
      "CREATE TABLE tcgplayer_second_operation_queue",
    ];
    for (const source of arbitraryPathMutants) {
      expect(inspectTcgplayerScope([{ relativePath: "arbitrary/new-surface.ts", source }]).violations).not.toEqual([]);
    }
  });

  it("rejects fixture identities that counterfeit or misplace captured provider facts", () => {
    expect(
      inspectFixtureProvenance({
        identityKind: "synthetic",
        externalId: "90000001",
        priceColumn: "TCG Marketplace Price",
        priceText: "0.2600",
      }),
    ).toEqual([]);
    expect(
      inspectFixtureProvenance({
        identityKind: "redacted",
        externalId: "[redacted-1]",
        priceColumn: "TCG Marketplace Price",
        priceText: "0.2600",
      }),
    ).toContain("bracketed-numeric-redaction");
    expect(
      inspectFixtureProvenance({
        identityKind: "synthetic",
        externalId: "8527463",
        priceColumn: "TCG Marketplace Price",
        priceText: "9.9900",
      }),
    ).toContain("real-identity-with-invented-fact");
    expect(
      inspectFixtureProvenance({
        identityKind: "synthetic",
        externalId: "90000001",
        priceColumn: "TCG Marketplace Price",
        priceText: "2.5900",
      }),
    ).toContain("misplaced-low-price-with-shipping");
  });

  it("composes the canonical producer runtimes, TCGplayer profiles, schema, and expiry settlement port", () => {
    const contextRoot = path.resolve(import.meta.dirname, "../../..");
    const compositionRoot = readFileSync(path.join(contextRoot, "index.ts"), "utf8");
    for (const required of [
      "createChannelCompositionProfileRegistry(tcgplayerCompositionProfiles)",
      "claimedReservationRunSettlement: createTcgplayerClaimedReservationRunSettlementPort(eventStore)",
      "createTcgplayerCsvRuntime({",
      "transactionalEventStore: eventStore",
      "...tcgplayerCsvSchemaMigrations",
      "...tcgplayerCsv.projectors",
    ]) {
      expect(compositionRoot, required).toContain(required);
    }
    expect(compositionRoot).toContain("export { type ChannelEnvironment }");
    const runtime = readFileSync(path.resolve(import.meta.dirname, "../api/runtime.ts"), "utf8");
    expect(runtime).toContain("reserveClaimedOutboundOperationsInTransaction(");
    expect(runtime).not.toContain("outboundSync.reserveClaimedOutboundOperations({");
    expect(runtime).toContain("transactionalEventStore.appendToStreamInTransaction(db");
  });

  it("keeps membership digests stable across jsonb-style object key reordering", () => {
    const member = {
      operationId: "operation-synthetic",
      attemptId: "attempt-synthetic",
      claimGeneration: 1,
      reservationId: "reservation-synthetic",
      channelListingId: "channel-listing-synthetic",
      listingId: "listing-synthetic",
      desiredStateSequence: 9,
      listingRevision: 3,
      payloadDigest: "a".repeat(64),
      ordinal: 0,
      memberKind: "composed" as const,
      externalKey: "product:90000001",
      conditionText: null,
      basisSnapshotId: "snapshot-synthetic",
      basisSnapshotGeneration: 1,
      basisTotalQuantity: 2,
      basisPriceAmountMinor: 26,
      targetQuantity: 1,
      targetPriceAmountMinor: 27,
      csvRow: { Zeta: "last", Alpha: "first" },
      refusalReason: null,
      mappingDimension: null,
      mappingSourceKey: null,
    };
    const reordered = { ...member, csvRow: { Alpha: "first", Zeta: "last" } };
    expect(digestChannelSyncRunMembers([member])).toBe(digestChannelSyncRunMembers([reordered]));
  });
});

type SourceEntry = Readonly<{ relativePath: string; source: string }>;

function listSources(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function inspectCanonicalProducerSources(entries: readonly SourceEntry[]) {
  const violations: string[] = [];
  const forbidden = [
    /(?:type|interface)\s+(?:ClaimedOutboundOperation|ClaimedOperationReservation|ChannelCompositionProfile|ChannelReferenceRead)\b/,
    /as\s+(?:ClaimedOutboundOperation|ClaimedOperationReservation|OutboundSyncServices)\b/,
    /\b(?:reservation|operation)!\./,
    /desiredStateSequence\s*:\s*(?:operation\.)?listingRevision/,
  ];
  for (const entry of entries) {
    forbidden.forEach((pattern, index) => {
      if (pattern.test(entry.source)) violations.push(`${entry.relativePath}:producer-contract-${index + 1}`);
    });
  }
  return { scanned: entries.length, total: entries.length, violations };
}

function inspectExportLimitCallers(entries: readonly SourceEntry[]) {
  const callers = entries
    .filter(
      (entry) =>
        entry.source.includes("parseTcgplayerFullExport(") &&
        !/export\s+function\s+parseTcgplayerFullExport\s*\(/.test(entry.source),
    )
    .map((entry) => entry.relativePath.replaceAll("\\", "/"))
    .sort();
  const violations: string[] = [];
  for (const entry of entries) {
    if (
      !entry.source.includes("parseTcgplayerFullExport(") ||
      /export\s+function\s+parseTcgplayerFullExport\s*\(/.test(entry.source)
    )
      continue;
    if (!entry.source.includes("limits: TcgplayerExportIngestLimits;"))
      violations.push(`${entry.relativePath}:required-limits`);
    if (!/parseTcgplayerFullExport\([\s\S]*?input\.limits,?\s*\)/m.test(entry.source)) {
      violations.push(`${entry.relativePath}:unthreaded-limits`);
    }
    if (/type\s+LocalExportLimits\b/.test(entry.source)) violations.push(`${entry.relativePath}:local-limit-contract`);
    if (/parseTcgplayerFullExport\([\s\S]*?maxRecords\s*:/m.test(entry.source)) {
      violations.push(`${entry.relativePath}:defaulted-or-narrowed-limit`);
    }
    if (/parseTcgplayerFullExport\([\s\S]*?undefined\s+as\s+never/m.test(entry.source)) {
      violations.push(`${entry.relativePath}:missing-limit`);
    }
  }
  return { scanned: entries.length, total: entries.length, callers, violations };
}

function inspectTcgplayerScope(entries: readonly SourceEntry[]) {
  const forbidden = [
    /from\s+["'][^"']*(?:bounded-contexts\/|(?:\.\.\/){3,})(?:catalog|inventory|marketplace)\//,
    /\bfetch\s*\(/,
    /\b(?:readCredential|credentialReference|credentialToken|credentialSecret|oauth|playwright|puppeteer)\b/i,
    /move\s*to\s*live|moveToLive/i,
    /provider(?:Row|Byte)Limit/,
    /(?:second|alternate).*operation.*queue|tcgplayer_second_operation_queue/i,
  ];
  const violations: string[] = [];
  for (const entry of entries) {
    forbidden.forEach((pattern, index) => {
      if (pattern.test(entry.source)) violations.push(`${entry.relativePath}:scope-${index + 1}`);
    });
  }
  return { scanned: entries.length, total: entries.length, violations };
}

function inspectFixtureProvenance(
  fixture: Readonly<{
    identityKind: "synthetic" | "provider-fact-verbatim" | "redacted";
    externalId: string;
    priceColumn: string;
    priceText: string;
  }>,
): string[] {
  const violations: string[] = [];
  if (fixture.identityKind === "redacted" && /^\[[^\]]+\]$/.test(fixture.externalId)) {
    violations.push("bracketed-numeric-redaction");
  }
  if (["8527463", "8527473"].includes(fixture.externalId) && fixture.identityKind !== "provider-fact-verbatim") {
    violations.push("real-identity-with-invented-fact");
  }
  if (fixture.priceColumn === "TCG Marketplace Price" && fixture.priceText === "2.5900") {
    violations.push("misplaced-low-price-with-shipping");
  }
  return violations;
}
