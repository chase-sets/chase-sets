import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it, vi } from "vitest";
import { createRiskAlertRoutes } from "./http";
import { RiskAlertActionRejectedError } from "./contracts";
import { createRiskAlertRuntime } from "./runtime";
import type { RiskAlertServices } from "./runtime";

const actor = Object.freeze({
  sessionId: "ses_synthetic_operator",
  tenantId: "tnt_synthetic_operator",
  userId: "usr_synthetic_operator",
  accountId: "acc_synthetic_operator",
  membershipId: "mbr_synthetic_operator",
  roleKey: "platform-admin",
  permissions: Object.freeze(["support.manage", "reported-content.view"]),
}) satisfies ResolvedActor;
const context = Object.freeze({
  tenantId: "tnt_synthetic_operator",
  audit: Object.freeze({ performedByUserId: "usr_synthetic_operator", forAccountId: "acc_synthetic_operator" }),
}) satisfies EventStoreContext;
const recorded = { actionId: "action_synthetic_operator", recordedAt: "2026-10-06T12:00:00.000Z" };

function authorizedApp(services: RiskAlertServices) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/", createRiskAlertRoutes(services));
  return app;
}

function realRuntimeApp(options: Readonly<{ candidate?: boolean; missing?: boolean }> = {}) {
  const appendToStream = vi.fn().mockResolvedValue([]);
  const query = vi.fn().mockResolvedValue({
    rows: options.missing
      ? []
      : [{ alert_id: "risk_synthetic_alert", manual_payout_review_candidate: options.candidate ?? false }],
  });
  const db = { query } as unknown as PgQueryable;
  const eventStore = { appendToStream } as unknown as EventStore;
  const app = authorizedApp(createRiskAlertRuntime({ db, eventStore }));
  return { app, appendToStream, query };
}

describe("risk-alerts HTTP authorization", () => {
  it("authorizes risk alerts with the reported-content grant", async () => {
    const services = {
      listRiskAlertQueue: vi.fn<RiskAlertServices["listRiskAlertQueue"]>().mockResolvedValue({ items: [], total: 0 }),
      getRiskAlertQueueItem: vi.fn<RiskAlertServices["getRiskAlertQueueItem"]>().mockResolvedValue(null),
      getRiskAlertQueueMetrics: vi.fn<RiskAlertServices["getRiskAlertQueueMetrics"]>().mockResolvedValue({
        total_count: 0,
        needs_review_count: 0,
        manual_payout_review_candidate_count: 0,
      }),
      recordRiskAlertAction: vi.fn<RiskAlertServices["recordRiskAlertAction"]>().mockResolvedValue(recorded),
      projectors: [],
    } satisfies RiskAlertServices;
    const actions = ["acknowledge", "request-manual-payout-review"] as const;
    const reads = [
      { path: "/", call: services.listRiskAlertQueue, status: 200 },
      { path: "/metrics", call: services.getRiskAlertQueueMetrics, status: 200 },
      { path: "/alert_synthetic", call: services.getRiskAlertQueueItem, status: 404 },
    ];
    for (const granted of [true, false]) {
      vi.clearAllMocks();
      const app = new Hono<AuthenticatedApiEnv>();
      app.use("*", async (c, next) => {
        c.set(
          "actor",
          granted
            ? actor
            : { ...actor, permissions: actor.permissions.filter((key) => key !== "reported-content.view") },
        );
        c.set("context", context);
        await next();
      });
      app.route("/", createRiskAlertRoutes(services));
      for (const read of reads) {
        const response = await app.request(read.path);
        expect(response.status).toBe(granted ? read.status : 403);
        expect(read.call).toHaveBeenCalledTimes(granted ? 1 : 0);
        if (!granted) {
          expect(await response.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
        }
      }
      for (const action of actions) {
        const body = Object.freeze({ action, note: "Synthetic operator evidence" });
        const target = "alert_synthetic";
        const response = await app.request(`/${target}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(granted ? 200 : 403);
        if (granted) {
          expect(await response.json()).toEqual({ id: recorded.actionId, recordedAt: recorded.recordedAt });
          expect(services.recordRiskAlertAction).toHaveBeenLastCalledWith(
            {
              alertId: target,
              action,
              note: body.note,
              operatorUserId: actor.userId,
            },
            context,
          );
        } else {
          expect(await response.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
          expect(services.recordRiskAlertAction).not.toHaveBeenCalled();
        }
      }
      if (!granted) {
        for (const service of Object.values(services)) {
          if (typeof service === "function") expect(service).not.toHaveBeenCalled();
        }
      }
    }
  });
});

describe("risk-alerts HTTP action outcomes", () => {
  function servicesForAction(recordRiskAlertAction: RiskAlertServices["recordRiskAlertAction"]): RiskAlertServices {
    return {
      listRiskAlertQueue: vi.fn<RiskAlertServices["listRiskAlertQueue"]>().mockResolvedValue({ items: [], total: 0 }),
      getRiskAlertQueueItem: vi.fn<RiskAlertServices["getRiskAlertQueueItem"]>().mockResolvedValue(null),
      getRiskAlertQueueMetrics: vi.fn<RiskAlertServices["getRiskAlertQueueMetrics"]>().mockResolvedValue({
        total_count: 0,
        needs_review_count: 0,
        manual_payout_review_candidate_count: 0,
      }),
      recordRiskAlertAction,
      projectors: [],
    };
  }

  it("risk alert action appends for an allowed action", async () => {
    const record = vi.fn<RiskAlertServices["recordRiskAlertAction"]>().mockResolvedValue(recorded);
    const app = authorizedApp(servicesForAction(record));

    for (const action of ["request-manual-payout-review", "acknowledge"] as const) {
      const response = await app.request("/alert_synthetic/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: "Synthetic operator evidence" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: recorded.actionId, recordedAt: recorded.recordedAt });
    }
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("risk alert action refuses a non-candidate payout review", async () => {
    const record = vi
      .fn<RiskAlertServices["recordRiskAlertAction"]>()
      .mockRejectedValue(new RiskAlertActionRejectedError("action-not-allowed"));
    const app = authorizedApp(servicesForAction(record));

    const response = await app.request("/alert_synthetic/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request-manual-payout-review" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "validation_failed",
        reason: "action-not-allowed",
        message: "The risk alert action was rejected.",
      },
    });
  });

  it("risk alert action refuses an unknown alert", async () => {
    const record = vi
      .fn<RiskAlertServices["recordRiskAlertAction"]>()
      .mockRejectedValue(new RiskAlertActionRejectedError("alert-not-found"));
    const app = authorizedApp(servicesForAction(record));

    const response = await app.request("/alert_missing/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acknowledge" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        reason: "alert-not-found",
        message: "The risk alert action was rejected.",
      },
    });
  });

  it("risk alert action keeps the invalid-action refusal", async () => {
    const record = vi.fn<RiskAlertServices["recordRiskAlertAction"]>().mockResolvedValue(recorded);
    const app = authorizedApp(servicesForAction(record));

    const response = await app.request("/alert_synthetic/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid-action" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "validation_failed", message: "Risk alert action is invalid." },
    });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("risk-alerts HTTP action outcomes on the real runtime", () => {
  it("risk alert action refuses a non-candidate payout review without appending", async () => {
    const { app, appendToStream } = realRuntimeApp({ candidate: false });

    const response = await app.request("/alert_synthetic/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request-manual-payout-review" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "validation_failed",
        reason: "action-not-allowed",
        message: "The risk alert action was rejected.",
      },
    });
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("risk alert action refuses an unknown alert without appending", async () => {
    const { app, appendToStream } = realRuntimeApp({ missing: true });

    const response = await app.request("/alert_missing/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acknowledge" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        reason: "alert-not-found",
        message: "The risk alert action was rejected.",
      },
    });
    expect(appendToStream).not.toHaveBeenCalled();
  });

  it("risk alert action appends allowed actions through the real runtime", async () => {
    const candidate = realRuntimeApp({ candidate: true });
    const candidateResponse = await candidate.app.request("/alert_synthetic/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request-manual-payout-review" }),
    });
    expect(candidateResponse.status).toBe(200);
    expect(await candidateResponse.json()).toEqual({
      id: expect.any(String),
      recordedAt: expect.any(String),
    });
    expect(candidate.appendToStream).toHaveBeenCalledTimes(1);

    const nonCandidate = realRuntimeApp({ candidate: false });
    const acknowledgeResponse = await nonCandidate.app.request("/alert_synthetic/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acknowledge" }),
    });
    expect(acknowledgeResponse.status).toBe(200);
    expect(await acknowledgeResponse.json()).toEqual({
      id: expect.any(String),
      recordedAt: expect.any(String),
    });
    expect(nonCandidate.appendToStream).toHaveBeenCalledTimes(1);
  });
});
