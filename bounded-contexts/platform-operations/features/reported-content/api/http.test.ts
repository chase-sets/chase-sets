import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { createReportedContentRoutes } from "./http";
import type { ReportedContentServices } from "./runtime";

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

describe("reported-content HTTP authorization", () => {
  it("authorizes reported-content with the reported-content grant", async () => {
    const services = {
      listReportedContentQueue: vi
        .fn<ReportedContentServices["listReportedContentQueue"]>()
        .mockResolvedValue({ items: [], total: 0 }),
      getReportedContentQueueItem: vi
        .fn<ReportedContentServices["getReportedContentQueueItem"]>()
        .mockResolvedValue(null),
      getReportedContentQueueMetrics: vi
        .fn<ReportedContentServices["getReportedContentQueueMetrics"]>()
        .mockResolvedValue({
          total_count: 0,
          needs_review_count: 0,
          auto_unlisted_count: 0,
        }),
      recordModerationAction: vi.fn<ReportedContentServices["recordModerationAction"]>().mockResolvedValue(recorded),
      projectors: [],
    } satisfies ReportedContentServices;
    const actions = [
      "dismiss",
      "contact-seller",
      "unlist",
      "escalate-account-suspension",
      "withdraw-review",
      "redact-review-feedback",
      "withdraw-review-reply",
    ] as const;
    const reads = [
      { path: "/", call: services.listReportedContentQueue, status: 200 },
      { path: "/metrics", call: services.getReportedContentQueueMetrics, status: 200 },
      { path: "/listing/listing_synthetic", call: services.getReportedContentQueueItem, status: 404 },
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
      app.route("/", createReportedContentRoutes(services));
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
        const target = `${action.includes("review") ? "review" : "listing"}/target_synthetic`;
        const response = await app.request(`/${target}/actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(granted ? 200 : 403);
        if (granted) {
          expect(await response.json()).toEqual({ id: recorded.actionId, recordedAt: recorded.recordedAt });
          expect(services.recordModerationAction).toHaveBeenLastCalledWith(
            {
              targetType: target.split("/")[0],
              targetId: "target_synthetic",
              action,
              note: body.note,
              operatorUserId: actor.userId,
            },
            context,
          );
        } else {
          expect(await response.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
          expect(services.recordModerationAction).not.toHaveBeenCalled();
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
