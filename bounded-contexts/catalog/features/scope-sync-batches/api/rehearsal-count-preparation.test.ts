import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { scopeSyncBatchRoutes } from "./route";
import { createCountAcquisition, type CountAcquisitionLedger } from "./count-acquisition";
import type { ScopeSyncBatchServices } from "./runtime";
import { scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import {
  CountAcquisitionRefused,
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

type Fault = "none" | "fail-second-send" | "uncertain-first-send";

// Real routes and the real count engine; the provider send and every batch,
// preview, confirm, usage-history and held-set service is a counting trap.
function harness(options: { remaining?: number; reused?: readonly string[]; blocked?: readonly string[] } = {}) {
  let clock = start;
  let membership = "1".repeat(64);
  let authorityFingerprint = "2".repeat(64);
  let fault: Fault = "none";
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
  const debits: { id: string; quoteId: string; key: string; outcome: string | null }[] = [];
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
  let readbackOverride: ((targets: CountQuote["targets"]) => CountQuote["targets"]) | null = null;
  const send = vi.fn(async () => {
    const calls = send.mock.calls.length;
    if (fault === "fail-second-send" && calls === 2) throw new Error("synthetic provider failure");
    if (fault === "uncertain-first-send" && calls === 1) throw new TypeError("synthetic transport failure");
    return { totalCount: 121, pageSize: 100, returnedPage: 1 as const, returnedItemCount: 100, observedAt: clock };
  });
  const ledger: CountAcquisitionLedger = {
    authority: async () => ({
      fingerprint: authorityFingerprint,
      headroom: remaining - debits.length,
      allowed: true,
    }),
    saveQuote: async (quote) => {
      quotes.set(quote.quoteId, quote);
    },
    loadQuote: async (quoteId) => {
      const quote = quotes.get(quoteId);
      if (!quote) throw new CountAcquisitionRefused();
      return quote;
    },
    approve: async (quoteId, fingerprint) => {
      const quote = quotes.get(quoteId);
      if (!quote || quote.fingerprint !== fingerprint || Date.parse(quote.expiresAt) < Date.parse(clock))
        throw new CountAcquisitionRefused();
      approved.add(quoteId);
      return quote;
    },
    claim: async (quote, target) => {
      if (current(target.query)) return null;
      const key = `${target.query.parentValue}:${target.query.kind}`;
      const own = debits.filter((debit) => debit.quoteId === quote.quoteId);
      if (own.some((debit) => debit.key === key) || own.length >= quote.cap || debits.length >= remaining)
        throw new CountAcquisitionRefused();
      const id = randomUUID();
      debits.push({ id, quoteId: quote.quoteId, key, outcome: null });
      return id;
    },
    result: async (debitId, _quoteId, query, outcome, source) => {
      debits.find((debit) => debit.id === debitId)!.outcome = outcome;
      if (outcome === "complete" && source) evidence.set(countQueryKey(query), source);
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
    acquireCounts: (input: { quoteId: string; fingerprint: string }) => engine.acquire({ ...input, owner: "owner" }),
    getCountQuote: async (input: { quoteId: string }) => {
      const quote = quotes.get(input.quoteId);
      if (!quote) throw new CountAcquisitionRefused();
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
    },
  } as unknown as ScopeSyncBatchServices;
  const root = new Hono<{ Variables: { context: EventStoreContext; actor: ResolvedActor | null } }>();
  root.use("*", async (c, next) => {
    c.set("context", context);
    c.set("actor", actor);
    await next();
  });
  root.route("/api/catalog/scope-sync-batches", scopeSyncBatchRoutes(services));
  const requests: { method: string; path: string }[] = [];
  let transportFault: ((path: string, method: string, index: number) => "lose-response" | "throw" | null) | null = null;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error("loopback isolation: unexpected origin");
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
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
    now: () => clock,
    advance: (ms: number) => {
      clock = later(ms, clock);
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
    setTransportFault: (value: typeof transportFault) => {
      transportFault = value;
    },
    overrideReadback: (value: typeof readbackOverride) => {
      readbackOverride = value;
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

describe("rehearsal count preparation (AC1)", () => {
  it("quote does not spend or start a batch", async () => {
    const h = harness({ reused: ["OP02:sealed"] });
    const receipt = await quoted(h);
    expect(receipt).toMatchObject({
      mode: "quote",
      outcome: "quoted",
      refusal: null,
      approval: null,
      acquisition: null,
      quote: { plannedCredits: 3, cap: 3, perKindCost: { cards: 2, sealed: 1 }, scopeCount: 2, targetCount: 4 },
    });
    expect(receipt.roster.map((entry) => entry.state)).toEqual(["missing", "missing", "missing", "reused"]);
    expect(receipt.sources).toHaveLength(1);
    expect(h.requests).toEqual([{ method: "POST", path: `${countsPath}/quote` }]);
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
    expect(await acquire(h, missing)).toMatchObject({ outcome: "refused", refusal: "quote-readback-failed" });
    expect(h.acquirePosts()).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expectNoBatchWork(h);
  });

  it("acquires once through the existing action and reads retained results only", async () => {
    const h = harness({ reused: ["OP02:sealed"] });
    const receipt = await acquire(h, approvalFor(await quoted(h), h.now()));
    expect(receipt).toMatchObject({
      outcome: "complete",
      acquisition: { response: { status: 200, state: "complete" }, readback: { status: "read", state: "complete" } },
    });
    expect(receipt.sources).toHaveLength(4);
    expect(receipt.debits).toHaveLength(3);
    expect(h.requests).toEqual([
      { method: "POST", path: `${countsPath}/quote` },
      { method: "GET", path: expect.stringMatching(/\/counts\/quote\/[0-9a-f-]{36}$/) },
      { method: "POST", path: `${countsPath}/acquire` },
      { method: "GET", path: expect.stringMatching(/\/counts\/quote\/[0-9a-f-]{36}$/) },
    ]);
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.fetch.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    expectNoBatchWork(h);
  });
});

describe("rehearsal count preparation stops (AC3)", () => {
  it("refuses drift: membership, profile/query and authority drift stop without sends", async () => {
    for (const drift of ["membership", "authority"] as const) {
      const h = harness();
      const approval = approvalFor(await quoted(h), h.now());
      if (drift === "membership") h.setMembership("9".repeat(64));
      else h.setAuthority("9".repeat(64));
      const receipt = await acquire(h, approval);
      expect(receipt).toMatchObject({ outcome: "failed", acquisition: { response: { status: 409, state: null } } });
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

  it("partial failure and uncertainty stop with retained debits and no reacquire", async () => {
    for (const [fault, outcome, sends] of [
      ["fail-second-send", "failed", 2],
      ["uncertain-first-send", "uncertain", 1],
    ] as const) {
      const h = harness();
      const approval = approvalFor(await quoted(h), h.now());
      h.setFault(fault);
      const receipt = await acquire(h, approval);
      expect(receipt.outcome).toBe(outcome);
      expect(receipt.acquisition?.readback.state).toBe(outcome);
      expect(h.send).toHaveBeenCalledTimes(sends);
      expect(h.debits).toHaveLength(sends);
      expect(receipt.debits).toHaveLength(outcome === "failed" ? 1 : 0);
      const replay = await acquire(h, approval);
      expect(replay).toMatchObject({ outcome: "refused", refusal: "quote-not-pending" });
      expect(h.acquirePosts()).toBe(1);
      expect(h.send).toHaveBeenCalledTimes(sends);
      expectNoBatchWork(h);
    }
  });

  it("interrupted acquisition and readback failure stop even when the server completed", async () => {
    const lost = harness();
    const approval = approvalFor(await quoted(lost), lost.now());
    lost.setTransportFault((path) => (path.endsWith("/acquire") ? "lose-response" : null));
    const interrupted = await acquire(lost, approval);
    expect(interrupted).toMatchObject({
      outcome: "uncertain",
      acquisition: { response: { status: null, state: null }, readback: { status: "read", state: "complete" } },
    });
    expect(lost.send).toHaveBeenCalledTimes(4);

    const unread = harness();
    const second = approvalFor(await quoted(unread), unread.now());
    unread.setTransportFault((path, method, index) => (method === "GET" && index > 3 ? "throw" : null));
    expect(await acquire(unread, second)).toMatchObject({
      outcome: "readback-failed",
      acquisition: { readback: { status: "failed", state: null } },
    });
    for (const h of [lost, unread]) {
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
      expect(h.acquirePosts()).toBe(1);
      expectNoBatchWork(h);
    }
  });

  it("guard-disabled replay and partial-success negatives fail", async () => {
    const h = harness();
    const approval = approvalFor(await quoted(h), h.now());
    h.setFault("fail-second-send");
    const partial = await acquire(h, approval);
    // Disabled completion guard: the same evidence relabelled complete is refused by the receipt gate.
    const relabelled = { ...partial, outcome: "complete" as const };
    expect(validateRehearsalCountPreparationReceipt(relabelled, { ...run, forbiddenValues: [] }).ok).toBe(false);
    // Disabled replay guard: a second direct submission is visible to the single-submission oracle.
    await h.admin.acquire({ quoteId: partial.quote!.quoteId, fingerprint: partial.quote!.fingerprint });
    expect(() => expect(h.acquirePosts()).toBe(1)).toThrow();
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
    const body = JSON.stringify({ quoteId: randomUUID(), targets: Array.from({ length: 10_000 }, () => target) });
    expect(Buffer.byteLength(body)).toBeLessThan(rehearsalCountAdminMaxResponseBytes / 2);
    const fits = createRehearsalCountAdminClient({
      origin,
      cookie: "chase_sets_session=synthetic",
      fetch: async () => new Response(body, { status: 200 }),
    });
    expect((await fits.readQuote(randomUUID())).status).toBe(200);

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
