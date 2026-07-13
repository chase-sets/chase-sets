import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, EventId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createAuthenticityCaseRuntime } from "./runtime";
import { AuthenticityDomainError } from "../../../support/runtime-support/common";

const context = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_seller" as AccountId,
  },
};

function createDeps() {
  const { eventStore } = createInMemoryEventStore();
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  return {
    deps: { eventStore, checkpointStore: {} as never, db: db as never },
    db,
  };
}

const orderSnapshot = {
  orderId: "ord_1" as never,
  listingId: "lst_1",
  catalogItemId: "cat_1",
  expectedConditionLabel: "Near Mint",
};

const authenticityPlan = { planId: "plan_1", feeAmount: "8.00", feeCurrency: "USD" };

describe("authenticity case runtime", () => {
  it("opens a case exactly once and is idempotent for a repeat call on the same order", async () => {
    const { deps } = createDeps();
    const runtime = createAuthenticityCaseRuntime(deps);

    const first = await runtime.openCase(
      {
        orderId: "ord_1",
        sellerAccountId: "acc_seller" as never,
        buyerAccountId: "acc_buyer" as never,
        orderSnapshot,
        authenticityPlan,
      },
      context,
    );

    const second = await runtime.openCase(
      {
        caseId: first.caseId as never,
        orderId: "ord_1",
        sellerAccountId: "acc_seller" as never,
        buyerAccountId: "acc_buyer" as never,
        orderSnapshot,
        authenticityPlan,
      },
      context,
    );

    expect(second.caseId).toBe(first.caseId);
    expect(second.version).toBe(first.version);
  });

  it("drives the full happy path through the command handler", async () => {
    const { deps } = createDeps();
    const runtime = createAuthenticityCaseRuntime(deps);

    const opened = await runtime.openCase(
      {
        orderId: "ord_1",
        sellerAccountId: "acc_seller" as never,
        buyerAccountId: "acc_buyer" as never,
        orderSnapshot,
        authenticityPlan,
      },
      context,
    );

    await runtime.recordInboundTracking({ caseId: opened.caseId, inboundTrackingIdentifier: "1Z-999" }, context);
    await runtime.receiveCase({ caseId: opened.caseId }, context);
    await runtime.beginInspection({ caseId: opened.caseId, inspectorAccountId: "acc_inspector" }, context);
    await runtime.recordVerdict(
      {
        caseId: opened.caseId,
        verdict: "passed",
        reasonCodes: [],
        checklistResults: [{ checkName: "cert-match", result: "pass", notes: null }],
        evidencePhotoRefs: ["obj://evidence/1.jpg"],
        inspectorAccountId: "acc_inspector",
      },
      context,
    );
    const forwarded = await runtime.forwardCase(
      { caseId: opened.caseId, outboundTrackingIdentifier: "1Z-888" },
      context,
    );

    expect(forwarded.version).toBeGreaterThan(opened.version);
  });

  it("rejects forwarding before a passed verdict is recorded", async () => {
    const { deps } = createDeps();
    const runtime = createAuthenticityCaseRuntime(deps);

    const opened = await runtime.openCase(
      {
        orderId: "ord_1",
        sellerAccountId: "acc_seller" as never,
        buyerAccountId: "acc_buyer" as never,
        orderSnapshot,
        authenticityPlan,
      },
      context,
    );

    await expect(runtime.forwardCase({ caseId: opened.caseId }, context)).rejects.toBeInstanceOf(
      AuthenticityDomainError,
    );
  });
});
