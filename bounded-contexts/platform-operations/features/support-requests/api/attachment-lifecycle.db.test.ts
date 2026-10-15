// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import {
  attachmentOperationStreamId,
  createAttachmentManifest,
  decideAttachmentOperation,
  replayAttachmentOperation,
  type AttachmentOperationEvent,
} from "../domain/attachment-operation";
import { createSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
import {
  createSupportAttachmentReferenceLifecycle,
  createSupportRequestRuntime,
  type SupportRequestServices,
} from "./runtime";
import { buildSupportEvidenceCleanupLocatorHandlers } from "../read-model/cleanup-locator";
import {
  createSupportEvidenceCleanupRunner,
  parseSupportEvidenceCleanupBinding,
  requestSupportAttachmentCleanup,
  type SupportEvidenceCleanupStorage,
} from "./attachment-cleanup";
import { attachmentStorageKey, storeSupportEvidenceAttachments } from "./attachments";
import { createEvidenceAccessAudit } from "./evidence-access-audit";
import { decideSupportRequest, initialSupportRequestState } from "../domain/domain";
import { hashParticipantRequest } from "../domain/participant-attempt";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for attachment lifecycle tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_owner" as never, forAccountId: "acc_owner" as never },
};
const owner = {
  tenantId: context.tenantId,
  accountId: context.audit.forAccountId,
  supportRequestId: "sup_case",
  operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const operationStream = attachmentOperationStreamId(owner);
const operationCodec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
const caseStream = `support.support-request-${owner.supportRequestId}`;
const manifest = createAttachmentManifest({
  owner,
  profile: "support-evidence-raster/v1",
  encoderFingerprint: {
    profile: "support-evidence-raster/v1",
    sharp: "test",
    libvips: "test",
    platform: "test",
    arch: "test",
    libc: "test",
  },
  images: ["a", "b"].map((hash) => ({ canonicalSha256: hash.repeat(64), contentType: "image/jpeg", byteSize: 10 })),
});
const attachments = manifest.items.map((item) =>
  createSupportEvidenceAttachmentReference({
    attachmentId: item.attachmentId,
    sha256: item.canonicalSha256,
    contentType: item.contentType,
  }),
);
const claim = {
  owner,
  evidenceId: "sev_case",
  attachments,
  submittedAt: "2026-10-13T12:00:00.000Z",
  expectedVersion: 3,
  caseVersion: 1,
};

describeDb("Support attachment reference fences on real PostgreSQL with legacy case audit tenants", () => {
  let pools: Readonly<Record<"platform-operations", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["platform-operations"],
      "support_attachment_lifecycle",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
    store = createPostgresEventStore({ pool });
    await store.appendToStream({
      streamId: caseStream,
      expectedVersion: "no_stream",
      context: { ...context, tenantId: "tnt_seed_development" },
      events: decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: owner.supportRequestId as never,
        orderId: "ord_case" as never,
        buyerAccountId: owner.accountId,
        sellerAccountId: "acc_seller" as never,
        openedByAccountId: owner.accountId,
        openedByRole: "buyer",
        flowType: "product-damaged",
        orderTotalAmount: "10.00",
        openedAt: claim.submittedAt,
      }).map((event) => ({ eventType: event.type, payload: event.data })),
    });
    await store.appendToStream({
      streamId: operationStream,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "support.attachment-operation.staged", payload: manifest },
        ...manifest.items.map((item) => ({
          eventType: "support.attachment-operation.stored",
          payload: { index: item.index },
        })),
      ],
    });
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  const lifecycle = () => createSupportAttachmentReferenceLifecycle(store);
  const runtime = (eventStore: EventStore) =>
    createSupportRequestRuntime({
      eventStore,
      db: pool,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    });
  const commandInput = {
    streamId: caseStream,
    context,
    command: {
      type: "SubmitSupportEvidence",
      evidenceId: claim.evidenceId,
      submittedByAccountId: owner.accountId,
      submittedByRole: "buyer",
      evidenceType: "photo",
      summary: "Evidence",
      submittedAt: claim.submittedAt,
      attachments,
      attachmentOperationId: owner.operationId,
    },
  } as const;
  const execute = async (eventStore: EventStore, path: "command" | "participant") => {
    const services = runtime(eventStore);
    if (path === "command") return services.commandHandler(commandInput);
    const body = {
      submittedByRole: "buyer",
      evidenceType: "photo",
      summary: "Evidence",
      attachments,
      attachmentOperationId: owner.operationId,
    };
    return services.executeParticipantAttempt(
      {
        actionKind: "submit-evidence",
        attempt: {
          attemptId: "9391_lifecycle_attempt_0123456789",
          requestHash: await hashParticipantRequest("submit-evidence", body),
        },
        targetId: owner.supportRequestId,
        accountId: owner.accountId,
        actor: {
          ...evidenceActor("owner", ["support.manage"], false, owner.accountId),
          userId: context.audit.performedByUserId,
        },
        body,
      },
      context,
    );
  };
  const caseAppend = (events: number) =>
    store.appendToStream({
      streamId: caseStream,
      expectedVersion: "any",
      context,
      events: Array.from({ length: events }, () => ({
        eventType: "support.support-request.test-barrier",
        payload: {},
      })),
    });
  const submit = (version: number) =>
    store.appendToStreams!([
      {
        streamId: caseStream,
        expectedVersion: "any",
        context,
        events: [
          {
            eventType: "support.support-request.evidence-submitted",
            payload: {
              supportRequestId: owner.supportRequestId,
              evidence: { evidenceId: claim.evidenceId, attachments },
            },
          },
        ],
      },
      { streamId: operationStream, expectedVersion: version, context, events: [] },
    ]);

  it.each(["command", "participant"] as const)(
    "%s: a concurrent case append conflicts with the claim (mutant: omit case guard)",
    async (path) => {
      const wrapped: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (
            inputs.some((input) =>
              input.events.some((event) => event.eventType === "support.attachment-operation.reference-claimed"),
            )
          )
            await caseAppend(1);
          return store.appendToStreams!(inputs);
        },
      };
      await expect(execute(wrapped, path)).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(await readCompleteStream(store, { streamId: operationStream })).toHaveLength(3);
      expect(await readCompleteStream(store, { streamId: caseStream })).toHaveLength(2);
    },
  );
  it.each(["command", "participant"] as const)(
    "%s: a delayed submission after release fails atomically (mutant: omit empty operation guard or serial fallback)",
    async (path) => {
      const wrapped: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (
            inputs.some((input) =>
              input.events.some((event) => event.eventType === "support.support-request.evidence-submitted"),
            )
          )
            await lifecycle().release({ owner, expectedVersion: 4 }, context);
          return store.appendToStreams!(inputs);
        },
        appendToStream: async (input) => {
          if (input.events.some((event) => event.eventType === "support.support-request.evidence-submitted"))
            await lifecycle().release({ owner, expectedVersion: 4 }, context);
          return store.appendToStream(input);
        },
      };
      await expect(execute(wrapped, path)).rejects.toMatchObject({
        code: path === "participant" ? "participant-concurrency-unknown" : "concurrency_conflict",
      });
      expect(await readCompleteStream(store, { streamId: caseStream })).toHaveLength(1);
    },
  );
  it.each([500, 501])(
    "release sees committed evidence at case event %i (mutant: first-page-only release)",
    async (length) => {
      await lifecycle().claim(claim, context);
      await caseAppend(length - 2);
      await submit(4);
      await expect(lifecycle().release({ owner, expectedVersion: 4 }, context)).rejects.toThrow(
        "attachment_reference_committed",
      );
      expect(await readCompleteStream(store, { streamId: caseStream })).toHaveLength(length);
    },
  );
  it("release's read horizon is guarded (mutant: read absence then unguarded release)", async () => {
    await lifecycle().claim(claim, context);
    const wrapped: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        await submit(4);
        return store.appendToStreams!(inputs);
      },
    };
    await expect(
      createSupportAttachmentReferenceLifecycle(wrapped).release({ owner, expectedVersion: 4 }, context),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await readCompleteStream(store, { streamId: operationStream })).toHaveLength(4);
  });
  it("put admission after claim rejects (mutant: allow claimed operation writes)", async () => {
    await lifecycle().claim(claim, context);
    const state = replayAttachmentOperation(
      (await readCompleteStream(store, { streamId: operationStream })).map(operationCodec.decode),
    );
    expect(() =>
      decideAttachmentOperation(state, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
    ).toThrow("operation-terminal");
  });
  it.each(["command", "participant"] as const)(
    "%s: confirmation recovers across restart and replay (mutant: confirmation only in upload process memory)",
    async (path) => {
      const interrupted: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (
            inputs.some((input) =>
              input.events.some((event) => event.eventType === "support.attachment-operation.referenced"),
            )
          )
            throw new Error("confirmation interrupted after evidence commit");
          return store.appendToStreams!(inputs);
        },
      };
      await expect(execute(interrupted, path)).rejects.toThrow("confirmation interrupted");
      await execute(createPostgresEventStore({ pool }), path);
      await execute(createPostgresEventStore({ pool }), path);
      const history = await readCompleteStream(store, { streamId: operationStream });
      expect(history.map((event) => event.eventType).slice(-2)).toEqual([
        "support.attachment-operation.reference-claimed",
        "support.attachment-operation.referenced",
      ]);
      expect(replayAttachmentOperation(history.map(operationCodec.decode)).status).toBe("referenced");
      expect(
        (await readCompleteStream(store, { streamId: caseStream })).filter(
          (event) => event.eventType === "support.support-request.evidence-submitted",
        ),
      ).toHaveLength(1);
    },
  );
});

describeDb("Support evidence cleanup claims on real PostgreSQL (AC-E1, AC-E2, AC-E4)", () => {
  let pools: Readonly<Record<"platform-operations", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let store: EventStore;
  const instance = '["support-deployment-instance/v1","test","release-a"]';
  const scope = { environment: "test", deploymentInstance: instance, implementationSha: "a".repeat(40) };
  const hour = 60 * 60 * 1000;
  const later = (ms: number) => new Date(Date.now() + ms);
  const keys = manifest.items.map((item) =>
    attachmentStorageKey(owner.supportRequestId, item.attachmentId, item.canonicalSha256, item.contentType),
  );
  const checkpointStore = { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} };
  type Available = Extract<SupportRequestServices["attachmentCleanup"], { kind: "available" }>;

  function bindingAt(revision: number, bindingId = "cleanup-a") {
    const binding = parseSupportEvidenceCleanupBinding(
      JSON.stringify({
        version: 1,
        environment: "test",
        deploymentInstance: instance,
        bindingId,
        revision,
        active: true,
      }),
      scope,
    );
    if (binding.kind !== "configured") throw new Error("synthetic binding must be configured");
    return binding;
  }
  function objectStore(initial: readonly string[] = keys) {
    const objects = new Set(initial);
    const storage = {
      deleteKeys: vi.fn(async (requested: readonly string[]) =>
        requested.map((key) => ({ key, status: objects.delete(key) ? ("deleted" as const) : ("absent" as const) })),
      ),
      verifyPrivate: vi.fn(async (key: string) =>
        objects.has(key) ? ({ status: "match" } as const) : ({ status: "absent" } as const),
      ),
    };
    return { objects, storage };
  }
  function cleanupRuntime(
    eventStore: EventStore,
    storage: SupportEvidenceCleanupStorage,
    revision = 1,
    bindingId?: string,
  ) {
    return createSupportRequestRuntime({
      eventStore,
      db: pool,
      checkpointStore,
      attachmentCleanup: { kind: "available", binding: bindingAt(revision, bindingId), storage },
    });
  }
  const cleanup = (runtime: SupportRequestServices) => runtime.attachmentCleanup as Available;
  const forcedRunner = (storage: SupportEvidenceCleanupStorage, streamOwner = owner) =>
    createSupportEvidenceCleanupRunner({
      eventStore: store,
      db: pool,
      capability: { kind: "available", binding: bindingAt(1), storage },
      audit: createEvidenceAccessAudit(store, () => new Date().toISOString()),
      // Mutant: a locator that authorizes would hand every operation to the runner.
      listCandidates: async () => [
        {
          streamId: attachmentOperationStreamId(streamOwner),
          supportRequestId: streamOwner.supportRequestId,
          operationId: streamOwner.operationId,
        },
      ],
    });
  async function project(streamIds: readonly string[] = [operationStream]) {
    const handlers = buildSupportEvidenceCleanupLocatorHandlers(pool, store);
    for (const streamId of streamIds)
      for (const event of await readCompleteStream(store, { streamId }))
        await handlers[event.eventType]!(toTransportEvent(event));
  }
  const locators = async () =>
    (
      await pool.query<{ operation_stream_id: string; state: string; stream_version: number }>(
        "SELECT operation_stream_id, state, stream_version FROM support_evidence_cleanup_locators ORDER BY 1",
      )
    ).rows;
  const operationTypes = async (streamId = operationStream) =>
    (await readCompleteStream(store, { streamId })).map((event) =>
      event.eventType.replace("support.attachment-operation.", ""),
    );
  const requireCleanup = (operationId = owner.operationId) =>
    requestSupportAttachmentCleanup(store, {
      supportRequestId: owner.supportRequestId,
      operationId,
      performedByUserId: "usr_operator",
    });
  const caseLength = async () => (await readCompleteStream(store, { streamId: caseStream })).length;
  const caseAppend = (events: number) =>
    store.appendToStream({
      streamId: caseStream,
      expectedVersion: "any",
      context,
      events: Array.from({ length: events }, () => ({
        eventType: "support.support-request.test-barrier",
        payload: {},
      })),
    });
  const submitCommand = (eventStore: EventStore) =>
    createSupportRequestRuntime({ eventStore, db: pool, checkpointStore }).commandHandler({
      streamId: caseStream,
      context,
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: "sev_case",
        submittedByAccountId: owner.accountId,
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Evidence",
        submittedAt: "2026-10-13T12:00:00.000Z",
        attachments,
        attachmentOperationId: owner.operationId,
      },
    } as never);

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["platform-operations"],
      "support_evidence_cleanup",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
    store = createPostgresEventStore({ pool });
    await store.appendToStream({
      streamId: caseStream,
      expectedVersion: "no_stream",
      context: { ...context, tenantId: "tnt_seed_development" },
      events: decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: owner.supportRequestId as never,
        orderId: "ord_case" as never,
        buyerAccountId: owner.accountId,
        sellerAccountId: "acc_seller" as never,
        openedByAccountId: owner.accountId,
        openedByRole: "buyer",
        flowType: "product-damaged",
        orderTotalAmount: "10.00",
        openedAt: "2026-10-13T12:00:00.000Z",
      }).map((event) => ({ eventType: event.type, payload: event.data })),
    });
    await store.appendToStream({
      streamId: operationStream,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "support.attachment-operation.staged", payload: manifest },
        ...manifest.items.map((item) => ({
          eventType: "support.attachment-operation.stored",
          payload: { index: item.index },
        })),
      ],
    });
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  it("cleanup-then-claim: the claim deletes once and fences the later submission out (mutant: reference claim ignores cleanup)", async () => {
    await requireCleanup();
    await expect(submitCommand(store)).rejects.toThrow("attachment_reference_unknown");
    await project();
    const { objects, storage } = objectStore();
    const result = await cleanup(cleanupRuntime(store, storage)).run({ now: later(60_000) });
    expect(result).toMatchObject({ denied: null, claimed: 1, deleted: 1, failed: 0 });
    expect(storage.deleteKeys).toHaveBeenCalledTimes(1);
    expect(storage.deleteKeys).toHaveBeenCalledWith(keys);
    expect(objects.size).toBe(0);
    expect(await operationTypes()).toEqual([
      "staged",
      "stored",
      "stored",
      "cleanup-required",
      "cleanup-claimed",
      "deleted-unreferenced",
    ]);
    await expect(submitCommand(createPostgresEventStore({ pool }))).rejects.toThrow("attachment_reference_unknown");
    expect(await caseLength()).toBe(1);
  });

  it("claim-then-cleanup: a reference claim makes cleanup refuse and the runner never deletes (mutant: locator authorizes)", async () => {
    await submitCommand(store);
    await expect(requireCleanup()).rejects.toThrow("attachment_operation_referenced");
    await project();
    const { objects, storage } = objectStore();
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(48 * hour) })).toMatchObject({ examined: 0 });
    expect(await forcedRunner(storage).run({ now: later(48 * hour) })).toMatchObject({ referenced: 1, claimed: 0 });
    expect(storage.deleteKeys).not.toHaveBeenCalled();
    expect(objects.size).toBe(2);
    expect((await operationTypes()).at(-1)).toBe("referenced");
  });

  it.each(["command", "participant"] as const)(
    "%s: a delayed submission after release and cleanup fails its operation guard",
    async (path) => {
      const { objects, storage } = objectStore();
      const interleave = async () => {
        await createSupportAttachmentReferenceLifecycle(store).release({ owner, expectedVersion: 4 }, context);
        await requireCleanup();
        await project();
        expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(60_000) })).toMatchObject({ deleted: 1 });
      };
      const wrapped: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (inputs.some((input) => input.events.some((event) => event.eventType.endsWith(".evidence-submitted"))))
            await interleave();
          return store.appendToStreams!(inputs);
        },
      };
      const runtime = createSupportRequestRuntime({ eventStore: wrapped, db: pool, checkpointStore });
      const attempt =
        path === "command"
          ? submitCommand(wrapped)
          : runtime.executeParticipantAttempt(
              {
                actionKind: "submit-evidence",
                attempt: {
                  attemptId: "9392_delayed_attempt_0123456789",
                  requestHash: await hashParticipantRequest("submit-evidence", {
                    submittedByRole: "buyer",
                    evidenceType: "photo",
                    summary: "Evidence",
                    attachments,
                    attachmentOperationId: owner.operationId,
                  }),
                },
                targetId: owner.supportRequestId,
                accountId: owner.accountId,
                actor: {
                  ...evidenceActor("owner", ["support.manage"], false, owner.accountId),
                  userId: context.audit.performedByUserId,
                },
                body: {
                  submittedByRole: "buyer",
                  evidenceType: "photo",
                  summary: "Evidence",
                  attachments,
                  attachmentOperationId: owner.operationId,
                },
              },
              context,
            );
      await expect(attempt).rejects.toMatchObject({
        code: path === "participant" ? "participant-concurrency-unknown" : "concurrency_conflict",
      });
      expect(await caseLength()).toBe(1);
      expect(objects.size).toBe(0);
      expect((await operationTypes()).slice(3)).toEqual([
        "reference-claimed",
        "reference-claim-released",
        "cleanup-required",
        "cleanup-claimed",
        "deleted-unreferenced",
      ]);
    },
  );

  it("a concurrent case append conflicts with the cleanup claim before any delete (mutant: omit case guard)", async () => {
    await requireCleanup();
    await project();
    const { objects, storage } = objectStore();
    const wrapped: EventStore = {
      ...store,
      appendToStreams: async (inputs) => {
        if (inputs.some((input) => input.events.some((event) => event.eventType.endsWith(".cleanup-claimed"))))
          await caseAppend(1);
        return store.appendToStreams!(inputs);
      },
    };
    expect(await cleanup(cleanupRuntime(wrapped, storage)).run({ now: later(60_000) })).toMatchObject({
      conflicts: 1,
      claimed: 0,
    });
    expect(storage.deleteKeys).not.toHaveBeenCalled();
    expect(await operationTypes()).toHaveLength(4);
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(60_000) })).toMatchObject({ deleted: 1 });
    expect(objects.size).toBe(0);
  });

  it.each([500, 501])(
    "a case reference at event %i retains the bytes (mutant: first-page-only case read)",
    async (length) => {
      await requireCleanup();
      await caseAppend(length - 2);
      await store.appendToStream({
        streamId: caseStream,
        expectedVersion: "any",
        context,
        events: [
          {
            eventType: "support.support-request.evidence-submitted",
            payload: { supportRequestId: owner.supportRequestId, evidence: { evidenceId: "sev_legacy", attachments } },
          },
        ],
      });
      await project();
      const { objects, storage } = objectStore();
      expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(60_000) })).toMatchObject({
        referenced: 1,
        claimed: 0,
      });
      expect(storage.deleteKeys).not.toHaveBeenCalled();
      expect(objects.size).toBe(2);
      expect(await caseLength()).toBe(length);
      expect(await operationTypes()).toHaveLength(4);
    },
  );

  it("a malformed case history retains the bytes and leaves the rest of the run untouched", async () => {
    await requireCleanup();
    await store.appendToStream({
      streamId: caseStream,
      expectedVersion: "any",
      context,
      events: [
        {
          eventType: "support.support-request.evidence-submitted",
          payload: { supportRequestId: owner.supportRequestId, evidence: "PLANTED_MALFORMED" },
        },
      ],
    });
    await project();
    const { objects, storage } = objectStore();
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(60_000) })).toMatchObject({
      denied: null,
      invalid: 1,
      claimed: 0,
    });
    expect(storage.deleteKeys).not.toHaveBeenCalled();
    expect(objects.size).toBe(2);
    expect(await operationTypes()).toHaveLength(4);
  });

  it("referenced bytes survive resolve, close, cancel, replay, restart and the day after", async () => {
    await submitCommand(store);
    for (const fact of ["resolved", "closed", "cancelled"])
      await store.appendToStream({
        streamId: caseStream,
        expectedVersion: "any",
        context,
        events: [{ eventType: `support.support-request.test-${fact}`, payload: {} }],
      });
    const { objects, storage } = objectStore();
    await project();
    await pool.query("TRUNCATE support_evidence_cleanup_locators");
    await project();
    expect(await locators()).toEqual([
      { operation_stream_id: operationStream, state: "reference-held", stream_version: 5 },
    ]);
    store = createPostgresEventStore({ pool });
    for (const offset of [25 * hour, 48 * hour]) {
      expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(offset) })).toMatchObject({ examined: 0 });
      expect(await forcedRunner(storage).run({ now: later(offset) })).toMatchObject({ referenced: 1 });
    }
    expect(storage.deleteKeys).not.toHaveBeenCalled();
    expect(objects.size).toBe(2);
    expect((await operationTypes()).at(-1)).toBe("referenced");
  });

  it("abandons an unreferenced stored batch only after 24 hours, then deletes it", async () => {
    await project();
    const { objects, storage } = objectStore();
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(23 * hour) })).toMatchObject({ examined: 0 });
    expect(await forcedRunner(storage).run({ now: later(23 * hour) })).toMatchObject({ withinGrace: 1, claimed: 0 });
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(25 * hour) })).toMatchObject({
      abandoned: 1,
      deleted: 1,
    });
    expect(objects.size).toBe(0);
    const history = await readCompleteStream(store, { streamId: operationStream });
    expect(history[3]).toMatchObject({
      payload: { reason: "abandoned" },
      performedByUserId: "usr_support_evidence_cleanup",
    });
  });

  describe("pending writers (AC-E2)", () => {
    const pendingOwner = { ...owner, operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAW" };
    const pendingStream = attachmentOperationStreamId(pendingOwner);
    const body = new Uint8Array([1, 2, 3, 4]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const fingerprint = {
      profile: "support-evidence-raster/v1",
      sharp: "t",
      libvips: "t",
      platform: "t",
      arch: "t",
      libc: "t",
    } as const;
    const canonicalizer = {
      canonicalize: async () => ({
        kind: "canonical" as const,
        image: {
          body,
          contentType: "image/jpeg" as const,
          sha256,
          byteSize: body.length,
          profile: fingerprint.profile,
          fingerprint,
        },
      }),
    };

    it("an admitted put held open past grace yields zero deletes; once settled, cleanup deletes once (mutant: pending writer ignored)", async () => {
      const { objects, storage } = objectStore([]);
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const putStarted = new Promise<void>((resolve) => (started = resolve));
      const upload = storeSupportEvidenceAttachments({
        supportRequestId: owner.supportRequestId,
        operationId: pendingOwner.operationId,
        context,
        eventStore: store,
        uploads: [{ body, contentType: "image/jpeg", filename: null }],
        canonicalizer,
        storage: {
          putPrivate: async (input) => {
            started();
            await barrier;
            objects.add(input.key);
            return { status: "completed", key: input.key };
          },
          verifyPrivate: async (key) => (objects.has(key) ? { status: "match" } : { status: "absent" }),
          readPrivate: async () => ({ status: "absent" }),
        },
      }).catch((error: unknown) => error);
      await putStarted;
      await requireCleanup(pendingOwner.operationId);
      await project([pendingStream]);
      expect((await locators()).find((row) => row.operation_stream_id === pendingStream)?.state).toBe(
        "retained-unsettled",
      );
      // Past grace, with an absent read: still retained because the admitted put has not settled.
      expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(hour) })).toMatchObject({ claimed: 0 });
      expect(await forcedRunner(storage, pendingOwner).run({ now: later(hour) })).toMatchObject({
        retainedUnsettled: 1,
        claimed: 0,
      });
      expect(storage.deleteKeys).not.toHaveBeenCalled();
      expect(await operationTypes(pendingStream)).toEqual(["staged", "put-admitted", "cleanup-required"]);
      release();
      expect(await upload).toMatchObject({ code: "operation-terminal" });
      expect(objects.size).toBe(1);
      expect(await operationTypes(pendingStream)).toEqual([
        "staged",
        "put-admitted",
        "cleanup-required",
        "put-settled",
      ]);
      await project([pendingStream]);
      expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(hour) })).toMatchObject({ deleted: 1 });
      await project([pendingStream]);
      expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(2 * hour) })).toMatchObject({
        examined: 0,
      });
      expect(storage.deleteKeys).toHaveBeenCalledTimes(1);
      expect(objects.size).toBe(0);
      expect((await operationTypes(pendingStream)).slice(-2)).toEqual(["cleanup-claimed", "deleted-unreferenced"]);
    });

    it("a crash with no settlement retains without success, forever", async () => {
      const pendingManifest = createAttachmentManifest({
        owner: pendingOwner,
        profile: fingerprint.profile,
        encoderFingerprint: fingerprint,
        images: [{ canonicalSha256: sha256, contentType: "image/jpeg", byteSize: body.length }],
      });
      await store.appendToStream({
        streamId: pendingStream,
        expectedVersion: "no_stream",
        context,
        events: [
          { eventType: "support.attachment-operation.staged", payload: pendingManifest },
          { eventType: "support.attachment-operation.put-admitted", payload: { index: 0, attempt: 1 } },
        ],
      });
      await requireCleanup(pendingOwner.operationId);
      await project([pendingStream]);
      const { storage } = objectStore([]);
      for (const offset of [hour, 30 * 24 * hour]) {
        expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(offset) })).toMatchObject({ claimed: 0 });
        expect(await forcedRunner(storage, pendingOwner).run({ now: later(offset) })).toMatchObject({
          retainedUnsettled: 1,
        });
      }
      expect(storage.deleteKeys).not.toHaveBeenCalled();
      expect(await operationTypes(pendingStream)).toEqual(["staged", "put-admitted", "cleanup-required"]);
    });
  });

  it.each([
    ["confirm failure", "confirm", 8],
    ["delete failure", "delete", 8],
    ["per-key delete error", "per-key", 8],
    ["delete success then append failure", "append", 7],
  ] as const)("%s converges across restart with exact counts and never resurrects", async (_label, fault, events) => {
    await requireCleanup();
    await project();
    const { objects, storage } = objectStore();
    let faulty: EventStore = store;
    const faultyStorage: SupportEvidenceCleanupStorage = {
      deleteKeys: async (requested) => {
        if (fault === "delete") throw new Error("provider unavailable");
        if (fault === "per-key") {
          objects.delete(requested[0]!);
          return [
            { key: requested[0]!, status: "deleted" },
            { key: requested[1]!, status: "failed", code: "provider-error" },
          ];
        }
        return storage.deleteKeys(requested);
      },
      verifyPrivate: async (key) => (fault === "confirm" ? { status: "match" } : storage.verifyPrivate(key)),
    };
    if (fault === "append")
      faulty = {
        ...store,
        appendToStream: async (input) => {
          if (input.events.some((event) => event.eventType.endsWith(".deleted-unreferenced")))
            throw new Error("append lost after delete");
          return store.appendToStream(input);
        },
      };
    const first = cleanup(cleanupRuntime(faulty, faultyStorage)).run({ now: later(60_000) });
    if (fault === "append") await expect(first).rejects.toThrow("append lost after delete");
    else expect(await first).toMatchObject({ claimed: 1, failed: 1, deleted: 0 });
    expect(await operationTypes()).not.toContain("deleted-unreferenced");
    expect(objects.size).toBe(fault === "delete" ? 2 : fault === "per-key" ? 1 : 0);
    // Restart: a new process with healthy storage converges from durable history alone.
    store = createPostgresEventStore({ pool });
    await project();
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(120_000) })).toMatchObject({ deleted: 1 });
    await project();
    expect(await locators()).toEqual([
      { operation_stream_id: operationStream, state: "deleted-unreferenced", stream_version: events },
    ]);
    expect(await cleanup(cleanupRuntime(store, storage)).run({ now: later(25 * hour) })).toMatchObject({ examined: 0 });
    const types = await operationTypes();
    expect(types).toHaveLength(events);
    expect(types.filter((type) => type === "deleted-unreferenced")).toHaveLength(1);
    expect(types.at(-1)).toBe("deleted-unreferenced");
    expect(objects.size).toBe(0);
    // Nothing resurrects: restaging, a new put or a reference claim on the terminal operation all refuse.
    const terminal = replayAttachmentOperation(
      (await readCompleteStream(store, { streamId: operationStream })).map(operationCodec.decode),
    );
    for (const command of [
      { type: "StageSupportAttachmentOperation", data: manifest },
      { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } },
      {
        type: "ClaimSupportAttachmentReference",
        data: { evidenceId: "sev_case", attachments, submittedAt: claim.submittedAt },
      },
    ] as const)
      expect(() => decideAttachmentOperation(terminal, command)).toThrow("operation-terminal");
  });

  describe("binding receipt and service audit (AC-E4)", () => {
    it("a stale-receipt worker cannot claim, before or racing the newer receipt", async () => {
      await requireCleanup();
      await project();
      const { objects, storage } = objectStore();
      const stale = cleanupRuntime(store, storage, 1);
      await cleanup(stale).initialize();
      const racing: EventStore = {
        ...store,
        appendToStreams: async (inputs) => {
          if (inputs.some((input) => input.events.some((event) => event.eventType.endsWith(".cleanup-claimed"))))
            await cleanup(cleanupRuntime(store, objectStore().storage, 2)).initialize();
          return store.appendToStreams!(inputs);
        },
      };
      expect(await cleanup(cleanupRuntime(racing, storage, 1)).run({ now: later(60_000) })).toMatchObject({
        conflicts: 1,
        claimed: 0,
      });
      expect(await cleanup(stale).run({ now: later(60_000) })).toMatchObject({
        denied: "binding_receipt_stale",
        examined: 0,
      });
      expect(storage.deleteKeys).not.toHaveBeenCalled();
      expect(objects.size).toBe(2);
      const conflicting = cleanupRuntime(store, storage, 2, "cleanup-b");
      await expect(cleanup(conflicting).initialize()).rejects.toThrow("cleanup_binding_digest_conflict");
      expect(await cleanup(conflicting).run({ now: later(60_000) })).toMatchObject({ denied: "binding_unavailable" });
      expect(await cleanup(cleanupRuntime(store, storage, 2)).run({ now: later(60_000) })).toMatchObject({
        deleted: 1,
      });
      const claim = (await readCompleteStream(store, { streamId: operationStream })).find((event) =>
        event.eventType.endsWith(".cleanup-claimed"),
      );
      expect(claim?.payload).toMatchObject({ attempt: 1, bindingId: "cleanup-a", bindingRevision: 2 });
    });

    it("records exactly one service attempt before the claim and never reads bytes (mutant: service audit skipped)", async () => {
      await requireCleanup();
      await project();
      const { storage } = objectStore();
      const readPrivate = vi.fn();
      const runtime = cleanupRuntime(store, { ...storage, readPrivate } as never);
      expect(await cleanup(runtime).run({ now: later(60_000) })).toMatchObject({ deleted: 1 });
      const attempts = await readCompleteStream(store, {
        streamId: `support.evidence-access-${owner.supportRequestId}`,
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.payload).toMatchObject({
        action: "cleanup-audit-read",
        decision: "allowed",
        participation: "service",
        userId: null,
        accountId: null,
        serviceBinding: { bindingId: "cleanup-a", revision: 1 },
      });
      const claim = (await readCompleteStream(store, { streamId: operationStream })).find((event) =>
        event.eventType.endsWith(".cleanup-claimed"),
      )!;
      expect(BigInt(attempts[0]!.globalPosition)).toBeLessThan(BigInt(claim.globalPosition));
      expect((await createEvidenceAccessAudit(store, () => "").page(owner.supportRequestId)).items).toHaveLength(1);
      expect(readPrivate).not.toHaveBeenCalled();
      // The binding grants no human byte access: an unrelated human without a grant still cannot download.
      await expect(
        runtime.getAttachment({
          supportRequestId: owner.supportRequestId,
          attachmentId: manifest.items[0]!.attachmentId,
          actor: evidenceActor("platform-admin", ["support.view"], false, "acc_unrelated"),
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("audit-append or database failure performs no cleanup", async () => {
      await requireCleanup();
      await project();
      const { objects, storage } = objectStore();
      const auditDown: EventStore = {
        ...store,
        appendToStream: async (input) => {
          if (input.streamId.startsWith("support.evidence-access-")) throw new Error("audit unavailable");
          return store.appendToStream(input);
        },
      };
      expect(await cleanup(cleanupRuntime(auditDown, storage)).run({ now: later(60_000) })).toMatchObject({
        auditUnavailable: 1,
        claimed: 0,
      });
      const caseDown: EventStore = {
        ...store,
        readStream: async (input) => {
          if (input.streamId === caseStream) throw new Error("database unavailable");
          return store.readStream(input);
        },
      };
      await expect(cleanup(cleanupRuntime(caseDown, storage)).run({ now: later(60_000) })).rejects.toThrow(
        "database unavailable",
      );
      const receiptDown: EventStore = {
        ...store,
        readStream: async (input) => {
          if (input.streamId === "support.evidence-cleanup-binding") throw new Error("database unavailable");
          return store.readStream(input);
        },
      };
      expect(await cleanup(cleanupRuntime(receiptDown, storage)).run({ now: later(60_000) })).toMatchObject({
        denied: "binding_unavailable",
      });
      expect(storage.deleteKeys).not.toHaveBeenCalled();
      expect(objects.size).toBe(2);
      expect(await operationTypes()).toHaveLength(4);
    });
  });

  it("fresh, upgraded and boot-twice schemas converge and a rebuilt locator replays identically", async () => {
    await pool.query(platformOperationsModule.schemaSql);
    const migration = (platformOperationsModule.schemaMigrations ?? []).find(
      (entry) => entry.migrationId === "20261015_support_evidence_cleanup_locators",
    )!;
    for (const statement of migration.statements) await pool.query(statement);
    for (const statement of migration.statements) await pool.query(statement);
    await requireCleanup();
    await project();
    await project();
    const once = await locators();
    expect(once).toEqual([{ operation_stream_id: operationStream, state: "cleanup-pending", stream_version: 4 }]);
    await pool.query("TRUNCATE support_evidence_cleanup_locators");
    await project();
    expect(await locators()).toEqual(once);
  });
});
