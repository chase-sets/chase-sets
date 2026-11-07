import { isDeepStrictEqual } from "node:util";
import { compareGlobalPosition, parseGlobalPosition, type GlobalPosition } from "@chase-sets/event-core/storage";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PolicyHistoryReader, PolicyHistoryRecord } from "@chase-sets/platform-policy/policy-history-reader";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { evaluateSellerComplianceCohort, type CohortPolicyIdentity, type CohortPolicySegment } from "../domain/cohort-window";
import { decodeSellerComplianceCohortPolicyValue, SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE, sellerComplianceCohortPolicy } from "../domain/seller-compliance-cohort-policy";
import { readSellerComplianceCohort, readSellerComplianceCohortLedgerHead, writeSellerComplianceCohort } from "../read-model/cohort-store";
import { listCohortChangedSellers, readCohortSweepCheckpoint, recordCohortEvaluationFailure, writeCohortSweepCheckpoint } from "../read-model/cohort-queries";
import { addUtcMonths, listSellerCompletedSalesPage, readSellerCompletedSalesSnapshotToken, readSellerComplianceSnapshotChangeSequence, snapshotTokensMatch, type SellerSaleFact } from "../../seller-compliance-sales/read-model/queries";

class CohortReplayError extends Error {
  constructor(public readonly kind: string, public readonly policyVersion: string | null, message: string) {
    super(message);
  }
}

function identity(record: PolicyHistoryRecord): CohortPolicyIdentity {
  const { policyKey, documentId, eventId, streamVersion } = record;
  return { policyKey, documentId, eventId, streamVersion };
}

function identityMatches(record: PolicyHistoryRecord, stored: unknown): boolean {
  return isDeepStrictEqual(identity(record), stored);
}

async function readCompleteHistory(reader: PolicyHistoryReader, tick: string, fixedHorizon?: GlobalPosition) {
  const start = fixedHorizon === undefined ? await reader.start(sellerComplianceCohortPolicy.policyKey) : null;
  const horizon = parseGlobalPosition(fixedHorizon ?? start!.horizon);
  let cursor = { policyKey: sellerComplianceCohortPolicy.policyKey, horizon, afterGlobalPosition: "0" as GlobalPosition };
  const records: PolicyHistoryRecord[] = [];
  const events = new Map<string, PolicyHistoryRecord>();
  const streams = new Map<string, PolicyHistoryRecord>();
  let previousPosition = "0" as GlobalPosition;
  for (;;) {
    const page = await reader.readPage(cursor);
    const next = page.continuation;
    if (page.horizon !== horizon || next.horizon !== horizon || next.policyKey !== cursor.policyKey ||
      compareGlobalPosition(parseGlobalPosition(next.afterGlobalPosition), horizon) > 0 ||
      compareGlobalPosition(next.afterGlobalPosition, cursor.afterGlobalPosition) < 0 ||
      (!page.complete && compareGlobalPosition(next.afterGlobalPosition, cursor.afterGlobalPosition) === 0))
      throw new Error("Policy history page did not preserve its fixed complete horizon.");
    for (const record of page.records) {
      const duplicate = events.get(record.eventId);
      if (duplicate !== undefined) {
        if (!isDeepStrictEqual(duplicate, record)) throw new Error("Policy history eventId has conflicting identity or content.");
        continue;
      }
      const position = parseGlobalPosition(record.globalPosition);
      const previous = streams.get(record.documentId);
      if (!record.eventId || !record.documentId || record.policyKey !== sellerComplianceCohortPolicy.policyKey ||
        !Number.isSafeInteger(record.streamVersion) || record.streamVersion !== (previous?.streamVersion ?? 0) + 1 ||
        record.eventType !== (previous ? "platform-policy.document.revised" : "platform-policy.document.created") ||
        compareGlobalPosition(position, previousPosition) <= 0 || compareGlobalPosition(position, cursor.afterGlobalPosition) <= 0 ||
        compareGlobalPosition(position, next.afterGlobalPosition) > 0 || compareGlobalPosition(position, horizon) > 0 ||
        (record.status !== "active" && record.status !== "inactive"))
        throw new Error("Policy history has an invalid document identity, stream gap or global order.");
      parseIsoUtcTimestamp(record.recordedAt);
      parseIsoUtcTimestamp(record.effectiveFrom);
      if (record.effectiveUntil !== null) parseIsoUtcTimestamp(record.effectiveUntil);
      events.set(record.eventId, record);
      streams.set(record.documentId, record);
      previousPosition = position;
      if (record.recordedAt <= tick) records.push(record);
    }
    if (page.complete) return { records, horizon };
    cursor = next;
  }
}

function startsAt(record: PolicyHistoryRecord, firstActivation?: string): string {
  // First activation admits the approved history. Revisions are prospective authority.
  return record.eventId === firstActivation ? record.effectiveFrom : [record.recordedAt, record.effectiveFrom].sort().at(-1)!;
}

function selectCohortPolicyHistory(records: readonly PolicyHistoryRecord[], tick: string, storedVersion?: string) {
  if (storedVersion !== undefined) {
    let stored: unknown;
    try { stored = JSON.parse(storedVersion); } catch { stored = null; }
    if (!records.some((record) => identityMatches(record, stored)))
      throw new CohortReplayError("missing-prior-policy", storedVersion, "Stored policy identity is absent from complete history.");
  }
  const batches = new Map<string, PolicyHistoryRecord>();
  for (const record of records) batches.set(`${record.documentId}\0${record.recordedAt}`, record);
  const selectionRecords = [...batches.values()].sort((a, b) => compareGlobalPosition(a.globalPosition, b.globalPosition));
  const firstActivation = selectionRecords.find((record) => record.status === "active" &&
    !(typeof record.value === "object" && record.value !== null && "activated" in record.value && record.value.activated === false))?.eventId;
  const boundaries = [...new Set(selectionRecords.flatMap((record) => [startsAt(record, firstActivation), ...(record.effectiveUntil === null ? [] : [record.effectiveUntil])]))]
    .filter((at) => at <= tick).sort();
  const selectedAt = (at: string): PolicyHistoryRecord | null => {
    const documents = new Map<string, PolicyHistoryRecord>();
    for (const record of selectionRecords) if (startsAt(record, firstActivation) <= at) documents.set(record.documentId, record);
    return [...documents.values()]
      .filter((record) => record.status === "active" && record.effectiveFrom <= at && (record.effectiveUntil === null || at < record.effectiveUntil))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.recordedAt.localeCompare(a.recordedAt) || b.documentId.localeCompare(a.documentId))[0] ?? null;
  };
  const timeline: { effectiveFrom: string; record: PolicyHistoryRecord | null }[] = [];
  for (const at of boundaries) {
    const record = selectedAt(at);
    if (timeline.length === 0 || timeline.at(-1)!.record?.eventId !== record?.eventId) timeline.push({ effectiveFrom: at, record });
  }
  const selected = selectedAt(tick);
  const decode = (record: PolicyHistoryRecord | null) => {
    if (record === null) return null;
    try { return decodeSellerComplianceCohortPolicyValue(record.value); }
    catch { throw new CohortReplayError("policy-decode", JSON.stringify(identity(record)), "Selected policy history value failed cohort policy decoding."); }
  };
  // Retain raw selected/prior identity before any decode can fail.
  const value = decode(selected) ?? SELLER_COMPLIANCE_COHORT_POLICY_DEFAULT_VALUE;
  const priorPolicies: CohortPolicySegment[] = timeline.slice(0, -1).map((segment) => ({ effectiveFrom: segment.effectiveFrom, policy: decode(segment.record) }));
  const revisionEffectiveAt = timeline.at(-1)?.effectiveFrom;
  return { selected, value, priorPolicies, revisionEffectiveAt };
}

export function createCohortEvaluationRuntime(deps: Readonly<{ pool: PgTransactionalPool; historyReader: PolicyHistoryReader }>) {
  const { pool, historyReader } = deps;
  async function evaluate(sellerAccountId: string, tick: string, history: readonly PolicyHistoryRecord[]): Promise<boolean> {
    let policyVersion: string | null = null;
    try {
      const current = await readSellerComplianceCohort(pool, sellerAccountId);
      const ledger = await readSellerComplianceCohortLedgerHead(pool, sellerAccountId);
      const previous = current ?? ledger;
      const selection = selectCohortPolicyHistory(history, tick, previous?.policyVersion);
      if (selection.selected === null || !selection.value.activated) return true;
      policyVersion = JSON.stringify(identity(selection.selected));
      const lookback = Math.max(selection.value.lookbackMonths ?? 0, ...selection.priorPolicies.map((segment) => segment.policy?.lookbackMonths ?? 0));
      // A retained transition can predate today's lookback: transition walks need its complete causal suffix too.
      const fromInclusive = [addUtcMonths(tick, -lookback), ledger?.effectiveAt ?? current?.entryEffectiveAt ?? tick].sort()[0]!;
      const window = { sellerAccountId, fromInclusive, toExclusive: new Date(Date.parse(tick) + 1).toISOString() };
      const before = await readSellerCompletedSalesSnapshotToken(pool, window);
      const sales: SellerSaleFact[] = [];
      let cursor: Parameters<typeof listSellerCompletedSalesPage>[1]["cursor"] = null;
      do {
        const page = await listSellerCompletedSalesPage(pool, { ...window, cursor, limit: 100 });
        sales.push(...page.sales);
        if (page.nextCursor !== null && isDeepStrictEqual(page.nextCursor, cursor)) throw new CohortReplayError("sales-snapshot", policyVersion, "Seller sales cursor did not advance.");
        cursor = page.nextCursor;
      } while (cursor !== null);
      const after = await readSellerCompletedSalesSnapshotToken(pool, window);
      if (!snapshotTokensMatch(before, after)) throw new CohortReplayError("sales-snapshot", policyVersion, "Seller sales changed during evaluation.");
      const previousIdentity = previous ? history.find((record) => {
        try { return identityMatches(record, JSON.parse(previous.policyVersion)); } catch { return false; }
      }) : undefined;
      const evaluation = evaluateSellerComplianceCohort({
        sales, policy: selection.value, evaluationAt: tick, observedAt: tick,
        policyIdentity: identity(selection.selected),
        ...(previous ? { previous: { state: previous.state, band: previous.band, entryEffectiveAt: previous.entryEffectiveAt,
          exitEffectiveAt: previous.exitEffectiveAt, transitionEffectiveAt: ledger?.effectiveAt,
          policyIdentity: previousIdentity ? identity(previousIdentity) : null } } : {}),
        ...(selection.revisionEffectiveAt === undefined ? {} : { revisionEffectiveAt: selection.revisionEffectiveAt }),
        priorPolicies: selection.priorPolicies,
      });
      await writeSellerComplianceCohort(pool, { sellerAccountId, expectedVersion: previous?.version ?? "0", evaluation,
        policy: { status: selection.selected.status, value: selection.value } });
      return true;
    } catch (error) {
      await recordCohortEvaluationFailure(pool, { sellerAccountId, evaluationAt: tick,
        failureKind: error instanceof CohortReplayError ? error.kind : "evaluation",
        policyVersion: error instanceof CohortReplayError ? error.policyVersion : policyVersion,
        detail: error instanceof CohortReplayError ? error.message : "Seller compliance evaluation failed." });
      return false;
    }
  }

  async function evaluateSeller(input: Readonly<{ sellerAccountId: string; tick: string }>): Promise<boolean> {
    if (typeof input.sellerAccountId !== "string" || !input.sellerAccountId.trim()) throw new Error("Seller account identity is required.");
    const tick = new Date(parseIsoUtcTimestamp(input.tick)).toISOString();
    let history;
    try { history = await readCompleteHistory(historyReader, tick); }
    catch {
      await recordCohortEvaluationFailure(pool, { sellerAccountId: input.sellerAccountId, evaluationAt: tick,
        failureKind: "policy-history", policyVersion: null, detail: "Policy history is incomplete or malformed." });
      return false;
    }
    return evaluate(input.sellerAccountId, tick, history.records);
  }

  async function runTick(input: Readonly<{ tick?: string; limit?: number }> = {}) {
    const tick = new Date(parseIsoUtcTimestamp(input.tick ?? new Date().toISOString())).toISOString();
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Cohort tick limit must be between 1 and 100.");
    return withPgTransaction(pool, async (db) => {
      let checkpoint = await readCohortSweepCheckpoint(db);
      let history;
      try { history = await readCompleteHistory(historyReader, tick, checkpoint.currentPolicyHorizon === null ? undefined : parseGlobalPosition(checkpoint.currentPolicyHorizon)); }
      catch { throw new Error("Seller compliance sweep requires complete policy history; checkpoint was not advanced."); }
      if (checkpoint.currentSnapshot === null) {
        checkpoint = await writeCohortSweepCheckpoint(db, checkpoint, { ...checkpoint,
          currentSnapshot: await readSellerComplianceSnapshotChangeSequence(db),
          currentPolicyHorizon: history.horizon, evaluationAt: tick, rawPageCursor: null, sellerCursor: null });
      }
      const sellers = await listCohortChangedSellers(db, {
        lastCompletedSnapshot: checkpoint.lastCompletedSnapshot, currentSnapshot: checkpoint.currentSnapshot!,
        afterSellerAccountId: checkpoint.sellerCursor, evaluationAt: tick,
        policyChanged: checkpoint.policyHorizon !== history.horizon || history.records.some((record) =>
          [startsAt(record), record.effectiveUntil].some((at) => at !== null && at <= tick && (checkpoint.lastEvaluationAt === null || at > checkpoint.lastEvaluationAt))), limit,
      });
      const rawPageCursor = sellers.at(-1) ?? checkpoint.rawPageCursor;
      checkpoint = await writeCohortSweepCheckpoint(db, checkpoint, { ...checkpoint, rawPageCursor });
      let failed = 0;
      for (const seller of sellers) {
        if (!await evaluate(seller, tick, history.records)) failed++;
        checkpoint = await writeCohortSweepCheckpoint(db, checkpoint, { ...checkpoint, sellerCursor: seller });
      }
      if (sellers.length < limit) {
        await writeCohortSweepCheckpoint(db, checkpoint, { ...checkpoint,
          lastCompletedSnapshot: checkpoint.currentSnapshot!, currentSnapshot: null,
          policyHorizon: checkpoint.currentPolicyHorizon!, currentPolicyHorizon: null, lastEvaluationAt: checkpoint.evaluationAt, evaluationAt: null });
      }
      return { processed: sellers.length, failed };
    });
  }
  return { evaluateSeller, runTick };
}
