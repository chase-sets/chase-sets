import { describe, expect, it } from "vitest";
import {
  parseRehearsalCountPreparationApproval,
  rehearsalCountPreparationApprovalSchemaVersion,
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

function pageOne(scopeRecordId: string, kind: "cards" | "sealed", sourceId: string) {
  return {
    scopeRecordId,
    kind,
    sourceId,
    validationKind: "page-1-count" as const,
    totalCount: kind === "cards" ? 121 : 7,
    pageSize: 100,
    returnedItemCount: kind === "cards" ? 100 : 7,
    observedAt: "2026-10-14T12:01:00.000Z",
    expiresAt: "2026-10-14T12:16:00.000Z",
  };
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
    roster: [
      { scopeRecordId: "scope-op01", kind: "cards", parentValue: "OP01", state: "missing" },
      { scopeRecordId: "scope-op01", kind: "sealed", parentValue: "OP01", state: "missing" },
      { scopeRecordId: "scope-op02", kind: "cards", parentValue: "OP02", state: "missing" },
      { scopeRecordId: "scope-op02", kind: "sealed", parentValue: "OP02", state: "reused" },
    ],
    acquisition: {
      submittedAt: "2026-10-14T12:00:30.000Z",
      response: { status: 200, state: "complete" },
      readback: { readAt, status: "read", state: "complete" },
    },
    sources: [
      pageOne("scope-op01", "cards", uuid(2)),
      pageOne("scope-op01", "sealed", uuid(3)),
      pageOne("scope-op02", "cards", uuid(4)),
      {
        ...pageOne("scope-op02", "sealed", `sha256:${hex("e")}`),
        validationKind: "complete-cache",
        returnedItemCount: null,
        observedAt: "2026-10-14T11:58:00.000Z",
        expiresAt: "2026-10-14T12:13:00.000Z",
      },
    ],
    debits: [
      { scopeRecordId: "scope-op01", kind: "cards", debitId: uuid(2), outcome: "complete" },
      { scopeRecordId: "scope-op01", kind: "sealed", debitId: uuid(3), outcome: "complete" },
      { scopeRecordId: "scope-op02", kind: "cards", debitId: uuid(4), outcome: "complete" },
    ],
    outcome: "complete",
    refusal: null,
    completedAt: readAt,
  } as Receipt;
}

function quoted(): Receipt {
  const receipt = complete();
  receipt.mode = "quote";
  receipt.approval = null;
  receipt.acquisition = null;
  receipt.roster = receipt.roster.map((entry) => ({ ...entry }));
  receipt.sources = [receipt.sources[3]!];
  receipt.debits = [];
  receipt.outcome = "quoted";
  receipt.completedAt = "2026-10-14T11:59:30.000Z";
  return receipt;
}

function errorsOf(receipt: unknown) {
  return validateRehearsalCountPreparationReceipt(receipt, expected).errors;
}

describe("rehearsal count preparation receipt (AC4)", () => {
  it("accepts closed quote and complete acquisition receipts bound to the admitted run", () => {
    expect(errorsOf(complete())).toEqual([]);
    expect(errorsOf(quoted())).toEqual([]);
    const text = `${JSON.stringify(complete(), null, 2)}\n`;
    expect(validateRehearsalCountPreparationReceiptText(text, expected)).toMatchObject({ ok: true, errors: [] });
  });

  it("rejects missing payload, partial roster, nested unknown, date-only and overflow", () => {
    for (const text of ["", "null", "{}", "[]", "{"])
      expect(validateRehearsalCountPreparationReceiptText(text, expected).ok, text).toBe(false);

    const partial = complete();
    partial.sources.pop();
    expect(errorsOf(partial)).toContain("complete-requires-every-roster-source");
    const shortRoster = complete();
    shortRoster.roster.pop();
    expect(errorsOf(shortRoster)).toContain("roster-count-mismatch");

    const nestedQuote = complete() as Record<string, unknown>;
    (nestedQuote.quote as Record<string, unknown>).selectionUrl = "x";
    expect(errorsOf(nestedQuote).some((error) => error.startsWith("schema:quote"))).toBe(true);
    const nestedSource = complete() as Record<string, unknown>;
    (nestedSource.sources as Record<string, unknown>[])[0]!.items = [];
    expect(errorsOf(nestedSource).some((error) => error.startsWith("schema:sources.0"))).toBe(true);

    const dateOnly = complete();
    dateOnly.approval!.approvedAt = "2026-10-14";
    expect(errorsOf(dateOnly).some((error) => error.startsWith("schema:approval.approvedAt"))).toBe(true);

    const overflow = complete();
    overflow.sources[0]!.totalCount = 2147483648;
    expect(errorsOf(overflow).some((error) => error.startsWith("schema:sources.0.totalCount"))).toBe(true);
    const unsafe = JSON.stringify(complete()).replace('"authorityHeadroom":40', '"authorityHeadroom":1e400');
    expect(validateRehearsalCountPreparationReceiptText(unsafe, expected).ok).toBe(false);
    const tooMany = complete();
    tooMany.quote!.targetCount = 10_001;
    expect(errorsOf(tooMany).some((error) => error.startsWith("schema:quote.targetCount"))).toBe(true);
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

  it("binds the admitted SHA, run and attempt", () => {
    for (const key of ["sha", "runId", "runAttempt"] as const) {
      const receipt = complete();
      receipt[key] = key === "sha" ? "b".repeat(40) : "999";
      expect(errorsOf(receipt)).toContain(`identity-mismatch:${key}`);
    }
  });

  it("complete requires current exact sources at readback: stale and future evidence reject", () => {
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
  });

  it("debits are page-1 sources of missing roster entries with source id equal to debit id", () => {
    const reusedDebit = complete();
    reusedDebit.debits.push({
      scopeRecordId: "scope-op02",
      kind: "sealed",
      debitId: `sha256:${hex("e")}`,
      outcome: "complete",
    });
    expect(errorsOf(reusedDebit)).toContain("debit-not-acquired-source");
    const otherSource = complete();
    otherSource.debits[0]!.debitId = uuid(9);
    expect(errorsOf(otherSource)).toContain("debit-not-acquired-source");
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

  it("refusals carry a code and stops never claim completion", () => {
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
