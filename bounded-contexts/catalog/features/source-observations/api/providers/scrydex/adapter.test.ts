import { describe, expect, it, vi } from "vitest";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type ScrydexOnePieceCredentials,
} from "./adapter";

// Every credential, identifier, URL, and usage value below is synthetic. The usage
// body follows the real Scrydex `data` envelope captured by the host on 2026-10-09.
const syntheticCredentials = {
  apiKey: "synthetic-scrydex-api-key-8427",
  teamId: "synthetic-scrydex-team-8427",
} as const satisfies ScrydexOnePieceCredentials;
const syntheticBaseUrl = "https://synthetic-scrydex.invalid/onepiece/v1";
const observedAt = new Date("2026-10-09T12:00:00.000Z");
const forbiddenValues = [
  syntheticCredentials.apiKey,
  syntheticCredentials.teamId,
  "synthetic-account-8427",
  "synthetic-owner@example.invalid",
  "synthetic-billing.invalid",
  "synthetic-scrydex.invalid",
  "synthetic-plan-tier",
  "2026-09-22",
  "2026-10-22",
  "2026-10-01",
];
const forbiddenFieldNames = [
  "account_id",
  "team_id",
  "api_key",
  "email",
  "invoice_url",
  "plan",
  "overage",
  "daily_usage",
  "period",
  "credits_consumed",
];

function syntheticUsageBody(dataOverrides: Record<string, unknown> = {}) {
  return {
    data: {
      total_credits_consumed: 8_766,
      overage_credits_consumed: 0,
      credits_remaining: 41_234,
      period_start: "2026-09-22T19:39:46.000Z",
      period_end: "2026-10-22T19:39:46.000Z",
      daily_usage: [{ date: "2026-10-01", credits_consumed: 8_766 }],
      account_id: "synthetic-account-8427",
      email: "synthetic-owner@example.invalid",
      ...dataOverrides,
    },
    team_id: syntheticCredentials.teamId,
    api_key: syntheticCredentials.apiKey,
    plan: "synthetic-plan-tier",
    invoice_url: "https://synthetic-billing.invalid/invoices/synthetic",
  };
}

function usageAdapter(input: {
  body?: unknown;
  status?: number;
  credentials?: ScrydexOnePieceCredentials;
  now?: () => Date;
}) {
  const fetch = vi.fn(async (request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(new URL(String(request)).pathname).toBe("/account/v1/usage");
    expect(new Headers(init?.headers).get("X-Api-Key")).toBe((input.credentials ?? syntheticCredentials).apiKey);
    return Response.json(input.body ?? syntheticUsageBody(), { status: input.status ?? 200 });
  });
  const adapter = createScrydexOnePieceProviderAdapter({
    credentials: input.credentials ?? syntheticCredentials,
    baseUrl: syntheticBaseUrl,
    fetch,
    now: input.now ?? (() => observedAt),
  });
  return { adapter, fetch };
}

describe("Scrydex usage snapshot boundary", () => {
  it("retains only redacted balance fields, state, observed-at, and lag diagnostics", async () => {
    const { adapter, fetch } = usageAdapter({});

    const snapshot = await adapter.getUsageSnapshot();

    expect(snapshot).toStrictEqual({
      providerKey: "scrydex",
      creditUnit: "credits",
      creditState: "available",
      totalCredits: 50_000,
      remainingCredits: 41_234,
      usedCredits: 8_766,
      observedAt: observedAt.toISOString(),
      attemptedAt: observedAt.toISOString(),
      attemptState: "checked",
      providerUpdatedAt: null,
      lagCategory: "documented-window",
      diagnosticCode: null,
      diagnostic: "Scrydex account usage check completed with redacted credit evidence.",
      freshWithinSeconds: 900,
      unavailableAfterSeconds: 3600,
    });
    const retained = JSON.stringify(snapshot);
    for (const value of forbiddenValues) expect(retained).not.toContain(value);
    for (const field of forbiddenFieldNames) expect(retained).not.toContain(field);
    expect(retained).not.toMatch(/https?:\/\//);

    const diagnostics = JSON.stringify([
      await adapter.getTransportDiagnostics(),
      await adapter.getCredentialReadiness(),
    ]);
    for (const value of forbiddenValues) expect(diagnostics).not.toContain(value);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records the documented lag window because Scrydex reports no usage update timestamp", async () => {
    const { adapter } = usageAdapter({ body: syntheticUsageBody({ updated_at: "2026-10-09T11:59:00.000Z" }) });

    expect(await adapter.getUsageSnapshot()).toMatchObject({
      lagCategory: "documented-window",
      providerUpdatedAt: null,
    });
  });

  it.each([
    ["without the data envelope", { total_credits: 50_000, remaining_credits: 41_234, used_credits: 8_766 }],
    ["without remaining credits", syntheticUsageBody({ credits_remaining: undefined })],
    ["with a non-numeric balance", syntheticUsageBody({ credits_remaining: "41234" })],
    ["for a billing period that has ended", syntheticUsageBody({ period_end: "2026-10-09T11:00:00.000Z" })],
    ["without billing period bounds", syntheticUsageBody({ period_start: undefined })],
  ])("keeps a usage response %s unknown instead of zero or exhausted", async (_case, body) => {
    const { adapter } = usageAdapter({ body });

    expect(await adapter.getUsageSnapshot()).toMatchObject({
      attemptState: "checked",
      creditState: "unknown",
      totalCredits: null,
      remainingCredits: null,
      diagnostic:
        "Scrydex account usage response did not include remaining-credit evidence for the current billing period.",
    });
  });

  it("leaves the allowance unreported when overage or consumed evidence is missing", async () => {
    const overage = usageAdapter({ body: syntheticUsageBody({ overage_credits_consumed: 12, credits_remaining: 3 }) });
    const noConsumed = usageAdapter({ body: syntheticUsageBody({ total_credits_consumed: undefined }) });

    expect(await overage.adapter.getUsageSnapshot()).toMatchObject({
      creditState: "available",
      totalCredits: null,
      remainingCredits: 3,
      usedCredits: 8_766,
      diagnostic: expect.stringContaining("overage credits consumed"),
    });
    expect(await noConsumed.adapter.getUsageSnapshot()).toMatchObject({
      creditState: "available",
      totalCredits: null,
      remainingCredits: 41_234,
      usedCredits: null,
      diagnostic: expect.stringContaining("allowance is unreported"),
    });
  });

  it("leaves the allowance unreported when the derived sum is not a representable count", async () => {
    // Synthetic range controls, not claims about real Scrydex balances: each operand is a
    // safe integer but their sum is not, and 1e308 operands sum to Infinity.
    const largestSafe = Number.MAX_SAFE_INTEGER;
    const unsafeSum = usageAdapter({
      body: syntheticUsageBody({ total_credits_consumed: largestSafe, credits_remaining: largestSafe }),
    });
    const overflow = usageAdapter({
      body: syntheticUsageBody({ total_credits_consumed: 1e308, credits_remaining: 1e308 }),
    });

    const unsafeSnapshot = await unsafeSum.adapter.getUsageSnapshot();
    expect(unsafeSnapshot).toMatchObject({
      creditState: "available",
      totalCredits: null,
      remainingCredits: largestSafe,
      usedCredits: largestSafe,
      diagnostic: expect.stringContaining("allowance is unreported"),
    });

    const overflowSnapshot = await overflow.adapter.getUsageSnapshot();
    for (const snapshot of [unsafeSnapshot, overflowSnapshot]) {
      for (const count of [snapshot!.totalCredits, snapshot!.remainingCredits, snapshot!.usedCredits]) {
        expect(count === null || Number.isSafeInteger(count)).toBe(true);
      }
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    }
    expect(overflowSnapshot).toMatchObject({ creditState: "unknown", totalCredits: null, remainingCredits: null });
  });

  it("reports zero remaining credits as exhausted and a tenth or less as low", async () => {
    const exhausted = usageAdapter({ body: syntheticUsageBody({ credits_remaining: 0 }) });
    const low = usageAdapter({
      body: syntheticUsageBody({ total_credits_consumed: 45_000, credits_remaining: 5_000 }),
    });

    expect(await exhausted.adapter.getUsageSnapshot()).toMatchObject({ creditState: "exhausted", remainingCredits: 0 });
    expect(await low.adapter.getUsageSnapshot()).toMatchObject({ creditState: "low", totalCredits: 50_000 });
  });

  it("reports a failed read as unavailable with no observed balance", async () => {
    const { adapter } = usageAdapter({ status: 503, body: { error: "synthetic-maintenance", account_id: "x" } });

    const snapshot = await adapter.getUsageSnapshot();

    expect(snapshot).toMatchObject({
      attemptState: "unavailable",
      observedAt: null,
      attemptedAt: observedAt.toISOString(),
      lagCategory: "unobserved",
      creditState: "unknown",
      remainingCredits: null,
      totalCredits: null,
      diagnosticCode: "provider-degraded",
    });
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-maintenance");
  });

  it("never sends a usage request without credentials", async () => {
    const { adapter, fetch } = usageAdapter({ credentials: {} });

    expect(await adapter.getUsageSnapshot()).toMatchObject({
      attemptState: "not-configured",
      observedAt: null,
      attemptedAt: null,
      diagnosticCode: "credential-missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("isolates snapshots per adapter credentials and keeps import planning live", async () => {
    const first = usageAdapter({});
    const second = usageAdapter({
      credentials: { apiKey: "synthetic-scrydex-api-key-other", teamId: "synthetic-scrydex-team-other" },
      body: syntheticUsageBody({ credits_remaining: 7 }),
    });

    expect((await first.adapter.getUsageSnapshot()).remainingCredits).toBe(41_234);
    expect((await second.adapter.getUsageSnapshot()).remainingCredits).toBe(7);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(second.fetch).toHaveBeenCalledTimes(1);

    const scope = {
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-reference",
      values: { expansionId: "synthetic-op-01" },
    };
    await first.adapter.planImport(scope);
    await first.adapter.planImport(scope);
    expect(first.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("accepted set-name coordinates", () => {
  function adapter() {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      expect(new URL(String(request)).pathname).toBe("/account/v1/usage");
      throw new Error("synthetic denied provider fetch");
    });
    return {
      adapter: createScrydexOnePieceProviderAdapter({
        credentials: syntheticCredentials,
        baseUrl: syntheticBaseUrl,
        fetch,
        now: () => observedAt,
        countReader: { read: async () => null },
        countEnvironment: "test",
        countAccountRevision: "synthetic-revision",
        cacheStore: { read: async () => null, write: vi.fn() },
      }),
      fetch,
    };
  }

  it.each([
    [SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY, "scrydex:one-piece:set:op-01"],
    [SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "scrydex:one-piece:expansion:op-01:cards"],
    [SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "scrydex:one-piece:expansion:op-01:sealed"],
    [SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, "scrydex:lorcana:set:1"],
    [SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "scrydex:lorcana:expansion:1:cards"],
  ])("plans %s from the accepted setName coordinate", async (unitKey, planKey) => {
    const subject = adapter();
    const plan = await subject.adapter.planImport({
      unitKey,
      scopeKey: "synthetic",
      values: { setName: unitKey.includes("lorcana") ? "1" : "op-01" },
    });

    expect(plan.planKey).toBe(planKey);
    expect(subject.fetch).toHaveBeenCalledOnce();
    expect(subject.fetch.mock.calls[0]?.[0]).toContain("/account/v1/usage");
  });

  it("keeps explicit coordinates authoritative over setName and refuses blank explicit keys", async () => {
    const subject = adapter();
    await expect(
      subject.adapter.planImport({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        scopeKey: "synthetic",
        values: { expansionId: "explicit", setName: "accepted" },
      }),
    ).resolves.toMatchObject({ planKey: "scrydex:one-piece:set:explicit" });
    await expect(
      subject.adapter.planImport({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        scopeKey: "synthetic",
        values: { expansionId: "", setName: "accepted" },
      }),
    ).rejects.toThrow("requires expansionId");
    await expect(
      subject.adapter.planImport({
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        scopeKey: "synthetic",
        values: { cardId: "", setName: "accepted" },
      }),
    ).rejects.toThrow("requires cardId");
    await expect(
      subject.adapter.planImport({
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        scopeKey: "synthetic",
        values: { sealedProductId: "", setName: "accepted" },
      }),
    ).rejects.toThrow("requires sealedProductId");
  });
});

import {
  acquireScrydexPageOneCount,
  scrydexCountQuery,
  validateScrydexCountPage,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as sealedUnit,
} from "./adapter";
import type { ScrydexCountEvidence } from "../../../../scope-sync-batches/domain/count-acquisition";
import {
  cacheKeyForProviderOptionQuery,
  type CatalogProviderOptionQueryCacheRecord,
} from "../provider-option-query-cache";
import { createServer } from "node:http";
import { once } from "node:events";

// Derived from #9431 receipt c6127099375. Items are synthetic; envelope keys/values are captured.
const cards = { count: 100, data: Array.from({ length: 100 }, () => ({})), page: 1, page_size: 100, total_count: 121 };
const sealed = { count: 7, data: Array.from({ length: 7 }, () => ({})), page: 1, page_size: 100, total_count: 7 };

describe("#9424 exact sealed expansion estimates", () => {
  const scope = {
    unitKey: sealedUnit,
    scopeKey: "expansion-sealed-products",
    values: { expansionId: "OP01", language: "en" },
  };
  const query = scrydexCountQuery({
    environment: "test",
    accountRevision: "synthetic-revision",
    productDomain: "one-piece",
    profileKey: "one-piece-sealed-product-source-observation",
    profileVersion: "2026.06.22",
    unitKey: sealedUnit,
    kind: "sealed",
    languageCode: "en",
    parentValue: "OP01",
  });
  const request = {
    providerKey: "scrydex",
    profileKey: query.profileKey,
    profileVersion: query.profileVersion,
    ingestionUnitKey: sealedUnit,
    queryKind: "sealed-products",
    languageCode: "en",
    parentValue: "OP01",
  };
  function evidence(patch: Partial<ScrydexCountEvidence> = {}): ScrydexCountEvidence {
    return {
      query,
      validationKind: "page-1-count",
      sourceId: "synthetic-sealed-debit",
      totalCount: 121,
      pageSize: 100,
      returnedPage: 1,
      returnedItemCount: 100,
      observedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + 900_000).toISOString(),
      ...patch,
    };
  }
  function cache(patch: Partial<CatalogProviderOptionQueryCacheRecord> = {}): CatalogProviderOptionQueryCacheRecord {
    return {
      ...request,
      cacheKey: cacheKeyForProviderOptionQuery(request),
      items: Array.from({ length: 3 }, (_, i) => ({
        providerKey: "scrydex",
        queryKind: "sealed-products",
        value: `synthetic-${i}`,
        label: `Synthetic ${i}`,
        parentValue: "OP01",
        description: null,
        imageUrl: null,
        aliases: [],
        metadata: {},
      })),
      itemCount: 3,
      totalCount: 3,
      pageSize: 2,
      fetchedAt: observedAt.toISOString(),
      expiresAt: new Date(observedAt.getTime() + 900_000).toISOString(),
      staleUntil: new Date(observedAt.getTime() + 86_400_000).toISOString(),
      diagnosticCode: null,
      diagnosticText: null,
      ...patch,
    };
  }
  function fixture(
    source: ScrydexCountEvidence | null,
    completed: CatalogProviderOptionQueryCacheRecord | null = null,
  ) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(syntheticUsageBody()));
    const read = vi.fn(async () => source);
    const write = vi.fn();
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: syntheticCredentials,
      baseUrl: syntheticBaseUrl,
      fetch,
      now: () => observedAt,
      countReader: { read },
      countEnvironment: "test",
      countAccountRevision: "synthetic-revision",
      cacheStore: { read: async () => completed, write },
    });
    return { adapter, fetch, read, write };
  }
  it.each([0, 7, 121])(
    "AC1/AC2 estimates governed total %i from observed size without count/sealed calls",
    async (totalCount) => {
      const f = fixture(evidence({ totalCount, returnedItemCount: Math.min(totalCount, 100) }));
      expect((await f.adapter.planImport(scope)).usageEstimate).toMatchObject({
        estimatedRequestCount: Math.max(1, Math.ceil(totalCount / 100)),
        pageSize: 100,
        countSource: { validationKind: "page-1-count", sourceId: "synthetic-sealed-debit", query },
      });
      expect(f.read).toHaveBeenCalledWith(query);
      expect(f.fetch.mock.calls.every(([url]) => String(url).includes("/usage"))).toBe(true);
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("AC2 newest source wins without splicing metadata; complete-cache wins a tie", async () => {
    const tied = fixture(evidence(), cache());
    expect((await tied.adapter.planImport(scope)).usageEstimate).toMatchObject({
      estimatedRequestCount: 2,
      pageSize: 2,
      countSource: { validationKind: "complete-cache", totalCount: 3 },
    });
    const newerCount = fixture(evidence(), cache({ fetchedAt: new Date(observedAt.getTime() - 1).toISOString() }));
    expect((await newerCount.adapter.planImport(scope)).usageEstimate).toMatchObject({
      estimatedRequestCount: 2,
      pageSize: 100,
      countSource: { validationKind: "page-1-count", totalCount: 121 },
    });
  });
  it.each([
    null,
    evidence({ totalCount: -1 }),
    evidence({ totalCount: 2147483648 }),
    evidence({ pageSize: 0 }),
    evidence({ returnedItemCount: 99 }),
    evidence({ sourceId: "" }),
    evidence({ observedAt: new Date(observedAt.getTime() - 900_001).toISOString() }),
    evidence({ observedAt: new Date(observedAt.getTime() + 1).toISOString() }),
    evidence({ expiresAt: new Date(observedAt.getTime() - 1).toISOString() }),
    ...(
      [
        "environment",
        "accountRevision",
        "profileKey",
        "profileVersion",
        "unitKey",
        "languageCode",
        "parentValue",
        "requestFingerprint",
      ] as const
    ).map((key) => evidence({ query: { ...query, [key]: "synthetic-wrong" } })),
    evidence({ query: { ...query, kind: "cards" } }),
    evidence({ query: { ...query, productDomain: "lorcana" } }),
  ])("AC2/AC3 rejects unavailable, unsafe, stale, future and wrong-identity count evidence %#", async (source) => {
    expect((await fixture(source).adapter.planImport(scope)).usageEstimate?.estimatedRequestCount).toBeNull();
  });
  it.each([
    { totalCount: null },
    { itemCount: 2 },
    { totalCount: 121 },
    { pageSize: 0 },
    { parentValue: "wrong" },
    { fetchedAt: new Date(observedAt.getTime() - 900_001).toISOString() },
  ])("AC2 partial/count-less/capped/invalid complete rows never supply a count %#", async (patch) => {
    expect(
      (await fixture(null, cache(patch)).adapter.planImport(scope)).usageEstimate?.estimatedRequestCount,
    ).toBeNull();
  });
  it("AC1 explicit sealed id remains one request with no count read", async () => {
    const f = fixture(null);
    expect(
      (await f.adapter.planImport({ ...scope, values: { sealedProductId: "synthetic-id" } })).usageEstimate
        ?.estimatedRequestCount,
    ).toBe(1);
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["options", "import"] as const)(
    "AC2 unwrapped %s observations cache only completed pagination",
    async (surface) => {
      for (const mode of ["complete", "partial", "mismatch", "failed", "different-query"] as const) {
        let completed: CatalogProviderOptionQueryCacheRecord | null = null;
        const write = vi.fn(async (record: CatalogProviderOptionQueryCacheRecord) => {
          completed = record;
        });
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/usage")) return Response.json(syntheticUsageBody());
          expect(write).not.toHaveBeenCalled();
          if (mode === "different-query" && url.pathname.includes("/OP01/")) return Response.json({}, { status: 404 });
          if (url.pathname.endsWith("/expansions"))
            return Response.json({ data: [{ id: "synthetic-replacement", code: "OP01", name: "Synthetic" }] });
          const page = Number(url.searchParams.get("page"));
          if (mode === "failed" && page === 2) throw new Error("Synthetic page failure");
          return Response.json({
            data: Array.from({ length: page === 1 ? 2 : 1 }, (_, i) => ({
              id: `synthetic-${page}-${i}`,
              name: "Synthetic sealed",
            })),
            ...(mode === "partial"
              ? {}
              : {
                  page,
                  page_size: 2,
                  total_count: 3,
                  count: mode === "mismatch" && page === 2 ? 0 : page === 1 ? 2 : 1,
                }),
          });
        });
        const subject = createScrydexOnePieceProviderAdapter({
          fetch,
          credentials: syntheticCredentials,
          baseUrl: syntheticBaseUrl,
          now: () => observedAt,
          cacheStore: { read: async () => completed, write },
        });
        const run = async () => {
          if (surface === "options")
            return subject.listOptions({
              unitKey: sealedUnit,
              optionKind: "sealed-products",
              parentValues: { expansionId: "OP01" },
            });
          const plan = await subject.planImport(scope);
          for await (const _payload of subject.fetchPayloads(plan)) {
            /* consume synthetic authorized observation */
          }
        };
        if (mode === "mismatch" || mode === "failed" || (mode === "different-query" && surface === "options")) {
          await expect(run()).rejects.toThrow();
          expect(write).not.toHaveBeenCalled();
        } else {
          await run();
          expect(write).toHaveBeenCalledOnce();
          expect(write.mock.calls[0]?.[0]).toMatchObject({
            totalCount: mode === "complete" ? 3 : null,
            pageSize: mode === "complete" ? 2 : null,
          });
          expect((await subject.planImport(scope)).usageEstimate?.estimatedRequestCount).toBe(
            mode === "complete" ? 2 : null,
          );
        }
      }
    },
  );
});

describe("AC3 Scrydex page-1 count authority", () => {
  it.each([302, 429, 404, 200])(
    "AC2 actual loopback HTTP %s sends once with no redirects/retries/discovery/page 2",
    async (status) => {
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.writeHead(status, { "content-type": "application/json", location: "/hidden-next" });
        response.end(JSON.stringify(status === 200 ? cards : { error: "synthetic" }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Loopback unavailable.");
        const query = scrydexCountQuery({
          environment: "test",
          accountRevision: "runtime",
          productDomain: "one-piece",
          profileKey: "synthetic",
          profileVersion: "1",
          unitKey: "scrydex:one-piece:single-card:source-observation-import",
          kind: "cards",
          languageCode: "en",
          parentValue: "OP01",
        });
        const send = acquireScrydexPageOneCount(query, {
          baseUrl: `http://127.0.0.1:${address.port}/onepiece/v1`,
          credentials: { apiKey: "synthetic", teamId: "synthetic" },
        });
        if (status === 200) expect((await send).totalCount).toBe(121);
        else await expect(send).rejects.toThrow();
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("/cards?page=1&page_size=250");
        expect(requests[0]).not.toContain("usage");
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );
  it.each([cards, sealed])("accepts the receipt-derived snake_case envelope", (body) => {
    expect(Object.keys(body).sort()).toEqual(["count", "data", "page", "page_size", "total_count"]);
    expect(validateScrydexCountPage(body, 1)).toEqual({
      totalCount: body.total_count,
      pageSize: 100,
      returnedPage: 1,
      returnedItemCount: body.count,
    });
  });
  it.each([0, 1, 121])("accepts zero/single/multiple pages in camel case: %s", (totalCount) => {
    expect(
      validateScrydexCountPage(
        { data: Array.from({ length: Math.min(100, totalCount) }, () => ({})), page: 1, pageSize: 100, totalCount },
        1,
      )?.totalCount,
    ).toBe(totalCount);
  });
  it.each([
    { ...cards, total_count: undefined },
    { ...cards, page_size: undefined },
    { ...cards, page: 2 },
    { ...cards, count: 99 },
    { ...cards, data: [] },
    { ...cards, total_count: 2147483648 },
    { ...cards, total_count: 1.5 },
    { ...cards, page_size: 0 },
    { ...cards, page_size: 2147483648 },
    { data: [], next_page: "/page2" },
    { ...cards, totalCount: 122 },
  ])("refuses missing, capped, next-only, unsafe and conflicting authority", (body) => {
    expect(() => validateScrydexCountPage(body, 1)).toThrow();
  });
  it("one count attempt uses observed size and never requests page 2 or usage", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(cards));
    const query = scrydexCountQuery({
      environment: "test",
      accountRevision: "runtime",
      productDomain: "one-piece",
      profileKey: "synthetic",
      profileVersion: "1",
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      kind: "cards",
      languageCode: "en",
      parentValue: "OP01",
    });
    const result = await acquireScrydexPageOneCount(query, {
      fetch,
      credentials: { apiKey: "synthetic", teamId: "synthetic" },
      baseUrl: "http://127.0.0.1/onepiece/v1",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain("page_size=250");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(result.pageSize).toBe(100);
  });
});
