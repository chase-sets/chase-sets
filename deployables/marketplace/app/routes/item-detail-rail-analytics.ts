import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { itemDetailRailAnalyticsEventNames } from "@chase-sets/discovery/web";
import { recordItemDetailRailAnalytics } from "@chase-sets/observability";
import { getMarketplaceObservability } from "../observability.server";

const allowedEvents = new Set<string>(itemDetailRailAnalyticsEventNames);
const invalidAnalyticsLabel = Symbol("invalid analytics label");

type ItemDetailRailAnalyticsPayload = Readonly<{
  event: string;
  intent?: string | null;
  workflow?: string | null;
  selection?: string | null;
  topic?: string | null;
  outcome?: string | null;
  gate?: string | null;
  viewer?: string | null;
  surface?: string | null;
  position?: number | null;
  queryHash?: string | null;
  resultSetKey?: string | null;
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
    return new Response("Invalid item detail rail analytics event.", { status: 400 });
  }

  const observability = getMarketplaceObservability();

  recordItemDetailRailAnalytics(payload);

  observability.logger.info("Item detail rail analytics event captured.", {
    type: "marketplace.item_detail_rail.analytics_event",
    event: payload.event,
    intent: payload.intent,
    workflow: payload.workflow,
    selection: payload.selection,
    topic: payload.topic,
    outcome: payload.outcome,
    gate: payload.gate,
    viewer: payload.viewer,
    surface: payload.surface,
  });

  return new Response(null, { status: 204 });
}

function parsePayload(text: string): ItemDetailRailAnalyticsPayload | null {
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

  const intent = readOptionalBoundedString(body.intent);
  const workflow = readOptionalBoundedString(body.workflow);
  const selection = readOptionalBoundedString(body.selection);
  const topic = readOptionalBoundedString(body.topic);
  const outcome = readOptionalBoundedString(body.outcome);
  const gate = readOptionalBoundedString(body.gate);
  const viewer = readOptionalBoundedString(body.viewer);
  const surface = readOptionalBoundedString(body.surface);
  const queryHash = readOptionalSha256(body.queryHash);
  const resultSetKey = readOptionalSha256(body.resultSetKey);
  const position = readOptionalPositiveInteger(body.position);
  if (
    intent === invalidAnalyticsLabel ||
    workflow === invalidAnalyticsLabel ||
    selection === invalidAnalyticsLabel ||
    topic === invalidAnalyticsLabel ||
    outcome === invalidAnalyticsLabel ||
    gate === invalidAnalyticsLabel ||
    viewer === invalidAnalyticsLabel ||
    surface === invalidAnalyticsLabel ||
    queryHash === invalidAnalyticsLabel ||
    resultSetKey === invalidAnalyticsLabel ||
    position === invalidAnalyticsLabel
  ) {
    return null;
  }

  return {
    event,
    intent,
    workflow,
    selection,
    topic,
    outcome,
    gate,
    viewer,
    surface,
    position,
    queryHash,
    resultSetKey,
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

function readOptionalPositiveInteger(value: unknown) {
  if (typeof value === "undefined" || value === null) {
    return null;
  }

  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : invalidAnalyticsLabel;
}

function readOptionalSha256(value: unknown) {
  if (typeof value === "undefined" || value === null) {
    return null;
  }

  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : invalidAnalyticsLabel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
