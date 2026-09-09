import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tcgplayerCsvSchemaMigrations, tcgplayerCsvSchemaSql } from "../read-model/schema";

describe("tcgplayer-bootstrap-manifest-and-replay", () => {
  it("keeps boot SQL and the same-change migration aligned for every owned table and index", () => {
    const migration = tcgplayerCsvSchemaMigrations[0]!;
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
    expect(tcgplayerCsvSchemaSql).toContain("ON DELETE RESTRICT");
  });

  it("imports producer interfaces instead of redeclaring or casting them across arbitrary paths", () => {
    const featureRoot = path.resolve(import.meta.dirname, "..");
    const sources = listSources(featureRoot);
    const combined = sources.map((file) => readFileSync(file, "utf8")).join("\n");
    expect({ scanned: sources.length, total: sources.length }).toEqual({
      scanned: sources.length,
      total: sources.length,
    });
    expect(combined).toContain('from "../../outbound-sync/domain/contracts"');
    expect(combined).toContain('from "../../listing-composition/domain/contracts"');
    expect(combined).not.toMatch(
      /(?:type|interface)\s+(?:ClaimedOutboundOperation|ClaimedOperationReservation|ChannelCompositionProfile|ChannelReferenceRead)\b/,
    );
    expect(combined).not.toMatch(
      /as\s+(?:ClaimedOutboundOperation|ClaimedOperationReservation|OutboundSyncServices)\b/,
    );
    expect(combined).not.toMatch(/desiredStateSequence\s*:\s*(?:operation\.)?listingRevision/);
  });
});

function listSources(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.parentPath.includes(`${path.sep}tests`))
    .map((entry) => path.join(entry.parentPath, entry.name));
}
