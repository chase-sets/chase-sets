import { describe, expect, it, vi } from "vitest";
import { previewCatalogSyncProviderParticipation } from "../../source-observations/api/catalog-sync-scope-planner";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { createScrydexOnePieceProviderAdapter } from "../../source-observations/api/providers/scrydex/adapter";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { captureCountsFixture } from "../tests/count-capture-counts-fixture";
import { captureSession } from "../tests/count-capture-session-fixture";
import { createCapturePlannerFixture } from "../tests/count-capture-planner-fixture";
import { createScopeSyncBatchConfirmationCheck } from "./count-capture-planner";

function fixture() {
  const f = captureCountsFixture();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (String(input) !== "https://api.scrydex.com/account/v1/usage") throw new Error("Unexpected provider I/O.");
    return Response.json({
      data: {
        credits_remaining: 30,
        total_credits_consumed: 0,
        overage_credits_consumed: 0,
        period_start: "2026-01-01T00:00:00Z",
        period_end: "2027-01-01T00:00:00Z",
      },
    });
  });
  const adapter = createScrydexOnePieceProviderAdapter({
    fetch,
    credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
    now: () => new Date(f.clock.now),
    countEnvironment: "staging",
    countAccountRevision: "runtime",
    countReader: { read: async (query) => f.sources[query.kind] ?? null },
  });
  const planned = createCapturePlannerFixture(async () => {
    throw new Error("The real adapter must select count sources.");
  });
  planned.previewCatalogSyncScope.mockImplementation((input) =>
    previewCatalogSyncProviderParticipation({
      ...input,
      acceptedScopeMappings: input.acceptedScopeMappings ?? [],
      providerProfileVersions: catalogProviderIntegrationProfileVersions,
      providerAdapterRegistry: new ProviderAdapterRegistry([adapter]),
    }),
  );
  f.writer.preview.mockImplementation(async (input) => (await planned.planner.resolve(input)).preview);
  f.writer.preConfirmPlannerRead.mockImplementation(
    createScopeSyncBatchConfirmationCheck(planned.planner).preConfirmPlannerRead,
  );
  return { ...f, usageFetch: fetch };
}

describe("capture with the real provider participation planner", () => {
  it("retains both same-request reads without overlapping possible sends", async () => {
    const f = fixture();
    await f.acquire();
    f.clock.now = "2026-10-13T08:04:10.000Z";
    const preview = await f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget });
    await f.lifecycle.preConfirm(captureSession(), {
      selection: f.selection,
      budget: f.budget,
      planFingerprint: preview.planFingerprint,
    });
    const run = f.run();
    expect(run.status).toBe("open");
    expect(run.reads.map((read) => read.phase)).toEqual(["preview", "pre-confirm"]);
    for (const read of run.reads) {
      expect(read.eligible).toBe(true);
      expect(read.winners.map((winner) => winner.source?.sourceId)).toEqual([
        "synthetic-cards-debit",
        "synthetic-sealed-debit",
      ]);
      const sends = run.sends.filter((send) => send.requestId === read.requestId);
      expect(
        sends
          .filter((send) => send.usage?.purpose === "planImport")
          .map((send) => send.usage?.unitKey)
          .sort(),
      ).toEqual([...countCaptureUnitKeys].sort());
      expect(sends.every((send) => send.status === 200)).toBe(true);
      expect(sends.length).toBeLessThanOrEqual(4);
    }
    expect(run.sends).toHaveLength(9);
    expect(f.usageFetch).toHaveBeenCalledTimes(7);
  });

  it("stops after a failed possible send without starting another unit's send", async () => {
    const f = fixture();
    await f.acquire();
    f.usageFetch.mockRejectedValueOnce(new Error("synthetic connection reset"));
    await expect(f.lifecycle.preview(captureSession(), { selection: f.selection, budget: f.budget })).rejects.toThrow(
      CountCaptureStopped,
    );
    expect(f.run().status).toBe("stopped");
    expect(f.run().reads).toEqual([]);
    expect(f.run().sends.filter((send) => send.phase === "preview")).toHaveLength(1);
    expect(f.run().sends.at(-1)?.status).toBeNull();
    expect(f.usageFetch).toHaveBeenCalledTimes(1);
  });
});
