// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
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
} from "../domain/attachment-operation";
import { createSupportEvidenceAttachmentReference } from "../domain/attachment-reference";
import { createSupportAttachmentReferenceLifecycle, createSupportRequestRuntime } from "./runtime";
import { decideSupportRequest, initialSupportRequestState } from "../domain/domain";

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

describeDb("Support attachment reference fences on real PostgreSQL", () => {
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
      context,
      events: decideSupportRequest(initialSupportRequestState, { type: "OpenSupportRequest", supportRequestId: owner.supportRequestId as never, orderId: "ord_case" as never, buyerAccountId: owner.accountId, sellerAccountId: "acc_seller" as never, openedByAccountId: owner.accountId, openedByRole: "buyer", flowType: "product-damaged", orderTotalAmount: "10.00", openedAt: claim.submittedAt }).map((event) => ({ eventType: event.type, payload: event.data })),
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
  const runtime = (eventStore: EventStore) => createSupportRequestRuntime({ eventStore, db: pool, checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} } });
  const commandInput = { streamId: caseStream, context, command: { type: "SubmitSupportEvidence", evidenceId: claim.evidenceId, submittedByAccountId: owner.accountId, submittedByRole: "buyer", evidenceType: "photo", summary: "Evidence", submittedAt: claim.submittedAt, attachments, attachmentOperationId: owner.operationId } } as const;
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

  it("a concurrent case append conflicts with the claim (mutant: omit case guard)", async () => {
    await caseAppend(1);
    await expect(lifecycle().claim(claim, context)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await readCompleteStream(store, { streamId: operationStream })).toHaveLength(3);
  });
  it("a delayed submission after release fails atomically (mutant: omit empty operation guard or serial fallback)", async () => {
    const wrapped: EventStore = { ...store,
      appendToStreams: async (inputs) => {
        if (inputs.some((input) => input.events.some((event) => event.eventType === "support.support-request.evidence-submitted")))
          await lifecycle().release({ owner, expectedVersion: 4 }, context);
        return store.appendToStreams!(inputs);
      },
      appendToStream: async (input) => {
        if (input.events.some((event) => event.eventType === "support.support-request.evidence-submitted"))
          await lifecycle().release({ owner, expectedVersion: 4 }, context);
        return store.appendToStream(input);
      },
    };
    await expect(runtime(wrapped).commandHandler(commandInput)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await readCompleteStream(store, { streamId: caseStream })).toHaveLength(1);
  });
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
      (await readCompleteStream(store, { streamId: operationStream })).map((event) => ({
        type: event.eventType,
        data: event.payload,
      })) as Parameters<typeof replayAttachmentOperation>[0],
    );
    expect(() =>
      decideAttachmentOperation(state, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
    ).toThrow("operation-terminal");
  });
  it("confirmation recovers across restart and replay (mutant: confirmation only in upload process memory)", async () => {
    const interrupted: EventStore = { ...store, appendToStreams: async (inputs) => {
      if (inputs.some((input) => input.events.some((event) => event.eventType === "support.attachment-operation.referenced")))
        throw new Error("confirmation interrupted after evidence commit");
      return store.appendToStreams!(inputs);
    } };
    await expect(runtime(interrupted).commandHandler(commandInput)).rejects.toThrow("confirmation interrupted");
    const restarted = runtime(createPostgresEventStore({ pool }));
    await restarted.commandHandler(commandInput);
    await restarted.commandHandler(commandInput);
    const history = await readCompleteStream(store, { streamId: operationStream });
    expect(history.map((event) => event.eventType).slice(-2)).toEqual([
      "support.attachment-operation.reference-claimed",
      "support.attachment-operation.referenced",
    ]);
    expect(replayAttachmentOperation(history.map((event) => ({ type: event.eventType, data: event.payload })) as Parameters<typeof replayAttachmentOperation>[0]).status).toBe("referenced");
    expect((await readCompleteStream(store, { streamId: caseStream })).filter((event) => event.eventType === "support.support-request.evidence-submitted")).toHaveLength(1);
  });
});
