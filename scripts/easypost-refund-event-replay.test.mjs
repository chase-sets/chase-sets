import { describe, expect, it } from "vitest";
import {
  EASYPOST_REFUND_EVENT_REPLAY_CONFIRM,
  createEasyPostReplayHeaders,
  parseEasyPostRefundEventReplayArgs,
  runEasyPostRefundEventReplay,
  validateEasyPostRefundEventReplayOptions,
} from "./easypost-refund-event-replay.mjs";

function createFetchStub() {
  const calls = [];
  const eventSummary = {
    id: "evt_refundStatus202606030001",
    object: "Event",
    description: "refund.successful",
    mode: "production",
    status: "completed",
    created_at: "2026-06-03T03:00:00Z",
  };
  const eventDetail = {
    ...eventSummary,
    result: {
      id: "rfnd_controlledRefund202606030001",
      object: "Refund",
      shipment_id: "shp_controlledParcel202606030001",
      tracking_code: "9400111202555012345678",
      status: "refunded",
      updated_at: "2026-06-03T03:01:00Z",
    },
  };
  const eventBody = JSON.stringify(eventDetail);

  return {
    calls,
    eventBody,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/v2/events") {
        return jsonResponse({
          events: [{ id: "evt_tracker202606030001", description: "tracker.updated" }, eventSummary],
          has_more: false,
        });
      }
      if (parsed.pathname === "/v2/events/evt_refundStatus202606030001") {
        return jsonResponse(eventDetail);
      }
      if (parsed.pathname === "/v2/events/evt_refundStatus202606030001/payloads") {
        return jsonResponse({
          payloads: [
            {
              id: "payload_refundStatus202606030001",
              created_at: "2026-06-03T03:02:00Z",
              updated_at: "2026-06-03T03:02:01Z",
              request_url: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
              response_code: 400,
              request_body: eventBody,
            },
          ],
        });
      }
      if (parsed.pathname === "/api/fulfillment/provider/postage/webhooks") {
        return textResponse(200, '{"status":"recorded","providerEventId":"evt_refundStatus202606030001"}');
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

describe("easypost refund event replay", () => {
  it("parses operator flags and environment fallbacks", () => {
    expect(
      parseEasyPostRefundEventReplayArgs(
        [
          "--mode",
          "replay",
          "--event-id",
          "evt_refundStatus202606030001",
          "--target-shipment-id",
          "shp_controlledParcel202606030001",
        ],
        {
          EASYPOST_API_KEY: "EZAK_live",
          EASYPOST_WEBHOOK_SECRET: "secret",
          EASYPOST_REFUND_EVENT_REPLAY_CONFIRM: EASYPOST_REFUND_EVENT_REPLAY_CONFIRM,
        },
      ),
    ).toMatchObject({
      apiKey: "EZAK_live",
      webhookSecret: "secret",
      mode: "replay",
      eventId: "evt_refundStatus202606030001",
      targetShipmentId: "shp_controlledParcel202606030001",
    });
  });

  it("validates replay mode guardrails", () => {
    expect(
      validateEasyPostRefundEventReplayOptions({
        apiKey: "EZAK_live",
        webhookUrl: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
        mode: "replay",
        checkedAt: "2026-06-03T03:00:00.000Z",
        startDatetime: "2026-06-01T00:00:00Z",
        pageSize: 100,
        maxPages: 5,
      }),
    ).toEqual([
      "EASYPOST_WEBHOOK_SECRET or --webhook-secret is required for replay mode.",
      `Replay mode requires --confirm "${EASYPOST_REFUND_EVENT_REPLAY_CONFIRM}".`,
    ]);
  });

  it("dry-runs matching EasyPost refund events without leaking full provider identifiers or payload bodies", async () => {
    const stub = createFetchStub();

    const report = await runEasyPostRefundEventReplay(
      {
        apiBaseUrl: "https://api.easypost.com/v2",
        apiKey: "EZAK_live",
        webhookUrl: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
        mode: "dry-run",
        startDatetime: "2026-06-01T00:00:00Z",
        pageSize: 100,
        maxPages: 5,
        checkedAt: "2026-06-03T03:00:00.000Z",
      },
      { fetch: stub.fetch },
    );

    expect(report.refundEventCount).toBe(1);
    expect(report.replay).toBeNull();
    expect(JSON.stringify(report)).not.toContain("evt_refundStatus202606030001");
    expect(JSON.stringify(report)).not.toContain(stub.eventBody);
    expect(report.refundEvents[0]).toMatchObject({
      id: "evt_refu...0001",
      result: {
        id: "rfnd_con...0001",
        shipmentId: "shp_cont...0001",
        trackingCode: "9400...5678",
      },
      payloads: [
        {
          id: "payload_...0001",
          hasRequestBody: true,
          responseCode: 400,
        },
      ],
    });
  });

  it("replays a selected EasyPost payload body with a fresh HMAC signature", async () => {
    const stub = createFetchStub();

    const report = await runEasyPostRefundEventReplay(
      {
        apiBaseUrl: "https://api.easypost.com/v2",
        apiKey: "EZAK_live",
        webhookSecret: "secret",
        webhookUrl: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
        mode: "replay",
        confirm: EASYPOST_REFUND_EVENT_REPLAY_CONFIRM,
        eventId: "evt_refundStatus202606030001",
        startDatetime: "2026-06-01T00:00:00Z",
        pageSize: 100,
        maxPages: 5,
        checkedAt: "2026-06-03T03:00:00.000Z",
      },
      {
        fetch: stub.fetch,
        now: () => new Date("2026-06-03T03:03:00.000Z"),
      },
    );

    const replayCall = stub.calls.find(
      (call) => new URL(call.url).pathname === "/api/fulfillment/provider/postage/webhooks",
    );
    expect(replayCall.init.method).toBe("POST");
    expect(replayCall.init.body).toBe(stub.eventBody);
    expect(replayCall.init.headers["x-timestamp"]).toBe("2026-06-03T03:03:00.000Z");
    expect(replayCall.init.headers["x-path"]).toBe("/api/fulfillment/provider/postage/webhooks");
    expect(replayCall.init.headers["x-hmac-signature-v2"]).toMatch(/^hmac-sha256-hex=[a-f0-9]{64}$/);
    expect(report.replay).toMatchObject({
      attempted: true,
      source: "payload-request-body",
      responseStatus: 200,
      succeeded: true,
    });
    expect(report.replay.responseBodyPreview).not.toContain("evt_refundStatus202606030001");
  });

  it("creates deterministic EasyPost replay headers", () => {
    const headers = createEasyPostReplayHeaders({
      webhookUrl: "https://chasesets.com/api/fulfillment/provider/postage/webhooks",
      webhookSecret: "secret",
      body: '{"id":"evt_1"}',
      now: () => new Date("2026-06-03T03:03:00.000Z"),
    });

    expect(headers).toEqual({
      "Content-Type": "application/json",
      "x-timestamp": "2026-06-03T03:03:00.000Z",
      "x-path": "/api/fulfillment/provider/postage/webhooks",
      "x-hmac-signature-v2": "hmac-sha256-hex=e8d8102a4a6df9c5d08eac9ac63b9c435a3fe61c969a3d8a8866030c87fad437",
    });
  });
});
