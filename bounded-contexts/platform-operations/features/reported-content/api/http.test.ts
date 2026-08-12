import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformOperationsApiEnv } from "../../../api";
import { createReportedContentRoutes } from "./http";
import type { ReportedContentServices } from "./runtime";

/**
 * Every identity below is SYNTHETIC and exists only inside this file. None of
 * them corresponds to a seeded, staging, or production session, user, account,
 * membership, or report -- the `_synthetic_` infix is the marker.
 */
const SYNTHETIC_SESSION_ID = "ses_synthetic_reported_content_boundary";
const SYNTHETIC_USER_ID = "usr_synthetic_reported_content_boundary";
const SYNTHETIC_ACCOUNT_ID = "acc_synthetic_reported_content_boundary";
const SYNTHETIC_MEMBERSHIP_ID = "mbr_synthetic_reported_content_boundary";
const SYNTHETIC_TENANT_ID = "tnt_synthetic_reported_content_boundary";
const SYNTHETIC_TARGET_ID = "lst_synthetic_reported_content_boundary";

/**
 * The one governing variable of this suite. The mutant arm is derived from the
 * grant arm by filtering exactly this key out, so "otherwise identical actor
 * with only that key removed" is mechanical rather than two hand-maintained
 * literals that could drift apart.
 */
const REPORTED_CONTENT_GRANT = "reported-content.view";

/**
 * Frozen non-governing actor authority. Operator-shaped and deliberately
 * generous elsewhere, so the mutant cannot pass or fail for any reason other
 * than the removed key.
 */
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
    listReportedContentQueue: vi.fn(async () => ({ items: [], total: 0 })),
    getReportedContentQueueItem: vi.fn(async () => null),
    getReportedContentQueueMetrics: vi.fn(async () => ({ open: 0, actioned: 0 })),
    recordModerationAction: vi.fn(async () => ({
      actionId: "rca_synthetic_reported_content_boundary",
      recordedAt: FROZEN_RECORDED_AT,
    })),
    projectors: [],
  };
}

/**
 * Frozen harness. The actor identity, the membership, the role key, the
 * event-store context, the services, and the request are identical across both
 * arms; only `permissions` differs.
 */
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
  app.route("/", createReportedContentRoutes(services as unknown as ReportedContentServices));
  return app;
}

function moderationActionRequest() {
  return {
    method: "POST",
    body: JSON.stringify({ action: "dismiss", note: "synthetic control" }),
    headers: { "Content-Type": "application/json" },
  } as const;
}

const MODERATION_ACTION_PATH = `/listing/${SYNTHETIC_TARGET_ID}/actions`;

describe("reported content API authorization boundary", () => {
  it("authorizes reported-content with the reported-content grant", async () => {
    // GRANT ARM -- read.
    const readServices = createServices();
    const readResponse = await createApp(readServices, OPERATOR_PERMISSIONS).request("/");

    expect(readResponse.status).toBe(200);
    expect(readServices.listReportedContentQueue).toHaveBeenCalledTimes(1);

    // GRANT ARM -- moderation write. This is the same key, and it authorizes
    // recording a moderation action, not reads alone.
    const writeServices = createServices();
    const writeResponse = await createApp(writeServices, OPERATOR_PERMISSIONS).request(
      MODERATION_ACTION_PATH,
      moderationActionRequest(),
    );

    expect(writeResponse.status).toBe(200);
    expect(writeServices.recordModerationAction).toHaveBeenCalledTimes(1);
    expect(writeServices.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dismiss", operatorUserId: SYNTHETIC_USER_ID }),
      FROZEN_CONTEXT,
    );
  });

  it("returns 403 for an otherwise identical actor with only the reported-content grant removed", async () => {
    // KEY-REMOVAL MUTANT -- read. Only the governing key differs from the arm
    // above; the actor, membership, role key, context, services, and request
    // are the frozen values.
    const readServices = createServices();
    const readResponse = await createApp(readServices, WITHOUT_GRANT).request("/");

    expect(readResponse.status).toBe(403);
    const readBody = (await readResponse.json()) as { error: { code: string } };
    // Discriminates the permission check from the missing-actor branch, which
    // answers 401 authentication_required.
    expect(readBody.error.code).toBe("authorization_forbidden");
    expect(readServices.listReportedContentQueue).not.toHaveBeenCalled();

    // KEY-REMOVAL MUTANT -- moderation write.
    const writeServices = createServices();
    const writeResponse = await createApp(writeServices, WITHOUT_GRANT).request(
      MODERATION_ACTION_PATH,
      moderationActionRequest(),
    );

    expect(writeResponse.status).toBe(403);
    const writeBody = (await writeResponse.json()) as { error: { code: string } };
    expect(writeBody.error.code).toBe("authorization_forbidden");
    // The request stopped at the permission gate: it never reached the
    // missing-context branch (401) or the invalid-action branch (400), both of
    // which the green arm above proves are satisfied by these same inputs.
    expect(writeServices.recordModerationAction).not.toHaveBeenCalled();
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
