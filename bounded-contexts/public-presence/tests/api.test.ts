import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import {
  createAdminWaitlistRoutes,
  createPublicWaitlistRoutes,
  type PublicPresenceApiEnv,
} from "../api";
import type { WaitlistServices } from "../features/waitlist/api/runtime";

function createServices(overrides: Partial<WaitlistServices> = {}) {
  const services = {
    commandHandler: vi.fn() as never,
    submitWaitlistSignup: vi.fn(async () => ({ signupId: "wls_test", version: 1 })),
    listWaitlistSignups: vi.fn(async () => ({ items: [], total: 0 })),
    getWaitlistMetrics: vi.fn(async () => ({
      total_count: 0,
      buy_count: 0,
      sell_count: 0,
      both_count: 0,
    })),
    projectors: [],
  } satisfies WaitlistServices;

  return { ...services, ...overrides } satisfies WaitlistServices;
}

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

function publicAppFor(services: WaitlistServices) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.route("/", createPublicWaitlistRoutes(services));
  return app;
}

function adminAppFor(
  services: WaitlistServices,
  actor: ResolvedActor | null = actorWithPermissions(["public-presence.view"]),
) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", createAdminWaitlistRoutes(services));
  return app;
}

const validSignup = {
  email: "todd@example.com",
  role: "both",
  interests: ["low-sales-fees"],
  emailConsent: true,
  source: {
    pagePath: "/",
    referrer: null,
    utmSource: "discord",
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
  },
};

describe("public presence API", () => {
  it("allows unauthenticated waitlist signup", async () => {
    const submitWaitlistSignup = vi.fn(async () => ({ signupId: "wls_test", version: 1 }));
    const response = await publicAppFor(createServices({ submitWaitlistSignup })).request(
      "/waitlist",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
        body: JSON.stringify(validSignup),
      },
    );

    expect(response.status).toBe(201);
    expect(submitWaitlistSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "todd@example.com",
        role: "both",
        interests: ["low-sales-fees"],
        emailConsent: true,
      }),
      expect.objectContaining({
        tenantId: "tnt_public_presence",
      }),
    );
  });

  it("rejects honeypot submissions and missing consent", async () => {
    const app = publicAppFor(createServices({
      submitWaitlistSignup: vi.fn(async (params) => {
        if (!params.emailConsent) {
          throw new Error("Email consent is required.");
        }
        return { signupId: "wls_test", version: 1 };
      }),
    }));
    const honeypot = await app.request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.11",
      },
      body: JSON.stringify({ ...validSignup, website: "https://spam.example" }),
    });
    const missingConsent = await app.request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.12",
      },
      body: JSON.stringify({ ...validSignup, emailConsent: false }),
    });

    expect(honeypot.status).toBe(400);
    expect(missingConsent.status).toBe(400);
  });

  it("rate limits repeated public submissions", async () => {
    const app = publicAppFor(createServices());
    let response = new Response(null);

    for (let index = 0; index < 21; index += 1) {
      response = await app.request("/waitlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.13",
        },
        body: JSON.stringify({ ...validSignup, email: `rate-${index}@example.com` }),
      });
    }

    expect(response.status).toBe(429);
  });

  it("protects admin list, metrics, and export with public-presence.view", async () => {
    const services = createServices();
    const forbidden = adminAppFor(services, actorWithPermissions()).request("/waitlist");
    await expect(forbidden).resolves.toHaveProperty("status", 403);

    const app = adminAppFor(services);
    const list = await app.request("/waitlist?role=both&interest=low-sales-fees&search=todd");
    const metrics = await app.request("/waitlist/metrics");
    const exportResponse = await app.request("/waitlist/export");

    expect(list.status).toBe(200);
    expect(metrics.status).toBe(200);
    expect(exportResponse.status).toBe(200);
    expect(services.listWaitlistSignups).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      role: "both",
      interest: "low-sales-fees",
      search: "todd",
    });
  });
});
