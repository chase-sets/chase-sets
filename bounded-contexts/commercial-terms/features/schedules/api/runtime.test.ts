import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createCommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { createScheduleRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
}

describe("commercial terms schedule runtime", () => {
  it("rejects active schedule creation when the account type already has an overlapping active window", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("tstzrange")) {
          return { rows: [{ document_id: "cts_existing" }] };
        }

        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createScheduleRuntime({ policies, db: db as never });

    await expect(
      runtime.createSchedule(
        {
          label: "Business Override",
          accountType: "business",
          marketplaceSalesFeePercentageBps: 650,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 750,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: null,
          createdByUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("Active schedule cts_existing already covers that account type and effective window.");
    expect(allEvents).toHaveLength(0);
  });

  it("rejects active schedule revisions with overlapping windows while excluding the current schedule", async () => {
    const queryParams: (readonly unknown[])[] = [];
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queryParams.push(params ?? []);
        if (sql.includes("FROM platform_policy_document_history")) {
          return { rows: [] };
        }
        if (sql.includes("WHERE document_id = $1") && sql.includes("policy_key LIKE 'commercial-terms.schedule.%'")) {
          return {
            rows: [
              {
                schedule_id: "cts_current",
                label: "Business",
                account_type: "business",
                marketplace_sales_fee_percentage_bps: 850,
                marketplace_sales_fee_fixed_amount: "0.10",
                shipping_allowance_percentage_bps: 500,
                status: "active",
                effective_from: "2026-01-01T00:00:00.000Z",
                effective_until: null,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (sql.includes("tstzrange")) {
          return { rows: [{ document_id: "cts_existing" }] };
        }

        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createScheduleRuntime({ policies, db: db as never });

    await expect(
      runtime.reviseSchedule(
        "cts_current",
        {
          label: "Business Renewal",
          marketplaceSalesFeePercentageBps: 650,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 750,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: null,
          revisedByUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("Active schedule cts_existing already covers that account type and effective window.");
    expect(queryParams).toContainEqual([
      "commercial-terms.schedule.business",
      "2026-05-01T00:00:00.000Z",
      null,
      "cts_current",
    ]);
    expect(allEvents).toHaveLength(0);
  });
});
