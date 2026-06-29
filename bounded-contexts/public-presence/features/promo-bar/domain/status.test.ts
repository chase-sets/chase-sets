import { describe, expect, it } from "vitest";
import type { PromoBarMessage } from "../api/contracts";
import { isPromoBarMessageLiveAt, promoBarMessageStatusAt } from "./status";

const message = {
  id: "pbm_launch",
  title: "Launch window",
  description: null,
  href: null,
  link_label: null,
  tone: "info",
  is_active: true,
  display_order: 10,
  starts_at: "2026-07-01T12:00:00.000Z",
  ends_at: "2026-07-02T12:00:00.000Z",
  created_at: "2026-06-29T00:00:00.000Z",
  updated_at: "2026-06-29T00:00:00.000Z",
} satisfies PromoBarMessage;

describe("promoBarMessageStatusAt", () => {
  it("treats active scheduled messages as live only within their effective window", () => {
    expect(promoBarMessageStatusAt(message, "2026-07-01T11:59:59.999Z")).toBe("scheduled");
    expect(isPromoBarMessageLiveAt(message, "2026-07-01T11:59:59.999Z")).toBe(false);

    expect(promoBarMessageStatusAt(message, "2026-07-01T12:00:00.000Z")).toBe("active");
    expect(isPromoBarMessageLiveAt(message, "2026-07-01T12:00:00.000Z")).toBe(true);

    expect(promoBarMessageStatusAt(message, "2026-07-02T11:59:59.999Z")).toBe("active");
    expect(isPromoBarMessageLiveAt(message, "2026-07-02T11:59:59.999Z")).toBe(true);

    expect(promoBarMessageStatusAt(message, "2026-07-02T12:00:00.000Z")).toBe("expired");
    expect(isPromoBarMessageLiveAt(message, "2026-07-02T12:00:00.000Z")).toBe(false);
  });

  it("keeps manually inactive messages out of the live set regardless of dates", () => {
    expect(
      promoBarMessageStatusAt(
        {
          ...message,
          is_active: false,
        },
        "2026-07-01T12:00:00.000Z",
      ),
    ).toBe("inactive");
  });
});
