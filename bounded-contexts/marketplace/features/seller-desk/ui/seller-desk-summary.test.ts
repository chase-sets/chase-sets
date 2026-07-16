import { describe, expect, it } from "vitest";
import { buildSellerAttentionItem } from "@chase-sets/seller-attention-queue";
import {
  attentionActionLabel,
  attentionSourceLabel,
  resolveAttentionSummary,
  severityLabel,
  severityTone,
} from "./seller-desk-summary";

describe("severity mapping", () => {
  it("maps severities to badge tones", () => {
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("info")).toBe("info");
  });

  it("labels each severity", () => {
    expect(severityLabel("critical")).toBe("Critical");
    expect(severityLabel("warning")).toBe("Warning");
    expect(severityLabel("info")).toBe("Info");
  });
});

describe("resolveAttentionSummary", () => {
  it("interpolates the ship-by summary from its code and params", () => {
    const item = buildSellerAttentionItem({
      source: "fulfillment-ship-by",
      entityId: "ship-1",
      severity: "critical",
      summary: { code: "ship-by-overdue", params: { reference: "SHP-1", dueAt: "2026-07-14T00:00:00.000Z" } },
      observedAt: "2026-07-13T00:00:00.000Z",
      dueAt: "2026-07-14T00:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe("Shipment SHP-1 is past its ship-by deadline");
  });

  it("interpolates the blocked-payout reason", () => {
    const item = buildSellerAttentionItem({
      source: "settlement-blocked-payout",
      entityId: "pay-1",
      severity: "critical",
      summary: { code: "payout-blocked", params: { reference: "PO-1", reason: "verify your bank account" } },
      observedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe("Payout PO-1 is blocked: verify your bank account");
  });

  it("interpolates the import unresolved count", () => {
    const item = buildSellerAttentionItem({
      source: "inventory-resolution",
      entityId: "imp-1",
      severity: "warning",
      summary: { code: "import-rows-unresolved", params: { reference: "IMP-1", count: 4 } },
      observedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe("Import IMP-1 has 4 rows to resolve");
  });

  it("falls back to a neutral label for an unknown code", () => {
    const item = buildSellerAttentionItem({
      source: "listing-action",
      entityId: "lst-1",
      severity: "info",
      summary: { code: "some-future-code", params: {} },
      observedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe("An item needs your attention");
  });
});

describe("labels", () => {
  it("names the deep-link action per source", () => {
    expect(attentionActionLabel("fulfillment-ship-by")).toBe("Pack shipment");
    expect(attentionActionLabel("offer-response")).toBe("Review offer");
    expect(attentionActionLabel("inventory-resolution")).toBe("Resolve import");
  });

  it("names the source for the degraded marker", () => {
    expect(attentionSourceLabel("settlement-blocked-payout")).toBe("Blocked payouts");
  });
});
