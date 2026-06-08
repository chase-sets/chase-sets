import { describe, expect, it, vi } from "vitest";
import {
  catalogIntegrationJobAttributes,
  catalogIntegrationOptionQueryAttributes,
  createLogger,
  loadObservabilityConfig,
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
