import { describe, expect, it, vi } from "vitest";
import {
  createScrydexOnePieceProviderAdapter,
  readScrydexCountSource,
  scrydexCountQuery,
} from "../../source-observations/api/providers/scrydex/adapter";
import { collectCountCaptureWinners, runCountCaptureRequest, type CountCaptureLedger } from "./count-capture-context";
import type { ProviderUsageSnapshot } from "../../source-observations/api/provider-adapters/provider-adapter";
import { countCaptureUnitKeys } from "../domain/count-lifecycle-receipt";
import { retainTargetedCountCaptureUsage } from "./count-capture-usage";

describe("captures actual winners", () => {
  it("observes this read's exact source and time without another lookup", async () => {
    const now = "2026-10-13T08:00:00.000Z";
    const query = scrydexCountQuery({
      environment: "staging",
      accountRevision: "synthetic",
      productDomain: "one-piece",
      profileKey: "synthetic",
      profileVersion: "1",
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      kind: "cards",
      languageCode: "en",
      parentValue: "OP01",
    });
    const source = {
      query,
      sourceId: "synthetic-source",
      validationKind: "page-1-count" as const,
      totalCount: 121,
      pageSize: 100,
      returnedPage: 1 as const,
      returnedItemCount: 100,
      observedAt: now,
      expiresAt: "2026-10-13T08:15:00.000Z",
    };
    const read = vi.fn(async () => source);
    const result = await collectCountCaptureWinners(() =>
      readScrydexCountSource(query, {
        now: () => new Date(now),
        countReader: { read },
      }),
    );
    expect(result.value).toEqual(source);
    expect(result.winners).toEqual([{ query, source, readAt: now }]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.winners[0]?.source?.sourceId).not.toBe("synthetic-same-total-alternate");
  });

  it("records absent sources and a missing observation distinctly", async () => {
    const query = scrydexCountQuery({
      environment: "staging",
      accountRevision: "synthetic",
      productDomain: "one-piece",
      profileKey: "synthetic",
      profileVersion: "1",
      unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
      kind: "sealed",
      languageCode: "en",
      parentValue: "OP01",
    });
    const result = await collectCountCaptureWinners(() => readScrydexCountSource(query, {}));
    expect(result.winners).toHaveLength(1);
    expect(result.winners[0]?.source).toBeNull();
    const mutant = await collectCountCaptureWinners(async () => null);
    expect(mutant.winners).toHaveLength(0);
  });
});

describe("retains targeted usage", () => {
  it("accounts for all three planning units and one readiness read on each of two cold adapters", async () => {
    let sequence = 0;
    const ledger = {
      debit: vi.fn<CountCaptureLedger["debit"]>(async () => ++sequence),
      result: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    for (const phase of ["preview", "pre-confirm"] as const) {
      const transport = vi.fn<typeof fetch>(async () =>
        Response.json({
          data: {
            credits_remaining: 100,
            total_credits_consumed: 0,
            overage_credits_consumed: 0,
            period_start: "2026-10-01T00:00:00Z",
            period_end: "2026-11-01T00:00:00Z",
          },
        }),
      );
      const adapter = createScrydexOnePieceProviderAdapter({
        fetch: transport,
        credentials: { apiKey: "synthetic", teamId: "synthetic" },
        now: () => new Date("2026-10-13T08:00:00Z"),
      });
      const binding = { runId: "synthetic-run", requestId: `synthetic-${phase}`, phase };
      await runCountCaptureRequest({ binding, ledger }, async () => {
        await Promise.all([adapter.getCredentialReadiness(), adapter.getTransportDiagnostics()]);
        for (const unitKey of countCaptureUnitKeys)
          await adapter.planImport({
            unitKey,
            scopeKey: "synthetic-op01",
            values: { expansionId: "OP01", languageCode: "en" },
          });
      });
      expect(transport).toHaveBeenCalledTimes(4);
      const sends = ledger.debit.mock.calls.filter(([request]) => request.phase === phase).map(([, send]) => send);
      expect(sends.map((send) => send.usage)).toEqual([
        { purpose: "readiness" },
        ...countCaptureUnitKeys.map((unitKey) => ({ purpose: "planImport", unitKey })),
      ]);
    }
    expect(ledger.debit).toHaveBeenCalledTimes(8);
    expect(ledger.stop).not.toHaveBeenCalled();
  });
  it("uses the real sanitizer and callback, then skips without another transport", async () => {
    const now = new Date("2026-10-13T08:00:00.000Z");
    let persisted: ProviderUsageSnapshot | null = null;
    const onUsageObserved = vi.fn(async (snapshot: ProviderUsageSnapshot) => {
      persisted = snapshot;
    });
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          credits_remaining: 100,
          total_credits_consumed: 0,
          overage_credits_consumed: 0,
          period_start: "2026-10-01T00:00:00Z",
          period_end: "2026-11-01T00:00:00Z",
          account_id: "synthetic-private-account-marker",
        },
      }),
    );
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: { apiKey: "synthetic", teamId: "synthetic" },
      fetch: transport,
      now: () => now,
      onUsageObserved,
    });
    const ledger = { debit: vi.fn(async () => 1), result: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const authority = async () => ({
      allowed: persisted?.attemptState === "checked",
      headroom: persisted?.remainingCredits ?? null,
      fingerprint: "synthetic-retained",
    });
    const work = () =>
      retainTargetedCountCaptureUsage({ authority, getUsageSnapshot: () => adapter.getUsageSnapshot!() }, 11);
    const binding = { runId: "synthetic-run", requestId: "synthetic-request", phase: "bootstrap" as const };
    expect(await runCountCaptureRequest({ binding, ledger }, work)).toEqual({ state: "persisted" });
    expect(onUsageObserved).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persisted)).not.toContain("synthetic-private-account-marker");
    expect(onUsageObserved).toHaveBeenCalledWith(
      expect.objectContaining({ providerUpdatedAt: null, lagCategory: "documented-window" }),
    );
    expect(ledger.debit).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ category: "usage", usage: { purpose: "bootstrap" } }),
    );
    expect(await runCountCaptureRequest({ binding, ledger }, work)).toEqual({ state: "skipped" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("skips sufficient durable authority without a provider call", async () => {
    const authority = vi.fn(async () => ({ allowed: true, headroom: 11, fingerprint: "synthetic-authority" }));
    const getUsageSnapshot = vi.fn();
    expect(await retainTargetedCountCaptureUsage({ authority, getUsageSnapshot }, 11)).toEqual({ state: "skipped" });
    expect(getUsageSnapshot).not.toHaveBeenCalled();
  });
  it("does not accept a raw snapshot without the persistence callback", async () => {
    const authority = vi.fn(async () => ({ allowed: false, headroom: null, fingerprint: "synthetic-missing" }));
    const getUsageSnapshot = vi.fn(async () => ({ remainingCredits: 100, attemptState: "checked" }));
    await expect(retainTargetedCountCaptureUsage({ authority, getUsageSnapshot }, 11)).rejects.toThrow(
      "capture-stopped",
    );
    expect(getUsageSnapshot).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenCalledTimes(2);
  });
  it("requires the entire remaining run allowance, not just the count cap", async () => {
    let persisted = false;
    const authority = vi.fn(async () => ({ allowed: true, headroom: persisted ? 10 : 2, fingerprint: "synthetic" }));
    const getUsageSnapshot = vi.fn(async () => {
      persisted = true;
    });
    await expect(retainTargetedCountCaptureUsage({ authority, getUsageSnapshot }, 11)).rejects.toThrow(
      "capture-stopped",
    );
    expect(getUsageSnapshot).toHaveBeenCalledTimes(1);
  });
});
