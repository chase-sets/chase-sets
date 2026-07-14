import { describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildDiscoverySavedListPickerProjectionHandlers } from "./projection";

function event(type: string, streamVersion: number, data: Record<string, unknown>) {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "collections.saved-list-lst_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-07-14T00:00:00.000Z", recordedAt: "2026-07-14T00:00:00.000Z" },
  });
}

class RecordingDb implements PgQueryable {
  public readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    this.calls.push({ sql, values });
    return { rows: [], rowCount: 1 };
  }
}

describe("Discovery Saved List Addition Collections projection", () => {
  it("creates an account-owned local picker row from the Saved List created fact", async () => {
    const db = new RecordingDb();
    const handlers = buildDiscoverySavedListPickerProjectionHandlers(db);

    await handlers["collections.saved-list.created"]?.(
      event("collections.saved-list.created", 1, {
        ownerAccountId: "acc_1",
        title: "Trade targets",
        createdAt: "2026-07-14T00:00:00.000Z",
      }),
    );

    expect(db.calls[0]?.sql).toContain("INSERT INTO discovery_saved_list_picker");
    expect(db.calls[0]?.values).toEqual(["lst_1", "acc_1", "Trade targets", 1, "2026-07-14T00:00:00.000Z"]);
  });

  it("updates local picker counts without reading Collections at request time", async () => {
    const db = new RecordingDb();
    const handlers = buildDiscoverySavedListPickerProjectionHandlers(db);

    await handlers["collections.saved-list.line-added"]?.(
      event("collections.saved-list.line-added", 2, {
        lineId: "line_1",
        trackedQuantity: 3,
        addedAt: "2026-07-14T00:01:00.000Z",
      }),
    );

    expect(db.calls[0]?.sql).toContain("tracked_unit_count = tracked_unit_count + $2");
    expect(db.calls[0]?.values).toEqual(["lst_1", 3, "line_1", 2, "2026-07-14T00:01:00.000Z"]);
  });
});
