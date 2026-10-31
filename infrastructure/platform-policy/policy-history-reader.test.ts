import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { GlobalPosition, StoredEvent } from "@chase-sets/event-core/storage";
import { createPolicyHistoryReader, PolicyHistoryReaderError } from "./index";

const policyKey = "pricing.shipping-window";
const otherPolicyKey = "other.catalog";

type EventOptions = Readonly<{
  documentId?: string;
  streamVersion?: number;
  eventId?: string;
  omitValue?: boolean;
}>;

function event(
  position: number,
  key = policyKey,
  overrides: Record<string, unknown> = {},
  eventType: StoredEvent["eventType"] = "platform-policy.document.created",
  options: EventOptions = {},
): StoredEvent {
  const documentId = options.documentId ?? `doc-${position}`;
  const payload: Record<string, unknown> = {
    documentId,
    policyKey: key,
    status: "active",
    value: { cents: position },
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveUntil: null,
    ...overrides,
  };
  if (options.omitValue) delete payload.value;
  return {
    eventId: (options.eventId ?? `evt-${position}`) as never,
    streamId: `platform-policy.document-${documentId}`,
    streamVersion: options.streamVersion ?? 1,
    globalPosition: String(position) as never,
    tenantId: "tenant" as never,
    eventType,
    payload: payload as never,
    metadata: {},
    occurredAt: "2026-01-01T00:00:00.000Z" as never,
    recordedAt: "2026-01-01T00:00:00.000Z" as never,
    performedByUserId: "user" as never,
    forAccountId: "account" as never,
  };
}

type ReaderOptions = Readonly<{
  horizon?: GlobalPosition;
  readAll?: EventStore["readAll"];
}>;

function readerFor(events: readonly StoredEvent[], options: ReaderOptions = {}) {
  const horizon = options.horizon ?? (events.length === 0 ? "0" : events.at(-1)!.globalPosition);
  const reads: unknown[] = [];
  const eventStore: EventStore = {
    appendToStream: async () => [],
    readStream: async () => [],
    readAll:
      options.readAll ??
      (async (input) => {
        reads.push(input);
        return events
          .filter((candidate) => BigInt(candidate.globalPosition) > BigInt(input?.afterGlobalPosition ?? "0"))
          .filter((candidate) => BigInt(candidate.globalPosition) <= BigInt(input?.atOrBeforeGlobalPosition ?? horizon))
          .slice(0, input?.limit ?? 500);
      }),
  };
  const pool = { query: async () => ({ rows: [{ head: horizon }] }) } as never;
  return { reader: createPolicyHistoryReader({ eventStore, pool }), reads };
}

describe("bounded policy history reader", () => {
  it("policy timeline identity and document coverage", async () => {
    const { reader, reads } = readerFor([
      event(9, policyKey, { value: { cents: 9 }, effectiveFrom: "2026-01-01T00:00:00.000Z" }, undefined, {
        documentId: "doc-history",
        streamVersion: 1,
      }),
      event(
        10,
        policyKey,
        { value: { cents: 9 }, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        "platform-policy.document.revised",
        { documentId: "doc-history", streamVersion: 2 },
      ),
      event(
        11,
        policyKey,
        { value: { cents: 11 }, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        "platform-policy.document.revised",
        { documentId: "doc-history", streamVersion: 3 },
      ),
      event(12, policyKey, { status: "inactive" }, undefined, { documentId: "doc-inactive" }),
      event(13, policyKey, { effectiveUntil: "2026-01-02T00:00:00.000Z" }, undefined, { documentId: "doc-expired" }),
    ]);

    const start = await reader.start(policyKey);
    const page = await reader.readPage(start.continuation);

    expect(reads[0]).toMatchObject({
      afterGlobalPosition: "0",
      atOrBeforeGlobalPosition: start.horizon,
      eventTypes: ["platform-policy.document.created", "platform-policy.document.revised"],
      streamPrefixes: ["platform-policy.document-"],
      limit: 500,
    });

    expect(page.records).toEqual([
      {
        eventId: "evt-9",
        eventType: "platform-policy.document.created",
        policyKey,
        documentId: "doc-history",
        streamVersion: 1,
        globalPosition: "9",
        recordedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        value: { cents: 9 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      {
        eventId: "evt-10",
        eventType: "platform-policy.document.revised",
        policyKey,
        documentId: "doc-history",
        streamVersion: 2,
        globalPosition: "10",
        recordedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        value: { cents: 9 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      {
        eventId: "evt-11",
        eventType: "platform-policy.document.revised",
        policyKey,
        documentId: "doc-history",
        streamVersion: 3,
        globalPosition: "11",
        recordedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        value: { cents: 11 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      {
        eventId: "evt-12",
        eventType: "platform-policy.document.created",
        policyKey,
        documentId: "doc-inactive",
        streamVersion: 1,
        globalPosition: "12",
        recordedAt: "2026-01-01T00:00:00.000Z",
        status: "inactive",
        value: { cents: 12 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
      },
      {
        eventId: "evt-13",
        eventType: "platform-policy.document.created",
        policyKey,
        documentId: "doc-expired",
        streamVersion: 1,
        globalPosition: "13",
        recordedAt: "2026-01-01T00:00:00.000Z",
        status: "active",
        value: { cents: 13 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  describe("raw-page continuation is complete", () => {
    it("keeps raw-page continuation complete across an interleaved 500-event boundary and JSON restart", async () => {
      const events = Array.from({ length: 502 }, (_, index) =>
        event(index + 1, index + 1 === 499 || index + 1 === 501 ? policyKey : otherPolicyKey),
      );
      const { reader } = readerFor(events);
      const start = await reader.start(policyKey);

      const first = await reader.readPage(start.continuation);
      expect(first.records.map((record) => record.globalPosition)).toEqual(["499"]);
      expect(first.complete).toBe(false);
      expect(first.continuation.afterGlobalPosition).toBe("500");

      const restarted = JSON.parse(JSON.stringify(first.continuation)) as typeof first.continuation;
      const second = await reader.readPage(restarted);
      expect(second.records.map((record) => record.globalPosition)).toEqual(["501"]);
      expect(second.complete).toBe(true);
    });

    it("requires an empty page after an exactly-500 raw terminal page and completes empty history", async () => {
      const full = readerFor(Array.from({ length: 500 }, (_, index) => event(index + 1, otherPolicyKey)));
      const start = await full.reader.start(policyKey);
      const first = await full.reader.readPage(start.continuation);
      expect(first.records).toEqual([]);
      expect(first.complete).toBe(false);
      expect(first.continuation.afterGlobalPosition).toBe("500");
      await expect(full.reader.readPage(first.continuation)).resolves.toMatchObject({ complete: true, records: [] });

      const empty = readerFor([]);
      const emptyStart = await empty.reader.start(policyKey);
      await expect(empty.reader.readPage(emptyStart.continuation)).resolves.toMatchObject({
        complete: true,
        records: [],
        continuation: { afterGlobalPosition: "0" },
      });
    });
  });

  it("policy timeline fails closed", async () => {
    const malformed: readonly [string, StoredEvent][] = [
      ["status", event(1, policyKey, { status: "paused" })],
      ["window", event(1, policyKey, { effectiveFrom: "not-a-timestamp" })],
      ["policy key", event(1, "not-a-policy-key")],
      ["value", event(1, policyKey, {}, undefined, { omitValue: true })],
    ];
    for (const [label, candidate] of malformed) {
      const { reader } = readerFor([candidate]);
      const start = await reader.start(policyKey);
      await expect(reader.readPage(start.continuation), label).rejects.toThrow();
    }

    const mismatchedIdentity = readerFor([event(1, policyKey, { documentId: "wrong-document" })]);
    const mismatchedStart = await mismatchedIdentity.reader.start(policyKey);
    await expect(mismatchedIdentity.reader.readPage(mismatchedStart.continuation)).rejects.toThrow(
      "does not match its stream",
    );

    const nonObjectPayloads: readonly [string, unknown][] = [
      ["null", null],
      ["string", "doc-1"],
      ["array", []],
    ];
    const nonObjectPayloadFailures = await Promise.all(
      nonObjectPayloads.map(async ([label, payload]) => {
        const { reader } = readerFor([{ ...event(1), payload: payload as never }]);
        const start = await reader.start(policyKey);
        const error = await reader.readPage(start.continuation).then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
        return { label, typed: error instanceof PolicyHistoryReaderError, message: String(error) };
      }),
    );
    expect(nonObjectPayloadFailures).toEqual(
      nonObjectPayloads.map(([label]) => ({
        label,
        typed: true,
        message: expect.stringContaining("payload must be an object"),
      })),
    );

    // Other keys' identities are decoded, but their record fields are not.
    const crossKey = readerFor([event(1), event(2, otherPolicyKey, { status: "paused" })]);
    const crossKeyStart = await crossKey.reader.start(policyKey);
    expect(
      (await crossKey.reader.readPage(crossKeyStart.continuation)).records.map((record) => record.eventId),
    ).toEqual(["evt-1"]);
    const crossKeyIdentity = readerFor([event(1), event(2, otherPolicyKey, { documentId: "wrong-document" })]);
    const crossKeyIdentityStart = await crossKeyIdentity.reader.start(policyKey);
    await expect(crossKeyIdentity.reader.readPage(crossKeyIdentityStart.continuation)).rejects.toThrow(
      "does not match its stream",
    );

    const nonCanonical = readerFor([event(1)]);
    const nonCanonicalStart = await nonCanonical.reader.start(policyKey);
    await expect(
      nonCanonical.reader.readPage({ ...nonCanonicalStart.continuation, afterGlobalPosition: "01" as GlobalPosition }),
    ).rejects.toThrow("canonical global position");

    const outOfHorizon = readerFor([event(1)], { horizon: "2" as GlobalPosition });
    const outOfHorizonStart = await outOfHorizon.reader.start(policyKey);
    await expect(
      outOfHorizon.reader.readPage({ ...outOfHorizonStart.continuation, afterGlobalPosition: "503" as GlobalPosition }),
    ).rejects.toThrow("outside its fixed horizon");

    const missingPosition = readerFor([event(1)]);
    const missingPositionStart = await missingPosition.reader.start(policyKey);
    const missingPositionPage = await missingPosition.reader.readPage(missingPositionStart.continuation);
    const missingPositionContinuation = { ...missingPositionPage.continuation } as {
      policyKey: string;
      horizon: GlobalPosition;
      afterGlobalPosition?: GlobalPosition;
    };
    delete missingPositionContinuation.afterGlobalPosition;
    await expect(
      missingPosition.reader.readPage(missingPositionContinuation as typeof missingPositionPage.continuation),
    ).rejects.toThrow("canonical global position");

    const nonAdvancing = readerFor([], {
      horizon: "2" as GlobalPosition,
      readAll: async () => [event(1), event(1, policyKey, {}, "platform-policy.document.revised")],
    });
    const nonAdvancingStart = await nonAdvancing.reader.start(policyKey);
    await expect(nonAdvancing.reader.readPage(nonAdvancingStart.continuation)).rejects.toThrow("non-advancing");

    const aboveHorizon = readerFor([], {
      horizon: "2" as GlobalPosition,
      readAll: async () => [event(3)],
    });
    const aboveStart = await aboveHorizon.reader.start(policyKey);
    await expect(aboveHorizon.reader.readPage(aboveStart.continuation)).rejects.toThrow("non-advancing");

    const sourceFailure = readerFor([], { readAll: async () => Promise.reject(new Error("source refused")) });
    const sourceStart = await sourceFailure.reader.start(policyKey);
    await expect(sourceFailure.reader.readPage(sourceStart.continuation)).rejects.toThrow("source refused");

    const stable = readerFor([event(1)]);
    const stableStart = await stable.reader.start(policyKey);
    const first = await stable.reader.readPage(stableStart.continuation);
    const replay = await stable.reader.readPage(stableStart.continuation);
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

    const gap = readerFor([
      event(1, policyKey, {}, undefined, { documentId: "doc-gap", streamVersion: 1 }),
      event(2, policyKey, {}, "platform-policy.document.revised", { documentId: "doc-gap", streamVersion: 3 }),
    ]);
    const gapStart = await gap.reader.start(policyKey);
    expect((await gap.reader.readPage(gapStart.continuation)).records.map((record) => record.streamVersion)).toEqual([
      1, 3,
    ]);
  });
});
