import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import {
  createAdminPromoBarRoutes,
  createAdminWaitlistRoutes,
  createWaitlistAnalyticsRoutes,
  createPublicPromoBarRoutes,
  createPublicWaitlistRoutes,
  type PublicPresenceApiEnv,
} from "../api";
import type { PromoBarServices } from "../features/promo-bar/api/runtime";
import type { PromoBarMessage } from "../features/promo-bar/api/contracts";
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
    getWaitlistReferralSummary: vi.fn(async () => ({ referralCount: 0, referralGoal: 3 })),
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

function createPromoBarServices(overrides: Partial<PromoBarServices> = {}) {
  const message = {
    id: "pbm_test",
    title: "Earn 5% toward shipping.",
    description: null,
    href: "/order-protection",
    link_label: "Learn more",
    tone: "success",
    is_active: true,
    display_order: 10,
    starts_at: null,
    ends_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  } satisfies PromoBarMessage;
  const services = {
    listActivePromoBarMessages: vi.fn(async () => []),
    listPromoBarMessages: vi.fn(async () => []),
    createPromoBarMessage: vi.fn(async () => message),
    updatePromoBarMessage: vi.fn(async () => null),
    setPromoBarMessageActive: vi.fn(async () => null),
    deletePromoBarMessage: vi.fn(async () => false),
  } satisfies PromoBarServices;

  return { ...services, ...overrides } satisfies PromoBarServices;
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

function publicPromoBarAppFor(services: PromoBarServices) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.route("/", createPublicPromoBarRoutes(services));
  return app;
}

function publicAnalyticsAppFor(record = vi.fn()) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.route("/", createWaitlistAnalyticsRoutes({ record }));
  return { app, record };
}

function adminPromoBarAppFor(
  services: PromoBarServices,
  actor: ResolvedActor | null = actorWithPermissions(["public-presence.view"]),
) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/", createAdminPromoBarRoutes(services));
  return app;
}

const validSignup = {
  email: "todd@example.com",
  role: "both",
  interests: ["low-sales-fees"],
  marketingConsent: true,
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
    const response = await publicAppFor(createServices({ submitWaitlistSignup })).request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify(validSignup),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "wls_test", version: 1, status: "joined" });
    expect(submitWaitlistSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "todd@example.com",
        role: "both",
        interests: ["low-sales-fees"],
        marketingConsent: true,
      }),
      expect.objectContaining({
        tenantId: "tnt_public_presence",
      }),
    );
  });

  it("rejects honeypot submissions", async () => {
    const app = publicAppFor(createServices());
    const honeypot = await app.request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.11",
      },
      body: JSON.stringify({ ...validSignup, website: "https://spam.example" }),
    });

    expect(honeypot.status).toBe(400);
  });

  it("accepts a signup without optional marketing consent", async () => {
    const submitWaitlistSignup = vi.fn(async () => ({ signupId: "wls_test", version: 1 }));
    const app = publicAppFor(createServices({ submitWaitlistSignup }));
    const { marketingConsent: _marketingConsent, ...signupWithoutConsent } = validSignup;
    const response = await app.request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.12",
      },
      body: JSON.stringify(signupWithoutConsent),
    });

    expect(response.status).toBe(201);
    expect(submitWaitlistSignup).toHaveBeenCalledWith(
      expect.objectContaining({ marketingConsent: false }),
      expect.anything(),
    );
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
      sort: undefined,
    });
  });

  it("passes an admin sort selection through to the read model", async () => {
    const services = createServices();
    const app = adminAppFor(services);

    const list = await app.request("/waitlist?sort=referrals");
    const exportResponse = await app.request("/waitlist/export?sort=referrals");

    expect(list.status).toBe(200);
    expect(exportResponse.status).toBe(200);
    expect(services.listWaitlistSignups).toHaveBeenCalledWith(expect.objectContaining({ sort: "referrals" }));
  });

  it("attributes a signup submitted with a referral code", async () => {
    const submitWaitlistSignup = vi.fn(async () => ({ signupId: "wls_referred", version: 1 }));
    const app = publicAppFor(createServices({ submitWaitlistSignup }));
    const response = await app.request("/waitlist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.20",
      },
      body: JSON.stringify({ ...validSignup, referredBySignupId: "wls_referrer" }),
    });

    expect(response.status).toBe(201);
    expect(submitWaitlistSignup).toHaveBeenCalledWith(
      expect.objectContaining({ referredBySignupId: "wls_referrer" }),
      expect.anything(),
    );
  });

  it("returns a referral summary for a well-formed signup id and rejects malformed ids", async () => {
    const getWaitlistReferralSummary = vi.fn(async () => ({ referralCount: 2, referralGoal: 3 }));
    const app = publicAppFor(createServices({ getWaitlistReferralSummary }));

    const valid = await app.request("/waitlist/wls_public/referral-summary");
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toEqual({ referralCount: 2, referralGoal: 3 });
    expect(getWaitlistReferralSummary).toHaveBeenCalledWith("wls_public");

    const malformed = await app.request("/waitlist/not-a-signup-id/referral-summary");
    expect(malformed.status).toBe(400);
    expect(getWaitlistReferralSummary).toHaveBeenCalledTimes(1);
  });

  it("exposes active promo bar messages publicly", async () => {
    const services = createPromoBarServices({
      listActivePromoBarMessages: vi.fn(async () => [
        {
          id: "pbm_shipping",
          title: "Earn 5% toward shipping.",
          description: null,
          href: "/order-protection",
          link_label: "Learn more",
          tone: "success",
          is_active: true,
          display_order: 10,
          starts_at: null,
          ends_at: null,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        } satisfies PromoBarMessage,
      ]),
    });
    const response = await publicPromoBarAppFor(services).request("/promo-bar-messages");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: "pbm_shipping", title: "Earn 5% toward shipping." }],
    });
  });

  it("captures bounded waitlist analytics events", async () => {
    const { app, record } = publicAnalyticsAppFor();
    const response = await app.request("/analytics/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "cta_clicked",
        section: "hero",
        target: "waitlist_form",
        role: "sell",
        interest: "low-sales-fees",
        variant: "seller_first_v1",
        page_path: "/?utm_source=launch&utm_campaign=beta",
        utm_source: "launch",
        utm_medium: "social",
        utm_campaign: "founder wave",
      }),
    });

    expect(response.status).toBe(204);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cta_clicked",
        section: "hero",
        target: "waitlist_form",
        role: "sell",
        page_path: "/?utm_source=launch&utm_campaign=beta",
        utm_campaign: "founder wave",
      }),
    );
  });

  it("rejects unsupported waitlist analytics events and non-POST methods", async () => {
    const { app, record } = publicAnalyticsAppFor();
    const invalid = await app.request("/analytics/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "email_submitted", email: "seller@example.com" }),
    });
    const get = await app.request("/analytics/waitlist");

    expect(invalid.status).toBe(400);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST");
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects arbitrary waitlist analytics label text before recording", async () => {
    const { app, record } = publicAnalyticsAppFor();
    const response = await app.request("/analytics/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "cta_clicked",
        section: "seller@example.com",
        target: "waitlist form",
        role: "sell",
      }),
    });

    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects unbounded waitlist analytics source fields before recording", async () => {
    const { app, record } = publicAnalyticsAppFor();
    const urlResponse = await app.request("/analytics/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "landing_page_view",
        page_path: "https://evil.example/?email=seller@example.com",
        utm_source: "launch",
      }),
    });
    const emailResponse = await app.request("/analytics/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "landing_page_view",
        page_path: "/?utm_source=seller@example.com",
        utm_source: "seller@example.com",
      }),
    });

    expect(urlResponse.status).toBe(400);
    expect(emailResponse.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("protects promo bar management with public-presence.view", async () => {
    const services = createPromoBarServices();
    const forbidden = adminPromoBarAppFor(services, actorWithPermissions()).request("/promo-bar-messages");
    await expect(forbidden).resolves.toHaveProperty("status", 403);

    const app = adminPromoBarAppFor(services);
    const list = await app.request("/promo-bar-messages");
    const create = await app.request("/promo-bar-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "0% fees on beta listings.",
        href: "/sales-fees",
        linkLabel: "Seller fees",
        tone: "success",
        isActive: true,
        displayOrder: 20,
      }),
    });

    expect(list.status).toBe(200);
    expect(create.status).toBe(201);
    expect(services.createPromoBarMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "0% fees on beta listings.",
        href: "/sales-fees",
        linkLabel: "Seller fees",
      }),
    );
  });

  it("returns command snapshots for promo bar management writes", async () => {
    const createdMessage = {
      id: "pbm_created",
      title: "0% fees on beta listings.",
      description: null,
      href: "/sales-fees",
      link_label: "Seller fees",
      tone: "success",
      is_active: true,
      display_order: 20,
      starts_at: null,
      ends_at: null,
      created_at: "2026-06-15T00:00:00.000Z",
      updated_at: "2026-06-15T00:00:00.000Z",
    } satisfies PromoBarMessage;
    const updatedMessage = { ...createdMessage, title: "Updated fees", updated_at: "2026-06-15T00:01:00.000Z" };
    const inactiveMessage = { ...updatedMessage, is_active: false, updated_at: "2026-06-15T00:02:00.000Z" };
    const services = createPromoBarServices({
      createPromoBarMessage: vi.fn(async () => createdMessage),
      updatePromoBarMessage: vi.fn(async () => updatedMessage),
      setPromoBarMessageActive: vi.fn(async (_id, isActive) => (isActive ? updatedMessage : inactiveMessage)),
      deletePromoBarMessage: vi.fn(async () => true),
    });
    const app = adminPromoBarAppFor(services);

    const create = await app.request("/promo-bar-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "0% fees on beta listings." }),
    });
    const update = await app.request("/promo-bar-messages/pbm_created", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated fees" }),
    });
    const activate = await app.request("/promo-bar-messages/pbm_created/activate", { method: "POST" });
    const deactivate = await app.request("/promo-bar-messages/pbm_created/deactivate", { method: "POST" });
    const deleted = await app.request("/promo-bar-messages/pbm_created", { method: "DELETE" });

    await expect(create.json()).resolves.toMatchObject({ id: "pbm_created", title: "0% fees on beta listings." });
    await expect(update.json()).resolves.toMatchObject({ id: "pbm_created", title: "Updated fees" });
    await expect(activate.json()).resolves.toMatchObject({ id: "pbm_created", is_active: true });
    await expect(deactivate.json()).resolves.toMatchObject({ id: "pbm_created", is_active: false });
    await expect(deleted.json()).resolves.toEqual({ id: "pbm_created", status: "deleted" });
  });
});
