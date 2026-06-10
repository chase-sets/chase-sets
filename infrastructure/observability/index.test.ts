import { describe, expect, it, vi } from "vitest";
import {
  catalogControlPlaneEventAttributes,
  catalogIntegrationJobAttributes,
  catalogIntegrationOptionQueryAttributes,
  createLogger,
  loadObservabilityConfig,
  projectionFreshnessAuditMetricRecords,
  publicPresenceWaitlistAnalyticsAttributes,
  sanitizeLogFields,
} from "./index";

describe("observability config", () => {
  it("loads low-cost local defaults", () => {
    expect(loadObservabilityConfig({})).toMatchObject({
      enabled: true,
      serviceName: "platform-api",
      deploymentEnvironment: "local",
      otlpEndpoint: "http://localhost:4318",
      tracesSamplerArg: "1.0",
      logFilePath: undefined,
      logLevel: "info",
    });
  });

  it("allows production sampling and explicit service identity", () => {
    expect(
      loadObservabilityConfig({
        NODE_ENV: "production",
        OTEL_SERVICE_NAME: "api",
        OTEL_SERVICE_VERSION: "1.2.3",
        DEPLOYMENT_ENVIRONMENT: "production",
        OTEL_RESOURCE_ATTRIBUTES: "region=us-central,team=marketplace",
        LOG_FILE_PATH: "./platform-api.jsonl",
        LOG_LEVEL: "warn",
      }),
    ).toMatchObject({
      serviceName: "api",
      serviceVersion: "1.2.3",
      deploymentEnvironment: "production",
      tracesSamplerArg: "0.1",
      logFilePath: "./platform-api.jsonl",
      logLevel: "warn",
      resourceAttributes: {
        region: "us-central",
        team: "marketplace",
      },
    });
  });
});

describe("structured logging", () => {
  it("redacts sensitive fields recursively", () => {
    expect(
      sanitizeLogFields({
        route: "/api/orders",
        authorization: "Bearer secret",
        nested: {
          email: "buyer@example.com",
          status: "ok",
        },
      }),
    ).toEqual({
      route: "/api/orders",
      authorization: "[redacted]",
      nested: {
        email: "[redacted]",
        status: "ok",
      },
    });
  });

  it("writes JSON logs at the configured level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger(
      loadObservabilityConfig({
        LOG_LEVEL: "info",
        OTEL_SERVICE_NAME: "test-service",
        DEPLOYMENT_ENVIRONMENT: "test",
      }),
    );

    logger.debug("hidden");
    logger.info("visible", { type: "test.log", token: "secret" });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      level: "info",
      message: "visible",
      service: "test-service",
      environment: "test",
      type: "test.log",
      token: "[redacted]",
    });
    log.mockRestore();
  });
});

describe("public presence waitlist analytics observability", () => {
  it("maps landing analytics to bounded metric labels", () => {
    expect(
      publicPresenceWaitlistAnalyticsAttributes({
        event: "cta clicked!",
        section: "hero",
        target: "waitlist_form",
        field: "consent",
        role: "sell",
        interest: "low-sales-fees",
        variant: "landing-audit-remediation",
        status: null,
      }),
    ).toEqual({
      context: "public-presence",
      event: "cta_clicked_",
      section: "hero",
      target: "waitlist_form",
      field: "consent",
      role: "sell",
      interest: "low-sales-fees",
      variant: "landing-audit-remediation",
      status: "none",
    });
  });
});

describe("catalog integration observability", () => {
  it("maps control-plane journey events to bounded redaction-safe labels", () => {
    expect(
      catalogControlPlaneEventAttributes({
        eventName: "catalog_control_plane.supporting_workflow_detour_opened",
        providerKey: "TCG Player Provider",
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
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
      }),
    ).toEqual({
      context: "catalog",
      event: "catalog_control_plane.supporting_workflow_detour_opened",
      provider: "TCG_Player_Provider",
      unit: "tcgplayer_pokemon_single-card_source-observation-import",
      scope: "en_3_base_base1",
      profile: "pokemon-tcg_2026.06.04",
      job_ref: "present",
      observation_status: "changed",
      observation_count: "11-100",
      promotion_result: "preview-ready",
      promotion_count: "2-10",
      blocker_category: "provider-transport",
      detour_target: "adapter-readiness",
      detour_outcome: "opened",
      role_bucket: "operator",
      read_model_freshness: "fresh",
    });
  });

  it("maps provider option queries to bounded metric labels", () => {
    expect(
      catalogIntegrationOptionQueryAttributes({
        providerKey: "TCG Player Provider",
        queryKind: "Product Lines / Set Names / Very Long Query Kind".repeat(4),
        cacheStatus: "stale",
        cacheSource: "cache",
        result: "success",
        degraded: true,
        cacheOnly: false,
        forceRefresh: true,
      }),
    ).toEqual({
      context: "catalog",
      provider: "TCG_Player_Provider",
      query_kind: "Product_Lines_Set_Names_Very_Long_Query_KindProduct_Lines_Set_Names_Very_Long_Qu",
      cache_status: "stale",
      cache_source: "cache",
      result: "success",
      degraded: true,
      cache_only: false,
      force_refresh: true,
    });
  });

  it("maps integration jobs without high-cardinality IDs", () => {
    expect(
      catalogIntegrationJobAttributes({
        operation: "bulk-review-work-unit",
        jobKind: "promote",
        result: "failed",
      }),
    ).toEqual({
      context: "catalog",
      operation: "bulk-review-work-unit",
      job_kind: "promote",
      result: "failed",
    });
  });
});

describe("projection freshness observability", () => {
  it("maps freshness audits to bounded route-template metric labels", () => {
    const records = projectionFreshnessAuditMetricRecords({
      type: "read-after-write.freshness",
      outcome: "fresh",
      method: "get",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: true,
      readTargetContextHeaderValid: true,
      requestedTargetContextName: "checkout",
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      durationMs: 347.8,
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 2,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });

    expect(records.evaluations).toHaveLength(1);
    expect(records.evaluations[0]).toEqual({
      durationMs: 348,
      attributes: {
        type: "read-after-write.freshness",
        outcome: "fresh",
        method: "GET",
        mount_path: "/api/marketplace",
        route_path: "/account/checkout-sessions/:sessionId",
        target_context: "checkout",
        projection: "checkout.session-projection",
        source_context: "checkout",
        wait_mode: "exact-dependency",
        receipt: "present",
        target_context_header: "present_valid",
        receipt_source_count: 1,
        receipt_event_count: 2,
      },
    });
    expect(records.pending).toEqual([]);
  });

  it("maps timeout pending lag without high-cardinality identifiers", () => {
    const records = projectionFreshnessAuditMetricRecords({
      type: "read-after-write.freshness",
      outcome: "timeout",
      method: "GET",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: false,
      readTargetContextHeaderValid: false,
      requestedTargetContextName: null,
      targetContextNames: ["checkout"],
      waitMode: "target-context",
      durationMs: 900,
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [],
      pending: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          sourceContextName: "checkout",
          globalPositionLag: "4",
          state: "degraded",
          lastError: "present",
        },
      ],
    });

    expect(records.evaluations[0].attributes).toMatchObject({
      outcome: "timeout",
      route_path: "/account/checkout-sessions/:sessionId",
      target_context: "checkout",
      projection: "none",
      source_context: "checkout",
      wait_mode: "target-context",
      target_context_header: "missing",
    });
    expect(records.pending).toEqual([
      {
        globalPositionLag: 4,
        attributes: {
          type: "read-after-write.freshness",
          outcome: "timeout",
          method: "GET",
          mount_path: "/api/marketplace",
          route_path: "/account/checkout-sessions/:sessionId",
          target_context: "checkout",
          projection: "checkout.session-projection",
          source_context: "checkout",
          wait_mode: "target-context",
          state: "degraded",
          last_error: "present",
        },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("chk_");
    expect(JSON.stringify(records)).not.toContain("account_");
    expect(JSON.stringify(records)).not.toContain("todd.skelton");
    expect(JSON.stringify(records)).not.toContain("afterWrite");
  });

  it("classifies missing receipts and invalid target context headers for alerting", () => {
    const records = projectionFreshnessAuditMetricRecords({
      type: "read-after-write.freshness",
      outcome: "missing-receipt",
      method: "HEAD",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: false,
      readTargetContextHeaderPresent: true,
      readTargetContextHeaderValid: false,
      requestedTargetContextName: null,
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      durationMs: -1,
      receiptSourceContextNames: [],
      receiptSourceCount: 0,
      receiptEventCount: 0,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });

    expect(records.evaluations[0]).toMatchObject({
      durationMs: 0,
      attributes: {
        outcome: "missing-receipt",
        method: "HEAD",
        receipt: "missing",
        target_context_header: "present_invalid",
        source_context: "none",
      },
    });
  });

  it("defensively collapses concrete route ids if a caller passes a path", () => {
    const records = projectionFreshnessAuditMetricRecords({
      type: "read-after-write.freshness",
      outcome: "fresh",
      method: "GET",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/chk_01KTMF9TCCPKGA3J3TYMGGXQ2R"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: true,
      readTargetContextHeaderValid: true,
      requestedTargetContextName: "checkout",
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      durationMs: 10,
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });

    expect(records.evaluations[0].attributes.route_path).toBe("/account/checkout-sessions/:id");
    expect(JSON.stringify(records)).not.toContain("chk_01KTMF9TCCPKGA3J3TYMGGXQ2R");
  });
});
