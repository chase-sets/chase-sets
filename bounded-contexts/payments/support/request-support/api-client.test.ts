import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeFreshWriteReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { createPaymentsRequestApiHeaders, hasPaymentsFreshReadAfterWriteSource } from "./api-client";

describe("payments request API client support", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("encodes after-write source metadata as Payments fresh-read headers", () => {
    const observedAtMs = Date.parse("2026-06-24T07:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(observedAtMs);
    const afterWriteSource = {
      commandReceipt: {
        mode: "eventual",
        commitPosition: "42",
        commitEventIds: ["evt_order_created"],
        commitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      },
    };

    const headers = new Headers(createPaymentsRequestApiHeaders({ afterWriteSource }));

    expect(hasPaymentsFreshReadAfterWriteSource(afterWriteSource)).toBe(true);
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("payments");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), observedAtMs)).toEqual({
      observedAtMs,
      commitPosition: "42",
      sources: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
  });

  it("preserves explicit freshness headers over after-write source defaults", () => {
    const observedAtMs = Date.parse("2026-06-24T07:00:00.000Z");
    const explicitReceipt = encodeFreshWriteReceipt({
      observedAtMs,
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "9",
          eventIds: ["evt_checkout"],
        },
      ],
    });
    const afterWriteSource = {
      commandReceipt: {
        mode: "eventual",
        commitPosition: "42",
        commitEventIds: ["evt_order_created"],
        commitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      },
    };

    const headers = new Headers(
      createPaymentsRequestApiHeaders({
        headers: {
          [CHASE_SETS_READ_AFTER_WRITE_HEADER]: explicitReceipt,
          [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "checkout",
        },
        afterWriteSource,
        nowMs: observedAtMs,
      }),
    );

    expect(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(explicitReceipt);
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("checkout");
  });

  it("does not claim freshness for sources without mutation metadata", () => {
    expect(hasPaymentsFreshReadAfterWriteSource({ orderIds: ["ord_1"] })).toBe(false);
    expect(createPaymentsRequestApiHeaders({ afterWriteSource: { orderIds: ["ord_1"] } })).toBeUndefined();
  });
});
