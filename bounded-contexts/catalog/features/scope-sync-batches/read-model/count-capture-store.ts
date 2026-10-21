import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  CountCaptureStopped,
  countCapturePhases,
  type CountCaptureBinding,
  type CountCaptureLedger,
  type CountCapturePhase,
} from "../../source-observations/api/providers/count-capture-transport";
import {
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../../source-observations/api/providers/scrydex/adapter";
import { countFingerprint, countQuoteSchema, countTimeIsCurrent, type CountQuote } from "../domain/count-acquisition";
import {
  countCaptureFields,
  countCaptureUnitKeys,
  countCaptureQuerySchema,
  countCapturePlanSchema,
  countCapturePlannerReadSchema,
  type CountCapturePlannerRead,
} from "../domain/count-capture-plan";
import {
  countCaptureAuthoritySchema,
  countLifecycleReceiptSchema,
  countLifecycleStopReceiptSchema,
  type CountCaptureAuthority,
} from "../domain/count-lifecycle-receipt";

// Possible sends per phase; slots never transfer between phases, and the run total is 11.
export const countCapturePhaseCaps: Readonly<Record<CountCapturePhase, number>> = {
  baseline: 0,
  bootstrap: 1,
  quote: 0,
  acquisition: 2,
  preview: 4,
  "pre-confirm": 4,
};
export const countCaptureSendCap = 11;
const countCaptureRunMs = 900_000;
const planImportUnitKeys: readonly string[] = [
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
];

const { id, instant, count, hash, sha } = countCaptureFields;
const phaseSchema = z.enum(countCapturePhases);
const sendSchema = z
  .object({
    sequence: z.number().int().min(1).max(countCaptureSendCap),
    requestId: z.uuid(),
    phase: phaseSchema,
    category: z.enum(["usage", "cards", "sealed"]),
    usage: z
      .object({
        purpose: z.enum(["bootstrap", "readiness", "planImport"]),
        unitKey: z
          .string()
          .refine((key) => planImportUnitKeys.includes(key))
          .optional(),
      })
      .strict()
      .optional(),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    debitedAt: instant,
    // A null status is a possible send without a recorded 2xx result; it is never refunded.
    status: z.number().int().min(200).max(299).nullable(),
    respondedAt: instant.nullable(),
  })
  .strict();

// The host authority envelope the run was admitted under, as declared by the host
// and validated for consistency. The server never observed these deployment facts.
const hostSchema = z
  .object({
    fingerprint: hash,
    dispatchId: id,
    packetHash: hash,
    runnerSha: sha,
    deployment: z.object({ runId: id, jobId: id, sha, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
    netCredits: count,
  })
  .strict();
const authoritySchema = z.object({ fingerprint: hash, headroom: count.nullable(), allowed: z.boolean() }).strict();
const effectsSchema = z
  .object({ at: instant, batches: count, reservations: count, jobs: count, enqueues: count, imports: count })
  .strict();
const baselineSchema = z
  .object({
    recordedAt: instant,
    selection: z
      .object({
        scopeRecordId: id,
        scopeRecordVersion: instant,
        accountRevision: id,
        productDomain: z.literal("one-piece"),
        parentValue: z.literal("OP01"),
        languageCode: z.literal("en"),
      })
      .strict(),
    units: z
      .array(
        z
          .object({
            unitKey: z.enum(countCaptureUnitKeys),
            profileKey: id,
            profileVersion: id,
            mappingId: id,
            mappingVersion: instant,
            setCoordinate: z.literal("OP01"),
          })
          .strict(),
      )
      .length(countCaptureUnitKeys.length)
      .refine((units) => units.every((unit, index) => unit.unitKey === countCaptureUnitKeys[index])),
    countAuthority: authoritySchema,
    effects: effectsSchema,
  })
  .strict();
const noticeBodySchema = z
  .object({
    kind: z.literal("initial"),
    environment: z.literal("staging"),
    selection: baselineSchema.shape.selection,
    host: hostSchema,
    caps: z
      .object({
        count: z.literal(countCapturePhaseCaps.acquisition),
        usage: z.literal(countCaptureSendCap - countCapturePhaseCaps.acquisition),
        total: z.literal(countCaptureSendCap),
        bootstrap: z.literal(countCapturePhaseCaps.bootstrap),
        preview: z.literal(countCapturePhaseCaps.preview),
        preConfirm: z.literal(countCapturePhaseCaps["pre-confirm"]),
        otherProviders: z.literal(0),
      })
      .strict(),
    overage: z.literal("refused"),
    countDebits: z.literal("separate-from-batch-reservation"),
    baselineFingerprint: hash,
  })
  .strict();
const noticeSchema = z.object({ recordedAt: instant, fingerprint: hash, body: noticeBodySchema }).strict();
const usageSchema = z
  .object({ recordedAt: instant, state: z.enum(["skipped", "persisted"]), required: count, authority: authoritySchema })
  .strict();

const finalNoticeSchema = z
  .object({
    recordedAt: instant,
    fingerprint: hash,
    readBackAt: instant.nullable(),
    body: z
      .object({
        quoteId: z.uuid(),
        fingerprint: hash,
        membershipFingerprint: hash,
        authority: authoritySchema,
        expiresAt: instant,
        plannedCount: count.max(2),
        serverCap: count.max(2),
        perKindBound: z.literal(1),
        plannedKinds: z.array(z.enum(["cards", "sealed"])).max(2),
        reused: z.array(countQuoteSchema.shape.targets.element).max(2),
        usage: countLifecycleReceiptSchema.shape.usage,
        remainingPreview: z.literal(4),
        remainingPreConfirm: z.literal(4),
        remainingTotal: count.max(10),
        host: hostSchema,
        countDebits: z.literal("separate-from-batch-reservation"),
      })
      .strict(),
  })
  .strict();
const receiptSchema = z.union([countLifecycleReceiptSchema, countLifecycleStopReceiptSchema]);
// The runner that sealed a run and the status it sealed from. Only that runner's
// one completion of that exact run may retain its receipt.
export const countCaptureSealSchema = z
  .object({
    from: z.enum(["open", "stopped"]),
    runnerRunId: z.string().regex(/^[1-9]\d{0,19}$/),
    runnerRunAttempt: z.number().int().min(1).max(1000),
  })
  .strict();

const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
    admittedAt: instant,
    expiresAt: instant,
    status: z.enum(["open", "stopped", "frozen"]),
    scopeRecordId: id,
    host: hostSchema,
    phases: z.array(phaseSchema).max(countCapturePhases.length),
    request: z.object({ requestId: z.uuid(), phase: phaseSchema }).strict().nullable(),
    sends: z.array(sendSchema).max(countCaptureSendCap),
    baseline: baselineSchema.nullable(),
    notice: noticeSchema.nullable(),
    usage: usageSchema.nullable(),
    authority: countCaptureAuthoritySchema.nullable().default(null),
    quote: countQuoteSchema.nullable().default(null),
    quoteUsage: countLifecycleReceiptSchema.shape.usage.nullable().default(null),
    budget: countCapturePlanSchema.shape.budget.nullable().default(null),
    quoteReadBackAt: instant.nullable().default(null),
    finalNotice: finalNoticeSchema.nullable().default(null),
    approvalAt: instant.nullable().default(null),
    acquisition: countQuoteSchema.nullable().default(null),
    reads: z.array(countCapturePlannerReadSchema).max(2).default([]),
    windows: z
      .array(z.object({ phase: phaseSchema, startedAt: instant, endedAt: instant.nullable() }).strict())
      .max(6)
      .default([]),
    frozenAt: instant.nullable().default(null),
    seal: countCaptureSealSchema.nullable().default(null),
    receipt: receiptSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (run) =>
      run.phases.every((phase, index) => index === 0 || phaseOrder(run.phases[index - 1]!) < phaseOrder(phase)) &&
      (!run.request || run.request.phase === run.phases.at(-1)) &&
      run.sends.every(
        (send, index) =>
          send.sequence === index + 1 &&
          run.phases.includes(send.phase) &&
          (send.status === null) === (send.respondedAt === null),
      ),
  );
export type CountCaptureRun = z.infer<typeof runSchema>;
export type CountCaptureHost = z.infer<typeof hostSchema>;
export type CountCaptureBaseline = z.infer<typeof baselineSchema>;
export type CountCaptureEffects = z.infer<typeof effectsSchema>;
export type CountCaptureNotice = z.infer<typeof noticeSchema>;
export type CountCaptureUsage = z.infer<typeof usageSchema>;
export type CountCaptureSealInput = Readonly<
  { dispatchId: string } & Omit<z.infer<typeof countCaptureSealSchema>, "from">
>;
export type CountCaptureStore = ReturnType<typeof createCountCaptureStore>;

function phaseOrder(phase: CountCapturePhase) {
  return countCapturePhases.indexOf(phase);
}

// An unknown schema version, an open payload or an inconsistent run refuses.
function parseRun(value: unknown): CountCaptureRun {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw new CountCaptureStopped();
  return parsed.data;
}

function lock(db: PgQueryable) {
  return db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["catalog-count-capture"]);
}

async function append(db: PgQueryable, run: CountCaptureRun) {
  await db.query(
    "INSERT INTO catalog_scope_sync_count_capture_history (run_id, owner_hash, payload) VALUES ($1, $2, $3::jsonb)",
    [run.runId, run.ownerHash, JSON.stringify(parseRun(run))],
  );
}

async function latest(db: PgQueryable, runId: string): Promise<CountCaptureRun> {
  const result = await db.query<{ payload: unknown }>(
    "SELECT payload FROM catalog_scope_sync_count_capture_history WHERE run_id = $1 ORDER BY position DESC LIMIT 1",
    [runId],
  );
  const run = parseRun(result.rows[0]?.payload);
  if (run.runId !== runId) throw new CountCaptureStopped();
  return run;
}

function bound(run: CountCaptureRun, binding: CountCaptureBinding) {
  if (run.request?.requestId !== binding.requestId || run.request.phase !== binding.phase)
    throw new CountCaptureStopped();
}

export const remainingCountCaptureCap = (plannedCount: number) =>
  plannedCount + countCapturePhaseCaps.preview + countCapturePhaseCaps["pre-confirm"];

function assertQuote(run: CountCaptureRun, quote: CountQuote, at: string) {
  const baseline = run.baseline;
  const missing = quote.targets.filter((target) => !target.source).length;
  if (
    !baseline ||
    quote.state !== "quoted" ||
    Date.parse(quote.expiresAt) < Date.parse(at) ||
    countFingerprint(quote.selection) !== countFingerprint({ mode: "ids", scopeRecordIds: [run.scopeRecordId] }) ||
    quote.targets.length !== 2 ||
    new Set(quote.targets.map((target) => target.query.kind)).size !== 2 ||
    quote.plannedCredits !== missing ||
    quote.cap !== missing ||
    missing > countCapturePhaseCaps.acquisition ||
    !quote.authority.allowed ||
    quote.authority.headroom === null ||
    quote.authority.headroom < remainingCountCaptureCap(missing) ||
    quote.targets.some((target) => {
      const query = countCaptureQuerySchema.safeParse(target.query);
      const unit = baseline.units.find((unit) => unit.unitKey === target.query.unitKey);
      return (
        !query.success ||
        target.scopeRecordId !== run.scopeRecordId ||
        target.blocked ||
        target.query.accountRevision !== baseline.selection.accountRevision ||
        !unit ||
        target.query.profileKey !== unit.profileKey ||
        target.query.profileVersion !== unit.profileVersion ||
        (target.source !== null &&
          (!countTimeIsCurrent(target.source, at) ||
            countFingerprint(target.source.query) !== countFingerprint(target.query)))
      );
    })
  )
    throw new CountCaptureStopped();
}

// The pre-spend notice is derived from durable run state alone: the declared host
// authority, the recorded baseline and the fixed caps. No caller input reaches it.
function initialNoticeBody(run: CountCaptureRun): z.infer<typeof noticeBodySchema> {
  return {
    kind: "initial",
    environment: "staging",
    selection: run.baseline!.selection,
    host: run.host,
    caps: {
      count: countCapturePhaseCaps.acquisition,
      usage: countCaptureSendCap - countCapturePhaseCaps.acquisition,
      total: countCaptureSendCap,
      bootstrap: countCapturePhaseCaps.bootstrap,
      preview: countCapturePhaseCaps.preview,
      preConfirm: countCapturePhaseCaps["pre-confirm"],
      otherProviders: 0,
    },
    overage: "refused",
    countDebits: "separate-from-batch-reservation",
    baselineFingerprint: countFingerprint(run.baseline),
  };
}

// Bounded local counts of every effect a capture must never cause. No provider I/O.
export async function readCountCaptureEffects(db: PgQueryable, at: string): Promise<CountCaptureEffects> {
  const result = await db.query<Record<Exclude<keyof CountCaptureEffects, "at">, string>>(
    `SELECT
      (SELECT count(*) FROM catalog_scope_sync_batches)::text AS batches,
      (SELECT count(*) FROM catalog_scope_sync_batches WHERE status IN ('queued','running')
        AND COALESCE((budget->'creditedProviderRequestLimits'->>'scrydex')::bigint, 0) > 0)::text AS reservations,
      (SELECT count(*) FROM catalog_source_observation_integration_durable_jobs WHERE job_kind = 'integration')::text AS jobs,
      (SELECT count(*) FROM catalog_source_observation_integration_durable_jobs WHERE job_kind = 'catalog-sync-scope')::text AS enqueues,
      (SELECT count(*) FROM catalog_source_observation_integration_work_units)::text AS imports`,
  );
  const row = result.rows[0];
  return effectsSchema.parse({
    at,
    batches: Number(row?.batches),
    reservations: Number(row?.reservations),
    jobs: Number(row?.jobs),
    enqueues: Number(row?.enqueues),
    imports: Number(row?.imports),
  });
}

// Staging-only capture history. Every change is one locked append of the whole run,
// so two API replicas sharing one database serialize on the same lock.
export function createCountCaptureStore(pool: PgTransactionalPool, now = () => new Date().toISOString()) {
  // A refused change appends the stopped run instead; it never releases a debit.
  async function mutate<T>(runId: string, work: (run: CountCaptureRun) => T): Promise<T> {
    const outcome = await withPgTransaction(pool, async (db) => {
      await lock(db);
      const run = await latest(db, runId);
      if (run.status !== "open") return { accepted: false as const };
      let next: CountCaptureRun;
      let value: T;
      try {
        if (Date.parse(run.expiresAt) <= Date.parse(now())) throw new CountCaptureStopped();
        next = structuredClone(run);
        value = work(next);
        next = parseRun(next);
      } catch {
        await append(db, { ...run, status: "stopped" });
        return { accepted: false as const };
      }
      await append(db, next);
      return { accepted: true as const, value };
    });
    if (!outcome.accepted) throw new CountCaptureStopped();
    return outcome.value;
  }

  async function runs(db: PgQueryable, ownerHash?: string): Promise<CountCaptureRun[]> {
    const result = await db.query<{ payload: unknown }>(
      ownerHash === undefined
        ? "SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history ORDER BY run_id, position DESC"
        : "SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history WHERE owner_hash = $1 ORDER BY run_id, position DESC",
      ownerHash === undefined ? [] : [ownerHash],
    );
    return result.rows.map((row) => parseRun(row.payload));
  }
  const active = (run: CountCaptureRun, at: string) =>
    run.status === "open" && Date.parse(run.expiresAt) > Date.parse(at);

  const ledger: CountCaptureLedger = {
    debit: (binding, send) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        // A send without a recorded result may have reached the provider, so sends
        // resolve one at a time and nothing is debited after an unresolved one.
        if (run.sends.some((entry) => entry.status === null)) throw new CountCaptureStopped();
        const phase = binding.phase;
        const inPhase = run.sends.filter((entry) => entry.phase === phase);
        if (run.sends.length >= countCaptureSendCap || inPhase.length >= countCapturePhaseCaps[phase])
          throw new CountCaptureStopped();
        const usage = send.usage;
        if (phase === "acquisition") {
          if (
            run.quote &&
            (!run.approvalAt ||
              !run.finalNotice?.readBackAt ||
              inPhase.length >= run.quote.cap ||
              !run.quote.targets.some(
                (target) =>
                  !target.source &&
                  target.query.kind === send.category &&
                  target.query.requestFingerprint === send.requestFingerprint,
              ))
          )
            throw new CountCaptureStopped();
          if (send.category === "usage" || usage || inPhase.some((entry) => entry.category === send.category))
            throw new CountCaptureStopped();
        } else if (
          send.category !== "usage" ||
          !usage ||
          (phase === "bootstrap"
            ? usage.purpose !== "bootstrap" || usage.unitKey !== undefined
            : usage.purpose === "readiness"
              ? usage.unitKey !== undefined
              : usage.purpose !== "planImport" || !planImportUnitKeys.includes(usage.unitKey ?? "")) ||
          inPhase.some((entry) => entry.usage?.purpose === usage.purpose && entry.usage.unitKey === usage.unitKey)
        ) {
          throw new CountCaptureStopped();
        }
        const sequence = run.sends.length + 1;
        run.sends.push({
          sequence,
          requestId: binding.requestId,
          phase,
          category: send.category,
          ...(usage
            ? {
                usage:
                  usage.unitKey === undefined
                    ? { purpose: usage.purpose }
                    : { purpose: usage.purpose, unitKey: usage.unitKey },
              }
            : {}),
          requestFingerprint: send.requestFingerprint,
          debitedAt: now(),
          status: null,
          respondedAt: null,
        });
        return sequence;
      }),
    result: (binding, sequence, status) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        const entry = run.sends[sequence - 1];
        if (!entry || entry.requestId !== binding.requestId || entry.status !== null) throw new CountCaptureStopped();
        entry.status = status;
        entry.respondedAt = now();
      }),
    stop: (binding) =>
      withPgTransaction(pool, async (db) => {
        await lock(db);
        const run = await latest(db, binding.runId);
        if (run.status === "open") await append(db, { ...run, status: "stopped" });
      }),
  };

  return {
    ledger,
    read: (runId: string) => latest(pool, runId),
    // One active run at a time across every replica, and one run per host dispatch
    // ever; an unreadable run blocks admission.
    admit: (
      input: Readonly<{
        ownerHash: string;
        scopeRecordId: string;
        host: CountCaptureHost;
        authority?: CountCaptureAuthority;
      }>,
    ) =>
      withPgTransaction(pool, async (db) => {
        await lock(db);
        const retained = await runs(db);
        const admittedAt = now();
        if (retained.some((run) => active(run, admittedAt))) throw new CountCaptureStopped();
        if (retained.some((run) => run.host.dispatchId === input.host.dispatchId)) throw new CountCaptureStopped();
        const run = parseRun({
          schemaVersion: 1,
          runId: randomUUID(),
          ownerHash: input.ownerHash,
          admittedAt,
          expiresAt: new Date(Date.parse(admittedAt) + countCaptureRunMs).toISOString(),
          status: "open",
          scopeRecordId: input.scopeRecordId,
          host: input.host,
          authority: input.authority ?? null,
          phases: [],
          request: null,
          sends: [],
          baseline: null,
          notice: null,
          usage: null,
        });
        await append(db, run);
        return run;
      }),
    // The owner's one active run. Its identity never comes from the caller.
    activeRun: async (ownerHash: string): Promise<CountCaptureRun> => {
      const owned = (await runs(pool, ownerHash)).filter((run) => active(run, now()));
      if (owned.length !== 1) throw new CountCaptureStopped();
      return owned[0]!;
    },
    // Phases advance strictly in order and bind one request at a time. Every phase
    // after the baseline follows the recorded initial notice, and every phase after
    // the targeted usage observation follows its recorded outcome.
    begin: (runId: string, phase: CountCapturePhase) =>
      mutate(runId, (run): CountCaptureBinding => {
        const last = run.phases.at(-1);
        if (run.request || (last !== undefined && phaseOrder(phase) <= phaseOrder(last)))
          throw new CountCaptureStopped();
        if (phase !== "baseline" && !run.notice) throw new CountCaptureStopped();
        if (phaseOrder(phase) > phaseOrder("bootstrap") && !run.usage) throw new CountCaptureStopped();
        const binding = { runId, requestId: randomUUID(), phase };
        run.phases.push(phase);
        run.windows.push({ phase, startedAt: now(), endedAt: null });
        run.request = { requestId: binding.requestId, phase };
        return binding;
      }),
    recordBaseline: (binding: CountCaptureBinding, baseline: CountCaptureBaseline) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        if (binding.phase !== "baseline" || run.baseline || baseline.selection.scopeRecordId !== run.scopeRecordId)
          throw new CountCaptureStopped();
        run.baseline = baseline;
        return baseline;
      }),
    // Recorded once, after the finished baseline and before any later phase begins.
    recordInitialNotice: (runId: string) =>
      mutate(runId, (run): CountCaptureNotice => {
        if (!run.baseline || run.request || run.notice || run.phases.length !== 1) throw new CountCaptureStopped();
        const body = initialNoticeBody(run);
        run.notice = { recordedAt: now(), fingerprint: countFingerprint(body), body };
        return run.notice;
      }),
    recordUsage: (binding: CountCaptureBinding, usage: Omit<CountCaptureUsage, "recordedAt">) =>
      mutate(binding.runId, (run): CountCaptureUsage => {
        bound(run, binding);
        if (binding.phase !== "bootstrap" || run.usage) throw new CountCaptureStopped();
        run.usage = { ...usage, recordedAt: now() };
        return run.usage;
      }),
    bindQuote: (
      binding: CountCaptureBinding,
      quote: CountQuote,
      budget: z.infer<typeof countCapturePlanSchema.shape.budget>,
      usage?: z.infer<typeof countLifecycleReceiptSchema.shape.usage> | null,
    ) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        if (binding.phase !== "quote" || run.quote) throw new CountCaptureStopped();
        assertQuote(run, quote, now());
        run.quote = countQuoteSchema.parse(quote);
        run.budget = budget;
        run.quoteUsage = usage ?? null;
        return run.quote;
      }),
    readBackQuote: (runId: string, quote: CountQuote) =>
      mutate(runId, (run) => {
        if (!run.quote || run.request || run.quoteReadBackAt || countFingerprint(run.quote) !== countFingerprint(quote))
          throw new CountCaptureStopped();
        assertQuote(run, quote, now());
        run.quoteReadBackAt = now();
        return run.quote;
      }),
    recordFinalNotice: (runId: string) =>
      mutate(runId, (run) => {
        if (!run.quote || !run.quoteReadBackAt || !run.quoteUsage || run.finalNotice || run.request)
          throw new CountCaptureStopped();
        const quote = run.quote;
        assertQuote(run, quote, now());
        const body = {
          quoteId: quote.quoteId,
          fingerprint: quote.fingerprint,
          membershipFingerprint: quote.membershipFingerprint,
          authority: quote.authority,
          expiresAt: quote.expiresAt,
          plannedCount: quote.plannedCredits,
          serverCap: quote.cap,
          perKindBound: 1 as const,
          plannedKinds: quote.targets.filter((target) => !target.source).map((target) => target.query.kind),
          reused: quote.targets.filter((target) => target.source !== null),
          remainingPreview: 4 as const,
          remainingPreConfirm: 4 as const,
          usage: { ...run.quoteUsage, ageMs: Date.parse(now()) - Date.parse(run.quoteUsage.observedAt) },
          remainingTotal: remainingCountCaptureCap(quote.plannedCredits),
          host: run.host,
          countDebits: "separate-from-batch-reservation" as const,
        };
        run.finalNotice = { recordedAt: now(), fingerprint: countFingerprint(body), readBackAt: null, body };
        return run.finalNotice;
      }),
    readBackFinalNotice: (runId: string, fingerprint: string) =>
      mutate(runId, (run) => {
        if (
          !run.finalNotice ||
          run.finalNotice.readBackAt ||
          run.finalNotice.fingerprint !== fingerprint ||
          countFingerprint(run.finalNotice.body) !== fingerprint
        )
          throw new CountCaptureStopped();
        run.finalNotice.readBackAt = now();
        return run.finalNotice;
      }),
    approveAcquisition: (binding: CountCaptureBinding, quoteId: string, fingerprint: string) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        if (
          !run.quote ||
          run.quote.quoteId !== quoteId ||
          run.quote.fingerprint !== fingerprint ||
          run.approvalAt ||
          !run.finalNotice?.readBackAt
        )
          throw new CountCaptureStopped();
        assertQuote(run, run.quote, now());
        run.approvalAt = now();
      }),
    retainAcquisition: (binding: CountCaptureBinding, result: CountQuote) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        const sends = run.sends.filter((send) => send.requestId === binding.requestId);
        if (sends.length !== run.quote?.plannedCredits || sends.some((send) => send.status === null))
          throw new CountCaptureStopped();
        if (
          !run.quote ||
          result.quoteId !== run.quote.quoteId ||
          result.fingerprint !== run.quote.fingerprint ||
          result.state !== "complete" ||
          result.cap !== run.quote.cap ||
          result.plannedCredits !== run.quote.plannedCredits ||
          result.membershipFingerprint !== run.quote.membershipFingerprint ||
          countFingerprint(result.selection) !== countFingerprint(run.quote.selection) ||
          result.targets.length !== 2 ||
          result.targets.some(
            (target, index) =>
              !target.source ||
              target.blocked ||
              countFingerprint(target.query) !== countFingerprint(run.quote!.targets[index]!.query) ||
              countFingerprint(target.source.query) !== countFingerprint(target.query) ||
              !countTimeIsCurrent(target.source, now()),
          )
        )
          throw new CountCaptureStopped();
        run.acquisition = countQuoteSchema.parse(result);
      }),
    retainPlannerRead: (binding: CountCaptureBinding, row: CountCapturePlannerRead) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        const parsed = countCapturePlannerReadSchema.parse(row);
        const scope = parsed.plan.scopes[0];
        if (
          parsed.requestId !== binding.requestId ||
          parsed.phase !== binding.phase ||
          run.reads.length !== (binding.phase === "preview" ? 0 : 1) ||
          (binding.phase === "pre-confirm" && parsed.comparedFingerprint !== run.reads[0]?.planFingerprint) ||
          countFingerprint(parsed.plan.selection) !== countFingerprint(run.quote?.selection) ||
          countFingerprint(parsed.plan.budget) !== countFingerprint(run.budget) ||
          !scope ||
          scope.scopeRecordId !== run.scopeRecordId ||
          scope.scopeRecordVersion !== run.baseline?.selection.scopeRecordVersion ||
          countFingerprint(
            scope.mappingVersions
              .map((mapping) => ({ id: mapping.mappingId, version: mapping.version }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ) !==
            countFingerprint(
              run.baseline.units
                .map((unit) => ({ id: unit.mappingId, version: unit.mappingVersion }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            ) ||
          scope.units.length !== 3 ||
          run.baseline.units.some(
            (unit) =>
              !scope.units.some(
                (selected) =>
                  selected.selected &&
                  selected.unitKey === unit.unitKey &&
                  selected.profileKey === unit.profileKey &&
                  selected.profileVersion === unit.profileVersion,
              ),
          )
        )
          throw new CountCaptureStopped();
        run.reads.push(parsed);
      }),
    // Seals the owner's latest run, only for its own dispatch. The server clock fixes
    // frozenAt once; no later step moves it, reopens the run or admits a send.
    seal: (ownerHash: string, input: CountCaptureSealInput) =>
      withPgTransaction(pool, async (db) => {
        await lock(db);
        const result = await db.query<{ payload: unknown }>(
          "SELECT payload FROM catalog_scope_sync_count_capture_history WHERE owner_hash=$1 ORDER BY position DESC LIMIT 1",
          [ownerHash],
        );
        const run = parseRun(result.rows[0]?.payload);
        if (run.ownerHash !== ownerHash || run.status === "frozen" || run.host.dispatchId !== input.dispatchId)
          throw new CountCaptureStopped();
        const sealed = parseRun({
          ...run,
          status: "frozen",
          frozenAt: now(),
          seal: { from: run.status, runnerRunId: input.runnerRunId, runnerRunAttempt: input.runnerRunAttempt },
        });
        await append(db, sealed);
        return sealed;
      }),
    // Appends the one terminal receipt of the exact sealed run it was derived from.
    // A replaced, unsealed or already-completed run, or a receipt naming another
    // boundary or runner, refuses without any append.
    retainReceipt: (sealed: CountCaptureRun, receipt: z.infer<typeof receiptSchema>) =>
      withPgTransaction(pool, async (db) => {
        await lock(db);
        const run = await latest(db, sealed.runId);
        const parsed = receiptSchema.parse(receipt);
        const boundary = "frozenAt" in parsed ? parsed.frozenAt : parsed.evidence.frozenAt;
        if (
          run.status !== "frozen" ||
          run.receipt ||
          !run.seal ||
          !sealed.seal ||
          run.ownerHash !== sealed.ownerHash ||
          run.frozenAt !== sealed.frozenAt ||
          countFingerprint(run.seal) !== countFingerprint(sealed.seal) ||
          boundary !== run.frozenAt ||
          parsed.attribution.runnerRunId !== run.seal.runnerRunId ||
          parsed.attribution.runnerRunAttempt !== run.seal.runnerRunAttempt
        )
          throw new CountCaptureStopped();
        await append(db, { ...run, receipt: parsed });
        return (await latest(db, sealed.runId)).receipt!;
      }),
    finish: (binding: CountCaptureBinding) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        if (run.sends.some((send) => send.requestId === binding.requestId && send.status === null))
          throw new CountCaptureStopped();
        run.request = null;
        const window = run.windows.at(-1);
        if (window) window.endedAt = now();
      }),
  };
}
