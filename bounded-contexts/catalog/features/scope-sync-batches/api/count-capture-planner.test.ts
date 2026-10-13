import { describe, expect, it, vi } from "vitest";
import { createScopeSyncBatchPlannerReads } from "./count-capture-planner";
import { buildScopeSyncBatchPreview } from "../domain/batch";

describe("pre-confirm has no effect capability", () => {
  it("uses the confirmation resolver and eligibility check rather than a renamed preview", async () => {
    const selection = { mode: "ids" as const, scopeRecordIds: [] };
    const preview = buildScopeSyncBatchPreview({ selection, plans: [], resolvedAt: "2026-10-13T08:00:00Z" });
    const resolve = vi.fn(async () => ({ preview, plans: [] }));
    const reads = createScopeSyncBatchPlannerReads({ resolve });
    const context = { tenantId: "synthetic", audit: { performedByUserId: "synthetic", forAccountId: "synthetic" } };
    const input = { selection, planFingerprint: preview.planFingerprint, context };
    const result = await reads.preConfirmPlannerRead(input);
    expect(result.eligible).toBe(false);
    expect(result.effectsCapability).toBe(false);
    expect(result.current.preview).toBe(preview);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(input);
    await expect(reads.resolveConfirmation(input)).rejects.toThrow();
    expect(Object.keys(reads).sort()).toEqual(["preConfirmPlannerRead", "resolveConfirmation"]);
  });
});
