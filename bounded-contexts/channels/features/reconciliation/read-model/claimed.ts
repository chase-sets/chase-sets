import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readAppliedListingMembership, readSnapshotRowsById } from "../../tcgplayer-csv/read-model/queries";
import type { ClaimedChannelStateRead } from "../domain/contracts";
import type { SnapshotAgeMetadata } from "../domain/snapshot-age";

export async function readPersistedClaimedState(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    snapshots: readonly SnapshotAgeMetadata[];
    freshness: ClaimedChannelStateRead["freshness"];
    maxListings: number;
  }>,
): Promise<ClaimedChannelStateRead> {
  const unavailable = (): ClaimedChannelStateRead => ({
    sourceAuthority: { kind: "declared-incomplete", reason: "claimed-material-unavailable" },
    freshness: input.freshness,
    snapshotId: input.snapshots[0]?.snapshotId ?? "",
    rows: [],
    appliedChannelListingIds: [],
  });
  if (input.freshness !== "current" || !input.snapshots[0]) return unavailable();
  const materials = await Promise.all(
    input.snapshots
      .slice(0, 2)
      .map((snapshot) => readSnapshotRowsById(db, { snapshotId: snapshot.snapshotId, maxRows: input.maxListings })),
  );
  if (
    materials.some(
      (material, index) =>
        !material ||
        material.snapshot.connectionId !== input.connectionId ||
        material.snapshot.surface !== "live" ||
        material.snapshot.snapshotId !== input.snapshots[index]!.snapshotId ||
        material.snapshot.snapshotGeneration !== input.snapshots[index]!.snapshotGeneration ||
        material.snapshot.capturedAt !== input.snapshots[index]!.capturedAt ||
        material.membershipCompleteness.kind !== "complete",
    )
  )
    return unavailable();
  const applied = await readAppliedListingMembership(db, {
    connectionId: input.connectionId,
    maxRows: input.maxListings,
  });
  if (!applied) return unavailable();
  const current = materials[0]!;
  return {
    sourceAuthority: {
      kind: "present-rows",
      collectedCount: current.rows.length,
      snapshotRowTotal: current.snapshot.parsedRowCount,
    },
    freshness: "current",
    snapshotId: current.snapshot.snapshotId,
    rows: current.rows,
    appliedChannelListingIds: applied.map((member) => member.channelListingId),
    appliedMaterialIdentities: applied,
    pair: materials[1]
      ? { previousRows: materials[1].rows, from: materials[1].snapshot.capturedAt, to: current.snapshot.capturedAt }
      : null,
  };
}
