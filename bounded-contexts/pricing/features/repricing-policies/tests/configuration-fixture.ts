import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  PgPoolClient,
  PgTransactionalPool,
  PgQueryable,
  PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import type { ConfigurationClosureStatus } from "@chase-sets/event-core/configuration-epoch";
import { randomUUID } from "node:crypto";
import { RepricingConfigurationConflict, type RepricingConfigurationWriter } from "../api/configuration";
import { parseRepricingConfigurationReceipt } from "../domain/configuration-receipt";

export function withMemoryConfigurationTransactions(eventStore: EventStore) {
  return {
    ...eventStore,
    readStreamInTransaction: (_, input) => eventStore.readStream(input),
    appendToStreamInTransaction: (_, input) => eventStore.appendToStream(input),
  } satisfies EventStore & Pick<PostgresEventStore, "readStreamInTransaction" | "appendToStreamInTransaction">;
}

export function createMemoryRepricingConfigurationWriter(eventStore: EventStore): RepricingConfigurationWriter {
  const requests = new Map<string, { key: string; fingerprint: string; receipt: unknown }>();
  const heads = new Map<string, number>();
  const client: PgPoolClient = { query: async () => ({ rows: [] }), release: () => undefined };
  return {
    async request(input) {
      const requestKey = input.requestKey ?? randomUUID();
      const original = requests.get(`${input.accountId}:${requestKey}`);
      if (original) {
        if (original.key !== input.key || original.fingerprint !== input.fingerprint)
          throw new RepricingConfigurationConflict("Request key already used.");
        return parseRepricingConfigurationReceipt(original.receipt, input.parseState);
      }
      const prepared = await input.prepare(client);
      if (!prepared) return null;
      if (input.installationGuard && !(await input.installationGuard.allowsInstallation(client)))
        throw new Error("Use the durable writer fixture to exercise guarded pending installation.");
      const requestedRevision =
        (heads.get(input.key) ??
          (typeof prepared.append.expectedVersion === "number" ? prepared.append.expectedVersion : 0)) + 1;
      await eventStore.appendToStream(prepared.append);
      const receipt = {
        requestKey,
        requestedRevision,
        installedRevision: requestedRevision,
        status: "applied" as const,
        state: prepared.state,
      };
      heads.set(input.key, requestedRevision);
      requests.set(`${input.accountId}:${requestKey}`, { key: input.key, fingerprint: input.fingerprint, receipt });
      return receipt;
    },
    async retry(key, accountId, requestKey, fingerprint, parseState) {
      return this.request({ key, accountId, requestKey, fingerprint, parseState, prepare: async () => null });
    },
    async status(key, parseState) {
      const current = [...requests.values()].filter((request) => request.key === key).at(-1);
      const request = current ? parseRepricingConfigurationReceipt(current.receipt, parseState) : null;
      return {
        installedRevision: heads.get(key) ?? 0,
        installedState: request?.status === "applied" ? request.state : null,
        requestedRevision: heads.get(key) ?? 0,
        request,
      };
    },
    async list() {
      return [];
    },
  };
}

export function createConfigurationPoolFixture(
  delegate: PgTransactionalPool = {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }),
  },
) {
  type Row = {
    key: string;
    seller_account_id: string;
    request_key: string;
    fingerprint: string;
    requested_revision: number;
    prepared: string;
    prepared_hash: string;
    receipt: unknown;
    committed_events: unknown[];
  };
  const rows = new Map<string, Row>();
  const heads = new Map<
    string,
    { requested_revision: number; installed_revision: number; creation_revision: number }
  >();
  const control = { pending: false };
  const invalidations = new Map<string, { generation: string; status: string; affected_reservation_ids: string[] }>();
  const query =
    (fallback: PgQueryable): PgQueryable["query"] =>
    async <T>(sql: string, values: readonly unknown[] = []) => {
      const key = String(values[0]);
      let result: unknown[] = [];
      if (sql.includes("pg_advisory_xact_lock") || sql.startsWith("SET LOCAL")) return { rows: [] };
      if (sql.startsWith("INSERT INTO event_owner_stream_invalidations")) {
        const row = { generation: String(values[1]), status: "PENDING", affected_reservation_ids: [] };
        invalidations.set(key, row);
        result = [row];
      } else if (sql.startsWith("SELECT generation::text, status, affected_reservation_ids")) {
        if (invalidations.has(key)) result = [invalidations.get(key)];
      } else if (sql.startsWith("UPDATE event_owner_stream_invalidations SET status = 'APPLIED'")) {
        invalidations.get(key)!.status = "APPLIED";
      } else if (sql.startsWith("INSERT INTO pricing_repricing_configuration_heads")) {
        if (!heads.has(key))
          heads.set(key, {
            requested_revision: Number(values[2]),
            installed_revision: Number(values[2]),
            creation_revision: Number(values[2]),
          });
      } else if (sql.includes("SELECT key FROM pricing_repricing_configuration_heads")) {
        result = [
          ...new Set(
            [...rows.values()]
              .filter(
                (row) =>
                  row.seller_account_id === key &&
                  heads.get(row.key)!.installed_revision < heads.get(row.key)!.requested_revision,
              )
              .map((row) => row.key),
          ),
        ].map((key) => ({ key }));
      } else if (sql.includes("SELECT requested_revision, installed_revision")) {
        if (heads.has(key)) result = [heads.get(key)];
      } else if (sql.includes("count(*)::text AS count")) {
        const revisions = [...rows.values()].filter((row) => row.key === key).map((row) => row.requested_revision);
        result = [
          {
            count: String(revisions.length),
            first: revisions.length ? Math.min(...revisions) : null,
            last: revisions.length ? Math.max(...revisions) : null,
          },
        ];
      } else if (sql.includes("FROM pricing_repricing_configuration_requests")) {
        result = [...rows.values()].filter((row) =>
          sql.includes("WHERE seller_account_id")
            ? row.seller_account_id === key && row.request_key === values[1]
            : row.key === key &&
              (sql.includes("AND request_key") ? row.request_key === values[1] : row.requested_revision === values[1]),
        );
      } else if (sql.includes("INSERT INTO pricing_repricing_configuration_requests")) {
        const row: Row = {
          key,
          requested_revision: Number(values[1]),
          request_key: String(values[2]),
          fingerprint: String(values[3]),
          prepared: String(values[4]),
          prepared_hash: String(values[5]),
          receipt: JSON.parse(String(values[6])),
          seller_account_id: String(values[7]),
          committed_events: [],
        };
        rows.set(`${key}:${row.request_key}`, row);
      } else if (sql.includes("UPDATE pricing_repricing_configuration_requests SET receipt = jsonb_build_object")) {
        for (const row of rows.values()) {
          const receipt = row.receipt as { status: string };
          if (row.key === key && receipt.status === "accepted-pending")
            row.receipt = {
              requestKey: row.request_key,
              requestedRevision: row.requested_revision,
              status: "superseded-by-revision",
              replacingRevision: Number(values[1]),
            };
        }
      } else if (sql.includes("UPDATE pricing_repricing_configuration_requests SET receipt")) {
        rows.get(`${key}:${values[1]}`)!.receipt = JSON.parse(String(values[2]));
        if (values[3]) rows.get(`${key}:${values[1]}`)!.committed_events = JSON.parse(String(values[3]));
      } else if (sql.includes("UPDATE pricing_repricing_configuration_heads SET requested_revision"))
        heads.get(key)!.requested_revision = Number(values[1]);
      else if (sql.includes("UPDATE pricing_repricing_configuration_heads SET installed_revision"))
        heads.get(key)!.installed_revision = Number(values[1]);
      else if (sql.includes("JOIN pricing_repricing_configuration_requests"))
        result = [...rows.values()].filter((row) => row.seller_account_id === key);
      else return fallback.query<T>(sql.startsWith("BEGIN ISOLATION LEVEL") ? "BEGIN" : sql, values);
      return { rows: result as T[] };
    };
  const pool: PgTransactionalPool = {
    query: query(delegate),
    async connect() {
      const client = await delegate.connect();
      return { query: query(client), release: client.release };
    },
  };
  const status = (key: string): ConfigurationClosureStatus => ({
    key,
    epoch: 0,
    topologyRevision: 1,
    status: "PENDING",
    pendingConsumers: control.pending ? [{ storeId: "synthetic-withheld-store", incarnation: "synthetic-v1" }] : [],
  });
  const epochs = {
    beginClosureInTransaction: async (_: PgQueryable, key: string) => status(key),
    driveClosure: async (key: string) => status(key),
    installClosureInTransaction: async (_: PgQueryable, key: string) => {
      if (control.pending) throw new Error("Synthetic required store is still pending.");
      return { ...status(key), status: "OPEN" as const };
    },
  };
  return { pool, epochs, control, rows, heads };
}
