import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import {
  createAdminPromoBarRoutes,
  createAdminWaitlistRoutes,
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
        emailConsent: true,
      }),
      expect.objectContaining({
        tenantId: "tnt_public_presence",
      }),
    );
  });

  it("rejects honeypot submissions and missing consent", async () => {
    const app = publicAppFor(
      createServices({
        submitWaitlistSignup: vi.fn(async (params) => {
          if (!params.emailConsent) {
            throw new Error("Email consent is required.");
          }
          return { signupId: "wls_test", version: 1 };
        }),
      }),
    );
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
      setPromoBarMessageActive: vi.fn(async (_id, isActive) =>
        isActive ? updatedMessage : inactiveMessage,
      ),
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
