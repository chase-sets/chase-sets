import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { createPolicyHistoryReader } from "./index";

const policyKey = "pricing.shipping-window";
const horizon = "502" as never;

function event(
  position: number,
  key = policyKey,
  overrides: Record<string, unknown> = {},
  eventType: StoredEvent["eventType"] = "platform-policy.document.created",
): StoredEvent {
  const documentId = `doc-${position}`;
  return {
    eventId: `evt-${position}` as never,
    streamId: `platform-policy.document-${documentId}`,
    streamVersion: 1,
    globalPosition: String(position) as never,
    tenantId: "tenant" as never,
    eventType,
    payload: {
      documentId,
      policyKey: key,
      status: "active",
      value: { cents: position },
      effectiveFrom: "2026-01-01T00:00:00Z",
      effectiveUntil: null,
      ...overrides,
    },
    metadata: {},
    occurredAt: "2026-01-01T00:00:00.000Z" as never,
    recordedAt: "2026-01-01T00:00:00.000Z" as never,
    performedByUserId: "user" as never,
    forAccountId: "account" as never,
  };
}

function readerFor(events: readonly StoredEvent[]) {
  const reads: unknown[] = [];
  const eventStore: EventStore = {
    appendToStream: async () => [],
    readStream: async () => [],
    readAll: async (input) => {
      reads.push(input);
      return events
        .filter((candidate) => BigInt(candidate.globalPosition) > BigInt(input?.afterGlobalPosition ?? "0"))
        .filter((candidate) => BigInt(candidate.globalPosition) <= BigInt(input?.atOrBeforeGlobalPosition ?? horizon))
        .slice(0, input?.limit ?? 500);
    },
  };
  const pool = { query: async () => ({ rows: [{ head: horizon }] }) } as never;
  return { reader: createPolicyHistoryReader({ eventStore, pool }), reads };
}

describe("bounded policy revision timeline", () => {
  it("returns immutable identity and filters only after scanning each raw page", async () => {
    const { reader, reads } = readerFor([
      event(1),
      event(2, "other.catalog"),
      event(
        3,
        policyKey,
        {
          documentId: "doc-3",
          value: { cents: 3 },
        },
        "platform-policy.document.revised",
      ),
    ]);
    const start = await reader.start(policyKey);
    const page = await reader.readPage(start.continuation);

    expect(page.records).toHaveLength(2);
    expect(page.records.map((record) => record.globalPosition)).toEqual(["1", "3"]);
    expect(page.records[1]).toMatchObject({ eventId: "evt-3", documentId: "doc-3", value: { cents: 3 } });
    expect(page.complete).toBe(true);
    expect(reads).toHaveLength(1);
  });

  it("does not complete a full raw page with no target matches", async () => {
    const first = Array.from({ length: 500 }, (_, index) => event(index + 1, "other.catalog"));
    const { reader } = readerFor([...first, event(501)]);
    const start = await reader.start(policyKey);
    const firstPage = await reader.readPage(start.continuation);
    expect(firstPage.records).toEqual([]);
    expect(firstPage.complete).toBe(false);
    expect(firstPage.continuation.afterGlobalPosition).toBe("500");

    const secondPage = await reader.readPage(firstPage.continuation);
    expect(secondPage.records).toHaveLength(1);
    expect(secondPage.complete).toBe(true);
  });

  it("fails closed on poisoned identity and invalid continuations", async () => {
    const { reader } = readerFor([event(1, policyKey, { documentId: "wrong-document" })]);
    const start = await reader.start(policyKey);
    await expect(reader.readPage(start.continuation)).rejects.toThrow("does not match its stream");
    await expect(reader.readPage({ ...start.continuation, afterGlobalPosition: "01" as never })).rejects.toThrow(
      "canonical global position",
    );
    await expect(reader.readPage({ ...start.continuation, afterGlobalPosition: "503" as never })).rejects.toThrow(
      "outside its fixed horizon",
    );
  });
});
