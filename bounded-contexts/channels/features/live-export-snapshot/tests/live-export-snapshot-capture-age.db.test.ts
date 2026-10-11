import { expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { evaluateSnapshotAge } from "../../reconciliation/domain/snapshot-age";
import { persistTcgplayerExportSnapshot } from "../../tcgplayer-csv/api/runtime";
import { readLatestLiveSnapshotMetadata } from "../../tcgplayer-csv/read-model/queries";
import { consumerMutant, persistMutant } from "./mutants";
import {
  admitExport,
  connectionId,
  describeDb,
  liveExport,
  liveExportDatabase,
  liveExportRuntime,
  snapshotEffects,
} from "./test-support";

describeDb("live-export-snapshot-capture-age persisted evidence", () => {
  const h = liveExportDatabase("live_export_capture_age");

  it("retains a capture 23h before ingestion: a run 2h later is stale, unlike the ingestion-time mutant", async () => {
    const capturedAt = new Date(Date.now() - 23 * 3_600_000).toISOString();
    await admitExport(h.db, "old-capture", liveExport(capturedAt));
    expect(await liveExportRuntime(h.db).consumeConnection(connectionId)).toBe(1);
    const rows = await readLatestLiveSnapshotMetadata(h.db, connectionId);
    expect(rows[0]).toMatchObject({ capturedAt, capturedAtSource: "connector-captured" });
    const run = new Date(Date.parse(rows[0]!.ingestedAt) + 2 * 3_600_000).toISOString();
    expect(evaluateSnapshotAge(rows, run, 86_400_000)).toEqual({ kind: "stale", reason: "snapshot-capture-stale" });

    await admitExport(h.db, "mutant-capture", liveExport(capturedAt));
    const mutant = consumerMutant("capturedAt: plan.payload.capturedAt,", "capturedAt: ingestedAt,");
    expect(await liveExportRuntime(h.db, {}, mutant).consumeConnection(connectionId)).toBe(1);
    expect(evaluateSnapshotAge(await readLatestLiveSnapshotMetadata(h.db, connectionId), run, 86_400_000)).toEqual({
      kind: "fresh",
    });
  });

  it("staged refuses connector attribution before any write; the bypass persists forbidden attribution", async () => {
    const payload = liveExport("2026-10-10T11:00:00.000Z");
    const input = {
      snapshotId: "synthetic-staged",
      connectionId,
      surface: "staged" as const,
      parsed: { ...payload.parsed, surface: "staged" as const },
      ingestedAt: "2026-10-10T12:00:00.000Z",
      capturedAt: payload.capturedAt,
      capturedAtSource: "connector-captured" as const,
    };
    const before = await snapshotEffects(h.db);
    await expect(withPgTransaction(h.db, (db) => persistTcgplayerExportSnapshot(db, input))).rejects.toThrow(
      "Only a Live snapshot",
    );
    expect(await snapshotEffects(h.db)).toEqual(before);
    const mutant = persistMutant(
      'if (input.capturedAtSource === "connector-captured" && input.surface !== "live")',
      "if (false)",
    );
    await expect(withPgTransaction(h.db, (db) => mutant(db, input))).resolves.toMatchObject({
      surface: "staged",
      capturedAtSource: "connector-captured",
    });
  });
});
