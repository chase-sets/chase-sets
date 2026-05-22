import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  loadObservabilityConfig,
  recordPublicPresenceWaitlistAnalytics,
  startObservability,
} from "@chase-sets/observability";
import { waitlistAnalyticsEventNames } from "@chase-sets/public-presence/web";

const allowedEvents = new Set<string>(waitlistAnalyticsEventNames);
const invalidAnalyticsLabel = Symbol("invalid analytics label");

type WaitlistAnalyticsPayload = Readonly<{
  event: string;
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

export function loader(_args: LoaderFunctionArgs) {
  return new Response(null, {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const payload = parsePayload(await request.text());
  if (!payload) {
    return new Response("Invalid waitlist analytics event.", { status: 400 });
  }

  const observability = getPublicWebObservability();

  recordPublicPresenceWaitlistAnalytics({
    event: payload.event,
    section: payload.section,
    role: payload.role,
    interest: payload.interest,
    variant: payload.variant,
    status: payload.status,
  });

  observability.logger.info("Public waitlist analytics event captured.", {
    type: "public_presence.waitlist.analytics_event",
    event: payload.event,
    section: payload.section,
    target: payload.target,
    field: payload.field,
    role: payload.role,
    interest: payload.interest,
    variant: payload.variant,
    status: payload.status,
    page_path: payload.page_path,
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    checked: payload.checked,
  });

  return new Response(null, { status: 204 });
}

function getPublicWebObservability() {
  return startObservability(
    loadObservabilityConfig(process.env, {
      serviceName: "public-web",
      serviceVersion: "0.1.0",
    }),
  );
}

function parsePayload(text: string): WaitlistAnalyticsPayload | null {
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
  const utmSource = readOptionalBoundedString(body.utm_source);
  const utmMedium = readOptionalBoundedString(body.utm_medium);
  const utmCampaign = readOptionalBoundedString(body.utm_campaign);
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
    event,
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
