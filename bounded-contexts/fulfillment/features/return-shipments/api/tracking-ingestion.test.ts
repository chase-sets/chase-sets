import { describe, expect, it, vi } from "vitest";
import type { PostageProviderWebhookEvent } from "@chase-sets/postage-labels";
import {
  buildReturnShipmentTrackingCommand,
  classifyReturnShipmentTrackingStatus,
  processReturnShipmentTrackingEvent,
  returnTrackingIdempotencyKey,
} from "./tracking-ingestion";
import type { ReturnShipmentTrackingMatch } from "../read-model/queries";

const context = { tenantId: "tnt_1", audit: { performedByUserId: "usr_system" }, trace: {} } as never;

const match: ReturnShipmentTrackingMatch = {
  return_shipment_id: "rsh_1",
  remedy_id: "rmd_1",
  status: "ready-to-ship",
  policy_version: "return-policy-v1",
};

function webhookEvent(overrides: Partial<PostageProviderWebhookEvent> = {}): PostageProviderWebhookEvent {
  return {
    providerEventId: "pev_1",
    providerName: "sandbox-usps",
    providerMode: "test",
    eventKind: "tracking-status",
    providerObjectReference: "track_obj_1",
    providerShipmentId: "ps_1",
    trackingIdentifier: "9400-1",
    status: "delivered",
    statusDetail: null,
    message: null,
    occurredAt: "2026-06-05T00:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

/**
 * Minimal fake of the ReturnShipment provider-event ledger + operator page lookup.
 * Records processed rows so dedup and reconciliation retries can be asserted.
 */
function createFakeDb(shipmentMatch: ReturnShipmentTrackingMatch | null) {
  const processed = new Map<string, string>();
  const hashes = new Map<string, string>();
  const claims = new Map<string, string>();
  const query = vi.fn(async (sql: string, params: readonly unknown[]) => {
    if (sql.includes("WITH inserted AS") && sql.includes("fulfillment_return_shipment_provider_events")) {
      const id = params[0] as string;
      const payloadHash = params[11] as string;
      const inserted = !processed.has(id);
      if (inserted) processed.set(id, "reserved");
      if (!hashes.has(id)) hashes.set(id, payloadHash);
      return {
        rows: [
          {
            payload_hash: hashes.get(id),
            handoff_state:
              processed.get(id) === "unmatched"
                ? "unmatched"
                : processed.get(id) === "reserved"
                  ? "reserved"
                  : "completed",
            processing_result: processed.get(id),
            inserted,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE fulfillment_return_shipment_provider_events") && sql.includes("claim_generation")) {
      const id = params[0] as string;
      const token = params[2] as string;
      if (claims.has(id)) return { rows: [], rowCount: 0 };
      claims.set(id, token);
      return { rows: [{ provider_event_id: id }], rowCount: 1 };
    }
    if (sql.includes("FROM fulfillment_return_shipment_operator_pages")) {
      return { rows: shipmentMatch ? [shipmentMatch] : [], rowCount: shipmentMatch ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO fulfillment_return_shipment_provider_events")) {
      processed.set(params[0] as string, params[12] as string);
      claims.delete(params[0] as string);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { db: { query } as never, query, processed };
}

describe("classifyReturnShipmentTrackingStatus", () => {
  it("maps a possession scan to carrier-accepted, never label creation", () => {
    expect(classifyReturnShipmentTrackingStatus("accepted", null)).toEqual({ kind: "carrier-accepted" });
    expect(classifyReturnShipmentTrackingStatus("picked_up", null)).toEqual({ kind: "carrier-accepted" });
    expect(classifyReturnShipmentTrackingStatus("pre_transit", null)).toEqual({ kind: "carrier-accepted" });
  });

  it("maps movement scans to in-transit and a facility scan to delivered", () => {
    expect(classifyReturnShipmentTrackingStatus("in_transit", null)).toEqual({ kind: "in-transit" });
    expect(classifyReturnShipmentTrackingStatus("out_for_delivery", null)).toEqual({ kind: "in-transit" });
    expect(classifyReturnShipmentTrackingStatus("delivered", null)).toEqual({ kind: "delivered" });
  });

  it("classifies loss, damage, and undeliverable scans as explicit exceptions", () => {
    expect(classifyReturnShipmentTrackingStatus("exception", "package lost")).toEqual({
      kind: "exception",
      exceptionType: "lost-in-transit",
    });
    expect(classifyReturnShipmentTrackingStatus("exception", "damage reported")).toEqual({
      kind: "exception",
      exceptionType: "damaged-in-transit",
    });
    expect(classifyReturnShipmentTrackingStatus("return_to_sender", null)).toEqual({
      kind: "exception",
      exceptionType: "delivery-failed",
    });
  });

  it("does not optimistically advance an ambiguous or unknown status", () => {
    expect(classifyReturnShipmentTrackingStatus("some_new_status", null)).toEqual({ kind: "ignored" });
    expect(classifyReturnShipmentTrackingStatus(null, null)).toEqual({ kind: "ignored" });
  });
});

describe("buildReturnShipmentTrackingCommand", () => {
  it("stamps the command metadata with the shipment's remedy correlation and a stable idempotency key", () => {
    const command = buildReturnShipmentTrackingCommand(
      { kind: "delivered" },
      { match, providerEventId: "pev_9", occurredAt: "2026-06-05T00:00:00.000Z", detail: null },
    );
    expect(command).toMatchObject({
      type: "RecordReturnShipmentDelivered",
      metadata: {
        correlationRemedyId: "rmd_1",
        idempotencyKey: returnTrackingIdempotencyKey("pev_9"),
        policyVersion: "return-policy-v1",
      },
    });
  });

  it("returns null for an ignored milestone", () => {
    expect(
      buildReturnShipmentTrackingCommand(
        { kind: "ignored" },
        { match, providerEventId: "pev_9", occurredAt: "2026-06-05T00:00:00.000Z", detail: null },
      ),
    ).toBeNull();
  });
});

describe("processReturnShipmentTrackingEvent", () => {
  it("applies a delivered carrier scan to the matched reverse shipment", async () => {
    const fake = createFakeDb(match);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const result = await processReturnShipmentTrackingEvent(
      { db: fake.db, commandHandler, streamIdFor: (id) => `fulfillment.return-shipment-${id}` },
      webhookEvent(),
      context,
    );
    expect(result).toMatchObject({ status: "recorded", returnShipmentId: "rsh_1", processingResult: "delivered" });
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "fulfillment.return-shipment-rsh_1",
        command: expect.objectContaining({ type: "RecordReturnShipmentDelivered" }),
      }),
    );
  });

  it("deduplicates a re-delivered webhook by provider event identity", async () => {
    const fake = createFakeDb(match);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const deps = { db: fake.db, commandHandler, streamIdFor: (id: string) => `fulfillment.return-shipment-${id}` };
    await processReturnShipmentTrackingEvent(deps, webhookEvent(), context);
    const second = await processReturnShipmentTrackingEvent(deps, webhookEvent(), context);
    expect(second.status).toBe("duplicate");
    expect(commandHandler).toHaveBeenCalledTimes(1);
  });

  it("records an unmatched event as retryable so a later reconciliation poll repairs the miss", async () => {
    const fake = createFakeDb(null);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const deps = { db: fake.db, commandHandler, streamIdFor: (id: string) => `fulfillment.return-shipment-${id}` };
    const first = await processReturnShipmentTrackingEvent(deps, webhookEvent(), context);
    expect(first.status).toBe("unmatched");
    expect(fake.processed.get("pev_1")).toBe("unmatched");
    // The shipment now exists; a reconciliation poll re-observes the same event id and is NOT deduped.
    const repaired = createFakeDb(match);
    repaired.processed.set("pev_1", "unmatched");
    const commandHandler2 = vi.fn(async () => ({ version: 1 }) as never);
    const second = await processReturnShipmentTrackingEvent(
      { db: repaired.db, commandHandler: commandHandler2, streamIdFor: (id: string) => `x-${id}` },
      webhookEvent(),
      context,
    );
    expect(second.status).toBe("recorded");
    expect(commandHandler2).toHaveBeenCalledTimes(1);
  });

  it("raises an exception without advancing custody for a lost-in-transit scan", async () => {
    const fake = createFakeDb(match);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const result = await processReturnShipmentTrackingEvent(
      { db: fake.db, commandHandler, streamIdFor: (id) => `fulfillment.return-shipment-${id}` },
      webhookEvent({ providerEventId: "pev_lost", status: "exception", statusDetail: "Package lost in transit" }),
      context,
    );
    expect(result.processingResult).toBe("exception");
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "RaiseReturnShipmentException", exceptionType: "lost-in-transit" }),
      }),
    );
  });

  it("ignores non-tracking provider events", async () => {
    const fake = createFakeDb(match);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const result = await processReturnShipmentTrackingEvent(
      { db: fake.db, commandHandler, streamIdFor: (id) => `x-${id}` },
      webhookEvent({ eventKind: "refund-status" }),
      context,
    );
    expect(result.status).toBe("ignored");
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("records an unmapped status as a no-op without emitting a command", async () => {
    const fake = createFakeDb(match);
    const commandHandler = vi.fn(async () => ({ version: 1 }) as never);
    const result = await processReturnShipmentTrackingEvent(
      { db: fake.db, commandHandler, streamIdFor: (id) => `x-${id}` },
      webhookEvent({ providerEventId: "pev_unknown", status: "some_new_status" }),
      context,
    );
    expect(result.processingResult).toBe("ignored");
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
