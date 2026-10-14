import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { scopeSyncBatchRoutes } from "./route";
import { createCountAcquisition, type CountAcquisitionLedger } from "./count-acquisition";
import type { ScopeSyncBatchServices } from "./runtime";
import { scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import {
  CountAcquisitionRefused,
  countFingerprint,
  countQueryKey,
  countTimeIsCurrent,
  type CountQuote,
  type ScrydexCountQuery,
  type ScrydexCountSource,
} from "../domain/count-acquisition";
import {
  acquireRehearsalCounts,
  admitRehearsalCountAcquisition,
  createRehearsalCountAdminClient,
  quoteRehearsalCounts,
  rehearsalCountAdminMaxResponseBytes,
} from "./rehearsal-count-preparation";
import {
  rehearsalCountPreparationApprovalSchemaVersion,
  RehearsalCountPreparationRefusal,
  validateRehearsalCountPreparationReceipt,
  type RehearsalCountPreparationPass,
  type RehearsalCountPreparationReceipt,
} from "../domain/rehearsal-count-preparation-receipt";

const origin = "https://admin.staging.chasesets.com";
const countsPath = "/api/catalog/scope-sync-batches/counts";
const run = { sha: "a".repeat(40), runId: "123456", runAttempt: "1" };
const dispatchId = "9224-pass1-one-piece";
const pass: RehearsalCountPreparationPass = {
  passNumber: 1,
  productDomain: "one-piece",
  languageCode: null,
  scopeKind: "set",
};
const context: EventStoreContext = {
  tenantId: "tnt_synthetic",
  audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
};
const actor: ResolvedActor = {
  roleKey: "platform-admin",
  permissions: ["catalog.manage", "catalog.view"],
  sessionId: "synthetic-session",
  tenantId: "tnt_synthetic",
  userId: "usr_synthetic",
  accountId: "acc_synthetic",
  membershipId: "synthetic-membership",
};
const start = "2026-10-14T12:00:00.000Z";
const later = (ms: number, from = start) => new Date(Date.parse(from) + ms).toISOString();

function countQuery(set: string, kind: "cards" | "sealed", languageCode = "en"): ScrydexCountQuery {
  return scrydexCountQuery({
    environment: "staging",
    accountRevision: "synthetic",
    productDomain: "one-piece",
    profileKey: kind === "cards" ? "one-piece-card-print" : "one-piece-sealed-product",
    profileVersion: "2026.06.22",
    unitKey: `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`,
    kind,
    languageCode,
    parentValue: set,
  });
}

// Postgres JSONB returns object keys shortest-first, so a retained read never keeps insertion order.
function jsonbOrdered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrdered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, jsonbOrdered(entry)]),
  );
}

type Fault = "none" | "fail-second-send" | "uncertain-first-send" | "lose-first-result";
type Debit = {
  id: string;
  quoteId: string;
  scopeRecordId: string;
  kind: "cards" | "sealed";
  queryKey: string;
  debitedAt: string;
  outcome: "complete" | "failed" | "uncertain" | null;
  source: ScrydexCountSource | null;
};

// Real routes, the real count engine and an in-memory ledger that models the
// store's whole-quote allocation; the provider send and every batch, preview,
// confirm, usage-history and held-set service is a counting trap.
function harness(options: { remaining?: number; reused?: readonly string[]; blocked?: readonly string[] } = {}) {
  let clock = start;
  let membership = "1".repeat(64);
  let authorityFingerprint = "2".repeat(64);
  let fault: Fault = "none";
  let external = 0;
  let projection: ((view: Record<string, unknown>) => Record<string, unknown>) | null = null;
  const remaining = options.remaining ?? 40;
  const definitions = ["OP01", "OP02"].flatMap((set) =>
    (["cards", "sealed"] as const).map((kind) => ({
      key: `${set}:${kind}`,
      scopeRecordId: `scope-${set.toLowerCase()}`,
      query: countQuery(set, kind),
    })),
  );
  const quotes = new Map<string, CountQuote>();
  const approved = new Set<string>();
  const allocations = new Map<string, { executionId: string; planned: number; at: string; endedAt: string | null }>();
  const debits: Debit[] = [];
  const evidence = new Map<string, ScrydexCountSource>();
  for (const key of options.reused ?? []) {
    const query = definitions.find((definition) => definition.key === key)!.query;
    evidence.set(countQueryKey(query), {
      query,
      validationKind: "complete-cache",
      sourceId: `sha256:${"e".repeat(64)}`,
      totalCount: 7,
      pageSize: 100,
      observedAt: later(-60_000),
      expiresAt: later(14 * 60_000),
    });
  }
  const current = (query: ScrydexCountQuery) => {
    const source = evidence.get(countQueryKey(query));
    return source && countTimeIsCurrent(source, clock) ? source : null;
  };
  const outstanding = () =>
    [...allocations.entries()].reduce((sum, [quoteId, allocation]) => {
      const quote = quotes.get(quoteId)!;
      if (allocation.endedAt || Date.parse(quote.expiresAt) < Date.parse(clock)) return sum;
      return sum + Math.max(0, allocation.planned - debits.filter((debit) => debit.quoteId === quoteId).length);
    }, 0);
  const net = () => remaining - external - debits.length - outstanding();
  let readbackOverride: ((targets: CountQuote["targets"]) => CountQuote["targets"]) | null = null;
  const send = vi.fn(async () => {
    const calls = send.mock.calls.length;
    if (fault === "fail-second-send" && calls === 2) throw new Error("synthetic provider failure");
    if (fault === "uncertain-first-send" && calls === 1) throw new TypeError("synthetic transport failure");
    return { totalCount: 121, pageSize: 100, returnedPage: 1 as const, returnedItemCount: 100, observedAt: clock };
  });
  const ledger: CountAcquisitionLedger = {
    authority: async () => ({ fingerprint: authorityFingerprint, headroom: Math.max(0, net()), allowed: true }),
    saveQuote: async (quote) => {
      quotes.set(quote.quoteId, quote);
    },
    loadQuote: async (quoteId) => {
      const quote = quotes.get(quoteId);
      if (!quote) throw new CountAcquisitionRefused();
      return quote;
    },
    admit: async (quote, _owner, authority) => {
      if (
        allocations.has(quote.quoteId) ||
        approved.has(quote.quoteId) ||
        debits.some((debit) => debit.quoteId === quote.quoteId) ||
        authority.fingerprint !== authorityFingerprint ||
        Date.parse(quote.expiresAt) < Date.parse(clock) ||
        net() < quote.plannedCredits
      )
        throw new CountAcquisitionRefused();
      const executionId = randomUUID();
      allocations.set(quote.quoteId, { executionId, planned: quote.plannedCredits, at: clock, endedAt: null });
      return executionId;
    },
    approve: async (quoteId, fingerprint) => {
      const quote = quotes.get(quoteId);
      if (!quote || quote.fingerprint !== fingerprint || Date.parse(quote.expiresAt) < Date.parse(clock))
        throw new CountAcquisitionRefused();
      approved.add(quoteId);
      return quote;
    },
    claim: async (quote, target, _owner, _authority, executionId) => {
      const allocation = allocations.get(quote.quoteId);
      if (executionId ? allocation?.executionId !== executionId || allocation.endedAt : allocation)
        throw new CountAcquisitionRefused();
      if (current(target.query)) return null;
      const own = debits.filter((debit) => debit.quoteId === quote.quoteId);
      if (
        own.some((debit) => debit.queryKey === countQueryKey(target.query)) ||
        own.length >= quote.cap ||
        (executionId ? net() < 0 : net() < 1)
      )
        throw new CountAcquisitionRefused();
      const id = randomUUID();
      debits.push({
        id,
        quoteId: quote.quoteId,
        scopeRecordId: target.scopeRecordId,
        kind: target.query.kind,
        queryKey: countQueryKey(target.query),
        debitedAt: clock,
        outcome: null,
        source: null,
      });
      return id;
    },
    result: async (debitId, _quoteId, query, outcome, source) => {
      if (fault === "lose-first-result" && !debits.some((debit) => debit.outcome))
        throw new Error("synthetic result write failure");
      const debit = debits.find((entry) => entry.id === debitId)!;
      debit.outcome = outcome;
      debit.source = source;
      if (outcome === "complete" && source) evidence.set(countQueryKey(query), source);
    },
    end: async (quoteId, executionId) => {
      const allocation = allocations.get(quoteId);
      if (allocation?.executionId === executionId) allocation.endedAt ??= clock;
    },
  };
  const engine = createCountAcquisition({
    ledger,
    resolve: async () => ({
      membershipFingerprint: membership,
      targets: definitions.map((definition) => ({
        scopeRecordId: definition.scopeRecordId,
        query: definition.query,
        source: current(definition.query),
        blocked: (options.blocked ?? []).includes(definition.key),
      })),
    }),
    send,
    allowed: () => true,
    now: () => clock,
  });
  const retained = (quote: CountQuote) => {
    const overlaid = quote.targets.map((target) => ({ ...target, source: current(target.query) ?? target.source }));
    const targets = readbackOverride ? readbackOverride(overlaid) : overlaid;
    const own = debits.filter((debit) => debit.quoteId === quote.quoteId);
    const state: CountQuote["state"] = own.some((debit) => !debit.outcome || debit.outcome === "uncertain")
      ? "uncertain"
      : own.some((debit) => debit.outcome === "failed")
        ? "failed"
        : targets.every((target) => target.source) && (approved.has(quote.quoteId) || quote.plannedCredits === 0)
          ? "complete"
          : approved.has(quote.quoteId)
            ? "failed"
            : "quoted";
    return { ...quote, targets, state };
  };
  const preparationView = (quote: CountQuote) => {
    const allocation = allocations.get(quote.quoteId);
    const rows = debits
      .filter((debit) => debit.quoteId === quote.quoteId)
      .map((debit) => ({
        quoteId: debit.quoteId,
        scopeRecordId: debit.scopeRecordId,
        kind: debit.kind,
        queryFingerprint: debit.queryKey,
        debitId: debit.id,
        credits: 1,
        debitedAt: debit.debitedAt,
        outcome: debit.outcome ?? "acquiring",
        observedAt: debit.outcome === "complete" ? debit.source!.observedAt : null,
        expiresAt: debit.outcome === "complete" ? debit.source!.expiresAt : null,
      }));
    const view = {
      schemaVersion: "catalog-count-quote-preparation-view/v1",
      quote: retained(quote),
      currentAuthority: {
        readAt: clock,
        usageFingerprint: authorityFingerprint,
        usageObservedAt: start,
        state: "allowed",
        headroom: Math.max(0, net()),
      },
      admission: {
        state: !allocation
          ? "none"
          : allocation.endedAt
            ? "ended"
            : Date.parse(quote.expiresAt) < Date.parse(clock)
              ? "expired"
              : "active",
        plannedCredits: allocation?.planned ?? null,
        admittedAt: allocation?.at ?? null,
        endedAt: allocation?.endedAt ?? null,
      },
      debits: { status: "complete", reason: null, readAt: clock, fingerprint: countFingerprint(rows), rows },
    };
    return projection ? projection(view) : view;
  };
  const traps = {
    preview: vi.fn(),
    confirm: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    retryUnit: vi.fn(),
    resolveHeldSets: vi.fn(),
    countSpend: vi.fn(),
  };
  const services = {
    ...traps,
    quoteCounts: (input: { selection: unknown; cap?: number }) => engine.quote({ ...input, owner: "owner" }),
    acquireCounts: (input: { quoteId: string; fingerprint: string; admission?: "whole-quote" }) =>
      engine.acquire({ ...input, owner: "owner" }),
    getCountQuote: async (input: { quoteId: string; view?: "preparation" }) => {
      const quote = quotes.get(input.quoteId);
      if (!quote) throw new CountAcquisitionRefused();
      return jsonbOrdered(input.view === "preparation" ? preparationView(quote) : retained(quote));
    },
  } as unknown as ScopeSyncBatchServices;
  const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
  root.use("*", async (c, next) => {
    c.set("context", context);
    c.set("actor", actor);
    await next();
  });
  root.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(services));
  const requests: { method: string; path: string; body: unknown }[] = [];
  let transportFault: ((path: string, method: string, index: number) => "lose-response" | "throw" | null) | null = null;
  let beforeAcquire: (() => void) | null = null;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error("loopback isolation: unexpected origin");
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.pathname.endsWith("/acquire")) beforeAcquire?.();
    const action = transportFault?.(url.pathname, method, requests.length);
    if (action === "throw") throw new TypeError("synthetic transport failure");
    const response = await root.request(url.toString(), init);
    if (action === "lose-response") throw new TypeError("synthetic lost response");
    return response;
  });
  const admin = createRehearsalCountAdminClient({ origin, cookie: "chase_sets_session=synthetic", fetch });
  return {
    admin,
    fetch,
    send,
    traps,
    requests,
    debits,
    allocations,
    now: () => clock,
    advance: (ms: number) => {
      clock = later(ms, clock);
    },
    driftQuery: () => {
      definitions[0] = { ...definitions[0]!, query: countQuery("OP09", "cards") };
    },
    setMembership: (value: string) => {
      membership = value;
    },
    setAuthority: (value: string) => {
      authorityFingerprint = value;
    },
    setFault: (value: Fault) => {
      fault = value;
    },
    // An unrelated debit or reservation on the same account slot, with the usage snapshot unchanged.
    spendElsewhere: (credits: number) => {
      external += credits;
    },
    setTransportFault: (value: typeof transportFault) => {
      transportFault = value;
    },
    setBeforeAcquire: (value: typeof beforeAcquire) => {
      beforeAcquire = value;
    },
    overrideReadback: (value: typeof readbackOverride) => {
      readbackOverride = value;
    },
    overrideProjection: (value: typeof projection) => {
      projection = value;
    },
    acquirePosts: () => requests.filter((request) => request.path === `${countsPath}/acquire`).length,
  };
}

type Harness = ReturnType<typeof harness>;

function expectNoBatchWork(h: Harness) {
  for (const [name, trap] of Object.entries(h.traps)) expect(trap, name).not.toHaveBeenCalled();
}

function expectValid(receipt: RehearsalCountPreparationReceipt) {
  expect(validateRehearsalCountPreparationReceipt(receipt, { ...run, forbiddenValues: [] }).errors).toEqual([]);
}

function approvalFor(receipt: RehearsalCountPreparationReceipt, at: string, patch: Record<string, unknown> = {}) {
  const quote = receipt.quote!;
  return JSON.stringify({
    schemaVersion: rehearsalCountPreparationApprovalSchemaVersion,
    dispatchId: receipt.dispatchId,
    approvalId: "host-approval-1",
    approvedAt: at,
    pass: receipt.pass,
    quote: {
      quoteId: quote.quoteId,
      fingerprint: quote.fingerprint,
      membershipFingerprint: quote.membershipFingerprint,
      expiresAt: quote.expiresAt,
    },
    plannedCredits: quote.plannedCredits,
    perKindCost: quote.perKindCost,
    cap: quote.cap,
    authority: { fingerprint: quote.authority.fingerprint, headroom: quote.authority.headroom, observedAt: at },
    ...patch,
  });
}

async function quoted(h: Harness, cap?: number) {
  const receipt = await quoteRehearsalCounts({ admin: h.admin, run, dispatchId, pass, cap, now: h.now });
  expectValid(receipt);
  return receipt;
}

async function acquire(h: Harness, approval: string) {
  const admitted = admitRehearsalCountAcquisition({ approval, pass, dispatchId, now: h.now() });
  const receipt = await acquireRehearsalCounts({ admin: h.admin, run, approval: admitted, now: h.now });
  expectValid(receipt);
  return receipt;
}

function refusalCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof RehearsalCountPreparationRefusal ? error.code : `unexpected:${String(error)}`;
  }
}

const preparationRead = expect.stringMatching(/\/counts\/quote\/[0-9a-f-]{36}\?view=preparation$/);

describe("rehearsal count preparation (AC1)", () => {
  it("quote does not spend or start a batch", async () => {
    const h = harness({ reused: ["OP02:sealed"] });
    const receipt = await quoted(h);
    expect(receipt).toMatchObject({
      mode: "quote",
      outcome: "quoted",
      refusal: null,
      approval: null,
      authority: null,
      acquisition: null,
      accounting: null,
      quote: { plannedCredits: 3, cap: 3, perKindCost: { cards: 2, sealed: 1 }, scopeCount: 2, targetCount: 4 },
    });
    expect(receipt.roster.map((entry) => entry.state)).toEqual(["missing", "missing", "missing", "reused"]);
    expect(receipt.sources).toHaveLength(1);
    expect(h.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `${countsPath}/quote` },
    ]);
    expect(h.send).not.toHaveBeenCalled();
    expectNoBatchWork(h);
  });

  it("quote reports reuse and no-Scrydex as not-required without spend", async () => {
    const h = harness({ reused: ["OP01:cards", "OP01:sealed", "OP02:cards", "OP02:sealed"] });
    const receipt = await quoted(h);
    expect(receipt).toMatchObject({ outcome: "not-required", quote: { plannedCredits: 0 } });
    expect(h.send).not.toHaveBeenCalled();
    expectNoBatchWork(h);
  });

  it("client cap only lowers the server cap and cap/headroom below P refuses before submission", async () => {
    const capped = harness();
    expect(await quoted(capped, 3)).toMatchObject({ outcome: "refused", refusal: "cap-below-planned" });
    const thin = harness({ remaining: 3 });
    expect(await quoted(thin)).toMatchObject({ outcome: "refused", refusal: "headroom-below-planned" });
    const blocked = harness({ blocked: ["OP01:cards"] });
    expect(await quoted(blocked)).toMatchObject({ outcome: "refused", refusal: "blocked-targets" });
    for (const h of [capped, thin, blocked]) {
      expect(h.send).not.toHaveBeenCalled();
      expect(h.acquirePosts()).toBe(0);
      expectNoBatchWork(h);
    }
  });

  it("unbound acquisition refuses", async () => {
    const h = harness();
    const receipt = await quoted(h);
    const at = h.now();
    const approval = (patch: Record<string, unknown> = {}) => approvalFor(receipt, at, patch);
    const admit =
      (value: string, now = at) =>
      () =>
        admitRehearsalCountAcquisition({ approval: value, pass, dispatchId, now });
    expect(refusalCode(admit(""))).toBe("approval-invalid");
    expect(refusalCode(admit("{"))).toBe("approval-invalid");
    expect(refusalCode(admit(approval({ pass: { ...pass, passNumber: 2 } })))).toBe("approval-pass-mismatch");
    expect(refusalCode(admit(approval({ dispatchId: "9224-pass1-lorcana" })))).toBe("approval-dispatch-mismatch");
    expect(refusalCode(admit(approval({ plannedCredits: 0, perKindCost: { cards: 0, sealed: 0 } })))).toBe(
      "nothing-to-acquire",
    );
    expect(refusalCode(admit(approval({ perKindCost: { cards: 2, sealed: 1 } })))).toBe("approval-invalid");
    expect(refusalCode(admit(approval({ cap: 3 })))).toBe("cap-below-planned");
    expect(
      refusalCode(admit(approval({ authority: { fingerprint: "2".repeat(64), headroom: 3, observedAt: at } }))),
    ).toBe("headroom-below-planned");
    expect(refusalCode(admit(approval(), later(15 * 60_000 + 1, at)))).toBe("approval-stale");
    expect(refusalCode(admit(approval({ approvedAt: later(1_000, at) })))).toBe("approval-stale");
    expect(
      refusalCode(
        admit(
          approval({ authority: { fingerprint: "2".repeat(64), headroom: 40, observedAt: later(-16 * 60_000, at) } }),
        ),
      ),
    ).toBe("authority-stale");
    expect(
      refusalCode(admit(approval({ quote: { ...JSON.parse(approval()).quote, expiresAt: at } }), later(1, at))),
    ).toBe("quote-expired");
    expect(h.requests).toHaveLength(1);

    const altered = [
      approval({ quote: { ...JSON.parse(approval()).quote, fingerprint: "f".repeat(64) } }),
      approval({ quote: { ...JSON.parse(approval()).quote, membershipFingerprint: "f".repeat(64) } }),
      approval({ authority: { fingerprint: "f".repeat(64), headroom: 40, observedAt: at } }),
      approval({ plannedCredits: 5, perKindCost: { cards: 3, sealed: 2 }, cap: 5 }),
    ];
    for (const value of altered)
      expect(await acquire(h, value)).toMatchObject({ outcome: "refused", refusal: "quote-binding-mismatch" });
    const missing = approval({ quote: { ...JSON.parse(approval()).quote, quoteId: randomUUID() } });
    expect(await acquire(h, missing)).toMatchObject({
      outcome: "refused",
      refusal: "quote-readback-failed",
      accounting: { status: "unknown", debits: [] },
    });
    expect(h.acquirePosts()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expectNoBatchWork(h);
  });

  it("acquires once through whole-quote admission and reads retained quote debits only", async () => {
    const h = harness({ reused: ["OP02:sealed"] });
    const receipt = await acquire(h, approvalFor(await quoted(h), h.now()));
    expect(receipt).toMatchObject({
      outcome: "complete",
      authority: { state: "allowed", headroom: 40, usageFingerprint: "2".repeat(64) },
      acquisition: {
        admission: "whole-quote",
        response: { status: 200, state: "complete" },
        readback: { status: "read", state: "complete", admission: "ended" },
      },
      accounting: { status: "complete", reason: null },
    });
    expect(receipt.sources).toHaveLength(4);
    expect(receipt.accounting!.debits.map((debit) => [debit.debitId, debit.outcome])).toEqual(
      h.debits.map((debit) => [debit.id, "complete"]),
    );
    expect(h.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `${countsPath}/quote` },
      { method: "GET", path: preparationRead },
      { method: "POST", path: `${countsPath}/acquire` },
      { method: "GET", path: preparationRead },
    ]);
    expect(h.requests[2]!.body).toEqual({
      quoteId: receipt.quote!.quoteId,
      fingerprint: receipt.quote!.fingerprint,
      admission: "whole-quote",
    });
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.fetch.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    expectNoBatchWork(h);
  });
});

describe("rehearsal count preparation current authority (AC2 Probe A)", () => {
  it("headroom drop after quote refuses before acquire with zero sends", async () => {
    // P=2 and headroom 2 at quote time; an unrelated debit then leaves 1 under the same usage fingerprint.
    const h = harness({ remaining: 2, reused: ["OP01:sealed", "OP02:sealed"] });
    const quote = await quoted(h);
    expect(quote).toMatchObject({ outcome: "quoted", quote: { plannedCredits: 2, authority: { headroom: 2 } } });
    const approval = approvalFor(quote, h.now());
    h.spendElsewhere(1);
    const receipt = await acquire(h, approval);
    expect(receipt).toMatchObject({
      outcome: "refused",
      refusal: "headroom-below-planned",
      acquisition: null,
      authority: { state: "allowed", headroom: 1, usageFingerprint: quote.quote!.authority.fingerprint },
      accounting: { status: "complete", debits: [] },
    });
    expect(h.acquirePosts()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.debits).toEqual([]);
    expect(h.allocations.size).toBe(0);
    expectNoBatchWork(h);
  });

  it("a race after the pre-read is refused by locked admission: one recorded submission, zero debits/sends", async () => {
    const h = harness({ remaining: 2, reused: ["OP01:sealed", "OP02:sealed"] });
    const approval = approvalFor(await quoted(h), h.now());
    h.setBeforeAcquire(() => h.spendElsewhere(1));
    const receipt = await acquire(h, approval);
    expect(receipt).toMatchObject({
      outcome: "admission-refused",
      acquisition: { response: { status: 409, state: null }, readback: { status: "read", admission: "none" } },
      accounting: { status: "complete", debits: [] },
    });
    expect(h.acquirePosts()).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.allocations.size).toBe(0);
  });

  it("a concurrent execution's in-flight debits leave the losing submission a locked refusal", async () => {
    const h = harness();
    const quote = await quoted(h);
    const approval = approvalFor(quote, h.now());
    const quoteId = quote.quote!.quoteId;
    const query = countQuery("OP01", "cards");
    const inFlight = randomUUID();
    // Another invocation admits this quote after the pre-read and is mid-send when this one reads back.
    h.setBeforeAcquire(() => {
      h.allocations.set(quoteId, { executionId: randomUUID(), planned: 4, at: h.now(), endedAt: null });
      h.debits.push({
        id: inFlight,
        quoteId,
        scopeRecordId: "scope-op01",
        kind: query.kind,
        queryKey: countQueryKey(query),
        debitedAt: h.now(),
        outcome: null,
        source: null,
      });
    });
    const receipt = await acquire(h, approval);
    expect(receipt).toMatchObject({
      outcome: "admission-refused",
      acquisition: { response: { status: 409, state: null }, readback: { status: "read", admission: "active" } },
      accounting: { status: "complete", debits: [{ debitId: inFlight, outcome: "acquiring" }] },
    });
    expect(h.acquirePosts()).toBe(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("changed or unknown current authority refuses before submission", async () => {
    const changed = harness();
    const approval = approvalFor(await quoted(changed), changed.now());
    changed.setAuthority("9".repeat(64));
    expect(await acquire(changed, approval)).toMatchObject({ outcome: "refused", refusal: "authority-changed" });
    const unknown = harness();
    const second = approvalFor(await quoted(unknown), unknown.now());
    unknown.overrideProjection((view) => ({
      ...view,
      currentAuthority: { ...(view.currentAuthority as object), state: "unknown", headroom: null },
    }));
    expect(await acquire(unknown, second)).toMatchObject({ outcome: "refused", refusal: "authority-unavailable" });
    const unaccounted = harness();
    const third = approvalFor(await quoted(unaccounted), unaccounted.now());
    unaccounted.overrideProjection((view) => ({
      ...view,
      debits: { ...(view.debits as object), status: "unknown", reason: "invalid-row" },
    }));
    expect(await acquire(unaccounted, third)).toMatchObject({ outcome: "refused", refusal: "accounting-unavailable" });
    for (const h of [changed, unknown, unaccounted]) {
      expect(h.acquirePosts()).toBe(0);
      expect(h.send).not.toHaveBeenCalled();
    }
  });
});

describe("rehearsal count preparation stops (AC3)", () => {
  it("refuses drift: membership/profile and exact-query drift are refused by admission without sends", async () => {
    for (const drift of ["membership", "query"] as const) {
      const h = harness();
      const approval = approvalFor(await quoted(h), h.now());
      if (drift === "membership") h.setMembership("9".repeat(64));
      else h.driftQuery();
      const receipt = await acquire(h, approval);
      expect(receipt).toMatchObject({
        outcome: "admission-refused",
        acquisition: { response: { status: 409, state: null } },
        accounting: { status: "complete", debits: [] },
      });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.acquirePosts()).toBe(1);
      expectNoBatchWork(h);
    }
    const expiring = harness();
    const approval = approvalFor(await quoted(expiring), expiring.now());
    const admitted = admitRehearsalCountAcquisition({ approval, pass, dispatchId, now: expiring.now() });
    expiring.advance(15 * 60_000 + 1);
    expect(
      await acquireRehearsalCounts({ admin: expiring.admin, run, approval: admitted, now: expiring.now }),
    ).toMatchObject({ outcome: "refused", refusal: "quote-expired" });
    expect(expiring.acquirePosts()).toBe(0);
  });

  it("partial failure and uncertainty stop with every retained debit identity and no reacquire", async () => {
    for (const [fault, outcome, rows] of [
      ["fail-second-send", "failed", ["complete", "failed"]],
      ["uncertain-first-send", "uncertain", ["uncertain"]],
      ["lose-first-result", "uncertain", ["acquiring"]],
    ] as const) {
      const h = harness();
      const approval = approvalFor(await quoted(h), h.now());
      h.setFault(fault);
      const receipt = await acquire(h, approval);
      expect(receipt.outcome, fault).toBe(outcome);
      expect(h.send).toHaveBeenCalledTimes(rows.length);
      expect(receipt.accounting).toMatchObject({ status: "complete", reason: null });
      expect(receipt.accounting!.debits.map((debit) => [debit.debitId, debit.outcome])).toEqual(
        h.debits.map((debit, index) => [debit.id, rows[index]]),
      );
      expect(receipt.accounting!.debits.filter((debit) => debit.outcome !== "complete")).toEqual(
        receipt
          .accounting!.debits.filter((debit) => debit.outcome !== "complete")
          .map((debit) => ({ ...debit, observedAt: null, expiresAt: null })),
      );
      expect(receipt.acquisition?.readback.admission).toBe("ended");
      const replay = await acquire(h, approval);
      expect(replay).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
      expect(replay.accounting!.debits).toHaveLength(rows.length);
      expect(h.acquirePosts()).toBe(1);
      expect(h.send).toHaveBeenCalledTimes(rows.length);
      expectNoBatchWork(h);
    }
  });

  it("interrupted acquisition and unavailable readback stop; unknown accounting is never zero spend", async () => {
    const lost = harness();
    const approval = approvalFor(await quoted(lost), lost.now());
    lost.setTransportFault((path) => (path.endsWith("/acquire") ? "lose-response" : null));
    const interrupted = await acquire(lost, approval);
    expect(interrupted).toMatchObject({
      outcome: "uncertain",
      acquisition: { response: { status: null, state: null }, readback: { status: "read", state: "complete" } },
      accounting: { status: "complete" },
    });
    expect(interrupted.accounting!.debits).toHaveLength(4);
    expect(lost.send).toHaveBeenCalledTimes(4);

    const unread = harness();
    const second = approvalFor(await quoted(unread), unread.now());
    unread.setTransportFault((path, method, index) => (method === "GET" && index > 3 ? "throw" : null));
    const unreadable = await acquire(unread, second);
    expect(unreadable).toMatchObject({
      outcome: "readback-failed",
      acquisition: { readback: { status: "failed", state: null, admission: null } },
      accounting: { status: "unknown", reason: "readback-failed", debits: [] },
    });
    expect(unread.debits).toHaveLength(4);

    const truncated = harness();
    const third = approvalFor(await quoted(truncated), truncated.now());
    let reads = 0;
    truncated.overrideProjection((view) =>
      ++reads === 1 ? view : { ...view, debits: { ...(view.debits as object), status: "unknown", reason: "overflow" } },
    );
    expect(await acquire(truncated, third)).toMatchObject({
      outcome: "partial",
      accounting: { status: "unknown", reason: "overflow" },
    });
    for (const h of [lost, unread, truncated]) {
      expect(h.acquirePosts()).toBe(1);
      expectNoBatchWork(h);
    }
  });

  it("same-total other-source and stale/future readback evidence never count as complete", async () => {
    const swaps: ((source: ScrydexCountSource, at: string) => ScrydexCountSource)[] = [
      (source) => ({ ...source, query: countQuery(source.query.parentValue, source.query.kind, "ja") }),
      (source, at) => ({ ...source, observedAt: later(-15 * 60_000 - 1, at) }),
      (source, at) => ({ ...source, observedAt: later(1_000, at), expiresAt: later(15 * 60_000, at) }),
    ];
    for (const swap of swaps) {
      const h = harness();
      const approval = approvalFor(await quoted(h), h.now());
      h.overrideReadback((targets) =>
        targets.map((target, index) =>
          index === 0 && target.source ? { ...target, source: swap(target.source, h.now()) } : target,
        ),
      );
      const receipt = await acquire(h, approval);
      expect(receipt.outcome).toBe("partial");
      expect(receipt.sources).toHaveLength(3);
      expect(receipt.accounting!.debits).toHaveLength(4);
      expect(h.acquirePosts()).toBe(1);
      expectNoBatchWork(h);
    }
  });

  it("stripping the admission mode cannot reuse or bypass an admitted quote", async () => {
    const h = harness();
    const quote = await quoted(h);
    h.setFault("fail-second-send");
    await acquire(h, approvalFor(quote, h.now()));
    const sends = h.send.mock.calls.length;
    const second = await h.admin.acquire({ quoteId: quote.quote!.quoteId, fingerprint: quote.quote!.fingerprint });
    expect(second.status).toBe(409);
    expect(h.requests.at(-1)!.body).toEqual({
      quoteId: quote.quote!.quoteId,
      fingerprint: quote.quote!.fingerprint,
      admission: "whole-quote",
    });
    const raw = await h.fetch(`${origin}${countsPath}/acquire`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ quoteId: quote.quote!.quoteId, fingerprint: quote.quote!.fingerprint }),
    });
    expect(((await raw.json()) as { state?: string }).state).toBe("failed");
    expect(h.send).toHaveBeenCalledTimes(sends);
  });
});

// N2: each control removes one changed guard from the executed preparation
// module and proves the same scenario's oracle then observes the defect.
describe("rehearsal count preparation guard-removal controls (N2)", () => {
  afterEach(() => {
    vi.doUnmock("../domain/rehearsal-count-preparation-receipt");
    vi.resetModules();
  });
  async function mutant(patch: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("../domain/rehearsal-count-preparation-receipt", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      ...patch,
    }));
    return import("./rehearsal-count-preparation");
  }

  it("without the current-headroom admission guard, Probe A submits the underfunded quote", async () => {
    const guarded = harness({ remaining: 2, reused: ["OP01:sealed", "OP02:sealed"] });
    const approval = approvalFor(await quoted(guarded), guarded.now());
    guarded.spendElsewhere(1);
    expect((await acquire(guarded, approval)).refusal).toBe("headroom-below-planned");
    expect(guarded.acquirePosts()).toBe(0);

    const removed = await mutant({ rehearsalCountAdmissionRefusal: () => null });
    const h = harness({ remaining: 2, reused: ["OP01:sealed", "OP02:sealed"] });
    const second = approvalFor(await quoted(h), h.now());
    h.spendElsewhere(1);
    const admitted = admitRehearsalCountAcquisition({ approval: second, pass, dispatchId, now: h.now() });
    const receipt = await removed.acquireRehearsalCounts({ admin: h.admin, run, approval: admitted, now: h.now });
    expect(h.acquirePosts()).toBe(1);
    expect(receipt.outcome).toBe("admission-refused");
    expect(validateRehearsalCountPreparationReceipt(receipt, { ...run, forbiddenValues: [] }).errors).toContain(
      "submission-requires-current-authority",
    );
  });

  it("without the complete/partial classifier, a failed acquisition is refused by the receipt gate", async () => {
    const removed = await mutant({ rehearsalCountAcquisitionOutcome: () => "complete" });
    const h = harness();
    const approval = approvalFor(await quoted(h), h.now());
    h.setFault("fail-second-send");
    const admitted = admitRehearsalCountAcquisition({ approval, pass, dispatchId, now: h.now() });
    const receipt = await removed.acquireRehearsalCounts({ admin: h.admin, run, approval: admitted, now: h.now });
    expect(receipt.outcome).toBe("complete");
    const verdict = validateRehearsalCountPreparationReceipt(receipt, { ...run, forbiddenValues: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual(
      expect.arrayContaining(["complete-requires-complete-acquisition", "complete-requires-complete-debits"]),
    );
  });
});

describe("rehearsal count Admin client bounds", () => {
  it("bounds reads for a maximum 10000-target quote, refuses overflow and never follows redirects", async () => {
    const target = {
      scopeRecordId: `scope-${"x".repeat(58)}`,
      query: { ...countQuery("OP01", "cards"), environment: "e".repeat(32), accountRevision: "r".repeat(64) },
      source: null,
      blocked: false,
    };
    target.query.profileKey = "p".repeat(96);
    const debit = {
      quoteId: randomUUID(),
      scopeRecordId: target.scopeRecordId,
      kind: "cards",
      queryFingerprint: "f".repeat(64),
      debitId: randomUUID(),
      credits: 1,
      debitedAt: start,
      outcome: "complete",
      observedAt: start,
      expiresAt: start,
    };
    const body = JSON.stringify({
      quote: { quoteId: randomUUID(), targets: Array.from({ length: 10_000 }, () => target) },
      debits: { rows: Array.from({ length: 10_000 }, () => debit) },
    });
    expect(Buffer.byteLength(body)).toBeLessThan(rehearsalCountAdminMaxResponseBytes / 2);
    const fits = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: async () => new Response(body, { status: 200 }),
    });
    expect((await fits.readPreparation(randomUUID())).status).toBe(200);

    const overflow = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: async () => new Response("x".repeat(64), { status: 200 }),
      maxResponseBytes: 32,
    });
    expect(await quoteRehearsalCounts({ admin: overflow, run, dispatchId, pass, now: () => start })).toMatchObject({
      outcome: "refused",
      refusal: "response-overflow",
      quote: null,
    });

    const redirect = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
    );
    const redirected = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: redirect,
    });
    expect(await quoteRehearsalCounts({ admin: redirected, run, dispatchId, pass, now: () => start })).toMatchObject({
      outcome: "refused",
      refusal: "quote-unavailable",
    });
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
