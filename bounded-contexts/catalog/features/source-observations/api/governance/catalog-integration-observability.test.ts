import { describe, expect, it } from "vitest";
import { normalizeCatalogControlPlaneTelemetryEvent } from "./catalog-integration-observability";

describe("Catalog control plane telemetry normalization", () => {
  it("keeps only bounded redaction-safe dimensions", () => {
    expect(
      normalizeCatalogControlPlaneTelemetryEvent({
        eventName: "catalog_control_plane.blocker_hit",
        providerKey: "tcgdex",
        unitKey: "tcgdex:pokemon:single-card:source-observation-import",
        scopeId: "en:3:base:base1",
        profileRef: "pokemon-tcg:2026.06.04",
        jobRefState: "present",
        observationStatus: "changed",
        observationCount: 37,
        promotionResult: "preview-ready",
        promotionCount: 2,
        blockerCategory: "provider-transport",
        detourTarget: "adapter-readiness",
        detourOutcome: "opened",
        roleBucket: "operator",
        readModelFreshness: "fresh",
      }),
    ).toEqual({
      eventName: "catalog_control_plane.blocker_hit",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      scopeId: "en:3:base:base1",
      profileRef: "pokemon-tcg:2026.06.04",
      jobRefState: "present",
      observationStatus: "changed",
      observationCountBucket: "11-100",
      promotionResult: "preview-ready",
      promotionCountBucket: "2-10",
      blockerCategory: "provider-transport",
      detourTarget: "adapter-readiness",
      detourOutcome: "opened",
      roleBucket: "operator",
      readModelFreshness: "fresh",
    });
  });

  it("drops free-form and unsafe dimension values before metrics", () => {
    expect(
      normalizeCatalogControlPlaneTelemetryEvent({
        eventName: "catalog_control_plane.primary_workbench_viewed",
        providerKey: "provider@example.com",
        unitKey: "unit with spaces",
        scopeId: "raw payload {secret}",
        profileRef: "profile\nversion",
        jobRefState: "job_123" as never,
        observationStatus: "raw-provider-status" as never,
        observationCount: -1,
        promotionResult: "operator typed note" as never,
        promotionCount: Number.NaN,
        blockerCategory: "credential-secret" as never,
        detourTarget: "raw-json" as never,
        detourOutcome: "clicked something" as never,
        roleBucket: "todd@example.com" as never,
        readModelFreshness: "fresh",
      }),
    ).toMatchObject({
      providerKey: "none",
      unitKey: "none",
      scopeId: "none",
      profileRef: "none",
      jobRefState: "none",
      observationStatus: "none",
      observationCountBucket: "unknown",
      promotionResult: "none",
      promotionCountBucket: "unknown",
      blockerCategory: "unknown",
      detourTarget: "none",
      detourOutcome: "not-applicable",
      roleBucket: "unknown",
      readModelFreshness: "fresh",
    });
  });

  it("keeps conflict resolution as a rebuilt support detour target", () => {
    expect(
      normalizeCatalogControlPlaneTelemetryEvent({
        eventName: "catalog_control_plane.supporting_workflow_detour_opened",
        detourTarget: "conflict-resolution",
        detourOutcome: "opened",
      }).detourTarget,
    ).toBe("conflict-resolution");
  });
});
