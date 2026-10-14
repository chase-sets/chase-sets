import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProviderUsageSnapshot } from "../../source-observations/api/provider-adapters/provider-adapter";
import {
  CountAcquisitionRefused,
  countAllocationEndSchemaVersion,
  countAllocationSchema,
  countAllocationSchemaVersion,
  countFingerprint,
  countPreparationViewSchemaVersion,
  countQueryKey,
  countQuerySchema,
  countQuoteDebitSchema,
  countQuoteDebitsMax,
  countSourceIsCurrent,
  countTimeIsCurrent,
  countQuoteSchema,
  projectCountSpend,
  countResultSchema,
  type CountAuthority,
  type CountPreparationView,
  type CountQuote,
  type CountQuoteDebit,
  type CountSpend,
  type CountTarget,
  type ScrydexCountEvidence,
  type ScrydexCountQuery,
} from "../domain/count-acquisition";

// Scrydex account usage may lag live spend by 20-30 minutes per provider policy.
const SCRYDEX_USAGE_LAG_MS = 30 * 60 * 1000;
// A quote expires 15 minutes after it is made and admission follows the quote, so no
// allocation recorded earlier can still be active; expiry decides activity, and this
// scan bound doubles that lifetime as a margin for replica clock skew.
const ALLOCATION_WINDOW_MS = 2 * 900_000;
type Allocation = Readonly<{
  executionId: string;
  quoteId: string;
  plannedCredits: number;
  converted: number;
  admittedAt: string;
  expiresAt: string;
  endedAt: string | null;
}>;
const debitPayloadSchema = z.object({ query: countQuerySchema, credits: z.literal(1) }).strict();
const usageSchema = z
  .object({
    remainingCredits: z.number().int().min(0).max(2147483647).nullable(),
    totalCredits: z.number().int().min(0).max(2147483647).nullable(),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
    attemptState: z.enum(["checked", "unavailable", "not-configured"]),
  })
  .strict();
type Row = { event_id: string; payload: unknown; recorded_at: Date | string };
export type CountStore = ReturnType<typeof createCountStore>;
export function countAccountSlot(environment: string, revision: string): string {
  return countFingerprint({ provider: "scrydex", environment, revision });
}
export async function lockCountHeadroom(db: PgQueryable, slot: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalog-count:${slot}`]);
}
export function createCountStore(db: PgTransactionalPool, slot: string, now = () => new Date().toISOString()) {
  async function append(
    kind: string,
    payload: unknown,
    extra: {
      quoteId?: string;
      query?: ScrydexCountQuery;
      debitId?: string;
      scopeRecordId?: string;
      kind?: string;
    } = {},
    target: PgQueryable = db,
  ) {
    const id = randomUUID();
    await target.query(
      `INSERT INTO catalog_scope_sync_count_history (event_id, account_slot, event_kind, quote_id, query_key, debit_id, scope_record_id, count_kind, payload, recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`,
      [
        id,
        slot,
        kind,
        extra.quoteId ?? null,
        extra.query ? countQueryKey(extra.query) : null,
        extra.debitId ?? null,
        extra.scopeRecordId ?? null,
        extra.kind ?? null,
        JSON.stringify(payload),
        now(),
      ],
    );
    return id;
  }
  async function latest(query: ScrydexCountQuery, target: PgQueryable = db) {
    const rows = await target.query<Row & { result: unknown }>(
      `SELECT d.event_id, d.payload, d.recorded_at, r.payload AS result
      FROM catalog_scope_sync_count_history d LEFT JOIN catalog_scope_sync_count_history r ON r.debit_id=d.event_id AND r.event_kind='result'
      WHERE d.account_slot=$1 AND d.query_key=$2 AND d.event_kind='debit' ORDER BY d.position DESC LIMIT 1`,
      [slot, countQueryKey(query)],
    );
    return rows.rows[0] ?? null;
  }
  async function read(query: ScrydexCountQuery, target: PgQueryable = db) {
    const row = await latest(query, target);
    const parsed = countResultSchema.safeParse(row?.result);
    return parsed.success &&
      parsed.data.outcome === "complete" &&
      countSourceIsCurrent(parsed.data.evidence, query, now()) &&
      parsed.data.evidence.sourceId === row?.event_id
      ? parsed.data.evidence
      : null;
  }
  async function blocked(query: ScrydexCountQuery, target: PgQueryable = db) {
    const row = await latest(query, target);
    if (!row) return false;
    const result = countResultSchema.safeParse(row.result);
    if (!result.success || result.data.outcome === "uncertain") return true;
    return Date.parse(now()) - new Date(row.recorded_at).getTime() <= 900_000;
  }
  /** Whole-quote allocations recorded for one quote, or within the active window; null when any row is invalid. */
  async function allocations(
    target: PgQueryable,
    scope: { quoteId: string } | { since: string },
  ): Promise<Allocation[] | null> {
    const rows = await target.query<{
      event_id: string;
      quote_id: string | null;
      payload: unknown;
      recorded_at: Date | string;
      converted: string;
      ended_at: Date | string | null;
    }>(
      `SELECT a.event_id,a.quote_id,a.payload,a.recorded_at,
      (SELECT count(*) FROM catalog_scope_sync_count_history d
        WHERE d.account_slot=a.account_slot AND d.quote_id=a.quote_id AND d.event_kind='debit')::text AS converted,
      (SELECT min(e.recorded_at) FROM catalog_scope_sync_count_history e
        WHERE e.account_slot=a.account_slot AND e.quote_id=a.quote_id AND e.event_kind='allocation-ended') AS ended_at
      FROM catalog_scope_sync_count_history a
      WHERE a.account_slot=$1 AND a.event_kind='allocated'
        AND ($2::text IS NULL OR a.quote_id=$2) AND ($3::timestamptz IS NULL OR a.recorded_at >= $3::timestamptz)
      ORDER BY a.position`,
      [slot, "quoteId" in scope ? scope.quoteId : null, "since" in scope ? scope.since : null],
    );
    const parsed: Allocation[] = [];
    for (const row of rows.rows) {
      const payload = countAllocationSchema.safeParse(row.payload);
      const converted = Number(row.converted);
      if (!payload.success || !row.quote_id || !Number.isSafeInteger(converted)) return null;
      parsed.push({
        executionId: row.event_id,
        quoteId: row.quote_id,
        plannedCredits: payload.data.plannedCredits,
        converted,
        admittedAt: new Date(row.recorded_at).toISOString(),
        expiresAt: payload.data.expiresAt,
        endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
      });
    }
    // One execution per quote: a second allocation is never written, so reading one is corruption.
    return "quoteId" in scope && parsed.length > 1 ? null : parsed;
  }
  const allocationActive = (allocation: Allocation, at: string) =>
    allocation.endedAt === null && Date.parse(allocation.expiresAt) >= Date.parse(at);
  async function ledger(target: PgQueryable = db) {
    const rows = await target.query<Row>(
      `SELECT event_id,payload,recorded_at FROM catalog_scope_sync_count_history
      WHERE account_slot=$1 AND event_kind='usage' ORDER BY position DESC LIMIT 1`,
      [slot],
    );
    const at = now();
    const usage = usageSchema.safeParse(rows.rows[0]?.payload);
    const snapshot = usage.success ? usage.data : null;
    const unreflectedSince = snapshot?.observedAt
      ? new Date(Date.parse(snapshot.observedAt) - SCRYDEX_USAGE_LAG_MS).toISOString()
      : null;
    const totals = await target.query<{ debits: string; reserved: string }>(
      `SELECT
      (SELECT count(*) FROM catalog_scope_sync_count_history WHERE account_slot=$1 AND event_kind='debit'
        AND recorded_at > $2::timestamptz)::text AS debits,
      COALESCE((SELECT sum(GREATEST(0,(budget->'creditedProviderRequestLimits'->>'scrydex')::bigint))
        FROM catalog_scope_sync_batches WHERE status IN ('queued','running')
        OR updated_at > $2::timestamptz),0)::text AS reserved`,
      [slot, unreflectedSince],
    );
    const debits = Number(totals.rows[0]?.debits),
      reserved = Number(totals.rows[0]?.reserved);
    // Converted credits are already debits, so only the unconverted remainder of an allocation is held.
    const held = await allocations(target, {
      since: new Date(Date.parse(at) - ALLOCATION_WINDOW_MS).toISOString(),
    });
    const allocated = held?.reduce(
      (sum, allocation) =>
        sum + (allocationActive(allocation, at) ? Math.max(0, allocation.plannedCredits - allocation.converted) : 0),
      0,
    );
    const fresh =
      snapshot?.observedAt &&
      countTimeIsCurrent(
        {
          observedAt: snapshot.observedAt,
          expiresAt: new Date(Date.parse(snapshot.observedAt) + 900_000).toISOString(),
        },
        at,
      );
    const valid =
      fresh &&
      snapshot.attemptState === "checked" &&
      snapshot.remainingCredits !== null &&
      snapshot.totalCredits !== null &&
      snapshot.remainingCredits <= snapshot.totalCredits &&
      Number.isSafeInteger(debits) &&
      Number.isSafeInteger(reserved) &&
      allocated !== undefined;
    return {
      at,
      fingerprint: countFingerprint(snapshot),
      observedAt: snapshot?.observedAt ?? null,
      // Unclamped: a negative value means retained commitments already exceed the usage snapshot.
      net: valid ? Math.min(snapshot.remainingCredits!, snapshot.totalCredits!) - debits - reserved - allocated! : null,
    };
  }
  /** Retained usage less unreflected debits, batch reservations and unconverted quote allocations. */
  async function authority(target: PgQueryable = db): Promise<CountAuthority> {
    const current = await ledger(target);
    const headroom = current.net === null ? null : Math.max(0, current.net);
    return { fingerprint: current.fingerprint, headroom, allowed: headroom !== null };
  }
  async function saveQuote(quote: CountQuote, owner: string) {
    await append("quoted", { quote, owner }, { quoteId: quote.quoteId });
  }
  async function loadQuote(quoteId: string, owner: string, target: PgQueryable = db): Promise<CountQuote> {
    const rows = await target.query<Row>(
      `SELECT event_id,payload,recorded_at FROM catalog_scope_sync_count_history
      WHERE account_slot=$1 AND quote_id=$2 AND event_kind='quoted' LIMIT 1`,
      [slot, quoteId],
    );
    const parsed = z
      .object({ quote: countQuoteSchema, owner: z.string().min(1) })
      .strict()
      .safeParse(rows.rows[0]?.payload);
    if (!parsed.success || parsed.data.owner !== owner) throw new CountAcquisitionRefused();
    const { fingerprint, ...value } = parsed.data.quote;
    if (countFingerprint(value) !== fingerprint || value.quoteId !== quoteId) throw new CountAcquisitionRefused();
    return parsed.data.quote;
  }
  async function retainedQuote(quote: CountQuote): Promise<CountQuote> {
    const rows = await db.query<{ query_key: string; debit_id: string; payload: unknown }>(
      "SELECT query_key,debit_id,payload FROM catalog_scope_sync_count_history WHERE account_slot=$1 AND quote_id=$2 AND event_kind='result'",
      [slot, quote.quoteId],
    );
    const targets = await Promise.all(
      quote.targets.map(async (target) => {
        const row = rows.rows.find((row) => row.query_key === countQueryKey(target.query));
        const parsed = countResultSchema.safeParse(row?.payload);
        const source = await read(target.query);
        return source
          ? { ...target, source }
          : parsed.success &&
              parsed.data.outcome === "complete" &&
              parsed.data.evidence.sourceId === row?.debit_id &&
              countQueryKey(parsed.data.evidence.query) === countQueryKey(target.query)
            ? { ...target, source: parsed.data.evidence }
            : target;
      }),
    );
    return {
      ...quote,
      targets,
      state: await quoteState({ ...quote, targets }),
    };
  }
  async function approve(pool: PgTransactionalPool, quoteId: string, fingerprint: string, owner: string) {
    return withPgTransaction(pool, async (tx) => {
      await lockCountHeadroom(tx, slot);
      const quote = await loadQuote(quoteId, owner, tx);
      if (quote.fingerprint !== fingerprint || Date.parse(quote.expiresAt) < Date.parse(now()))
        throw new CountAcquisitionRefused();
      const approved = await tx.query(
        "SELECT event_id FROM catalog_scope_sync_count_history WHERE quote_id=$1 AND event_kind='approved' LIMIT 1",
        [quoteId],
      );
      if (!approved.rows.length) await append("approved", { fingerprint, owner }, { quoteId }, tx);
      return quote;
    });
  }
  /**
   * Whole-quote admission: under the account-slot headroom lock, the owned,
   * unexpired, never-executed quote must still be covered in full by current net
   * headroom; its P is then held as one allocation whose event id is the single
   * execution identity. No debit or send happens here.
   */
  async function admit(
    pool: PgTransactionalPool,
    quote: CountQuote,
    owner: string,
    expectedAuthority: CountAuthority,
  ): Promise<string> {
    return withPgTransaction(pool, async (tx) => {
      await lockCountHeadroom(tx, slot);
      const persisted = await loadQuote(quote.quoteId, owner, tx);
      const executed = await tx.query<{ events: string }>(
        `SELECT count(*)::text AS events FROM catalog_scope_sync_count_history
        WHERE account_slot=$1 AND quote_id=$2 AND event_kind IN ('approved','debit','allocated')`,
        [slot, quote.quoteId],
      );
      const current = await ledger(tx);
      if (
        persisted.fingerprint !== quote.fingerprint ||
        Date.parse(persisted.expiresAt) < Date.parse(current.at) ||
        persisted.plannedCredits < 1 ||
        persisted.cap < persisted.plannedCredits ||
        Number(executed.rows[0]?.events) !== 0 ||
        current.net === null ||
        current.fingerprint !== persisted.authority.fingerprint ||
        current.fingerprint !== expectedAuthority.fingerprint ||
        current.net < persisted.plannedCredits
      )
        throw new CountAcquisitionRefused();
      return append(
        "allocated",
        {
          schemaVersion: countAllocationSchemaVersion,
          admission: "whole-quote",
          plannedCredits: persisted.plannedCredits,
          quoteFingerprint: persisted.fingerprint,
          authorityFingerprint: persisted.authority.fingerprint,
          expiresAt: persisted.expiresAt,
        },
        { quoteId: quote.quoteId },
        tx,
      );
    });
  }
  /** Terminal close: fences every later claim of the execution, which releases only unconverted capacity. */
  async function end(
    pool: PgTransactionalPool,
    quoteId: string,
    executionId: string,
    owner: string,
    state: "complete" | "failed" | "uncertain",
  ) {
    await withPgTransaction(pool, async (tx) => {
      await lockCountHeadroom(tx, slot);
      await loadQuote(quoteId, owner, tx);
      const [allocation] = (await allocations(tx, { quoteId })) ?? [];
      if (allocation?.executionId !== executionId) throw new CountAcquisitionRefused();
      if (allocation.endedAt === null)
        await append(
          "allocation-ended",
          { schemaVersion: countAllocationEndSchemaVersion, executionId, state },
          { quoteId },
          tx,
        );
    });
  }
  /** A batch reservation may not take capacity an active allocation still holds unconverted. */
  async function allocationConflict(target: PgQueryable): Promise<boolean> {
    const at = now();
    const held = await allocations(target, { since: new Date(Date.parse(at) - ALLOCATION_WINDOW_MS).toISOString() });
    return (
      !held ||
      held.some((allocation) => allocationActive(allocation, at) && allocation.converted < allocation.plannedCredits)
    );
  }
  async function claim(
    pool: PgTransactionalPool,
    quote: CountQuote,
    item: CountTarget,
    owner: string,
    expectedAuthority: CountAuthority,
    executionId?: string,
  ): Promise<string | null> {
    return withPgTransaction(pool, async (tx) => {
      await lockCountHeadroom(tx, slot);
      const persisted = await loadQuote(quote.quoteId, owner, tx);
      // Fence first: an admitted quote is claimable only by its live execution, and
      // only while the allocation is neither ended nor expired; dropping the
      // admission mode never reaches its capacity.
      const held = await allocations(tx, { quoteId: quote.quoteId });
      const allocation = held?.[0] ?? null;
      if (
        !held ||
        (executionId
          ? allocation?.executionId !== executionId || !allocationActive(allocation, now())
          : allocation !== null)
      )
        throw new CountAcquisitionRefused();
      const approval = await tx.query(
        "SELECT event_id FROM catalog_scope_sync_count_history WHERE quote_id=$1 AND event_kind='approved' AND payload->>'fingerprint'=$2 LIMIT 1",
        [quote.quoteId, quote.fingerprint],
      );
      if (
        !approval.rows.length ||
        persisted.fingerprint !== quote.fingerprint ||
        !persisted.targets.some(
          (entry) =>
            entry.scopeRecordId === item.scopeRecordId && countQueryKey(entry.query) === countQueryKey(item.query),
        ) ||
        Date.parse(quote.expiresAt) < Date.parse(now())
      )
        throw new CountAcquisitionRefused();
      if (await read(item.query, tx)) return null;
      if (await blocked(item.query, tx)) throw new CountAcquisitionRefused();
      const current = await ledger(tx);
      const spent = await tx.query<{ aggregate: string; per_set: string; per_kind: string }>(
        `SELECT count(*)::text AS aggregate,
        count(*) FILTER (WHERE scope_record_id=$2)::text AS per_set,
        count(*) FILTER (WHERE scope_record_id=$2 AND count_kind=$3)::text AS per_kind
        FROM catalog_scope_sync_count_history WHERE quote_id=$1 AND event_kind='debit'`,
        [quote.quoteId, item.scopeRecordId, item.query.kind],
      );
      const used = spent.rows[0];
      if (
        current.net === null ||
        current.fingerprint !== expectedAuthority.fingerprint ||
        current.fingerprint !== quote.authority.fingerprint ||
        // An ordinary claim needs a free credit beyond every outstanding allocation. A
        // whole-quote claim converts one of its own credits, which leaves net
        // unchanged, so it needs only that commitments stay covered.
        (allocation ? Number(used?.aggregate) >= allocation.plannedCredits || current.net < 0 : current.net < 1) ||
        !used ||
        Number(used.aggregate) >= quote.cap ||
        Number(used.per_set) >= 2 ||
        Number(used.per_kind) >= 1
      )
        throw new CountAcquisitionRefused();
      return append(
        "debit",
        { query: item.query, credits: 1 },
        { quoteId: quote.quoteId, query: item.query, scopeRecordId: item.scopeRecordId, kind: item.query.kind },
        tx,
      );
    });
  }
  async function result(
    debitId: string,
    quoteId: string,
    query: ScrydexCountQuery,
    outcome: "complete" | "failed" | "uncertain",
    evidence: ScrydexCountEvidence | null,
  ) {
    if (outcome === "complete" && (!countSourceIsCurrent(evidence, query, now()) || evidence.sourceId !== debitId))
      throw new CountAcquisitionRefused();
    const debit = await db.query(
      "SELECT event_id FROM catalog_scope_sync_count_history WHERE event_id=$1 AND account_slot=$2 AND quote_id=$3 AND query_key=$4 AND event_kind='debit'",
      [debitId, slot, quoteId, countQueryKey(query)],
    );
    if (!debit.rows.length) throw new CountAcquisitionRefused();
    await append("result", { outcome, evidence }, { debitId, quoteId, query });
  }
  async function quoteState(quote: CountQuote): Promise<CountQuote["state"]> {
    const rows = await db.query<{ debits: string; approvals: string; outcomes: unknown }>(
      `SELECT
      (SELECT count(*) FROM catalog_scope_sync_count_history WHERE quote_id=$1 AND event_kind='debit')::text AS debits,
      (SELECT count(*) FROM catalog_scope_sync_count_history WHERE quote_id=$1 AND event_kind='approved')::text AS approvals,
      (SELECT jsonb_agg(r.payload->>'outcome') FROM catalog_scope_sync_count_history d LEFT JOIN catalog_scope_sync_count_history r ON r.debit_id=d.event_id AND r.event_kind='result' WHERE d.quote_id=$1 AND d.event_kind='debit') AS outcomes`,
      [quote.quoteId],
    );
    const row = rows.rows[0];
    const outcomes = Array.isArray(row?.outcomes) ? row.outcomes : [];
    if (outcomes.some((outcome) => outcome === null || outcome === "uncertain")) return "uncertain";
    if (outcomes.includes("failed")) return "failed";
    if (quote.targets.every((target) => target.source) && (Number(row?.approvals) || quote.plannedCredits === 0))
      return "complete";
    return Number(row?.approvals) ? "failed" : "quoted";
  }
  /**
   * Every debit the quote owns on this account slot, joined to its retained result,
   * independent of current sources and of the capped spend history. Overflow or any
   * unreadable row makes the projection unknown; the readable rows are kept.
   */
  async function quoteDebits(quoteId: string): Promise<CountPreparationView["debits"]> {
    const rows = await db.query<{
      event_id: string;
      scope_record_id: string | null;
      count_kind: string | null;
      query_key: string | null;
      payload: unknown;
      recorded_at: Date | string;
      result: unknown;
    }>(
      `SELECT d.event_id,d.scope_record_id,d.count_kind,d.query_key,d.payload,d.recorded_at,r.payload AS result
      FROM catalog_scope_sync_count_history d
      LEFT JOIN catalog_scope_sync_count_history r ON r.debit_id=d.event_id AND r.event_kind='result' AND r.account_slot=d.account_slot
      WHERE d.account_slot=$1 AND d.quote_id=$2 AND d.event_kind='debit' ORDER BY d.position LIMIT $3`,
      [slot, quoteId, countQuoteDebitsMax + 1],
    );
    const readAt = now();
    let reason: "overflow" | "invalid-row" | null = rows.rows.length > countQuoteDebitsMax ? "overflow" : null;
    const projected: CountQuoteDebit[] = [];
    for (const row of rows.rows.slice(0, countQuoteDebitsMax)) {
      const debit = debitPayloadSchema.safeParse(row.payload);
      const result = row.result === null ? null : countResultSchema.safeParse(row.result);
      const evidence = result?.success && result.data.outcome === "complete" ? result.data.evidence : null;
      const candidate = countQuoteDebitSchema.safeParse({
        quoteId,
        scopeRecordId: row.scope_record_id,
        kind: row.count_kind,
        queryFingerprint: row.query_key,
        debitId: row.event_id,
        credits: 1,
        debitedAt: new Date(row.recorded_at).toISOString(),
        outcome: result === null ? "acquiring" : result.success ? result.data.outcome : null,
        observedAt: evidence?.observedAt ?? null,
        expiresAt: evidence?.expiresAt ?? null,
      });
      if (
        !candidate.success ||
        !debit.success ||
        countQueryKey(debit.data.query) !== row.query_key ||
        debit.data.query.kind !== row.count_kind ||
        (evidence && evidence.sourceId !== row.event_id)
      ) {
        reason ??= "invalid-row";
        continue;
      }
      projected.push(candidate.data);
    }
    return {
      status: reason ? "unknown" : "complete",
      reason,
      readAt,
      fingerprint: reason ? null : countFingerprint(projected),
      rows: projected,
    };
  }
  /** The opt-in preparation read: unchanged retained quote plus current authority, admission and quote debits. */
  async function preparationView(quote: CountQuote): Promise<CountPreparationView> {
    const retained = await retainedQuote(quote);
    const current = await ledger();
    const held = await allocations(db, { quoteId: quote.quoteId });
    const allocation = held?.[0] ?? null;
    const debits = await quoteDebits(quote.quoteId);
    return {
      schemaVersion: countPreparationViewSchemaVersion,
      quote: retained,
      currentAuthority: {
        readAt: current.at,
        usageFingerprint: current.fingerprint,
        usageObservedAt: current.observedAt,
        state: current.net === null ? "unknown" : "allowed",
        headroom: current.net === null ? null : Math.max(0, current.net),
      },
      // An unreadable allocation is reported as held, never as absent.
      admission: !held
        ? { state: "active", plannedCredits: null, admittedAt: null, endedAt: null }
        : {
            state: !allocation
              ? "none"
              : allocation.endedAt
                ? "ended"
                : allocationActive(allocation, current.at)
                  ? "active"
                  : "expired",
            plannedCredits: allocation?.plannedCredits ?? null,
            admittedAt: allocation?.admittedAt ?? null,
            endedAt: allocation?.endedAt ?? null,
          },
      debits,
    };
  }
  async function history(limit = 50, before?: string): Promise<readonly CountSpend[]> {
    const rows = await db.query<
      Row & {
        quote_id: string;
        count_kind: "cards" | "sealed";
        result: { outcome?: CountSpend["outcome"]; evidence?: ScrydexCountEvidence } | null;
      }
    >(
      `SELECT d.event_id,d.quote_id,d.count_kind,d.payload,d.recorded_at,r.payload AS result
      FROM catalog_scope_sync_count_history d LEFT JOIN catalog_scope_sync_count_history r ON r.debit_id=d.event_id AND r.event_kind='result'
      WHERE d.account_slot=$1 AND d.event_kind='debit' AND ($2::timestamptz IS NULL OR d.recorded_at < $2::timestamptz)
      ORDER BY d.position DESC LIMIT $3`,
      [slot, before ?? null, Math.min(100, Math.max(1, limit))],
    );
    return projectCountSpend(
      rows.rows.map((row) => ({
        debitId: row.event_id,
        quoteId: row.quote_id,
        kind: row.count_kind,
        credits: 1,
        outcome: row.result?.outcome ?? "uncertain",
        debitedAt: new Date(row.recorded_at).toISOString(),
        observedAt: row.result?.evidence?.observedAt ?? null,
        expiresAt: row.result?.evidence?.expiresAt ?? null,
      })),
      now(),
    );
  }
  return {
    slot,
    read,
    blocked,
    authority,
    saveQuote,
    loadQuote,
    admit,
    approve,
    claim,
    result,
    end,
    allocationConflict,
    history,
    quoteState,
    retainedQuote,
    preparationView,
    retainUsage: async (snapshot: ProviderUsageSnapshot) => {
      const parsed = usageSchema.safeParse({
        remainingCredits: snapshot.remainingCredits,
        totalCredits: snapshot.totalCredits,
        observedAt: snapshot.observedAt,
        attemptState: snapshot.attemptState,
      });
      const payload = parsed.success
        ? parsed.data
        : { remainingCredits: null, totalCredits: null, observedAt: null, attemptState: "unavailable" as const };
      await withPgTransaction(db, async (tx) => {
        await lockCountHeadroom(tx, slot);
        const current = await tx.query<Row>(
          "SELECT event_id,payload,recorded_at FROM catalog_scope_sync_count_history WHERE account_slot=$1 AND event_kind='usage' ORDER BY position DESC LIMIT 1",
          [slot],
        );
        const old = usageSchema.safeParse(current.rows[0]?.payload);
        if (!old.success || countFingerprint(old.data) !== countFingerprint(payload))
          await append("usage", payload, {}, tx);
      });
    },
  };
}
