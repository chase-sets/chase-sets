import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EnqueueNotificationInput, NotificationOutbox } from "@chase-sets/outbound-messaging";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as settlementModule } from "../../../index";
import { buildWalletAdjustmentProjectionHandlers } from "./wallet-adjustment-projection";
import {
  getWalletAdjustment,
  getWalletAdjustmentForAccount,
  listIncompleteWalletAdjustments,
  listWalletAdjustments,
} from "./wallet-adjustment-queries";
import { listWalletEntries } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["settlement"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  return databaseBaseUrl;
}

// Real minted Wallet Adjustment ids are ULIDs (deriveWalletAdjustmentId), so
// the display-reference derivation yields a WAD-XXXXXXXX reference. Fixtures
// must use a real ULID; a short placeholder trips the raw-id fallback and
// would not exercise the display-reference path the projection relies on.
const adjustmentId = "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";

/** Minimal transport envelope fields the notification-enqueueing handlers read; unused by the plain replay tests below. */
function envelope(id: string, occurredAt: string) {
  return { id, globalPosition: id, trace: { traceId: `req_${id}` }, timing: { occurredAt } };
}

/** A `NotificationOutbox` spy typed against the real port so `.mock.calls[0][0]` is indexable without an `any` cast. */
function createOutboxSpy(): NotificationOutbox & {
  enqueueNotification: Mock<(input: EnqueueNotificationInput) => Promise<void>>;
} {
  const enqueueNotification: Mock<(input: EnqueueNotificationInput) => Promise<void>> = vi.fn(async () => undefined);
  return { enqueueNotification };
}

const lifecycle = [
  {
    ...envelope("evt_requested_1", "2026-07-10T00:00:00.000Z"),
    type: "settlement.wallet-adjustment.requested",
    data: {
      adjustmentId,
      targetAccountId: "acc_seller",
      direction: "credit",
      amount: "40.00",
      currencyCode: "usd",
      reasonCode: "goodwill-cash-credit",
      explanation: null,
      evidenceReferences: ["case-1"],
      reversalOfAdjustmentId: null,
      requestedBy: "usr_requester",
      requestedAt: "2026-07-10T00:00:00.000Z",
      selfBenefiting: false,
    },
  },
  {
    ...envelope("evt_approved_1", "2026-07-10T01:00:00.000Z"),
    type: "settlement.wallet-adjustment.approved",
    data: {
      adjustmentId,
      approvedBy: "usr_approver",
      approvedAt: "2026-07-10T01:00:00.000Z",
      controls: {
        highValueCreditThresholdAmount: "500.00",
        highValueDebitThresholdAmount: "500.00",
        recentAuthMaxAgeMinutes: 15,
      },
      elevationRequired: false,
      elevationReasons: [],
      elevationApprovedBy: null,
      createsOrIncreasesNegativeBalance: false,
      reversalAfterFundsSettled: false,
    },
  },
  {
    ...envelope("evt_posted_1", "2026-07-10T02:00:00.000Z"),
    type: "settlement.wallet-adjustment.posted",
    data: {
      adjustmentId,
      ledgerEntryId: "led_replay_1",
      postedAt: "2026-07-10T02:00:00.000Z",
      availableBalanceBefore: "10.00",
      availableBalanceAfter: "50.00",
    },
  },
] as const;

describeDb("settlement wallet adjustment projection persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "wallet_adjustment",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.settlement;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  async function replay(times: number) {
    const handlers = buildWalletAdjustmentProjectionHandlers(pool);
    for (let i = 0; i < times; i += 1) {
      for (const event of lifecycle) {
        await handlers[event.type]?.(event as never, {} as never);
      }
    }
  }

  it("reconstructs the adjustment and its ledger linkage, idempotently under replay", async () => {
    await replay(2);

    const row = await getWalletAdjustment(pool, adjustmentId);
    expect(row?.status).toBe("posted");
    expect(row?.amount).toBe("40.00");
    expect(row?.reason_code).toBe("goodwill-cash-credit");
    expect(row?.posted_ledger_entry_id).toBe("led_replay_1");
    expect(row?.available_balance_before).toBe("10.00");
    expect(row?.available_balance_after).toBe("50.00");
    expect(row?.high_value_credit_threshold_amount).toBe("500.00");
    expect(row?.recent_auth_max_age_minutes).toBe(15);
    expect(row?.evidence_references).toEqual(["case-1"]);

    const list = await listWalletAdjustments(pool, { targetAccountId: "acc_seller" });
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);
  });

  it("joins Wallet Adjustment linkage onto the account-facing ledger entry, and leaves non-adjustment entries unlinked", async () => {
    await replay(1);
    const adjustment = await getWalletAdjustment(pool, adjustmentId);

    await pool.query(
      `INSERT INTO settlement_wallet_pages (account_id, currency_code, pending_balance_amount, available_balance_amount, total_credited_amount, total_debited_amount, updated_at)
       VALUES ('acc_seller', 'usd', '0.00', '50.00', '40.00', '0.00', '2026-07-10T02:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO settlement_ledger_entry_pages (ledger_entry_id, account_id, kind, direction, amount, currency_code, funds_status, posted_at, updated_at)
       VALUES ('led_replay_1', 'acc_seller', 'adjustment', 'credit', '40.00', 'usd', 'available', '2026-07-10T02:00:00.000Z', '2026-07-10T02:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO settlement_ledger_entry_pages (ledger_entry_id, account_id, kind, direction, amount, currency_code, funds_status, posted_at, updated_at)
       VALUES ('led_sale_1', 'acc_seller', 'sale', 'credit', '15.00', 'usd', 'pending', '2026-07-10T03:00:00.000Z', '2026-07-10T03:00:00.000Z')`,
    );

    const { items } = await listWalletEntries(pool, { accountId: "acc_seller" });
    expect(items).toHaveLength(2);

    const adjustmentEntry = items.find((entry) => entry.ledger_entry_id === "led_replay_1");
    expect(adjustmentEntry?.adjustment_id).toBe(adjustmentId);
    expect(adjustmentEntry?.adjustment_display_reference).toBe(adjustment?.display_reference);
    expect(adjustmentEntry?.adjustment_status).toBe("posted");
    expect(adjustmentEntry?.adjustment_reason_code).toBe("goodwill-cash-credit");
    expect(adjustmentEntry?.adjustment_reversal_of_adjustment_id).toBeNull();
    expect(adjustmentEntry?.adjustment_reversed_by_adjustment_id).toBeNull();

    const saleEntry = items.find((entry) => entry.ledger_entry_id === "led_sale_1");
    expect(saleEntry?.adjustment_id ?? null).toBeNull();
  });

  it("keeps an approved-but-unposted adjustment observable as incomplete, then clears it once posted", async () => {
    const handlers = buildWalletAdjustmentProjectionHandlers(pool);
    await handlers["settlement.wallet-adjustment.requested"]?.(lifecycle[0] as never, {} as never);
    await handlers["settlement.wallet-adjustment.approved"]?.(lifecycle[1] as never, {} as never);

    const incompleteBefore = await listIncompleteWalletAdjustments(pool);
    expect(incompleteBefore.map((entry) => entry.adjustment_id)).toContain(adjustmentId);

    await handlers["settlement.wallet-adjustment.posted"]?.(lifecycle[2] as never, {} as never);
    const incompleteAfter = await listIncompleteWalletAdjustments(pool);
    expect(incompleteAfter.map((entry) => entry.adjustment_id)).not.toContain(adjustmentId);
  });

  it("stores a support-safe display reference, resolvable only for the owning account", async () => {
    await replay(1);

    const row = await getWalletAdjustment(pool, adjustmentId);
    expect(row?.display_reference).toMatch(/^WAD-[0-9A-Z]{8}$/);

    const ownedLookup = await getWalletAdjustmentForAccount(pool, {
      reference: row!.display_reference,
      accountId: "acc_seller",
    });
    expect(ownedLookup?.display_reference).toBe(row!.display_reference);
    expect(ownedLookup?.status).toBe("posted");
    expect(ownedLookup).not.toHaveProperty("adjustment_id");
    expect(ownedLookup).not.toHaveProperty("explanation");
    expect(ownedLookup).not.toHaveProperty("evidence_references");
    expect(ownedLookup).not.toHaveProperty("requested_by");

    const wrongAccountLookup = await getWalletAdjustmentForAccount(pool, {
      reference: row!.display_reference,
      accountId: "acc_someone_else",
    });
    expect(wrongAccountLookup).toBeNull();

    const byTypedId = await getWalletAdjustmentForAccount(pool, {
      reference: adjustmentId,
      accountId: "acc_seller",
    });
    expect(byTypedId?.display_reference).toBe(row!.display_reference);
  });

  it("enqueues exactly one posted notice for an ordinary adjustment, using the payout-readiness contact email when on file", async () => {
    await pool.query(
      `INSERT INTO settlement_payout_readiness_pages (account_id, status, contact_email, updated_at)
       VALUES ('acc_seller', 'ready', 'seller@example.com', '2026-07-09T00:00:00.000Z')`,
    );

    const outbox = createOutboxSpy();
    const handlers = buildWalletAdjustmentProjectionHandlers(pool, outbox);
    for (const event of lifecycle) {
      await handlers[event.type]?.(event as never, {} as never);
    }

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    const call = outbox.enqueueNotification.mock.calls[0]![0];
    expect(call.message.messageType).toBe("settlement.wallet-adjustment.posted");
    expect(call.message.idempotencyKey).toBe(`settlement:wallet_adjustment_posted:${adjustmentId}`);
    expect(call.message.recipientAccountId).toBe("acc_seller");
    expect(call.message.channels.some((channel) => channel.channel === "email")).toBe(true);
  });

  it("enqueues no posted notice for a bare posting and exactly one reversed notice linking both entries", async () => {
    const originalId = "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8P1";
    const reversalId = "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8P2";
    const targetAccountId = "acc_rev_target";

    const outbox = createOutboxSpy();
    const handlers = buildWalletAdjustmentProjectionHandlers(pool, outbox);

    const originalLifecycle = [
      {
        ...envelope("evt_orig_requested", "2026-07-11T00:00:00.000Z"),
        type: "settlement.wallet-adjustment.requested",
        data: {
          adjustmentId: originalId,
          targetAccountId,
          direction: "debit",
          amount: "20.00",
          currencyCode: "usd",
          reasonCode: "operational-error",
          explanation: null,
          evidenceReferences: [],
          reversalOfAdjustmentId: null,
          requestedBy: "usr_requester",
          requestedAt: "2026-07-11T00:00:00.000Z",
          selfBenefiting: false,
        },
      },
      {
        ...envelope("evt_orig_approved", "2026-07-11T01:00:00.000Z"),
        type: "settlement.wallet-adjustment.approved",
        data: {
          adjustmentId: originalId,
          approvedBy: "usr_approver",
          approvedAt: "2026-07-11T01:00:00.000Z",
          controls: {
            highValueCreditThresholdAmount: "500.00",
            highValueDebitThresholdAmount: "500.00",
            recentAuthMaxAgeMinutes: 15,
          },
          elevationRequired: false,
          elevationReasons: [],
          elevationApprovedBy: null,
          createsOrIncreasesNegativeBalance: false,
          reversalAfterFundsSettled: false,
        },
      },
      {
        ...envelope("evt_orig_posted", "2026-07-11T02:00:00.000Z"),
        type: "settlement.wallet-adjustment.posted",
        data: {
          adjustmentId: originalId,
          ledgerEntryId: "led_rev_orig",
          postedAt: "2026-07-11T02:00:00.000Z",
          availableBalanceBefore: "50.00",
          availableBalanceAfter: "30.00",
        },
      },
    ] as const;

    for (const event of originalLifecycle) {
      await handlers[event.type]?.(event as never, {} as never);
    }
    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    outbox.enqueueNotification.mockClear();

    const reversalLifecycle = [
      {
        ...envelope("evt_rev_requested", "2026-07-12T00:00:00.000Z"),
        type: "settlement.wallet-adjustment.requested",
        data: {
          adjustmentId: reversalId,
          targetAccountId,
          direction: "credit",
          amount: "20.00",
          currencyCode: "usd",
          reasonCode: "operational-error",
          explanation: "Reversal",
          evidenceReferences: [],
          reversalOfAdjustmentId: originalId,
          requestedBy: "usr_requester",
          requestedAt: "2026-07-12T00:00:00.000Z",
          selfBenefiting: false,
        },
      },
      {
        ...envelope("evt_rev_approved", "2026-07-12T01:00:00.000Z"),
        type: "settlement.wallet-adjustment.approved",
        data: {
          adjustmentId: reversalId,
          approvedBy: "usr_approver",
          approvedAt: "2026-07-12T01:00:00.000Z",
          controls: {
            highValueCreditThresholdAmount: "500.00",
            highValueDebitThresholdAmount: "500.00",
            recentAuthMaxAgeMinutes: 15,
          },
          elevationRequired: true,
          elevationReasons: ["reversal-after-settlement"],
          elevationApprovedBy: "usr_elevated_approver",
          createsOrIncreasesNegativeBalance: false,
          reversalAfterFundsSettled: true,
        },
      },
      {
        ...envelope("evt_rev_posted", "2026-07-12T02:00:00.000Z"),
        type: "settlement.wallet-adjustment.posted",
        data: {
          adjustmentId: reversalId,
          ledgerEntryId: "led_rev_reversal",
          postedAt: "2026-07-12T02:00:00.000Z",
          availableBalanceBefore: "30.00",
          availableBalanceAfter: "50.00",
        },
      },
    ] as const;

    for (const event of reversalLifecycle) {
      await handlers[event.type]?.(event as never, {} as never);
    }
    // The reversal's own posting is not announced on its own.
    expect(outbox.enqueueNotification).not.toHaveBeenCalled();

    const reversedEvent = {
      ...envelope("evt_orig_reversed", "2026-07-12T03:00:00.000Z"),
      type: "settlement.wallet-adjustment.reversed",
      data: {
        adjustmentId: originalId,
        reversalAdjustmentId: reversalId,
        reversedBy: "usr_requester",
        reversedAt: "2026-07-12T03:00:00.000Z",
      },
    } as const;
    await handlers[reversedEvent.type]?.(reversedEvent as never, {} as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    const call = outbox.enqueueNotification.mock.calls[0]![0];
    expect(call.message.messageType).toBe("settlement.wallet-adjustment.reversed");
    expect(call.message.idempotencyKey).toBe(`settlement:wallet_adjustment_reversed:${originalId}`);
    expect(call.message.recipientAccountId).toBe(targetAccountId);
    expect(call.message.templateData.originalReference).toMatch(/^WAD-/);
    expect(call.message.templateData.reversalReference).toMatch(/^WAD-/);
    expect(call.message.templateData.resultingBalance).toContain("50");
  });
});
