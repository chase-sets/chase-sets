import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { createRiskAlertRoutes } from "./http";
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
