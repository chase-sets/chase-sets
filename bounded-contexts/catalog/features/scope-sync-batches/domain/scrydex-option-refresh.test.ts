import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as cacheCapture from "./scrydex-cache-capture";
import * as period from "./scrydex-billing-period";
import { guardDisabledMutant } from "../tests/count-capture-mutants";
import { periodAt, syntheticPeriod, periodReserve, periodGateForTest } from "../tests/scrydex-period-fixture";
import {
  classifyScrydexOptionRefreshRequest,
  evaluateScrydexOptionRefreshAdmission,
  evaluateScrydexUsagePreflight,
  buildScrydexOptionRefreshReceipt,
  providerPagesUpperBound,
  validateScrydexOptionRefreshReceipt,
} from "./scrydex-option-refresh";

describe("Scrydex bounded option refresh", () => {
  const admitPeriod = process.env.SCRYDEX_PERIOD_MUTANT
    ? guardDisabledMutant<typeof evaluateScrydexOptionRefreshAdmission>(
        "../domain/scrydex-option-refresh.ts",
        ["const decision = evaluateScrydexBillingPeriod({", "const decision = periodGate({"],
        "evaluateScrydexOptionRefreshAdmission",
        { z, ...cacheCapture, ...period, periodGate: periodGateForTest() },
      )
    : evaluateScrydexOptionRefreshAdmission;
  const periodInput = (consumed = 49_944, reserve: unknown = periodReserve("1:1")) => ({
    provider: {
      providerKey: "scrydex",
      providerReadiness: "ready",
      usageBudget: {
        readiness: "ready",
        freshness: "fresh",
        observedAt: periodAt,
        creditAllowance: 100_000,
        creditBalance: 100_000 - consumed,
        billingPeriod: syntheticPeriod,
      },
    },
    providerSendWindow: { state: "disabled" },
    rolloutControls: { controls: [] },
    unitKeys: [],
    periodReserve: reserve,
    runId: "1:1",
    now: periodAt,
  });
  it("period-cap boundary admits 49,944 and refuses 49,945 for the actual 56-credit envelope", () => {
    expect(admitPeriod(periodInput())).toMatchObject({
      admitted: true,
      decision: { consumedCredits: 49_944, plannedCredits: 56, unreflectedCredits: 0 },
    });
    expect(admitPeriod(periodInput(49_945))).toMatchObject({ admitted: false, reason: "usage-period-cap" });
  });
  it.each([
    undefined,
    null,
    {},
    periodReserve("wrong-run"),
    periodReserve("1:1", null),
    { ...periodReserve("1:1"), observedAt: "2026-10-13T07:00:00.000Z" },
    { ...periodReserve("1:1"), endsAt: "2027-02-01T00:00:00.000Z" },
    { ...periodReserve("1:1"), credits: -1 },
  ])("refuses missing, unknown or unbound host reserve %j", (reserve) => {
    const input = periodInput();
    input.periodReserve = reserve;
    expect(admitPeriod(input)).toMatchObject({ admitted: false, reason: "usage-period-cap" });
  });
  it("counts refresh-before-count and concurrent/uncertain reserves instead of treating 56 as the period cap", () => {
    expect(admitPeriod(periodInput(49_900, periodReserve("1:1", 45)))).toMatchObject({
      admitted: false,
      reason: "usage-period-cap",
    });
    expect(admitPeriod(periodInput(30_000))).toMatchObject({ admitted: true });
  });
  it.each([
    { observedAt: "2026-10-13T07:46:59.999Z" },
    { observedAt: "2026-10-13T08:02:00.001Z" },
    { creditAllowance: -1 },
    { creditBalance: 100_001 },
    { creditBalance: 1000.1 },
    { billingPeriod: null },
    { billingPeriod: { ...syntheticPeriod, overageCreditsConsumed: 1 } },
    { billingPeriod: { ...syntheticPeriod, endsAt: periodAt } },
    { billingPeriod: { ...syntheticPeriod, startsAt: "2026-11-01T00:00:00.000Z" } },
    { billingPeriod: { ...syntheticPeriod, unknown: true } },
  ])("fails closed on invalid period observation %j", (change) => {
    const input = periodInput();
    Object.assign(input.provider.usageBudget, change);
    expect(admitPeriod(input)).toMatchObject({ admitted: false, reason: "usage-period-cap" });
  });
  it.each([
    [0, 2],
    [100, 2],
    [101, 3],
    [1000, 11],
  ])("bounds provider pages for %i total", (total, expected) => {
    expect(providerPagesUpperBound(total)).toBe(expected);
  });

  it("rejects over-cap totals", () => {
    expect(providerPagesUpperBound(1001)).toBeNull();
  });

  it.each([
    ["disabled", "unavailable"],
    ["unarmed", "unavailable"],
    ["armed", "usage-readiness:unknown"],
    ["terminal", "usage-readiness:unknown"],
    ["unavailable", "usage-readiness:unknown"],
    ["missing", "usage-readiness:unknown"],
  ])("refuses non-ready usage state %s", (state) => {
    const result = evaluateScrydexUsagePreflight({
      providerKey: "scrydex",
      usageBudget: { readiness: "unknown", freshness: state },
    });
    expect(result.admitted).toBe(false);
  });

  it("admits fresh usage with allowance and balance", () => {
    const result = evaluateScrydexUsagePreflight({
      providerKey: "scrydex",
      providerReadiness: "ready",
      usageBudget: {
        readiness: "ready",
        freshness: "fresh",
        creditAllowance: 5000,
        creditBalance: 4000,
        observedAt: "2026-10-21T00:00:00.000Z",
      },
    });
    expect(result.admitted).toBe(true);
  });

  it.each(["armed", "terminal", "unavailable", undefined])("refuses provider-send state %s", (state) => {
    const result = evaluateScrydexOptionRefreshAdmission({
      provider: {
        providerKey: "scrydex",
        readiness: "ready",
        usageBudget: { readiness: "ready", freshness: "fresh", creditAllowance: 5000, creditBalance: 4000 },
      },
      providerSendWindow: state === undefined ? {} : { state },
      rolloutControls: { controls: [] },
      unitKeys: ["scrydex:one-piece:set:reference-data"],
    });
    expect(result.admitted).toBe(false);
    expect(result.preflight.creditBalance).toBe(4000);
  });

  it("refuses a non-open option-query control targeting Scrydex", () => {
    const result = evaluateScrydexOptionRefreshAdmission({
      provider: {
        providerKey: "scrydex",
        readiness: "ready",
        usageBudget: { readiness: "ready", freshness: "fresh", creditAllowance: 5000, creditBalance: 4000 },
      },
      providerSendWindow: { state: "disabled" },
      rolloutControls: {
        controls: [
          {
            controlId: "scrydex-option-query-stop",
            status: "blocked",
            capabilities: ["provider-option-query"],
            providerKeys: ["scrydex"],
            unitKeys: [],
          },
        ],
      },
      unitKeys: ["scrydex:one-piece:set:reference-data"],
    });
    expect(result).toMatchObject({ admitted: false, reason: "rollout-control:scrydex-option-query-stop" });
  });

  it("rejects an impossible complete receipt and enforces exact spend", () => {
    const unitKeys = [
      "scrydex:one-piece:set:reference-data",
      "scrydex:one-piece:single-card:source-observation-import",
      "scrydex:one-piece:sealed-product:source-observation-import",
      "scrydex:lorcana:set:reference-data",
      "scrydex:lorcana:single-card:source-observation-import",
    ] as const;
    const units = unitKeys.map((unitKey) => ({
      unitKey,
      status: "live" as const,
      httpStatus: 500,
      cache: null,
      total: null,
      providerPagesUpperBound: null,
      completedAt: "2026-10-21T00:00:00.000Z",
    }));
    const receipt = buildScrydexOptionRefreshReceipt({
      outcome: "complete",
      reason: null,
      runner: {
        sha: "a".repeat(40),
        runId: "1",
        runAttempt: "1",
        journeyScope: "scrydex-force-refresh-bounded",
        origin: "admin.staging.chasesets.com",
      },
      deployment: {
        beforeSha: "a".repeat(40),
        beforeImageDigest: null,
        afterSha: "a".repeat(40),
        afterImageDigest: null,
      },
      startedAt: "2026-10-21T00:00:00.000Z",
      finishedAt: "2026-10-21T00:01:00.000Z",
      preflight: {
        creditBalance: 4000,
        creditAllowance: 5000,
        observedAt: "2026-10-21T00:00:00.000Z",
        readiness: "ready",
        freshness: "fresh",
      },
      requests: { forced: 5, refusals: 0 },
      units,
      creditsSpentUpperBound: 0,
      assumptions: ["one usage read"],
    });
    expect(validateScrydexOptionRefreshReceipt(receipt)).toEqual(
      expect.arrayContaining([
        "complete: requires five successful units and equal SHA/image deployment binds",
        "creditsSpentUpperBound: must equal one usage read plus attempted unit bounds",
      ]),
    );
  });

  it("admits one typed forced sets request and rejects cache or cursor variants", () => {
    const base =
      "https://admin.staging.chasesets.com/api/catalog/source-observations/integration-options?providerKey=scrydex&profileKey=p&profileVersion=v&ingestionUnitKey=scrydex:one-piece:set:reference-data&queryKind=sets&limit=100&forceRefresh=true";
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: base }).allowed).toBe(true);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${base}&cursor=offset:1` }).allowed).toBe(false);
    expect(classifyScrydexOptionRefreshRequest({ method: "GET", url: `${base}&cacheOnly=true` }).allowed).toBe(false);
    expect(classifyScrydexOptionRefreshRequest({ method: "POST", url: base }).allowed).toBe(false);
  });
});
