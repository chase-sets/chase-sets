import { describe, expect, it } from "vitest";
import { countFingerprint } from "./count-acquisition";
import {
  parseRehearsalCountPreparationApproval,
  rehearsalCountPreparationApprovalSchemaVersion,
  rehearsalCountPreparationContinuation,
  rehearsalCountPreparationReceiptSchemaVersion as schemaVersion,
  rehearsalCountPreparationSelection,
  RehearsalCountPreparationRefusal,
  validateRehearsalCountPreparationReceipt,
  validateRehearsalCountPreparationReceiptText,
  type RehearsalCountPreparationReceipt,
} from "./rehearsal-count-preparation-receipt";

const identity = { sha: "a".repeat(40), runId: "123456", runAttempt: "1" };
const forbiddenValues = ["synthetic-admin@example.invalid", "synthetic-password-value"];
const expected = { ...identity, forbiddenValues };
const hex = (character: string) => character.repeat(64);
const uuid = (index: number) => `00000000-0000-4000-8000-00000000000${index}`;
const readAt = "2026-10-14T12:05:00.000Z";
const pass = { passNumber: 1, productDomain: "one-piece", languageCode: null, scopeKind: "set" } as const;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type Receipt = Mutable<RehearsalCountPreparationReceipt>;
type Accounting = NonNullable<Receipt["accounting"]>;
type Debit = Accounting["debits"][number];

const entries = [
  { scopeRecordId: "scope-op01", kind: "cards", parentValue: "OP01", queryFingerprint: hex("1") },
  { scopeRecordId: "scope-op01", kind: "sealed", parentValue: "OP01", queryFingerprint: hex("2") },
  { scopeRecordId: "scope-op02", kind: "cards", parentValue: "OP02", queryFingerprint: hex("3") },
  { scopeRecordId: "scope-op02", kind: "sealed", parentValue: "OP02", queryFingerprint: hex("4") },
] as const;

function pageOne(index: number, sourceId: string) {
  const entry = entries[index]!;
  return {
    scopeRecordId: entry.scopeRecordId,
    kind: entry.kind,
    queryFingerprint: entry.queryFingerprint,
    sourceId,
    validationKind: "page-1-count" as const,
    totalCount: entry.kind === "cards" ? 121 : 7,
    pageSize: 100,
    returnedItemCount: entry.kind === "cards" ? 100 : 7,
    observedAt: "2026-10-14T12:01:00.000Z",
    expiresAt: "2026-10-14T12:16:00.000Z",
  };
}

function reused() {
  return {
    ...pageOne(3, `sha256:${hex("e")}`),
    validationKind: "complete-cache" as const,
    returnedItemCount: null,
    observedAt: "2026-10-14T11:58:00.000Z",
    expiresAt: "2026-10-14T12:13:00.000Z",
  };
}

function debit(index: number, debitId: string, outcome: Debit["outcome"]): Debit {
  const entry = entries[index]!;
  return {
    quoteId: uuid(1),
    scopeRecordId: entry.scopeRecordId,
    kind: entry.kind,
    queryFingerprint: entry.queryFingerprint,
    debitId,
    credits: 1,
    debitedAt: "2026-10-14T12:00:31.000Z",
    outcome,
    observedAt: outcome === "complete" ? "2026-10-14T12:01:00.000Z" : null,
    expiresAt: outcome === "complete" ? "2026-10-14T12:16:00.000Z" : null,
  };
}

function accounting(debits: Debit[]): Accounting {
  return { status: "complete", reason: null, readAt, fingerprint: countFingerprint(debits), debits };
}

function complete(): Receipt {
  return {
    schemaVersion,
    mode: "acquire",
    ...identity,
    dispatchId: "9224-pass1-one-piece",
    pass: { ...pass },
    selection: rehearsalCountPreparationSelection(pass) as Receipt["selection"],
    approval: {
      approvalId: "host-approval-1",
      approvedAt: "2026-10-14T12:00:00.000Z",
      authorityObservedAt: "2026-10-14T11:59:00.000Z",
      authorityHeadroom: 40,
      authorityFingerprint: hex("b"),
    },
    quote: {
      quoteId: uuid(1),
      fingerprint: hex("c"),
      membershipFingerprint: hex("d"),
      expiresAt: "2026-10-14T12:14:00.000Z",
      plannedCredits: 3,
      cap: 3,
      perKindCost: { cards: 2, sealed: 1 },
      scopeCount: 2,
      targetCount: 4,
      authority: { fingerprint: hex("b"), headroom: 40, allowed: true },
    },
    authority: {
      readAt: "2026-10-14T12:00:20.000Z",
      usageFingerprint: hex("b"),
      usageObservedAt: "2026-10-14T11:59:00.000Z",
      state: "allowed",
      headroom: 40,
    },
    roster: entries.map((entry, index) => ({ ...entry, state: index === 3 ? "reused" : "missing" })),
    acquisition: {
      admission: "whole-quote",
      submittedAt: "2026-10-14T12:00:30.000Z",
      response: { status: 200, state: "complete" },
      readback: { readAt, status: "read", state: "complete", admission: "ended" },
    },
    sources: [pageOne(0, uuid(2)), pageOne(1, uuid(3)), pageOne(2, uuid(4)), reused()],
    accounting: accounting([
      debit(0, uuid(2), "complete"),
      debit(1, uuid(3), "complete"),
      debit(2, uuid(4), "complete"),
    ]),
    outcome: "complete",
    refusal: null,
    completedAt: readAt,
  } as Receipt;
}

function failed(): Receipt {
  const receipt = complete();
  receipt.outcome = "failed";
  receipt.acquisition!.response.state = "failed";
  receipt.acquisition!.readback.state = "failed";
  receipt.sources = [pageOne(0, uuid(2)), reused()];
  receipt.accounting = accounting([debit(0, uuid(2), "complete"), debit(1, uuid(3), "failed")]);
  return receipt;
}

function uncertain(): Receipt {
  const receipt = complete();
  receipt.outcome = "uncertain";
  receipt.acquisition!.response = { status: null, state: null };
  receipt.acquisition!.readback.state = "uncertain";
  receipt.sources = [reused()];
  receipt.accounting = accounting([debit(0, uuid(2), "acquiring")]);
  return receipt;
}

function unreadable(): Receipt {
  const receipt = complete();
  receipt.outcome = "readback-failed";
  receipt.acquisition!.readback = { readAt, status: "failed", state: null, admission: null };
  receipt.sources = [];
  receipt.accounting = { status: "unknown", reason: "readback-failed", readAt, fingerprint: null, debits: [] };
  return receipt;
}

function quoted(): Receipt {
  const receipt = complete();
  receipt.mode = "quote";
  receipt.approval = null;
  receipt.authority = null;
  receipt.acquisition = null;
  receipt.accounting = null;
  receipt.sources = [reused()];
  receipt.outcome = "quoted";
  receipt.completedAt = "2026-10-14T11:59:30.000Z";
  return receipt;
}

function errorsOf(receipt: unknown) {
  return validateRehearsalCountPreparationReceipt(receipt, expected).errors;
}

describe("rehearsal count preparation receipt (AC4)", () => {
  it("accepts closed quote, complete and source-less stop receipts bound to the admitted run", () => {
    for (const receipt of [complete(), failed(), uncertain(), unreadable(), quoted()])
      expect(errorsOf(receipt), receipt.outcome).toEqual([]);
    const text = `${JSON.stringify(failed(), null, 2)}\n`;
    const verdict = validateRehearsalCountPreparationReceiptText(text, expected);
    expect(verdict).toMatchObject({ ok: true, errors: [] });
    expect(verdict.receipt!.accounting!.debits.map((row) => [row.debitId, row.outcome])).toEqual([
      [uuid(2), "complete"],
      [uuid(3), "failed"],
    ]);
  });

  it("an underfunded pre-submit refusal records current authority and complete empty accounting", () => {
    const refused = complete();
    refused.outcome = "refused";
    refused.refusal = "headroom-below-planned";
    refused.acquisition = null;
    refused.sources = [reused()];
    refused.authority!.headroom = 1;
    refused.accounting = accounting([]);
    expect(errorsOf(refused)).toEqual([]);
    // The same underfunded authority can never precede a submission.
    refused.outcome = "admission-refused";
    refused.refusal = null;
    refused.acquisition = {
      admission: "whole-quote",
      submittedAt: "2026-10-14T12:00:30.000Z",
      response: { status: 409, state: null },
      readback: { readAt, status: "read", state: "quoted", admission: "none" },
    };
    expect(errorsOf(refused)).toEqual(["submission-requires-current-authority"]);
    refused.authority!.headroom = 3;
    expect(errorsOf(refused)).toEqual([]);
  });

  it("unknown accounting is never zero spend and cannot complete", () => {
    const unknown = complete();
    unknown.accounting = { ...unknown.accounting!, status: "unknown", reason: "overflow", fingerprint: null };
    expect(errorsOf(unknown)).toContain("complete-requires-complete-accounting");
    unknown.outcome = "partial";
    expect(errorsOf(unknown)).toEqual([]);
    const unreasoned = unreadable();
    unreasoned.accounting!.reason = null;
    expect(errorsOf(unreasoned)).toContain("accounting-shape-mismatch");
    const missing = uncertain();
    missing.accounting = null;
    expect(errorsOf(missing)).toContain("mode-shape-mismatch");
  });

  it("rejects omission, partial roster, nested unknown, date-only and overflow", () => {
    for (const text of ["", "null", "{}", "[]", "{"])
      expect(validateRehearsalCountPreparationReceiptText(text, expected).ok, text).toBe(false);

    const omitted = failed();
    omitted.accounting!.debits.pop();
    expect(errorsOf(omitted)).toContain("accounting-fingerprint-mismatch");
    const omittedSource = complete();
    omittedSource.sources.pop();
    expect(errorsOf(omittedSource)).toContain("complete-requires-every-roster-source");
    const unsourced = complete();
    unsourced.sources[0] = { ...unsourced.sources[0]!, sourceId: uuid(9) };
    expect(errorsOf(unsourced)).toContain("complete-requires-debit-sources");
    const shortRoster = complete();
    shortRoster.roster.pop();
    expect(errorsOf(shortRoster)).toContain("roster-count-mismatch");

    const nestedQuote = complete() as Record<string, unknown>;
    (nestedQuote.quote as Record<string, unknown>).selectionUrl = "x";
    expect(errorsOf(nestedQuote).some((error) => error.startsWith("schema:quote"))).toBe(true);
    const nestedSource = complete() as Record<string, unknown>;
    (nestedSource.sources as Record<string, unknown>[])[0]!.items = [];
    expect(errorsOf(nestedSource).some((error) => error.startsWith("schema:sources.0"))).toBe(true);
    const nestedDebit = failed() as unknown as { accounting: { debits: Record<string, unknown>[] } };
    nestedDebit.accounting.debits[1]!.providerResponse = {};
    expect(errorsOf(nestedDebit).some((error) => error.startsWith("schema:accounting.debits.1"))).toBe(true);
    const nestedAuthority = complete() as unknown as { authority: Record<string, unknown> };
    nestedAuthority.authority.accountId = "x";
    expect(errorsOf(nestedAuthority).some((error) => error.startsWith("schema:authority"))).toBe(true);

    const dateOnly = complete();
    dateOnly.approval!.approvedAt = "2026-10-14";
    expect(errorsOf(dateOnly).some((error) => error.startsWith("schema:approval.approvedAt"))).toBe(true);
    const debitDate = failed();
    debitDate.accounting!.debits[1]!.debitedAt = "2026-10-14";
    expect(errorsOf(debitDate).some((error) => error.startsWith("schema:accounting.debits.1.debitedAt"))).toBe(true);

    const overflow = complete();
    overflow.sources[0]!.totalCount = 2147483648;
    expect(errorsOf(overflow).some((error) => error.startsWith("schema:sources.0.totalCount"))).toBe(true);
    const unsafe = JSON.stringify(complete()).replace('"authorityHeadroom":40', '"authorityHeadroom":1e400');
    expect(validateRehearsalCountPreparationReceiptText(unsafe, expected).ok).toBe(false);
    const tooMany = complete();
    tooMany.quote!.targetCount = 10_001;
    expect(errorsOf(tooMany).some((error) => error.startsWith("schema:quote.targetCount"))).toBe(true);
    const tooManyDebits = unreadable();
    tooManyDebits.accounting!.debits = Array.from({ length: 10_001 }, () => debit(0, uuid(2), "acquiring"));
    expect(errorsOf(tooManyDebits).some((error) => error.startsWith("schema:accounting.debits"))).toBe(true);
  });

  it("rejects escaped rotated-cookie markers and admitted credential values without echoing them", () => {
    const escaped = JSON.stringify(complete()).replace('"host-approval-1"', '"\\u0063hase_sets_session"');
    const marker = validateRehearsalCountPreparationReceiptText(escaped, expected);
    expect(marker.ok).toBe(false);
    expect(marker.errors).toContain("secret-marker:session-cookie");

    const credential = complete();
    credential.dispatchId = "synthetic-password-value";
    const leaked = validateRehearsalCountPreparationReceiptText(JSON.stringify(credential), expected);
    expect(leaked.ok).toBe(false);
    expect(leaked.errors).toContain("forbidden-value");
    expect(leaked.errors.join("\n")).not.toContain("synthetic-password-value");

    const url = JSON.stringify(complete()).replace('"OP01"', '"https://api.example.invalid/OP01"');
    expect(validateRehearsalCountPreparationReceiptText(url, expected).errors).toContain("secret-marker:url");
  });

  it("binds the admitted SHA, run and attempt; earlier receipt versions are historical only", () => {
    for (const key of ["sha", "runId", "runAttempt"] as const) {
      const receipt = complete();
      receipt[key] = key === "sha" ? "b".repeat(40) : "999";
      expect(errorsOf(receipt)).toContain(`identity-mismatch:${key}`);
    }
    const earlier = { ...complete(), schemaVersion: "catalog-rehearsal-count-preparation-receipt/v1" };
    expect(errorsOf(earlier)).toContain("schema:schemaVersion:invalid_value");
  });

  it("complete requires current exact sources, complete debits and an ended admission", () => {
    const stale = complete();
    stale.sources[0]!.observedAt = "2026-10-14T11:49:59.000Z";
    expect(errorsOf(stale)).toContain("complete-source-not-current");
    const future = complete();
    future.sources[0]!.observedAt = "2026-10-14T12:05:01.000Z";
    expect(errorsOf(future)).toContain("complete-source-not-current");
    const expired = complete();
    expired.sources[3]!.expiresAt = "2026-10-14T12:04:59.000Z";
    expect(errorsOf(expired)).toContain("complete-source-not-current");
    const ambiguous = complete();
    ambiguous.acquisition!.response = { status: null, state: null };
    expect(errorsOf(ambiguous)).toContain("complete-requires-complete-acquisition");
    const open = complete();
    open.acquisition!.readback.admission = "active";
    expect(errorsOf(open)).toContain("complete-requires-complete-acquisition");
    const relabelled = failed();
    relabelled.outcome = "complete";
    expect(errorsOf(relabelled)).toEqual(
      expect.arrayContaining(["complete-requires-complete-acquisition", "complete-requires-complete-debits"]),
    );
  });

  it("debits belong to this quote's missing entries; reuse is never a new debit", () => {
    const reusedDebit = complete();
    reusedDebit.accounting = accounting([...reusedDebit.accounting!.debits, debit(3, uuid(5), "complete")]);
    expect(errorsOf(reusedDebit)).toContain("debit-outside-roster");
    const foreign = failed();
    foreign.accounting = accounting([{ ...debit(0, uuid(2), "complete"), quoteId: uuid(9) }]);
    expect(errorsOf(foreign)).toContain("debit-outside-roster");
    const otherQuery = failed();
    otherQuery.accounting = accounting([{ ...debit(0, uuid(2), "complete"), queryFingerprint: hex("9") }]);
    expect(errorsOf(otherQuery)).toContain("debit-outside-roster");
    const duplicate = failed();
    duplicate.accounting = accounting([debit(0, uuid(2), "complete"), debit(0, uuid(2), "complete")]);
    expect(errorsOf(duplicate)).toContain("debit-duplicate");
    const timed = failed();
    timed.accounting = accounting([{ ...debit(1, uuid(3), "failed"), observedAt: "2026-10-14T12:01:00.000Z" }]);
    expect(errorsOf(timed)).toContain("debit-shape-mismatch");
    const borrowed = failed();
    borrowed.sources = [pageOne(0, uuid(3)), reused()];
    expect(errorsOf(borrowed)).toContain("source-debit-mismatch");
    // A fresh source from another quote may carry that quote's older debit id; it stays reuse.
    const olderReuse = complete();
    olderReuse.sources[2] = { ...pageOne(2, uuid(7)) };
    olderReuse.accounting = accounting(olderReuse.accounting!.debits.slice(0, 2));
    expect(errorsOf(olderReuse)).toEqual([]);
  });

  it("enforces displayed limits: <=1 per kind, <=2 credits per set, Lorcana cards only, cap/headroom cover P", () => {
    const duplicate = quoted();
    duplicate.roster.push({ ...duplicate.roster[0]! });
    duplicate.quote!.targetCount = 5;
    expect(errorsOf(duplicate)).toContain("roster-duplicate-kind");

    const lorcana = quoted();
    lorcana.pass.productDomain = "lorcana";
    lorcana.selection = rehearsalCountPreparationSelection(lorcana.pass) as Receipt["selection"];
    expect(errorsOf(lorcana)).toContain("lorcana-sealed");

    const underCap = quoted();
    underCap.quote!.cap = 2;
    expect(errorsOf(underCap)).toContain("quoted-requires-cap-and-headroom");
    const underHeadroom = quoted();
    underHeadroom.quote!.authority.headroom = 2;
    expect(errorsOf(underHeadroom)).toContain("quoted-requires-cap-and-headroom");

    const notRequired = quoted();
    notRequired.outcome = "not-required";
    expect(errorsOf(notRequired)).toContain("not-required-requires-zero-planned");

    const cost = quoted();
    cost.quote!.perKindCost = { cards: 3, sealed: 0 };
    expect(errorsOf(cost)).toContain("per-kind-cost-mismatch");

    const selection = quoted();
    selection.selection.query.languageCode = "ja";
    expect(errorsOf(selection)).toContain("selection-not-pass");
  });

  it("refusals carry a code; only no-spend and complete continue to independent reservation checks", () => {
    const refused = quoted();
    refused.outcome = "refused";
    expect(errorsOf(refused)).toContain("refusal-code-mismatch");
    refused.refusal = "blocked-targets";
    expect(errorsOf(refused)).toEqual([]);

    const partial = complete();
    partial.outcome = "partial";
    partial.sources.pop();
    expect(errorsOf(partial)).toEqual([]);
    partial.acquisition = null;
    expect(errorsOf(partial)).toContain("acquisition-shape-mismatch");

    const notRequired = quoted();
    notRequired.outcome = "not-required";
    notRequired.quote = { ...notRequired.quote!, plannedCredits: 0, cap: 0, perKindCost: { cards: 0, sealed: 0 } };
    notRequired.roster = notRequired.roster.map((entry) => ({ ...entry, state: "reused" }));
    notRequired.sources = entries.map((entry) => ({
      ...reused(),
      scopeRecordId: entry.scopeRecordId,
      kind: entry.kind,
      queryFingerprint: entry.queryFingerprint,
    }));
    expect(errorsOf(notRequired)).toEqual([]);
    expect(rehearsalCountPreparationContinuation(notRequired)).toBe("reservation");
    expect(rehearsalCountPreparationContinuation(complete())).toBe("reservation");
    expect(rehearsalCountPreparationContinuation(quoted())).toBe("approval");
    for (const stop of [failed(), uncertain(), unreadable(), partial, refused])
      expect(rehearsalCountPreparationContinuation(stop), stop.outcome).toBe("stop");
  });
});

describe("rehearsal count preparation approval", () => {
  const approval = {
    schemaVersion: rehearsalCountPreparationApprovalSchemaVersion,
    dispatchId: "9224-pass1-one-piece",
    approvalId: "host-approval-1",
    approvedAt: "2026-10-14T12:00:00.000Z",
    pass,
    quote: {
      quoteId: uuid(1),
      fingerprint: hex("c"),
      membershipFingerprint: hex("d"),
      expiresAt: "2026-10-14T12:14:00.000Z",
    },
    plannedCredits: 3,
    perKindCost: { cards: 2, sealed: 1 },
    cap: 3,
    authority: { fingerprint: hex("b"), headroom: 40, observedAt: "2026-10-14T11:59:00.000Z" },
  };

  it("parses only the closed host approval and refuses by code", () => {
    expect(parseRehearsalCountPreparationApproval(JSON.stringify(approval))).toEqual(approval);
    for (const value of [
      "",
      "{",
      JSON.stringify({ ...approval, extra: true }),
      JSON.stringify({ ...approval, quote: { ...approval.quote, url: "x" } }),
      JSON.stringify({ ...approval, approvedAt: "2026-10-14" }),
      JSON.stringify({ ...approval, cap: 10_001 }),
      JSON.stringify({ ...approval, pass: { ...pass, scopeKind: "expansion" } }),
    ]) {
      let refusal: unknown;
      try {
        parseRehearsalCountPreparationApproval(value);
      } catch (error) {
        refusal = error;
      }
      expect(refusal, value).toBeInstanceOf(RehearsalCountPreparationRefusal);
      expect((refusal as RehearsalCountPreparationRefusal).code).toBe("approval-invalid");
    }
  });
});
