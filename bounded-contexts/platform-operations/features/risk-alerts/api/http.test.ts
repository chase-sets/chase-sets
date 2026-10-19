import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import type { PayoutReviewHoldCrossContextPort } from "./cross-context";
import { createRiskAlertRoutes } from "./http";
import { createRiskAlertRuntime, type RiskAlertServices } from "./runtime";

const actor = Object.freeze({
  sessionId: "ses_synthetic_operator",
  tenantId: "tnt_synthetic_operator",
  userId: "usr_synthetic_operator",
  accountId: "acc_synthetic_operator",
  membershipId: "mbr_synthetic_operator",
  roleKey: "platform-admin",
  permissions: Object.freeze(["support.manage", "reported-content.view", "payout-review-holds.manage"]),
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
            : {
                ...actor,
                permissions: actor.permissions.filter(
                  (key) => key !== "reported-content.view" && key !== "payout-review-holds.manage",
                ),
              },
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
              ...(action === "request-manual-payout-review" ? { actorPermissions: actor.permissions } : {}),
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

describe("risk-alert request-manual-payout-review action", () => {
  const knownAlertId = "alert_synthetic_known";
  const flaggedAccountId = "acc_synthetic_flagged_seller";

  function createActionHarness(
    options: Readonly<{ permissions?: readonly string[]; payoutReviewHoldMounted?: boolean }> = {},
  ) {
    const calls: string[] = [];
    const db = {
      query: vi.fn(async (_sql: string, params: readonly unknown[] = []) => ({
        rows: params[0] === knownAlertId ? [{ alert_id: knownAlertId, account_id: flaggedAccountId }] : [],
      })),
    };
    const placeRiskAlertHold = vi.fn<PayoutReviewHoldCrossContextPort["placeRiskAlertHold"]>(async () => {
      calls.push("hold");
      return { outcome: "placed", version: 1 };
    });
    const appendToStream = vi.fn(async () => {
      calls.push("action");
      return [];
    });
    const services = createRiskAlertRuntime({
      db: db as never,
      eventStore: { appendToStream } as never,
      ...(options.payoutReviewHoldMounted === false ? {} : { payoutReviewHoldCrossContext: { placeRiskAlertHold } }),
    });
    const permissions = options.permissions ?? actor.permissions;
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { ...actor, permissions });
      c.set("context", context);
      await next();
    });
    app.route("/", createRiskAlertRoutes(services));
    const post = (alertId: string, body: Record<string, unknown>) =>
      app.request(`/${alertId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    return { post, placeRiskAlertHold, appendToStream, calls, permissions };
  }

  it.each([
    ["a missing note", undefined, `Risk alert ${knownAlertId}`],
    ["a whitespace note", "   \n", `Risk alert ${knownAlertId}`],
    ["a padded note", "  Seller chargeback spike  ", "Seller chargeback spike"],
    ["a 500-character note", "n".repeat(500), "n".repeat(500)],
  ])("places the risk-alert hold before recording the action for %s", async (_name, note, reason) => {
    const harness = createActionHarness();
    const response = await harness.post(knownAlertId, { action: "request-manual-payout-review", note });

    expect(response.status).toBe(200);
    expect(harness.calls).toEqual(["hold", "action"]);
    expect(harness.placeRiskAlertHold).toHaveBeenCalledWith(
      { accountId: flaggedAccountId, reason, sourceReference: knownAlertId, actorPermissions: harness.permissions },
      context,
    );
    expect(harness.appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: `platform-operations.risk-alert-${knownAlertId}`,
        events: [
          expect.objectContaining({
            eventType: "platform-operations.risk-alert.action-recorded",
            payload: expect.objectContaining({ action: "request-manual-payout-review", alertId: knownAlertId }),
          }),
        ],
      }),
    );
  });

  it("appends to neither stream when the note, permission, alert or Settlement port refuses", async () => {
    const tooLong = createActionHarness();
    const tooLongResponse = await tooLong.post(knownAlertId, {
      action: "request-manual-payout-review",
      note: "n".repeat(501),
    });
    expect(tooLongResponse.status).toBe(400);
    expect(await tooLongResponse.json()).toMatchObject({ error: { code: "validation_failed" } });

    const unknown = createActionHarness();
    const unknownResponse = await unknown.post("alert_synthetic_unknown", { action: "request-manual-payout-review" });
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toMatchObject({ error: { code: "not_found" } });

    // Alert queue access alone does not grant the Settlement hold.
    const queueOnly = createActionHarness({ permissions: ["support.manage", "reported-content.view"] });
    const queueOnlyResponse = await queueOnly.post(knownAlertId, { action: "request-manual-payout-review" });
    expect(queueOnlyResponse.status).toBe(403);
    expect(await queueOnlyResponse.json()).toMatchObject({ error: { code: "authorization_forbidden" } });

    const unmounted = createActionHarness({ payoutReviewHoldMounted: false });
    const unmountedResponse = await unmounted.post(knownAlertId, { action: "request-manual-payout-review" });
    expect(unmountedResponse.status).toBe(400);

    for (const harness of [tooLong, unknown, queueOnly, unmounted]) {
      expect(harness.placeRiskAlertHold).not.toHaveBeenCalled();
      expect(harness.appendToStream).not.toHaveBeenCalled();
    }
  });

  it("records acknowledge without a hold for an actor without the hold permission", async () => {
    const harness = createActionHarness({ permissions: ["reported-content.view"] });
    const response = await harness.post(knownAlertId, { action: "acknowledge", note: "Reviewed" });

    expect(response.status).toBe(200);
    expect(harness.calls).toEqual(["action"]);
    expect(harness.appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            payload: expect.objectContaining({ action: "acknowledge", note: "Reviewed", operatorUserId: actor.userId }),
          }),
        ],
      }),
    );
    const unknownAcknowledge = await harness.post("alert_synthetic_unknown", { action: "acknowledge" });
    expect(unknownAcknowledge.status).toBe(404);
    expect(harness.placeRiskAlertHold).not.toHaveBeenCalled();
  });
});
