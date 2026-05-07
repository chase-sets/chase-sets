import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPlatformFeedbackRoutes, type ExperienceApiEnv } from "../api";
import type { PlatformFeedbackServices } from "../features/platform-feedback/api/runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
} satisfies EventStoreContext;

function actorWithPermissions(permissions: readonly string[] = []): ResolvedActor {
  return {
    sessionId: "ses_test",
    tenantId: "tnt_test",
    userId: "usr_test",
    accountId: "acc_test",
    membershipId: "mem_test",
    roleKey: "owner",
    permissions,
  };
}

function createServices(overrides: Partial<PlatformFeedbackServices> = {}) {
  const services = {
    commandHandler: vi.fn() as never,
    submitPlatformFeedback: vi.fn(async () => ({ feedbackId: "pfb_test", version: 1 })),
    dismissPrompt: vi.fn(async () => ({
      promptId: "pfp_test",
      version: 1,
      snoozedUntil: "2026-05-14T12:00:00.000Z",
    })),
    getPromptEligibility: vi.fn(async () => ({
      shouldPrompt: true,
      reason: "eligible" as const,
    })),
    markReviewed: vi.fn(async () => ({ feedbackId: "pfb_test", version: 2 })),
    archive: vi.fn(async () => ({ feedbackId: "pfb_test", version: 3 })),
    listPlatformFeedback: vi.fn(async () => ({ items: [], total: 0 })),
    getPlatformFeedback: vi.fn(async () => null),
    getPlatformFeedbackMetrics: vi.fn(async () => ({
      total_count: 0,
      new_count: 0,
      reviewed_count: 0,
      archived_count: 0,
      average_rating: null,
      by_topic: [],
      by_workflow: [],
    })),
    projectors: [],
  } satisfies PlatformFeedbackServices;

  return { ...services, ...overrides } satisfies PlatformFeedbackServices;
}

function appFor(
  services: PlatformFeedbackServices,
  actor: ResolvedActor | null = actorWithPermissions(),
  storeContext: EventStoreContext | null = context,
) {
  const app = new Hono<ExperienceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", storeContext);
    await next();
  });
  app.route("/", createPlatformFeedbackRoutes(services));
  return app;
}

describe("experience platform feedback API", () => {
  it("allows any resolved actor to submit contextual feedback", async () => {
    const submitPlatformFeedback = vi.fn(async () => ({
      feedbackId: "pfb_test",
      version: 1,
    }));
    const services = createServices({ submitPlatformFeedback });
    const response = await appFor(services).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating: 5,
        topic: "checkout-payment",
        comment: "Fast checkout.",
        followUpConsent: true,
        workflow: "checkout-payment",
        sourceRoutePath: "/account/payments/pay_test",
        relatedEntities: [{ type: "payment", id: "pay_test" }],
      }),
    });

    expect(response.status).toBe(201);
    expect(submitPlatformFeedback).toHaveBeenCalledWith(
      {
        userId: "usr_test",
        accountId: "acc_test",
        rating: 5,
        topic: "checkout-payment",
        comment: "Fast checkout.",
        followUpConsent: true,
        workflow: "checkout-payment",
        sourceRoutePath: "/account/payments/pay_test",
        relatedEntities: [{ type: "payment", id: "pay_test" }],
      },
      context,
    );
  });

  it("requires view permission for admin queue, filters, detail, and metrics", async () => {
    const listPlatformFeedback = vi.fn(async () => ({ items: [], total: 0 }));
    const getPlatformFeedback = vi.fn(async () => ({
      feedback_id: "pfb_test",
      user_id: "usr_test",
      account_id: "acc_test",
      rating: 4,
      topic: "ease-of-use" as const,
      comment: null,
      follow_up_consent: false,
      workflow: "listing-publish" as const,
      source_route_path: "/account/listings",
      related_entities: [],
      related_entity_key: null,
      status: "new" as const,
      submitted_at: "2026-05-07T12:00:00.000Z",
      updated_at: "2026-05-07T12:00:00.000Z",
      reviewed_by_user_id: null,
      reviewed_at: null,
      archived_by_user_id: null,
      archived_at: null,
    }));
    const services = createServices({ listPlatformFeedback, getPlatformFeedback });

    const forbidden = await appFor(services).request("/");
    expect(forbidden.status).toBe(403);

    const app = appFor(services, actorWithPermissions(["platform-feedback.view"]));
    const list = await app.request(
      "/?status=new&topic=ease-of-use&workflow=listing-publish&limit=25&offset=50",
    );
    const metrics = await app.request("/metrics");
    const detail = await app.request("/pfb_test");

    expect(list.status).toBe(200);
    expect(metrics.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(listPlatformFeedback).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      status: "new",
      topic: "ease-of-use",
      workflow: "listing-publish",
    });
  });

  it("requires manage permission for reviewed and archived status actions", async () => {
    const markReviewed = vi.fn(async () => ({ feedbackId: "pfb_test", version: 2 }));
    const archive = vi.fn(async () => ({ feedbackId: "pfb_test", version: 3 }));
    const services = createServices({ markReviewed, archive });

    const viewOnly = appFor(services, actorWithPermissions(["platform-feedback.view"]));
    const forbiddenReview = await viewOnly.request("/pfb_test/review", { method: "POST" });
    const forbiddenArchive = await viewOnly.request("/pfb_test/archive", { method: "POST" });
    expect(forbiddenReview.status).toBe(403);
    expect(forbiddenArchive.status).toBe(403);

    const manager = appFor(services, actorWithPermissions(["platform-feedback.manage"]));
    const reviewed = await manager.request("/pfb_test/review", { method: "POST" });
    const archived = await manager.request("/pfb_test/archive", { method: "POST" });

    expect(reviewed.status).toBe(200);
    expect(archived.status).toBe(200);
    expect(markReviewed).toHaveBeenCalledWith("pfb_test", "usr_test", context);
    expect(archive).toHaveBeenCalledWith("pfb_test", "usr_test", context);
  });
});
