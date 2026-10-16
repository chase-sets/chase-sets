import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresAgentGrantConsentDirectory,
  createPostgresAgentGrantSpendPolicy,
  platformAgentGuardrailsSchemaSql,
  type AgentSpendingMandate,
} from "./agent-guardrails";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;

const AUTONOMOUS_MANDATE: AgentSpendingMandate = {
  maxPerOrderCents: null,
  dailyCapCents: 5_000,
  monthlyCapCents: null,
  humanPresentRequired: false,
  allowedRails: ["stored-pm"],
};

const completionContext = {
  rail: "stored-pm" as const,
  humanPresent: false,
  humanNotPresentAuthorized: true,
};

describe("agent grant spending mandate Postgres enforcement", () => {
  let pools: Readonly<Record<"platform", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for agent-guardrails DB tests.");
    }

    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["platform"], "agent_guardrails");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.platform.query(platformAgentGuardrailsSchemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("blocks a $60 completion against a $50 daily cap and names the cap", async () => {
    const policy = createPostgresAgentGrantSpendPolicy(pools.platform, {
      mandateResolver: () => AUTONOMOUS_MANDATE,
    });

    const decision = await policy.authorize({
      grantId: "lpa_1",
      accountId: "acc_1",
      operation: "complete_checkout",
      operationId: "op_60",
      amountCents: 6_000,
      ...completionContext,
    });

    expect(decision).toMatchObject({ allowed: false, limitKind: "daily-cap", capCents: 5_000 });
    if (!decision.allowed) {
      expect(decision.reason).toContain("$50.00 daily limit");
    }
  });

  it("prevents two concurrent completions from jointly exceeding the cap (single-flight)", async () => {
    const policy = createPostgresAgentGrantSpendPolicy(pools.platform, {
      mandateResolver: () => AUTONOMOUS_MANDATE,
    });

    const [first, second] = await Promise.all([
      policy.authorize({
        grantId: "lpa_race",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_race_a",
        amountCents: 3_000,
        ...completionContext,
      }),
      policy.authorize({
        grantId: "lpa_race",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_race_b",
        amountCents: 3_000,
        ...completionContext,
      }),
    ]);

    const allowed = [first, second].filter((decision) => decision.allowed);
    const denied = [first, second].filter((decision) => !decision.allowed);
    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ allowed: false, limitKind: "daily-cap" });

    // Exactly one authorization was recorded — the two completions cannot both count.
    const recorded = await pools.platform.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM platform_agent_grant_spend_authorizations WHERE grant_id = $1`,
      ["lpa_race"],
    );
    expect(recorded.rows[0]?.count).toBe("1");
  });

  it("resets the counter as prior authorizations age out of the rolling window", async () => {
    let current = new Date("2026-07-08T00:00:00.000Z");
    const policy = createPostgresAgentGrantSpendPolicy(pools.platform, {
      now: () => current,
      mandateResolver: () => AUTONOMOUS_MANDATE,
    });

    expect(
      await policy.authorize({
        grantId: "lpa_reset",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_day1",
        amountCents: 4_000,
        ...completionContext,
      }),
    ).toEqual({ allowed: true });

    // A second $40 purchase the same day exhausts the $50 cap.
    expect(
      await policy.authorize({
        grantId: "lpa_reset",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_day1_again",
        amountCents: 4_000,
        ...completionContext,
      }),
    ).toMatchObject({ allowed: false, limitKind: "daily-cap" });

    // A day later the earlier authorization has aged out and the budget is available again.
    current = new Date("2026-07-09T01:00:00.000Z");
    expect(
      await policy.authorize({
        grantId: "lpa_reset",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_day2",
        amountCents: 4_000,
        ...completionContext,
      }),
    ).toEqual({ allowed: true });
  });

  it("stores and resolves a per-grant mandate, and reports spend summaries", async () => {
    const directory = createPostgresAgentGrantConsentDirectory(pools.platform);

    // Defaults to the conservative handoff-only mandate before any opt-in.
    expect(await directory.resolveMandate("lpa_dir")).toMatchObject({
      humanPresentRequired: true,
      allowedRails: ["handoff-only"],
    });

    await directory.setMandate({
      grantId: "lpa_dir",
      accountId: "acc_1",
      mandate: AUTONOMOUS_MANDATE,
    });
    expect(await directory.resolveMandate("lpa_dir")).toMatchObject({
      dailyCapCents: 5_000,
      humanPresentRequired: false,
      allowedRails: ["stored-pm"],
    });

    const policy = createPostgresAgentGrantSpendPolicy(pools.platform, {
      mandateResolver: directory.resolveMandate,
    });
    await policy.authorize({
      grantId: "lpa_dir",
      accountId: "acc_1",
      operation: "complete_checkout",
      operationId: "op_dir",
      amountCents: 2_500,
      ...completionContext,
    });

    const summary = await directory.getSpendSummary("lpa_dir");
    expect(summary).toEqual({ dailyCents: 2_500, monthlyCents: 2_500 });
  });

  it("reads retired rails as absent", async () => {
    const directory = createPostgresAgentGrantConsentDirectory(pools.platform);
    // Rows written while ap2 was a grant rail keep their stored value; authority only narrows on read.
    for (const [grantId, storedRails] of [
      ["lpa_mixed", ["stored-pm", "ap2"]],
      ["lpa_retired", ["ap2"]],
    ] as const) {
      await pools.platform.query(
        `INSERT INTO platform_agent_grant_spending_mandates (grant_id, account_id, human_present_required, allowed_rails)
         VALUES ($1, $2, false, $3::jsonb)`,
        [grantId, "acc_1", JSON.stringify(storedRails)],
      );
    }

    expect(await directory.resolveMandate("lpa_mixed")).toMatchObject({
      humanPresentRequired: false,
      allowedRails: ["stored-pm"],
    });
    expect(await directory.resolveMandate("lpa_retired")).toMatchObject({
      humanPresentRequired: false,
      allowedRails: ["handoff-only"],
    });
  });
});
