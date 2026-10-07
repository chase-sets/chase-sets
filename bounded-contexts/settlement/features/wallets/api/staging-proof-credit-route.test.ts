import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { SettlementApiEnv } from "../../../api";
import { guardStagingProofPolicy } from "./staging-proof-policy";
import { createStagingProofCreditRuntime } from "./staging-proof-credit-runtime";
import { createStagingProofCreditRoutes } from "./staging-proof-credit-route";
import { STAGING_PROOF_DOCUMENT, stagingProofCreditPolicy, proofLedgerId } from "../domain/staging-proof-credit";
import { createWalletRuntime } from "./runtime";
import { readFileSync } from "node:fs";

const accountId = "acc_synthetic_proof" as const;
const actor: ResolvedActor = {
  sessionId: "ses_synthetic",
  tenantId: "tnt_synthetic",
  userId: "usr_synthetic",
  accountId,
  membershipId: "mem_synthetic",
  roleKey: "platform-admin",
  permissions: ["wallet-adjustments.create", "wallet-adjustments.approve"],
  authenticatedAt: new Date().toISOString(),
};
const context = {
  tenantId: "tnt_synthetic" as const,
  audit: { performedByUserId: "usr_synthetic" as const, forAccountId: accountId },
};
const db = { query: async () => ({ rows: [], rowCount: 0 }) };
const params = {
  value: { enabled: true, proofAccountId: accountId },
  status: "active" as const,
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveUntil: null,
  actorUserId: actor.userId,
};

async function setup(environment: unknown = "staging") {
  const memory = createInMemoryEventStore();
  const policies = guardStagingProofPolicy(createPolicyRuntime({ eventStore: memory.eventStore, db }));
  await policies.createPolicyDocument(stagingProofCreditPolicy, params, context);
  const services = createStagingProofCreditRuntime({
    eventStore: memory.eventStore,
    policies,
    deploymentEnvironment: environment as DeploymentEnvironment,
  });
  const wallets = createWalletRuntime({ eventStore: memory.eventStore, db, checkpointStore: {} as never });
  const appFor = (resolvedActor: ResolvedActor | null = actor, runtime = services) => {
    const app = new Hono<SettlementApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", resolvedActor);
      c.set("context", context);
      await next();
    });
    app.route("/", createStagingProofCreditRoutes(runtime));
    return app;
  };
  return { ...memory, policies, services, wallets, appFor };
}
function request(
  app: Hono<SettlementApiEnv>,
  body: unknown = { targetAccountId: accountId, amount: "25.00" },
  headers = {},
) {
  return app.request("/wallet/staging-proof-credits", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Chase-Sets-CSRF": "1", ...headers },
  });
}

describe("staging-proof-credit-environment", () => {
  it.each(["production", "preview", "test", "dev", "local", "remote-dev", "unknown", "", null])(
    "refuses %s with all other guards valid",
    async (environment) => {
      const f = await setup(environment);
      const response = await request(f.appFor(), undefined, {
        Host: "staging.example.test",
        "X-Deployment-Environment": "staging",
      });
      expect(response.status).toBe(409);
      await expect(f.services.post({ targetAccountId: accountId, amount: "25.00" }, actor, context)).rejects.toThrow(
        "proof_environment_refused",
      );
      expect(f.allEvents.filter((e) => e.streamId.startsWith("settlement.wallet-"))).toHaveLength(0);
    },
  );
  it("unknown-environment-refusal: absent runtime binding and route-guard-only bypass remain closed", async () => {
    const f = await setup("production");
    const absent = createStagingProofCreditRuntime({ eventStore: f.eventStore, policies: f.policies });
    await expect(absent.post({ targetAccountId: accountId, amount: "25.00" }, actor, context)).rejects.toThrow(
      "proof_environment_refused",
    );
    expect((await request(f.appFor(actor, { ...f.services, deploymentEnvironment: "staging" }))).status).toBe(409);
    expect(f.allEvents.filter((e) => e.streamId.startsWith("settlement.wallet-"))).toHaveLength(0);
  });
});

describe("staging-proof-credit-authority-and-cap", () => {
  it.each(["0.00", "-0.01", "25.01", "1.001", "NaN", "Infinity", "1", 1, null])(
    "amount-cap refuses %s without append",
    async (amount) => {
      const f = await setup();
      expect((await request(f.appFor(), { targetAccountId: accountId, amount })).status).toBe(409);
      expect(await f.services.receipt(accountId, actor)).toBeNull();
    },
  );
  it.each(["0.01", "25.00"])("accepts boundary %s with complete audit-fact-present", async (amount) => {
    const f = await setup();
    expect((await request(f.appFor(), { targetAccountId: accountId, amount })).status).toBe(200);
    expect(await f.services.receipt(accountId, actor)).toMatchObject({
      accountId,
      actorUserId: actor.userId,
      amount,
      currencyCode: "usd",
      cap: "25.00",
      environment: "staging",
      proof: "7806-ac6",
      policyDocumentId: STAGING_PROOF_DOCUMENT,
      policyVersion: 1,
      reason: "staging-operator-proof",
      recentlyAuthenticated: true,
      authenticatedAt: actor.authenticatedAt,
      recentAuthMaxAgeMinutes: 15,
      ruling: "https://github.com/chase-sets/chase-sets/issues/7806#issuecomment-6041721954",
      ledgerEntryId: proofLedgerId(accountId),
    });
    const wallet = await f.wallets.loadWalletState(accountId);
    expect(wallet.availableBalanceAmount).toBe(amount);
    expect(wallet.entries).toHaveLength(1);
    expect(wallet.stagingProofCredits).toHaveLength(1);
  });
  it.each([{ currencyCode: "usd" }, { environment: "staging" }, { idempotencyKey: "retry" }])(
    "closed request refuses %j",
    async (extra) => {
      const f = await setup();
      expect((await request(f.appFor(), { targetAccountId: accountId, amount: "1.00", ...extra })).status).toBe(409);
    },
  );
  it.each([[], ["payouts.create"], ["wallet-adjustments.create"], ["wallet-adjustments.approve"]])(
    "requires both permissions %j",
    async (...permissions) => {
      const f = await setup();
      expect((await request(f.appFor({ ...actor, permissions: permissions.flat() }))).status).toBe(409);
      expect(await f.services.receipt(accountId, actor)).toBeNull();
    },
  );
  it("refuses stale/missing/future auth, missing session, missing CSRF and non-proof-account", async () => {
    const f = await setup();
    for (const authenticatedAt of [null, "invalid", "2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
      expect((await request(f.appFor({ ...actor, authenticatedAt }))).status).toBe(409);
    }
    expect((await request(f.appFor({ ...actor, sessionId: "" }))).status).toBe(409);
    expect((await request(f.appFor(), undefined, { "X-Chase-Sets-CSRF": "" })).status).toBe(409);
    expect((await request(f.appFor(), undefined, { "Sec-Fetch-Site": "cross-site" })).status).toBe(409);
    expect((await request(f.appFor(), { targetAccountId: "acc_other", amount: "25.00" })).status).toBe(409);
    expect(await f.services.receipt(accountId, actor)).toBeNull();
  });
  it("real console write adapter refuses pin-change, null-reset, replacement and malformed policy", async () => {
    const f = await setup();
    for (const proofAccountId of [null, "acc_other"] as const) {
      await expect(
        f.policies.revisePolicyDocument(
          stagingProofCreditPolicy,
          STAGING_PROOF_DOCUMENT,
          { ...params, value: { enabled: false, proofAccountId } },
          context,
        ),
      ).rejects.toThrow("proof_pin_immutable");
    }
    await expect(
      f.policies.createPolicyDocument(
        stagingProofCreditPolicy,
        { ...params, value: { enabled: true, proofAccountId: "acc_other" } },
        context,
      ),
    ).rejects.toThrow("proof_pin_immutable");
    await expect(
      f.policies.createPolicyDocumentWithId(stagingProofCreditPolicy, "replacement", params, context),
    ).rejects.toThrow("proof_policy_replacement_refused");
    await expect(
      f.policies.revisePolicyDocument(
        stagingProofCreditPolicy,
        STAGING_PROOF_DOCUMENT,
        { ...params, value: { ...params.value, unexpected: true } },
        context,
      ),
    ).rejects.toThrow("proof_policy_invalid");
    expect((await f.policies.readPolicyDocumentState(STAGING_PROOF_DOCUMENT)).version).toBe(1);
  });
  it("disabled/expired/inactive/malformed/unavailable authority and halt fail closed; reads remain", async () => {
    const f = await setup();
    const receipt = await f.services.post({ targetAccountId: accountId, amount: "25.00" }, actor, context);
    for (const change of [
      { value: { ...params.value, enabled: false } },
      { effectiveUntil: "2026-02-01T00:00:00.000Z" },
      { status: "inactive" as const },
    ]) {
      await f.policies.revisePolicyDocument(
        stagingProofCreditPolicy,
        STAGING_PROOF_DOCUMENT,
        { ...params, ...change },
        context,
      );
      expect((await request(f.appFor())).status).toBe(409);
      expect(await f.services.receipt(accountId, actor)).toEqual(receipt);
    }
    await f.policies.revisePolicyDocument(stagingProofCreditPolicy, STAGING_PROOF_DOCUMENT, params, context);
    const resolve = vi.spyOn(f.policies, "resolvePolicy");
    resolve.mockRejectedValueOnce(new Error("synthetic private error"));
    const refused = await request(f.appFor());
    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain("synthetic private error");
    resolve.mockImplementation(
      async (definition) => ({ value: { ...(definition.defaultValue as object), haltNewActions: true } }) as never,
    );
    expect((await request(f.appFor())).status).toBe(409);
    resolve.mockRestore();
    const valid = await f.policies.readPolicyDocumentState(STAGING_PROOF_DOCUMENT);
    const read = vi.spyOn(f.policies, "readPolicyDocumentState");
    read.mockResolvedValueOnce({
      ...valid,
      state: { ...valid.state, value: { enabled: "yes", proofAccountId: accountId } },
    });
    expect((await request(f.appFor())).status).toBe(409);
    read.mockRejectedValueOnce(new Error("synthetic unavailable authority"));
    expect((await request(f.appFor())).status).toBe(409);
  });
  it("wrong Wallet currency refuses independently; negative balance and pending/holds are preserved", async () => {
    const wrong = await setup();
    await wrong.eventStore.appendToStream({
      streamId: `settlement.wallet-${accountId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "settlement.wallet.opened",
          payload: { accountId, currencyCode: "eur", openedAt: "2026-01-01T00:00:00.000Z" },
        },
      ],
    });
    await expect(wrong.services.post({ targetAccountId: accountId, amount: "25.00" }, actor, context)).rejects.toThrow(
      "proof_currency_mismatch",
    );
    const f = await setup();
    await f.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_negative",
        kind: "platform-purchase",
        direction: "debit",
        amount: "30.00",
        allowNegativeBalance: true,
      },
      context,
    );
    await f.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_pending",
        kind: "sale",
        direction: "credit",
        amount: "7.00",
        fundsStatus: "pending",
      },
      context,
    );
    await f.services.post({ targetAccountId: accountId, amount: "25.00" }, actor, context);
    expect(await f.wallets.loadWalletState(accountId)).toMatchObject({
      availableBalanceAmount: "-5.00",
      pendingBalanceAmount: "7.00",
      heldBalanceAmount: "0.00",
      negativeBalanceStatus: "negative",
    });
  });
  it("runbook-to-route and DB-profile discovery are explicit", () => {
    const runbook = readFileSync(new URL("../../../../../docs/runbooks/money-operations.md", import.meta.url), "utf8");
    for (const text of [
      "/api/settlement/wallet/staging-proof-credits",
      '"X-Chase-Sets-CSRF": "1"',
      'credentials: "same-origin"',
      "Wallet adjustment",
      "same verified AccountId",
    ])
      expect(runbook).toContain(text);
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const dbTest = "features/wallets/api/staging-proof-credit.db.test.ts";
    expect(pkg.scripts["test:db"].split(" ")).toContain(dbTest);
    expect(pkg.scripts["test:unit"]).toContain(`--exclude ${dbTest}`);
  });
});

describe("staging-proof-credit-replay", () => {
  it("duplicates, restart, changed operator/key, spend and disable/re-enable never replenish", async () => {
    const f = await setup();
    const input = { targetAccountId: accountId, amount: "25.00" };
    const receipts = await Promise.all(Array.from({ length: 4 }, () => f.services.post(input, actor, context)));
    expect(receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0]))).toBe(true);
    await f.wallets.postEntry(
      {
        accountId,
        ledgerEntryId: "led_synthetic_spend",
        kind: "platform-purchase",
        direction: "debit",
        amount: "25.00",
      },
      context,
    );
    await f.policies.revisePolicyDocument(
      stagingProofCreditPolicy,
      STAGING_PROOF_DOCUMENT,
      { ...params, value: { ...params.value, enabled: false } },
      context,
    );
    await f.policies.revisePolicyDocument(stagingProofCreditPolicy, STAGING_PROOF_DOCUMENT, params, context);
    const restarted = createStagingProofCreditRuntime({
      eventStore: f.eventStore,
      policies: f.policies,
      deploymentEnvironment: "staging",
    });
    const other = { ...actor, userId: "usr_other" };
    expect(
      await restarted.post(input, other, { ...context, audit: { ...context.audit, performedByUserId: "usr_other" } }),
    ).toEqual(receipts[0]);
    expect((await request(f.appFor(), input, { "Idempotency-Key": "changed-key" })).status).toBe(200);
    await expect(restarted.post({ ...input, amount: "24.00" }, actor, context)).rejects.toThrow(
      "proof_amount_conflict",
    );
    expect((await f.wallets.loadWalletState(accountId)).availableBalanceAmount).toBe("0.00");
    expect(f.allEvents.filter((e) => e.eventType === "settlement.wallet.staging-proof-credit-posted")).toHaveLength(1);
  });
  it("failed append leaves unopened Wallet untouched; partial/mismatched history refuses", async () => {
    const f = await setup();
    const failStore: EventStore = {
      ...f.eventStore,
      appendToStreams: async () => {
        throw new Error("synthetic append failure");
      },
    };
    const fail = createStagingProofCreditRuntime({
      eventStore: failStore,
      policies: f.policies,
      deploymentEnvironment: "staging",
    });
    await expect(fail.post({ targetAccountId: accountId, amount: "25.00" }, actor, context)).rejects.toThrow(
      "synthetic append failure",
    );
    expect((await f.wallets.loadWalletState(accountId)).accountId).toBeNull();
    await f.wallets.postEntry(
      { accountId, ledgerEntryId: proofLedgerId(accountId), kind: "adjustment", direction: "credit", amount: "25.00" },
      context,
    );
    await expect(f.services.post({ targetAccountId: accountId, amount: "25.00" }, actor, context)).rejects.toThrow(
      "proof_history_invalid",
    );
    await expect(f.services.receipt(accountId, actor)).rejects.toThrow("proof_history_invalid");
  });
});
