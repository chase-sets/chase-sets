import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { compareGlobalPosition } from "@chase-sets/event-core/storage";
import {
  decodeSellerComplianceCohortPolicyValue,
  sellerComplianceCohortPolicy,
  SellerComplianceCohortPolicyDomainError,
  type SellerComplianceCohortPolicyValue,
} from "../domain/seller-compliance-cohort-policy";
import {
  evaluateSellerComplianceCohort,
  addUtcMonths,
  type CohortPolicySegment,
  type CohortState,
  type DisclosureBand,
} from "../domain/cohort-window";
import {
  listSellerCompletedSalesPage,
  listSellersWithChangedCompletedSales,
  listSellersWithSalesOccurringInWindow,
  readSellerComplianceSnapshotChangeSequence,
  type SellerSaleFact,
} from "../../seller-compliance-sales/read-model/queries";
import {
  readSellerComplianceCohort,
  readSellerComplianceCohortLedgerHead,
  writeSellerComplianceCohort,
} from "../read-model/cohort-store";
import type { PolicyHistoryReader, PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";

export function createSellerComplianceCohortRuntime(
  deps: Readonly<{
    db: PgQueryable;
    pool: PgTransactionalPool;
    policies: Pick<PolicyRuntime, "resolvePolicy">;
    /** Production wiring supplies the immutable, horizon-bounded policy source. */
    policyHistory?: PolicyHistoryReader;
  }>,
) {
  type PolicySnapshot = Readonly<{
    value: SellerComplianceCohortPolicyValue;
    version: string;
    effectiveFrom: string | null;
    recordedAt?: string;
    priorPolicies?: readonly CohortPolicySegment[];
  }>;

  class PolicyHistoryFailure extends Error {
    readonly policyVersion: string | null;
    constructor(message: string, policyVersion: string | null = null) {
      super(message);
      this.name = "PolicyHistoryFailure";
      this.policyVersion = policyVersion;
    }
  }

  function policyVersion(record: PolicyHistoryRecord): string {
    // Keep the historical document@effectiveFrom shape for first creates while
    // making same-document revisions distinct via their stream version.
    return `${record.documentId}@${record.effectiveFrom}${record.streamVersion > 1 ? `#${record.streamVersion}` : ""}`;
  }

  function policyStart(record: PolicyHistoryRecord): string {
    const effective = Date.parse(record.effectiveFrom);
    const recorded = Date.parse(record.recordedAt);
    return new Date(Math.max(effective, recorded)).toISOString();
  }

  async function readPolicyHistory(at: string): Promise<PolicySnapshot | null> {
    if (!deps.policyHistory) return null;
    const started = await deps.policyHistory.start(sellerComplianceCohortPolicy.policyKey);
    const records: PolicyHistoryRecord[] = [];
    let continuation = started.continuation;
    for (;;) {
      const page = await deps.policyHistory.readPage(continuation);
      records.push(...page.records);
      if (page.complete) break;
      if (page.continuation.afterGlobalPosition === continuation.afterGlobalPosition) {
        throw new Error("Policy history reader returned a non-advancing continuation.");
      }
      continuation = page.continuation;
    }

    const atMs = Date.parse(at);
    const byEventId = new Map<string, PolicyHistoryRecord>();
    for (const record of records) {
      const existing = byEventId.get(record.eventId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record))
          throw new PolicyHistoryFailure(
            `Policy history event identity ${record.eventId} has conflicting records.`,
            policyVersion(record),
          );
        continue;
      }
      byEventId.set(record.eventId, record);
    }
    const unique = [...byEventId.values()].sort((a, b) => {
      return compareGlobalPosition(a.globalPosition, b.globalPosition);
    });
    const versions = new Map<string, number[]>();
    for (const record of unique) {
      const list = versions.get(record.documentId) ?? [];
      if (!list.includes(record.streamVersion)) list.push(record.streamVersion);
      versions.set(record.documentId, list);
    }
    for (const [documentId, values] of versions) {
      values.sort((a, b) => a - b);
      for (let index = 0; index < values.length; index += 1)
        if (values[index] !== index + 1)
          throw new PolicyHistoryFailure(
            `Policy history stream gap for ${documentId}.`,
            `${documentId}@unknown#${values[index]}`,
          );
    }
    const latestAt = (instantMs: number) => {
      const latestByDocument = new Map<string, PolicyHistoryRecord>();
      for (const record of unique) {
        if (Date.parse(record.recordedAt) > instantMs) continue;
        const prior = latestByDocument.get(record.documentId);
        if (!prior || compareGlobalPosition(prior.globalPosition, record.globalPosition) < 0)
          latestByDocument.set(record.documentId, record);
      }
      return [...latestByDocument.values()]
        .filter((record) => {
          const start = Date.parse(policyStart(record));
          const end = record.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(record.effectiveUntil);
          return record.status === "active" && start <= instantMs && instantMs < end;
        })
        .sort((a, b) => {
          const effective = Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom);
          if (effective !== 0) return effective;
          const recorded = Date.parse(b.recordedAt) - Date.parse(a.recordedAt);
          if (recorded !== 0) return recorded;
          return b.documentId.localeCompare(a.documentId);
        })[0];
    };
    const breakpoints = new Set<number>([
      ...unique.flatMap((record) => [Date.parse(record.recordedAt), Date.parse(policyStart(record))]),
    ]);
    for (const record of unique) if (record.effectiveUntil !== null) breakpoints.add(Date.parse(record.effectiveUntil));
    const segments: CohortPolicySegment[] = [...breakpoints]
      .filter((value) => Number.isFinite(value) && value <= atMs)
      .sort((a, b) => a - b)
      .map((value) => {
        const selected = latestAt(value);
        if (!selected) return { effectiveFrom: new Date(value).toISOString(), policy: null };
        try {
          return {
            effectiveFrom: new Date(value).toISOString(),
            policy: decodeSellerComplianceCohortPolicyValue(selected.value),
          };
        } catch (error) {
          throw new PolicyHistoryFailure(
            error instanceof Error ? error.message : String(error),
            policyVersion(selected),
          );
        }
      });
    const selected = latestAt(atMs);
    if (!selected) return null;
    let selectedValue: SellerComplianceCohortPolicyValue;
    try {
      selectedValue = decodeSellerComplianceCohortPolicyValue(selected.value);
    } catch (error) {
      throw new PolicyHistoryFailure(error instanceof Error ? error.message : String(error), policyVersion(selected));
    }
    const selectedStart = policyStart(selected);
    const priorPolicies = segments.filter((segment) => Date.parse(segment.effectiveFrom) < Date.parse(selectedStart));
    return {
      value: selectedValue,
      version: policyVersion(selected),
      effectiveFrom: selectedStart,
      recordedAt: selected.recordedAt,
      priorPolicies,
    };
  }

  async function loadSales(
    sellerAccountId: string,
    fromInclusive: string,
    toExclusive: string,
  ): Promise<readonly SellerSaleFact[]> {
    const sales: SellerSaleFact[] = [];
    let cursor = null;
    do {
      const page = await listSellerCompletedSalesPage(deps.db, {
        sellerAccountId,
        fromInclusive,
        toExclusive,
        cursor,
        limit: 100,
      });
      sales.push(...page.sales);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return sales;
  }
  async function recordFailure(
    sellerAccountId: string,
    evaluationAt: string,
    detail: string,
    policyVersion: string | null,
    kind = "policy-resolution",
  ) {
    await deps.db.query(
      `INSERT INTO platform_operations_seller_compliance_evaluation_failures (seller_account_id,evaluation_at,failure_kind,detail,policy_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [sellerAccountId, evaluationAt, kind, detail, policyVersion],
    );
  }
  /** Retains each activated policy version's content, so a later revision can still judge the time before it. */
  async function retainPolicyEvidence(
    version: string,
    effectiveFrom: string | null | undefined,
    value: SellerComplianceCohortPolicyValue,
  ) {
    if (!effectiveFrom) return;
    await deps.db.query(
      `INSERT INTO platform_operations_seller_compliance_policy_evidence (policy_version,effective_from,value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (policy_version) DO NOTHING`,
      [version, effectiveFrom, JSON.stringify(value)],
    );
  }
  async function loadPriorPolicies(
    revisionEffectiveAt: string,
    stampedVersion: string,
  ): Promise<CohortPolicySegment[]> {
    const result = await deps.db.query<{ policy_version: string; effective_from: Date | string; value: unknown }>(
      `SELECT policy_version, effective_from, value FROM platform_operations_seller_compliance_policy_evidence WHERE effective_from < $1 ORDER BY effective_from ASC, policy_version ASC`,
      [revisionEffectiveAt],
    );
    if (!result.rows.some((row) => row.policy_version === stampedVersion))
      throw new Error(
        `Policy ${stampedVersion} produced the seller's cohort state but its content was not retained, so a change before ${revisionEffectiveAt} cannot be dated.`,
      );
    return result.rows.map((row) => ({
      effectiveFrom: new Date(row.effective_from).toISOString(),
      policy: decodeSellerComplianceCohortPolicyValue(row.value as never),
    }));
  }
  async function evaluateSeller(
    sellerAccountId: string,
    evaluationAt: string,
    resolved?: Readonly<{
      value: SellerComplianceCohortPolicyValue;
      version: string;
      priorPolicies?: readonly CohortPolicySegment[];
    }>,
    revisionEffectiveAt?: string,
  ): Promise<boolean> {
    let current = resolved;
    let revisionAt = revisionEffectiveAt;
    if (!current) {
      let value;
      try {
        value = await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: evaluationAt });
      } catch (error) {
        await recordFailure(
          sellerAccountId,
          evaluationAt,
          error instanceof Error ? error.message : String(error),
          error instanceof PolicyHistoryFailure ? error.policyVersion : null,
        );
        return false;
      }
      current = {
        value: value.value,
        version: value.documentId ? `${value.documentId}@${value.effectiveFrom ?? "unknown"}` : "fallback",
      };
      revisionAt ??= value.effectiveFrom ?? undefined;
      if (value.value.activated) await retainPolicyEvidence(current.version, value.effectiveFrom, value.value);
    }
    if (!current.value.activated) return false;
    const { value: policy, version: policyVersion } = current;
    const row = await readSellerComplianceCohort(deps.db, sellerAccountId);
    // A seller whose cohort row was lost resumes from its retained ledger, never from a blank history.
    const head = row ? null : await readSellerComplianceCohortLedgerHead(deps.db, sellerAccountId);
    // Restoring before the ledger's latest observation would rewrite later history; a later tick restores the row.
    if (head && Date.parse(evaluationAt) < Date.parse(head.observedAt)) return false;
    const base = row ?? head;
    const lookbackMonths = policy.lookbackMonths ?? 60;
    const verdictFloor = addUtcMonths(evaluationAt, -lookbackMonths);
    const verdictSales = await loadSales(sellerAccountId, verdictFloor, evaluationAt);
    const verdict = evaluateSellerComplianceCohort({ sales: verdictSales, policy, evaluationAt });
    if (!base) {
      if (verdict.state === "outside") return false;
      await writeSellerComplianceCohort(deps.pool, {
        sellerAccountId,
        policyVersion,
        observedAt: evaluationAt,
        evaluation: verdict,
        expectedVersion: "0",
      });
      return true;
    }
    const previous = {
      state: base.state as CohortState,
      band: base.band as DisclosureBand,
      entryEffectiveAt: base.entryEffectiveAt,
      exitEffectiveAt: base.exitEffectiveAt,
    };
    const transitioned =
      verdict.state !== previous.state || (verdict.state === "member" && verdict.band !== previous.band);
    let evaluation;
    if (transitioned) {
      // A transition is dated after the latest recorded one, which can lie before this tick's lookback floor and under
      // an earlier policy, so the older sales and that policy's retained content are loaded.
      const ledgerHead = head ?? (await readSellerComplianceCohortLedgerHead(deps.db, sellerAccountId));
      const since = ledgerHead !== null && ledgerHead.version === base.version ? ledgerHead.effectiveAt : null;
      const lower = since ?? (previous.state === "member" ? previous.entryEffectiveAt : previous.exitEffectiveAt);
      const revised = base.policyVersion !== policyVersion ? revisionAt : undefined;
      const priorPolicies =
        current?.priorPolicies ??
        (!deps.policyHistory && revised !== undefined && lower !== null && Date.parse(lower) + 1 < Date.parse(revised)
          ? await loadPriorPolicies(revised, base.policyVersion)
          : []);
      const maxLookback = Math.max(
        lookbackMonths,
        ...priorPolicies.flatMap((prior) => (prior.policy ? [prior.policy.lookbackMonths ?? 60] : [])),
      );
      const floor = lower === null ? verdictFloor : addUtcMonths(lower, -maxLookback);
      evaluation = evaluateSellerComplianceCohort({
        sales:
          Date.parse(floor) < Date.parse(verdictFloor)
            ? await loadSales(sellerAccountId, floor, evaluationAt)
            : verdictSales,
        policy,
        evaluationAt,
        previous: { ...previous, transitionEffectiveAt: since },
        revisionEffectiveAt: revised,
        priorPolicies,
      });
    } else {
      evaluation = evaluateSellerComplianceCohort({ sales: verdictSales, policy, evaluationAt, previous });
    }
    await writeSellerComplianceCohort(deps.pool, {
      sellerAccountId,
      policyVersion,
      observedAt: evaluationAt,
      evaluation,
      expectedVersion: base.version,
    });
    return true;
  }
  type Trigger = "t1-changed" | "t2-due" | "t3-revision" | "t3-occurrence" | "recovery" | "failure";
  type Candidate = Readonly<{ sellerAccountId: string; trigger: Trigger; revisionOnly?: boolean }>;
  let failureAfterSellerAccountId: string | null = null;

  async function checkpoint(trigger: Trigger) {
    const result = await deps.db.query<{
      snapshot_change_sequence: string;
      after_seller_account_id: string | null;
      policy_version: string;
      pass_started_at: Date | string;
    }>(
      `SELECT snapshot_change_sequence::text, after_seller_account_id, policy_version, pass_started_at FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
      [trigger],
    );
    const row = result.rows[0];
    if (!row) return null;
    const passStartedAt = row.pass_started_at;
    return { ...row, pass_started_at: typeof passStartedAt === "string" ? passStartedAt : passStartedAt.toISOString() };
  }

  async function writeCheckpoint(
    trigger: Trigger,
    page: Readonly<{ snapshot: string; afterSellerAccountId: string | null; passStartedAt: string }>,
    policyVersion: string,
    now: string,
  ) {
    await deps.db.query(
      `INSERT INTO platform_operations_seller_compliance_sweep_checkpoints (trigger_name,snapshot_change_sequence,after_seller_account_id,policy_version,pass_started_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (trigger_name) DO UPDATE SET snapshot_change_sequence=$2, after_seller_account_id=$3, policy_version=$4, pass_started_at=$5, updated_at=$6`,
      [trigger, page.snapshot, page.afterSellerAccountId, policyVersion, page.passStartedAt, now],
    );
  }

  async function candidateSellers(
    now: string,
    limit: number,
    snapshot: string,
    policy: SellerComplianceCohortPolicyValue,
    policyVersion: string,
    trigger: Trigger,
  ): Promise<{
    candidates: Candidate[];
    snapshot: string;
    afterSellerAccountId: string | null;
    passStartedAt: string;
    full: boolean;
  }> {
    const saved = await checkpoint(trigger);
    const completed =
      saved !== null && saved.after_seller_account_id === null && saved.policy_version === policyVersion;
    const resume =
      saved !== null &&
      !(
        saved.after_seller_account_id === null &&
        (saved.policy_version !== policyVersion || saved.snapshot_change_sequence !== snapshot)
      );
    const passSnapshot = resume ? saved!.snapshot_change_sequence : snapshot;
    const after = resume ? saved!.after_seller_account_id : null;
    const passStartedAt = resume ? saved!.pass_started_at : now;
    // A resumed pass keeps the recording-time window it started with, so no change ages out before the cursor reaches it.
    if (trigger === "t1-changed") {
      const lowerBound = saved?.after_seller_account_id === null ? saved.snapshot_change_sequence : "0";
      const changed = await deps.db.query<{ seller_account_id: string }>(
        `SELECT DISTINCT seller_account_id
         FROM platform_operations_seller_compliance_sales
         WHERE recorded_at IS NOT NULL AND seller_account_id IS NOT NULL
           AND change_sequence > $1::bigint AND change_sequence <= $2::bigint
           AND ($3::text IS NULL OR seller_account_id > $3::text)
         ORDER BY seller_account_id ASC LIMIT $4`,
        [lowerBound, passSnapshot, after, limit],
      );
      const ids = changed.rows
        .map((row) => row.seller_account_id)
        .sort()
        .slice(0, limit);
      return {
        candidates: ids.map((sellerAccountId) => ({ sellerAccountId, trigger })),
        snapshot: passSnapshot,
        passStartedAt,
        afterSellerAccountId: ids.at(-1) ?? null,
        // Two short source pages can still fill the budget together; the union's cut-off is where the pass resumes.
        full: ids.length === limit,
      };
    }
    if (trigger === "t2-due") {
      const due = await deps.db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE next_reevaluation_at <= $1 AND ($2::text IS NULL OR seller_account_id > $2::text) ORDER BY seller_account_id ASC LIMIT $3`,
        [now, after, limit],
      );
      return {
        candidates: due.rows.map((row) => ({ sellerAccountId: row.seller_account_id, trigger })),
        snapshot: passSnapshot,
        passStartedAt,
        afterSellerAccountId: due.rows.at(-1)?.seller_account_id ?? null,
        full: due.rows.length === limit,
      };
    }
    if (trigger === "t3-revision") {
      // A completed pass stays complete: a non-material revision leaves rows byte-identical, stamp included.
      if (completed) {
        return {
          candidates: [],
          snapshot: saved!.snapshot_change_sequence,
          afterSellerAccountId: null,
          passStartedAt: saved!.pass_started_at,
          full: false,
        };
      }
      const revision = await deps.db.query<{ seller_account_id: string }>(
        `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE policy_version <> $1 AND ($2::text IS NULL OR seller_account_id > $2::text) ORDER BY seller_account_id ASC LIMIT $3`,
        [policyVersion, after, limit],
      );
      const rawIds = revision.rows.map((row) => row.seller_account_id);
      return {
        candidates: rawIds.map((sellerAccountId) => ({ sellerAccountId, trigger, revisionOnly: true })),
        snapshot: passSnapshot,
        passStartedAt,
        afterSellerAccountId: rawIds.at(-1) ?? null,
        full: rawIds.length === limit,
      };
    }
    if (trigger === "t3-occurrence") {
      if (completed && saved!.snapshot_change_sequence === snapshot) {
        return {
          candidates: [],
          snapshot: saved!.snapshot_change_sequence,
          afterSellerAccountId: null,
          passStartedAt,
          full: false,
        };
      }
      const occurrence = await listSellersWithSalesOccurringInWindow(deps.db, {
        fromInclusive: addUtcMonths(now, -(policy.lookbackMonths ?? 60)),
        toExclusive: now,
        snapshotChangeSequence: passSnapshot,
        afterSellerAccountId: after,
        limit,
      });
      const rawIds = occurrence.sellerAccountIds;
      const ids = new Set<string>();
      if (rawIds.length > 0) {
        // Discovery only: a seller with a row is reached by its changes, due instant or a revision pass.
        const existing = await deps.db.query<{ seller_account_id: string }>(
          `SELECT seller_account_id FROM platform_operations_seller_compliance_cohorts WHERE seller_account_id = ANY($1::text[])`,
          [rawIds],
        );
        const withRows = new Set(existing.rows.map((row) => row.seller_account_id));
        rawIds.forEach((id) => {
          if (!withRows.has(id)) ids.add(id);
        });
      }
      return {
        candidates: [...ids].map((sellerAccountId) => ({ sellerAccountId, trigger })),
        snapshot: passSnapshot,
        passStartedAt,
        afterSellerAccountId: rawIds.at(-1) ?? null,
        full: rawIds.length === limit,
      };
    }
    if (trigger === "recovery") {
      // Sellers whose cohort row was lost while their ledger was kept, restored from that ledger in bounded pages.
      const lost = await deps.db.query<{ seller_account_id: string }>(
        `SELECT DISTINCT transitions.seller_account_id FROM platform_operations_seller_compliance_cohort_transitions AS transitions WHERE ($1::text IS NULL OR transitions.seller_account_id > $1::text) AND NOT EXISTS (SELECT 1 FROM platform_operations_seller_compliance_cohorts AS cohorts WHERE cohorts.seller_account_id = transitions.seller_account_id) ORDER BY transitions.seller_account_id ASC LIMIT $2`,
        [after, limit],
      );
      const rawIds = lost.rows.map((row) => row.seller_account_id);
      return {
        candidates: rawIds.map((sellerAccountId) => ({ sellerAccountId, trigger })),
        snapshot: passSnapshot,
        passStartedAt,
        afterSellerAccountId: rawIds.at(-1) ?? null,
        full: rawIds.length === limit,
      };
    }
    throw new Error(`Unsupported candidate trigger ${trigger}`);
  }

  async function failureCandidates(
    now: string,
    limit: number,
    snapshot: string,
  ): Promise<{ candidates: Candidate[]; snapshot: string; passStartedAt: string; full: boolean }> {
    const saved = await checkpoint("failure");
    const passSnapshot = saved?.snapshot_change_sequence ?? snapshot;
    const after = saved?.after_seller_account_id ?? failureAfterSellerAccountId;
    const existing = await deps.db.query<{ seller_account_id: string }>(
      `SELECT seller_account_id
       FROM platform_operations_seller_compliance_cohorts
       WHERE ($1::text IS NULL OR seller_account_id > $1::text)
       ORDER BY seller_account_id ASC
       LIMIT $2`,
      [after, limit],
    );
    const changed = await listSellersWithChangedCompletedSales(deps.db, {
      fromInclusive: new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString(),
      toExclusive: now,
      snapshotChangeSequence: passSnapshot,
      afterSellerAccountId: after,
      limit,
    });
    const ids = [...new Set([...existing.rows.map((row) => row.seller_account_id), ...changed.sellerAccountIds])]
      .sort()
      .slice(0, limit);
    return {
      candidates: ids.map((sellerAccountId) => ({ sellerAccountId, trigger: "failure" })),
      snapshot: passSnapshot,
      passStartedAt: saved?.pass_started_at ?? now,
      full: existing.rows.length === limit || changed.sellerAccountIds.length === limit || ids.length === limit,
    };
  }
  async function sweep(params: Readonly<{ now?: string; limit?: number }> = {}): Promise<number> {
    const now = params.now ?? new Date().toISOString();
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
    let resolved;
    try {
      const historyValue = await readPolicyHistory(now);
      if (deps.policyHistory) {
        resolved = historyValue;
      } else {
        const value = await deps.policies.resolvePolicy(sellerComplianceCohortPolicy, { at: now });
        resolved = {
          value: value.value,
          version: value.documentId ? `${value.documentId}@${value.effectiveFrom ?? "unknown"}` : "fallback",
          effectiveFrom: value.effectiveFrom,
        };
      }
    } catch (error) {
      const snapshot = await readSellerComplianceSnapshotChangeSequence(deps.db);
      const page = await failureCandidates(now, limit, snapshot);
      const kind = error instanceof SellerComplianceCohortPolicyDomainError ? "policy-decode" : "policy-resolution";
      for (const candidate of page.candidates)
        await recordFailure(
          candidate.sellerAccountId,
          now,
          error instanceof Error ? error.message : String(error),
          error instanceof PolicyHistoryFailure ? error.policyVersion : null,
          kind,
        );
      if (page.full && page.candidates.length > 0) {
        failureAfterSellerAccountId = page.candidates[page.candidates.length - 1]!.sellerAccountId;
        await writeCheckpoint(
          "failure",
          { ...page, afterSellerAccountId: failureAfterSellerAccountId },
          "failure",
          now,
        );
      } else {
        failureAfterSellerAccountId = null;
        await deps.db.query(
          `DELETE FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
          ["failure"],
        );
      }
      return page.candidates.length;
    }
    if (!resolved || !resolved.value.activated) return 0;
    // Immutable history is authoritative in production; the evidence table is
    // retained only for the resolver fallback and is never used to reconstruct
    // policy timelines on the history path.
    if (!deps.policyHistory) await retainPolicyEvidence(resolved.version, resolved.effectiveFrom, resolved.value);
    const snapshot = await readSellerComplianceSnapshotChangeSequence(deps.db);
    let processed = 0;
    const evaluated = new Set<string>();
    for (const trigger of ["t1-changed", "t2-due", "t3-revision", "t3-occurrence", "recovery"] as const) {
      const page = await candidateSellers(now, limit - processed, snapshot, resolved.value, resolved.version, trigger);
      for (const candidate of page.candidates) {
        if (evaluated.has(candidate.sellerAccountId)) continue;
        try {
          await evaluateSeller(
            candidate.sellerAccountId,
            now,
            { value: resolved.value, version: resolved.version, priorPolicies: resolved.priorPolicies },
            resolved.effectiveFrom ?? undefined,
          );
        } catch (error) {
          await recordFailure(
            candidate.sellerAccountId,
            now,
            error instanceof Error ? error.message : String(error),
            resolved.version,
            "evaluation",
          );
        }
        evaluated.add(candidate.sellerAccountId);
        processed += 1;
      }
      if (page.full && (page.candidates.length > 0 || trigger === "t3-revision" || trigger === "t3-occurrence")) {
        await writeCheckpoint(trigger, page, resolved.version, now);
      } else if (trigger === "t3-revision" || trigger === "t3-occurrence") {
        await writeCheckpoint(trigger, { ...page, afterSellerAccountId: null }, resolved.version, now);
      } else if (trigger === "t1-changed") {
        await writeCheckpoint(trigger, { ...page, afterSellerAccountId: null }, resolved.version, now);
      } else {
        await deps.db.query(
          `DELETE FROM platform_operations_seller_compliance_sweep_checkpoints WHERE trigger_name = $1`,
          [trigger],
        );
      }
      if (processed >= limit) break;
    }
    return processed;
  }
  return { evaluateSeller, sweep };
}
