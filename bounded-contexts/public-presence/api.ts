import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PublicPresenceServices } from "./support/runtime-support/services";
import type { WaitlistServices } from "./features/waitlist/api/runtime";

export type PublicPresenceApiEnv = AuthenticatedApiEnv;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("publicPresence.api.request.failed");
}

function requestKey(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("cf-connecting-ip") || "local"
  );
}

function isRateLimited(request: Request) {
  const now = Date.now();
  const key = requestKey(request);
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  current.count += 1;
  return current.count > RATE_LIMIT_MAX;
}

function publicEventStoreContext(): EventStoreContext {
  return {
    tenantId: "tnt_public_presence" as never,
    audit: {
      performedByUserId: "usr_public_presence" as never,
      forAccountId: "acc_public_presence" as never,
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

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function createPublicWaitlistRoutes(services: WaitlistServices) {
  const app = new Hono<PublicPresenceApiEnv>();

  app.post("/waitlist", async (c) => {
    if (isRateLimited(c.req.raw)) {
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
          emailConsent: Boolean(body.emailConsent),
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

export function buildPublicPresencePublicApi(services: PublicPresenceServices) {
  return createPublicWaitlistRoutes(services.waitlist);
}

export function buildPublicPresenceAdminApi(services: PublicPresenceServices) {
  return createAdminWaitlistRoutes(services.waitlist);
}
