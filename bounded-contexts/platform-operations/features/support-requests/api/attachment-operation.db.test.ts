// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createFilesystemPrivateObjectStore, type PrivateObjectStore } from "@chase-sets/object-storage";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as platformOperationsModule } from "../../../index";
import {
  attachmentOperationStreamId,
  createAttachmentManifest,
  decideAttachmentOperation,
  replayAttachmentOperation,
  type AttachmentOperationEvent,
} from "../domain/attachment-operation";
import {
  attachmentStorageKey,
  storeSupportEvidenceAttachments,
  SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
} from "./attachments";
import {
  canonicalizeSupportEvidenceImage,
  createSupportEvidenceCanonicalizationQueue,
} from "./evidence-canonicalization";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Support Attachment Operation tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
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
const streamId = attachmentOperationStreamId(owner);
const photo = readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg");
const photo2 = readFileSync("features/support-requests/api/__fixtures__/evidence/palette-transparency.png");

describeDb("durable canonical Support Attachment Operation on PostgreSQL and filesystem", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let urls: ReturnType<typeof createMultiContextTestDatabaseUrls<(typeof contextNames)[number]>>;
  let pool: PgTransactionalPool;
  let eventStore: EventStore;
  let root: string;
  const roots: string[] = [];
  beforeAll(async () => {
    urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "support_attachment_operation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
    eventStore = createPostgresEventStore({ pool });
    await mkdir(path.resolve("../../artifacts"), { recursive: true });
    root = await mkdtemp(path.resolve("../../artifacts/support-attachment-operation-"));
    roots.push(root);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
    for (const directory of roots) await rm(directory, { recursive: true, force: true });
  });
  const history = () => readCompleteStream(eventStore, { streamId });
  const types = async () => (await history()).map((e) => e.eventType.split(".").at(-1));
  function fixture(count = 2) {
    const privateStore = createFilesystemPrivateObjectStore({ rootDir: root });
    const storage = {
      ...privateStore,
      verifyPrivate: vi.fn<PrivateObjectStore["verifyPrivate"]>(privateStore.verifyPrivate),
      putPrivate: vi.fn<PrivateObjectStore["putPrivate"]>(async (input) => {
        expect((await types()).at(-1)).toBe("put-admitted");
        expect((await history())[0].payload.items).toHaveLength(count);
        return privateStore.putPrivate(input);
      }),
    };
    const input = {
      ...owner,
      context,
      eventStore,
      storage,
      canonicalizer: createSupportEvidenceCanonicalizationQueue({ canonicalize: canonicalizeSupportEvidenceImage }),
      uploads: [
        { body: photo, contentType: "image/jpeg", filename: "private.jpg" },
        { body: photo2, contentType: "image/png", filename: "private.png" },
      ].slice(0, count),
    };
    return { privateStore, storage, input };
  }
  async function canonicalManifest() {
    const results = [
      await canonicalizeSupportEvidenceImage({ body: photo, declaredContentType: "image/jpeg" }),
      await canonicalizeSupportEvidenceImage({ body: photo2, declaredContentType: "image/png" }),
    ];
    const images = results.map((result) => {
      if (result.kind !== "canonical") throw new Error("fixture must canonicalize");
      return result.image;
    });
    const manifest = createAttachmentManifest({
      owner,
      profile: images[0].profile,
      encoderFingerprint: images[0].fingerprint,
      images: images.map((i) => ({ canonicalSha256: i.sha256, contentType: i.contentType, byteSize: i.byteSize })),
    });
    const keys = manifest.items.map((i) =>
      attachmentStorageKey(owner.supportRequestId, i.attachmentId, i.canonicalSha256, i.contentType),
    );
    return { images, manifest, keys };
  }

  it("stages the entire ordered manifest before every put and returns only the complete ordered references", async () => {
    const f = fixture();
    const references = await storeSupportEvidenceAttachments(f.input);
    expect(references).toHaveLength(2);
    expect(await types()).toEqual([
      "staged",
      "put-admitted",
      "put-settled",
      "stored",
      "put-admitted",
      "put-settled",
      "stored",
    ]);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
    expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(4);
    expect(await storeSupportEvidenceAttachments(f.input)).toEqual(references);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
    expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(6);
    expect(await history()).toHaveLength(7);
  });

  it("replays the original complete upload read-only after claim and confirmation on PostgreSQL", async () => {
    const f = fixture();
    const references = await storeSupportEvidenceAttachments(f.input);
    const codec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();
    const commands = [
      {
        type: "ClaimSupportAttachmentReference",
        data: {
          evidenceId: "sev_synthetic_replay",
          attachments: references.map((item) => item.reference),
          submittedAt: "2026-10-14T00:00:00.000Z",
        },
      },
      { type: "ConfirmSupportAttachmentReferenced", data: { evidenceId: "sev_synthetic_replay" } },
    ] as const;
    for (const command of commands) {
      const beforeTransition = await history();
      const events = decideAttachmentOperation(replayAttachmentOperation(beforeTransition.map(codec.decode)), command);
      await eventStore.appendToStream({
        streamId,
        expectedVersion: beforeTransition.at(-1)!.streamVersion,
        context,
        events: events.map(codec.encode),
      });
      const beforeReplay = await history();
      f.storage.verifyPrivate.mockClear();
      expect(await storeSupportEvidenceAttachments(f.input)).toEqual(references);
      expect(await history()).toEqual(beforeReplay);
      expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
      expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["byte-size", "sha256", "oversize"])(
    "seeded %s conflict is unchanged with zero puts; kills pre-read-removed mutant",
    async (difference) => {
      const f = fixture();
      const { images, keys } = await canonicalManifest();
      const bytes =
        difference === "sha256"
          ? Buffer.alloc(images[0].byteSize)
          : Buffer.alloc(images[0].byteSize + (difference === "oversize" ? 10 * 1024 * 1024 : 1));
      await f.privateStore.putPrivate({
        key: keys[0],
        body: bytes,
        contentType: images[0].contentType,
        deadlineMs: 30_000,
      });
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      expect(await readFile(path.join(root, keys[0]))).toEqual(bytes);
      expect(await types()).toEqual(["staged", "cleanup-required"]);
    },
  );

  it("matching seeded bytes converge without puts or fabricated settlements", async () => {
    const f = fixture();
    const { images, keys } = await canonicalManifest();
    for (let index = 0; index < 2; index++)
      await f.privateStore.putPrivate({
        key: keys[index],
        body: images[index].body,
        contentType: images[index].contentType,
        deadlineMs: 30_000,
      });
    expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(2);
    expect(await types()).toEqual(["staged", "stored", "stored"]);
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
  });

  it("unavailable pre-read is not a match and never admits a put; kills unavailable-as-match mutant", async () => {
    const f = fixture();
    f.storage.verifyPrivate.mockResolvedValue({ status: "unavailable", code: "transport-failed" });
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toMatchObject({ code: "storage-unavailable" });
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
    expect(await types()).toEqual(["staged"]);
  });

  it.each(["absent", "truncated", "oversize", "mismatched", "unavailable"])(
    "post-write %s verification produces no Stored or partial reference set",
    async (kind) => {
      const f = fixture();
      const { images } = await canonicalManifest();
      f.storage.putPrivate.mockImplementation(async (input) => {
        if (kind === "absent") return { status: "completed", key: input.key };
        const body =
          kind === "truncated"
            ? input.body.slice(0, -1)
            : kind === "oversize"
              ? Buffer.alloc(images[0].byteSize + 1)
              : kind === "mismatched"
                ? Buffer.alloc(images[0].byteSize)
                : input.body;
        return f.privateStore.putPrivate({ ...input, body });
      });
      if (kind === "unavailable")
        f.storage.verifyPrivate
          .mockResolvedValueOnce({ status: "absent" })
          .mockResolvedValueOnce({ status: "unavailable", code: "transport-failed" });
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
      expect(await types()).toEqual(
        kind === "unavailable"
          ? ["staged", "put-admitted", "put-settled"]
          : ["staged", "put-admitted", "put-settled", "cleanup-required"],
      );
      expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["stage", "admit", "settle", "stored"])(
    "append failure at %s followed by process loss and same-id retry converges",
    async (point) => {
      const f = fixture();
      const eventName =
        point === "stage"
          ? "staged"
          : point === "admit"
            ? "put-admitted"
            : point === "settle"
              ? "put-settled"
              : "stored";
      let failed = false;
      const interrupted: EventStore = {
        ...eventStore,
        appendToStream: async (input) => {
          if (!failed && input.events[0]?.eventType.endsWith(`.${eventName}`)) {
            failed = true;
            throw new Error("synthetic process loss before append");
          }
          return eventStore.appendToStream(input);
        },
      };
      await expect(storeSupportEvidenceAttachments({ ...f.input, eventStore: interrupted })).rejects.toBeDefined();
      expect(await types()).toEqual(
        point === "stage"
          ? []
          : point === "admit"
            ? ["staged"]
            : point === "settle"
              ? ["staged", "put-admitted"]
              : ["staged", "put-admitted", "put-settled"],
      );
      // Reopen the actual connections, not a fake restarted service.
      await closeMultiContextTestPools(pools);
      pools = createMultiContextTestPools(urls);
      pool = pools["platform-operations"];
      eventStore = createPostgresEventStore({ pool });
      expect(await storeSupportEvidenceAttachments({ ...f.input, eventStore })).toHaveLength(2);
      expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
      expect(await types()).toEqual(
        point === "settle"
          ? ["staged", "put-admitted", "stored", "put-admitted", "put-settled", "stored"]
          : ["staged", "put-admitted", "put-settled", "stored", "put-admitted", "put-settled", "stored"],
      );
    },
  );

  it("a held response past its finite deadline leaves an unresolved admission; same-id retry verifies without re-put", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.storage.putPrivate.mockImplementationOnce(async (input) => {
      const result = await f.privateStore.putPrivate(input);
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = storeSupportEvidenceAttachments(f.input);
      const rejected = expect(pending).rejects.toMatchObject({ code: "storage-unavailable" });
      await ready;
      await vi.advanceTimersByTimeAsync(SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS);
      await rejected;
      release();
      vi.useRealTimers();
      expect(await types()).toEqual(["staged", "put-admitted"]);
      expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(2);
      expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
      expect(await types()).toEqual(["staged", "put-admitted", "stored", "put-admitted", "put-settled", "stored"]);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it("transport loss after bytes are written leaves no settlement and resumes by independent verification", async () => {
    const f = fixture();
    f.storage.putPrivate.mockImplementationOnce(async (input) => {
      await f.privateStore.putPrivate(input);
      throw new Error("synthetic transport loss");
    });
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    expect(await types()).toEqual(["staged", "put-admitted"]);
    expect(await storeSupportEvidenceAttachments(f.input)).toHaveLength(2);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
  });

  it("known provider failure settles and requires cleanup immediately, never retrying a terminal operation", async () => {
    const f = fixture();
    f.storage.putPrivate.mockImplementationOnce(async ({ key }) => ({ status: "failed", key, code: "provider-error" }));
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    expect(await types()).toEqual(["staged", "put-admitted", "put-settled", "cleanup-required"]);
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "files", "order", "fingerprint"])(
    "changed %s retry has zero appends and provider calls",
    async (field) => {
      const f = fixture();
      await storeSupportEvidenceAttachments(f.input);
      const before = await history();
      f.storage.putPrivate.mockClear();
      f.storage.verifyPrivate.mockClear();
      const input =
        field === "owner"
          ? { ...f.input, context: { ...context, audit: { ...context.audit, forAccountId: "acc_other" as never } } }
          : field === "order"
            ? { ...f.input, uploads: [...f.input.uploads].reverse() }
            : field === "files"
              ? { ...f.input, uploads: [f.input.uploads[0]] }
              : {
                  ...f.input,
                  canonicalizer: {
                    canonicalize: async (i: Parameters<typeof canonicalizeSupportEvidenceImage>[0]) => {
                      const result = await canonicalizeSupportEvidenceImage(i);
                      return result.kind === "canonical"
                        ? {
                            ...result,
                            image: {
                              ...result.image,
                              fingerprint: { ...result.image.fingerprint, sharp: "different" },
                            },
                          }
                        : result;
                    },
                  },
                };
      await expect(storeSupportEvidenceAttachments(input)).rejects.toBeDefined();
      expect(await history()).toEqual(before);
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      expect(f.storage.verifyPrivate).not.toHaveBeenCalled();
    },
  );

  it.each(["reference-claimed", "cleanup-claimed", "unknown"])(
    "a concurrent %s history/version blocks admission with zero puts",
    async (claim) => {
      const f = fixture();
      const verify = f.privateStore.verifyPrivate;
      f.storage.verifyPrivate.mockImplementationOnce(async (key, expected) => {
        const events = await history();
        await eventStore.appendToStream({
          streamId,
          expectedVersion: events.at(-1)!.streamVersion,
          context,
          events: [{ eventType: `support.attachment-operation.${claim}`, payload: {} }],
        });
        return verify(key, expected);
      });
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(f.storage.putPrivate).not.toHaveBeenCalled();
      await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
      expect(f.storage.verifyPrivate).toHaveBeenCalledTimes(1);
    },
  );

  it("two concurrent admissions are operation-version guarded, with one tracked put", async () => {
    const f = fixture(1);
    // Stage the one-item manifest through the service, using an unavailable pre-read.
    f.storage.verifyPrivate.mockResolvedValueOnce({ status: "unavailable", code: "transport-failed" });
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    let entered = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.storage.verifyPrivate.mockImplementation(async (key, expected) => {
      if (++entered <= 2) {
        if (entered === 2) release();
        await barrier;
        return { status: "absent" };
      }
      return f.privateStore.verifyPrivate(key, expected);
    });
    const results = await Promise.allSettled([
      storeSupportEvidenceAttachments(f.input),
      storeSupportEvidenceAttachments(f.input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    expect(await types()).toEqual(["staged", "put-admitted", "put-settled", "stored"]);
  });

  it("stored corruption never re-puts; poisoned durable histories never touch the provider", async () => {
    const f = fixture();
    await storeSupportEvidenceAttachments(f.input);
    f.storage.verifyPrivate.mockResolvedValueOnce({ status: "absent" });
    await expect(storeSupportEvidenceAttachments(f.input)).rejects.toBeDefined();
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
    expect((await types()).at(-1)).toBe("cleanup-required");
    const { manifest } = await canonicalManifest();
    const other = { ...owner, operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAW" };
    await eventStore.appendToStream({
      streamId: attachmentOperationStreamId(other),
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "support.attachment-operation.staged",
          payload: { ...manifest, manifestFingerprint: "0".repeat(64) },
        },
      ],
    });
    f.storage.verifyPrivate.mockClear();
    f.storage.putPrivate.mockClear();
    await expect(storeSupportEvidenceAttachments({ ...f.input, operationId: other.operationId })).rejects.toBeDefined();
    expect(f.storage.verifyPrivate).not.toHaveBeenCalled();
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
  });

  it("fresh, upgraded, replayed and boot-twice databases converge; seeds author no operation", async () => {
    await bootstrapContextDatabase(platformOperationsModule, pool);
    expect(platformOperationsModule.seed).toBeDefined();
    await platformOperationsModule.seed!(pool);
    await platformOperationsModule.seed!(pool);
    expect(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM event_store_events WHERE stream_id LIKE 'support.attachment-operation-%'",
        )
      ).rows[0].count,
    ).toBe("0");
    const f = fixture();
    const references = await storeSupportEvidenceAttachments(f.input);
    await bootstrapContextDatabase(platformOperationsModule, pool);
    const replayed = replayAttachmentOperation(
      (await history()).map((e) => ({ type: e.eventType, data: e.payload })) as AttachmentOperationEvent[],
    );
    expect(replayed.status).toBe("stored");
    const restarted = createPostgresEventStore({ pool });
    expect(await storeSupportEvidenceAttachments({ ...f.input, eventStore: restarted })).toEqual(references);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(2);
    expect(await history()).toHaveLength(7);
  });
});
