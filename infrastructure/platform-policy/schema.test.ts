import { describe, expect, it } from "vitest";
import { platformPolicySchemaMigrations, platformPolicySchemaSql } from "./schema";

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const addStreamVersion =
  "ALTER TABLE platform_policy_documents ADD COLUMN IF NOT EXISTS stream_version bigint NOT NULL DEFAULT 0";

describe("policy document stream version schema", () => {
  it("gives a new table and an existing table the same stream version column", () => {
    const bootSql = normalize(platformPolicySchemaSql);

    expect(bootSql).toContain("updated_at timestamptz NOT NULL, stream_version bigint NOT NULL DEFAULT 0 );");
    expect(bootSql).toContain(`${addStreamVersion};`);
    expect(bootSql).not.toMatch(/\bUPDATE\b/);
  });

  it("adds the column in the ledger before the backfill reads it", () => {
    expect(platformPolicySchemaMigrations.map((migration) => migration.migrationId)).toEqual([
      "20261123_platform_policy_document_stream_version",
    ]);
    const [addColumn, backfill, ...rest] = platformPolicySchemaMigrations[0]!.statements.map(normalize);

    expect(rest).toEqual([]);
    expect(addColumn).toBe(addStreamVersion);
    expect(backfill).toMatch(/^UPDATE platform_policy_documents AS policy_document SET stream_version = /);
  });

  it("backfills a row from the events its history records, not from the stream head", () => {
    const backfill = normalize(platformPolicySchemaMigrations[0]!.statements[1]!);

    expect(backfill).toContain(
      "SELECT history.document_id, max(stored_event.stream_version) AS stream_version " +
        "FROM platform_policy_document_history AS history " +
        "JOIN event_store_events AS stored_event ON stored_event.event_id = history.event_id " +
        "GROUP BY history.document_id",
    );
    expect(backfill).not.toMatch(/event_store_streams|current_version/);
  });

  it("backfills only a row that holds an earlier version, so a second run changes nothing", () => {
    const backfill = normalize(platformPolicySchemaMigrations[0]!.statements[1]!);

    expect(backfill).toMatch(
      /WHERE projected\.document_id = policy_document\.document_id AND policy_document\.stream_version < projected\.stream_version$/,
    );
  });
});
