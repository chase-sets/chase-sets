import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createInMemoryRateLimiter,
  createPolicyBackedRateLimiter,
  type RateLimitRuleResolver,
} from "@chase-sets/http/rate-limit";
import type { PublicPresenceServices } from "./support/runtime-support/services";
import type { PromoBarMessageTone } from "./features/promo-bar/api/contracts";
import type { PromoBarServices } from "./features/promo-bar/api/runtime";
import { createWaitlistAnalyticsRoutes } from "./features/waitlist/api/analytics";
import type { WaitlistServices } from "./features/waitlist/api/runtime";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

export type PublicPresenceApiEnv = AuthenticatedApiEnv;
export { createWaitlistAnalyticsRoutes } from "./features/waitlist/api/analytics";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const WAITLIST_SIGNUP_RATE_LIMIT_SURFACE = "public-presence.waitlist.submit";
const REFERRAL_SUMMARY_RATE_LIMIT_MAX = 60;
const waitlistReferralSummaryRateLimiter = createInMemoryRateLimiter({
  keyPrefix: "public-presence:waitlist-referral-summary",
  max: REFERRAL_SUMMARY_RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});
const waitlistSignupIdPattern = /^wls_[0-9a-z]+$/;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("publicPresence.api.request.failed");
}

function isReferralSummaryRateLimited(request: Request) {
  return waitlistReferralSummaryRateLimiter.check(request).limited;
}

function publicEventStoreContext(): EventStoreContext {
  return {
    tenantId: "tnt_public_presence" as TenantId,
    audit: {
      performedByUserId: "usr_public_presence" as UserId,
      forAccountId: "acc_public_presence" as AccountId,
    },
  };
}

function requireActor(
  c: {
    get(key: "actor"): PublicPresenceApiEnv["Variables"]["actor"];
  },
  permission: "public-presence.view",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authentication_required", message: t("publicPresence.api.authentication.required") },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  if (!actor.permissions.includes(permission)) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({ error: { code: "authorization_forbidden", message: t("publicPresence.api.forbidden") } }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function readPromoBarMessageBody(body: Record<string, unknown>) {
  return {
    title: String(body.title ?? ""),
    description: typeof body.description === "string" ? body.description : null,
    href: typeof body.href === "string" ? body.href : null,
    linkLabel: typeof body.linkLabel === "string" ? body.linkLabel : null,
    tone: typeof body.tone === "string" ? (body.tone as PromoBarMessageTone) : undefined,
    isActive: typeof body.isActive === "boolean" ? body.isActive : true,
    displayOrder: Number(body.displayOrder ?? 100),
    startsAt: typeof body.startsAt === "string" ? body.startsAt : null,
    endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
  };
}

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function createPublicWaitlistRoutes(services: WaitlistServices, resolveRateLimitRule?: RateLimitRuleResolver) {
  const app = new Hono<PublicPresenceApiEnv>();
  const waitlistSignupRateLimiter = createPolicyBackedRateLimiter(
    WAITLIST_SIGNUP_RATE_LIMIT_SURFACE,
    { max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS },
    resolveRateLimitRule ?? (async (_surface, defaults) => defaults),
    { keyPrefix: "public-presence:waitlist" },
  );

  app.post("/waitlist", async (c) => {
    const rateLimit = await waitlistSignupRateLimiter.check(c.req.raw);
    if (rateLimit.limited) {
      return c.json({ error: { code: "rate_limited", message: t("publicPresence.api.rate.limited") } }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    if (typeof body.website === "string" && body.website.trim().length > 0) {
      return c.json({ error: { code: "spam_rejected", message: t("publicPresence.api.request.failed") } }, 400);
    }

    try {
      const result = await services.submitWaitlistSignup(
        {
          email: String(body.email ?? ""),
          role: String(body.role ?? ""),
          interests: Array.isArray(body.interests) ? body.interests.map(String) : [],
          marketingConsent: Boolean(body.marketingConsent),
          referredBySignupId: typeof body.referredBySignupId === "string" ? body.referredBySignupId : null,
          source: {
            pagePath: String(body.source?.pagePath ?? "/"),
            referrer: typeof body.source?.referrer === "string" ? body.source.referrer : null,
            utmSource: typeof body.source?.utmSource === "string" ? body.source.utmSource : null,
            utmMedium: typeof body.source?.utmMedium === "string" ? body.source.utmMedium : null,
            utmCampaign: typeof body.source?.utmCampaign === "string" ? body.source.utmCampaign : null,
            utmContent: typeof body.source?.utmContent === "string" ? body.source.utmContent : null,
            utmTerm: typeof body.source?.utmTerm === "string" ? body.source.utmTerm : null,
          },
        },
        publicEventStoreContext(),
      );

      return c.json({ id: result.signupId, version: result.version, status: "joined" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/waitlist/count", async (c) => {
    return c.json(await services.getWaitlistCounter());
  });

  app.get("/waitlist/:signupId/referral-summary", async (c) => {
    if (isReferralSummaryRateLimited(c.req.raw)) {
      return c.json({ error: { code: "rate_limited", message: t("publicPresence.api.rate.limited") } }, 429);
    }

    const signupId = c.req.param("signupId");
    if (!waitlistSignupIdPattern.test(signupId)) {
      return c.json({ error: { code: "validation_failed", message: t("publicPresence.api.request.failed") } }, 400);
    }

    return c.json(await services.getWaitlistReferralSummary(signupId));
  });

  return app;
}

export function createPublicPromoBarRoutes(services: PromoBarServices) {
  const app = new Hono<PublicPresenceApiEnv>();

  app.get("/promo-bar-messages", async (c) => {
    return c.json({ items: await services.listActivePromoBarMessages() });
  });

  return app;
}

export function createAdminWaitlistRoutes(services: WaitlistServices) {
  const app = new Hono<PublicPresenceApiEnv>();

  app.get("/waitlist", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listWaitlistSignups({
      limit,
      offset,
      role: c.req.query("role"),
      interest: c.req.query("interest"),
      search: c.req.query("search"),
      sort: c.req.query("sort"),
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/waitlist/metrics", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getWaitlistMetrics());
  });

  app.get("/waitlist/export", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const result = await services.listWaitlistSignups({
      limit: 500,
      offset: 0,
      role: c.req.query("role"),
      interest: c.req.query("interest"),
      search: c.req.query("search"),
      sort: c.req.query("sort"),
    });
    const rows = [
      [
        "email",
        "role",
        "interests",
        "page_path",
        "referrer",
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "referred_by_signup_id",
        "referral_count",
        "submitted_at",
        "updated_at",
      ],
      ...result.items.map((item) => [
        item.email,
        item.role,
        item.interests,
        item.page_path,
        item.referrer,
        item.utm_source,
        item.utm_medium,
        item.utm_campaign,
        item.referred_by_signup_id,
        item.referral_count,
        item.submitted_at,
        item.updated_at,
      ]),
    ];
    const body = rows.map((row) => row.map(csvCell).join(",")).join("\n");

    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="chase-sets-waitlist.csv"',
      },
    });
  });

  return app;
}

export function createAdminPromoBarRoutes(services: PromoBarServices) {
  const app = new Hono<PublicPresenceApiEnv>();

  app.get("/promo-bar-messages", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    return c.json({ items: await services.listPromoBarMessages() });
  });

  app.post("/promo-bar-messages", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const message = await services.createPromoBarMessage(readPromoBarMessageBody(body));
      return c.json(message, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.put("/promo-bar-messages/:messageId", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const message = await services.updatePromoBarMessage(c.req.param("messageId"), readPromoBarMessageBody(body));
      if (!message) {
        return c.json({ error: { code: "not_found", message: t("publicPresence.api.promoBar.notFound") } }, 404);
      }
      return c.json(message);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/promo-bar-messages/:messageId/activate", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const message = await services.setPromoBarMessageActive(c.req.param("messageId"), true);
    if (!message) {
      return c.json({ error: { code: "not_found", message: t("publicPresence.api.promoBar.notFound") } }, 404);
    }
    return c.json(message);
  });

  app.post("/promo-bar-messages/:messageId/deactivate", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const message = await services.setPromoBarMessageActive(c.req.param("messageId"), false);
    if (!message) {
      return c.json({ error: { code: "not_found", message: t("publicPresence.api.promoBar.notFound") } }, 404);
    }
    return c.json(message);
  });

  app.delete("/promo-bar-messages/:messageId", async (c) => {
    const access = requireActor(c, "public-presence.view");
    if (access.response) {
      return access.response;
    }

    const messageId = c.req.param("messageId");
    const deleted = await services.deletePromoBarMessage(messageId);
    if (!deleted) {
      return c.json({ error: { code: "not_found", message: t("publicPresence.api.promoBar.notFound") } }, 404);
    }
    return c.json({ id: messageId, status: "deleted" });
  });

  return app;
}

export function buildPublicPresencePublicApi(services: PublicPresenceServices) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.route("/", createWaitlistAnalyticsRoutes(services.waitlistAnalyticsRecorder));
  app.route("/", createPublicWaitlistRoutes(services.waitlist, services.rateLimitPolicyResolver));
  app.route("/", createPublicPromoBarRoutes(services.promoBar));
  return app;
}

export function buildPublicPresenceAdminApi(services: PublicPresenceServices) {
  const app = new Hono<PublicPresenceApiEnv>();
  app.route("/", createAdminWaitlistRoutes(services.waitlist));
  app.route("/", createAdminPromoBarRoutes(services.promoBar));
  return app;
}
