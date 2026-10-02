import { describe, expect, it, vi } from "vitest";
import { createTcgplayerAutomationHttpClients, type TcgplayerAutomationHttpConfig } from "@chase-sets/catalog/server";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } from "../../market-trades/domain/stat-hygiene-policy";
import { createPriceSignalRuntime } from "../api/runtime";
import {
  PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
  type ProviderObservationPolicyValue,
} from "../domain/provider-observation-policy";
import {
  createObjectStorageTcgplayerMarketCaptureReceiptSink,
  readTcgplayerEndpointFailureClass,
  type TcgplayerMarketCaptureReceiptV1,
} from "../integrations/tcgplayer/capture-sanitizer";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";
import type { TcgplayerMarketStageFact } from "../integrations/tcgplayer/transport-port";
import {
  createTcgplayerMarketClient,
  type EndpointFailurePhase,
  type SafeHttpStatusClass,
} from "../integrations/tcgplayer/market-client";

const ENDPOINTS = ["sales", "listings", "history"] as const;
type Endpoint = (typeof ENDPOINTS)[number];
const HOSTILE = "synthetic-secret-cookie-error-value-name";
const HOSTILE_URL = "https://synthetic-provider.invalid/private-identity";
const HOSTILE_DETAILS = `${HOSTILE} ${HOSTILE_URL} synthetic-account-secret synthetic-external-seller-secret 192.0.2.42`;
const PAGE_POLICY: ProviderObservationPolicyValue = {
  ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
  sales: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.sales, pageSize: 1, pageBudget: 2, limit: 2 },
  listings: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE.listings, pageSize: 1, pageBudget: 2 },
};

describe("tcgplayer-market-capture-v1 response-receipt shape", () => {
  it.each([
    ["401", 401, "auth-rejected", 1],
    ["403", 403, "forbidden", 1],
    ["429", 429, "rate-limited", 1],
    ["400", 400, "client-error", 1],
    ["500", 500, "server-error", 1],
    ["302", 302, "other", 1],
    ["body-read-failure", 400, "client-error", 1],
    ["no-headers", null, "no-response", null],
    ["later-abort", 403, "forbidden", 1],
    ["credential-unavailable", null, "credential-unavailable", null],
    ["recovery", 200, null, 2],
  ] as const)(
    "preserves %s through the real Catalog client and private sink",
    async (scenario, status, failureClass, statusAttempt) => {
      vi.useFakeTimers();
      try {
        const domain = {
          requestDelayMs: 0,
          rateLimitCooldownMs: 10000,
          maxConcurrentRequests: 1,
          adaptiveEnabled: false,
          minRequestDelayMs: 0,
          maxRequestDelayMs: 10000,
          learnedMinDelayMs: 0,
        };
        const config: TcgplayerAutomationHttpConfig = {
          auth: { tcgAuthCookie: null, userAgent: "synthetic", credential: null },
          domainConfigs: { mpApi: domain, mpSearchApi: domain, infiniteApi: domain, mpGateway: domain },
          adaptiveConfig: { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 10 },
          maxRetries: ["403", "429", "later-abort", "recovery"].includes(scenario) ? 1 : 0,
        };
        const store = {
          loadConfig: async () => config,
          loadDomainConfig: async () => domain,
          persistDomainDelays: async () => undefined,
        };
        if (scenario === "credential-unavailable")
          vi.spyOn(store, "loadConfig").mockRejectedValue(
            Object.assign(new Error(HOSTILE_DETAILS), { code: "credential-unavailable" }),
          );
        const calls = { sales: 0, listings: 0, history: 0 };
        const waitForAbort = (signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        const clients = createTcgplayerAutomationHttpClients(store, {
          now: () => Date.parse("2026-09-01T15:00:00.000Z"),
          fetch: async (_url, options) => {
            const path = new URL(String(_url)).pathname;
            const endpoint = path.includes("latestsales")
              ? "sales"
              : path.includes("listings")
                ? "listings"
                : "history";
            const call = ++calls[endpoint];
            if (scenario === "no-headers" || (scenario === "later-abort" && call === 2))
              return waitForAbort(options?.signal ?? undefined);
            if (scenario === "recovery" && call === 2)
              return new Response(JSON.stringify(emptyResponse(endpoint)), { status: 200 });
            const response = new Response(HOSTILE_DETAILS, {
              status: scenario === "recovery" ? 403 : (status ?? 400),
              headers: { "x-synthetic-private": HOSTILE_DETAILS, "set-cookie": HOSTILE_DETAILS },
            });
            if (scenario === "body-read-failure")
              vi.spyOn(response, "text").mockRejectedValue(new Error(HOSTILE_DETAILS));
            return response;
          },
          sleep: async (_ms, signal) => {
            if (["403", "429"].includes(scenario)) return waitForAbort(signal);
          },
        });
        const probe = captureProbe(
          { ...clients, mpGateway: syntheticTransport().mpGateway },
          { ...PAGE_POLICY, secondaryTimeoutMs: 20 },
        );
        const pending = probe.run();
        await vi.advanceTimersByTimeAsync(20);
        const receipt = await pending;
        for (const endpoint of ENDPOINTS) {
          const diagnostic = receipt.responseSummary.endpointDiagnostics![endpoint];
          expect(diagnostic).toMatchObject({ lastHttpStatus: status, failureClass });
          expect(readTcgplayerEndpointFailureClass(diagnostic)).toBe(failureClass);
          const terminal = diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "terminal").at(-1)!;
          expect(terminal).toMatchObject({ page: 1, lastHttpStatus: status, lastHttpStatusAttempt: statusAttempt });
          const headers = diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received");
          expect(headers.map((entry) => entry.attempt)).toEqual(
            status === null ? [] : scenario === "recovery" ? [1, 2] : [1],
          );
          for (const header of headers) {
            expect(header).toMatchObject({
              page: 1,
              httpStatus:
                scenario === "recovery" && header.attempt === 2 ? 200 : scenario === "recovery" ? 403 : status,
            });
          }
        }
        expectPrivate(probe, receipt);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([600, 403] as const)("retains paged Catalog status %i after a successful page", async (pageTwoStatus) => {
    const domain = {
      requestDelayMs: 0,
      rateLimitCooldownMs: 10000,
      maxConcurrentRequests: 1,
      adaptiveEnabled: false,
      minRequestDelayMs: 0,
      maxRequestDelayMs: 10000,
      learnedMinDelayMs: 0,
    };
    const config: TcgplayerAutomationHttpConfig = {
      auth: { tcgAuthCookie: null, userAgent: "synthetic", credential: null },
      domainConfigs: { mpApi: domain, mpSearchApi: domain, infiniteApi: domain, mpGateway: domain },
      adaptiveConfig: { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 10 },
      maxRetries: 0,
    };
    const store = {
      loadConfig: async () => config,
      loadDomainConfig: async () => domain,
      persistDomainDelays: async () => undefined,
    };
    const salesCalls = { count: 0 };
    const clients = createTcgplayerAutomationHttpClients(store, {
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.includes("latestsales")) {
          salesCalls.count += 1;
          if (salesCalls.count === 1) return new Response(JSON.stringify(salesPage(2, "Yes")), { status: 200 });
          return pageTwoStatus === 600
            ? outOfRangeResponse(pageTwoStatus)
            : new Response(HOSTILE_DETAILS, { status: 403 });
        }
        if (path.includes("listings")) return new Response(JSON.stringify(listingsPage()), { status: 200 });
        if (path.includes("history")) return new Response(JSON.stringify(emptyResponse("history")), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    const receipt = await captureProbe(
      { ...clients, mpGateway: syntheticTransport().mpGateway },
      { ...PAGE_POLICY, secondaryTimeoutMs: 20 },
    ).run();
    const diagnostic = receipt.responseSummary.endpointDiagnostics!.sales;
    expect(diagnostic.lastHttpStatus).toBe(pageTwoStatus === 600 ? null : 403);
    expect(diagnostic.failureClass).toBe(pageTwoStatus === 600 ? "no-response" : "forbidden");
    expect(readTcgplayerEndpointFailureClass(diagnostic)).toBe(pageTwoStatus === 600 ? "no-response" : "forbidden");
    expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received").at(-1)).toMatchObject({
      page: 2,
      statusClass: pageTwoStatus === 600 ? "other" : "4xx",
    });
    if (pageTwoStatus === 600)
      expect(
        diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received").at(-1),
      ).not.toHaveProperty("httpStatus");
    else
      expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received").at(-1)).toMatchObject(
        { httpStatus: 403 },
      );
    expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "terminal").at(-1)).toMatchObject({
      page: 2,
      outcome: "failure",
    });
  });

  it("retains a single out-of-range Catalog failure", async () => {
    const domain = {
      requestDelayMs: 0,
      rateLimitCooldownMs: 10000,
      maxConcurrentRequests: 1,
      adaptiveEnabled: false,
      minRequestDelayMs: 0,
      maxRequestDelayMs: 10000,
      learnedMinDelayMs: 0,
    };
    const config: TcgplayerAutomationHttpConfig = {
      auth: { tcgAuthCookie: null, userAgent: "synthetic", credential: null },
      domainConfigs: { mpApi: domain, mpSearchApi: domain, infiniteApi: domain, mpGateway: domain },
      adaptiveConfig: { increaseMultiplier: 2, floorStepMs: 100, decreaseAmountMs: 100, successThreshold: 10 },
      maxRetries: 0,
    };
    const store = {
      loadConfig: async () => config,
      loadDomainConfig: async () => domain,
      persistDomainDelays: async () => undefined,
    };
    const clients = createTcgplayerAutomationHttpClients(store, {
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.includes("latestsales")) return outOfRangeResponse(600);
        if (path.includes("listings")) return new Response(JSON.stringify(listingsPage()), { status: 200 });
        if (path.includes("history")) return new Response(JSON.stringify(emptyResponse("history")), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    const receipt = await captureProbe(
      { ...clients, mpGateway: syntheticTransport().mpGateway },
      { ...PAGE_POLICY, secondaryTimeoutMs: 20 },
    ).run();
    const diagnostic = receipt.responseSummary.endpointDiagnostics!.sales;
    expect(diagnostic.failureClass).not.toBeNull();
    expect(readTcgplayerEndpointFailureClass(diagnostic)).not.toBeNull();
    expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received")).toEqual([
      expect.objectContaining({ page: 1, statusClass: "other" }),
    ]);
    expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "headers-received")[0]).not.toHaveProperty(
      "httpStatus",
    );
    expect(diagnostic.stageTrace!.entries.filter((entry) => entry.stage === "terminal").at(-1)).toMatchObject({
      page: 1,
      outcome: "failure",
    });
  });

  it("reads an old receipt diagnostic as unknown and rejects invalid new fields", async () => {
    const receipt = await captureProbe(syntheticTransport()).run();
    const oldReceipt: TcgplayerMarketCaptureReceiptV1 = {
      ...receipt,
      responseSummary: {
        ...receipt.responseSummary,
        endpointDiagnostics: {
          sales: { failurePhase: "transport", httpStatusClass: "other" },
          listings: { failurePhase: null, httpStatusClass: "none" },
          history: { failurePhase: null, httpStatusClass: "none" },
        },
      },
    };
    expect(readTcgplayerEndpointFailureClass(null)).toBe("unknown");
    expect(readTcgplayerEndpointFailureClass(undefined)).toBe("unknown");
    expect(readTcgplayerEndpointFailureClass(oldReceipt.responseSummary.endpointDiagnostics!.sales)).toBe("unknown");
    for (const diagnostic of [
      { lastHttpStatus: 429.5, failureClass: "rate-limited" },
      { lastHttpStatus: 600, failureClass: "other" },
      { lastHttpStatus: 429, failureClass: "expired" },
    ])
      expect(readTcgplayerEndpointFailureClass(diagnostic)).toBe("unknown");
  });

  it("retains only closed per-endpoint stage facts in the existing post-commit private object", async () => {
    const baseline = syntheticTransport();
    const at = "2026-09-01T15:00:00.000Z";
    const emit = (
      callback: ((fact: TcgplayerMarketStageFact) => void) | undefined,
      stage: TcgplayerMarketStageFact["stage"],
      extra: Partial<TcgplayerMarketStageFact> = {},
    ) => callback?.({ stage, at, attempt: 1, ...extra });
    let failing = true;
    const transport: TcgplayerMarketTransport = {
      mpGateway: baseline.mpGateway,
      mpApi: {
        post: async <T>(
          path: string,
          data?: unknown,
          options?: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>[2],
        ) => {
          for (let index = 0; index < 90; index += 1) emit(options?.onStage, "config-wait");
          emit(options?.onStage, "fetch-start");
          emit(options?.onStage, "headers-received", {
            statusClass: failing ? "4xx" : "2xx",
            httpStatus: failing ? 403 : 200,
          });
          if (failing) {
            emit(options?.onStage, "headers-received", { statusClass: "4xx", httpStatus: 429 });
            emit(options?.onStage, "cooldown-start");
            emit(options?.onStage, "abort", { activeStage: "cooldown-start" });
            emit(options?.onStage, "terminal", {
              outcome: "aborted",
              lastHttpStatus: 429,
              lastHttpStatusAttempt: 1,
              failureCode: null,
            });
            throw hostileError(403);
          }
          emit(options?.onStage, "parse-start");
          emit(options?.onStage, "parse-end");
          emit(options?.onStage, "terminal", {
            outcome: "success",
            lastHttpStatus: 200,
            lastHttpStatusAttempt: 1,
            failureCode: null,
          });
          return baseline.mpApi.post<T>(path, data, options);
        },
      },
      mpSearchApi: baseline.mpSearchApi,
      infiniteApi: baseline.infiniteApi,
    };
    const probe = captureProbe(transport);
    const failed = await probe.run();
    const trace = failed.responseSummary.endpointDiagnostics!.sales.stageTrace!;
    expect(trace.entries).toHaveLength(64);
    expect(trace.entries[0]).toMatchObject({ page: 1, attempt: 1, stage: "config-wait", at });
    expect(trace.entries.slice(-3)).toEqual([
      { page: 1, attempt: 1, stage: "headers-received", at, statusClass: "4xx", httpStatus: 403 },
      { page: 1, attempt: 1, stage: "abort", at, activeStage: "cooldown-start" },
      {
        page: 1,
        attempt: 1,
        stage: "terminal",
        at,
        outcome: "aborted",
        lastHttpStatus: 429,
        lastHttpStatusAttempt: 1,
        failureCode: null,
      },
    ]);
    expect(trace).toMatchObject({ overflow: 32, retryCount: 0, cooldownCount: 1 });
    expect(failed.responseSummary.endpointDiagnostics!.sales).toMatchObject({
      lastHttpStatus: 429,
      failureClass: "rate-limited",
    });
    expect(failed.responseSummary.salesStatus).toBe("unavailable");
    expect(failed.responseSummary.salesCoverage).toBe("unknown");
    expectPrivate(probe, failed);
    failing = false;
    const healthy = await probe.run();
    expect(healthy.responseSummary.endpointDiagnostics!.sales.stageTrace).toMatchObject({
      entries: expect.arrayContaining([
        { page: 1, attempt: 1, stage: "headers-received", at, statusClass: "2xx", httpStatus: 200 },
      ]),
    });
    expect(
      healthy.responseSummary.endpointDiagnostics!.sales.stageTrace!.entries.some((entry) => entry.stage === "abort"),
    ).toBe(false);
    expect(healthy.responseSummary.salesStatus).toBe("observed");
    expectPrivate(probe, healthy, 1);
    expect(failed.kind).toBe(healthy.kind);
  });

  it("attributes retries and pagination to independent pages and attempts", async () => {
    const baseline = syntheticTransport();
    let salesCalls = 0;
    const at = "2026-09-01T15:00:00.000Z";
    const transport: TcgplayerMarketTransport = {
      ...baseline,
      mpApi: {
        post: async <T>(
          _path: string,
          _data?: unknown,
          options?: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>[2],
        ) => {
          salesCalls += 1;
          const onStage = options?.onStage;
          onStage?.({ stage: "fetch-start", at, attempt: 1 });
          onStage?.({ stage: "headers-received", at, attempt: 1, statusClass: "4xx" });
          onStage?.({ stage: "retry-start", at, attempt: 1 });
          onStage?.({ stage: "cooldown-start", at, attempt: 1 });
          onStage?.({ stage: "cooldown-end", at, attempt: 1 });
          onStage?.({ stage: "fetch-start", at, attempt: 2 });
          onStage?.({ stage: "headers-received", at, attempt: 2, statusClass: "2xx" });
          onStage?.({ stage: "terminal", at, attempt: 2, outcome: "success" });
          return salesPage(2, salesCalls === 1 ? "Yes" : "", salesCalls === 1 ? "" : "Yes") as T;
        },
      },
    };
    const result = await createTcgplayerMarketClient(transport).fetchSecondary({
      productId: 7001,
      policy: PAGE_POLICY,
      now: () => at,
    });
    expect(salesCalls).toBe(2);
    expect(result.observation.sales).toMatchObject({ status: "observed", coverage: "complete", pagesFetched: 2 });
    expect(result.stageTraces.sales).toMatchObject({ retryCount: 2, cooldownCount: 2, overflow: 0 });
    expect(result.stageTraces.sales!.entries.filter((entry) => entry.stage === "terminal")).toEqual([
      { page: 1, attempt: 2, stage: "terminal", at, outcome: "success" },
      { page: 2, attempt: 2, stage: "terminal", at, outcome: "success" },
    ]);
    expect(result.stageTraces.sales!.entries.filter((entry) => entry.stage === "headers-received")).toEqual([
      { page: 1, attempt: 1, stage: "headers-received", at, statusClass: "4xx" },
      { page: 1, attempt: 2, stage: "headers-received", at, statusClass: "2xx" },
      { page: 2, attempt: 1, stage: "headers-received", at, statusClass: "4xx" },
      { page: 2, attempt: 2, stage: "headers-received", at, statusClass: "2xx" },
    ]);
    expect(result.stageTraces.listings).toBeUndefined();
    expect(result.stageTraces.history).toBeUndefined();
  });

  it("retains page-one success before a pending page-two request aborts", async () => {
    const baseline = syntheticTransport();
    const at = "2026-09-01T15:00:00.000Z";
    let salesCalls = 0;
    const transport: TcgplayerMarketTransport = {
      ...baseline,
      mpApi: {
        post: async <T>(
          _path: string,
          _data?: unknown,
          options?: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>[2],
        ) => {
          salesCalls += 1;
          if (salesCalls === 1) {
            options?.onStage?.({ stage: "terminal", at, attempt: 1, outcome: "success" });
            return salesPage(2, "Yes") as T;
          }
          options?.onStage?.({ stage: "fetch-start", at, attempt: 1 });
          return new Promise<T>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                options.onStage?.({ stage: "abort", at, attempt: 1, activeStage: "fetch-start" });
                options.onStage?.({ stage: "terminal", at, attempt: 1, outcome: "aborted" });
                reject(hostileError());
              },
              { once: true },
            );
          });
        },
      },
    };
    const result = await createTcgplayerMarketClient(transport).fetchSecondary({
      productId: 7001,
      policy: { ...PAGE_POLICY, secondaryTimeoutMs: 20 },
      now: () => at,
    });
    expect(salesCalls).toBe(2);
    expect(result.observation.sales.status).toBe("unavailable");
    expect(result.stageTraces.sales).toMatchObject({ overflow: 0 });
    expect(result.stageTraces.sales!.entries).toEqual([
      { page: 1, attempt: 1, stage: "terminal", at, outcome: "success" },
      { page: 2, attempt: 1, stage: "fetch-start", at },
      { page: 2, attempt: 1, stage: "abort", at, activeStage: "fetch-start" },
      { page: 2, attempt: 1, stage: "terminal", at, outcome: "aborted" },
    ]);
  });

  it("drops the prior terminal only when the ordinary budget is full", async () => {
    const baseline = syntheticTransport();
    const at = "2026-09-01T15:00:00.000Z";
    const transport: TcgplayerMarketTransport = {
      ...baseline,
      mpApi: {
        post: async <T>(
          path: string,
          data?: unknown,
          options?: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>[2],
        ) => {
          for (let index = 0; index < 61; index += 1) {
            options?.onStage?.({ stage: "config-wait", at, attempt: 1 });
          }
          options?.onStage?.({ stage: "terminal", at, attempt: 1, outcome: "failure" });
          options?.onStage?.({ stage: "terminal", at, attempt: 2, outcome: "success" });
          return baseline.mpApi.post<T>(path, data, options);
        },
      },
    };
    const result = await createTcgplayerMarketClient(transport).fetchSecondary({
      productId: 7001,
      policy: PAGE_POLICY,
      now: () => at,
    });
    const trace = result.stageTraces.sales!;
    expect(trace.entries).toHaveLength(62);
    expect(trace.overflow).toBe(1);
    expect(trace.entries.filter((entry) => entry.stage === "terminal")).toEqual([
      { page: 1, attempt: 2, stage: "terminal", at, outcome: "success" },
    ]);
  });

  it("does not turn received headers or null history into qualification coverage", async () => {
    const baseline = syntheticTransport();
    const at = "2026-09-01T15:00:00.000Z";
    const transport: TcgplayerMarketTransport = {
      ...baseline,
      mpApi: {
        post: async <T>(
          _path: string,
          _data?: unknown,
          options?: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>[2],
        ) => {
          options?.onStage?.({ stage: "fetch-start", at, attempt: 1 });
          options?.onStage?.({ stage: "headers-received", at, attempt: 1, statusClass: "2xx" });
          options?.onStage?.({ stage: "parse-start", at, attempt: 1 });
          options?.onStage?.({ stage: "parse-failure", at, attempt: 1 });
          options?.onStage?.({ stage: "terminal", at, attempt: 1, outcome: "failure" });
          throw hostileError();
        },
      },
      infiniteApi: {
        get: async <T>(
          _path: string,
          _params?: Parameters<TcgplayerMarketTransport["infiniteApi"]["get"]>[1],
          options?: Parameters<TcgplayerMarketTransport["infiniteApi"]["get"]>[2],
        ) => {
          options?.onStage?.({ stage: "headers-received", at, attempt: 1, statusClass: "2xx" });
          return { count: 0, result: null } as T;
        },
      },
    };
    const probe = captureProbe(transport);
    const receipt = await probe.run();
    expect(receipt.responseSummary).toMatchObject({
      salesStatus: "unavailable",
      salesCoverage: "unknown",
      historyStatus: "unavailable",
      historyCoverage: "unknown",
    });
    expect(receipt.responseSummary.endpointDiagnostics!.sales.stageTrace!.entries.map((entry) => entry.stage)).toEqual([
      "fetch-start",
      "headers-received",
      "parse-start",
      "parse-failure",
      "terminal",
    ]);
    expect(receipt.responseSummary.endpointDiagnostics!.sales.httpStatusClass).toBe("other");
    expectPrivate(probe, receipt);
  });
  it("composes one privacy-safe sink receipt from field summaries captured before decoding", async () => {
    const receipts: TcgplayerMarketCaptureReceiptV1[] = [];
    const retainedObjects: Array<Readonly<{ key: string; body: Uint8Array; visibility: string }>> = [];
    const pool = new SyntheticProductionPool();
    const receiptSink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
      putObject: async (object) => void retainedObjects.push(object),
    });
    const runtime = createPriceSignalRuntime({
      db: pool,
      pool,
      tcgplayerMarketTransport: syntheticTransport(),
      tcgplayerMarketCaptureReceiptSink: {
        retain: async (receipt) => {
          receipts.push(receipt);
          await receiptSink.retain(receipt);
        },
      },
    });

    await expect(runtime.runTcgplayerMarketCapture()).resolves.toMatchObject({
      status: "completed",
      capturesCommitted: 1,
    });
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({
      kind: "tcgplayer-market-capture-v1",
      lifecycle: {
        fieldSummaryCapturedAt: "response-receipt-before-decode",
        retainedAt: "after-immutable-capture-commit",
      },
      responseSummary: {
        salesReturned: 1,
        listingReturned: 1,
        historyResults: 1,
        maximumTupleMultiplicity: 1,
        captureLocalJointRows: 1,
      },
    });
    const listingFields = receipt.responseSummary.fieldPresenceAndTypes.listingPages[0]!.items.fields;
    expect(listingFields.find((field) => field.field === "sellerKey")).toEqual({
      field: "sellerKey",
      presentCount: 1,
      missingCount: 0,
      observedTypes: ["string"],
    });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-external-seller-secret");
    expect(receipt).not.toHaveProperty("responseBody");
    expect(retainedObjects).toHaveLength(1);
    expect(retainedObjects[0]).toMatchObject({
      key: `provider-evidence/tcgplayer-market-captures/${encodeURIComponent(receipt.captureId)}.json`,
      visibility: "private",
    });
    const retainedArtifact = new TextDecoder().decode(retainedObjects[0]!.body);
    expect(JSON.parse(retainedArtifact)).toEqual(receipt);
    expect(Object.keys(JSON.parse(retainedArtifact))).toEqual([
      "kind",
      "captureId",
      "lifecycle",
      "requestPosture",
      "responseSummary",
    ]);
    expect(retainedArtifact).not.toContain("synthetic-external-seller-secret");
  });

  describe.each(ENDPOINTS)("%s endpoint", (endpoint) => {
    it.each([
      ["4xx", 403],
      ["5xx", 503],
      ["other", undefined],
    ] as const)(
      "retains transport rejection and owned %s class through the private sink",
      async (httpClass, status) => {
        const control = controlledTransport((name) => {
          if (name === endpoint) throw hostileError(status);
        });
        const probe = captureProbe(control.transport);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          const receipt = await probe.run();
          expectDiagnostics(receipt, endpoint, "transport", httpClass);
          expect(control.calls).toEqual({ sales: 1, listings: 1, history: 1 });
          expect(receipt.responseSummary[`${endpoint}Status`]).toBe("unavailable");
          expect(receipt.responseSummary[`${endpoint}Coverage`]).toBe("unknown");
          expectPrivate(probe, receipt);
          const logged = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
          expect(logged).not.toContain(HOSTILE);
          expect(logged).not.toContain(HOSTILE_URL);
        } finally {
          log.mockRestore();
          warn.mockRestore();
          error.mockRestore();
        }
      },
    );

    it("retains parsed arrival even when a hostile malformed envelope fails closed", async () => {
      const control = controlledTransport((name) =>
        name === endpoint
          ? {
              [HOSTILE]: HOSTILE_URL,
              cookie: HOSTILE,
              responseBody: HOSTILE,
            }
          : undefined,
      );
      const probe = captureProbe(control.transport);
      const receipt = await probe.run();
      expectDiagnostics(receipt, endpoint, "response-processing", "other");
      expect(control.calls).toEqual({ sales: 1, listings: 1, history: 1 });
      expect(receipt.responseSummary[`${endpoint}Status`]).toBe("unavailable");
      expect(receipt.responseSummary[`${endpoint}Coverage`]).toBe("unknown");
      expectPrivate(probe, receipt);
    });
  });

  it.each(ENDPOINTS)("marks %s response processing before the receipt summarizer can throw", async (endpoint) => {
    const control = controlledTransport((name) => {
      if (name !== endpoint) return;
      const field = { sales: "data", listings: "results", history: "result" }[endpoint];
      return Object.defineProperty({}, field, {
        enumerable: true,
        get() {
          throw hostileError(403);
        },
      });
    });
    const probe = captureProbe(control.transport);
    const receipt = await probe.run();
    expectDiagnostics(receipt, endpoint, "response-processing", "4xx");
    expectPrivate(probe, receipt);
  });

  it("distinguishes formerly identical receipts for 4xx, 5xx and other failures", async () => {
    const receipts = [];
    for (const status of [403, 503, undefined]) {
      const control = controlledTransport((name) => {
        if (name === "sales") throw hostileError(status);
      });
      receipts.push(await captureProbe(control.transport).run());
    }
    const summaries = receipts.map((receipt) => receipt.responseSummary);
    expect(new Set(summaries.map((summary) => JSON.stringify(summary)))).toHaveProperty("size", 3);
    const withoutDiagnostics = summaries.map(({ endpointDiagnostics: _diagnostics, ...summary }) => summary);
    expect(withoutDiagnostics[1]).toEqual(withoutDiagnostics[0]);
    expect(withoutDiagnostics[2]).toEqual(withoutDiagnostics[0]);
  });

  describe.each(["sales", "listings"] as const)("%s continuation", (endpoint) => {
    it.each(["transport", "response-processing"] as const)(
      "locates a page-two %s failure after a valid page",
      async (phase) => {
        const control = controlledTransport((name, page) => {
          if (name !== endpoint) return;
          if (page === 1) return endpoint === "sales" ? salesPage(2, "Yes") : listingsPage(2);
          if (phase === "transport") throw hostileError(503);
          return endpoint === "sales" ? { ...salesPage(2, "", "Yes"), data: null } : { errors: [], results: null };
        });
        const probe = captureProbe(control.transport, PAGE_POLICY);
        const receipt = await probe.run();
        expect(control.calls).toEqual({ sales: 1, listings: 1, history: 1, [endpoint]: 2 });
        expectDiagnostics(receipt, endpoint, phase, phase === "transport" ? "5xx" : "other");
        const summaries = receipt.responseSummary.fieldPresenceAndTypes;
        expect(endpoint === "sales" ? summaries.salesPages : summaries.listingPages).toHaveLength(
          phase === "transport" ? 1 : 2,
        );
        expect(receipt.responseSummary[`${endpoint}Coverage`]).toBe("unknown");
        expect(receipt.responseSummary[`${endpoint}Status`]).toBe("unavailable");
        expectPrivate(probe, receipt);
      },
    );
  });

  it("keeps null history distinct from valid empty endpoints without inferring a live count", async () => {
    const empty = controlledTransport((name) => emptyResponse(name));
    const emptyProbe = captureProbe(empty.transport);
    const valid = await emptyProbe.run();
    expectDiagnostics(valid);
    expect(valid.responseSummary).toMatchObject({
      salesStatus: "observed",
      listingsStatus: "observed",
      historyStatus: "observed",
      salesReturned: 0,
      listingReturned: 0,
      historyResults: 0,
      historyBuckets: 0,
      salesCoverage: "complete",
      listingsCoverage: "complete",
      historyCoverage: "observed",
      typedRows: 0,
    });
    expectPrivate(emptyProbe, valid);
    const nullHistory = controlledTransport((name) =>
      name === "history" ? { count: 0, result: null } : emptyResponse(name),
    );
    const nullProbe = captureProbe(nullHistory.transport);
    const invalid = await nullProbe.run();
    expectDiagnostics(invalid, "history", "response-processing", "other");
    expect(invalid.responseSummary).toMatchObject({
      historyStatus: "unavailable",
      historyCoverage: "unknown",
      historyResults: 0,
    });
    for (const [receipt, resultType] of [
      [valid, "array"],
      [invalid, "null"],
    ] as const) {
      const fields = receipt.responseSummary.fieldPresenceAndTypes.history!.envelope.fields;
      expect(fields.find((field) => field.field === "count")).toEqual({
        field: "count",
        presentCount: 1,
        missingCount: 0,
        observedTypes: ["number"],
      });
      expect(fields.find((field) => field.field === "result")).toEqual({
        field: "result",
        presentCount: 1,
        missingCount: 0,
        observedTypes: [resultType],
      });
    }
    expectPrivate(nullProbe, invalid);
  });

  it("recovers on the next pass with unchanged observations, counts, coverage and requests", async () => {
    let failing = true;
    const control = controlledTransport(() => {
      if (failing) throw hostileError(503);
    });
    const probe = captureProbe(control.transport);
    const failed = await probe.run();
    for (const diagnostic of Object.values(failed.responseSummary.endpointDiagnostics!)) {
      expect(diagnostic).toEqual({
        failurePhase: "transport",
        httpStatusClass: "5xx",
        lastHttpStatus: null,
        failureClass: "unknown",
      });
    }
    failing = false;
    const recovered = await probe.run();
    const baselineControl = controlledTransport(() => undefined);
    const baseline = await captureProbe(baselineControl.transport).run();
    expectDiagnostics(recovered);
    expect(recovered.responseSummary).toEqual(baseline.responseSummary);
    expect(recovered.requestPosture).toEqual(baseline.requestPosture);
    expect(control.calls).toEqual({ sales: 2, listings: 2, history: 2 });
    expect(baselineControl.calls).toEqual({ sales: 1, listings: 1, history: 1 });
    expectPrivate(probe, recovered, 1);

    // Reuse the same client as well as the runtime: neither scope may retain failed phases.
    const client = createTcgplayerMarketClient(control.transport);
    const input = { productId: 7001, policy: PAGE_POLICY, now: () => "2026-09-01T15:00:00.000Z" };
    failing = true;
    await client.fetchSecondary(input);
    failing = false;
    const next = await client.fetchSecondary(input);
    const fresh = await createTcgplayerMarketClient(syntheticTransport()).fetchSecondary(input);
    expect(next).toEqual(fresh);
    expect(next.failurePhases).toEqual({ sales: null, listings: null, history: null });
  });

  it.each(["request-cap", "page-budget", "rejected-row"] as const)("preserves %s incompleteness", async (scenario) => {
    const control = controlledTransport((name) => {
      if (name === "sales")
        return scenario === "rejected-row" ? { ...salesPage(), data: [{ invalid: HOSTILE }] } : salesPage(3, "Yes");
    });
    const policy = {
      ...PAGE_POLICY,
      sales: { ...PAGE_POLICY.sales, pageBudget: 1, limit: scenario === "request-cap" ? 1 : 3 },
    };
    const receipt = await captureProbe(control.transport, policy).run();
    expect(receipt.responseSummary.salesCoverage).toBe(
      {
        "request-cap": "request-cap-truncated",
        "page-budget": "page-budget-truncated",
        "rejected-row": "unknown",
      }[scenario],
    );
    expectDiagnostics(receipt);
    expect(control.calls).toEqual({ sales: 1, listings: 1, history: 1 });
  });
});

class SyntheticProductionPool implements PgTransactionalPool {
  constructor(private readonly policy = PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE) {}

  async connect(): Promise<PgPoolClient> {
    return { query: this.query.bind(this), release: () => undefined };
  }

  async query<Row = Record<string, unknown>>(sql: string) {
    if (sql.includes("policy_key = 'pricing.price-signal'")) {
      return { rows: [{ event_id: "synthetic-signal-r1", value: { productsPerPass: 1 } } as Row] };
    }
    if (sql.includes("policy_key = 'pricing.provider-observation'")) {
      return {
        rows: [
          {
            event_id: "synthetic-observation-r1",
            value: { ...this.policy, capturesPerPass: 1 },
          } as Row,
        ],
      };
    }
    if (sql.includes("policy_key = 'pricing.market-stat-hygiene'")) {
      return { rows: [{ event_id: "synthetic-stat-r1", value: MARKET_STAT_HYGIENE_LAUNCH_POLICY_VALUE } as Row] };
    }
    if (sql.includes("FROM pricing_external_catalog_item_reference_inputs")) {
      return {
        rows: [
          {
            external_key: "product:7001",
            catalog_item_id: "cat_unmistakably_synthetic",
            sku_external_key: "sku:9001",
            catalog_product_key: "cat_unmistakably_synthetic::",
          } as Row,
        ],
      };
    }
    if (sql.includes("FROM pricing_external_market_capture_cursors")) return { rows: [] as Row[] };
    if (sql.includes("FROM pricing_external_product_reference_inputs")) {
      return {
        rows: [
          {
            catalog_item_id: "cat_unmistakably_synthetic",
            catalog_product_key: "cat_unmistakably_synthetic::",
          } as Row,
        ],
      };
    }
    if (sql.includes("INSERT INTO pricing_external_market_captures")) {
      return { rows: [{ capture_id: "synthetic-capture" } as Row] };
    }
    return { rows: [] as Row[] };
  }
}

function hostileError(status?: number) {
  return Object.assign(new Error(HOSTILE), {
    status,
    name: HOSTILE,
    cookie: HOSTILE,
    responseBody: HOSTILE,
    url: HOSTILE_URL,
    [HOSTILE]: HOSTILE_URL,
  });
}

function controlledTransport(reply: (endpoint: Endpoint, page: number) => unknown) {
  const baseline = syntheticTransport();
  const calls = { sales: 0, listings: 0, history: 0 };
  const transport: TcgplayerMarketTransport = {
    mpGateway: baseline.mpGateway,
    mpApi: {
      post: async <T>(...args: Parameters<TcgplayerMarketTransport["mpApi"]["post"]>) =>
        (reply("sales", ++calls.sales) ?? (await baseline.mpApi.post<T>(...args))) as T,
    },
    mpSearchApi: {
      post: async <T>(...args: Parameters<TcgplayerMarketTransport["mpSearchApi"]["post"]>) =>
        (reply("listings", ++calls.listings) ?? (await baseline.mpSearchApi.post<T>(...args))) as T,
    },
    infiniteApi: {
      get: async <T>(...args: Parameters<TcgplayerMarketTransport["infiniteApi"]["get"]>) =>
        (reply("history", ++calls.history) ?? (await baseline.infiniteApi.get<T>(...args))) as T,
    },
  };
  return { transport, calls };
}

function captureProbe(transport: TcgplayerMarketTransport, policy = PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE) {
  const receipts: TcgplayerMarketCaptureReceiptV1[] = [];
  const objects: Array<{ key: string; body: Uint8Array; visibility: "private" }> = [];
  const sink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
    putObject: async (object) => void objects.push(object),
  });
  const pool = new SyntheticProductionPool(policy);
  const runtime = createPriceSignalRuntime({
    db: pool,
    pool,
    tcgplayerMarketTransport: transport,
    tcgplayerMarketCaptureReceiptSink: {
      retain: async (receipt) => {
        receipts.push(receipt);
        await sink.retain(receipt);
      },
    },
  });
  return {
    objects,
    async run() {
      const before = receipts.length;
      await expect(runtime.runTcgplayerMarketCapture()).resolves.toEqual({
        status: "completed",
        reason: "none",
        signalWorkCount: 1,
        signalsRecorded: 1,
        signalsUnresolved: 0,
        capturesCommitted: 1,
      });
      expect(receipts).toHaveLength(before + 1);
      return receipts[before]!;
    },
  };
}

function expectDiagnostics(
  receipt: TcgplayerMarketCaptureReceiptV1,
  failedEndpoint?: Endpoint,
  failurePhase: EndpointFailurePhase = null,
  httpStatusClass: SafeHttpStatusClass = "none",
) {
  expect(receipt.responseSummary.endpointDiagnostics).toEqual(
    Object.fromEntries(
      ENDPOINTS.map((name) => [
        name,
        {
          failurePhase: name === failedEndpoint ? failurePhase : null,
          httpStatusClass: name === failedEndpoint ? httpStatusClass : "none",
          lastHttpStatus: null,
          failureClass: "unknown",
        },
      ]),
    ),
  );
}

function expectPrivate(probe: ReturnType<typeof captureProbe>, receipt: TcgplayerMarketCaptureReceiptV1, index = 0) {
  const object = probe.objects[index]!;
  expect(object.key).toBe(`provider-evidence/tcgplayer-market-captures/${encodeURIComponent(receipt.captureId)}.json`);
  expect(object.visibility).toBe("private");
  const retainedArtifact = new TextDecoder().decode(object.body);
  const parsed = JSON.parse(retainedArtifact);
  expect(Object.keys(parsed)).toEqual(["kind", "captureId", "lifecycle", "requestPosture", "responseSummary"]);
  expect(parsed).toEqual(receipt);
  expect(parsed.kind).toBe("tcgplayer-market-capture-v1");
  for (const marker of [
    HOSTILE,
    HOSTILE_URL,
    "synthetic-external-seller-secret",
    "synthetic-transient-sale",
    "synthetic-account-secret",
    "192.0.2.42",
  ]) {
    expect(retainedArtifact).not.toContain(marker);
  }
  expect(retainedArtifact).not.toMatch(/responseBody|exceptionMessage|cookie|authorization/);
}

function salesPage(totalResults = 1, nextPage = "", previousPage = "") {
  return {
    previousPage,
    nextPage,
    resultCount: 1,
    totalResults,
    data: [
      {
        condition: "Near Mint",
        variant: "Normal",
        language: "English",
        quantity: 1,
        title: "synthetic",
        listingType: "ListingWithoutPhotos",
        customListingId: "synthetic-transient-sale",
        purchasePrice: 5,
        shippingPrice: 0,
        orderDate: "2026-09-01T00:00:00.000Z",
      },
    ],
  };
}

function listingsPage(totalResults = 1) {
  return {
    errors: [],
    results: [{ totalResults, resultId: "synthetic-result", aggregations: {}, results: [syntheticListing()] }],
  };
}

function emptyResponse(endpoint: Endpoint) {
  if (endpoint === "sales") return { ...salesPage(0), resultCount: 0, data: [] };
  if (endpoint === "listings")
    return {
      errors: [],
      results: [{ totalResults: 0, resultId: "synthetic-empty", aggregations: {}, results: [] }],
    };
  return { count: 0, result: [] };
}

function outOfRangeResponse(status: number) {
  return { status, ok: false, text: async () => HOSTILE_DETAILS } as Response;
}

function syntheticTransport(): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>() =>
        [
          {
            skuId: 9001,
            marketPrice: 10,
            lowestPrice: 9,
            highestPrice: 11,
            priceCount: 3,
            calculatedAt: "2026-09-01T15:00:00.000Z",
          },
        ] as T,
    },
    mpApi: {
      post: async <T>() => salesPage() as T,
    },
    mpSearchApi: {
      post: async <T>() => listingsPage() as T,
    },
    infiniteApi: {
      get: async <T>() =>
        ({
          count: 1,
          result: [
            {
              skuId: "9001",
              variant: "Normal",
              language: "English",
              condition: "Near Mint",
              averageDailyQuantitySold: "1",
              averageDailyTransactionCount: "1",
              totalQuantitySold: "1",
              totalTransactionCount: "1",
              trendingMarketPricePercentages: {},
              buckets: [],
            },
          ],
        }) as T,
    },
  };
}

function syntheticListing() {
  return {
    directProduct: false,
    goldSeller: false,
    listingId: 1,
    channelId: 0,
    conditionId: 1,
    verifiedSeller: true,
    directInventory: 0,
    rankedShippingPrice: 0,
    productId: 7001,
    printing: "Normal",
    languageAbbreviation: "EN",
    sellerName: "synthetic-external-seller-secret",
    forwardFreight: false,
    sellerShippingPrice: 0,
    language: "English",
    shippingPrice: 0,
    condition: "Near Mint",
    languageId: 1,
    score: 0,
    directSeller: false,
    productConditionId: 1,
    sellerId: "synthetic-external-seller-secret",
    listingType: "standard",
    sellerRating: 100,
    sellerSales: "1",
    quantity: 1,
    sellerKey: "synthetic-external-seller-secret",
    price: 10,
    customData: { images: [] },
  };
}
