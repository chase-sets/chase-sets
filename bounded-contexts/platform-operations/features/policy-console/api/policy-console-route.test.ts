import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { PlatformOperationsApiEnv } from "../../../api";
import { COMMERCIAL_TERMS_SCHEDULES_HREF, createPolicyConsoleRoutes } from "./policy-console-route";
import type { PolicyConsoleEntry } from "./contracts";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

const testPolicy = definePolicy<{ maxDays: number }>({
  policyKey: "settlement.clearance-window",
  contextName: "settlement",
  schemaSummary: "{ maxDays: integer }",
  defaultValue: { maxDays: 2 },
  decodeValue: (raw) => {
    const record = raw as Readonly<{ maxDays?: unknown }>;
    const maxDays = Number(record.maxDays);
    if (!Number.isInteger(maxDays) || maxDays < 0 || maxDays > 30) {
      throw new Error("maxDays must be an integer between 0 and 30.");
    }
    return { maxDays };
  },
});

function createQueryableDb(handlers: Readonly<{ registry?: unknown[]; active?: unknown[]; document?: unknown }>) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("DISTINCT ON (policy_key)")) {
        return { rows: handlers.registry ?? [] };
      }
      if (
        sql.includes("status = 'active'") &&
        sql.includes("ORDER BY effective_from DESC, updated_at DESC, document_id DESC")
      ) {
        return { rows: handlers.active ?? [] };
      }
      if (sql.includes("WHERE document_id = $1")) {
        return { rows: handlers.document ? [handlers.document] : [] };
      }
      if (sql.includes("FROM platform_policy_document_history")) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function createApp(entries: readonly PolicyConsoleEntry[], permissions: readonly string[]) {
  const app = new Hono<PlatformOperationsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey: "platform-admin",
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createPolicyConsoleRoutes(entries));
  return app;
}

type MockWritePortOverrides = Readonly<{
  createPolicyDocument?: ReturnType<typeof vi.fn>;
  revisePolicyDocument?: ReturnType<typeof vi.fn>;
  resolvePolicy?: ReturnType<typeof vi.fn>;
}>;

function buildEntry(
  overrides: Readonly<{ db?: ReturnType<typeof createQueryableDb>; write?: MockWritePortOverrides }> = {},
) {
  const db = overrides.db ?? createQueryableDb({});
  const write = {
    createPolicyDocument: vi.fn(),
    revisePolicyDocument: vi.fn(),
    resolvePolicy: vi.fn(async () => ({
      policyKey: testPolicy.policyKey,
      value: testPolicy.defaultValue,
      source: "fallback" as const,
      documentId: null,
      effectiveFrom: null,
      effectiveUntil: null,
      resolvedAt: new Date().toISOString(),
    })),
    ...overrides.write,
  };

  return {
    policyKey: testPolicy.policyKey,
    contextName: "settlement",
    db,
    definition: testPolicy,
    write,
  } as unknown as PolicyConsoleEntry;
}

describe("policy console routes", () => {
  it("requires view permission to list the registry", async () => {
    const app = createApp([buildEntry()], []);
    const response = await app.request("/");
    expect(response.status).toBe(403);
  });

  it("lists policies grouped by context, filling in fallback status when no document exists", async () => {
    const entry = buildEntry();
    const app = createApp([entry], ["platform-policy.view"]);

    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[]; commercialTermsSchedulesHref: string };
    expect(body.commercialTermsSchedulesHref).toBe(COMMERCIAL_TERMS_SCHEDULES_HREF);
    expect(body.items).toEqual([
      expect.objectContaining({
        policyKey: "settlement.clearance-window",
        status: "fallback",
        contextName: "settlement",
      }),
    ]);
  });

  it("excludes registry rows for policy keys the console does not declare", async () => {
    const db = createQueryableDb({
      registry: [
        {
          policy_key: "settlement.clearance-window",
          context_name: "settlement",
          schema_summary: "test",
          status: "active",
          value: { maxDays: 3 },
          effective_from: "2026-05-01T00:00:00.000Z",
          effective_until: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
        {
          policy_key: "commercial-terms.schedule.personal",
          context_name: "commercial-terms",
          schema_summary: "test",
          status: "active",
          value: {},
          effective_from: "2026-05-01T00:00:00.000Z",
          effective_until: null,
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const entry = buildEntry({ db });
    const app = createApp([entry], ["platform-policy.view"]);

    const response = await app.request("/");
    const body = (await response.json()) as { items: readonly { policyKey: string }[] };
    expect(body.items.map((item) => item.policyKey)).toEqual(["settlement.clearance-window"]);
  });

  it("lists each stored row with its own entry's current schema summary and its stored value unchanged", async () => {
    const payoutBoundsPolicy = definePolicy<{ maximumAmount: string }>({
      policyKey: "settlement.payout-bounds",
      contextName: "settlement",
      schemaSummary: "{ maximumAmount: decimal string }",
      defaultValue: { maximumAmount: "10000.00" },
      decodeValue: (raw) => raw as { maximumAmount: string },
    });
    const storedRow = {
      context_name: "settlement",
      status: "active",
      effective_from: "2026-05-01T00:00:00.000Z",
      effective_until: null,
      updated_at: "2026-05-01T00:00:00.000Z",
    };
    const db = createQueryableDb({
      registry: [
        {
          ...storedRow,
          policy_key: testPolicy.policyKey,
          schema_summary: "{ maxDays: integer, retiredDays: integer }",
          value: { maxDays: 3, retiredDays: 30 },
        },
        {
          ...storedRow,
          policy_key: payoutBoundsPolicy.policyKey,
          schema_summary: "{ maximumAmount: decimal string, retiredAmount: decimal string }",
          value: { maximumAmount: "5000.00", retiredAmount: "1.00" },
        },
      ],
    });
    const entry = buildEntry({ db });
    const payoutBoundsEntry = {
      ...entry,
      policyKey: payoutBoundsPolicy.policyKey,
      definition: payoutBoundsPolicy,
    } as unknown as PolicyConsoleEntry;
    const app = createApp([entry, payoutBoundsEntry], ["platform-policy.view"]);

    const response = await app.request("/");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      expect.objectContaining({
        policyKey: testPolicy.policyKey,
        schemaSummary: "{ maxDays: integer }",
        status: "active",
        value: { maxDays: 3, retiredDays: 30 },
      }),
      expect.objectContaining({
        policyKey: payoutBoundsPolicy.policyKey,
        schemaSummary: "{ maximumAmount: decimal string }",
        status: "active",
        value: { maximumAmount: "5000.00", retiredAmount: "1.00" },
      }),
    ]);
  });

  it("returns the current and upcoming windows for a policy overview", async () => {
    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();
    const db = createQueryableDb({
      active: [
        {
          document_id: "pol_current",
          policy_key: testPolicy.policyKey,
          status: "active",
          value: { maxDays: 2 },
          effective_from: "2026-01-01T00:00:00.000Z",
          effective_until: futureIso,
        },
        {
          document_id: "pol_upcoming",
          policy_key: testPolicy.policyKey,
          status: "active",
          value: { maxDays: 5 },
          effective_from: futureIso,
          effective_until: null,
        },
      ],
    });
    const entry = buildEntry({ db });
    const app = createApp([entry], ["platform-policy.view"]);

    const response = await app.request(`/${testPolicy.policyKey}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      current: { documentId: string | null };
      upcoming: readonly { documentId: string }[];
    };
    expect(body.current.documentId).toBe("pol_current");
    expect(body.upcoming).toEqual([expect.objectContaining({ documentId: "pol_upcoming" })]);
    void nowIso;
  });

  it("uses database timestamp values to select the current window and exclude an expired window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T06:00:00.000Z"));
    try {
      const db = createQueryableDb({
        active: [
          {
            document_id: "pol_upcoming",
            policy_key: testPolicy.policyKey,
            status: "active",
            value: { maxDays: 5 },
            effective_from: new Date("2026-09-12T00:00:00.000Z"),
            effective_until: null,
          },
          {
            document_id: "pol_current",
            policy_key: testPolicy.policyKey,
            status: "active",
            value: { maxDays: 2 },
            effective_from: new Date("2026-09-01T00:00:00.000Z"),
            effective_until: null,
          },
          {
            document_id: "pol_expired",
            policy_key: testPolicy.policyKey,
            status: "active",
            value: { maxDays: 1 },
            effective_from: new Date("2026-08-01T00:00:00.000Z"),
            effective_until: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
      });
      const app = createApp([buildEntry({ db })], ["platform-policy.view"]);

      const response = await app.request(`/${testPolicy.policyKey}`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        current: { source: "policy", documentId: "pol_current", value: { maxDays: 2 } },
        upcoming: [{ documentId: "pol_upcoming", value: { maxDays: 5 } }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("404s for an unknown policy key", async () => {
    const app = createApp([buildEntry()], ["platform-policy.view"]);
    const response = await app.request("/not-a-real-policy");
    expect(response.status).toBe(404);
  });

  it("requires manage permission to create a revision", async () => {
    const app = createApp([buildEntry()], ["platform-policy.view"]);
    const response = await app.request(`/${testPolicy.policyKey}/revisions`, {
      method: "POST",
      body: JSON.stringify({ value: { maxDays: 3 }, status: "active", effectiveFrom: new Date().toISOString() }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(403);
  });

  it("creates an immediate revision when no document is currently active", async () => {
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_1", version: 1 }));
    const entry = buildEntry({ write: { createPolicyDocument } });
    const app = createApp([entry], ["platform-policy.manage"]);

    const response = await app.request(`/${testPolicy.policyKey}/revisions`, {
      method: "POST",
      body: JSON.stringify({ value: { maxDays: 3 }, status: "active", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_1", version: 1, scheduled: false });
    expect(createPolicyDocument).toHaveBeenCalledWith(
      testPolicy,
      expect.objectContaining({ value: { maxDays: 3 }, actorUserId: "usr_admin" }),
      context,
    );
  });

  it("revises the currently active document in place for an immediate revision", async () => {
    const resolvePolicy = vi.fn(async () => ({
      policyKey: testPolicy.policyKey,
      value: { maxDays: 2 },
      source: "policy" as const,
      documentId: "pol_current",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: new Date().toISOString(),
    }));
    const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_current", version: 2 }));
    const entry = buildEntry({ write: { resolvePolicy, revisePolicyDocument } });
    const app = createApp([entry], ["platform-policy.manage"]);

    const response = await app.request(`/${testPolicy.policyKey}/revisions`, {
      method: "POST",
      body: JSON.stringify({ value: { maxDays: 4 }, status: "active", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_current", version: 2, scheduled: false });
    expect(revisePolicyDocument).toHaveBeenCalledTimes(1);
    expect(revisePolicyDocument).toHaveBeenCalledWith(
      testPolicy,
      "pol_current",
      expect.objectContaining({ value: { maxDays: 4 } }),
      context,
    );
  });

  it("closes the current document and creates a new one when scheduling a future revision", async () => {
    const futureIso = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const resolvePolicy = vi.fn(async () => ({
      policyKey: testPolicy.policyKey,
      value: { maxDays: 2 },
      source: "policy" as const,
      documentId: "pol_current",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: new Date().toISOString(),
    }));
    const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_current", version: 2 }));
    const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_scheduled", version: 1 }));
    const entry = buildEntry({ write: { resolvePolicy, revisePolicyDocument, createPolicyDocument } });
    const app = createApp([entry], ["platform-policy.manage"]);

    const response = await app.request(`/${testPolicy.policyKey}/revisions`, {
      method: "POST",
      body: JSON.stringify({ value: { maxDays: 6 }, status: "active", effectiveFrom: futureIso }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "pol_scheduled", version: 1, scheduled: true });
    expect(revisePolicyDocument).toHaveBeenCalledWith(
      testPolicy,
      "pol_current",
      expect.objectContaining({
        value: { maxDays: 2 },
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: futureIso,
      }),
      context,
    );
    expect(createPolicyDocument).toHaveBeenCalledWith(
      testPolicy,
      expect.objectContaining({ value: { maxDays: 6 }, effectiveFrom: futureIso }),
      context,
    );
  });

  it("surfaces a bounds violation from decodeValue as a 400", async () => {
    const revisePolicyDocument = vi.fn(async () => {
      throw new Error("maxDays must be an integer between 0 and 30.");
    });
    const resolvePolicy = vi.fn(async () => ({
      policyKey: testPolicy.policyKey,
      value: { maxDays: 2 },
      source: "policy" as const,
      documentId: "pol_current",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: new Date().toISOString(),
    }));
    const entry = buildEntry({ write: { resolvePolicy, revisePolicyDocument } });
    const app = createApp([entry], ["platform-policy.manage"]);

    const response = await app.request(`/${testPolicy.policyKey}/revisions`, {
      method: "POST",
      body: JSON.stringify({ value: { maxDays: 999 }, status: "active", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toContain("between 0 and 30");
  });

  describe("a refused future-dated revision", () => {
    const currentPolicy = () =>
      vi.fn(async () => ({
        policyKey: testPolicy.policyKey,
        value: { maxDays: 2 },
        source: "policy" as const,
        documentId: "pol_current",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        resolvedAt: new Date().toISOString(),
      }));

    async function postFuture(entry: PolicyConsoleEntry, value: unknown) {
      const app = createApp([entry], ["platform-policy.manage"]);
      return app.request(`/${testPolicy.policyKey}/revisions`, {
        method: "POST",
        body: JSON.stringify({
          value,
          status: "active",
          effectiveFrom: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        }),
        headers: { "Content-Type": "application/json" },
      });
    }

    it("leaves the current window open when the value is outside the policy's bounds", async () => {
      const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_current", version: 2 }));
      const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_scheduled", version: 1 }));
      const entry = buildEntry({
        write: { resolvePolicy: currentPolicy(), revisePolicyDocument, createPolicyDocument },
      });

      const response = await postFuture(entry, { maxDays: 999 });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("between 0 and 30");
      expect(revisePolicyDocument).not.toHaveBeenCalled();
      expect(createPolicyDocument).not.toHaveBeenCalled();
    });

    it("leaves the current window open when another active document covers the scheduled window", async () => {
      const db = createQueryableDb({});
      const baseQuery = db.query.getMockImplementation()!;
      db.query.mockImplementation(async (sql: string, values?: unknown) => {
        if (/^\s*SELECT document_id\s+FROM platform_policy_documents/.test(sql)) {
          expect(values).toContain("pol_current");
          return { rows: [{ document_id: "pol_other" }] };
        }
        return baseQuery(sql);
      });
      const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_current", version: 2 }));
      const createPolicyDocument = vi.fn(async () => ({ documentId: "pol_scheduled", version: 1 }));
      const entry = buildEntry({
        db,
        write: { resolvePolicy: currentPolicy(), revisePolicyDocument, createPolicyDocument },
      });

      const response = await postFuture(entry, { maxDays: 6 });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("pol_other");
      expect(revisePolicyDocument).not.toHaveBeenCalled();
      expect(createPolicyDocument).not.toHaveBeenCalled();
    });

    it("restores the current window when the scheduled document cannot be created after the close", async () => {
      const revisePolicyDocument = vi.fn(async () => ({ documentId: "pol_current", version: 2 }));
      const createPolicyDocument = vi.fn(async () => {
        throw new Error("Active policy document pol_raced already covers policy for that effective window.");
      });
      const entry = buildEntry({
        write: { resolvePolicy: currentPolicy(), revisePolicyDocument, createPolicyDocument },
      });

      const response = await postFuture(entry, { maxDays: 6 });

      expect(response.status).toBe(400);
      expect(revisePolicyDocument).toHaveBeenCalledTimes(2);
      expect(revisePolicyDocument).toHaveBeenLastCalledWith(
        testPolicy,
        "pol_current",
        expect.objectContaining({
          value: { maxDays: 2 },
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveUntil: null,
        }),
        context,
      );
    });
  });
});
