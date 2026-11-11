import type { EventStore } from "@chase-sets/event-core/event-store";
import { ZERO_GLOBAL_POSITION, type AppendToStreamInput, type StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { createCatalogItemRuntime } from "./runtime";

export const removalContext = {
  tenantId: "tnt_removal" as never,
  audit: { performedByUserId: "usr_enqueue" as never, forAccountId: "acc_removal" as never },
};

type Projection = { id: string; title: string; status: string; language: string };

export function createBulkRemoveDraftsHarness(items: readonly (Partial<Projection> & Pick<Projection, "id">)[]) {
  const projections = new Map<string, Projection>();
  const streams = new Map<string, StoredEvent[]>();
  const appends: AppendToStreamInput[] = [];
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  let appendError: Error | null = null;
  let position = 0;
  const eventStore: EventStore = {
    readStream: async ({ streamId, fromVersion = 1, limit = 500 }) =>
      (streams.get(streamId) ?? []).filter((event) => event.streamVersion >= fromVersion).slice(0, limit),
    readAll: async () => [],
    appendToStream: async (input) => {
      if (appendError) throw appendError;
      const history = streams.get(input.streamId) ?? [];
      if (
        (input.expectedVersion === "no_stream" && history.length > 0) ||
        (typeof input.expectedVersion === "number" && input.expectedVersion !== history.length)
      ) {
        throw new Error("expected version conflict");
      }
      appends.push(input);
      const added = input.events.map(
        (event, index): StoredEvent => ({
          eventId: `evt_removal_${++position}` as never,
          streamId: input.streamId,
          streamVersion: history.length + index + 1,
          globalPosition: String(position) as never,
          tenantId: input.context.tenantId,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: {},
          occurredAt: "2026-11-09T00:00:00.000Z" as never,
          recordedAt: "2026-11-09T00:00:00.000Z" as never,
        }),
      );
      streams.set(input.streamId, [...history, ...added]);
      return added;
    },
  };
  const db: PgQueryable = {
    query: async <T>(sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      if (!sql.includes("FROM catalog_admin_catalog_item_list_pages AS item")) {
        throw new Error(`Unexpected removal harness SQL: ${sql}`);
      }
      let rows = [...projections.values()];
      if (sql.includes("ANY($1::text[])")) {
        const ids = values[0] as string[];
        rows = rows.filter((row) => ids.includes(row.id));
      } else {
        for (const [index, value] of values.entries()) {
          const parameter = `$${index + 1}`;
          if (sql.includes(`item.language_code = ${parameter}`)) rows = rows.filter((row) => row.language === value);
          if (sql.includes(`item.status = ${parameter}`)) rows = rows.filter((row) => row.status === value);
        }
        rows.sort((left, right) => left.title.localeCompare(right.title));
      }
      return { rows: rows.map((row) => ({ catalog_item_id: row.id, title: row.title, status: row.status })) as T[] };
    },
  };
  const services = createCatalogItemRuntime({
    eventStore,
    db,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
  });

  async function seed() {
    for (const item of items) {
      const id = item.id;
      projections.set(id, {
        id,
        title: item.title ?? id,
        status: item.status ?? "draft",
        language: item.language ?? "en",
      });
      await services.commandHandler({
        streamId: `catalog.item-${id}`,
        command: {
          type: "CreateCatalogItem",
          itemId: id as never,
          languageCode: "en",
          title: localizedTextMapFromEnglish(item.title ?? id),
          subtitle: null,
          description: localizedTextMapFromEnglish(""),
        },
        context: removalContext,
      });
      if (item.status === "active") await publish(id);
    }
    appends.length = 0;
    statements.length = 0;
  }

  async function publish(id: string) {
    return eventStore.appendToStream({
      streamId: `catalog.item-${id}`,
      expectedVersion: streams.get(`catalog.item-${id}`)?.length ?? 0,
      context: removalContext,
      events: [{ eventType: "catalog.catalog-item.published", payload: { blueprintId: "bpr_synthetic" } }],
    });
  }

  return {
    services,
    db,
    projections,
    streams,
    statements,
    appends,
    seed,
    publish,
    failAppends: (error: Error) => {
      appendError = error;
    },
    removalEvents: (id: string) =>
      (streams.get(`catalog.item-${id}`) ?? []).filter(
        (event) => event.eventType === "catalog.catalog-item.draft-removed",
      ),
  };
}
