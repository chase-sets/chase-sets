// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { module as platformOperationsModule } from "../../../index";
import { createSupportRequestRuntime } from "./runtime";
import { buildSupportApi, type SupportApiEnv } from "./http";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { createEvidenceAccessAudit, EVIDENCE_ACCESS_EVENT, parseEvidenceAccessAttempt } from "./evidence-access-audit";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Support evidence access audit tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
const actor = evidenceActor("viewer", ["support.view", "support.manage"], true);
const context: EventStoreContext = {
  tenantId: actor.tenantId as never,
  audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
};
const caseId = "sup_audit_case";
const auditStreamId = `support.evidence-access-${caseId}`;
const body = new Uint8Array([0xff, 0xd8, 0xff]);
const reference = `support-attachment:v1:sea_photo:${createHash("sha256").update(body).digest("hex")}:jpg`;
const marker = "PLANTED_PRIVATE_PROVIDER_FILENAME_KEY_URL_CREDENTIAL_EXCEPTION";

describeDb("durable evidence access authorization, not delivery", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let urls: ReturnType<typeof createMultiContextTestDatabaseUrls<(typeof contextNames)[number]>>;
  let pool: PgTransactionalPool;
  let eventStore: EventStore;
  beforeAll(async () => {
    urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "support_evidence_access_audit");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
    eventStore = createPostgresEventStore({ pool });
    await eventStore.appendToStream({
      streamId: `support.support-request-${caseId}`,
      expectedVersion: "any",
      context,
      events: [
        {
          eventType: "support.support-request.opened",
          payload: {
            supportRequestId: caseId,
            buyerAccountId: actor.accountId,
            sellerAccountId: "acc_seller",
            orderReturnContext: [],
          },
        },
        {
          eventType: "support.support-request.evidence-submitted",
          payload: { evidence: { attachments: [reference] } },
        },
      ],
    });
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function fixture(resolvedActor: ResolvedActor | null = actor, store = eventStore) {
    const storage = {
      putObject: vi.fn(),
      getObject: vi.fn(async () => ({ body, contentType: "image/jpeg" })),
      deleteObjects: vi.fn(),
    };
    const runtime = createSupportRequestRuntime({
      eventStore: store,
      db: pool,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      attachmentStorage: storage,
    });
    const app = new Hono<SupportApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", resolvedActor);
      if (resolvedActor) c.set("context", context);
      await next();
    });
    app.route("/", buildSupportApi(runtime));
    return { app, storage };
  }
  const download = `/support-requests/${caseId}/attachments/sea_photo`;
  async function attempts() {
    return readCompleteStream(eventStore, { streamId: auditStreamId });
  }

  it("allowed download commits exactly one authorization before GET and survives connection/runtime restart", async () => {
    const { app, storage } = fixture();
    storage.getObject.mockImplementationOnce(async () => {
      expect(await attempts()).toHaveLength(1);
      expect((await attempts())[0].payload).toMatchObject({
        decision: "allowed",
        action: "download",
        reason: "any-case-grant",
        assignmentId: "acap_current",
        assignmentVersion: 3,
      });
      return { body, contentType: "image/jpeg" };
    });
    const response = await app.request(download);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    await closeMultiContextTestPools(pools);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
    eventStore = createPostgresEventStore({ pool });
    expect(await attempts()).toHaveLength(1);
    expect(parseEvidenceAccessAttempt((await attempts())[0].payload).decision).toBe("allowed");
    expect((await fixture().app.request(download)).status).toBe(200);
    expect(await attempts()).toHaveLength(2);
  });

  it.each(["anonymous", "base-permission", "unrelated", "revoked"])(
    "%s denial is committed before response with zero provider calls and unparsed upload",
    async (principal) => {
      const resolved =
        principal === "anonymous"
          ? null
          : principal === "base-permission"
            ? evidenceActor("platform-admin", [], true)
            : evidenceActor("platform-admin", ["support.manage", "support.view"], false, "acc_unrelated");
      const { app, storage } = fixture(resolved);
      const request = new Request(`http://localhost/support-requests/${caseId}/attachments`, {
        method: "POST",
        body: marker,
      });
      const parse = vi.spyOn(request, "formData");
      const response = await app.request(request);
      expect(response.status).toBe(principal === "anonymous" ? 401 : principal === "base-permission" ? 403 : 404);
      expect(await attempts()).toHaveLength(1);
      expect((await attempts())[0].payload).toMatchObject({ decision: "denied" });
      expect(parse).not.toHaveBeenCalled();
      expect(storage.getObject).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
    },
  );

  it.each(["allowed", "denied"])(
    "%s audit append failure returns bounded 503, zero provider calls and no markers",
    async (decision) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const brokenStore = {
          ...eventStore,
          appendToStream: vi.fn(async () => {
            throw new Error(marker);
          }),
        };
        const { app, storage } = fixture(decision === "allowed" ? actor : null, brokenStore);
        const request = new Request(`http://localhost/support-requests/${caseId}/attachments`, {
          method: "POST",
          body: marker,
        });
        const parse = vi.spyOn(request, "formData");
        const response = await app.request(request);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain(marker);
        expect(parse).not.toHaveBeenCalled();
        expect(storage.getObject).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(await attempts()).toHaveLength(0);
        expect(JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])).not.toContain(marker);
      } finally {
        errorLog.mockRestore();
        warnLog.mockRestore();
      }
    },
  );

  it("provider failure retains authorization only and complete events/logs/responses exclude planted markers", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { app, storage } = fixture();
      storage.getObject.mockRejectedValueOnce(new Error(marker));
      const response = await app.request(download);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(marker);
      const events = await attempts();
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe(EVIDENCE_ACCESS_EVENT);
      expect(parseEvidenceAccessAttempt(events[0].payload)).toMatchObject({ decision: "allowed", action: "download" });
      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])).not.toContain(marker);
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it("verification failure releases no bytes despite an allowed attempt", async () => {
    const { app, storage } = fixture();
    storage.getObject.mockResolvedValueOnce({ body: new Uint8Array([0]), contentType: "image/jpeg" });
    expect((await app.request(download)).status).toBe(404);
    expect(await attempts()).toHaveLength(1);
  });

  it("audit read appends one nonrecursive attempt and exposes explicit 50-record cursor pages", async () => {
    const audit = createEvidenceAccessAudit(eventStore, () => "2026-10-12T00:00:00.000Z");
    for (let index = 0; index < 51; index++)
      await audit.record(caseId, "download", actor, {
        decision: "allowed",
        reason: "participant",
        status: 200,
        participation: "buyer",
        assignment: null,
      });
    const { app, storage } = fixture();
    const first = await app.request(`/support-requests/ops/${caseId}/attachments/access-audit`);
    const page = await first.json();
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe("51");
    expect(await attempts()).toHaveLength(52);
    const second = await app.request(
      `/support-requests/ops/${caseId}/attachments/access-audit?cursor=${page.nextCursor}`,
    );
    const tail = await second.json();
    expect(tail.items).toHaveLength(3);
    expect(tail.nextCursor).toBeNull();
    expect(await attempts()).toHaveLength(53);
    expect((await attempts()).filter((event) => event.payload.action === "audit-read")).toHaveLength(2);
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it("anonymous malformed case ids return non-disclosing 404 without audit or storage", async () => {
    const { app, storage } = fixture(null);
    expect((await app.request("/support-requests/not-a-case/attachments/sea_photo")).status).toBe(404);
    expect(await attempts()).toHaveLength(0);
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});
