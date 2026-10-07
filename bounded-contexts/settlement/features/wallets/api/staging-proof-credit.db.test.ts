import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { module as settlementModule } from "../../../index";
import { createSettlementServices } from "../../../support/runtime-support/services";
import { createStagingProofCreditRuntime } from "./staging-proof-credit-runtime";
import { guardStagingProofPolicy } from "./staging-proof-policy";
import { buildWalletProjectionHandlers } from "../read-model/projection";
import { STAGING_PROOF_DOCUMENT, stagingProofCreditPolicy, proofLedgerId } from "../domain/staging-proof-credit";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const accountId = "acc_synthetic_proof_db" as const;
const otherAccountId = "acc_synthetic_proof_other" as const;
const context = {
  tenantId: "tnt_synthetic_proof" as const,
  audit: { performedByUserId: "usr_synthetic_proof" as const, forAccountId: accountId },
};
const actor = (): ResolvedActor => ({
  sessionId: "ses_synthetic_proof",
  tenantId: context.tenantId,
  userId: context.audit.performedByUserId,
  accountId,
  membershipId: "mem_synthetic_proof",
  roleKey: "platform-admin",
  permissions: ["wallet-adjustments.create", "wallet-adjustments.approve"],
  authenticatedAt: new Date().toISOString(),
});
const policyParams = (proofAccountId: AccountId | null = accountId, enabled = true) => ({
  value: { enabled, proofAccountId },
  status: "active" as const,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveUntil: null,
  actorUserId: context.audit.performedByUserId,
});

describeDb("staging-proof-credit atomicity and interleavings on real Postgres", () => {
  let pools: Readonly<Record<"settlement", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["settlement"], "staging_proof_credit");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.settlement;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ settlement: pool });
    await pool.query(settlementModule.schemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const services = () => createSettlementServices(pool, { deploymentEnvironment: "staging" });
  async function enabled() {
    const s = services();
    await s.policies.createPolicyDocument(stagingProofCreditPolicy, policyParams(), context);
    return s;
  }
  const input = { targetAccountId: accountId, amount: "25.00" };

  it("staging-proof-credit-replay: first-pin races admit at most one account/USD25 across all Wallets", async () => {
    const s = services();
    await s.policies.createPolicyDocument(stagingProofCreditPolicy, policyParams(null, false), context);
    const base = createPolicyRuntime({ eventStore: createPostgresEventStore({ pool }), db: pool });
    let readers = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racingPins = guardStagingProofPolicy({
      ...base,
      readPolicyDocumentState: async (id) => {
        const snapshot = await base.readPolicyDocumentState(id);
        readers += 1;
        if (readers === 2) release();
        await rendezvous;
        return snapshot;
      },
    });
    const firstPins = await Promise.allSettled(
      [accountId, otherAccountId].map((id) =>
        racingPins.revisePolicyDocument(stagingProofCreditPolicy, STAGING_PROOF_DOCUMENT, policyParams(id), context),
      ),
    );
    expect(firstPins.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(firstPins.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "concurrency_conflict" } });
    const pin = (await s.policies.readPolicyDocumentState(STAGING_PROOF_DOCUMENT)).state.value as {
      proofAccountId: AccountId;
    };
    const attempts = await Promise.allSettled(
      [accountId, otherAccountId].map((id) =>
        s.stagingProofCredits.post({ ...input, targetAccountId: id }, actor(), context),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const id of [accountId, otherAccountId]) {
      expect((await s.wallets.loadWalletState(id)).availableBalanceAmount).toBe(
        id === pin.proofAccountId ? "25.00" : "0.00",
      );
    }
    for (const proofAccountId of [null, pin.proofAccountId === accountId ? otherAccountId : accountId]) {
      await expect(
        s.policies.revisePolicyDocument(
          stagingProofCreditPolicy,
          STAGING_PROOF_DOCUMENT,
          policyParams(proofAccountId, false),
          context,
        ),
      ).rejects.toThrow("proof_pin_immutable");
    }
    await expect(
      s.policies.createPolicyDocument(stagingProofCreditPolicy, policyParams(otherAccountId), context),
    ).rejects.toThrow();
    await expect(
      s.policies.createPolicyDocumentWithId(
        stagingProofCreditPolicy,
        "replacement",
        policyParams(otherAccountId),
        context,
      ),
    ).rejects.toThrow();
  });

  it("staging-proof-credit-atomic-audit: unopened Wallet, projection lag/rebuild, complete receipt and no lifecycle", async () => {
    const s = await enabled();
    const receipt = await s.stagingProofCredits.post(input, actor(), context);
    expect(receipt.policyVersion).toBe(1);
    const eventStore = createPostgresEventStore({ pool });
    const events = await readCompleteStream(eventStore, { streamId: `settlement.wallet-${accountId}` });
    expect(events.map((e) => e.eventType)).toEqual([
      "settlement.wallet.opened",
      "settlement.wallet.ledger-entry-posted",
      "settlement.wallet.staging-proof-credit-posted",
    ]);
    expect(events[2]!.payload).toEqual(receipt);
    expect(events.every((e) => e.performedByUserId === actor().userId && e.forAccountId === accountId)).toBe(true);
    expect(
      (await pool.query("SELECT * FROM settlement_wallet_pages WHERE account_id = $1", [accountId])).rows,
    ).toHaveLength(0);
    expect(await services().stagingProofCredits.receipt(accountId, actor())).toEqual(receipt);
    const handlers = buildWalletProjectionHandlers(pool);
    const replay = async () => {
      for (const event of events)
        await handlers[event.eventType]!(buildTransportEvent(event.eventType, event.payload), { db: pool });
    };
    await replay();
    expect((await s.wallets.getWallet(accountId)).available_balance_amount).toBe("25.00");
    expect((await s.wallets.listWalletEntries({ accountId })).items[0]).toMatchObject({
      kind: "adjustment",
      adjustment_display_reference: null,
    });
    await pool.query("TRUNCATE settlement_wallet_pages, settlement_ledger_entry_pages");
    await replay();
    expect((await s.wallets.getWallet(accountId)).available_balance_amount).toBe("25.00");
    expect(await services().stagingProofCredits.post(input, actor(), context)).toEqual(receipt);
    expect((await s.walletAdjustments.listAdjustments({})).total).toBe(0);
  });

  it("rollback and audit-omission control: failed transaction leaves neither open, ledger nor audit", async () => {
    const s = await enabled();
    const eventStore = createPostgresEventStore({ pool });
    const failingStore = {
      ...eventStore,
      appendToStreams: async (inputs: Parameters<NonNullable<typeof eventStore.appendToStreams>>[0]) =>
        eventStore.appendToStreams!([
          ...inputs,
          { streamId: "synthetic-failure-control", expectedVersion: 1, events: [], context },
        ]),
    };
    const failing = createStagingProofCreditRuntime({
      eventStore: failingStore,
      policies: s.policies,
      deploymentEnvironment: "staging",
    });
    await expect(failing.post(input, actor(), context)).rejects.toThrow();
    expect(await readCompleteStream(eventStore, { streamId: `settlement.wallet-${accountId}` })).toHaveLength(0);
    await s.stagingProofCredits.post(input, actor(), context);
    const omitAudit = {
      ...eventStore,
      readStream: async (read: Parameters<typeof eventStore.readStream>[0]) =>
        (await eventStore.readStream(read)).filter(
          (e) => e.eventType !== "settlement.wallet.staging-proof-credit-posted",
        ),
    };
    const poisoned = createStagingProofCreditRuntime({
      eventStore: omitAudit,
      policies: s.policies,
      deploymentEnvironment: "staging",
    });
    await expect(poisoned.receipt(accountId, actor())).rejects.toThrow("proof_history_invalid");
    await expect(poisoned.post(input, actor(), context)).rejects.toThrow("proof_history_invalid");
  });

  it("duplicates/lost response/restart, expiry/toggles, spending and refunds retain one pair", async () => {
    const s = await enabled();
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => s.stagingProofCredits.post(input, actor(), context)),
    );
    expect(new Set(receipts.map((r) => JSON.stringify(r))).size).toBe(1);
    await s.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_synthetic_spend",
        amount: "25.00",
        kind: "platform-purchase",
        direction: "debit",
      },
      context,
    );
    await s.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_synthetic_refund",
        amount: "5.00",
        kind: "platform-purchase",
        direction: "credit",
      },
      context,
    );
    for (const change of [
      { value: { enabled: false, proofAccountId: accountId } },
      { effectiveUntil: "2026-02-01T00:00:00.000Z" },
    ]) {
      await s.policies.revisePolicyDocument(
        stagingProofCreditPolicy,
        STAGING_PROOF_DOCUMENT,
        { ...policyParams(), ...change },
        context,
      );
      await expect(s.stagingProofCredits.post(input, actor(), context)).rejects.toThrow();
      expect(await s.stagingProofCredits.receipt(accountId, actor())).toEqual(receipts[0]);
    }
    await s.policies.revisePolicyDocument(stagingProofCreditPolicy, STAGING_PROOF_DOCUMENT, policyParams(), context);
    expect(await services().stagingProofCredits.post(input, actor(), context)).toEqual(receipts[0]);
    await expect(s.stagingProofCredits.post({ ...input, amount: "0.01" }, actor(), context)).rejects.toThrow(
      "proof_amount_conflict",
    );
    const wallet = await s.wallets.loadWalletState(accountId);
    expect(wallet.availableBalanceAmount).toBe("5.00");
    expect(wallet.entries.filter((e) => e.ledgerEntryId === proofLedgerId(accountId))).toHaveLength(1);
    expect(wallet.stagingProofCredits).toHaveLength(1);
  });

  it("concurrent hold/debit and credit redecide without losing balances or consumption", async () => {
    const s = await enabled();
    await s.wallets.postEntry(
      { accountId, ledgerEntryId: "led_synthetic_initial", amount: "10.00", kind: "sale", direction: "credit" },
      context,
    );
    await s.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_synthetic_pending",
        amount: "7.00",
        kind: "sale",
        direction: "credit",
        fundsStatus: "pending",
      },
      context,
    );
    await Promise.all([
      s.stagingProofCredits.post(input, actor(), context),
      s.wallets.placeSpendHold({ accountId, holdId: "synthetic-hold", amount: "2.00" }, context),
      s.wallets.postEntry(
        {
          accountId,
          ledgerEntryId: "led_synthetic_debit",
          amount: "5.00",
          kind: "platform-purchase",
          direction: "debit",
        },
        context,
      ),
    ]);
    expect(await s.wallets.loadWalletState(accountId)).toMatchObject({
      availableBalanceAmount: "30.00",
      pendingBalanceAmount: "7.00",
      heldBalanceAmount: "2.00",
    });
    expect(await s.stagingProofCredits.post(input, actor(), context)).toMatchObject({ amount: "25.00" });
  });

  it("policy revision between decision and append prevents stale authority from committing", async () => {
    const s = await enabled();
    const store = createPostgresEventStore({ pool });
    let changed = false;
    const racing = {
      ...store,
      appendToStreams: async (inputs: Parameters<NonNullable<typeof store.appendToStreams>>[0]) => {
        if (!changed) {
          changed = true;
          await s.policies.revisePolicyDocument(
            stagingProofCreditPolicy,
            STAGING_PROOF_DOCUMENT,
            policyParams(accountId, false),
            context,
          );
        }
        return store.appendToStreams!(inputs);
      },
    };
    const runtime = createStagingProofCreditRuntime({
      eventStore: racing,
      policies: s.policies,
      deploymentEnvironment: "staging",
    });
    await expect(runtime.post(input, actor(), context)).rejects.toThrow("proof_policy_disabled");
    expect((await s.wallets.loadWalletState(accountId)).accountId).toBeNull();
    await s.policies.revisePolicyDocument(stagingProofCreditPolicy, STAGING_PROOF_DOCUMENT, policyParams(), context);
    await s.stagingProofCredits.post(input, actor(), context);
    // Synthetic pin-guard-omission control: the unguarded generic writer violates the same global bound.
    await expect(
      s.policies.revisePolicyDocument(
        stagingProofCreditPolicy,
        STAGING_PROOF_DOCUMENT,
        policyParams(otherAccountId),
        context,
      ),
    ).rejects.toThrow("proof_pin_immutable");
    const unguarded = createPolicyRuntime({ eventStore: store, db: pool });
    await unguarded.revisePolicyDocument(
      stagingProofCreditPolicy,
      STAGING_PROOF_DOCUMENT,
      policyParams(otherAccountId),
      context,
    );
    expect((await unguarded.readPolicyDocumentState(STAGING_PROOF_DOCUMENT)).state.value).toEqual(
      policyParams(otherAccountId).value,
    );
    await s.stagingProofCredits.post({ ...input, targetAccountId: otherAccountId }, actor(), context);
    const credited = await Promise.all([accountId, otherAccountId].map((id) => s.wallets.loadWalletState(id)));
    const oneAccountBound = () =>
      expect(credited.filter((wallet) => wallet.stagingProofCredits.length > 0)).toHaveLength(1);
    expect(oneAccountBound).toThrow();
  });
});
