import { describe, expect, it, vi } from "vitest";
import { listCommercialTermsEffectiveDateAttention } from "./queries";

describe("commercial terms effective-date attention queries", () => {
  it("returns upcoming schedules and expiring overrides in deadline order", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          document_id: "cts_upcoming",
          document_kind: "schedule",
          label: "August business terms",
          account_id: null,
          attention_kind: "upcoming",
          attention_at: "2026-08-01T00:00:00.000Z",
        },
        {
          document_id: "cag_launch",
          document_kind: "agreement",
          label: "Launch override",
          account_id: "acc_seller",
          attention_kind: "expiring",
          attention_at: "2026-08-15T00:00:00.000Z",
        },
      ],
    }));

    await expect(
      listCommercialTermsEffectiveDateAttention({ query } as never, new Date("2026-07-15T12:00:00.000Z")),
    ).resolves.toEqual([
      {
        id: "schedule:cts_upcoming:upcoming",
        kind: "upcoming-schedule",
        label: "August business terms",
        detail: "Effective 2026-08-01",
        attentionAt: "2026-08-01T00:00:00.000Z",
        href: "/commerce/terms?schedule=cts_upcoming",
      },
      {
        id: "agreement:cag_launch:expiring",
        kind: "expiring-override",
        label: "Launch override",
        detail: "Override expires 2026-08-15",
        attentionAt: "2026-08-15T00:00:00.000Z",
        href: "/commerce/terms?agreement=cag_launch",
      },
    ]);
  });
});
