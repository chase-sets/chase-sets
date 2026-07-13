import { describe, expect, it, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import {
  catalogControlPlaneEventAttributes,
  catalogIntegrationJobAttributes,
  catalogIntegrationOptionQueryAttributes,
  createHonoObservabilityMiddleware,
  checkoutObservabilityEventAttributes,
  createLogger,
  itemDetailRailAnalyticsAttributes,
  loadObservabilityConfig,
  parseOtlpHeaders,
  postWriteConsistencyEventAttributes,
  projectionFreshnessAuditMetricRecords,
  projectionFreshnessWakeEnqueueMetricRecord,
  projectionInterestIndexLookupMetricRecord,
  projectionWakeIntentEnqueueOutcomeMetricRecord,
  publicPresenceWaitlistAnalyticsAttributes,
  recordCheckoutObservabilityEvent,
  recordEventStoreAppendAdvisoryLockHold,
  recordMcpAuditRecord,
  recordPostWriteConsistencyEvent,
  recordProjectionFreshnessWakeEnqueue,
  recordProviderWebhookIngestion,
  recordProjectionInterestIndexLookup,
  recordProjectionWakeIntentEnqueueOutcome,
  recordProjectionWakeIntentOutcome,
  recordProjectionWakeNotificationEmitted,
  recordProjectionWakeRelayCatchUp,
  recordProjectionWakeRelayFanOut,
  sanitizeLogFields,
  type CheckoutObservabilityEventSignal,
} from "./index";

describe("observability config", () => {
  it("loads low-cost local defaults", () => {
    expect(loadObservabilityConfig({})).toMatchObject({
      enabled: true,
      serviceName: "platform-api",
      deploymentEnvironment: "local",
      otlpEndpoint: "http://localhost:4318",
      otlpHeaders: {},
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
        OTEL_EXPORTER_OTLP_HEADERS: "x-chase-sets-observability-token=token%20value,Authorization=Bearer%20otel",
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
      otlpHeaders: {
        "x-chase-sets-observability-token": "token value",
        Authorization: "Bearer otel",
      },
      resourceAttributes: {
        region: "us-central",
        team: "marketplace",
      },
    });
  });

  it("ignores malformed OTLP header entries without crashing startup", () => {
    expect(parseOtlpHeaders("x-token=abc,missingEquals,bad name=value,x-empty=")).toEqual({
      "x-token": "abc",
      "x-empty": "",
    });
  });
});

describe("provider webhook ingestion observability", () => {
  it("records bounded failure classes without putting provider ids in metric labels", () => {
    const counterAdds: unknown[] = [];
    const createCounter = vi.fn((name: string) => ({
      add: (value: number, attributes?: unknown) => counterAdds.push({ name, value, attributes }),
    }));
    const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter,
      createHistogram: vi.fn(),
      createUpDownCounter: vi.fn(),
    } as never);

    try {
      recordProviderWebhookIngestion({
        endpoint: "payments",
        failureClass: "handler-failure",
        outcome: "failed",
        statusCode: 400,
        retryable: true,
        providerEventId: "evt_private",
        eventKind: "payment-captured",
      });
    } finally {
      getMeter.mockRestore();
    }

    expect(counterAdds).toEqual([
      {
        name: "chase_sets_stripe_webhook_ingestion_total",
        value: 1,
        attributes: {
          endpoint: "payments",
          failure_class: "handler-failure",
          outcome: "failed",
          status_code: 400,
          retryable: "true",
          event_kind: "payment-captured",
        },
      },
    ]);
    expect(JSON.stringify(counterAdds)).not.toContain("evt_private");
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
        OBSERVABILITY_ENABLED: "false",
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

  it("exports structured logs through OTLP with scoped write headers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const logger = createLogger(
      loadObservabilityConfig({
        OTEL_SERVICE_NAME: "platform-api",
        DEPLOYMENT_ENVIRONMENT: "production",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        OTEL_EXPORTER_OTLP_HEADERS: "x-chase-sets-observability-token=writer-token",
      }),
    );

    logger.info("visible", { type: "test.log", count: 2, token: "secret" });

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "https://otel.example.test/v1/logs",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "content-type": "application/json",
            "x-chase-sets-observability-token": "writer-token",
          }),
        }),
      );
    });

    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(body.resourceLogs[0].resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "platform-api" } },
        { key: "deployment.environment", value: { stringValue: "production" } },
      ]),
    );
    expect(JSON.parse(record.body.stringValue)).toMatchObject({
      message: "visible",
      service: "platform-api",
      environment: "production",
      type: "test.log",
      count: 2,
      token: "[redacted]",
    });

    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("bounds concurrent structured log exports and drops overflow", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const pending: Array<() => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(new Response(null, { status: 200 })));
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const logger = createLogger(
      loadObservabilityConfig({
        OTEL_SERVICE_NAME: "platform-worker",
        DEPLOYMENT_ENVIRONMENT: "staging",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        LOG_EXPORT_MAX_IN_FLIGHT: "2",
        LOG_EXPORT_QUEUE_SIZE: "1",
      }),
    );

    logger.info("first");
    logger.info("second");
    logger.info("queued");
    logger.info("dropped");

    expect(fetch).toHaveBeenCalledTimes(2);

    pending.shift()?.();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    for (const resolve of pending.splice(0)) {
      resolve();
    }
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);

    log.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("request metrics", () => {
  it("creates custom HTTP instruments from the active meter when a request is recorded", async () => {
    const counterAdds: unknown[] = [];
    const histogramRecords: unknown[] = [];
    const createCounter = vi.fn((name: string) => ({
      add: (value: number, attributes?: unknown) => counterAdds.push({ name, value, attributes }),
    }));
    const createHistogram = vi.fn((name: string) => ({
      record: (value: number, attributes?: unknown) => histogramRecords.push({ name, value, attributes }),
    }));
    const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter,
      createHistogram,
      createUpDownCounter: vi.fn(),
    } as never);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const middleware = createHonoObservabilityMiddleware(logger);
    const context = {
      req: {
        raw: new Request("https://admin.chasesets.com/api/health/ready"),
        method: "GET",
        path: "/api/health/ready",
      },
      res: undefined as Response | undefined,
    };

    try {
      await middleware(context, async () => {
        context.res = new Response(null, { status: 204 });
      });
    } finally {
      getMeter.mockRestore();
    }

    expect(createCounter).toHaveBeenCalledWith("chase_sets_http_server_requests_total", undefined);
    expect(createHistogram).toHaveBeenCalledWith("chase_sets_http_server_request_duration_ms", { unit: "ms" });
    expect(counterAdds).toContainEqual({
      name: "chase_sets_http_server_requests_total",
      value: 1,
      attributes: {
        method: "GET",
        route: "/api/health/ready",
        status_class: "2xx",
      },
    });
    expect(histogramRecords).toEqual([
      expect.objectContaining({
        name: "chase_sets_http_server_request_duration_ms",
        attributes: {
          method: "GET",
          route: "/api/health/ready",
          status_class: "2xx",
        },
      }),
    ]);
  });
});

describe("MCP observability", () => {
  it("records native MCP audit outcomes with bounded labels", () => {
    const counterAdds: unknown[] = [];
    const createCounter = vi.fn((name: string) => ({
      add: (value: number, attributes?: unknown) => counterAdds.push({ name, value, attributes }),
    }));
    const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter,
      createHistogram: vi.fn(),
      createUpDownCounter: vi.fn(),
    } as never);

    try {
      recordMcpAuditRecord({
        outcome: "denied",
        method: "resources/read",
        resourceUri: "chase-sets://inventory/account_1/import-batches/batch_1",
        auditEventName: "mcp.inventory.resources.read",
        targetType: "Inventory Import Batch",
        reason: "Missing required permission: inventory.view.",
      });
    } finally {
      getMeter.mockRestore();
    }

    expect(createCounter).toHaveBeenCalledWith("chase_sets_mcp_audit_records_total", undefined);
    expect(counterAdds).toEqual([
      {
        name: "chase_sets_mcp_audit_records_total",
        value: 1,
        attributes: {
          outcome: "denied",
          method: "resources/read",
          tool: "none",
          resource: "present",
          audit_event: "mcp.inventory.resources.read",
          target_type: "Inventory_Import_Batch",
          reason: "missing_required_permission_inventory_view",
        },
      },
    ]);
    expect(JSON.stringify(counterAdds)).not.toContain("account_1");
    expect(JSON.stringify(counterAdds)).not.toContain("batch_1");
  });
});

describe("checkout observability", () => {
  const operatorSignalEvent = {
    eventName: "checkout.capability.kill_switch_unavailable",
    telemetryClass: "capability-state",
    alertClass: "operator-alert",
    entrySource: "buy-now",
    actorMode: "guest",
    scenarioState: "kill-switch",
    visibleState: "checkout-review",
    sideEffectStatus: "not-attempted",
    operatorSignalRequired: true,
    readinessContract: "checkout.cart-readiness.v1",
    readinessSnapshotState: "fresh",
    sourceRevisionState: "current",
    freshWriteReceiptPresence: "present-valid",
    supportReferencePresent: true,
    performanceBudgetId: "checkout-entry-ready-slo",
    providerCategory: "none",
    riskCategory: "none",
    downstreamStatus: "not-started",
    capabilityDecision: "enabled",
    freshStateScanResult: "not-applicable",
  } satisfies CheckoutObservabilityEventSignal;

  it("maps checkout events to bounded operator labels", () => {
    expect(checkoutObservabilityEventAttributes(operatorSignalEvent)).toEqual({
      context: "checkout",
      event_name: "checkout.capability.kill_switch_unavailable",
      telemetry_class: "capability-state",
      alert_class: "operator-alert",
      entry_source: "buy-now",
      actor_mode: "guest",
      scenario_state: "kill-switch",
      visible_state: "checkout-review",
      side_effect_status: "not-attempted",
      operator_signal_required: "true",
      readiness_contract: "checkout.cart-readiness.v1",
      readiness_snapshot_state: "fresh",
      source_revision_state: "current",
      fresh_write_receipt_presence: "present-valid",
      support_reference_present: "true",
      performance_budget_id: "checkout-entry-ready-slo",
      provider_category: "none",
      risk_category: "none",
      downstream_status: "not-started",
      capability_decision: "enabled",
      fresh_state_scan_result: "not-applicable",
    });
  });

  it("whitelists redacted checkout labels instead of raw checkout data", () => {
    const attributes = checkoutObservabilityEventAttributes({
      ...operatorSignalEvent,
      checkoutSessionId: "cs_raw_123",
      accountId: "acct_raw_123",
      email: "buyer@example.com",
      address: "3354 Brush Creek Court",
      afterWrite: "raw-after-write-token",
      providerPayload: { id: "pi_raw_123" },
      fullUrl: "https://example.test/checkouts/cn/raw",
    } as CheckoutObservabilityEventSignal & Record<string, unknown>);

    const serializedAttributes = JSON.stringify(attributes);

    expect(Object.keys(attributes)).not.toEqual(
      expect.arrayContaining(["checkoutSessionId", "accountId", "email", "address", "afterWrite", "providerPayload"]),
    );
    expect(serializedAttributes).not.toContain("cs_raw_123");
    expect(serializedAttributes).not.toContain("acct_raw_123");
    expect(serializedAttributes).not.toContain("buyer@example.com");
    expect(serializedAttributes).not.toContain("Brush Creek");
    expect(serializedAttributes).not.toContain("raw-after-write-token");
    expect(serializedAttributes).not.toContain("pi_raw_123");
    expect(serializedAttributes).not.toContain("checkouts/cn/raw");
  });

  it("records checkout events through the shared metric without requiring raw ids", () => {
    expect(() => recordCheckoutObservabilityEvent(operatorSignalEvent)).not.toThrow();
  });
});

describe("post-write consistency observability", () => {
  it("maps canonical post-write outcomes to low-cardinality labels", () => {
    const outcomes = [
      "projection_hit",
      "fallback_used",
      "fallback_failed",
      "missing_strategy",
      "optimistic_applied",
      "freshness_timeout",
      "rollback",
      "reconciliation",
      "stale_response_discard",
      "handoff_parsed",
      "handoff_satisfied",
      "handoff_pending",
      "handoff_expired",
      "handoff_invalid",
      "handoff_malformed",
      "handoff_permanent",
      "navigation_encoded",
      "navigation_missing_receipt",
      "read_data",
      "read_pending",
      "read_permanent",
    ] as const;

    expect(
      outcomes.map((outcome) =>
        postWriteConsistencyEventAttributes({
          boundedContextName: "checkout",
          surface: "account-cart",
          strategy: "optimistic-with-correction",
          outcome,
          routeId: "account-cart",
          routeTemplate: "/account/cart",
          correctionSource: "fresh-read:loader-revalidation",
          actorMode: "account",
          recoveryAction: outcome === "freshness_timeout" ? "reload_prompt" : null,
          freshnessOutcome: outcome === "freshness_timeout" ? "timeout" : "none",
        }),
      ),
    ).toEqual(
      outcomes.map((outcome) => ({
        type: "post-write.consistency",
        context: "checkout",
        surface: "account-cart",
        strategy: "optimistic-with-correction",
        outcome,
        route_id: "account-cart",
        route_template: "/account/cart",
        correction_source: "fresh-read_loader-revalidation",
        actor_mode: "account",
        recovery_action: outcome === "freshness_timeout" ? "reload_prompt" : "none",
        freshness_outcome: outcome === "freshness_timeout" ? "timeout" : "none",
        source_context: "none",
        projection: "none",
        read_model_table: "none",
        fallback_id: "none",
        fallback_category: "none",
      })),
    );
  });

  it("collapses raw-looking identifiers and ignores non-whitelisted fields", () => {
    const attributes = postWriteConsistencyEventAttributes({
      boundedContextName: "checkout",
      surface: "account cart raw 123",
      strategy: "optimistic-with-correction",
      outcome: "stale_response_discard",
      routeId: "account-cart/account_123",
      routeTemplate: "/account/cart/acct_01KTMF9TCCPKGA3J3TYMGGXQ2R",
      correctionSource: "fresh-read:loader-revalidation",
      actorMode: "account",
      recoveryAction: "discarded-stale-snapshot",
      freshnessOutcome: "not-required",
      accountId: "account_123",
      cartId: "cart_123",
      email: "buyer@example.com",
      afterWrite: "afterWrite=raw-token",
      checkoutSessionId: "chk_01KTMF9TCCPKGA3J3TYMGGXQ2R",
      fullUrl: "https://example.test/account/cart/acct_01KTMF9TCCPKGA3J3TYMGGXQ2R",
    } as never);

    const serializedAttributes = JSON.stringify(attributes);

    expect(attributes).toEqual({
      type: "post-write.consistency",
      context: "checkout",
      surface: "account_cart_raw_123",
      strategy: "optimistic-with-correction",
      outcome: "stale_response_discard",
      route_id: "account-cart_id",
      route_template: "/account/cart/:id",
      correction_source: "fresh-read_loader-revalidation",
      actor_mode: "account",
      recovery_action: "discarded-stale-snapshot",
      freshness_outcome: "not-required",
      source_context: "none",
      projection: "none",
      read_model_table: "none",
      fallback_id: "none",
      fallback_category: "none",
    });
    expect(serializedAttributes).not.toContain("account_123");
    expect(serializedAttributes).not.toContain("cart_123");
    expect(serializedAttributes).not.toContain("buyer@example.com");
    expect(serializedAttributes).not.toContain("raw-token");
    expect(serializedAttributes).not.toContain("chk_01KTMF9TCCPKGA3J3TYMGGXQ2R");
  });

  it("records post-write consistency events through the shared metric", () => {
    expect(() =>
      recordPostWriteConsistencyEvent({
        boundedContextName: "checkout",
        surface: "account-cart",
        strategy: "optimistic-with-correction",
        outcome: "rollback",
        routeId: "account-cart",
        routeTemplate: "/account/cart",
        correctionSource: "fresh-read:loader-revalidation",
        actorMode: "account",
        recoveryAction: "inline_error",
        freshnessOutcome: "not-required",
      }),
    ).not.toThrow();
  });

  it("maps projection fallback diagnostics without exposing source payloads", () => {
    const attributes = postWriteConsistencyEventAttributes({
      boundedContextName: "commercial-terms",
      surface: "commercial-terms-resolution",
      strategy: "projection-fallback",
      outcome: "fallback_failed",
      sourceContextName: "identity",
      projectionName: "commercial-terms-account-projection",
      readModelTable: "commercial_terms_account_pages",
      fallbackId: "commercial-terms.identity-account-source-fresh-account",
      fallbackCategory: "host-owned bridge",
      accountId: "acc_123",
      identityPayload: {
        email: "seller@example.com",
        accountId: "acc_123",
      },
    } as never);

    expect(attributes).toEqual({
      type: "post-write.consistency",
      context: "commercial-terms",
      surface: "commercial-terms-resolution",
      strategy: "projection-fallback",
      outcome: "fallback_failed",
      route_id: "none",
      route_template: "none",
      correction_source: "none",
      actor_mode: "none",
      recovery_action: "none",
      freshness_outcome: "none",
      source_context: "identity",
      projection: "commercial-terms-account-projection",
      read_model_table: "commercial_terms_account_pages",
      fallback_id: "commercial-terms.identity-account-source-fresh-account",
      fallback_category: "host-owned_bridge",
    });

    const serializedAttributes = JSON.stringify(attributes);
    expect(serializedAttributes).not.toContain("acc_123");
    expect(serializedAttributes).not.toContain("seller@example.com");
  });

  it("maps semantic handoff diagnostics without exposing handoff payloads", () => {
    const attributes = postWriteConsistencyEventAttributes({
      boundedContextName: "checkout",
      surface: "account-cart",
      strategy: "fresh-read",
      outcome: "handoff_pending",
      routeId: "account-cart",
      routeTemplate: "/account/cart",
      correctionSource: "semantic-handoff:checkout.cart.add-line",
      actorMode: "guest",
      recoveryAction: "pending_empty_state",
      freshnessOutcome: "valid-after-write",
      afterWrite: "afterWrite=raw-token",
      postWriteHandoff: encodeURIComponent(
        JSON.stringify({
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          cartId: "cart_123",
        }),
      ),
      accountId: "account_123",
      fullUrl: "https://example.test/account/cart?postWriteHandoff=raw",
    } as never);

    const serializedAttributes = JSON.stringify(attributes);

    expect(attributes).toEqual({
      type: "post-write.consistency",
      context: "checkout",
      surface: "account-cart",
      strategy: "fresh-read",
      outcome: "handoff_pending",
      route_id: "account-cart",
      route_template: "/account/cart",
      correction_source: "semantic-handoff_checkout.cart.add-line",
      actor_mode: "guest",
      recovery_action: "pending_empty_state",
      freshness_outcome: "valid-after-write",
      source_context: "none",
      projection: "none",
      read_model_table: "none",
      fallback_id: "none",
      fallback_category: "none",
    });
    expect(serializedAttributes).not.toContain("raw-token");
    expect(serializedAttributes).not.toContain("postWriteHandoff");
    expect(serializedAttributes).not.toContain("cart_123");
    expect(serializedAttributes).not.toContain("account_123");
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

describe("item detail rail analytics observability", () => {
  it("maps rail funnel analytics to bounded metric labels", () => {
    expect(
      itemDetailRailAnalyticsAttributes({
        event: "reference info opened",
        intent: "sell",
        workflow: "selected_offer",
        selection: "explicit",
        topic: "estimated_payout",
        outcome: "shown",
        gate: null,
        viewer: "guest",
        surface: "action_rail",
      }),
    ).toEqual({
      context: "marketplace",
      event: "reference_info_opened",
      intent: "sell",
      workflow: "selected_offer",
      selection: "explicit",
      topic: "estimated_payout",
      outcome: "shown",
      gate: "none",
      viewer: "guest",
      surface: "action_rail",
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
      wakeRequestCount: 0,
      workSignalError: null,
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
    expect(records.wakeRequests).toEqual([]);
    expect(records.workSignalErrors).toEqual([]);
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
      wakeRequestCount: 2,
      workSignalError: "present",
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
    expect(records.wakeRequests).toEqual([
      {
        wakeRequestCount: 2,
        attributes: {
          outcome: "timeout",
          wait_mode: "target-context",
        },
      },
    ]);
    expect(records.workSignalErrors).toEqual([
      {
        attributes: {
          outcome: "timeout",
          wait_mode: "target-context",
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
      wakeRequestCount: 0,
      workSignalError: null,
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
      wakeRequestCount: 0,
      workSignalError: null,
      pending: [],
    });

    expect(records.evaluations[0].attributes.route_path).toBe("/account/checkout-sessions/:id");
    expect(JSON.stringify(records)).not.toContain("chk_01KTMF9TCCPKGA3J3TYMGGXQ2R");
  });
});

describe("event-store append lock observability", () => {
  it("records append advisory-lock hold duration with bounded holder labels", () => {
    const histogramRecords: unknown[] = [];
    const createHistogram = vi.fn((name: string) => ({
      record: (value: number, attributes?: unknown) => histogramRecords.push({ name, value, attributes }),
    }));
    const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter: vi.fn(),
      createHistogram,
      createUpDownCounter: vi.fn(),
    } as never);

    try {
      recordEventStoreAppendAdvisoryLockHold({
        durationMs: 12.6,
        outcome: "committed",
        holderKind: "reaction",
        targetContextName: "ordering",
        sourceContextName: "marketplace",
        projectionName: "ordering-marketplace-offer-acceptance",
        subscriptionName: "ordering.marketplace-offer-acceptance",
      });
    } finally {
      getMeter.mockRestore();
    }

    expect(createHistogram).toHaveBeenCalledWith("chase_sets_event_store_append_advisory_lock_hold_duration_ms", {
      unit: "ms",
    });
    expect(histogramRecords).toEqual([
      {
        name: "chase_sets_event_store_append_advisory_lock_hold_duration_ms",
        value: 13,
        attributes: {
          outcome: "committed",
          holder_kind: "reaction",
          target_context: "ordering",
          source_context: "marketplace",
          projection: "ordering-marketplace-offer-acceptance",
          subscription: "ordering.marketplace-offer-acceptance",
        },
      },
    ]);
  });
});

describe("projection wake pipeline observability", () => {
  it("records wake-before-wait enqueue latency with support-safe labels", () => {
    const record = projectionFreshnessWakeEnqueueMetricRecord({
      outcome: "completed",
      priorityLane: "hot",
      requestCount: 2,
      enqueuedCount: 2,
      durationMs: 12.4,
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout.session-projection",
      mountPath: "/api/marketplace",
      routePath: "/account/checkout-sessions/chk_01KTMF9TCCPKGA3J3TYMGGXQ2R",
    });

    expect(record).toEqual({
      durationMs: 12,
      attributes: {
        outcome: "completed",
        priority_lane: "hot",
        source_context: "checkout",
        target_context: "checkout",
        projection: "checkout.session-projection",
        mount_path: "/api/marketplace",
        route_path: "/account/checkout-sessions/:id",
        request_count: 2,
        enqueued_count: 2,
      },
    });
    expect(JSON.stringify(record)).not.toContain("chk_01KTMF9TCCPKGA3J3TYMGGXQ2R");
    expect(() =>
      recordProjectionFreshnessWakeEnqueue({
        outcome: "failed",
        priorityLane: "hot",
        requestCount: 1,
        enqueuedCount: 0,
        durationMs: -1,
        sourceContextName: null,
        targetContextName: null,
        projectionName: null,
        mountPath: null,
        routePath: null,
      }),
    ).not.toThrow();
  });

  it("records wake notification emissions without throwing", () => {
    expect(() =>
      recordProjectionWakeNotificationEmitted({
        sourceContextName: "checkout",
        streamCategory: "checkout.checkout-session",
        eventCount: 2,
        payloadBytes: 412,
        emittedAt: "2026-06-10T12:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("records relay catch-up passes without throwing", () => {
    expect(() =>
      recordProjectionWakeRelayCatchUp({
        sourceContextName: "checkout",
        reason: "startup",
        eventCount: 7,
        cursorAdvanceCount: 2,
        durationMs: 35,
      }),
    ).not.toThrow();
    expect(() =>
      recordProjectionWakeRelayCatchUp({
        sourceContextName: "checkout",
        reason: "notification",
        eventCount: 0,
        cursorAdvanceCount: 0,
        durationMs: -1,
      }),
    ).not.toThrow();
  });

  it("records relay fan-out outcomes without throwing", () => {
    expect(() =>
      recordProjectionWakeRelayFanOut({
        sourceContextName: "checkout",
        status: "enqueued",
        priorityLane: "hot",
        routingMode: "safe_over_wake",
        intentCount: 3,
        enqueuedCount: 3,
        notificationAgeMs: 12,
      }),
    ).not.toThrow();
    expect(() =>
      recordProjectionWakeRelayFanOut({
        sourceContextName: null,
        status: "failed",
        reason: "invalid-notification",
        routingMode: "unspecified",
        intentCount: 0,
        enqueuedCount: 0,
        notificationAgeMs: Number.NaN,
      }),
    ).not.toThrow();
    expect(() =>
      recordProjectionWakeRelayFanOut({
        sourceContextName: "checkout",
        status: "skipped",
        reason: "no-interests",
        priorityLane: "hot",
        routingMode: null,
        intentCount: 0,
        enqueuedCount: 0,
        notificationAgeMs: -5,
      }),
    ).not.toThrow();
  });

  it("records wake intent enqueue outcomes with bounded labels", () => {
    const record = projectionWakeIntentEnqueueOutcomeMetricRecord({
      outcome: "requeued_completed",
      sourceContextName: "checkout",
      targetContextName: "marketplace",
      projectionName: "sellable-listing-pages",
      priorityLane: "hot",
      origin: "relay",
      routingMode: "safe_over_wake",
    });

    expect(record).toEqual({
      attributes: {
        outcome: "requeued_completed",
        source_context: "checkout",
        target_context: "marketplace",
        projection: "sellable-listing-pages",
        priority_lane: "hot",
        origin: "relay",
        routing_mode: "safe_over_wake",
      },
    });

    const counterAdds: unknown[] = [];
    const createCounter = vi.fn((name: string) => ({
      add: (value: number, attributes?: unknown) => counterAdds.push({ name, value, attributes }),
    }));
    const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue({
      createCounter,
      createHistogram: vi.fn(),
      createUpDownCounter: vi.fn(),
    } as never);

    try {
      recordProjectionWakeIntentEnqueueOutcome({
        outcome: "coalesced",
        sourceContextName: "checkout",
        targetContextName: "marketplace",
        projectionName: "sellable-listing-pages",
        priorityLane: "standard",
        origin: "api-wait",
        routingMode: null,
      });
    } finally {
      getMeter.mockRestore();
    }

    expect(createCounter).toHaveBeenCalledWith("chase_sets_projection_wake_intent_enqueue_outcomes_total", undefined);
    expect(counterAdds).toEqual([
      {
        name: "chase_sets_projection_wake_intent_enqueue_outcomes_total",
        value: 1,
        attributes: {
          outcome: "coalesced",
          source_context: "checkout",
          target_context: "marketplace",
          projection: "sellable-listing-pages",
          priority_lane: "standard",
          origin: "api-wait",
          routing_mode: "none",
        },
      },
    ]);
  });

  it("records interest-index lookup latency with support-safe labels", () => {
    const record = projectionInterestIndexLookupMetricRecord({
      sourceContextName: "checkout",
      targetContextName: "checkout",
      projectionName: "checkout-session-pages",
      priorityLane: "hot",
      outcome: "matched",
      intentCount: 1,
      durationMs: 4.6,
    });

    expect(record).toEqual({
      durationMs: 5,
      attributes: {
        source_context: "checkout",
        target_context: "checkout",
        projection: "checkout-session-pages",
        priority_lane: "hot",
        outcome: "matched",
      },
    });
    expect(() =>
      recordProjectionInterestIndexLookup({
        sourceContextName: "checkout",
        targetContextName: null,
        projectionName: null,
        priorityLane: "hot",
        outcome: "no-interests",
        intentCount: 0,
        durationMs: -1,
      }),
    ).not.toThrow();
  });

  it("records wake intent outcomes without throwing", () => {
    expect(() =>
      recordProjectionWakeIntentOutcome({
        outcome: "completed",
        priorityLane: "hot",
        origin: "relay",
        sourceContextName: "checkout",
        targetContextName: "checkout",
        projectionName: "checkout-session-pages",
        queueAgeMs: 5_000,
        attemptCount: 1,
        processingDurationMs: 42,
        requeued: false,
      }),
    ).not.toThrow();
    expect(() =>
      recordProjectionWakeIntentOutcome({
        outcome: "attempts-exhausted",
        priorityLane: "standard",
        origin: "api-wait",
        sourceContextName: "checkout",
        targetContextName: "checkout",
        projectionName: "checkout-session-pages",
        queueAgeMs: -1,
        attemptCount: 10,
        processingDurationMs: null,
      }),
    ).not.toThrow();
  });
});
