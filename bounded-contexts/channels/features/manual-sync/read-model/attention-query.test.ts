import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { readManualAttentionContributions } from "./attention-query";

describe("manual-owned attention query", () => {
  it("retains recovery precedence and normalizes pg Dates while accepting strings", async () => {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({
      rows: [
        {
          connection_id: "ready",
          run_state: "composed",
          clamp_state: null,
          observed_at: new Date("2026-09-01T00:00:00Z"),
        },
        {
          connection_id: "unknown",
          run_state: "application-unknown",
          clamp_state: null,
          observed_at: "2026-09-02T00:00:00Z",
        },
        {
          connection_id: "recovery",
          run_state: "application-unknown",
          clamp_state: "recovery",
          observed_at: new Date("2026-09-03T00:00:00Z"),
        },
      ],
    });
    expect(
      await readManualAttentionContributions({ query }, "acc_synthetic", ["ready", "unknown", "recovery"]),
    ).toEqual([
      { connectionId: "ready", reason: "ready", observedAt: "2026-09-01T00:00:00.000Z" },
      { connectionId: "unknown", reason: "unknown", observedAt: "2026-09-02T00:00:00Z" },
      { connectionId: "recovery", reason: "recovery", observedAt: "2026-09-03T00:00:00.000Z" },
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY run.connection_id,run.sequence DESC"), [
      "acc_synthetic",
      ["ready", "unknown", "recovery"],
    ]);
  });
  it("rejects oversized batches before database work", async () => {
    const query = vi.fn<PgQueryable["query"]>();
    await expect(
      readManualAttentionContributions(
        { query },
        "acc_synthetic",
        Array.from({ length: 101 }, (_, i) => String(i)),
      ),
    ).rejects.toThrow("invalid-attention-page");
    expect(query).not.toHaveBeenCalled();
  });
});
