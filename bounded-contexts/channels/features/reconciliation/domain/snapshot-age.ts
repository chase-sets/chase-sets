import type { ChannelInventorySnapshot } from "../../tcgplayer-csv/domain/contracts";

export const SNAPSHOT_AGE_FINDING_ID = "snapshot-age";
export const SNAPSHOT_AGE_MEMBER_ID = `finding:${SNAPSHOT_AGE_FINDING_ID}`;

export type SnapshotAgeMetadata = Pick<
  ChannelInventorySnapshot,
  "snapshotId" | "snapshotGeneration" | "ingestedAt" | "capturedAt" | "capturedAtSource"
>;

export type SnapshotAge =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "stale"; reason: "snapshot-capture-stale" }>
  | Readonly<{
      kind: "unknown";
      reason:
        | "snapshot-missing"
        | "snapshot-capture-unattributed"
        | "snapshot-capture-invalid"
        | "snapshot-capture-future"
        | "snapshot-capture-not-increasing";
    }>;

export function evaluateSnapshotAge(
  newestFirst: readonly SnapshotAgeMetadata[],
  runAt: string,
  snapshotMaxAgeMs: number,
): SnapshotAge {
  const latest = newestFirst[0];
  if (!latest) return { kind: "unknown", reason: "snapshot-missing" };
  const run = instant(runAt);
  for (const snapshot of newestFirst.slice(0, 2)) {
    if (snapshot.capturedAtSource !== "operator-declared")
      return { kind: "unknown", reason: "snapshot-capture-unattributed" };
    const capture = instant(snapshot.capturedAt);
    const ingestion = instant(snapshot.ingestedAt);
    if (capture === null || ingestion === null || run === null)
      return { kind: "unknown", reason: "snapshot-capture-invalid" };
    if (capture > ingestion || capture > run) return { kind: "unknown", reason: "snapshot-capture-future" };
  }
  const previous = newestFirst[1];
  if (previous && Date.parse(latest.capturedAt) <= Date.parse(previous.capturedAt))
    return { kind: "unknown", reason: "snapshot-capture-not-increasing" };
  return Date.parse(runAt) - Date.parse(latest.capturedAt) > snapshotMaxAgeMs
    ? { kind: "stale", reason: "snapshot-capture-stale" }
    : { kind: "fresh" };
}

function instant(value: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
