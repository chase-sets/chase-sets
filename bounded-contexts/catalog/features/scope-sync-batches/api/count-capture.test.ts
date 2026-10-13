import { describe, expect, it, vi } from "vitest";
import { readScrydexCountSource, scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import { collectCountCaptureWinners } from "./count-capture-context";
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

  it("records absent authority honestly and a missing observer cannot pass", async () => {
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
