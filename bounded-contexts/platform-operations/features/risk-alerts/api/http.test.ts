import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformOperationsApiEnv } from "../../../api";
import { createRiskAlertRoutes } from "./http";
import type { RiskAlertServices } from "./runtime";

/**
 * Every identity below is SYNTHETIC and exists only inside this file. None of
 * them corresponds to a seeded, staging, or production session, user, account,
 * membership, or risk alert -- the `_synthetic_` infix is the marker.
 */
const SYNTHETIC_SESSION_ID = "ses_synthetic_risk_alert_boundary";
const SYNTHETIC_USER_ID = "usr_synthetic_risk_alert_boundary";
const SYNTHETIC_ACCOUNT_ID = "acc_synthetic_risk_alert_boundary";
const SYNTHETIC_MEMBERSHIP_ID = "mbr_synthetic_risk_alert_boundary";
const SYNTHETIC_TENANT_ID = "tnt_synthetic_risk_alert_boundary";
const SYNTHETIC_ALERT_ID = "ral_synthetic_risk_alert_boundary";

/**
 * The one governing variable of this suite. The mutant arm is derived from the
 * grant arm by filtering exactly this key out, so "otherwise identical actor
 * with only that key removed" is mechanical rather than two hand-maintained
 * literals that could drift apart.
 *
 * Risk alerts are gated by the reported-content key: the same grant authorizes
 * the queue reads AND `POST /:alertId/actions`, whose accepted actions include
 * the settlement-adjacent `request-manual-payout-review`.
 */
const REPORTED_CONTENT_GRANT = "reported-content.view";

/** Frozen non-governing actor authority; identical in both arms except the key above. */
const OPERATOR_PERMISSIONS: readonly string[] = [
  "accounts.view",
  "memberships.view",
  "platform-feedback.view",
  REPORTED_CONTENT_GRANT,
  "support.manage",
  "support.view",
];

const WITHOUT_GRANT = OPERATOR_PERMISSIONS.filter((permission) => permission !== REPORTED_CONTENT_GRANT);

/** Frozen non-governing event-store context; identical in both arms. */
const FROZEN_CONTEXT = {
  tenantId: SYNTHETIC_TENANT_ID as never,
  audit: {
    performedByUserId: SYNTHETIC_USER_ID as never,
    forAccountId: SYNTHETIC_ACCOUNT_ID as never,
  },
};

const FROZEN_RECORDED_AT = "2026-08-10T12:00:00.000Z";

function createServices() {
  return {
    listRiskAlertQueue: vi.fn(async () => ({ items: [], total: 0 })),
    getRiskAlertQueueItem: vi.fn(async () => null),
    getRiskAlertQueueMetrics: vi.fn(async () => ({ open: 0, acknowledged: 0 })),
    recordRiskAlertAction: vi.fn(async () => ({
      actionId: "raa_synthetic_risk_alert_boundary",
      recordedAt: FROZEN_RECORDED_AT,
    })),
    projectors: [],
  };
}

function createApp(services: ReturnType<typeof createServices>, permissions: readonly string[]) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: SYNTHETIC_SESSION_ID,
      tenantId: SYNTHETIC_TENANT_ID,
      userId: SYNTHETIC_USER_ID,
      accountId: SYNTHETIC_ACCOUNT_ID,
      membershipId: SYNTHETIC_MEMBERSHIP_ID,
      roleKey: "platform-admin",
      permissions,
    });
    c.set("context", FROZEN_CONTEXT);
    await next();
  });
  app.route("/", createRiskAlertRoutes(services as unknown as RiskAlertServices));
  return app;
}

/**
 * A VALID action, so the mutant's 403 cannot be the invalid-action branch --
 * that branch answers 400 validation_failed, and the green arm below proves
 * this exact body is accepted.
 */
function alertActionRequest() {
  return {
    method: "POST",
    body: JSON.stringify({ action: "request-manual-payout-review", note: "synthetic control" }),
    headers: { "Content-Type": "application/json" },
  } as const;
}

const ALERT_ACTION_PATH = `/${SYNTHETIC_ALERT_ID}/actions`;

describe("risk alerts API authorization boundary", () => {
  it("authorizes risk alerts with the reported-content grant", async () => {
    // GRANT ARM -- read endpoint.
    const readServices = createServices();
    const readResponse = await createApp(readServices, OPERATOR_PERMISSIONS).request("/");

    expect(readResponse.status).toBe(200);
    expect(readServices.listRiskAlertQueue).toHaveBeenCalledTimes(1);

    // GRANT ARM -- action recording. The same key authorizes writing an
    // operator action, not reads alone.
    const actionServices = createServices();
    const actionResponse = await createApp(actionServices, OPERATOR_PERMISSIONS).request(
      ALERT_ACTION_PATH,
      alertActionRequest(),
    );

    expect(actionResponse.status).toBe(200);
    expect(actionServices.recordRiskAlertAction).toHaveBeenCalledTimes(1);
    expect(actionServices.recordRiskAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: SYNTHETIC_ALERT_ID,
        action: "request-manual-payout-review",
        operatorUserId: SYNTHETIC_USER_ID,
      }),
      FROZEN_CONTEXT,
    );
  });

  it("returns 403 on a read endpoint for an otherwise identical actor with only the reported-content grant removed", async () => {
    const services = createServices();
    const response = await createApp(services, WITHOUT_GRANT).request("/");

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    // Not the missing-actor branch, which answers 401 authentication_required.
    expect(body.error.code).toBe("authorization_forbidden");
    expect(services.listRiskAlertQueue).not.toHaveBeenCalled();
  });

  it("returns 403 on action recording for an otherwise identical actor with only the reported-content grant removed", async () => {
    const services = createServices();
    const response = await createApp(services, WITHOUT_GRANT).request(ALERT_ACTION_PATH, alertActionRequest());

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    // Discriminated from all three sibling terminal results reachable on this
    // route: missing actor (401 authentication_required), missing context (401
    // authentication_required), and invalid action (400 validation_failed).
    // The green arm proves the actor, the context, and this exact action body
    // are all satisfied by these frozen inputs, so the only cause left is the
    // removed permission.
    expect(body.error.code).toBe("authorization_forbidden");
    expect(services.recordRiskAlertAction).not.toHaveBeenCalled();
  });

  it("removes exactly one key between the two arms", () => {
    expect(OPERATOR_PERMISSIONS).toContain(REPORTED_CONTENT_GRANT);
    expect(WITHOUT_GRANT).not.toContain(REPORTED_CONTENT_GRANT);
    expect(WITHOUT_GRANT).toHaveLength(OPERATOR_PERMISSIONS.length - 1);
    expect(OPERATOR_PERMISSIONS.filter((permission) => !WITHOUT_GRANT.includes(permission))).toEqual([
      REPORTED_CONTENT_GRANT,
    ]);
  });
});
