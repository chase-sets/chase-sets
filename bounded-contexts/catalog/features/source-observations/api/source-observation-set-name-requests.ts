import { createHash, randomUUID } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  getEventCommitMetadata,
  recordCommittedEvents,
  runWithEventCommitMetadata,
} from "@chase-sets/event-core/consistency";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { emitDurableJobWorkSignal } from "@chase-sets/platform-runtime/durable-job-store";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogObservationRequestSource } from "../../operator-session/api/market-observations";
import { OperatorSessionRequestError } from "../../operator-session/api/request";
import type { TcgplayerSetNameRequestAnswer } from "../../operator-session/api/set-name-observations";
import type {
  SealedAnswerReceipt,
  TcgplayerSealedRequestAnswer,
} from "../../operator-session/api/sealed-product-observations";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import {
  admitSealedRequestAnswer,
  discardSealedRequestPayloads,
  hasSealedRequestParts,
  replaySealedRequestPart,
} from "./source-observation-sealed-request-answer";
import { deriveCatalogScopeSyncUnitState } from "../../scope-sync-state/domain/state";
import {
  bulkProgress,
  stableJsonStringify,
  summarizeIntegrationJobOutcomes,
  toSourceObservationIntegrationJob,
  toSourceObservationIntegrationJobEventSnapshot,
} from "./source-observation-job-serialization";
import {
  OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
  SourceObservationIntegrationJobLifecycleCommandError,
  type SourceObservationIntegrationJobStore,
  type SourceObservationIntegrationDurableJobRecord,
  type SourceObservationIntegrationJobScope,
  type SourceObservationIntegrationProfileSnapshot,
} from "./source-observation-runtime-contracts";

export const setNameRequestJobKind = "extension-set-names";
export const sealedRequestJobKind = "extension-sealed-products";
export const setNameRequestFailures = [
  "extension-unavailable",
  "provider-request-failed",
  "provider-response-unqualified",
  "extension-request-stale",
  "provider-collection-incomplete",
] as const;
type Failure = (typeof setNameRequestFailures)[number];
const jobs = "catalog_source_observation_integration_durable_jobs";
const events = "catalog_source_observation_integration_job_events";
const signals = "catalog_source_observation_durable_job_events";

type RequestRow = {
  request_id: string;
  job_id: string;
  generation: number;
  execution_key: string;
  product_line_id: number;
  deadline: Date | null;
  attempt_until: Date | null;
  attempts: number;
  environment: string | null;
  grant_id: string | null;
  closed_at: Date | null;
  answer_digest: string | null;
  receipt: Awaited<ReturnType<TcgplayerSetNameRequestAnswer>> | SealedAnswerReceipt;
};

export function createSetNameRequestRuntime(deps: {
  pool: PgTransactionalPool;
  storeIn: (db: PgQueryable) => SourceObservationIntegrationJobStore;
  recheck: (
    db: PgQueryable,
    job: SourceObservationIntegrationDurableJobRecord,
  ) => Promise<boolean | ProviderScopeMappingRow>;
}) {
  // pg clients also expose other methods at runtime. Supply a query-only adapter
  // so the durable job store participates in, rather than starts, this transaction.
  const store = (db: PgQueryable) => deps.storeIn({ query: db.query.bind(db) });
  const now = async (db: PgQueryable) =>
    (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;

  const lockExecution = (db: PgQueryable, key: string) =>
    db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalog-set-names:${key}`]);

  async function addRequest(db: PgQueryable, jobId: string, generation: number, key: string, productLineId: number) {
    await db.query(
      `INSERT INTO catalog_set_name_requests (job_id, generation, execution_key, request_id, product_line_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, generation, key, randomUUID(), productLineId],
    );
  }

  async function currentRequestForJob(db: PgQueryable, jobId: string) {
    return (
      await db.query<RequestRow>(
        `SELECT * FROM catalog_set_name_requests WHERE job_id = $1 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
        [jobId],
      )
    ).rows[0];
  }

  async function transition(
    db: PgQueryable,
    jobId: string,
    status: "running" | "completed" | "failed",
    reason: Failure | typeof OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE | null,
    observed = 0,
  ) {
    const outcome = status === "completed" ? "imported" : status === "failed" ? "failed" : null;
    const result = outcome
      ? summarizeIntegrationJobOutcomes(1, [
          {
            providerKey: "tcgplayer",
            languageCode: "en",
            expansionId: null,
            status: outcome,
            observed,
            reapplied: 0,
            reason,
          },
        ])
      : null;
    const progress = bulkProgress(
      status === "running" ? 0 : 1,
      1,
      null,
      outcome,
      status === "running" ? "waiting-for-extension" : status,
    );
    await db.query(
      `UPDATE ${jobs}
          SET status = $2, progress = $3::jsonb, result = $4::jsonb, error_message = $5,
              started_at = COALESCE(started_at, now()),
              completed_at = CASE WHEN $2 <> 'running' THEN now() END, updated_at = now()
        WHERE job_id = $1 AND job_kind IN ('extension-set-names', 'extension-sealed-products')`,
      [jobId, status, JSON.stringify(progress), JSON.stringify(result), reason],
    );
    const job = (await store(db).get(jobId))!;
    const event = await db.query<{ sequence: number }>(
      `INSERT INTO ${events} (job_id, sequence, event_name, snapshot, created_at)
       SELECT $1, COALESCE(max(sequence), 0) + 1, 'status', $2::jsonb, now()
         FROM ${events} WHERE job_id = $1 RETURNING sequence`,
      [jobId, JSON.stringify(toSourceObservationIntegrationJobEventSnapshot(job))],
    );
    await emitDurableJobWorkSignal(db, signals, "durable-job-store", jobId, Number(event.rows[0]!.sequence));
    await updateLinkedScopes(db, job);
    return job;
  }

  async function updateLinkedScopes(db: PgQueryable, job: SourceObservationIntegrationDurableJobRecord) {
    const snapshot = toSourceObservationIntegrationJob(job);
    const status = snapshot.operatorStatus;
    if (status === "partial" || status === "stale") throw new Error("Invalid extension child state.");
    await db.query(
      `UPDATE catalog_scope_sync_state
          SET state = $2, last_operator_status = $3, error_message = $4, observed_count = $5,
              changed_count = $6, requested_count = 1, failed_count = $7,
              last_started_at = $8, last_completed_at = $9, updated_at = $10
        WHERE last_job_id = $1`,
      [
        job.jobId,
        deriveCatalogScopeSyncUnitState(status),
        status,
        job.errorMessage,
        job.result?.observed ?? null,
        job.result?.imported ?? null,
        job.result?.failed ?? null,
        job.startedAt,
        job.completedAt,
        job.updatedAt,
      ],
    );
  }

  async function close(
    db: PgQueryable,
    row: RequestRow,
    reason: Failure | typeof OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE,
  ) {
    if (await hasSealedRequestParts(db, row.request_id)) await discardSealedRequestPayloads(db, row.request_id);
    await db.query(
      `UPDATE catalog_set_name_requests SET closed_at = clock_timestamp() WHERE job_id = $1 AND generation = $2`,
      [row.job_id, row.generation],
    );
    return transition(db, row.job_id, "failed", reason);
  }

  async function assertLiveGrant(db: PgQueryable, grantId: string) {
    const grant = await db.query(
      `SELECT id FROM catalog_operator_session_grants
        WHERE id = $1 AND revoked_at IS NULL AND idle_expires_at > clock_timestamp() FOR SHARE`,
      [grantId],
    );
    if (!grant.rows.length) throw new OperatorSessionRequestError("grant-invalid", 401);
  }

  const current: CatalogObservationRequestSource = ({ grant, environment }) =>
    withPgTransaction(deps.pool, async (db) => {
      await assertLiveGrant(db, grant.grantId);
      const row = (
        await db.query<RequestRow>(
          `SELECT * FROM catalog_set_name_requests WHERE closed_at IS NULL AND deadline IS NOT NULL
          FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!row || (row.environment && row.environment !== environment) || row.attempts >= 2) return null;
      const time = await now(db);
      if (row.deadline! <= time || (row.attempt_until && row.attempt_until > time)) return null;
      const job = (await store(db).get(row.job_id))!;
      const sealed = job.jobKind === sealedRequestJobKind;
      if (sealed && (await hasSealedRequestParts(db, row.request_id))) {
        await close(db, row, "extension-unavailable");
        return null;
      }
      if (!(await deps.recheck(db, job))) {
        await close(db, row, "extension-request-stale");
        return null;
      }
      const requestId = randomUUID();
      const expires = (
        await db.query<{ attempt_until: Date }>(
          `UPDATE catalog_set_name_requests
            SET request_id = $3, environment = $4, grant_id = $5, attempts = attempts + 1,
                deadline = CASE WHEN attempts = 0 THEN deadline + interval '15 minutes' ELSE deadline END,
                attempt_until = LEAST($6::timestamptz + interval '5 minutes',
                  CASE WHEN attempts = 0 THEN deadline + interval '15 minutes' ELSE deadline END)
          WHERE job_id = $1 AND generation = $2 RETURNING attempt_until`,
          [row.job_id, row.generation, requestId, environment, grant.grantId, time],
        )
      ).rows[0]!.attempt_until;
      const identity = { requestId, productLineId: row.product_line_id, expiresAt: expires.toISOString() };
      return sealed
        ? {
            kind: "sealed-products",
            ...identity,
            setNameId: Number(job.payload.scope.setId),
            searchName: job.payload.scope.setName!,
          }
        : { kind: "set-names", ...identity };
    });

  const answer: TcgplayerSetNameRequestAnswer = (input) =>
    withPgTransaction(input.backend ?? deps.pool, async (db) => {
      await assertLiveGrant(db, input.grant.grantId);
      const row = (
        await db.query<RequestRow>("SELECT * FROM catalog_set_name_requests WHERE request_id = $1 FOR UPDATE", [
          input.requestId,
        ])
      ).rows[0];
      const conflict = () => new OperatorSessionRequestError("observation-request-closed", 409);
      if (!row || row.grant_id !== input.grant.grantId || row.environment !== input.environment) throw conflict();
      const job = (await store(db).get(row.job_id))!;
      if (job.jobKind !== setNameRequestJobKind) throw conflict();
      const digest = createHash("sha256").update(input.text).digest("hex");
      if (row.closed_at) {
        if (row.answer_digest !== digest || !row.receipt || !("observationCount" in row.receipt)) throw conflict();
        return row.receipt;
      }
      const time = await now(db);
      if (!row.attempt_until || row.attempt_until <= time) throw conflict();
      if (input.kind === "observations" && input.productLineId !== row.product_line_id)
        throw new OperatorSessionRequestError("observation-line-mismatch", 409);
      if (!(await deps.recheck(db, job))) {
        await close(db, row, "extension-request-stale");
        return null;
      }
      const receipt =
        input.kind === "observations"
          ? await input.record(db)
          : { observationCount: 0, newObservationCount: 0, mappingsProposed: 0 };
      await db.query(
        `UPDATE catalog_set_name_requests
          SET closed_at = clock_timestamp(), answer_digest = $3, receipt = $4::jsonb
        WHERE job_id = $1 AND generation = $2`,
        [row.job_id, row.generation, digest, JSON.stringify(receipt)],
      );
      await transition(
        db,
        row.job_id,
        input.kind === "observations" ? "completed" : "failed",
        input.kind === "observations" ? null : input.failure,
        receipt.observationCount,
      );
      return receipt;
    });

  const answerSealed: TcgplayerSealedRequestAnswer = async (input) => {
    const { receipt, committedEvents } = await runWithEventCommitMetadata(async () => {
      const receipt = await withPgTransaction(input.backend ?? deps.pool, (db) => settleSealed(db, input));
      return { receipt, committedEvents: getEventCommitMetadata().committedEvents };
    });
    recordCommittedEvents(committedEvents);
    return receipt;
  };

  async function settleSealed(db: PgQueryable, input: Parameters<TcgplayerSealedRequestAnswer>[0]) {
    await assertLiveGrant(db, input.grant.grantId);
    const row = (
      await db.query<RequestRow>("SELECT * FROM catalog_set_name_requests WHERE request_id = $1 FOR UPDATE", [
        input.requestId,
      ])
    ).rows[0];
    const conflict = () => new OperatorSessionRequestError("observation-request-closed", 409);
    if (!row || row.grant_id !== input.grant.grantId || row.environment !== input.environment) throw conflict();
    const job = (await store(db).get(row.job_id))!;
    if (job.jobKind !== sealedRequestJobKind) throw conflict();
    const digest = createHash("sha256").update(input.text).digest("hex");
    const answer = input.answer;
    if (row.closed_at) {
      if (!row.receipt || !("kind" in row.receipt)) throw conflict();
      if (answer.kind === "part" && row.receipt.kind === "complete") {
        const replay = await replaySealedRequestPart(db, row.request_id, answer.partIndex, digest);
        if (replay) return replay;
      }
      if (answer.kind !== "part" && digest === row.answer_digest) return row.receipt;
      throw conflict();
    }
    if (!row.attempt_until || row.attempt_until <= (await now(db))) throw conflict();
    const mapping = await deps.recheck(db, job);
    if (!mapping || mapping === true) {
      await close(db, row, "extension-request-stale");
      return null;
    }
    if (answer.kind === "part") {
      const replay = await replaySealedRequestPart(db, row.request_id, answer.partIndex, digest);
      if (replay) return replay;
    }
    const receipt = await admitSealedRequestAnswer(db, input, digest, job.payload.scope, mapping);
    if (receipt.kind === "part") return receipt;
    await db.query(
      `UPDATE catalog_set_name_requests SET closed_at = clock_timestamp(), answer_digest = $3, receipt = $4::jsonb
           WHERE job_id = $1 AND generation = $2`,
      [row.job_id, row.generation, digest, JSON.stringify(receipt)],
    );
    await transition(
      db,
      row.job_id,
      receipt.kind === "complete" ? "completed" : "failed",
      receipt.kind === "failure" ? receipt.code : null,
      receipt.kind === "complete" ? receipt.productCount : 0,
    );
    return receipt;
  }

  return {
    current,
    answer,
    answerSealed,
    enqueue: (input: {
      scope: SourceObservationIntegrationJobScope;
      profileSnapshot: SourceObservationIntegrationProfileSnapshot;
      syncRunId: string;
      context: EventStoreContext;
      productLineId: number;
    }) =>
      withPgTransaction(deps.pool, async (db) => {
        const key = createHash("sha256")
          .update(
            stableJsonStringify({
              scope: input.scope,
              profile: input.profileSnapshot,
              tenant: input.context.tenantId,
              user: input.context.audit?.performedByUserId,
              account: input.context.audit?.forAccountId,
            }),
          )
          .digest("hex");
        await lockExecution(db, key);
        const jobStore = store(db);
        const jobKind = input.scope.execution === sealedRequestJobKind ? sealedRequestJobKind : setNameRequestJobKind;
        const links =
          jobKind === sealedRequestJobKind ? "catalog_sealed_request_run_links" : "catalog_set_name_request_run_links";
        const linked = (
          await db.query<{ child_job_id: string }>(`SELECT child_job_id FROM ${links} WHERE sync_run_id = $1`, [
            input.syncRunId,
          ])
        ).rows[0];
        if (linked) return toSourceObservationIntegrationJob((await jobStore.get(linked.child_job_id))!);
        const existing = (
          await db.query<{ job_id: string }>(
            "SELECT job_id FROM catalog_set_name_requests WHERE execution_key = $1 AND closed_at IS NULL",
            [key],
          )
        ).rows[0];
        const job = existing
          ? (await jobStore.get(existing.job_id))!
          : await jobStore.enqueue({
              jobId: createId("job"),
              jobKind,
              payload: {
                action: "import",
                scope: input.scope,
                syncRunId: input.syncRunId,
                profileSnapshot: input.profileSnapshot,
              },
              progress: bulkProgress(0, 1, null, null, "queued"),
              eventContext: input.context,
            });
        if (!existing) await addRequest(db, job.jobId, 1, key, input.productLineId);
        await db.query(`INSERT INTO ${links} (sync_run_id, child_job_id) VALUES ($1, $2)`, [
          input.syncRunId,
          job.jobId,
        ]);
        return toSourceObservationIntegrationJob(job);
      }),
    advance: () =>
      withPgTransaction(deps.pool, async (db) => {
        const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(84518452) AS locked");
        if (!lock.rows[0]?.locked) return 0;
        const active = (
          await db.query<RequestRow>(
            "SELECT * FROM catalog_set_name_requests WHERE closed_at IS NULL AND deadline IS NOT NULL",
          )
        ).rows[0];
        if (active) {
          const expired = (
            await db.query<RequestRow>(
              `SELECT * FROM catalog_set_name_requests WHERE job_id = $1 AND generation = $2
            AND closed_at IS NULL
            AND (deadline <= clock_timestamp() OR (attempt_until <= clock_timestamp() AND
              (attempts = 2 OR EXISTS (SELECT 1 FROM catalog_sealed_request_parts WHERE request_id = catalog_set_name_requests.request_id))))
            FOR UPDATE SKIP LOCKED`,
              [active.job_id, active.generation],
            )
          ).rows[0];
          if (!expired) return 0;
          await close(db, expired, "extension-unavailable");
          return 1;
        }
        const next = (
          await db.query<RequestRow>(
            `SELECT * FROM catalog_set_name_requests WHERE closed_at IS NULL AND deadline IS NULL
          ORDER BY created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        if (!next) return 0;
        await db.query(
          `UPDATE catalog_set_name_requests SET deadline = clock_timestamp() + interval '15 minutes'
          WHERE job_id = $1 AND generation = $2`,
          [next.job_id, next.generation],
        );
        await transition(db, next.job_id, "running", null);
        return 1;
      }),
    cancel: (jobId: string) =>
      withPgTransaction(deps.pool, async (db) => {
        const row = await currentRequestForJob(db, jobId);
        if (row && !row.closed_at)
          return toSourceObservationIntegrationJob(await close(db, row, OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE));
        const job = await store(db).get(jobId);
        if (job?.errorMessage === OPERATOR_CANCELLED_INTEGRATION_IMPORT_MESSAGE)
          return toSourceObservationIntegrationJob(job);
        throw new SourceObservationIntegrationJobLifecycleCommandError(
          "unsupported_state",
          "Only open extension jobs can be cancelled.",
        );
      }),
    retry: (jobId: string) =>
      withPgTransaction(deps.pool, async (db) => {
        const row = await currentRequestForJob(db, jobId);
        const jobStore = store(db);
        const job = await jobStore.get(jobId);
        if (!row || !job || job.status === "completed")
          throw new SourceObservationIntegrationJobLifecycleCommandError(
            "unsupported_state",
            "Only failed extension jobs can be retried.",
          );
        if (job.status !== "failed") return toSourceObservationIntegrationJob(job);
        await lockExecution(db, row.execution_key);
        const active = await db.query(
          "SELECT 1 FROM catalog_set_name_requests WHERE execution_key = $1 AND closed_at IS NULL",
          [row.execution_key],
        );
        if (active.rows.length)
          throw new SourceObservationIntegrationJobLifecycleCommandError(
            "unsupported_state",
            "A matching extension request is already active.",
          );
        const requeued = (await jobStore.requeue({
          jobId,
          progress: bulkProgress(0, 1, null, null, "queued"),
          result: summarizeIntegrationJobOutcomes(1, []),
          allowedStatuses: ["failed"],
        }))!;
        await addRequest(db, jobId, row.generation + 1, row.execution_key, row.product_line_id);
        await updateLinkedScopes(db, requeued);
        return toSourceObservationIntegrationJob(requeued);
      }),
  };
}
