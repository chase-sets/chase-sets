import { createHash, randomUUID } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresDurableJobStore } from "@chase-sets/platform-runtime/durable-job-store";
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import { moneyToCents } from "@chase-sets/primitives/money";
import { decideRepricingPolicy, initialRepricingPolicyState } from "../../repricing-policies/domain/domain";
import { planRepricingRound, traceFromEvaluation } from "../domain/round";
import type { RepricingEnginePolicyValue } from "../domain/policy";
import type { RepricingPolicyListingTrace } from "../domain/fact";
import {
  listCandidateRepricingProducts,
  loadRepricingRoundInputsPage,
  type RepricingCandidate,
  type RepricingProductKey,
} from "../read-model/queries";

export type RepricingDryRunBody = RepricingCandidate["body"];
export type RepricingDryRunSummary = Readonly<{
  listingsEvaluated: number;
  outcomes: Readonly<Record<string, number>>;
  skipReasons: Readonly<Record<string, number>>;
  flags: Readonly<Record<string, number>>;
  deltaBuckets: Readonly<Record<string, number>>;
  withinTolerance: number;
}>;
export type RepricingDryRun = Readonly<{
  dryRunId: string;
  body: RepricingDryRunBody;
  bodyHash: string;
  replacingPolicyId: string | null;
  status: "queued" | "running" | "completed" | "failed";
  requestedAt: string;
  completedAt: string | null;
  consumedAt: string | null;
  summary: RepricingDryRunSummary | null;
  cursor: RepricingProductKey | null;
  updatedAt: string;
}>;
type Payload = { dryRunId: string; sellerAccountId: string };
type Progress = { phase: RepricingDryRun["status"] };
type ReadRow = RepricingDryRun & { jobStatus: RepricingDryRun["status"] };
function publicDryRun({ jobStatus, ...run }: ReadRow): RepricingDryRun {
  return { ...run, status: jobStatus === "failed" ? "failed" : run.status };
}
const tables = { jobsTable: "pricing_repricing_dry_run_jobs", eventsTable: "pricing_repricing_dry_run_job_events" };
const jobKind = "repricing-dry-run";
const columns = `run.dry_run_id AS "dryRunId", run.body, run.body_hash AS "bodyHash",
  run.replacing_policy_id AS "replacingPolicyId", run.status, run.requested_at::text AS "requestedAt",
  run.completed_at::text AS "completedAt", run.consumed_at::text AS "consumedAt",
  run.summary, run.cursor, run.updated_at::text AS "updatedAt"`;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Invalid canonical policy body.");
  return encoded;
}

export function hashRepricingDryRunBody(body: RepricingDryRunBody): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scope: body.scope,
        excludedListingIds: body.excludedListingIds ?? [],
        rules: body.rules,
        maxChangesPerDay: body.maxChangesPerDay,
      }),
      "utf8",
    )
    .digest("hex");
}

export function validateRepricingDryRunBody(body: RepricingDryRunBody, accountId: string): RepricingDryRunBody {
  const events = decideRepricingPolicy(initialRepricingPolicyState, {
    ...body,
    type: "CreateRepricingPolicy",
    policyId: createId("rpp"),
    accountId: parseTypedId(accountId, "acc"),
    name: "Dry run",
    createdAt: new Date().toISOString(),
  });
  const event = events[0];
  if (event?.type !== "pricing.repricing-policy.created") throw new Error("Invalid policy body.");
  const { scope, excludedListingIds, rules, maxChangesPerDay } = event.data;
  return { scope, excludedListingIds, rules, maxChangesPerDay };
}

export function createRepricingDryRunServices(
  db: PgTransactionalPool,
  resolvePolicy: () => Promise<RepricingEnginePolicyValue>,
) {
  const store = createPostgresDurableJobStore<Payload, Progress, RepricingDryRunSummary>(db, tables);
  const getDryRun = async (sellerAccountId: string, dryRunId: string): Promise<RepricingDryRun | null> => {
    const row = (
      await db.query<ReadRow>(
        `SELECT ${columns}, job.status AS "jobStatus" FROM pricing_repricing_dry_runs AS run
       JOIN pricing_repricing_dry_run_jobs AS job ON job.job_id = run.dry_run_id
         AND job.payload->>'sellerAccountId' = run.seller_account_id
       WHERE run.seller_account_id = $1 AND run.dry_run_id = $2`,
        [sellerAccountId, dryRunId],
      )
    ).rows[0];
    return row ? publicDryRun(row) : null;
  };

  const enqueueDryRun = async (
    input: { sellerAccountId: string; body: RepricingDryRunBody; replacingPolicyId?: string },
    context: EventStoreContext,
  ): Promise<RepricingDryRun | null> => {
    const body = validateRepricingDryRunBody(input.body, input.sellerAccountId);
    const dryRunId = `repricing-dry-run:${randomUUID()}`;
    return withPgTransaction(db, async (client) => {
      if (input.replacingPolicyId !== undefined) {
        const owned = await client.query(
          `SELECT policy.policy_id FROM pricing_repricing_policies AS policy
           WHERE policy.seller_account_id = $1 AND policy.policy_id = $2`,
          [input.sellerAccountId, input.replacingPolicyId],
        );
        if (!owned.rows.length) return null;
      }
      const result = await client.query<RepricingDryRun>(
        `INSERT INTO pricing_repricing_dry_runs AS run (
          dry_run_id, seller_account_id, replacing_policy_id, body, body_hash, status, requested_at, updated_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', clock_timestamp(), clock_timestamp())
        RETURNING ${columns}`,
        [
          dryRunId,
          input.sellerAccountId,
          input.replacingPolicyId ?? null,
          JSON.stringify(body),
          hashRepricingDryRunBody(body),
        ],
      );
      await createPostgresDurableJobStore<Payload, Progress, RepricingDryRunSummary>(
        {
          query: client.query.bind(client),
        },
        tables,
      ).enqueue({
        jobId: dryRunId,
        jobKind,
        payload: { dryRunId, sellerAccountId: input.sellerAccountId },
        progress: { phase: "queued" },
        eventContext: context,
      });
      return result.rows[0]!;
    });
  };

  const listDryRuns = async (sellerAccountId: string, limit = 25): Promise<readonly RepricingDryRun[]> =>
    (
      await db.query<ReadRow>(
        `SELECT ${columns}, job.status AS "jobStatus" FROM pricing_repricing_dry_runs AS run
       JOIN pricing_repricing_dry_run_jobs AS job ON job.job_id = run.dry_run_id
         AND job.payload->>'sellerAccountId' = run.seller_account_id
       WHERE run.seller_account_id = $1 ORDER BY run.requested_at DESC, run.dry_run_id DESC LIMIT $2`,
        [sellerAccountId, boundedLimit(limit)],
      )
    ).rows.map(publicDryRun);

  const listDryRunTraces = async (
    sellerAccountId: string,
    dryRunId: string,
    input: { outcome?: RepricingPolicyListingTrace["outcome"]; after?: string; limit?: number } = {},
  ): Promise<readonly RepricingPolicyListingTrace[]> =>
    (
      await db.query<{ trace: RepricingPolicyListingTrace }>(
        `SELECT item.trace FROM pricing_repricing_dry_run_traces AS item
       WHERE item.seller_account_id = $1 AND item.dry_run_id = $2
         AND ($3::text IS NULL OR item.outcome = $3) AND ($4::text IS NULL OR item.listing_id > $4)
       ORDER BY item.listing_id LIMIT $5`,
        [sellerAccountId, dryRunId, input.outcome ?? null, input.after ?? null, boundedLimit(input.limit ?? 100)],
      )
    ).rows.map((row) => row.trace);

  const listDryRunEvents = async (sellerAccountId: string, dryRunId: string, afterSequence = 0) =>
    (
      await db.query<{ sequence: number; status: RepricingDryRun["status"] }>(
        `SELECT event.sequence, event.snapshot->>'status' AS status
       FROM pricing_repricing_dry_run_job_events AS event
       JOIN pricing_repricing_dry_runs AS run ON run.dry_run_id = event.job_id
       WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND event.sequence > $3
       ORDER BY event.sequence LIMIT 100`,
        [sellerAccountId, dryRunId, afterSequence],
      )
    ).rows.map((event) => ({ sequence: event.sequence, eventName: "status", data: { status: event.status } }));

  const processNextDryRunJob = async (input: {
    claimOwnerId: string;
    claimTtlMs: number;
    signal?: AbortSignal;
    throwIfLeaseLost?: () => void;
  }): Promise<number> => {
    const claimed = await store.claimNext({ ...input, jobKinds: [jobKind] });
    if (!claimed) return 0;
    const { sellerAccountId, dryRunId } = claimed.payload;
    const checkLease = () => {
      input.throwIfLeaseLost?.();
      if (input.signal?.aborted) throw new Error("Repricing dry run cancelled.");
    };
    const requireOwned = (owned: unknown) => {
      if (!owned) throw new Error("Repricing dry run claim lost.");
    };
    // Every page write checks the exact claim generation, not just its reusable owner name.
    const claimSql = `EXISTS (SELECT 1 FROM pricing_repricing_dry_run_jobs AS job
      WHERE job.job_id = run.dry_run_id AND job.payload->>'sellerAccountId' = run.seller_account_id
        AND job.status = 'running' AND job.claim_owner_id = $4 AND job.attempt_count = $5
        AND job.claimed_until > clock_timestamp())`;
    const initial = await getDryRun(sellerAccountId, dryRunId);
    if (!initial) throw new Error("Repricing dry run not found.");
    let run: RepricingDryRun = initial;
    try {
      checkLease();
      const policy = await resolvePolicy();
      if (run.status !== "completed") {
        const started = await db.query<RepricingDryRun>(
          `UPDATE pricing_repricing_dry_runs AS run SET status = 'running', updated_at = clock_timestamp()
           WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND run.updated_at = $3::timestamptz
             AND run.status = $6 AND ${claimSql} RETURNING ${columns}`,
          [sellerAccountId, dryRunId, run.updatedAt, input.claimOwnerId, claimed.attemptCount, run.status],
        );
        requireOwned(started.rows[0]);
        run = started.rows[0]!;
        const candidate: RepricingCandidate = {
          sellerAccountId,
          body: run.body,
          ...(run.replacingPolicyId ? { replacingPolicyId: run.replacingPolicyId } : {}),
        };
        while (true) {
          checkLease();
          const products = await listCandidateRepricingProducts(db, candidate, run.cursor);
          if (!products.length) break;
          const rounds = await loadRepricingRoundInputsPage(db, { products, candidate });
          const traces: RepricingPolicyListingTrace[] = [];
          for (const round of rounds.values()) {
            for (const evaluation of planRepricingRound(round, run.requestedAt, policy)) {
              const outcome =
                evaluation.action === "update-price"
                  ? "changed"
                  : evaluation.action === "pause"
                    ? "pause-requested"
                    : evaluation.action === "notify-only"
                      ? "notify-only"
                      : "skipped";
              traces.push(traceFromEvaluation(evaluation, outcome, evaluation.skipReason));
            }
          }
          checkLease();
          const guard = [sellerAccountId, dryRunId, run.updatedAt, input.claimOwnerId, claimed.attemptCount];
          await db.query(
            `INSERT INTO pricing_repricing_dry_run_traces
               (dry_run_id, seller_account_id, listing_id, outcome, skip_reason, flags, delta_cents, trace)
             SELECT run.dry_run_id, run.seller_account_id, item.trace->>'listingId', item.trace->>'outcome',
               item.trace->>'skipReason', ARRAY(SELECT jsonb_array_elements_text(item.trace->'flags')),
               item.delta_cents, item.trace
             FROM pricing_repricing_dry_runs AS run
             CROSS JOIN jsonb_to_recordset($6::jsonb) AS item(trace jsonb, delta_cents bigint)
             WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND run.updated_at = $3::timestamptz
               AND run.status = 'running' AND ${claimSql}
             ON CONFLICT (dry_run_id, listing_id) DO NOTHING`,
            [
              ...guard,
              JSON.stringify(
                traces.map((trace) => ({
                  trace,
                  delta_cents:
                    trace.targetPriceAmount === null
                      ? null
                      : (moneyToCents(trace.targetPriceAmount) - moneyToCents(trace.currentPriceAmount)).toString(),
                })),
              ),
            ],
          );
          checkLease();
          const advanced = await db.query<RepricingDryRun>(
            `WITH advanced AS (
               UPDATE pricing_repricing_dry_runs AS run SET cursor = $6::jsonb, updated_at = clock_timestamp()
               WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND run.updated_at = $3::timestamptz
                 AND run.status = 'running' AND ${claimSql} RETURNING ${columns}
             ), renewed AS (
               UPDATE pricing_repricing_dry_run_jobs AS job
               SET claimed_until = clock_timestamp() + $7 * interval '1 millisecond', updated_at = clock_timestamp()
               WHERE job.job_id = $2 AND job.payload->>'sellerAccountId' = $1
                 AND job.status = 'running' AND job.claim_owner_id = $4 AND job.attempt_count = $5
                 AND job.claimed_until > clock_timestamp() AND EXISTS (SELECT 1 FROM advanced)
               RETURNING job.job_id
             ) SELECT advanced.* FROM advanced JOIN renewed ON renewed.job_id = advanced."dryRunId"`,
            [...guard, JSON.stringify(products.at(-1)), input.claimTtlMs],
          );
          requireOwned(advanced.rows[0]);
          run = advanced.rows[0]!;
          if (products.length < 500) break;
        }
        checkLease();
        const completed = await db.query<RepricingDryRun>(
          `WITH items AS MATERIALIZED (
             SELECT item.* FROM pricing_repricing_dry_run_traces AS item
             WHERE item.seller_account_id = $1 AND item.dry_run_id = $2
           ), summary AS (SELECT jsonb_build_object(
             'listingsEvaluated', (SELECT count(*) FROM items),
             'withinTolerance', (SELECT count(*) FROM items WHERE items.skip_reason = 'within-tolerance'),
             'outcomes', COALESCE((SELECT jsonb_object_agg(counts.key, counts.n) FROM
               (SELECT items.outcome AS key, count(*) AS n FROM items GROUP BY items.outcome) AS counts), '{}'::jsonb),
             'skipReasons', COALESCE((SELECT jsonb_object_agg(counts.key, counts.n) FROM
               (SELECT items.skip_reason AS key, count(*) AS n FROM items WHERE items.skip_reason IS NOT NULL
                 GROUP BY items.skip_reason) AS counts), '{}'::jsonb),
             'flags', COALESCE((SELECT jsonb_object_agg(counts.key, counts.n) FROM
               (SELECT flag.key, count(*) AS n FROM items CROSS JOIN LATERAL unnest(items.flags) AS flag(key)
                 GROUP BY flag.key) AS counts), '{}'::jsonb),
             'deltaBuckets', COALESCE((SELECT jsonb_object_agg(counts.key, counts.n) FROM
               (SELECT width_bucket(items.delta_cents::numeric /
                   NULLIF((items.trace->>'currentPriceAmount')::numeric, 0),
                   ARRAY[-20,-10,-5,-1,1,5,10,20]::numeric[]) AS key, count(*) AS n
                 FROM items WHERE items.outcome = 'changed' GROUP BY key) AS counts), '{}'::jsonb)
           ) AS value)
           UPDATE pricing_repricing_dry_runs AS run
           SET status = 'completed', completed_at = clock_timestamp(), summary = summary.value, updated_at = clock_timestamp()
           FROM summary
           WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND run.updated_at = $3::timestamptz
             AND run.status = 'running' AND ${claimSql} RETURNING ${columns}`,
          [sellerAccountId, dryRunId, run.updatedAt, input.claimOwnerId, claimed.attemptCount],
        );
        requireOwned(completed.rows[0]);
        run = completed.rows[0]!;
      }
      checkLease();
      requireOwned(
        await store.complete({
          jobId: dryRunId,
          claimOwnerId: input.claimOwnerId,
          progress: { phase: "completed" },
          result: run.summary!,
        }),
      );
      return 1;
    } catch (error) {
      try {
        checkLease();
        const failed = await db.query(
          `UPDATE pricing_repricing_dry_runs AS run SET status = 'failed', updated_at = clock_timestamp()
           WHERE run.seller_account_id = $1 AND run.dry_run_id = $2 AND run.updated_at = $3::timestamptz
             AND run.status = $6 AND run.status IN ('queued', 'running') AND ${claimSql}
           RETURNING run.dry_run_id`,
          [sellerAccountId, dryRunId, run.updatedAt, input.claimOwnerId, claimed.attemptCount, run.status],
        );
        if (failed.rows.length)
          await store.fail({
            jobId: dryRunId,
            claimOwnerId: input.claimOwnerId,
            progress: { phase: "failed" },
            errorMessage: "Repricing dry run failed.",
          });
      } catch {
        // Preserve the operation error if the claim or failure persistence is unavailable.
      }
      throw error;
    }
  };

  return {
    enqueueDryRun,
    getDryRun,
    listDryRuns,
    listDryRunTraces,
    listDryRunEvents,
    processNextDryRunJob,
    waitForDryRunEvents: async (sellerAccountId: string, dryRunId: string, signal?: AbortSignal) => {
      if (await getDryRun(sellerAccountId, dryRunId)) await store.waitForEvents({ jobId: dryRunId, signal });
    },
  };
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be between 1 and 100.");
  return limit;
}
