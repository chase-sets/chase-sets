import { randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { z } from "zod";
import {
  CountCaptureStopped,
  type CountCaptureBinding,
  type CountCaptureLedger,
  type CountCapturePhase,
} from "../api/count-capture-context";
import {
  countCaptureAuthoritySchema,
  countCaptureUnitKeys,
  validateCountCaptureAuthority,
  type CountCaptureAuthority,
} from "../domain/count-lifecycle-receipt";
import { countFingerprint, countTimeIsCurrent, type CountQuote } from "../domain/count-acquisition";
import type { ScopeSyncBatchBudget, ScopeSyncBatchSelection } from "../domain/batch";

const phaseSchema = z.enum(["baseline", "bootstrap", "quote", "acquisition", "preview", "pre-confirm"]);
const stateSchema = z
  .object({
    runId: z.uuid(),
    ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
    authority: countCaptureAuthoritySchema,
    admittedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    stage: z.enum([
      "admitted",
      "noticed",
      "bootstrapped",
      "quoted",
      "approved",
      "acquired",
      "previewed",
      "pre-confirmed",
      "frozen",
      "failed",
    ]),
    request: z.object({ runId: z.uuid(), requestId: z.uuid(), phase: phaseSchema }).strict().nullable(),
    sends: z
      .array(
        z
          .object({
            phase: phaseSchema,
            requestId: z.uuid(),
            sequence: z.number().int().min(1).max(11),
            category: z.enum(["usage", "cards", "sealed"]),
            usage: z
              .object({
                purpose: z.enum(["bootstrap", "readiness", "planImport"]),
                unitKey: z.enum(countCaptureUnitKeys).optional(),
              })
              .strict()
              .optional(),
            requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            debitedAt: z.iso.datetime({ offset: true }),
            status: z.number().int().min(100).max(599).nullable(),
            respondedAt: z.iso.datetime({ offset: true }).nullable(),
          })
          .strict(),
      )
      .max(11),
    selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
    budgetHash: z.string().regex(/^[a-f0-9]{64}$/),
    countQueries: z
      .array(z.object({ kind: z.enum(["cards", "sealed"]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
      .max(2),
    quoteId: z.uuid().nullable(),
    quoteFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type CountCaptureState = z.infer<typeof stateSchema>;
export type CountCaptureStore = ReturnType<typeof createCountCaptureStore>;

export function createCountCaptureStore(pool: PgTransactionalPool, now = () => new Date().toISOString()) {
  async function append(db: PgQueryable, state: CountCaptureState) {
    await db.query(
      "INSERT INTO catalog_scope_sync_count_capture_history (run_id,owner_hash,payload) VALUES ($1,$2,$3::jsonb)",
      [state.runId, state.ownerHash, JSON.stringify(stateSchema.parse(state))],
    );
  }
  async function latest(db: PgQueryable, column: "run_id" | "owner_hash", value: string) {
    const result = await db.query<{ payload: unknown }>(
      `SELECT payload FROM catalog_scope_sync_count_capture_history WHERE ${column}=$1 ORDER BY position DESC LIMIT 1`,
      [value],
    );
    if (!result.rows.length) return null;
    return stateSchema.parse(result.rows[0]!.payload);
  }
  async function mutate<T>(runId: string, work: (state: CountCaptureState) => T): Promise<T> {
    const result = await withPgTransaction(pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["catalog-count-capture"]);
      const state = await latest(db, "run_id", runId);
      if (!state) throw new CountCaptureStopped();
      try {
        if (Date.parse(state.expiresAt) < Date.parse(now()) || state.stage === "failed" || state.stage === "frozen")
          throw new CountCaptureStopped();
        const value = work(state);
        await append(db, state);
        return { accepted: true as const, value };
      } catch {
        state.stage = "failed";
        await append(db, state);
        return { accepted: false as const };
      }
    });
    if (!result.accepted) throw new CountCaptureStopped();
    return result.value;
  }
  function bound(state: CountCaptureState, binding: CountCaptureBinding) {
    if (!state.request || countFingerprint(state.request) !== countFingerprint(binding))
      throw new CountCaptureStopped();
  }
  const ledger: CountCaptureLedger = {
    debit: (binding, send) =>
      mutate(binding.runId, (state) => {
        bound(state, binding);
        const phase = binding.phase;
        const limits = {
          baseline: 0,
          quote: 0,
          bootstrap: 1,
          acquisition: state.countQueries.length,
          preview: 4,
          "pre-confirm": 4,
        };
        if (state.sends.length >= 11 || state.sends.filter((entry) => entry.phase === phase).length >= limits[phase])
          throw new CountCaptureStopped();
        if (phase === "acquisition") {
          if (
            !state.countQueries.some(
              (query) => query.kind === send.category && query.fingerprint === send.requestFingerprint,
            ) ||
            state.sends.some((entry) => entry.category === send.category)
          )
            throw new CountCaptureStopped();
        } else {
          if (send.category !== "usage" || !send.usage) throw new CountCaptureStopped();
          const { purpose, unitKey } = send.usage;
          if (phase === "bootstrap") {
            if (purpose !== "bootstrap" || unitKey !== undefined) throw new CountCaptureStopped();
          } else if (purpose === "readiness") {
            if (unitKey !== undefined) throw new CountCaptureStopped();
          } else if (purpose !== "planImport" || !countCaptureUnitKeys.some((key) => key === unitKey)) {
            throw new CountCaptureStopped();
          }
          if (
            state.sends.some(
              (entry) => entry.phase === phase && entry.usage?.purpose === purpose && entry.usage?.unitKey === unitKey,
            )
          )
            throw new CountCaptureStopped();
        }
        const sequence = state.sends.length + 1;
        state.sends.push(
          stateSchema.shape.sends.element.parse({
            ...send,
            phase,
            requestId: binding.requestId,
            sequence,
            debitedAt: now(),
            status: null,
            respondedAt: null,
          }),
        );
        return sequence;
      }),
    result: (binding, sequence, status) =>
      mutate(binding.runId, (state) => {
        bound(state, binding);
        const entry = state.sends.find((send) => send.sequence === sequence && send.requestId === binding.requestId);
        if (!entry || entry.status !== null || status < 200 || status >= 300) throw new CountCaptureStopped();
        entry.status = status;
        entry.respondedAt = now();
      }),
    stop: (binding) =>
      mutate(binding.runId, (state) => {
        bound(state, binding);
        state.stage = "failed";
      }),
  };
  return {
    ledger,
    findOwner: (ownerHash: string) => latest(pool, "owner_hash", ownerHash),
    async admit(input: {
      ownerHash: string;
      authority: CountCaptureAuthority;
      selection: ScopeSyncBatchSelection;
      budget: ScopeSyncBatchBudget;
    }) {
      if (!validateCountCaptureAuthority(input.authority, now())) throw new CountCaptureStopped();
      return withPgTransaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["catalog-count-capture"]);
        if (await latest(db, "owner_hash", input.ownerHash)) throw new CountCaptureStopped();
        const existing = await db.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM (
               SELECT DISTINCT ON (run_id) payload
               FROM catalog_scope_sync_count_capture_history ORDER BY run_id, position DESC
             ) current_runs
             WHERE (payload->>'expiresAt')::timestamptz >= $1::timestamptz
               AND payload->>'stage' NOT IN ('failed','frozen')
           ) OR EXISTS (
             SELECT 1 FROM catalog_scope_sync_count_capture_history
             WHERE payload->'authority'->>'dispatchId' = $2
           ) AS blocked`,
          [now(), input.authority.dispatchId],
        );
        if (existing.rows[0]?.blocked !== false) throw new CountCaptureStopped();
        const state: CountCaptureState = {
          runId: randomUUID(),
          ownerHash: input.ownerHash,
          authority: input.authority,
          admittedAt: now(),
          expiresAt: new Date(Date.parse(now()) + 900_000).toISOString(),
          stage: "admitted",
          request: null,
          sends: [],
          selectionHash: countFingerprint(input.selection),
          budgetHash: countFingerprint(input.budget),
          countQueries: [],
          quoteId: null,
          quoteFingerprint: null,
        };
        await append(db, state);
        return state;
      });
    },
    transition: (runId: string, expected: CountCaptureState["stage"], next: CountCaptureState["stage"]) =>
      mutate(runId, (state) => {
        if (state.request || state.stage !== expected) throw new CountCaptureStopped();
        const allowed: Readonly<Record<string, string | undefined>> = {
          admitted: "noticed",
          quoted: "approved",
          "pre-confirmed": "frozen",
        };
        if (next !== "failed" && allowed[state.stage] !== next) throw new CountCaptureStopped();
        state.stage = next;
        return state;
      }),
    begin: (runId: string, phase: CountCapturePhase) =>
      mutate(runId, (state) => {
        const allowed = {
          baseline: ["admitted"],
          bootstrap: ["noticed"],
          quote: ["noticed", "bootstrapped"],
          acquisition: ["approved"],
          preview: ["acquired"],
          "pre-confirm": ["previewed"],
        };
        if (state.request || !allowed[phase].includes(state.stage)) throw new CountCaptureStopped();
        const binding = { runId, requestId: randomUUID(), phase };
        state.request = binding;
        return binding;
      }),
    finish: (binding: CountCaptureBinding) =>
      mutate(binding.runId, (state) => {
        bound(state, binding);
        if (
          (binding.phase === "quote" || binding.phase === "acquisition") &&
          (!state.quoteId || !state.quoteFingerprint)
        )
          throw new CountCaptureStopped();
        if (state.sends.some((send) => send.status === null)) throw new CountCaptureStopped();
        const next = {
          baseline: "admitted",
          bootstrap: "bootstrapped",
          quote: "quoted",
          acquisition: "acquired",
          preview: "previewed",
          "pre-confirm": "pre-confirmed",
        } as const;
        state.stage = next[binding.phase];
        state.request = null;
        return state;
      }),
    bindQuote: (binding: CountCaptureBinding, quote: CountQuote) =>
      mutate(binding.runId, (state) => {
        bound(state, binding);
        if (
          binding.phase !== "quote" ||
          quote.state !== "quoted" ||
          Date.parse(quote.expiresAt) < Date.parse(now()) ||
          quote.cap !== quote.plannedCredits ||
          quote.plannedCredits !== quote.targets.filter((target) => !target.source).length ||
          quote.plannedCredits > 2 ||
          !quote.authority.allowed ||
          (quote.authority.headroom ?? -1) < quote.plannedCredits + 8 ||
          countFingerprint(quote.selection) !== state.selectionHash ||
          quote.targets.length !== 2 ||
          new Set(quote.targets.map((target) => target.query.kind)).size !== 2 ||
          quote.targets.some(
            (target) =>
              target.blocked ||
              target.query.environment !== "staging" ||
              target.query.productDomain !== "one-piece" ||
              target.query.parentValue !== "OP01" ||
              target.query.languageCode !== "en" ||
              target.query.unitKey !== countCaptureUnitKeys[target.query.kind === "cards" ? 1 : 2] ||
              (target.source !== null && !countTimeIsCurrent(target.source, now())),
          )
        )
          throw new CountCaptureStopped();
        state.countQueries = quote.targets
          .filter((target) => !target.source)
          .map((target) => ({ kind: target.query.kind, fingerprint: target.query.requestFingerprint }));
        state.quoteId = quote.quoteId;
        state.quoteFingerprint = quote.fingerprint;
      }),
  };
}
