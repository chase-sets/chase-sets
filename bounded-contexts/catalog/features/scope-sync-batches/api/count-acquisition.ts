import { randomUUID } from "node:crypto";
import {
  CountAcquisitionRefused,
  countFingerprint,
  countQueryKey,
  countSourceIsCurrent,
  type CountAdmission,
  type CountAuthority,
  type CountQuote,
  type CountTarget,
  type ScrydexCountEvidence,
  type ScrydexCountQuery,
} from "../domain/count-acquisition";

export type CountAcquisitionLedger = Readonly<{
  authority(): Promise<CountAuthority>;
  saveQuote(quote: CountQuote, owner: string): Promise<void>;
  loadQuote(quoteId: string, owner: string): Promise<CountQuote>;
  /** Holds the quote's whole P under the headroom lock and returns its single execution id. */
  admit(quote: CountQuote, owner: string, authority: CountAuthority): Promise<string>;
  approve(quoteId: string, fingerprint: string, owner: string): Promise<CountQuote>;
  claim(
    quote: CountQuote,
    target: CountTarget,
    owner: string,
    authority: CountAuthority,
    executionId?: string,
  ): Promise<string | null>;
  result(
    debitId: string,
    quoteId: string,
    query: ScrydexCountQuery,
    outcome: "complete" | "failed" | "uncertain",
    evidence: ScrydexCountEvidence | null,
  ): Promise<void>;
  end(quoteId: string, executionId: string, owner: string, state: "complete" | "failed" | "uncertain"): Promise<void>;
}>;
export function createCountAcquisition(deps: {
  ledger: CountAcquisitionLedger;
  resolve(selection: unknown): Promise<{ membershipFingerprint: string; targets: readonly CountTarget[] }>;
  send(
    query: ScrydexCountQuery,
  ): Promise<{ totalCount: number; pageSize: number; returnedPage: 1; returnedItemCount: number; observedAt: string }>;
  allowed(): boolean;
  now?: () => string;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  async function quote(input: { selection: unknown; cap?: number; owner: string }): Promise<CountQuote> {
    const resolved = await deps.resolve(input.selection);
    const authority = await deps.ledger.authority();
    const plannedCredits = resolved.targets.filter((target) => !target.source).length;
    if (input.cap !== undefined && (!Number.isSafeInteger(input.cap) || input.cap < 0 || input.cap > 10_000))
      throw new CountAcquisitionRefused();
    const cap = Math.min(input.cap ?? plannedCredits, plannedCredits, authority.headroom ?? 0);
    const value = {
      quoteId: randomUUID(),
      ...resolved,
      authority: { ...authority, allowed: authority.allowed && deps.allowed() },
      selection: input.selection,
      plannedCredits,
      cap,
      expiresAt: new Date(Date.parse(now()) + 900_000).toISOString(),
      state: "quoted" as const,
    };
    const result = { ...value, fingerprint: countFingerprint(value) };
    await deps.ledger.saveQuote(result, input.owner);
    return result;
  }
  async function acquire(input: {
    quoteId: string;
    fingerprint: string;
    owner: string;
    admission?: CountAdmission;
  }): Promise<CountQuote> {
    const original = await deps.ledger.loadQuote(input.quoteId, input.owner);
    const current = await deps.resolve(original.selection);
    const authority = await deps.ledger.authority();
    if (
      !deps.allowed() ||
      !authority.allowed ||
      authority.fingerprint !== original.authority.fingerprint ||
      !original.authority.allowed ||
      original.fingerprint !== input.fingerprint ||
      Date.parse(original.expiresAt) < Date.parse(now()) ||
      original.membershipFingerprint !== current.membershipFingerprint ||
      current.targets.length !== original.targets.length ||
      current.targets.some(
        (item, index) =>
          countQueryKey(item.query) !== countQueryKey(original.targets[index]!.query) ||
          (original.targets[index]!.source &&
            (!item.source || countFingerprint(item.source) !== countFingerprint(original.targets[index]!.source))),
      )
    )
      throw new CountAcquisitionRefused();
    // Whole-quote admission buys all of P or nothing: a known shortfall refuses
    // before the ledger is touched, and the locked admission refuses a later one.
    if (
      input.admission === "whole-quote" &&
      (original.plannedCredits < 1 ||
        original.cap < original.plannedCredits ||
        current.targets.some((target) => target.blocked && !target.source))
    )
      throw new CountAcquisitionRefused();
    const executionId =
      input.admission === "whole-quote" ? await deps.ledger.admit(original, input.owner, authority) : undefined;
    let state: "complete" | "failed" | "uncertain" = "failed";
    try {
      await deps.ledger.approve(original.quoteId, original.fingerprint, input.owner);
      const acquired: CountTarget[] = [...current.targets];
      state = "complete";
      for (const [index, target] of current.targets.entries()) {
        if (target.source) continue;
        let debit: string | null;
        try {
          debit = await deps.ledger.claim(original, target, input.owner, authority, executionId);
        } catch {
          state = "failed";
          break;
        }
        if (!debit) {
          const reused = await deps.resolve(original.selection);
          const source = reused.targets.find(
            (item) =>
              item.scopeRecordId === target.scopeRecordId && countQueryKey(item.query) === countQueryKey(target.query),
          )?.source;
          if (reused.membershipFingerprint !== original.membershipFingerprint || !source) {
            state = "failed";
            break;
          }
          acquired[index] = { ...target, source };
          continue;
        }
        let outcome: "complete" | "failed" | "uncertain" = "complete";
        let evidence: ScrydexCountEvidence | null = null;
        try {
          const response = await deps.send(target.query);
          evidence = {
            query: target.query,
            sourceId: debit,
            validationKind: "page-1-count",
            ...response,
            expiresAt: new Date(Date.parse(response.observedAt) + 900_000).toISOString(),
          };
          if (!countSourceIsCurrent(evidence, target.query, now())) throw new Error("Invalid count evidence.");
          acquired[index] = { ...target, source: evidence };
        } catch (error) {
          evidence = null;
          outcome =
            error instanceof TypeError ||
            (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
              ? "uncertain"
              : "failed";
        }
        try {
          await deps.ledger.result(debit, original.quoteId, target.query, outcome, evidence);
        } catch {
          state = "uncertain";
          break;
        }
        if (outcome !== "complete") {
          state = outcome;
          break;
        }
      }
      return { ...original, targets: acquired, state };
    } finally {
      // Fence and release unconverted capacity; a failed end leaves it held until expiry.
      if (executionId) await deps.ledger.end(original.quoteId, executionId, input.owner, state).catch(() => undefined);
    }
  }
  return { quote, acquire };
}
