import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { resolvePublicRequestOrigin } from "@chase-sets/platform-runtime/http";
import type { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { catalogProviderProfileVersionIngestionUnitKey } from "../../source-observations/api/provider-integration-profiles";
import {
  CountCaptureStopped,
  runCountCaptureRequest,
} from "../../source-observations/api/providers/count-capture-transport";
import { runCatalogProviderWork } from "../../source-observations/api/providers/provider-send-admission";
import type { CatalogProviderSendRuntime } from "../../source-observations/api/providers/provider-send-runtime";
import type { CatalogProviderIntegrationProfileVersionReader } from "../../source-observations/api/source-observation-runtime-contracts";
import {
  countFingerprint,
  countQuoteSchema,
  countResultSchema,
  type CountAuthority,
  type CountQuote,
} from "../domain/count-acquisition";
import {
  countCaptureFields,
  countCaptureUnitKeys,
  countCapturePlanSchema,
  captureCountPlannerRead,
} from "../domain/count-capture-plan";
import {
  normalizeScopeSyncBatchBudget,
  type ScopeSyncBatchSelection,
  type ScopeSyncBatchBudget,
} from "../domain/batch";
import type { ScopeSyncBatchServices } from "./runtime";
import { collectCountCapturePlannerRead } from "./count-capture-context";
import {
  countCaptureAuthoritySchema,
  validateCountCaptureAuthority,
  type CountCaptureAuthority,
  countCaptureCollectionSchema,
  countLifecycleReceiptSchema,
  countLifecycleStopReceiptSchema,
  classifyCountLifecycleReceipt,
  validateCountLifecycleReceipt,
  type CountLifecycleReceipt,
  type CountLifecycleStopReceipt,
} from "../domain/count-lifecycle-receipt";
import {
  countCaptureSendCap,
  countCapturePhaseCaps,
  type CountCaptureBaseline,
  type CountCaptureEffects,
  type CountCaptureHost,
  type CountCaptureStore,
  type CountCaptureRun,
} from "../read-model/count-capture-store";
import { resolveScopeSyncCountMembership } from "./planner";

export const countCaptureAdminOrigin = "https://admin.staging.chasesets.com";
export type CountCaptureSession = Readonly<{
  request: Request;
  actor: ResolvedActor | null;
  context: EventStoreContext;
}>;

// The run owner is derived from the authenticated session alone: a real staging
// platform-admin session with Catalog view and manage, no agent grant, posting
// from the staging Admin origin. There is no client-supplied run or phase ID.
export function countCaptureSessionOwner(session: CountCaptureSession, environment: string): string {
  const { actor, context, request } = session;
  if (environment !== "staging") throw new CountCaptureStopped();
  if (!actor || !actor.sessionId) throw new CountCaptureStopped();
  if (actor.agentGrant) throw new CountCaptureStopped();
  if (actor.roleKey !== "platform-admin") throw new CountCaptureStopped();
  if (!actor.permissions.includes("catalog.view")) throw new CountCaptureStopped();
  if (!actor.permissions.includes("catalog.manage")) throw new CountCaptureStopped();
  if (
    actor.tenantId !== context.tenantId ||
    actor.userId !== context.audit.performedByUserId ||
    actor.accountId !== context.audit.forAccountId
  )
    throw new CountCaptureStopped();
  if (request.method !== "POST") throw new CountCaptureStopped();
  if (request.headers.get("origin") !== countCaptureAdminOrigin) throw new CountCaptureStopped();
  if (resolvePublicRequestOrigin(request) !== countCaptureAdminOrigin) throw new CountCaptureStopped();
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new CountCaptureStopped();
  return countFingerprint({
    session: actor.sessionId,
    tenant: actor.tenantId,
    account: actor.accountId,
    user: actor.userId,
  });
}

type Instant = string | Date;
// The local rows a baseline reads: the selected scope record, its accepted
// provider mappings and the Scrydex profile versions.
export type CountCaptureRoster = Readonly<{
  records: readonly Readonly<{
    scope_record_id: string;
    product_domain: string;
    scope_kind: string;
    lifecycle_status: string;
    updated_at: Instant;
  }>[];
  mappings: readonly Readonly<{
    mapping_id: string;
    scope_record_id: string;
    provider_key: string;
    unit_key: string;
    set_id: string | null;
    updated_at: Instant;
  }>[];
  profiles: readonly Readonly<{
    profileKey: string;
    profileVersion: string;
    active: boolean;
    lifecycle: string;
    unitKey: string | null;
  }>[];
}>;
export type CountCaptureLifecycle = ReturnType<typeof createCountCaptureLifecycle>;
type CaptureInput = Readonly<{ selection: ScopeSyncBatchSelection; budget?: Partial<ScopeSyncBatchBudget> | null }>;
export const countCapturePlannerInputSchema = z
  .object({
    selection: z.object({ mode: z.literal("ids"), scopeRecordIds: z.array(countCaptureFields.id).length(1) }).strict(),
    budget: countCapturePlanSchema.shape.budget.partial().nullable().optional(),
  })
  .strict();
export const countCaptureFreezeInputSchema = z
  .object({
    runnerRunId: z.string().regex(/^[1-9]\d{0,19}$/),
    runnerRunAttempt: z.number().int().min(1).max(1000),
    collection: countCaptureCollectionSchema.optional(),
  })
  .strict();
export type CountCaptureEvidence = Readonly<{
  complete: boolean;
  acquisitions: CountLifecycleReceipt["acquisitions"];
  usage: CountLifecycleReceipt["usage"] | null;
}>;

// One owned quote, at most two count debits plus an overflow sentinel, and the
// latest retained usage. These local reads never invoke adapter readiness.
export async function readCountCaptureEvidence(
  db: PgQueryable,
  slot: string,
  quote: CountQuote,
): Promise<CountCaptureEvidence> {
  const usageRow = await db.query<{ payload: unknown }>(
    "SELECT payload FROM catalog_scope_sync_count_history WHERE account_slot=$1 AND event_kind='usage' ORDER BY position DESC LIMIT 1",
    [slot],
  );
  const snapshot = z
    .object({
      remainingCredits: z.number().int().nonnegative().nullable(),
      totalCredits: z.number().int().nonnegative().nullable(),
      observedAt: z.iso.datetime({ offset: true }),
      attemptState: z.literal("checked"),
    })
    .safeParse(usageRow.rows[0]?.payload);
  const since = snapshot.success ? new Date(Date.parse(snapshot.data.observedAt) - 1_800_000).toISOString() : null;
  const totals = await db.query<{ debits: string; reserved: string }>(
    `SELECT
    (SELECT count(*) FROM catalog_scope_sync_count_history WHERE account_slot=$1 AND event_kind='debit' AND recorded_at > $2::timestamptz)::text AS debits,
    COALESCE((SELECT sum(GREATEST(0,(budget->'creditedProviderRequestLimits'->>'scrydex')::bigint)) FROM catalog_scope_sync_batches WHERE status IN ('queued','running') OR updated_at > $2::timestamptz),0)::text AS reserved`,
    [slot, since],
  );
  const rows = await db.query<{
    debit_id: string;
    recorded_at: string | Date;
    count_kind: "cards" | "sealed";
    result: unknown;
  }>(
    `SELECT d.event_id AS debit_id,d.recorded_at,d.count_kind,r.payload AS result
    FROM catalog_scope_sync_count_history d LEFT JOIN catalog_scope_sync_count_history r ON r.debit_id=d.event_id AND r.event_kind='result'
    WHERE d.account_slot=$1 AND d.quote_id=$2 AND d.event_kind='debit' ORDER BY d.position LIMIT 3`,
    [slot, quote.quoteId],
  );
  const acquisitions: CountLifecycleReceipt["acquisitions"] = [];
  let complete = rows.rows.length <= 2;
  for (const row of rows.rows.slice(0, 2)) {
    const parsed = countResultSchema.safeParse(row.result);
    if (!parsed.success || parsed.data.outcome !== "complete" || parsed.data.evidence.sourceId !== row.debit_id) {
      complete = false;
      continue;
    }
    const candidate = countLifecycleReceiptSchema.shape.acquisitions.element.safeParse({
      evidence: parsed.data.evidence,
      debitId: row.debit_id,
      quoteId: quote.quoteId,
      kind: row.count_kind,
      debitedAt: new Date(row.recorded_at).toISOString(),
      credits: 1,
      outcome: "complete",
      reused: false,
      priorReceiptHash: null,
      method: "GET",
    });
    if (candidate.success) acquisitions.push(candidate.data);
    else complete = false;
  }
  const usage = snapshot.success
    ? countLifecycleReceiptSchema.shape.usage.safeParse({
        remainingCredits: snapshot.data.remainingCredits,
        totalCredits: snapshot.data.totalCredits,
        observedAt: snapshot.data.observedAt,
        creditState:
          snapshot.data.remainingCredits === null
            ? "unknown"
            : snapshot.data.remainingCredits > 0
              ? "available"
              : "exhausted",
        usedCredits: null,
        providerUpdatedAt: null,
        lagCategory: "documented-window",
        bootstrap: "skipped",
        ageMs: 0,
        unreflectedCredits: Number(totals.rows[0]?.debits),
        reservedCredits: Number(totals.rows[0]?.reserved),
        additionalUsageCredits: 0,
        persisted: true,
      })
    : null;
  return { complete, acquisitions, usage: usage?.success ? usage.data : null };
}

const iso = (value: Instant) => new Date(value).toISOString();

// Local reads only: the exact selected scope record, its accepted mappings and
// every Scrydex profile version.
export async function readCountCaptureRoster(
  db: PgQueryable,
  profiles: CatalogProviderIntegrationProfileVersionReader,
  scopeRecordId: string,
): Promise<CountCaptureRoster> {
  const membership = await resolveScopeSyncCountMembership(db, { mode: "ids", scopeRecordIds: [scopeRecordId] });
  return {
    records: membership.records,
    mappings: membership.mappings,
    profiles: (await profiles.listProfileVersions("scrydex")).map((version) => ({
      profileKey: version.profileKey,
      profileVersion: version.profileVersion,
      active: version.active,
      lifecycle: version.lifecycle,
      unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    })),
  };
}

// The deployed Scrydex adapter's own usage observation, whose callback persists
// count authority, under whatever provider-send admission the deployment
// enforces. No other provider, raw usage request or cache expiry is involved.
export function observeDeployedScrydexUsage(
  registry: ProviderAdapterRegistry,
  providerSendRuntime: CatalogProviderSendRuntime | null | undefined,
) {
  return async (): Promise<unknown> => {
    const adapter = registry.require("scrydex");
    if (!adapter.getUsageSnapshot) throw new CountCaptureStopped();
    const observe = () => adapter.getUsageSnapshot!();
    return providerSendRuntime ? runCatalogProviderWork(providerSendRuntime.admission, observe) : observe();
  };
}

// Skips the usage read when durable count authority already covers `required`;
// otherwise makes exactly one deployed adapter usage observation, whose own
// callback persists the sanitized snapshot. Only the durable authority read back
// afterwards decides: the raw returned balance is never authority.
export async function retainTargetedCountCaptureUsage(
  deps: Readonly<{ authority(): Promise<CountAuthority>; getUsageSnapshot(): Promise<unknown> }>,
  required: number,
) {
  const covers = (authority: CountAuthority) =>
    authority.allowed && authority.headroom !== null && authority.headroom >= required;
  const before = await deps.authority();
  if (covers(before)) return { state: "skipped" as const, required, authority: before };
  await deps.getUsageSnapshot();
  const after = await deps.authority();
  if (!covers(after)) throw new CountCaptureStopped();
  return { state: "persisted" as const, required, authority: after };
}

// The full roster: one active One Piece OP01 set whose accepted mappings are
// exactly the three Scrydex capture units, each with one active profile version.
// An extra, omitted, foreign-provider or other-set unit refuses; none is dropped.
function rosterBaseline(roster: CountCaptureRoster, scopeRecordId: string, accountRevision: string) {
  const record = roster.records[0];
  if (
    roster.records.length !== 1 ||
    !record ||
    record.scope_record_id !== scopeRecordId ||
    record.product_domain !== "one-piece" ||
    record.scope_kind !== "set" ||
    record.lifecycle_status !== "active"
  )
    throw new CountCaptureStopped();
  if (roster.mappings.length !== countCaptureUnitKeys.length) throw new CountCaptureStopped();
  const units = countCaptureUnitKeys.map((unitKey) => {
    const mappings = roster.mappings.filter(
      (mapping) =>
        mapping.scope_record_id === scopeRecordId &&
        mapping.provider_key === "scrydex" &&
        mapping.unit_key === unitKey &&
        mapping.set_id === "OP01",
    );
    const profiles = roster.profiles.filter(
      (profile) => profile.unitKey === unitKey && profile.active && profile.lifecycle === "active",
    );
    const [mapping] = mappings;
    const [profile] = profiles;
    if (mappings.length !== 1 || profiles.length !== 1 || !mapping || !profile) throw new CountCaptureStopped();
    return {
      unitKey,
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      mappingId: mapping.mapping_id,
      mappingVersion: iso(mapping.updated_at),
      setCoordinate: "OP01" as const,
    };
  });
  return {
    selection: {
      scopeRecordId,
      scopeRecordVersion: iso(record.updated_at),
      accountRevision,
      productDomain: "one-piece" as const,
      parentValue: "OP01" as const,
      languageCode: "en" as const,
    },
    units,
  };
}

// The host's declaration, retained as declared. The server checked its
// consistency and freshness; it never observed the deployment or pods it names.
function declaredHost(authority: CountCaptureAuthority): CountCaptureHost {
  const { budget, deployment } = authority;
  return {
    fingerprint: countFingerprint(authority),
    dispatchId: authority.dispatchId,
    packetHash: authority.packetHash,
    runnerSha: authority.runnerSha,
    deployment: { runId: deployment.runId, jobId: deployment.jobId, sha: deployment.sha, digest: deployment.digest },
    netCredits: budget.remainingCredits - budget.unreflectedCredits - budget.reservedCredits,
  };
}

// One staging count capture. Each handler resolves the run
// from the session owner; every step refuses without the owner's admitted run.
export function createCountCaptureLifecycle(deps: {
  environment: string;
  accountRevision: string;
  store: CountCaptureStore;
  readRoster(scopeRecordId: string): Promise<CountCaptureRoster>;
  readEffects(at: string): Promise<CountCaptureEffects>;
  countAuthority(): Promise<CountAuthority>;
  // The deployed adapter's usage observation, whose callback persists authority.
  observeUsage(): Promise<unknown>;
  counts?: Pick<
    ScopeSyncBatchServices,
    "quoteCounts" | "getCountQuote" | "acquireCounts" | "preview" | "preConfirmPlannerRead"
  >;
  readCountEvidence?(quote: CountQuote): Promise<CountCaptureEvidence>;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const owner = (session: CountCaptureSession) => countCaptureSessionOwner(session, deps.environment);
  const requireCounts = () => {
    if (!deps.counts) throw new CountCaptureStopped();
    return deps.counts;
  };
  async function unchanged(run: CountCaptureRun) {
    const roster = rosterBaseline(await deps.readRoster(run.scopeRecordId), run.scopeRecordId, deps.accountRevision);
    if (
      !run.baseline ||
      countFingerprint(roster) !== countFingerprint({ selection: run.baseline.selection, units: run.baseline.units })
    )
      throw new CountCaptureStopped();
  }
  async function local<T>(run: CountCaptureRun, work: () => Promise<T>) {
    return runCountCaptureRequest(
      { binding: { runId: run.runId, requestId: randomUUID(), phase: "quote" }, ledger: deps.store.ledger },
      work,
    );
  }
  async function currentQuote(run: CountCaptureRun, session: CountCaptureSession) {
    if (!run.quote) throw new CountCaptureStopped();
    await unchanged(run);
    const authority = await deps.countAuthority();
    if (
      !authority.allowed ||
      authority.fingerprint !== run.quote.authority.fingerprint ||
      authority.headroom === null ||
      authority.headroom <
        run.quote.plannedCredits + countCapturePhaseCaps.preview + countCapturePhaseCaps["pre-confirm"]
    )
      throw new CountCaptureStopped();
    const quote = countQuoteSchema.parse(
      await requireCounts().getCountQuote({ quoteId: run.quote.quoteId, context: session.context }),
    );
    const normalized =
      quote.plannedCredits === 0 && quote.state === "complete" ? { ...quote, state: run.quote.state } : quote;
    if (countFingerprint(normalized) !== countFingerprint(run.quote) || Date.parse(quote.expiresAt) < Date.parse(now()))
      throw new CountCaptureStopped();
    return normalized;
  }
  async function phase<T>(
    session: CountCaptureSession,
    name: "quote" | "acquisition" | "preview" | "pre-confirm",
    work: (run: CountCaptureRun, binding: Awaited<ReturnType<CountCaptureStore["begin"]>>) => Promise<T>,
  ) {
    const run = await deps.store.activeRun(owner(session));
    const binding = await deps.store.begin(run.runId, name);
    return runCountCaptureRequest({ binding, ledger: deps.store.ledger }, async () => {
      await unchanged(run);
      const result = await work(run, binding);
      await deps.store.finish(binding);
      return result;
    });
  }

  return {
    // Admits one run under a valid host authority envelope, then reads its
    // baseline locally inside the run's zero-send baseline phase.
    async baseline(session: CountCaptureSession, input: Readonly<{ scopeRecordId: string; authority: unknown }>) {
      const ownerHash = owner(session);
      const at = now();
      if (!validateCountCaptureAuthority(input.authority, at).ok) throw new CountCaptureStopped();
      const host = declaredHost(countCaptureAuthoritySchema.parse(input.authority));
      const run = await deps.store.admit({
        ownerHash,
        scopeRecordId: input.scopeRecordId,
        host,
        authority: countCaptureAuthoritySchema.parse(input.authority),
      });
      const binding = await deps.store.begin(run.runId, "baseline");
      const baseline: CountCaptureBaseline = await runCountCaptureRequest(
        { binding, ledger: deps.store.ledger },
        async () => {
          const roster = rosterBaseline(
            await deps.readRoster(run.scopeRecordId),
            run.scopeRecordId,
            deps.accountRevision,
          );
          const recorded = await deps.store.recordBaseline(binding, {
            recordedAt: now(),
            ...roster,
            countAuthority: await deps.countAuthority(),
            effects: await deps.readEffects(now()),
          });
          await deps.store.finish(binding);
          return recorded;
        },
      );
      return {
        authority: countCaptureAuthoritySchema.parse(input.authority),
        admittedAt: run.admittedAt,
        expiresAt: run.expiresAt,
        host: run.host,
        access: {
          originHost: new URL(countCaptureAdminOrigin).host,
          role: "platform-admin" as const,
          permissions: ["catalog.view", "catalog.manage"] as const,
          ownerMatch: true as const,
          checkedAt: at,
        },
        baseline,
        providerSends: (await deps.store.read(run.runId)).sends.length,
      };
    },
    // Records the pre-spend notice, then returns it as read back from the store.
    async initialNotice(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      const recorded = await deps.store.recordInitialNotice(run.runId);
      const notice = (await deps.store.read(run.runId)).notice;
      if (!notice || notice.fingerprint !== recorded.fingerprint) throw new CountCaptureStopped();
      return { notice };
    },
    // The bootstrap phase. Usage reads are not count debits, so durable authority
    // must cover the whole run cap, including this phase's own possible send.
    async usage(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      const binding = await deps.store.begin(run.runId, "bootstrap");
      const usage = await runCountCaptureRequest({ binding, ledger: deps.store.ledger }, async () => {
        const outcome = await retainTargetedCountCaptureUsage(
          { authority: deps.countAuthority, getUsageSnapshot: deps.observeUsage },
          countCaptureSendCap,
        );
        const recorded = await deps.store.recordUsage(binding, outcome);
        await deps.store.finish(binding);
        return recorded;
      });
      return { usage };
    },
    quote(session: CountCaptureSession, input: CaptureInput) {
      return phase(session, "quote", async (run, binding) => {
        const budget = countCapturePlanSchema.shape.budget.parse(normalizeScopeSyncBatchBudget(input.budget));
        if (
          countFingerprint(input.selection) !== countFingerprint({ mode: "ids", scopeRecordIds: [run.scopeRecordId] })
        )
          throw new CountCaptureStopped();
        const quote = countQuoteSchema.parse(
          await requireCounts().quoteCounts({
            selection: input.selection,
            cap: countCapturePhaseCaps.acquisition,
            context: session.context,
          }),
        );
        const evidence = await deps.readCountEvidence?.(quote);
        return deps.store.bindQuote(binding, quote, budget, evidence?.usage);
      });
    },
    async quoteReadback(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      return local(run, async () => ({
        quote: await deps.store.readBackQuote(run.runId, await currentQuote(run, session)),
      }));
    },
    async finalNotice(session: CountCaptureSession) {
      const run = await deps.store.activeRun(owner(session));
      return local(run, async () => {
        await currentQuote(run, session);
        const recorded = await deps.store.recordFinalNotice(run.runId);
        const notice = (await deps.store.read(run.runId)).finalNotice;
        if (!notice || countFingerprint(notice) !== countFingerprint(recorded)) throw new CountCaptureStopped();
        return { notice: await deps.store.readBackFinalNotice(run.runId, notice.fingerprint) };
      });
    },
    acquire(session: CountCaptureSession, input: Readonly<{ quoteId: string; fingerprint: string }>) {
      return phase(session, "acquisition", async (run, binding) => {
        await currentQuote(run, session);
        await deps.store.approveAcquisition(binding, input.quoteId, input.fingerprint);
        const result = countQuoteSchema.parse(
          await requireCounts().acquireCounts({ ...input, context: session.context }),
        );
        await deps.store.retainAcquisition(binding, result);
        return { retained: true as const };
      });
    },
    preview(session: CountCaptureSession, input: CaptureInput) {
      return phase(session, "preview", async (run, binding) => {
        if (
          !run.acquisition ||
          countFingerprint(input.selection) !== countFingerprint(run.quote?.selection) ||
          countFingerprint(normalizeScopeSyncBatchBudget(input.budget)) !== countFingerprint(run.budget)
        )
          throw new CountCaptureStopped();
        const observed = await collectCountCapturePlannerRead(() =>
          requireCounts().preview({ ...input, context: session.context }),
        );
        await deps.store.retainPlannerRead(
          binding,
          captureCountPlannerRead({
            requestId: binding.requestId,
            plan: observed.plan,
            winners: observed.winners,
            preConfirm: null,
          }),
        );
        return observed.value;
      });
    },
    preConfirm(session: CountCaptureSession, input: CaptureInput & { planFingerprint: string }) {
      return phase(session, "pre-confirm", async (run, binding) => {
        if (
          input.planFingerprint !== run.reads[0]?.planFingerprint ||
          countFingerprint(input.selection) !== countFingerprint(run.quote?.selection) ||
          countFingerprint(normalizeScopeSyncBatchBudget(input.budget)) !== countFingerprint(run.budget)
        )
          throw new CountCaptureStopped();
        const observed = await collectCountCapturePlannerRead(() =>
          requireCounts().preConfirmPlannerRead({ ...input, context: session.context }),
        );
        await deps.store.retainPlannerRead(
          binding,
          captureCountPlannerRead({
            requestId: binding.requestId,
            plan: observed.plan,
            winners: observed.winners,
            preConfirm: observed.value,
          }),
        );
        return observed.value;
      });
    },
    async freeze(session: CountCaptureSession, input: z.infer<typeof countCaptureFreezeInputSchema>) {
      const parsed = countCaptureFreezeInputSchema.parse(input);
      const run = await deps.store.seal(owner(session));
      return local(run, async () => {
        const receipt = await closedReceipt(run, parsed, run.stopped);
        if (validateCountLifecycleReceipt(receipt).valid)
          return { receipt: await deps.store.retainReceipt(run.runId, receipt) };

        // A sealed run must return its own freeze-phase stop even when the
        // completed receipt cannot be classified as a safe lifecycle. Never
        // turn that server-owned stop into a runner baseline fallback.
        const stopCandidate = {
          schemaVersion: "scope-sync-count-lifecycle-stop/v1",
          attribution: {
            dispatchId: receipt.attribution.dispatchId,
            runnerRunId: receipt.attribution.runnerRunId,
            runnerRunAttempt: receipt.attribution.runnerRunAttempt,
            runnerSha: receipt.attribution.runnerSha,
            packetHash: receipt.attribution.packetHash,
            reviewReceiptHash: receipt.attribution.reviewReceiptHash,
            phases: receipt.attribution.phases,
          },
          stoppedAt: "frozenAt" in receipt ? receipt.frozenAt : receipt.stoppedAt,
          phase: "freeze",
          reason: "reason" in receipt ? receipt.reason : "missing-observation",
          ...("sends" in receipt ? { sends: receipt.sends } : {}),
          evidence:
            "effects" in receipt
              ? {
                  startedAt: receipt.startedAt,
                  frozenAt: receipt.frozenAt,
                  sends: receipt.sends,
                  effects: receipt.effects,
                }
              : receipt.evidence,
          classification: receipt.classification,
        };
        const stop = countLifecycleStopReceiptSchema.parse({
          ...stopCandidate,
          classification: classifyCountLifecycleReceipt(stopCandidate),
        });
        return { receipt: await deps.store.retainReceipt(run.runId, stop) };
      });
    },
  };

  async function closedReceipt(
    run: CountCaptureRun,
    input: z.infer<typeof countCaptureFreezeInputSchema>,
    stopped: boolean,
  ): Promise<CountLifecycleReceipt | CountLifecycleStopReceipt> {
    const frozenAt = run.frozenAt!;
    const attribution = {
      dispatchId: run.host.dispatchId,
      runnerRunId: input.runnerRunId,
      runnerRunAttempt: input.runnerRunAttempt,
      runnerSha: run.host.runnerSha,
      packetHash: run.host.packetHash,
      reviewReceiptHash: run.authority?.review.receiptHash ?? null,
      phases: [
        { phase: "admission" as const, startedAt: run.admittedAt, endedAt: run.admittedAt },
        ...run.windows
          .filter((window) => window.endedAt !== null)
          .map((window) => ({ ...window, endedAt: window.endedAt! })),
        { phase: "freeze" as const, startedAt: frozenAt, endedAt: frozenAt },
      ],
    };
    const sends = run.sends.map((send) => ({
      ...send,
      phase: send.phase as "bootstrap" | "acquisition" | "preview" | "pre-confirm",
      usage: send.usage ? { purpose: send.usage.purpose, unitKey: send.usage.unitKey ?? null } : null,
      outcome: send.status === null ? ("uncertain" as const) : ("response" as const),
    }));
    let effects: CountLifecycleReceipt["effects"] | undefined;
    try {
      if (run.baseline)
        effects = { baseline: run.baseline.effects, final: await deps.readEffects(frozenAt), complete: true };
    } catch {
      /* Unknown is retained as missing evidence. */
    }
    let evidence: CountCaptureEvidence | undefined;
    try {
      if (run.quote) evidence = await deps.readCountEvidence?.(run.quote);
    } catch {
      /* No provider fallback. */
    }
    const base = { attribution, startedAt: run.admittedAt, frozenAt, sends, ...(effects ? { effects } : {}) };
    const preview = run.reads[0];
    const preConfirm = run.reads[1];
    if (
      !run.authority ||
      !run.baseline ||
      !run.quote ||
      !run.acquisition ||
      !run.notice ||
      !run.finalNotice?.readBackAt ||
      !run.approvalAt ||
      !run.quoteUsage ||
      !preview ||
      !preConfirm ||
      !effects ||
      !evidence?.complete ||
      !input.collection ||
      run.request ||
      stopped
    ) {
      const stop = countLifecycleStopReceiptSchema.parse({
        schemaVersion: "scope-sync-count-lifecycle-stop/v1",
        attribution,
        stoppedAt: frozenAt,
        phase: "freeze",
        reason: stopped ? "capture-stopped" : "missing-observation",
        sends,
        evidence: { startedAt: base.startedAt, frozenAt, sends, ...(effects ? { effects } : {}) },
        classification: {
          verdict: "INCOMPLETE",
          reasons: [],
          acceptance: {
            "9431-ac7": { verdict: "INCOMPLETE", reasons: [] },
            "9424-ac5": { verdict: "INCOMPLETE", reasons: [] },
          },
        },
      });
      return { ...stop, classification: classifyCountLifecycleReceipt(stop) };
    }
    const { scopeRecordVersion: _version, ...selection } = run.baseline.selection;
    const quote = run.quote;
    const receipt = countLifecycleReceiptSchema.parse({
      schemaVersion: "scope-sync-count-lifecycle/v1",
      ...base,
      attribution,
      authority: run.authority,
      selection,
      access: {
        originHost: "admin.staging.chasesets.com",
        role: "platform-admin",
        permissions: ["catalog.view", "catalog.manage"],
        ownerMatch: true,
        checkedAt: run.admittedAt,
      },
      units: run.baseline.units.map((unit) => {
        const observed = preview.plan.scopes[0]!.units.find((entry) => entry.unitKey === unit.unitKey)!;
        return { ...unit, estimate: observed.estimate.estimatedRequestCount, blockers: observed.blockers };
      }),
      notices: {
        initial: { at: run.notice.recordedAt, fingerprint: run.notice.fingerprint },
        final: {
          at: run.finalNotice.recordedAt,
          fingerprint: run.finalNotice.fingerprint,
          readBackAt: run.finalNotice.readBackAt,
          readBackFingerprint: run.finalNotice.fingerprint,
        },
        approvalAt: run.approvalAt,
      },
      quote: {
        quoteId: quote.quoteId,
        fingerprint: quote.fingerprint,
        state: run.acquisition.state,
        membershipFingerprint: quote.membershipFingerprint,
        authorityFingerprint: quote.authority.fingerprint,
        expiresAt: quote.expiresAt,
        queries: quote.targets.map((target) => target.query),
        missingKinds: quote.targets.filter((target) => !target.source).map((target) => target.query.kind),
        reusedKinds: quote.targets.filter((target) => target.source).map((target) => target.query.kind),
        plannedCredits: quote.plannedCredits,
        cap: quote.cap,
        perKindBound: 1,
      },
      usage: {
        ...run.quoteUsage,
        bootstrap: run.usage!.state,
        ageMs: Date.parse(run.approvalAt) - Date.parse(run.quoteUsage.observedAt),
        additionalUsageCredits: run.sends.filter((send) => send.phase === "bootstrap").length,
      },
      acquisitions: evidence.acquisitions,
      consumption: run.reads.flatMap((read) =>
        read.winners.map((winner) => {
          const source = winner.source;
          const pages = source ? Math.max(1, Math.ceil(source.totalCount / source.pageSize)) : null;
          return {
            phase: read.phase,
            requestId: read.requestId,
            kind: winner.kind,
            query: winner.query,
            source,
            readAt: winner.readAt,
            ageMs: source ? Date.parse(winner.readAt) - Date.parse(source.observedAt) : null,
            pages,
            estimate:
              read.plan.scopes[0]!.units.find((unit) => unit.unitKey === winner.query.unitKey)?.estimate
                .estimatedRequestCount ?? null,
            planFingerprint: read.planFingerprint,
          };
        }),
      ),
      accounting: {
        possibleSends: {
          bootstrap: sends.filter((send) => send.phase === "bootstrap").length,
          acquisition: sends.filter((send) => send.phase === "acquisition").length,
          preview: sends.filter((send) => send.phase === "preview").length,
          "pre-confirm": sends.filter((send) => send.phase === "pre-confirm").length,
          other: 0,
        },
        total: sends.length,
        debitedCountCredits: evidence.acquisitions.length,
        plannedMaximumCredits:
          quote.plannedCredits +
          countCapturePhaseCaps.preview +
          countCapturePhaseCaps["pre-confirm"] +
          (run.usage!.state === "persisted" ? 1 : 0),
      },
      preConfirm: {
        comparedFingerprint: preConfirm.comparedFingerprint,
        currentFingerprint: preConfirm.planFingerprint,
        eligible: preConfirm.eligible,
        refusal: preConfirm.refusal,
        blockers: preConfirm.plan.blockers.map((blocker) => blocker.code),
        effectsCapability: false,
      },
      effects,
      freezeCollection: input.collection,
      stopReasons: [],
      classification: {
        verdict: "INCOMPLETE",
        reasons: [],
        acceptance: {
          "9431-ac7": { verdict: "INCOMPLETE", reasons: [] },
          "9424-ac5": { verdict: "INCOMPLETE", reasons: [] },
        },
      },
    });
    return { ...receipt, classification: classifyCountLifecycleReceipt(receipt) };
  }
}
