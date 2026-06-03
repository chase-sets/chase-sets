#!/usr/bin/env node
import { createHmac } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EASYPOST_REFUND_EVENT_REPLAY_VERSION = "easypost-refund-event-replay/v1";
export const EASYPOST_REFUND_EVENT_REPLAY_CONFIRM = "replay easypost refund event";

const DEFAULT_EASYPOST_API_BASE_URL = "https://api.easypost.com/v2";
const DEFAULT_WEBHOOK_URL = "https://chasesets.com/api/fulfillment/provider/postage/webhooks";

export function parseEasyPostRefundEventReplayArgs(argv, env = process.env) {
  return {
    apiBaseUrl:
      readOption(argv, "--api-base-url") ?? readEnv("EASYPOST_API_BASE_URL", env) ?? DEFAULT_EASYPOST_API_BASE_URL,
    apiKey: readOption(argv, "--api-key") ?? readEnv("EASYPOST_API_KEY", env),
    webhookSecret: readOption(argv, "--webhook-secret") ?? readEnv("EASYPOST_WEBHOOK_SECRET", env),
    webhookUrl:
      readOption(argv, "--webhook-url") ??
      readEnv("EASYPOST_REFUND_EVENT_REPLAY_WEBHOOK_URL", env) ??
      DEFAULT_WEBHOOK_URL,
    mode: readOption(argv, "--mode") ?? readEnv("EASYPOST_REFUND_EVENT_REPLAY_MODE", env) ?? "dry-run",
    confirm: readOption(argv, "--confirm") ?? readEnv("EASYPOST_REFUND_EVENT_REPLAY_CONFIRM", env),
    eventId: readOption(argv, "--event-id") ?? readEnv("EASYPOST_REFUND_EVENT_ID", env),
    targetShipmentId:
      readOption(argv, "--target-shipment-id") ?? readEnv("EASYPOST_REFUND_EVENT_TARGET_SHIPMENT_ID", env),
    targetRefundId: readOption(argv, "--target-refund-id") ?? readEnv("EASYPOST_REFUND_EVENT_TARGET_REFUND_ID", env),
    targetTrackingCode:
      readOption(argv, "--target-tracking-code") ?? readEnv("EASYPOST_REFUND_EVENT_TARGET_TRACKING_CODE", env),
    startDatetime:
      readOption(argv, "--start-datetime") ??
      readEnv("EASYPOST_REFUND_EVENT_START_DATETIME", env) ??
      daysAgoIsoTimestamp(30),
    endDatetime: readOption(argv, "--end-datetime") ?? readEnv("EASYPOST_REFUND_EVENT_END_DATETIME", env),
    pageSize: parseIntegerOption(
      readOption(argv, "--page-size") ?? readEnv("EASYPOST_REFUND_EVENT_PAGE_SIZE", env),
      100,
    ),
    maxPages: parseIntegerOption(readOption(argv, "--max-pages") ?? readEnv("EASYPOST_REFUND_EVENT_MAX_PAGES", env), 5),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function validateEasyPostRefundEventReplayOptions(options) {
  const errors = [];
  if (!options.apiKey) {
    errors.push("EASYPOST_API_KEY or --api-key is required.");
  }
  if (!options.webhookUrl) {
    errors.push("EASYPOST_REFUND_EVENT_REPLAY_WEBHOOK_URL or --webhook-url is required.");
  }
  if (!["dry-run", "replay"].includes(options.mode)) {
    errors.push("EASYPOST_REFUND_EVENT_REPLAY_MODE or --mode must be dry-run or replay.");
  }
  if (options.mode === "replay") {
    if (!options.webhookSecret) {
      errors.push("EASYPOST_WEBHOOK_SECRET or --webhook-secret is required for replay mode.");
    }
    if (options.confirm !== EASYPOST_REFUND_EVENT_REPLAY_CONFIRM) {
      errors.push(`Replay mode requires --confirm "${EASYPOST_REFUND_EVENT_REPLAY_CONFIRM}".`);
    }
  }
  if (!isIsoTimestamp(options.checkedAt)) {
    errors.push("EasyPost refund event replay checkedAt must be an ISO timestamp.");
  }
  if (options.startDatetime && Number.isNaN(Date.parse(options.startDatetime))) {
    errors.push("EasyPost refund event replay startDatetime must be parseable by Date.");
  }
  if (options.endDatetime && Number.isNaN(Date.parse(options.endDatetime))) {
    errors.push("EasyPost refund event replay endDatetime must be parseable by Date.");
  }
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
    errors.push("EasyPost refund event replay pageSize must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 20) {
    errors.push("EasyPost refund event replay maxPages must be an integer from 1 to 20.");
  }
  return errors;
}

export async function runEasyPostRefundEventReplay(options, dependencies = {}) {
  const errors = validateEasyPostRefundEventReplayOptions(options);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("EasyPost refund event replay requires a fetch implementation.");
  }

  const easyPost = createEasyPostClient({
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey,
    fetch: fetchImpl,
  });
  const refundEvents = options.eventId
    ? [await easyPost.getEvent(options.eventId)]
    : await listRefundEvents(easyPost, options);
  const inspectedEvents = [];

  for (const event of refundEvents) {
    const detailedEvent = options.eventId ? event : await easyPost.getEvent(event.id);
    if (!matchesRefundEventTarget(detailedEvent, options)) {
      continue;
    }
    const payloads = await easyPost.getEventPayloads(detailedEvent.id);
    inspectedEvents.push(buildInspectedRefundEvent(detailedEvent, payloads));
  }

  const selectedEvent = inspectedEvents[0] ?? null;
  const report = {
    schemaVersion: EASYPOST_REFUND_EVENT_REPLAY_VERSION,
    checkedAt: options.checkedAt,
    mode: options.mode,
    webhookUrl: redactWebhookUrl(options.webhookUrl),
    search: {
      eventId: redactIdentifier(options.eventId),
      targetShipmentId: redactIdentifier(options.targetShipmentId),
      targetRefundId: redactIdentifier(options.targetRefundId),
      targetTrackingCode: redactTrackingCode(options.targetTrackingCode),
      startDatetime: options.startDatetime,
      endDatetime: options.endDatetime ?? null,
      pageSize: options.pageSize,
      maxPages: options.maxPages,
    },
    refundEventCount: inspectedEvents.length,
    refundEvents: inspectedEvents.map(redactInspectedRefundEvent),
    selectedEvent: selectedEvent ? redactInspectedRefundEvent(selectedEvent) : null,
    replay: null,
  };

  if (options.mode === "replay") {
    if (!selectedEvent) {
      throw new Error("Replay mode did not find a matching EasyPost refund event.");
    }
    const replayBody = selectReplayBody(selectedEvent);
    const replayResult = await replayEasyPostEvent({
      fetchImpl,
      webhookUrl: options.webhookUrl,
      webhookSecret: options.webhookSecret,
      body: replayBody,
      now: dependencies.now ?? (() => new Date()),
    });
    report.replay = {
      attempted: true,
      providerEventId: redactIdentifier(selectedEvent.id),
      source: replayBody.source,
      responseStatus: replayResult.responseStatus,
      responseBodyPreview: redactResponseBodyPreview(replayResult.responseBody),
      succeeded: replayResult.responseStatus >= 200 && replayResult.responseStatus < 300,
    };
  }

  return report;
}

export function createEasyPostReplayHeaders({ webhookUrl, webhookSecret, body, now = () => new Date() }) {
  const url = new URL(webhookUrl);
  const timestamp = now().toISOString();
  const signedPath = url.pathname;
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}POST${signedPath}${body}`, "utf8")
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-timestamp": timestamp,
    "x-path": signedPath,
    "x-hmac-signature-v2": `hmac-sha256-hex=${signature}`,
  };
}

async function listRefundEvents(easyPost, options) {
  const events = [];
  let beforeId = null;
  for (let page = 0; page < options.maxPages; page += 1) {
    const response = await easyPost.listEvents({
      pageSize: options.pageSize,
      startDatetime: options.startDatetime,
      endDatetime: options.endDatetime,
      beforeId,
    });
    const pageEvents = Array.isArray(response.events) ? response.events : [];
    events.push(...pageEvents.filter((event) => isRefundEventSummary(event)));
    if (!response.has_more || pageEvents.length === 0) {
      break;
    }
    beforeId = pageEvents[pageEvents.length - 1]?.id ?? null;
    if (!beforeId) {
      break;
    }
  }
  return events;
}

function createEasyPostClient({ apiBaseUrl, apiKey, fetch }) {
  const authorization = `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
  async function easyPostJson(path) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      headers: {
        Authorization: authorization,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`EasyPost request ${path} failed with status ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  return {
    listEvents({ pageSize, startDatetime, endDatetime, beforeId }) {
      const params = new URLSearchParams();
      params.set("page_size", String(pageSize));
      if (startDatetime) {
        params.set("start_datetime", startDatetime);
      }
      if (endDatetime) {
        params.set("end_datetime", endDatetime);
      }
      if (beforeId) {
        params.set("before_id", beforeId);
      }
      return easyPostJson(`/events?${params.toString()}`);
    },
    getEvent(eventId) {
      return easyPostJson(`/events/${encodeURIComponent(eventId)}`);
    },
    async getEventPayloads(eventId) {
      const body = await easyPostJson(`/events/${encodeURIComponent(eventId)}/payloads`);
      return Array.isArray(body.payloads) ? body.payloads : [];
    },
  };
}

function isRefundEventSummary(event) {
  return typeof event?.description === "string" && event.description.startsWith("refund.") && hasConcreteId(event.id);
}

function matchesRefundEventTarget(event, options) {
  if (!isRefundEventSummary(event)) {
    return false;
  }
  const result = event.result ?? {};
  if (options.targetShipmentId && result.shipment_id !== options.targetShipmentId) {
    return false;
  }
  if (options.targetRefundId && result.id !== options.targetRefundId) {
    return false;
  }
  if (options.targetTrackingCode && result.tracking_code !== options.targetTrackingCode) {
    return false;
  }
  return true;
}

function buildInspectedRefundEvent(event, payloads) {
  return {
    id: event.id,
    description: event.description,
    mode: event.mode ?? event.result?.mode ?? null,
    status: event.status ?? null,
    createdAt: event.created_at ?? null,
    updatedAt: event.updated_at ?? null,
    result: {
      id: event.result?.id ?? null,
      object: event.result?.object ?? null,
      shipmentId: event.result?.shipment_id ?? null,
      trackingCode: event.result?.tracking_code ?? null,
      status: event.result?.status ?? null,
      updatedAt: event.result?.updated_at ?? null,
    },
    eventBody: JSON.stringify(event),
    payloads: payloads.map((payload) => ({
      id: payload.id,
      createdAt: payload.created_at ?? null,
      updatedAt: payload.updated_at ?? null,
      requestUrl: payload.request_url ?? null,
      responseCode: payload.response_code ?? null,
      requestBody: typeof payload.request_body === "string" ? payload.request_body : null,
    })),
  };
}

function redactInspectedRefundEvent(event) {
  return {
    id: redactIdentifier(event.id),
    description: event.description,
    mode: event.mode,
    status: event.status,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    result: {
      id: redactIdentifier(event.result.id),
      object: event.result.object,
      shipmentId: redactIdentifier(event.result.shipmentId),
      trackingCode: redactTrackingCode(event.result.trackingCode),
      status: event.result.status,
      updatedAt: event.result.updatedAt,
    },
    payloads: event.payloads.map((payload) => ({
      id: redactIdentifier(payload.id),
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      requestUrl: redactWebhookUrl(payload.requestUrl),
      responseCode: payload.responseCode,
      hasRequestBody: Boolean(payload.requestBody),
    })),
  };
}

function selectReplayBody(event) {
  const payloadBody = event.payloads.find((payload) => payload.requestBody)?.requestBody;
  if (payloadBody) {
    return {
      source: "payload-request-body",
      body: payloadBody,
    };
  }
  return {
    source: "event-detail",
    body: event.eventBody,
  };
}

async function replayEasyPostEvent({ fetchImpl, webhookUrl, webhookSecret, body, now }) {
  const headers = createEasyPostReplayHeaders({
    webhookUrl,
    webhookSecret,
    body: body.body,
    now,
  });
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers,
    body: body.body,
  });
  return {
    responseStatus: response.status,
    responseBody: await response.text().catch(() => ""),
  };
}

function daysAgoIsoTimestamp(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseIntegerOption(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function isIsoTimestamp(value) {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function hasConcreteId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function redactIdentifier(value) {
  if (!hasConcreteId(value)) {
    return null;
  }
  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function redactTrackingCode(value) {
  if (!hasConcreteId(value)) {
    return null;
  }
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function redactWebhookUrl(value) {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "redacted-url";
  }
}

function redactResponseBodyPreview(value) {
  return String(value ?? "")
    .replace(/evt_[A-Za-z0-9]+/g, (match) => redactIdentifier(match))
    .replace(/shp_[A-Za-z0-9]+/g, (match) => redactIdentifier(match))
    .replace(/rfnd_[A-Za-z0-9]+/g, (match) => redactIdentifier(match))
    .slice(0, 500);
}

async function main(argv, env = process.env) {
  try {
    const report = await runEasyPostRefundEventReplay(parseEasyPostRefundEventReplayArgs(argv, env));
    console.log(JSON.stringify(report, null, 2));
    return report.mode === "replay" && !report.replay?.succeeded ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
