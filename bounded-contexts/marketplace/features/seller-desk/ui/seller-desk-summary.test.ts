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
  it.each([0, 1])("renders bounded drift count and overflow %s without hiding health or manual work", (hasMore) => {
    const item = buildSellerAttentionItem({
      source: "channel-action",
      entityId: "connection-1",
      severity: "warning",
      summary: {
        code: "channel-action-open",
        params: {
          reasonCount: 1,
          topReason: "drift",
          affectedListingCount: 100,
          hasMore,
          manualReason: "ready",
          connectionId: "connection-1",
        },
      },
      observedAt: "2026-09-14T00:00:00.000Z",
    });
    const summary = resolveAttentionSummary(item);
    expect(summary).toContain(hasMore ? "Affected listings: more than 100." : "Affected listings: 100.");
    expect(summary).toContain("Health reasons needing attention: 1.");
    expect(summary).toContain(
      resolveAttentionSummary(
        buildSellerAttentionItem({
          ...item,
          entityId: "connection-1",
          summary: { code: "channel-ready", params: { connectionId: "connection-1" } },
        }),
      ),
    );
  });
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

  it.each([
    ["repricing-halt-engaged", {}, "Repricing is halted: no policy changes prices until you release the halt"],
    [
      "repricing-floor-binding",
      { count: 2341 },
      "2,341 listings have been held at their price floor past your alert threshold",
    ],
    [
      "repricing-paused-for-missing-input",
      { count: 12 },
      "12 listings are paused from repricing while a required input is missing",
    ],
    ["repricing-budget-exhausted", { count: 4 }, "A repricing policy used today's change cap; 4 listings waited for tomorrow"],
    ["repricing-frozen", { count: 3 }, "Repricing is briefly frozen on 3 listings of one product and resumes automatically"],
  ] as const)("renders the Pricing-owned %s summary with a grouped count", (code, params, expected) => {
    const item = buildSellerAttentionItem({
      source: "pricing-repricing",
      entityId: code,
      severity: "warning",
      summary: { code, params },
      observedAt: "2026-09-26T12:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe(expected);
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

  it("renders the Channels-owned recovery reason from the Channels catalog", () => {
    const item = buildSellerAttentionItem({
      source: "channel-action",
      entityId: "connection-tcg",
      severity: "warning",
      summary: { code: "channel-recovery", params: { connectionId: "connection-tcg" } },
      observedAt: "2026-09-10T12:00:00.000Z",
    });
    expect(resolveAttentionSummary(item)).toBe("Inbound clamp recovery needs review for connection connection-tcg");
  });
});

describe("labels", () => {
  it("channel-action-shared-facades keeps both mixed summaries and the manual-present action", () => {
    const health = buildSellerAttentionItem({
      source: "channel-action",
      entityId: "connection-tcg",
      severity: "critical",
      summary: { code: "channel-action-open", params: { reasonCount: 1, topReason: "polling" } },
      observedAt: "2026-09-13T00:00:00Z",
    });
    const mixed = {
      ...health,
      summary: {
        ...health.summary,
        params: { ...health.summary.params, manualReason: "recovery", connectionId: "connection-tcg" },
      },
    };
    expect(resolveAttentionSummary(health)).toBe("Health reasons needing attention: 1. First: Channel polling.");
    expect(resolveAttentionSummary(mixed)).toBe(
      "Health reasons needing attention: 1. First: Channel polling. Inbound clamp recovery needs review for connection connection-tcg",
    );
    expect(attentionActionLabel(health)).toBe("Review channel attention");
    expect(attentionActionLabel(mixed)).toBe("Open manual sync");
    expect(mixed.deepLink).toEqual(health.deepLink);
  });
  it("names the deep-link action per source", () => {
    const item = (source: Parameters<typeof buildSellerAttentionItem>[0]["source"]) =>
      buildSellerAttentionItem({
        source,
        entityId: "synthetic",
        severity: "info",
        summary: { code: "channel-ready", params: {} },
        observedAt: "2026-09-10T12:00:00Z",
      });
    expect(attentionActionLabel(item("fulfillment-ship-by"))).toBe("Pack shipment");
    expect(attentionActionLabel(item("offer-response"))).toBe("Review offer");
    expect(attentionActionLabel(item("inventory-resolution"))).toBe("Resolve import");
    expect(attentionActionLabel(item("channel-action"))).toBe("Open manual sync");
    expect(attentionActionLabel(item("pricing-repricing"))).toBe("Review repricing");
  });

  it("names the source for the degraded marker", () => {
    expect(attentionSourceLabel("settlement-blocked-payout")).toBe("Blocked payouts");
    expect(attentionSourceLabel("channel-action")).toBe("Channel action");
    expect(attentionSourceLabel("pricing-repricing")).toBe("Repricing");
  });
});
