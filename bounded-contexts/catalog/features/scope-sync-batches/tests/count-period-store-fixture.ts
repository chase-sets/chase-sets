import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import * as domain from "../domain/count-acquisition";
import * as period from "../domain/scrydex-billing-period";
import { createCountStore } from "../read-model/count-store";
import { guardDisabledMutant } from "./count-capture-mutants";
import { periodAt, periodGateForTest, syntheticPeriod } from "./scrydex-period-fixture";

type HistoryEvent = {
  event_id: string;
  event_kind: string;
  quote_id: string | null;
  query_key: string | null;
  debit_id: string | null;
  scope_record_id: string | null;
  count_kind: string | null;
  payload: unknown;
  recorded_at: string;
};

/** A retained, checked Scrydex usage snapshot `consumed` credits into the synthetic billing period. */
export function periodUsage(consumed: number, patch: Record<string, unknown> = {}) {
  return {
    remainingCredits: 100_000 - consumed,
    totalCredits: 100_000,
    observedAt: periodAt,
    attemptState: "checked",
    billingPeriod: syntheticPeriod,
    ...patch,
  };
}

/**
 * An in-memory stand-in for the count history table that answers exactly the
 * count store's statements, so the real store's locked admission, claims and
 * period gate run unchanged. Capture history contributes no usage sends.
 */
export function periodHistoryPool(initialUsage: unknown) {
  const events: HistoryEvent[] = [];
  let usage = initialUsage;
  const of = (kind: string, quoteId?: unknown) =>
    events.filter((event) => event.event_kind === kind && (quoteId === undefined || event.quote_id === quoteId));
  const query = async (sql: string, values: readonly unknown[] = []) => {
    const rows = (value: unknown[]) => ({ rows: value });
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("pg_advisory_xact_lock") || sql.includes("set_config"))
      return rows([]);
    if (sql.includes("INSERT INTO catalog_scope_sync_count_history")) {
      const [event_id, , event_kind, quote_id, query_key, debit_id, scope_record_id, count_kind, payload, recorded_at] =
        values as (string | null)[];
      events.push({
        event_id: event_id!,
        event_kind: event_kind!,
        quote_id,
        query_key,
        debit_id,
        scope_record_id,
        count_kind,
        payload: JSON.parse(payload!),
        recorded_at: recorded_at!,
      });
      return rows([]);
    }
    if (sql.includes("catalog_scope_sync_count_capture_history")) return rows([{ credits: "0", uncertain: "0" }]);
    if (sql.includes("AS reserved")) return rows([{ debits: String(of("debit").length), reserved: "0" }]);
    if (sql.includes("a.event_kind='allocated'"))
      return rows(
        of("allocated", values[1] ?? undefined).map((event) => ({
          ...event,
          converted: String(of("debit", event.quote_id).length),
          ended_at: of("allocation-ended", event.quote_id)[0]?.recorded_at ?? null,
        })),
      );
    if (sql.includes("event_kind='usage'"))
      return rows(usage === null ? [] : [{ event_id: "synthetic-usage", payload: usage, recorded_at: periodAt }]);
    if (sql.includes("event_kind='quoted'")) return rows(of("quoted", values[1]).slice(0, 1));
    if (sql.includes("IN ('approved','debit','allocated')"))
      return rows([
        {
          events: String(
            events.filter(
              (event) => event.quote_id === values[1] && ["approved", "debit", "allocated"].includes(event.event_kind),
            ).length,
          ),
        },
      ]);
    if (sql.includes("AS recorded")) return rows([{ recorded: String(of("debit", values[1]).length) }]);
    if (sql.includes("AS aggregate")) {
      const debits = of("debit", values[0]);
      const perSet = debits.filter((event) => event.scope_record_id === values[1]);
      return rows([
        {
          aggregate: String(debits.length),
          per_set: String(perSet.length),
          per_kind: String(perSet.filter((event) => event.count_kind === values[2]).length),
        },
      ]);
    }
    if (sql.includes("event_kind='approved'")) return rows(of("approved", values[0]).slice(0, 1));
    if (sql.includes("d.query_key=$2")) {
      const debit = of("debit")
        .filter((event) => event.query_key === values[1])
        .at(-1);
      return rows(
        debit
          ? [{ ...debit, result: of("result").find((event) => event.debit_id === debit.event_id)?.payload ?? null }]
          : [],
      );
    }
    if (sql.includes("WHERE event_id=$1 AND account_slot=$2 AND quote_id=$3"))
      return rows(
        of("debit", values[2]).filter((event) => event.event_id === values[0] && event.query_key === values[3]),
      );
    return rows([]);
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => undefined }),
  } as unknown as PgTransactionalPool;
  return {
    pool,
    events,
    setUsage: (value: unknown) => {
      usage = value;
    },
  };
}

/** The real count store, or under SCRYDEX_PERIOD_MUTANT=bypass-period-cap its source with the cap comparison disabled. */
export function periodStoreForTest(): typeof createCountStore {
  if (process.env.SCRYDEX_PERIOD_MUTANT !== "bypass-period-cap") return createCountStore;
  return guardDisabledMutant<typeof createCountStore>(
    "../read-model/count-store.ts",
    ["evaluateScrydexBillingPeriod({", "periodGate({"],
    "createCountStore",
    { randomUUID, z, withPgTransaction, ...domain, ...period, periodGate: periodGateForTest() },
  );
}
