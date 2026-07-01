import { Hono } from "hono";
import { waitlistAnalyticsEventNames, type WaitlistAnalyticsEventName } from "../ui/analytics";
import type { PublicPresenceApiEnv } from "../../../api";

const allowedEvents = new Set<string>(waitlistAnalyticsEventNames);
const invalidAnalyticsLabel = Symbol("invalid analytics label");

export type WaitlistAnalyticsPayload = Readonly<{
  event: WaitlistAnalyticsEventName;
  section?: string | null;
  target?: string | null;
  field?: string | null;
  role?: string | null;
  interest?: string | null;
  variant?: string | null;
  status?: string | null;
  page_path?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  checked?: boolean | null;
}>;

export type WaitlistAnalyticsRecorder = Readonly<{
  record: (payload: WaitlistAnalyticsPayload) => void | Promise<void>;
}>;

export const noopWaitlistAnalyticsRecorder: WaitlistAnalyticsRecorder = {
  record: () => undefined,
};

export function createWaitlistAnalyticsRoutes(recorder: WaitlistAnalyticsRecorder = noopWaitlistAnalyticsRecorder) {
  const app = new Hono<PublicPresenceApiEnv>();

  app.post("/analytics/waitlist", async (c) => {
    const payload = parseWaitlistAnalyticsPayload(await c.req.text());
    if (!payload) {
      return c.text("Invalid waitlist analytics event.", 400);
    }

    await recorder.record(payload);
    return new Response(null, { status: 204 });
  });

  app.all("/analytics/waitlist", (c) => {
    c.header("Allow", "POST");
    return c.body(null, 405);
  });

  return app;
}

export function parseWaitlistAnalyticsPayload(text: string): WaitlistAnalyticsPayload | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(body)) {
    return null;
  }

  const event = readBoundedString(body.event);
  if (!event || !allowedEvents.has(event)) {
    return null;
  }

  const section = readOptionalBoundedString(body.section);
  const target = readOptionalBoundedString(body.target);
  const field = readOptionalBoundedString(body.field);
  const role = readOptionalBoundedString(body.role);
  const interest = readOptionalBoundedString(body.interest);
  const variant = readOptionalBoundedString(body.variant);
  const status = readOptionalBoundedString(body.status);
  const pagePath = readOptionalPath(body.page_path);
  const utmSource = readOptionalAttributionString(body.utm_source);
  const utmMedium = readOptionalAttributionString(body.utm_medium);
  const utmCampaign = readOptionalAttributionString(body.utm_campaign);
  if (
    section === invalidAnalyticsLabel ||
    target === invalidAnalyticsLabel ||
    field === invalidAnalyticsLabel ||
    role === invalidAnalyticsLabel ||
    interest === invalidAnalyticsLabel ||
    variant === invalidAnalyticsLabel ||
    status === invalidAnalyticsLabel ||
    pagePath === invalidAnalyticsLabel ||
    utmSource === invalidAnalyticsLabel ||
    utmMedium === invalidAnalyticsLabel ||
    utmCampaign === invalidAnalyticsLabel
  ) {
    return null;
  }

  return {
    event: event as WaitlistAnalyticsEventName,
    section,
    target,
    field,
    role,
    interest,
    variant,
    status,
    page_path: pagePath,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    checked: typeof body.checked === "boolean" ? body.checked : null,
  };
}

function readBoundedString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : null;
}

function readOptionalBoundedString(value: unknown) {
  if (typeof value === "undefined" || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return invalidAnalyticsLabel;
  }

  const text = value.trim();
  return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : invalidAnalyticsLabel;
}

function readOptionalAttributionString(value: unknown) {
  if (typeof value === "undefined" || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return invalidAnalyticsLabel;
  }

  const text = value.trim();
  return text.length > 0 && text.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/.test(text)
    ? text
    : invalidAnalyticsLabel;
}

function readOptionalPath(value: unknown) {
  if (typeof value === "undefined" || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return invalidAnalyticsLabel;
  }

  const text = value.trim();
  return text.length > 0 && text.length <= 160 && text.startsWith("/") && /^[/a-zA-Z0-9_.~%=&?-]+$/.test(text)
    ? text
    : invalidAnalyticsLabel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
