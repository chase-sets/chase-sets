import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformOperationsApiEnv } from "../../../api";
import type { PlatformOperationsServices } from "../../../support/runtime-support/services";
import { createOperationsAttentionRoutes } from "./route";

const actor = (permissions: readonly string[] | null) =>
  permissions === null
    ? null
    : {
        sessionId: "ses_attention",
        tenantId: "tnt_chase_sets",
        userId: "usr_attention",
        accountId: "acc_attention",
        membershipId: "mem_attention",
        roleKey: "platform-admin",
        permissions: [...permissions],
      };

function createServices(overrides: Partial<PlatformOperationsServices> = {}) {
  return {
    supportRequests: {
      listSupportOperationsQueue: vi.fn(async () => ({ items: [], total: 0 })),
    },
    platformFeedback: {
      listPlatformFeedback: vi.fn(async () => ({ items: [], total: 0 })),
    },
    ...overrides,
  } as unknown as PlatformOperationsServices;
}

function buildApp(services: PlatformOperationsServices, permissions: readonly string[] | null) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor(permissions));
    await next();
  });
  app.route("/operations-attention", createOperationsAttentionRoutes(services));
  return app;
}

describe("operations attention API", () => {
  it.each([
    ["projection-operations.view", ["projection-poison-event", "projection-blocked-stream", "wake-stalled-job"]],
    ["support.manage", ["support-request-deadline"]],
    ["platform-feedback.view", ["platform-feedback-unreviewed"]],
  ] as const)("returns only sources visible to %s", async (permission, ids) => {
    const services = createServices();
    const response = await buildApp(services, [permission]).request("/operations-attention");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [],
      degraded: permission === "projection-operations.view",
      sources: ids.map((id) => ({
        id,
        status: permission === "projection-operations.view" ? "unavailable" : "available",
        itemCount: 0,
        total: permission === "projection-operations.view" ? "unknown" : 0,
        ...(permission === "projection-operations.view" ? { reason: "not-mounted" } : {}),
      })),
    });
  });

  it("returns an empty queue for an authenticated actor without queue permissions", async () => {
    const services = createServices();
    const response = await buildApp(services, ["accounts.view"]).request("/operations-attention");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      rollup: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, bySource: expect.any(Object) },
      sources: [],
      degraded: false,
    });
    expect(services.supportRequests.listSupportOperationsQueue).not.toHaveBeenCalled();
    expect(services.platformFeedback.listPlatformFeedback).not.toHaveBeenCalled();
  });

  it("requires an authenticated actor before reading any source", async () => {
    const services = createServices();
    const response = await buildApp(services, null).request("/operations-attention");

    expect(response.status).toBe(401);
    expect(services.supportRequests.listSupportOperationsQueue).not.toHaveBeenCalled();
    expect(services.platformFeedback.listPlatformFeedback).not.toHaveBeenCalled();
  });

  it("uses an authoritative support total only when the page covers it", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      support_request_id: `req-${index}`,
      display_reference: `CASE-${index}`,
      seller_response_due_at: null,
      support_review_due_at: null,
      seller_condition_attestation_due_at: null,
      updated_at: "2026-07-14T00:00:00.000Z",
    }));
    const listSupportOperationsQueue = vi.fn(async () => ({ items, total: 100 }));
    const services = createServices({ supportRequests: { listSupportOperationsQueue } } as never);
    const response = await buildApp(services, ["support.manage"]).request("/operations-attention");
    expect((await response.json()).sources).toEqual([
      { id: "support-request-deadline", status: "available", itemCount: 100, total: 100 },
    ]);

    listSupportOperationsQueue.mockResolvedValueOnce({ items, total: 101 });
    const truncated = await buildApp(services, ["support.manage"]).request("/operations-attention");
    expect((await truncated.json()).sources).toEqual([
      { id: "support-request-deadline", status: "available", itemCount: 100, total: "unknown" },
    ]);
  });

  it("uses an authoritative feedback total only when the page covers it", async () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      feedback_id: `fb-${index}`,
      topic: "checkout",
      submitted_at: "2026-07-14T00:00:00.000Z",
    }));
    const listPlatformFeedback = vi.fn(async () => ({ items, total: 100 }));
    const services = createServices({ platformFeedback: { listPlatformFeedback } } as never);
    const response = await buildApp(services, ["platform-feedback.view"]).request("/operations-attention");
    expect((await response.json()).sources).toEqual([
      { id: "platform-feedback-unreviewed", status: "available", itemCount: 100, total: 100 },
    ]);

    listPlatformFeedback.mockResolvedValueOnce({ items, total: 101 });
    const truncated = await buildApp(services, ["platform-feedback.view"]).request("/operations-attention");
    expect((await truncated.json()).sources).toEqual([
      { id: "platform-feedback-unreviewed", status: "available", itemCount: 100, total: "unknown" },
    ]);
  });

  it("marks projection sources not-mounted when the host port is absent", async () => {
    const response = await buildApp(createServices(), ["projection-operations.view"]).request("/operations-attention");
    const body = await response.json();
    expect(body.degraded).toBe(true);
    expect(body.sources).toEqual([
      {
        id: "projection-poison-event",
        status: "unavailable",
        itemCount: 0,
        total: "unknown",
        reason: "not-mounted",
      },
      {
        id: "projection-blocked-stream",
        status: "unavailable",
        itemCount: 0,
        total: "unknown",
        reason: "not-mounted",
      },
      {
        id: "wake-stalled-job",
        status: "unavailable",
        itemCount: 0,
        total: "unknown",
        reason: "not-mounted",
      },
    ]);
  });
});
