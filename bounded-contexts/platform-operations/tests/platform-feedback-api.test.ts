import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPlatformFeedbackRoutes, type ExperienceApiEnv } from "../features/platform-feedback/api/http";
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
    recordOperatorNote: vi.fn(async () => ({ feedbackId: "pfb_test", version: 4, noteId: "pfn_test" })),
    bulkMarkReviewed: vi.fn(async () => ({
      action: "reviewed" as const,
      updated: 1,
      skipped: 0,
      items: [{ feedbackId: "pfb_test", version: 2 }],
    })),
    bulkArchive: vi.fn(async () => ({
      action: "archived" as const,
      updated: 1,
      skipped: 0,
      items: [{ feedbackId: "pfb_test", version: 3 }],
    })),
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
    await expect(response.json()).resolves.toEqual({ id: "pfb_test", version: 1, status: "submitted" });
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
      operator_notes: [],
    }));
    const services = createServices({ listPlatformFeedback, getPlatformFeedback });

    const forbidden = await appFor(services).request("/");
    expect(forbidden.status).toBe(403);

    const app = appFor(services, actorWithPermissions(["platform-feedback.view", "platform-feedback.export"]));
    const list = await app.request("/?status=new&topic=ease-of-use&workflow=listing-publish&limit=25&offset=50");
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

  it("gates the comment export behind a separate export capability (#5145)", async () => {
    const services = createServices({
      listPlatformFeedback: vi.fn(async () => ({ items: [], total: 0 })),
    });

    // A view-only staff assignment cannot download the free-text comment corpus.
    const viewOnly = appFor(services, actorWithPermissions(["platform-feedback.view"]));
    const deniedExport = await viewOnly.request("/export?status=new");
    expect(deniedExport.status).toBe(403);

    // Even manage authority does not imply export.
    const manager = appFor(services, actorWithPermissions(["platform-feedback.view", "platform-feedback.manage"]));
    const managerExport = await manager.request("/export?status=new");
    expect(managerExport.status).toBe(403);

    // Export requires the explicit export grant.
    const exporter = appFor(services, actorWithPermissions(["platform-feedback.view", "platform-feedback.export"]));
    const exported = await exporter.request("/export?status=new");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Type")).toContain("text/csv");
  });

  it("rejects a customer submission that tries to override account or subject identity (#5145)", async () => {
    const submitPlatformFeedback = vi.fn(async () => ({ feedbackId: "pfb_test", version: 1 }));
    const services = createServices({ submitPlatformFeedback });

    const response = await appFor(services).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rating: 5,
        topic: "checkout-payment",
        workflow: "checkout-payment",
        sourceRoutePath: "/checkout",
        // Cross-account replay attempt: attribute feedback to another account.
        accountId: "acc_victim",
        userId: "usr_victim",
      }),
    });

    expect(response.status).toBe(403);
    expect(submitPlatformFeedback).not.toHaveBeenCalled();
  });

  it("requires manage permission for reviewed, archived, note, and bulk actions", async () => {
    const markReviewed = vi.fn(async () => ({ feedbackId: "pfb_test", version: 2 }));
    const archive = vi.fn(async () => ({ feedbackId: "pfb_test", version: 3 }));
    const recordOperatorNote = vi.fn(async () => ({ feedbackId: "pfb_test", version: 4, noteId: "pfn_test" }));
    const bulkMarkReviewed = vi.fn(async () => ({
      action: "reviewed" as const,
      updated: 1,
      skipped: 0,
      items: [{ feedbackId: "pfb_test", version: 2 }],
    }));
    const bulkArchive = vi.fn(async () => ({
      action: "archived" as const,
      updated: 1,
      skipped: 0,
      items: [{ feedbackId: "pfb_test", version: 3 }],
    }));
    const services = createServices({ markReviewed, archive, recordOperatorNote, bulkMarkReviewed, bulkArchive });

    const viewOnly = appFor(services, actorWithPermissions(["platform-feedback.view"]));
    const forbiddenReview = await viewOnly.request("/pfb_test/review", { method: "POST" });
    const forbiddenArchive = await viewOnly.request("/pfb_test/archive", { method: "POST" });
    const forbiddenNote = await viewOnly.request("/pfb_test/notes", { method: "POST", body: "{}" });
    const forbiddenBulk = await viewOnly.request("/bulk/review", { method: "POST", body: "{}" });
    expect(forbiddenReview.status).toBe(403);
    expect(forbiddenArchive.status).toBe(403);
    expect(forbiddenNote.status).toBe(403);
    expect(forbiddenBulk.status).toBe(403);

    const manager = appFor(services, actorWithPermissions(["platform-feedback.manage"]));
    const reviewed = await manager.request("/pfb_test/review", { method: "POST" });
    const archived = await manager.request("/pfb_test/archive", { method: "POST" });
    const noted = await manager.request("/pfb_test/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Follow up with checkout team." }),
    });
    const bulkReviewed = await manager.request("/bulk/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedbackIds: ["pfb_test"] }),
    });
    const bulkArchived = await manager.request("/bulk/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedbackIds: ["pfb_test"] }),
    });

    expect(reviewed.status).toBe(200);
    expect(archived.status).toBe(200);
    expect(noted.status).toBe(200);
    expect(bulkReviewed.status).toBe(200);
    expect(bulkArchived.status).toBe(200);
    await expect(reviewed.json()).resolves.toEqual({ id: "pfb_test", version: 2, status: "reviewed" });
    await expect(archived.json()).resolves.toEqual({ id: "pfb_test", version: 3, status: "archived" });
    await expect(noted.json()).resolves.toEqual({ id: "pfb_test", version: 4, noteId: "pfn_test" });
    await expect(bulkReviewed.json()).resolves.toEqual({
      action: "reviewed",
      updated: 1,
      skipped: 0,
      items: [{ id: "pfb_test", version: 2, status: "reviewed" }],
    });
    await expect(bulkArchived.json()).resolves.toEqual({
      action: "archived",
      updated: 1,
      skipped: 0,
      items: [{ id: "pfb_test", version: 3, status: "archived" }],
    });
    expect(markReviewed).toHaveBeenCalledWith("pfb_test", "usr_test", context);
    expect(archive).toHaveBeenCalledWith("pfb_test", "usr_test", context);
    expect(recordOperatorNote).toHaveBeenCalledWith(
      "pfb_test",
      { body: "Follow up with checkout team.", recordedByUserId: "usr_test" },
      context,
    );
    expect(bulkMarkReviewed).toHaveBeenCalledWith(["pfb_test"], "usr_test", context);
    expect(bulkArchive).toHaveBeenCalledWith(["pfb_test"], "usr_test", context);
  });

  it("returns prompt dismissal snapshots without depending on prompt projections", async () => {
    const dismissPrompt = vi.fn(async () => ({
      promptId: "pfp_test",
      version: 4,
      snoozedUntil: "2026-05-14T12:00:00.000Z",
    }));
    const services = createServices({ dismissPrompt });

    const response = await appFor(services).request("/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow: "checkout-payment",
        sourceRoutePath: "/checkout",
        relatedEntities: [{ type: "payment", id: "pay_test" }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "pfp_test",
      version: 4,
      snoozedUntil: "2026-05-14T12:00:00.000Z",
    });
    expect(dismissPrompt).toHaveBeenCalledWith(
      {
        userId: "usr_test",
        accountId: "acc_test",
        workflow: "checkout-payment",
        sourceRoutePath: "/checkout",
        relatedEntities: [{ type: "payment", id: "pay_test" }],
      },
      context,
    );
  });
});
