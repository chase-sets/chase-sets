import { describe, expect, it } from "vitest";
import { hasProcessedProviderWebhookEvent, recordProviderWebhookEvent } from ".";

describe("provider webhook inbox", () => {
  it("inserts provider events idempotently into a caller-owned table", async () => {
    const calls: readonly unknown[][][] = [];
    const db = {
      query: async (_sql: string, values?: readonly unknown[]) => {
        (calls as unknown[][][]).push([values as unknown[]]);
        return { rows: [{ provider_event_id: values?.[0] }], rowCount: 1 };
      },
    };

    await expect(
      recordProviderWebhookEvent(db as never, {
        tableName: "payments_provider_webhook_events",
        providerEventId: "evt_123",
        providerName: "stripe",
        eventKind: "payment-failed",
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("returns false when the provider event unique constraint rejects a duplicate", async () => {
    const insertedEventIds = new Set<string>();
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        expect(sql).toContain("ON CONFLICT (provider_event_id) DO NOTHING");
        const providerEventId = String(values?.[0]);
        if (insertedEventIds.has(providerEventId)) {
          return { rows: [], rowCount: 0 };
        }
        insertedEventIds.add(providerEventId);
        return { rows: [{ provider_event_id: providerEventId }], rowCount: 1 };
      },
    };
    const entry = {
      tableName: "payments_provider_webhook_events",
      providerEventId: "evt_duplicate",
      providerName: "stripe",
      eventKind: "payment-failed",
    } as const;

    await expect(recordProviderWebhookEvent(db as never, entry)).resolves.toBe(true);
    await expect(recordProviderWebhookEvent(db as never, entry)).resolves.toBe(false);
    expect(insertedEventIds).toEqual(new Set(["evt_duplicate"]));
  });

  it("rejects unsafe table names", async () => {
    await expect(
      recordProviderWebhookEvent({ query: async () => ({ rows: [] }) } as never, {
        tableName: "payments;drop table",
        providerEventId: "evt_123",
        providerName: "stripe",
        eventKind: "payment-failed",
      }),
    ).rejects.toThrow("Provider webhook inbox table name is invalid.");
  });

  it("checks whether a provider event was already processed", async () => {
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        expect(sql).toContain("FROM payments_provider_webhook_events");
        expect(values).toEqual(["evt_123"]);
        return { rows: [{ provider_event_id: "evt_123" }] };
      },
    };

    await expect(
      hasProcessedProviderWebhookEvent(db as never, {
        tableName: "payments_provider_webhook_events",
        providerEventId: "evt_123",
      }),
    ).resolves.toBe(true);
  });
});
