import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  PLATFORM_FEEDBACK_ROUTE_SURFACES,
  createCustomerFeedbackRoutes,
  createPlatformFeedbackOperatorRoutes,
  createPlatformFeedbackRoutes,
  type ExperienceApiEnv,
} from "../features/platform-feedback/api/http";
import type { PlatformFeedbackServices } from "../features/platform-feedback/api/runtime";

/**
 * Route-registry / composition-boundary regression coverage for #5145. Locks
 * the corrected capability model so a later change cannot (a) move an operator
 * route onto the customer surface, (b) drop an operator route's staff-capability
 * gate, (c) fold export back into the view grant, or (d) let a customer session
 * reach the operator surface -- including on a guessed operator path -- when the
 * marketplace host composes the same platform API.
 *
 * The corrected role model grants ordinary account roles (owner/manager/
 * fulfillment/viewer) NONE of the platform-feedback operator capabilities; that
 * source-of-truth exclusion is asserted directly against the role maps in
 * bounded-contexts/identity/features/memberships/read-model/constants.test.ts
 * and bounded-contexts/auth/support/auth-support/constants.test.ts. Here we
 * represent each ordinary-role and marketplace-customer session by an actor that
 * carries realistic non-feedback grants but no platform-feedback.* capability,
 * and prove the server-side authz denies it.
 */

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
} satisfies EventStoreContext;

function actor(roleKey: string, permissions: readonly string[], accountId = "acc_actor"): ResolvedActor {
  return {
    sessionId: "ses_test",
    tenantId: "tnt_test",
    userId: "usr_actor",
    accountId,
    membershipId: "mem_test",
    roleKey,
    permissions,
  };
}

// Ordinary account-role sessions after #5145: no platform-feedback.* capability.
const ORDINARY_ROLE_ACTORS: Readonly<Record<string, ResolvedActor>> = {
  owner: actor("owner", [
    "accounts.manage",
    "orders.manage",
    "orders.view",
    "payouts.manage",
    "support.manage",
    "support.view",
  ]),
  manager: actor("manager", ["orders.manage", "orders.view", "payouts.manage", "support.manage", "support.view"]),
  fulfillment: actor("fulfillment", ["fulfillment.manage", "orders.view", "support.manage", "support.view"]),
  viewer: actor("viewer", ["orders.view", "payouts.view", "support.view"]),
  // A marketplace customer session composing the same platform API directly:
  // an ordinary buyer/seller role with no operator capability.
  "marketplace-customer": actor("owner", ["orders.view", "listings.manage", "offers.manage"]),
};

const VIEW_ONLY_STAFF = actor("platform-admin", ["platform-feedback.view"]);
const MANAGE_STAFF = actor("platform-admin", [
  "platform-feedback.view",
  "platform-feedback.manage",
  "platform-feedback.export",
]);

function createServices(overrides: Partial<PlatformFeedbackServices> = {}): PlatformFeedbackServices {
  return {
    commandHandler: vi.fn() as never,
    submitPlatformFeedback: vi.fn(async () => ({ feedbackId: "pfb_test", version: 1 })),
    dismissPrompt: vi.fn(async () => ({ promptId: "pfp_test", version: 1, snoozedUntil: "2026-05-14T12:00:00.000Z" })),
    getPromptEligibility: vi.fn(async () => ({ shouldPrompt: true, reason: "eligible" as const })),
    markReviewed: vi.fn(async () => ({ feedbackId: "pfb_test", version: 2 })),
    archive: vi.fn(async () => ({ feedbackId: "pfb_test", version: 3 })),
    recordOperatorNote: vi.fn(async () => ({ feedbackId: "pfb_test", version: 4, noteId: "pfn_test" })),
    bulkMarkReviewed: vi.fn(async () => ({ action: "reviewed" as const, updated: 0, skipped: 0, items: [] })),
    bulkArchive: vi.fn(async () => ({ action: "archived" as const, updated: 0, skipped: 0, items: [] })),
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
    ...overrides,
  } satisfies PlatformFeedbackServices;
}

function appFor(services: PlatformFeedbackServices, sessionActor: ResolvedActor | null) {
  const app = new Hono<ExperienceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", sessionActor);
    c.set("context", context);
    await next();
  });
  app.route("/", createPlatformFeedbackRoutes(services));
  return app;
}

// Every operator surface, plus guessed operator leaves that are not implemented
// yet (triage/assignment/follow-up/redaction). All must be denied to non-staff.
const OPERATOR_REQUESTS: readonly Readonly<{ label: string; method: string; path: string; body?: string }>[] = [
  { label: "list", method: "GET", path: "/" },
  { label: "detail", method: "GET", path: "/pfb_1" },
  { label: "metrics", method: "GET", path: "/metrics" },
  { label: "export", method: "GET", path: "/export" },
  { label: "review", method: "POST", path: "/pfb_1/review" },
  { label: "archive", method: "POST", path: "/pfb_1/archive" },
  { label: "notes", method: "POST", path: "/pfb_1/notes", body: "{}" },
  { label: "bulk-review", method: "POST", path: "/bulk/review", body: "{}" },
  { label: "bulk-archive", method: "POST", path: "/bulk/archive", body: "{}" },
  // Guessed operator leaves (separate future leaves): deny-by-default.
  { label: "assignment", method: "POST", path: "/pfb_1/assign", body: "{}" },
  { label: "follow-up", method: "POST", path: "/pfb_1/follow-up", body: "{}" },
  { label: "redaction", method: "POST", path: "/pfb_1/redact", body: "{}" },
];

async function request(
  app: ReturnType<typeof appFor>,
  spec: Readonly<{ method: string; path: string; body?: string }>,
) {
  return app.request(spec.path, {
    method: spec.method,
    ...(spec.body ? { headers: { "Content-Type": "application/json" }, body: spec.body } : {}),
  });
}

describe("platform feedback authorization boundary (#5145)", () => {
  describe("canonical route-surface registry", () => {
    it("exposes exactly the present/submit/dismiss commands on the customer surface", () => {
      const customerRoutes = PLATFORM_FEEDBACK_ROUTE_SURFACES.filter((route) => route.surface === "customer");
      expect(customerRoutes.map((route) => `${route.verb} ${route.path}`).sort()).toEqual([
        "GET /prompt",
        "POST /",
        "POST /dismiss",
      ]);
      // No customer route carries an operator capability.
      for (const route of customerRoutes) {
        expect(route.capability).toBeNull();
      }
    });

    it("gates every operator route behind an explicit staff capability, with export separate from view", () => {
      const operatorRoutes = PLATFORM_FEEDBACK_ROUTE_SURFACES.filter((route) => route.surface === "operator");
      expect(operatorRoutes.length).toBeGreaterThan(0);
      for (const route of operatorRoutes) {
        expect(route.capability).not.toBeNull();
        expect(route.capability).toMatch(/^platform-feedback\.(view|manage|export)$/);
      }
      const exportRoute = operatorRoutes.find((route) => route.path === "/export");
      expect(exportRoute?.capability).toBe("platform-feedback.export");
      // Export never rides along on a read-only view grant.
      const viewRoutes = operatorRoutes.filter((route) => route.capability === "platform-feedback.view");
      expect(viewRoutes.every((route) => route.path !== "/export")).toBe(true);
    });
  });

  describe("negative-test matrix: operator surface denies non-staff sessions", () => {
    for (const [label, sessionActor] of Object.entries(ORDINARY_ROLE_ACTORS)) {
      it(`denies ordinary/customer session '${label}' on every operator endpoint`, async () => {
        const app = appFor(createServices(), sessionActor);
        for (const spec of OPERATOR_REQUESTS) {
          const response = await request(app, spec);
          expect([401, 403], `${label} ${spec.label}`).toContain(response.status);
        }
      });
    }

    it("denies anonymous sessions on every operator endpoint", async () => {
      const app = appFor(createServices(), null);
      for (const spec of OPERATOR_REQUESTS) {
        const response = await request(app, spec);
        expect([401, 403], `anonymous ${spec.label}`).toContain(response.status);
      }
    });

    it("lets view-only staff read but denies mutation, export, and guessed mutating leaves", async () => {
      const app = appFor(createServices(), VIEW_ONLY_STAFF);
      const readable = [
        { label: "list", method: "GET", path: "/" },
        { label: "metrics", method: "GET", path: "/metrics" },
      ];
      for (const spec of readable) {
        const response = await request(app, spec);
        expect(response.status, `view-only ${spec.label}`).toBe(200);
      }

      const denied = OPERATOR_REQUESTS.filter((spec) => spec.method !== "GET" || spec.path === "/export");
      for (const spec of denied) {
        const response = await request(app, spec);
        expect(response.status, `view-only denied ${spec.label}`).toBe(403);
      }
    });

    it("lets manage+export staff perform commands and export", async () => {
      const app = appFor(createServices(), MANAGE_STAFF);
      const review = await request(app, { method: "POST", path: "/pfb_1/review" });
      const archive = await request(app, { method: "POST", path: "/pfb_1/archive" });
      const note = await request(app, { method: "POST", path: "/pfb_1/notes", body: JSON.stringify({ body: "x" }) });
      const exported = await request(app, { method: "GET", path: "/export" });
      expect(review.status).toBe(200);
      expect(archive.status).toBe(200);
      expect(note.status).toBe(200);
      expect(exported.status).toBe(200);
    });
  });

  describe("customer command surface: no cross-account replay", () => {
    it("submits with session-derived identity and rejects body identity overrides", async () => {
      const submitPlatformFeedback = vi.fn(async () => ({ feedbackId: "pfb_test", version: 1 }));
      const services = createServices({ submitPlatformFeedback });
      const app = appFor(services, ORDINARY_ROLE_ACTORS.viewer);

      const ok = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: 5,
          topic: "checkout-payment",
          workflow: "checkout-payment",
          sourceRoutePath: "/",
        }),
      });
      expect(ok.status).toBe(201);
      expect(submitPlatformFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "usr_actor", accountId: "acc_actor" }),
        context,
      );

      for (const field of ["accountId", "userId", "subjectId", "invitationId", "membershipId"]) {
        const replay = await app.request("/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rating: 5,
            topic: "checkout-payment",
            workflow: "checkout-payment",
            sourceRoutePath: "/",
            [field]: "other",
          }),
        });
        expect(replay.status, `replay via ${field}`).toBe(403);
      }
      // Only the legitimate submission reached the service.
      expect(submitPlatformFeedback).toHaveBeenCalledTimes(1);
    });
  });

  describe("isolated surfaces stay single-responsibility", () => {
    it("the customer surface exposes no operator route", async () => {
      const app = new Hono<ExperienceApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", MANAGE_STAFF);
        c.set("context", context);
        await next();
      });
      app.route("/", createCustomerFeedbackRoutes(createServices()));

      // Even a fully privileged staff session cannot list/export through the
      // customer surface -- those routes are not composed there at all.
      const list = await app.request("/");
      const exported = await app.request("/export");
      expect(list.status).toBe(404);
      expect(exported.status).toBe(404);
    });

    it("the operator surface denies an anonymous or ordinary session by default", async () => {
      const app = new Hono<ExperienceApiEnv>();
      let current: ResolvedActor | null = null;
      app.use("*", async (c, next) => {
        c.set("actor", current);
        c.set("context", context);
        await next();
      });
      app.route("/", createPlatformFeedbackOperatorRoutes(createServices()));

      current = null;
      expect((await app.request("/")).status).toBe(401);
      current = ORDINARY_ROLE_ACTORS.owner;
      expect((await app.request("/")).status).toBe(403);
      expect((await app.request("/pfb_1/redact", { method: "POST", body: "{}" })).status).toBe(403);
    });
  });
});
