import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { parseIdentityAccountProfileReportSubmittedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { IdentityApiEnv } from "../../../api";
import type { IdentityMutationPersistence, IdentityMutationTransaction } from "../../account-management/api/fences";
import { accountProfileReportRoutes } from "./route";
import { createAccountProfileReportRuntime } from "./runtime";

const reporter = createId("acc");
const active = createId("acc");
const suspended = createId("acc");
const closed = createId("acc");
const details = "account-profile-marker-scan private report detail";
const context: EventStoreContext = {
  tenantId: createId("tnt"),
  audit: { performedByUserId: createId("usr"), forAccountId: reporter },
};

function fixture() {
  const attempts = new Map<string, string>();
  const reports = new Set<string>();
  const eligibleAccounts = new Set([`identity.account-${active}`]);
  const append = vi.fn<IdentityMutationTransaction["append"]>(async (inputs) => {
    for (const input of inputs) reports.add(input.streamId);
    return [];
  });
  const query = vi.fn(async (sql: string, params: readonly string[]) => {
    if (sql.includes("INSERT INTO identity_account_profile_report_attempts")) {
      if (attempts.has(params[0])) return { rows: [] };
      attempts.set(params[0], params[1]);
      return { rows: [{ attempt_key: params[0] }] };
    }
    if (sql.includes("SELECT request_digest")) return { rows: [{ request_digest: attempts.get(params[0]) }] };
    if (!sql.includes("event_store_events")) throw new Error("Unexpected test query");
    return { rows: [{ eligible: !reports.has(params[0]) && eligibleAccounts.has(params[1]) }] };
  });
  const persistence: Pick<IdentityMutationPersistence, "transaction"> = {
    transaction: async (_scopes, work) =>
      work({ db: { query } as never, read: async () => [], append, projectionPredicate: async () => [] }),
  };
  const app = new Hono<IdentityApiEnv>();
  app.use("*", async (c, next) => {
    if (c.req.header("authorization") === "test") {
      c.set("actor", {
        sessionId: "test",
        tenantId: context.tenantId,
        accountId: reporter,
        userId: context.audit.performedByUserId,
        membershipId: "test",
        roleKey: "viewer",
        permissions: [],
      });
      c.set("context", context);
    }
    await next();
  });
  app.route("/accounts", accountProfileReportRoutes(createAccountProfileReportRuntime(persistence)));
  function submit(target: string, body: unknown, authenticated = true) {
    return app.request(`/accounts/${target}/profile-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authenticated ? { authorization: "test" } : {}) },
      body: JSON.stringify(body),
    });
  }
  return { query, submit, append, eligibleAccounts };
}

afterEach(() => vi.restoreAllMocks());

describe("Account Profile Reports", () => {
  it("appends one frozen fact and returns identical results for replay, duplicate and every ineligible target", async () => {
    const f = fixture();
    const body = { attemptId: randomUUID(), reason: "other", details };
    const first = await f.submit(active, body);
    expect(first.status).toBe(202);
    const response = await first.json();
    expect(response).toEqual({ status: "received" });
    for (const attempt of [
      f.submit(active, body),
      ...[active, reporter, createId("acc"), suspended, closed, "unknown"].map((target) =>
        f.submit(target, { ...body, attemptId: randomUUID() }),
      ),
    ]) {
      const result = await attempt;
      expect(result.status).toBe(202);
      expect(await result.json()).toEqual(response);
    }
    expect(f.append).toHaveBeenCalledTimes(1);
    const [batch] = f.append.mock.calls[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].expectedVersion).toBe("no_stream");
    expect(batch[0].streamId).not.toContain(reporter);
    expect(batch[0].events).toHaveLength(1);
    const fact = batch[0].events[0];
    expect(fact.eventType).toBe("identity.account-profile.report-submitted");
    expect(parseIdentityAccountProfileReportSubmittedPayload(fact.payload)).toEqual({
      version: 1,
      reportId: expect.stringMatching(/^rpt_/),
      targetType: "account-profile",
      targetId: active,
      reporterAccountId: reporter,
      reason: "other",
      details,
      submittedAt: expect.any(String),
    });
  });

  it("binds a previously ignored attempt even if the target becomes eligible, and conflicts on a different body or target", async () => {
    const f = fixture();
    const body = { attemptId: randomUUID(), reason: "other", details };
    const first = await f.submit(suspended, body);
    f.eligibleAccounts.add(`identity.account-${suspended}`);
    expect(await (await f.submit(suspended, body)).json()).toEqual(await first.json());
    expect(f.append).not.toHaveBeenCalled();
    for (const response of [
      await f.submit(suspended, { ...body, reason: "personal-information" }),
      await f.submit(suspended, { ...body, details: "different details" }),
      await f.submit(active, body),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "attempt_conflict" } });
    }
    expect(f.append).not.toHaveBeenCalled();
  });

  it("refuses unauthenticated and non-closed requests, without querying persistence", async () => {
    const f = fixture();
    const body = { attemptId: randomUUID(), reason: "other", details };
    expect((await f.submit(active, body, false)).status).toBe(401);
    for (const invalid of [
      null,
      { ...body, reason: "unknown" },
      { ...body, attemptId: "" },
      { ...body, details: "x".repeat(1001) },
      { ...body, details: "\u0000" },
      { ...body, details: "\uD800" },
      { ...body, details: { text: details } },
      { ...body, reporterAccountId: reporter },
      { ...body, ["__proto__"]: {} },
    ]) {
      const response = await f.submit(active, invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_profile_report" } });
    }
    expect(f.query).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });

  it("account-profile-marker-scan: does not echo or log private payload or reporter when storage fails", async () => {
    const f = fixture();
    const consoles = ["log", "info", "warn", "error"].map((level) =>
      vi.spyOn(console, level as "log").mockImplementation(() => {}),
    );
    f.append.mockRejectedValueOnce(new Error(`${details} ${reporter}`));
    const response = await f.submit(active, { attemptId: randomUUID(), reason: "other", details });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "profile_report_unavailable" } });
    const publicOutput = JSON.stringify([body, [...response.headers], consoles.flatMap((spy) => spy.mock.calls)]);
    expect(publicOutput).not.toContain("account-profile-marker-scan");
    expect(publicOutput).not.toContain(reporter);
    expect(f.query.mock.calls.flatMap(([, values]) => values)).not.toContain(details);
  });
});
