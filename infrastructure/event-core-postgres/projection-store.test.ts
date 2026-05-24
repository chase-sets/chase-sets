import { describe, expect, it } from "vitest";
import type { PgQueryable } from "./types";
import { createPostgresProjectionStore } from "./projection-store";

describe("postgres projection store", () => {
  it("records poison events, blocks the stream, and reports active error summary", async () => {
    const db = createProjectionStoreDb();
    const store = createPostgresProjectionStore({
      db,
      now: () => "2026-05-24T00:00:00.000Z" as never,
    });

    await store.recordPoisonEvent?.({
      projectionKey: "catalog-item-projection",
      projectionName: "catalog-item-projection",
      projectionKind: "projector",
      streamId: "catalog.item-cat_bad",
      streamVersion: 1,
      eventId: "evt_1",
      eventType: "catalog.catalog-item.published",
      globalPosition: "1" as never,
      failureKind: "poison",
      errorMessage: "bad item payload",
      errorStack: null,
    });
    await store.recordDeferredBlockedStreamEvent?.({
      projectionKey: "catalog-item-projection",
      streamId: "catalog.item-cat_bad",
      streamVersion: 2,
      globalPosition: "3" as never,
    });

    await expect(store.loadBlockedStream?.("catalog-item-projection", "catalog.item-cat_bad")).resolves.toMatchObject({
      projectionKey: "catalog-item-projection",
      streamId: "catalog.item-cat_bad",
      firstBlockedGlobalPosition: "1",
      firstBlockedStreamVersion: 1,
      lastSeenGlobalPosition: "3",
      deferredEventCount: 1,
      state: "blocked",
    });
    await expect(store.loadProjectionErrorSummary?.("catalog-item-projection")).resolves.toEqual({
      blockedStreamCount: 1,
      poisonEventCount: 1,
    });
    await expect(store.listBlockedStreams?.("catalog-item-projection")).resolves.toHaveLength(1);

    await store.resolveBlockedStream?.("catalog-item-projection", "catalog.item-cat_bad");
    await expect(store.loadProjectionErrorSummary?.("catalog-item-projection")).resolves.toEqual({
      blockedStreamCount: 0,
      poisonEventCount: 0,
    });
  });
});

function createProjectionStoreDb(): PgQueryable {
  const blockedStreams = new Map<
    string,
    {
      projectionKey: string;
      streamId: string;
      firstBlockedGlobalPosition: string;
      firstBlockedStreamVersion: number;
      lastSeenGlobalPosition: string;
      deferredEventCount: number;
      state: "blocked" | "retrying" | "resolved";
    }
  >();
  const poisonEvents = new Set<string>();

  return {
    query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO event_projection_poison_events")) {
        poisonEvents.add(`${String(params[0])}:${String(params[1])}`);
        return { rows: [] as Row[], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = String(params[1]);
        const key = `${projectionKey}:${streamId}`;
        const existing = blockedStreams.get(key);
        blockedStreams.set(key, {
          projectionKey,
          streamId,
          firstBlockedGlobalPosition: existing?.firstBlockedGlobalPosition ?? String(params[2]),
          firstBlockedStreamVersion: existing?.firstBlockedStreamVersion ?? Number(params[3]),
          lastSeenGlobalPosition: String(params[2]),
          deferredEventCount: existing ? existing.deferredEventCount + 1 : 0,
          state: "blocked",
        });
        return { rows: [] as Row[], rowCount: 1 };
      }

      if (
        sql.includes("SELECT") &&
        sql.includes("FROM event_projection_blocked_streams") &&
        sql.includes("FROM event_projection_poison_events")
      ) {
        const projectionKey = String(params[0]);
        return {
          rows: [
            {
              blocked_stream_count: [...blockedStreams.values()].filter(
                (stream) => stream.projectionKey === projectionKey && stream.state !== "resolved",
              ).length,
              poison_event_count: [...poisonEvents].filter((key) => key.startsWith(`${projectionKey}:`)).length,
            } as Row,
          ],
          rowCount: 1,
        };
      }

      if (sql.includes("FROM event_projection_blocked_streams") && !sql.includes("stream_id = $2")) {
        const projectionKey = String(params[0]);
        return {
          rows: [...blockedStreams.values()]
            .filter((stream) => stream.projectionKey === projectionKey && stream.state !== "resolved")
            .map(
              (stream) =>
                ({
                  projection_key: stream.projectionKey,
                  stream_id: stream.streamId,
                  first_blocked_global_position: stream.firstBlockedGlobalPosition,
                  first_blocked_stream_version: stream.firstBlockedStreamVersion,
                  last_seen_global_position: stream.lastSeenGlobalPosition,
                  deferred_event_count: stream.deferredEventCount,
                  state: stream.state,
                }) as Row,
            ),
          rowCount: blockedStreams.size,
        };
      }

      if (sql.includes("FROM event_projection_blocked_streams") && sql.includes("WHERE projection_key = $1")) {
        const stream = blockedStreams.get(`${String(params[0])}:${String(params[1])}`);
        return {
          rows: stream
            ? ([
                {
                  projection_key: stream.projectionKey,
                  stream_id: stream.streamId,
                  first_blocked_global_position: stream.firstBlockedGlobalPosition,
                  first_blocked_stream_version: stream.firstBlockedStreamVersion,
                  last_seen_global_position: stream.lastSeenGlobalPosition,
                  deferred_event_count: stream.deferredEventCount,
                  state: stream.state,
                },
              ] as Row[])
            : [],
          rowCount: stream ? 1 : 0,
        };
      }

      if (sql.includes("UPDATE event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = params[1] ? String(params[1]) : null;
        for (const [key, stream] of blockedStreams) {
          if (stream.projectionKey === projectionKey && (!streamId || stream.streamId === streamId)) {
            blockedStreams.set(key, { ...stream, state: "resolved" });
          }
        }
        return { rows: [] as Row[], rowCount: 1 };
      }

      if (sql.includes("UPDATE event_projection_poison_events")) {
        const projectionKey = String(params[0]);
        const streamId = params[1] ? String(params[1]) : null;
        for (const key of [...poisonEvents]) {
          if (
            key.startsWith(`${projectionKey}:`) &&
            (!streamId || blockedStreams.has(`${projectionKey}:${streamId}`))
          ) {
            poisonEvents.delete(key);
          }
        }
        return { rows: [] as Row[], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL in projection store test: ${sql}`);
    },
  };
}
