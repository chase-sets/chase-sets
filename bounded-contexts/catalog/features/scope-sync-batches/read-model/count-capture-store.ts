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

const phaseSchema = z.enum(countCapturePhases);
const instant = z.iso.datetime({ offset: true });
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
const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.uuid(),
    ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
    admittedAt: instant,
    expiresAt: instant,
    status: z.enum(["open", "stopped"]),
    phases: z.array(phaseSchema).max(countCapturePhases.length),
    request: z.object({ requestId: z.uuid(), phase: phaseSchema }).strict().nullable(),
    sends: z.array(sendSchema).max(countCaptureSendCap),
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

// Staging-only capture history. Every change is one locked append of the whole run,
// so two API replicas sharing one database serialize on the same lock.
export function createCountCaptureStore(pool: PgTransactionalPool, now = () => new Date().toISOString()) {
  // A refused change appends the stopped run instead; it never releases a debit.
  async function mutate<T>(runId: string, work: (run: CountCaptureRun) => T): Promise<T> {
    const outcome = await withPgTransaction(pool, async (db) => {
      await lock(db);
      const run = await latest(db, runId);
      if (run.status === "stopped") return { accepted: false as const };
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
        if (run.status !== "stopped") await append(db, { ...run, status: "stopped" });
      }),
  };

  return {
    ledger,
    read: (runId: string) => latest(pool, runId),
    // One active run at a time across every replica; an unreadable run blocks admission.
    admit: (input: Readonly<{ ownerHash: string }>) =>
      withPgTransaction(pool, async (db) => {
        await lock(db);
        const runs = await db.query<{ payload: unknown }>(
          "SELECT DISTINCT ON (run_id) payload FROM catalog_scope_sync_count_capture_history ORDER BY run_id, position DESC",
        );
        const admittedAt = now();
        if (
          runs.rows
            .map((row) => parseRun(row.payload))
            .some((run) => run.status === "open" && Date.parse(run.expiresAt) > Date.parse(admittedAt))
        )
          throw new CountCaptureStopped();
        const run = parseRun({
          schemaVersion: 1,
          runId: randomUUID(),
          ownerHash: input.ownerHash,
          admittedAt,
          expiresAt: new Date(Date.parse(admittedAt) + countCaptureRunMs).toISOString(),
          status: "open",
          phases: [],
          request: null,
          sends: [],
        });
        await append(db, run);
        return run;
      }),
    // Phases advance strictly in order and bind one request at a time.
    begin: (runId: string, phase: CountCapturePhase) =>
      mutate(runId, (run): CountCaptureBinding => {
        const last = run.phases.at(-1);
        if (run.request || (last !== undefined && phaseOrder(phase) <= phaseOrder(last)))
          throw new CountCaptureStopped();
        const binding = { runId, requestId: randomUUID(), phase };
        run.phases.push(phase);
        run.request = { requestId: binding.requestId, phase };
        return binding;
      }),
    finish: (binding: CountCaptureBinding) =>
      mutate(binding.runId, (run) => {
        bound(run, binding);
        if (run.sends.some((send) => send.requestId === binding.requestId && send.status === null))
          throw new CountCaptureStopped();
        run.request = null;
      }),
  };
}
