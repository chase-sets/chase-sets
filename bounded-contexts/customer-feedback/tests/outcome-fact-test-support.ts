import { expect, vi } from "vitest";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildAuthOutcomeFactProjectionHandlers } from "../features/csat/integrations/auth/outcome-fact-projection";
import { buildIdentityOutcomeFactProjectionHandlers } from "../features/csat/integrations/identity/outcome-fact-projection";
import { buildDiscoveryOutcomeFactProjectionHandlers } from "../features/csat/integrations/discovery/outcome-fact-projection";
import type { OutcomeFact } from "../features/csat/read-model/outcome-fact-projection";

import { buildFulfillmentOutcomeFactProjectionHandlers } from "../features/csat/integrations/fulfillment/outcome-fact-projection";
import { buildPaymentsOutcomeFactProjectionHandlers } from "../features/csat/integrations/payments/outcome-fact-projection";
import { buildSettlementOutcomeFactProjectionHandlers } from "../features/csat/integrations/settlement/outcome-fact-projection";
import { buildSupportOutcomeFactProjectionHandlers } from "../features/csat/integrations/platform-operations/outcome-fact-projection";

export const outcomeHandlers = {
  ...buildAuthOutcomeFactProjectionHandlers(),
  ...buildIdentityOutcomeFactProjectionHandlers(),
  ...buildDiscoveryOutcomeFactProjectionHandlers(),
  ...buildFulfillmentOutcomeFactProjectionHandlers(),
  ...buildPaymentsOutcomeFactProjectionHandlers(),
  ...buildSettlementOutcomeFactProjectionHandlers(),
  ...buildSupportOutcomeFactProjectionHandlers(),
};

export function outcomeRows() {
  const rows = new Map<string, readonly unknown[]>();
  const query = vi.fn(async (_sql: string, values: readonly unknown[] = []) => {
    const key = String(values[0]);
    const inserted = !rows.has(key);
    if (inserted) rows.set(key, [...values]);
    return { rows: [], rowCount: inserted ? 1 : 0 };
  });
  return { db: { query }, rows };
}

export function expectSourceEvent(
  event: StoredEvent | undefined,
  expected: Pick<StoredEvent, "eventType" | "payload" | "tenantId" | "performedByUserId" | "forAccountId">,
) {
  expect(event).toBeDefined();
  expect(event).toMatchObject(expected);
  expect(event!.payload).toEqual(expected.payload);
  expect(event!.eventId).toEqual(expect.any(String));
  expect(event!.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(Number.isNaN(Date.parse(event!.recordedAt))).toBe(false);
}

export async function expectHelperParity(
  event: StoredEvent,
  expected: Omit<OutcomeFact, "outcomeOccurredAt" | "sourceEventId" | "performedByUserId" | "reasonCode">,
) {
  const store = outcomeRows();
  const handler = outcomeHandlers[event.eventType];
  expect(handler).toBeDefined();
  const transported = toTransportEvent(event);
  await handler!(transported, store);
  await handler!(transported, store);
  expect(store.rows.size).toBe(1);
  expect(store.rows.get(expected.idempotencyKey)).toEqual([
    expected.idempotencyKey,
    expected.outcomeCode,
    expected.sourceContext,
    expected.subjectAccountId,
    expected.subjectKind,
    expected.subjectEntityType,
    expected.subjectEntityId,
    event.recordedAt,
    event.eventId,
    event.performedByUserId,
    expected.authenticationMethod,
    null,
  ]);
}

export async function expectProjectionFailure(event: StoredEvent) {
  const failure = new Error("synthetic outcome projection unavailable");
  const query = vi.fn(async () => {
    throw failure;
  });
  await expect(outcomeHandlers[event.eventType]!(toTransportEvent(event), { db: { query } })).rejects.toBe(failure);
  expect(query).toHaveBeenCalledOnce();
}
